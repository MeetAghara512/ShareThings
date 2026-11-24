// State that more than one copy of the server would need to share. Without REDIS_URL it lives in this process's
// memory, as it always has, and resets when the server restarts. With REDIS_URL it lives in Redis, so every copy
// counts the same requests. Both stores have the same async methods; rooms, seats and hosts can be added to both later.
//
// Limits are sliding-window logs: a key keeps the times of its recent requests, and a request is refused, without
// being counted, when the key already has max of them inside its window.
const { randomBytes } = require("crypto");

const PREFIX = "st:"; // every Redis key starts with this, so the app can share a Redis with other things
const SWEEP_MS = 60 * 1000;
const COMPLAIN_EVERY = 60 * 1000;

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

function memoryStore() {
  const logs = new Map(); // key -> { times, windowMs }

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

  return {
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
    ready: () => true,
    async close() {
      clearInterval(sweep);
    },
  };
}

// If Redis cannot be reached, limits are not enforced: calls must keep working. Commands fail at once instead of
// queuing while the connection is down, and one that gets no answer in a second counts as a failure too
function redisStore(url) {
  const Redis = require("ioredis");
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 1000 });
  client.defineCommand("takeAll", { lua: TAKE });

  // One line a minute while it lasts, not one per request or per reconnect attempt
  let complainedAt = 0;
  const complain = err => {
    if (Date.now() - complainedAt < COMPLAIN_EVERY) return;
    complainedAt = Date.now();
    console.error("Redis is unavailable, so limits are not enforced:", err.message);
  };
  client.on("error", complain);

  return {
    async take(limits) {
      const now = Date.now();
      // Unique, so two requests in the same millisecond are two entries
      const mark = `${now}:${randomBytes(6).toString("hex")}`;
      try {
        const refused = await client.takeAll(limits.length, ...limits.map(({ key }) => PREFIX + key), now, mark, ...limits.flatMap(({ max, windowMs }) => [max, windowMs]));
        return refused ? { ok: false, index: refused - 1 } : { ok: true, mark };
      } catch (err) {
        complain(err);
        return { ok: true, mark: null };
      }
    },
    async forget(limits, mark) {
      if (!mark) return; // nothing was counted
      try {
        await Promise.all(limits.map(({ key }) => client.zrem(PREFIX + key, mark)));
      } catch (err) {
        complain(err);
      }
    },
    ready: () => client.status === "ready",
    async close() {
      await client.quit().catch(() => client.disconnect());
    },
  };
}

let shared = null;
// The store this server uses, chosen once from REDIS_URL. Without it there is no Redis client at all
const getStore = () => (shared ??= process.env.REDIS_URL ? redisStore(process.env.REDIS_URL) : memoryStore());

module.exports = { getStore, memoryStore, redisStore };
