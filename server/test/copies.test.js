// Three real server copies sharing one Redis: a guest on one copy admitted by a host on another keeps a plain seat, and
// the third copy, which also hears the admission, does nothing to it.
// Run: TEST_REDIS_URL=redis://127.0.0.1:6390 npm test (needs the client's socket.io-client, installed with the app)
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

const REDIS = process.env.TEST_REDIS_URL;
let io;
try {
  ({ io } = require(path.join(__dirname, "../../client/node_modules/socket.io-client")));
} catch {
  io = null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const id = () => randomBytes(16).toString("hex");

it("admits a guest across copies with a third copy running", { skip: (!REDIS && "set TEST_REDIS_URL to run against Redis") || (!io && "the client's socket.io-client is not installed") }, async () => {
  const servers = [], sockets = [];
  try {
    const ports = [await freePort(), await freePort(), await freePort()];
    for (const port of ports) {
      servers.push(spawn(process.execPath, ["index.js"], { cwd: path.join(__dirname, ".."), env: { PATH: process.env.PATH, PORT: String(port), REDIS_URL: REDIS }, stdio: "ignore" }));
    }
    for (const port of ports) {
      for (let i = 0; i < 100; i++) {
        const body = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.text(), () => "");
        if (body === "ok") break;
        await sleep(100);
      }
    }
    const connect = port => new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
      s.got = [];
      s.onAny((event, data) => s.got.push([event, data]));
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
    const ask = (s, event, data, ms = 5000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("no answer to " + event)), ms); s.emit(event, data, a => { clearTimeout(t); resolve(a); }); });
    const host = await connect(ports[0]), guest = await connect(ports[1]);
    await connect(ports[2]); // the third copy has a connection too
    const room = "copies-" + id().slice(0, 8);
    assert.equal((await ask(host, "room:join", { room, name: "Hana", clientId: id() })).host, true);
    const answer = ask(guest, "room:join", { room, name: "Ravi", clientId: id() }, 10000);
    let requests = [];
    for (let i = 0; i < 50 && !requests.length; i++) {
      requests = host.got.filter(([e]) => e === "room:requests").at(-1)?.[1].requests ?? [];
      await sleep(100);
    }
    assert.equal(requests.length, 1, "the host did not see the request");
    assert.deepEqual(await ask(host, "room:admit", { room, id: requests[0].id }), { ok: true });
    assert.equal((await answer).peerId, host.id);
    await sleep(2000);
    // Seen from a fourth connection: two people in the room, so nobody's seat was turned into a kept one
    const viewer = await connect(ports[2]);
    assert.equal((await ask(viewer, "room:peek", { room })).count, 2);
    const Redis = require("ioredis");
    const raw = new Redis(REDIS);
    const saved = JSON.parse(await raw.get(`st:room:code:${room}`));
    raw.disconnect();
    assert.deepEqual(Object.keys(saved.members).sort(), [host.id, guest.id].sort());
    assert.deepEqual(saved.held, {}, "the guest's seat was turned into a kept seat");
    assert.ok(!guest.got.some(([e]) => e === "user:left") && !host.got.some(([e]) => e === "user:left"));
  } finally {
    sockets.forEach(s => s.close());
    await Promise.all(servers.map(server => new Promise(resolve => { server.once("exit", resolve); server.kill("SIGTERM"); })));
  }
});
