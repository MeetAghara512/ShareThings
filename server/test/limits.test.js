// The server's limits (limits.js) and invite limits (invite.js) on top of each store: the same numbers, messages and
// local bypass as before. Each backend gets fresh modules, chosen by REDIS_URL as in production.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");

const REDIS = process.env.TEST_REDIS_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODULES = ["../store", "../limits", "../invite"];
const load = url => {
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  if (url) process.env.REDIS_URL = url;
  else delete process.env.REDIS_URL;
  const [store, limits, invite] = MODULES.map(m => require(m));
  return { store: store.getStore(), ...limits, ...invite };
};
// A documentation-range address no other test uses, so tests sharing one Redis never count each other's requests
const address = () => `198.51.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const v6block = () => `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
const socketFrom = (ip, id = randomBytes(8).toString("hex")) => ({ id, handshake: { headers: { "x-forwarded-for": ip }, address: "10.0.0.2" } });
const localSocket = () => ({ id: randomBytes(8).toString("hex"), handshake: { headers: {}, address: "127.0.0.1" } });

for (const [name, url] of [["memory", null], ["redis", REDIS]]) {
  describe(`limits on the ${name} store`, { skip: name === "redis" && !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
    let m;
    before(async () => {
      m = load(url);
      for (let i = 0; i < 100 && !m.store.ready(); i++) await sleep(20);
      assert.ok(m.store.ready());
    });
    after(() => m.store.close());

    it("lets 30 joins a minute through per address, then answers with the same message", async () => {
      const ip = address();
      for (let i = 0; i < 30; i++) assert.equal(await m.joinLimited(socketFrom(ip), () => assert.fail("acked")), false);
      let answer;
      assert.equal(await m.joinLimited(socketFrom(ip), a => (answer = a)), true);
      assert.deepEqual(answer, { full: true, error: "Too many attempts, wait a minute and try again" });
    });

    it("counts IPv6 clients by their /64 and IPv4 written as ::ffff:", async () => {
      const block = v6block();
      for (let i = 0; i < 30; i++) assert.equal(await m.joinLimited(socketFrom(`${block}:${i}::1`), () => {}), false);
      assert.equal(await m.joinLimited(socketFrom(`${block}:ffff::9`), () => {}), true);
      const ip = address();
      for (let i = 0; i < 15; i++) await m.joinLimited(socketFrom(ip), () => {});
      for (let i = 0; i < 15; i++) assert.equal(await m.joinLimited(socketFrom(`::ffff:${ip}`), () => {}), false);
      assert.equal(await m.joinLimited(socketFrom(ip), () => {}), true);
    });

    it("never limits a direct local connection", async () => {
      const local = localSocket();
      for (let i = 0; i < 200; i++) assert.equal(await m.joinLimited(local, () => assert.fail("acked")), false);
      for (let i = 0; i < 200; i++) assert.equal(await m.statsLimited(local), false);
    });

    it("refuses the 31st connection a minute from one address", async () => {
      const ip = address(), results = [];
      for (let i = 0; i < 31; i++) await m.limitConnections(socketFrom(ip), err => results.push(err));
      assert.equal(results.filter(e => e === undefined).length, 30);
      assert.equal(results[30]?.message, "Too many connections, wait a minute");
    });

    it("limits room checks per socket and per address, counting both or neither", async () => {
      const ip = address(), first = socketFrom(ip);
      let answer;
      const results = await Promise.all(Array.from({ length: 35 }, () => m.peekLimited(first, a => (answer = a))));
      assert.equal(results.filter(limited => !limited).length, 30);
      assert.deepEqual(answer, { limited: true });
      // The five refused checks were not counted on the address: three more sockets fit 90 more, exactly 120
      const others = [socketFrom(ip), socketFrom(ip), socketFrom(ip), socketFrom(ip)];
      const more = await Promise.all(Array.from({ length: 120 }, (_, i) => m.peekLimited(others[i % 4], () => {})));
      assert.equal(more.filter(limited => !limited).length, 90);
    });

    it("answers 60 network checks a minute per socket", async () => {
      const socket = socketFrom(address());
      for (let i = 0; i < 60; i++) assert.equal(await m.statsLimited(socket), false);
      assert.equal(await m.statsLimited(socket), true);
    });
  });

  describe(`invite limits on the ${name} store`, { skip: name === "redis" && !REDIS && "set TEST_REDIS_URL to run against Redis" }, () => {
    let m, failNext = 0, sent = 0;
    const realFetch = global.fetch;
    before(async () => {
      process.env.GMAIL_CLIENT_SECRET = "test-secret";
      process.env.GMAIL_REFRESH_TOKEN = "test-token";
      m = load(url);
      const { OAuth2Client } = require("google-auth-library");
      OAuth2Client.prototype.getAccessToken = async () => ({ token: "test-access-token" });
      // Nothing leaves this machine: the Gmail API is answered here
      global.fetch = async () => {
        if (failNext > 0) {
          failNext--;
          return { ok: false, status: 500, text: async () => "test failure" };
        }
        sent++;
        return { ok: true, status: 200, text: async () => "" };
      };
      for (let i = 0; i < 100 && !m.store.ready(); i++) await sleep(20);
    });
    after(async () => {
      global.fetch = realFetch;
      await m.store.close();
    });

    const tag = () => randomBytes(4).toString("hex");
    const inviter = (email, ip) => ({ data: { user: { email, name: "Tester" }, name: "Guest" }, rooms: new Set(["code:room"]), handshake: { headers: { origin: "http://localhost:3000", "x-forwarded-for": ip }, address: "10.0.0.2" } });
    const invite = (socket, to) => m.sendInvite(socket, { to, room: "room" }, ["http://localhost:3000"], "client-id", room => `code:${room}`);
    const errorOf = result => result.error ?? null;

    it("allows 5 invites an hour per sender", async () => {
      const socket = inviter(`sender-${tag()}@example.com`, address());
      for (let i = 0; i < 5; i++) assert.deepEqual(await invite(socket, `guest-${tag()}@example.com`), { ok: true });
      assert.equal(errorOf(await invite(socket, `guest-${tag()}@example.com`)), "You have sent too many invites. Try again in an hour.");
    });

    it("does not count an invite that could not be sent", async () => {
      const socket = inviter(`sender-${tag()}@example.com`, address());
      failNext = 3;
      for (let i = 0; i < 3; i++) assert.equal(errorOf(await invite(socket, `guest-${tag()}@example.com`)), "The invite could not be sent. Copy the invite link above and send it yourself.");
      for (let i = 0; i < 5; i++) assert.deepEqual(await invite(socket, `guest-${tag()}@example.com`), { ok: true });
      assert.equal(errorOf(await invite(socket, `guest-${tag()}@example.com`)), "You have sent too many invites. Try again in an hour.");
    });

    it("allows 10 invites an hour per network", async () => {
      const ip = address();
      for (let i = 0; i < 10; i++) assert.deepEqual(await invite(inviter(`s${i}-${tag()}@example.com`, ip), `guest-${tag()}@example.com`), { ok: true });
      assert.equal(errorOf(await invite(inviter(`late-${tag()}@example.com`, ip), `guest-${tag()}@example.com`)), "Too many invites from your network. Try again in an hour.");
    });

    it("allows 3 invites a day per mailbox, however it is written", async () => {
      const box = `pat${tag()}`;
      const spellings = [`${box}@gmail.com`, `${box.slice(0, 2)}.${box.slice(2)}@gmail.com`, `${box}+work@googlemail.com`];
      for (const to of spellings) assert.deepEqual(await invite(inviter(`s-${tag()}@example.com`, address()), to), { ok: true });
      assert.equal(errorOf(await invite(inviter(`s-${tag()}@example.com`, address()), `${box}+x@gmail.com`)), "This person has already been invited several times today. Try again tomorrow.");
    });

    it("lets only 5 of 8 parallel invites through", async () => {
      const socket = inviter(`sender-${tag()}@example.com`, address());
      const results = await Promise.all(Array.from({ length: 8 }, () => invite(socket, `guest-${tag()}@example.com`)));
      assert.equal(results.filter(r => r.ok).length, 5);
    });

    it("keeps email addresses out of Redis keys", { skip: name !== "redis" }, async () => {
      const Redis = require("ioredis");
      const raw = new Redis(REDIS);
      try {
        const keys = await raw.keys("st:invite:*");
        assert.ok(keys.length > 0);
        assert.ok(keys.every(key => !key.includes("@")), keys.find(key => key.includes("@")));
      } finally {
        raw.disconnect();
      }
    });
  });
}
