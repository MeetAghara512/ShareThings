// The store's limiter, against memory and, when TEST_REDIS_URL is set, against a real Redis.
// Run: TEST_REDIS_URL=redis://127.0.0.1:6390 npm test
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { memoryStore, redisStore } = require("../store");

const REDIS = process.env.TEST_REDIS_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unique = name => `test:${name}:${randomBytes(6).toString("hex")}`;
// Keys of their own, so the copies started by other test files never sweep these tests' rooms
const TEST_PREFIX = `st-test-${randomBytes(4).toString("hex")}:`;
const backends = [["memory", () => memoryStore()], ["redis", () => redisStore(REDIS, { prefix: TEST_PREFIX })]];

// Waits until a new Redis client is connected, so a test does not run into the fail-open path by accident
const connected = async store => {
  for (let i = 0; i < 100 && !store.ready(); i++) await sleep(20);
  assert.ok(store.ready(), "Redis did not connect");
  return store;
};

for (const [name, make] of backends) {
  describe(`${name} store`, { skip: name === "redis" && !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
    let store;
    const open = async () => (store ??= await connected(make()));
    after(() => store?.close());

    it("refuses without counting, and frees the window as it passes", async () => {
      const s = await open();
      const limits = [{ key: unique("window"), max: 3, windowMs: 400 }];
      for (let i = 0; i < 3; i++) assert.equal((await s.take(limits)).ok, true);
      assert.deepEqual(await s.take(limits), { ok: false, index: 0 });
      await sleep(200);
      assert.equal((await s.take(limits)).ok, false, "still full inside the window");
      await sleep(250); // the first three are now older than the window; the refused ones were never counted
      for (let i = 0; i < 3; i++) assert.equal((await s.take(limits)).ok, true, `slot ${i + 1} after the window`);
      assert.equal((await s.take(limits)).ok, false);
    });

    it("counts several keys all together or not at all", async () => {
      const s = await open();
      const a = unique("a"), b = unique("b");
      const both = [{ key: a, max: 2, windowMs: 60000 }, { key: b, max: 5, windowMs: 60000 }];
      assert.equal((await s.take(both)).ok, true);
      assert.equal((await s.take(both)).ok, true);
      assert.deepEqual(await s.take(both), { ok: false, index: 0 });
      // b was counted twice, not three times
      const bOnly = [{ key: b, max: 3, windowMs: 60000 }];
      assert.equal((await s.take(bOnly)).ok, true);
      assert.equal((await s.take(bOnly)).ok, false);
      // the second key full: refused with its index, and the first key is not counted either
      const c = unique("c"), d = unique("d");
      const cd = [{ key: c, max: 10, windowMs: 60000 }, { key: d, max: 1, windowMs: 60000 }];
      assert.equal((await s.take(cd)).ok, true);
      assert.deepEqual(await s.take(cd), { ok: false, index: 1 });
      const cOnly = [{ key: c, max: 2, windowMs: 60000 }];
      assert.equal((await s.take(cOnly)).ok, true);
      assert.equal((await s.take(cOnly)).ok, false);
    });

    it("stays exact under many concurrent calls", async () => {
      const s = await open();
      // One socket hammering: its own limit holds, and the address counts only what was let through
      const sock = unique("sock"), address = unique("addr");
      const one = await Promise.all(Array.from({ length: 50 }, () => s.take([{ key: sock, max: 30, windowMs: 60000 }, { key: address, max: 120, windowMs: 60000 }])));
      assert.equal(one.filter(r => r.ok).length, 30);
      const exactly = async (key, n) => {
        assert.equal((await s.take([{ key, max: n + 1, windowMs: 60000 }])).ok, true, `${key} had more than ${n}`);
        assert.equal((await s.take([{ key, max: n + 1, windowMs: 60000 }])).ok, false, `${key} had fewer than ${n}`);
      };
      await exactly(address, 30);
      // Ten sockets sharing one address: the address limit holds, with no socket over its own
      const shared = unique("shared"), sockets = Array.from({ length: 10 }, () => unique("s"));
      const many = await Promise.all(Array.from({ length: 200 }, (_, i) => s.take([{ key: sockets[i % 10], max: 30, windowMs: 60000 }, { key: shared, max: 120, windowMs: 60000 }])));
      assert.equal(many.filter(r => r.ok).length, 120);
      await exactly(shared, 120);
    });

    it("changes a room one change at a time, also from two copies", async () => {
      const a = await open(), b = name === "memory" ? a : await connected(make()); // memory is one process, one copy
      try {
        const room = unique("room");
        // Each change reads the list, waits a moment in between, and adds itself: a lost update would show up as a gap
        await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? b : a).withRoom(room, doc => { doc.waiting.push(i); doc.host = { key: "h", awayUntil: 0 }; })));
        assert.equal((await a.readRoom(room)).waiting.length, 40);
      } finally {
        if (b !== a) await b.close();
      }
    });

    it("gives the last place to only one of many joins at once", async () => {
      const a = await open(), b = name === "memory" ? a : await connected(make());
      try {
        const room = unique("full");
        const tries = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? b : a).withRoom(room, doc => {
          if (Object.keys(doc.members).length >= 2) return false;
          doc.members[`socket${i}`] = { clientId: null, name: "x", seat: null, copy: "c" };
          return true;
        })));
        assert.equal(tries.filter(Boolean).length, 2);
        assert.equal(Object.keys((await a.readRoom(room)).members).length, 2);
      } finally {
        if (b !== a) await b.close();
      }
    });

    it("saves nothing when a change fails, and runs effects only after saving", async () => {
      const s = await open();
      const room = unique("fail");
      await assert.rejects(s.withRoom(room, doc => { doc.members.x = { copy: "c" }; throw new Error("broken change"); }));
      assert.deepEqual((await s.readRoom(room)).members, {});
      const seen = [];
      await s.withRoom(room, (doc, effect) => { doc.members.y = { copy: "c" }; effect(() => seen.push("effect")); seen.push("change"); });
      assert.deepEqual(seen, ["change", "effect"]);
      assert.equal(await s.bothIn(room, "y", "y"), true);
      assert.equal(await s.bothIn(room, "y", "z"), false);
      await s.withRoom(room, doc => { delete doc.members.y; });
      assert.deepEqual(await s.readRoom(room), { members: {}, held: {}, host: null, waiting: [], removed: [], denied: [] });
    });

    it("hands a room back when something in it is due", async () => {
      const s = await open();
      const room = unique("due"), due = [];
      s.onDue(name => due.push([name, Date.now()]));
      const until = Date.now() + 300;
      await s.withRoom(room, doc => { doc.held.tab1234567890abcd = { id: "s1", name: "x", seat: null, until }; });
      assert.ok(await (async () => { for (let i = 0; i < 40; i++) { if (due.some(([name]) => name === room)) return true; await sleep(50); } return false; })(), "never due");
      const [, at] = due.find(([name]) => name === room);
      assert.ok(at >= until - 5 && at < until + 1300, `due ${at - until} ms after its time`);
    });

    it("forgets one counted request", async () => {
      const s = await open();
      const limits = [{ key: unique("forget"), max: 2, windowMs: 60000 }];
      const first = await s.take(limits);
      assert.equal((await s.take(limits)).ok, true);
      assert.equal((await s.take(limits)).ok, false);
      await s.forget(limits, first.mark);
      assert.equal((await s.take(limits)).ok, true);
      assert.equal((await s.take(limits)).ok, false);
    });
  });
}

describe("redis store details", { skip: !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
  it("prefixes its keys and lets them expire", async () => {
    const Redis = require("ioredis");
    const raw = new Redis(REDIS);
    const store = await connected(redisStore(REDIS));
    try {
      const key = unique("ttl");
      await store.take([{ key, max: 5, windowMs: 1500 }]);
      assert.equal(await raw.exists(key), 0, "a key without the prefix");
      const ttl = await raw.pttl(`st:${key}`);
      assert.ok(ttl > 0 && ttl <= 1500, `ttl ${ttl}`);
      await sleep(1700);
      assert.equal(await raw.exists(`st:${key}`), 0, "the key did not expire");
    } finally {
      await store.close();
      raw.disconnect();
    }
  });

  it("fails open when Redis cannot be reached, and complains once a minute", async () => {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const store = redisStore("redis://127.0.0.1:1"); // nothing listens on port 1
    try {
      const started = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await store.take([{ key: unique("down"), max: 1, windowMs: 60000 }]));
      await sleep(300); // reconnect attempts fail meanwhile too
      assert.ok(Date.now() - started < 2500, "a check waited on the missing Redis");
      assert.ok(results.every(r => r.ok && r.mark === null), JSON.stringify(results));
      assert.equal(store.ready(), false);
      await store.forget([{ key: "x", max: 1, windowMs: 1 }], null);
      assert.equal(errors.length, 1, errors.join(" | "));
      assert.match(errors[0], /^Redis is unavailable, so limits are not enforced and calls cannot start:/);
    } finally {
      console.error = original;
      await store.close();
    }
  });
});

describe("redis rooms across copies", { skip: !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
  it("hands the people of a stopped copy to a running one, and counts calls across copies", async () => {
    const a = await connected(redisStore(REDIS, { prefix: TEST_PREFIX })), b = await connected(redisStore(REDIS, { prefix: TEST_PREFIX }));
    const lost = [];
    b.onCopyLost((name, copy) => lost.push([name, copy]));
    const room = unique("lost");
    try {
      await a.withRoom(room, doc => {
        doc.members.s1 = { clientId: null, name: "x", seat: null, copy: a.copyId };
        doc.members.s2 = { clientId: null, name: "y", seat: null, copy: b.copyId };
      });
      assert.deepEqual(await a.roomsOf(a.copyId).then(rooms => rooms.includes(room)), true);
      const { calls } = await b.liveCounts(1);
      assert.ok(calls >= 1, "a room with two people is not counted as a call");
    } finally {
      await a.close(); // stops saying it is alive
    }
    try {
      // A copy judges others only after 2 * ALIVE_MS of being in touch with Redis itself, and a's "alive" lasts ALIVE_MS
      for (let i = 0; i < 160 && !lost.some(([name]) => name === room); i++) await sleep(100);
      assert.deepEqual(lost.find(([name]) => name === room), [room, a.copyId]);
    } finally {
      await b.withRoom(room, doc => { doc.members = {}; });
      await b.close();
    }
  });
});

// A TCP proxy in front of the test Redis, to make it unreachable and reachable again on demand
const net = require("node:net");
const proxy = () => {
  const target = new URL(REDIS);
  let server = null;
  const sockets = new Set();
  return {
    start: (port = 0) => new Promise(resolve => {
      server = net.createServer(client => {
        const upstream = net.connect(Number(target.port || 6379), target.hostname);
        for (const s of [client, upstream]) {
          sockets.add(s);
          s.on("error", () => {});
          s.on("close", () => { client.destroy(); upstream.destroy(); sockets.delete(s); });
        }
        client.pipe(upstream).pipe(client);
      });
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    }),
    stop: () => new Promise(resolve => {
      sockets.forEach(s => s.destroy());
      server.close(() => resolve());
    }),
  };
};
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const eventually = async (check, ms) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await check()) return true; return false; };

describe("redis rooms: lists, locks and outages", { skip: !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
  it("lists a room for a copy only while that copy has people in it", async () => {
    const s = await connected(redisStore(REDIS, { prefix: TEST_PREFIX }));
    try {
      const room = unique("listed");
      await s.withRoom(room, doc => { doc.members.s1 = { copy: "copyX" }; doc.members.s2 = { copy: "copyY" }; });
      assert.ok((await s.roomsOf("copyX")).includes(room) && (await s.roomsOf("copyY")).includes(room));
      await s.withRoom(room, doc => { delete doc.members.s1; });
      assert.ok(!(await s.roomsOf("copyX")).includes(room), "still listed for a copy with nobody there");
      assert.ok((await s.roomsOf("copyY")).includes(room));
      await s.withRoom(room, doc => { delete doc.members.s2; });
      assert.ok(!(await s.roomsOf("copyY")).includes(room));
    } finally {
      await s.close();
    }
  });

  it("keeps the room locked until the change's messages are sent", async () => {
    const Redis = require("ioredis");
    const raw = new Redis(REDIS);
    const s = await connected(redisStore(REDIS, { prefix: TEST_PREFIX }));
    try {
      const room = unique("locked");
      let during;
      await s.withRoom(room, (doc, effect) => {
        doc.members.s1 = { copy: "c" };
        effect(() => { during = raw.get(`${TEST_PREFIX}lock:${room}`); }); // sent before the store frees the lock
      });
      assert.ok(await during, "the lock was already free when the messages went out");
      assert.equal(await raw.get(`${TEST_PREFIX}lock:${room}`), null, "the lock was not freed afterwards");
    } finally {
      await s.close();
      raw.disconnect();
    }
  });

  it("does not take over the people of copies that were only cut off from Redis for longer than ALIVE_MS", async () => {
    const p = proxy(), port = await p.start();
    const via = `redis://127.0.0.1:${port}`;
    const a = await connected(redisStore(via, { prefix: TEST_PREFIX })), b = await connected(redisStore(via, { prefix: TEST_PREFIX }));
    const lost = [], back = [];
    for (const [s, name] of [[a, "a"], [b, "b"]]) {
      s.onCopyLost((room, copy) => lost.push([name, room, copy]));
      s.onReconnect(wasLost => back.push([name, wasLost]));
    }
    const room = unique("outage");
    try {
      await a.withRoom(room, doc => { doc.members.sa = { copy: a.copyId }; doc.members.sb = { copy: b.copyId }; });
      await p.stop();
      await sleep(8000); // longer than ALIVE_MS: both copies' "alive" run out meanwhile
      await p.start(port);
      assert.ok(await eventually(() => a.ready() && b.ready(), 15000), "did not reconnect");
      await sleep(13000); // past the 2 * ALIVE_MS a copy waits before judging others
      assert.deepEqual(lost.filter(([, r]) => r === room), [], "a copy took over the other's people");
      assert.deepEqual(Object.keys((await a.readRoom(room)).members).sort(), ["sa", "sb"]);
      assert.ok(back.some(([n, l]) => n === "a" && l === false) && back.some(([n, l]) => n === "b" && l === false), JSON.stringify(back));
    } finally {
      await a.withRoom(room, doc => { doc.members = {}; }).catch(() => {});
      await a.close();
      await b.close();
      await p.stop();
    }
  });

  it("tells the server when Redis has lost its data", async () => {
    const Redis = require("ioredis");
    const raw = new Redis(REDIS);
    const s = await connected(redisStore(REDIS, { prefix: TEST_PREFIX }));
    const told = [];
    s.onReconnect(lost => told.push(lost));
    try {
      await sleep(1200); // the run id has been read
      const before = s.runId();
      await raw.del(`${TEST_PREFIX}run`); // as after a Redis restart without saved data
      assert.ok(await eventually(() => told.includes(true), 3000), "not told");
      assert.notEqual(s.runId(), before);
    } finally {
      await s.close();
      raw.disconnect();
    }
  });

  it("starts while Redis is unreachable without ending the process, and works once Redis comes up", async () => {
    const { Server } = require("socket.io");
    const rejections = [];
    const onRejection = err => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    const port = await freePort(), p = proxy();
    // Retries a hundred times faster than usual, so their limit (about 70 s in production) is passed in a moment
    const s = redisStore(`redis://127.0.0.1:${port}`, { prefix: TEST_PREFIX, redisOptions: { retryStrategy: () => 20 } });
    const io = new Server();
    const errors = [], original = console.error, warn = console.warn;
    console.error = (...args) => errors.push(args.join(" "));
    console.warn = () => {};
    try {
      io.adapter(s.adapter());
      await sleep(2500);
      assert.deepEqual(rejections.map(String), [], "an unhandled rejection would end the server");
      assert.equal(s.ready(), false);
      assert.equal((await s.take([{ key: unique("down"), max: 1, windowMs: 1000 }])).ok, true, "limits fail open");
      await p.start(port);
      assert.ok(await eventually(() => s.ready(), 5000), "did not connect once Redis came up");
      // The adapter's subscriber, which waited for Redis, has subscribed by now
      assert.ok(await eventually(async () => (await io.of("/").adapter.serverCount().catch(() => 0)) >= 1, 5000), "the adapter did not subscribe");
      const room = unique("up");
      await s.withRoom(room, doc => { doc.members.s1 = { copy: s.copyId }; });
      assert.equal(await s.bothIn(room, "s1", "s1"), true);
      await s.withRoom(room, doc => { doc.members = {}; });
      assert.deepEqual(rejections.map(String), []);
    } finally {
      process.off("unhandledRejection", onRejection);
      console.error = original;
      console.warn = warn;
      await s.close(); // also closes the adapter's clients; the server here has no HTTP server to close
      await p.stop().catch(() => {});
    }
  });
});
