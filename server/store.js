// State that more than one copy of the server would need to share. Without REDIS_URL it lives in this process's
// memory, as it always has, and resets when the server restarts. With REDIS_URL it lives in Redis, so every copy
// sees the same limits and rooms. Both stores have the same async methods.
//
// Limits are sliding-window logs: a key keeps the times of its recent requests, and a request is refused, without
// being counted, when the key already has max of them inside its window.
//
// Rooms: one document per room (members, kept seats, host, waiting list, removed and denied tabs), changed only through
// withRoom, which runs one change at a time per room. In Redis that is a lock, so two copies never both give away the
// last place or both pick a host. Kept seats and a host away for a reload end at a time stored in the document: memory
// keeps a timer for it, and with Redis one copy at a time checks for due rooms every second, so they still end when
// the copy that started them is gone.
const { randomBytes } = require("crypto");

const PREFIX = "st:"; // every Redis key starts with this, so the app can share a Redis with other things (tests use their own)
const SWEEP_MS = 60 * 1000;
const COMPLAIN_EVERY = 60 * 1000;
const TICK_MS = 1000; // Redis: how often due rooms and lost copies are checked
const ALIVE_MS = 5000; // Redis: a copy that has not said it is alive for this long has stopped
const LOCK_MS = 5000; // Redis: a room's lock frees itself after this, if its copy died while holding it
const LOCK_WAIT_MS = 3000;

// Counts one request on every key, or on none. limits: [{ key, max, windowMs }]. Returns { ok: true, mark } when every
// key is under its max (mark undoes the count, see forget), else { ok: false, index } of the first key that is not.
// In Redis this runs as one script, so copies of the server checking the same key at once cannot both get the last slot
const TAKE = `
local now = tonumber(ARGV[1])
for i, key in ipairs(KEYS) do
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now - tonumber(ARGV[2 + i * 2]))
  if redis.call("ZCARD", key) >= tonumber(ARGV[1 + i * 2]) then return i end
end
for i, key in ipairs(KEYS) do
  redis.call("ZADD", key, now, ARGV[2])
  redis.call("PEXPIRE", key, ARGV[2 + i * 2])
end
return 0
`;

// Saves a room only while this copy still holds its lock; the lock is freed after the change's messages are sent.
// Also lists the room for each copy with people in it (so they can be taken over if that copy stops) and unlists it
// for copies that no longer have anyone there. KEYS: lock, room, members, calls, due, copies. ARGV: lock token, room,
// document (empty to delete it), when it is next due (0 for never), key prefix, then a count and the member ids, a
// count and the copies with people here, and the copies that had people here before
const SAVE = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
local name, ids = ARGV[2], tonumber(ARGV[6])
if ARGV[3] == "" then redis.call("DEL", KEYS[2]) else redis.call("SET", KEYS[2], ARGV[3]) end
redis.call("DEL", KEYS[3])
if ids > 0 then redis.call("SADD", KEYS[3], unpack(ARGV, 7, 6 + ids)) end
if ids == 2 then redis.call("SADD", KEYS[4], name) else redis.call("SREM", KEYS[4], name) end
if ARGV[4] == "0" then redis.call("ZREM", KEYS[5], name) else redis.call("ZADD", KEYS[5], ARGV[4], name) end
local here = tonumber(ARGV[7 + ids])
for i = 8 + ids, 7 + ids + here do
  redis.call("SADD", ARGV[5] .. "copy:" .. ARGV[i], name)
  redis.call("SADD", KEYS[6], ARGV[i])
end
for i = 8 + ids + here, #ARGV do redis.call("SREM", ARGV[5] .. "copy:" .. ARGV[i], name) end
return 1
`;
const UNLOCK = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

// members: socket id -> { clientId, name, seat, copy }. held: clientId -> { id, name, seat, until }. host: { key,
// awayUntil }. waiting: requests in order. removed, denied: tabs kept out until the room is empty
const emptyRoom = () => ({ members: {}, held: {}, host: null, waiting: [], removed: [], denied: [] });
const isEmpty = room => !room.host && !room.waiting.length && !Object.keys(room.members).length && !Object.keys(room.held).length;
// When something in the room ends by itself next: a kept seat, or the host's time to come back after a reload
const nextDue = room => Math.min(...Object.values(room.held).map(seat => seat.until), room.host?.awayUntil || Infinity);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function memoryStore() {
  const logs = new Map(); // key -> { times, windowMs }
  const rooms = new Map(); // room -> document
  const queues = new Map(); // room -> the change running now and those waiting for it
  const timers = new Map(); // room -> timer for its next due time
  let onDue = () => {};

  // The key's requests still inside its window (stored back, so the caller can add the new one)
  const recent = (key, windowMs, now) => {
    const times = (logs.get(key)?.times || []).filter(t => now - t < windowMs);
    logs.set(key, { times, windowMs });
    return times;
  };

  // Keys that are never used again would otherwise stay in memory forever
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, { windowMs }] of logs) if (!recent(key, windowMs, now).length) logs.delete(key);
  }, SWEEP_MS);
  sweep.unref();

  const save = (name, room) => {
    clearTimeout(timers.get(name));
    timers.delete(name);
    if (isEmpty(room)) return rooms.delete(name);
    rooms.set(name, room);
    const due = nextDue(room);
    if (due !== Infinity) timers.set(name, setTimeout(() => onDue(name), Math.max(0, due - Date.now())).unref());
  };

  return {
    shared: false,
    copyId: randomBytes(8).toString("hex"),
    async take(limits) {
      const now = Date.now();
      const lists = limits.map(({ key, windowMs }) => recent(key, windowMs, now));
      const index = limits.findIndex(({ max }, i) => lists[i].length >= max);
      if (index !== -1) return { ok: false, index };
      for (const times of lists) times.push(now);
      return { ok: true, mark: now };
    },
    async forget(limits, mark) {
      for (const { key } of limits) {
        const times = logs.get(key)?.times || [];
        const i = times.indexOf(mark);
        if (i !== -1) times.splice(i, 1);
        if (!times.length) logs.delete(key);
      }
    },
    // change(room, effect) changes the document and returns a result. Effects (messages to people) run once the change
    // is saved, so nobody is told about a change that did not happen
    async withRoom(name, change) {
      const before = queues.get(name) ?? Promise.resolve();
      let done;
      const turn = new Promise(r => (done = r));
      const mine = before.then(() => turn);
      queues.set(name, mine);
      await before;
      try {
        const room = structuredClone(rooms.get(name) ?? emptyRoom());
        const effects = [];
        const result = change(room, effect => effects.push(effect));
        save(name, room);
        effects.forEach(effect => effect());
        return result;
      } finally {
        done();
        if (queues.get(name) === mine) queues.delete(name);
      }
    },
    async readRoom(name) {
      return structuredClone(rooms.get(name) ?? emptyRoom());
    },
    async bothIn(name, a, b) {
      const members = rooms.get(name)?.members ?? {};
      return Object.hasOwn(members, a) && Object.hasOwn(members, b);
    },
    onDue(handler) {
      onDue = handler;
    },
    onCopyLost() {}, // one process: no other copy to lose
    onReconnect() {},
    roomsOf: async () => [],
    runId: (() => { const id = randomBytes(8).toString("hex"); return () => id; })(),
    liveCounts: async (online, calls) => ({ online, calls }),
    adapter: () => null,
    ready: () => true,
    async close() {
      clearInterval(sweep);
      timers.forEach(clearTimeout);
    },
  };
}

// If Redis cannot be reached, limits are not enforced: calls must keep working. Commands fail at once instead of
// queuing while the connection is down, and one that gets no answer in a second counts as a failure too. Rooms cannot
// be changed without Redis: those calls throw, and the server refuses a new join rather than guess
// redisOptions: for tests, such as a faster retryStrategy
function redisStore(url, { prefix = PREFIX, redisOptions = {} } = {}) {
  const Redis = require("ioredis");
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 1000, ...redisOptions });
  client.defineCommand("takeAll", { lua: TAKE });
  client.defineCommand("saveRoom", { numberOfKeys: 6, lua: SAVE });
  client.defineCommand("unlock", { numberOfKeys: 1, lua: UNLOCK });
  const copyId = randomBytes(8).toString("hex");
  const key = (...parts) => prefix + parts.join(":");
  let onDue = () => {}, onCopyLost = () => {}, onReconnect = () => {};
  let runId = randomBytes(8).toString("hex"); // replaced by the shared one as soon as Redis answers
  let seenRun = null; // the shared run id last read: a new one means Redis lost its data
  let healthySince = 0; // since when every tick has reached Redis; 0 while it cannot
  let connections = 0;
  const extra = []; // the adapter's clients, closed with the store

  // One line a minute while it lasts, not one per request or per reconnect attempt
  let complainedAt = 0;
  const complain = err => {
    if (Date.now() - complainedAt < COMPLAIN_EVERY) return;
    complainedAt = Date.now();
    console.error("Redis is unavailable, so limits are not enforced and calls cannot start:", err.message);
  };
  client.on("error", complain);

  // Every second: say this copy is alive, and let one copy at a time end what is due and take over the people of a
  // copy that stopped. The run id is shared, so a person who moves to another copy is not told the server restarted.
  // After any gap in reaching Redis (an outage, or Redis frozen), every copy's "alive" may have run out: a copy only
  // judges others stopped once it has itself reached Redis for 2 * ALIVE_MS without a gap, enough for the others to
  // reconnect (at most about 5 s apart) and say they are alive again
  const tick = async (reconnected = false) => {
    try {
      await client.set(key("alive", copyId), "1", "PX", ALIVE_MS);
      await client.sadd(key("copies"), copyId);
      let run = await client.get(key("run"));
      if (!run) {
        await client.set(key("run"), randomBytes(8).toString("hex"), "NX");
        run = await client.get(key("run"));
      }
      const lost = seenRun !== null && run !== seenRun;
      seenRun = runId = run;
      if (reconnected || lost) await onReconnect(lost);
      healthySince ||= Date.now();
      if (!(await client.set(key("sweep"), copyId, "PX", TICK_MS - 100, "NX"))) return;
      for (const room of await client.zrangebyscore(key("due"), "-inf", Date.now())) await onDue(room);
      if (Date.now() - healthySince < 2 * ALIVE_MS) return;
      for (const copy of await client.smembers(key("copies"))) {
        if (copy === copyId || (await client.exists(key("alive", copy)))) continue;
        for (const room of await client.smembers(key("copy", copy))) await onCopyLost(room, copy);
        await client.multi().del(key("copy", copy)).srem(key("copies"), copy).hdel(key("online"), copy).exec();
      }
    } catch (err) {
      healthySince = 0;
      complain(err);
    }
  };
  const ticker = setInterval(tick, TICK_MS);
  ticker.unref();
  // At once on (re)connecting, so this copy is known as alive before it seats anyone, and gets its people back
  client.on("ready", () => tick(connections++ > 0));
  client.on("close", () => (healthySince = 0));

  return {
    shared: true,
    copyId,
    async take(limits) {
      const now = Date.now();
      // Unique, so two requests in the same millisecond are two entries
      const mark = `${now}:${randomBytes(6).toString("hex")}`;
      try {
        const refused = await client.takeAll(limits.length, ...limits.map(({ key }) => prefix + key), now, mark, ...limits.flatMap(({ max, windowMs }) => [max, windowMs]));
        return refused ? { ok: false, index: refused - 1 } : { ok: true, mark };
      } catch (err) {
        complain(err);
        return { ok: true, mark: null };
      }
    },
    async forget(limits, mark) {
      if (!mark) return; // nothing was counted
      try {
        await Promise.all(limits.map(({ key }) => client.zrem(prefix + key, mark)));
      } catch (err) {
        complain(err);
      }
    },
    async withRoom(name, change) {
      const lock = key("lock", name), token = randomBytes(8).toString("hex");
      for (const started = Date.now(); !(await client.set(lock, token, "PX", LOCK_MS, "NX"));) {
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error("room is busy");
        await sleep(5 + Math.random() * 15);
      }
      try {
        const saved = await client.get(key("room", name));
        const room = saved ? JSON.parse(saved) : emptyRoom();
        const copiesOf = r => new Set(Object.values(r.members).map(member => member.copy));
        const before = copiesOf(room);
        const effects = [];
        const result = change(room, effect => effects.push(effect));
        const due = nextDue(room);
        const ids = Object.keys(room.members), here = [...copiesOf(room)], gone = [...before].filter(copy => !here.includes(copy));
        const ok = await client.saveRoom(lock, key("room", name), key("members", name), key("calls"), key("due"), key("copies"), token, name, isEmpty(room) ? "" : JSON.stringify(room), due === Infinity ? 0 : due, prefix, ids.length, ...ids, here.length, ...here, ...gone);
        if (!ok) throw new Error("room lock expired");
        // Still holding the lock, so the next change's messages cannot overtake these
        effects.forEach(effect => effect());
        return result;
      } finally {
        await client.unlock(lock, token).catch(() => {});
      }
    },
    async readRoom(name) {
      const saved = name && (await client.get(key("room", name)));
      return saved ? JSON.parse(saved) : emptyRoom();
    },
    // Asked for every relayed signal (ICE candidates come many at a time), so it is one small Redis call
    async bothIn(name, a, b) {
      const [x, y] = await client.smismember(key("members", name), a, b);
      return x === 1 && y === 1;
    },
    onDue(handler) {
      onDue = handler;
    },
    onCopyLost(handler) {
      onCopyLost = handler;
    },
    // handler(lost): back in touch with Redis; lost when Redis no longer has the data it had
    onReconnect(handler) {
      onReconnect = handler;
    },
    // Rooms where a copy has (or recently had) people
    roomsOf: copy => client.smembers(key("copy", copy)),
    runId: () => runId,
    // People online, summed over the copies, and rooms with two people in them
    async liveCounts(online) {
      const [, [, counts], [, calls]] = await client.multi().hset(key("online"), copyId, online).hvals(key("online")).scard(key("calls")).exec();
      return { online: counts.reduce((sum, n) => sum + Number(n), 0), calls };
    },
    // Socket.IO's Redis adapter, so a message to a person or a room reaches whichever copy they are on. It does not
    // handle a failed publish, which would otherwise end the process while Redis is down
    adapter() {
      const { createAdapter } = require("@socket.io/redis-adapter");
      // The adapter does not catch its subscriptions either: the subscriber waits for Redis however long it takes
      const pub = new Redis(url, redisOptions), sub = new Redis(url, { ...redisOptions, maxRetriesPerRequest: null });
      extra.push(pub, sub);
      pub.on("error", complain);
      sub.on("error", complain);
      const publish = pub.publish.bind(pub);
      pub.publish = (...args) => publish(...args).catch(complain);
      return createAdapter(pub, sub);
    },
    ready: () => client.status === "ready",
    async close() {
      clearInterval(ticker);
      for (const other of extra.splice(0)) other.disconnect();
      await client.quit().catch(() => client.disconnect());
    },
  };
}

let shared = null;
// The store this server uses, chosen once from REDIS_URL. Without it there is no Redis client at all
const getStore = () => (shared ??= process.env.REDIS_URL ? redisStore(process.env.REDIS_URL) : memoryStore());

module.exports = { getStore, memoryStore, redisStore };
