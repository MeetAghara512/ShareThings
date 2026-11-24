// Without REDIS_URL the server has no Redis client at all
const { it } = require("node:test");
const assert = require("node:assert/strict");

it("uses memory and never loads ioredis when REDIS_URL is not set", async () => {
  delete process.env.REDIS_URL;
  const { getStore } = require("../store");
  const store = getStore();
  assert.equal(store.ready(), true);
  assert.equal((await store.take([{ key: "k", max: 1, windowMs: 1000 }])).ok, true);
  assert.equal((await store.take([{ key: "k", max: 1, windowMs: 1000 }])).ok, false);
  assert.ok(!Object.keys(require.cache).some(path => path.includes(`${require("node:path").sep}ioredis${require("node:path").sep}`)), "ioredis was loaded");
  await store.close();
});
