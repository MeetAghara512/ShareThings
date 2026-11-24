// The store's limiter, against memory and, when TEST_REDIS_URL is set, against a real Redis.
// Run: TEST_REDIS_URL=redis://127.0.0.1:6390 npm test
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { memoryStore, redisStore } = require("../store");

const REDIS = process.env.TEST_REDIS_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unique = name => `test:${name}:${randomBytes(6).toString("hex")}`;
const backends = [["memory", () => memoryStore()], ["redis", () => redisStore(REDIS)]];

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
      assert.match(errors[0], /^Redis is unavailable, so limits are not enforced:/);
    } finally {
      console.error = original;
      await store.close();
    }
  });
});
