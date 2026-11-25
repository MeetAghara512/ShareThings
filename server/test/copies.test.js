// Real server copies sharing one Redis.
// Run: TEST_REDIS_URL=redis://127.0.0.1:6390 npm test (needs the client's socket.io-client, installed with the app)
const { describe, it, before, after } = require("node:test");
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
const skip = (!REDIS && "set TEST_REDIS_URL to run against Redis") || (!io && "the client's socket.io-client is not installed");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const id = () => randomBytes(16).toString("hex");
const eventually = async (check, ms) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await check()) return true; return false; };

// n copies of the server, each ready; their processes go into servers, their connections into sockets
async function copies(n, servers, sockets) {
  const ports = [];
  for (let i = 0; i < n; i++) ports.push(await freePort());
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
  return { ports, connect };
}
const stopAll = async (servers, sockets) => {
  sockets.forEach(s => s.close());
  await Promise.all(servers.map(server => new Promise(resolve => {
    if (server.exitCode !== null || server.signalCode) return resolve();
    server.once("exit", resolve);
    server.kill("SIGCONT"); // in case a test left it stopped
    server.kill("SIGTERM");
  })));
};
const ask = (s, event, data, ms = 5000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("no answer to " + event)), ms); s.emit(event, data, a => { clearTimeout(t); resolve(a); }); });
// The host's latest list of people asking to join
const requestsSeen = async (host, count) => {
  let requests = [];
  for (let i = 0; i < 50 && requests.length !== count; i++) {
    requests = host.got.filter(([e]) => e === "room:requests").at(-1)?.[1].requests ?? [];
    await sleep(100);
  }
  return requests;
};
const leftSeen = (...sockets) => sockets.some(s => s.got.some(([e]) => e === "user:left"));

// A guest on one copy admitted by a host on another keeps a plain seat, and the third copy, which also hears the
// admission, does nothing to it
it("admits a guest across copies with a third copy running", { skip }, async () => {
  const servers = [], sockets = [];
  try {
    const { ports, connect } = await copies(3, servers, sockets);
    const host = await connect(ports[0]), guest = await connect(ports[1]);
    await connect(ports[2]); // the third copy has a connection too
    const room = "copies-" + id().slice(0, 8);
    assert.equal((await ask(host, "room:join", { room, name: "Hana", clientId: id() })).host, true);
    const answer = ask(guest, "room:join", { room, name: "Ravi", clientId: id() }, 10000);
    const requests = await requestsSeen(host, 1);
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
    assert.ok(!leftSeen(guest, host));
  } finally {
    await stopAll(servers, sockets);
  }
});

// Copy 2 freezes (SIGSTOP) for longer than ALIVE_MS. Its connections, to Redis and to people, stay open, so it never
// reconnects; copy 1 takes it for stopped and sweeps it. Then it carries on (SIGCONT)
describe("a copy swept while it was only stalled", { skip }, () => {
  const servers = [], sockets = [];
  let raw, call, alone, across, sweptAt = 0, resumedAt = 0;
  const doc = async room => JSON.parse((await raw.get(`st:room:code:${room}`)) || "null");

  before(async () => {
    const Redis = require("ioredis");
    raw = new Redis(REDIS);
    const { ports, connect } = await copies(2, servers, sockets);
    const tab = () => ({ clientId: id() });
    // A call across the copies: host on copy 1, guest on copy 2
    call = { room: "stall-call-" + id().slice(0, 8), host: await connect(ports[0]), guest: await connect(ports[1]) };
    assert.equal((await ask(call.host, "room:join", { room: call.room, name: "Hana", ...tab() })).host, true);
    const entered = ask(call.guest, "room:join", { room: call.room, name: "Ravi", ...tab() }, 10000);
    const [request] = await requestsSeen(call.host, 1);
    assert.deepEqual(await ask(call.host, "room:admit", { room: call.room, id: request.id }), { ok: true });
    assert.equal((await entered).peerId, call.host.id);
    // Host and someone asking both on copy 2: the sweep drops that request along with the host's seat
    alone = { room: "stall-alone-" + id().slice(0, 8), host: await connect(ports[1]), asker: await connect(ports[1]) };
    assert.equal((await ask(alone.host, "room:join", { room: alone.room, name: "Mina", ...tab() })).host, true);
    alone.answer = ask(alone.asker, "room:join", { room: alone.room, name: "Omar", ...tab() }, 90000).then(reply => ({ reply, at: Date.now() }), err => ({ error: err.message }));
    assert.equal((await requestsSeen(alone.host, 1)).length, 1);
    // Host on copy 1, someone asking on copy 2: the room is not copy 2's, so the request stays
    across = { room: "stall-across-" + id().slice(0, 8), host: await connect(ports[0]), asker: await connect(ports[1]) };
    assert.equal((await ask(across.host, "room:join", { room: across.room, name: "Lea", ...tab() })).host, true);
    across.answer = ask(across.asker, "room:join", { room: across.room, name: "Ivo", ...tab() }, 90000).then(reply => ({ reply, at: Date.now() }), err => ({ error: err.message }));
    assert.equal((await requestsSeen(across.host, 1)).length, 1);

    servers[1].kill("SIGSTOP");
    // Copy 1 sweeps it once its "alive" has run out (and copy 1 has been in touch with Redis for 2 * ALIVE_MS)
    if (await eventually(async () => Object.keys((await doc(call.room))?.held ?? {}).length === 1, 30000)) sweptAt = Date.now();
    servers[1].kill("SIGCONT");
    resumedAt = Date.now();
  });

  after(async () => {
    await stopAll(servers, sockets);
    raw?.disconnect();
  });

  it("gives its people their seats back, and nobody is told anyone left", async () => {
    assert.ok(sweptAt, "copy 1 did not sweep the stalled copy");
    const back = async () => {
      const [a, b] = [await doc(call.room), await doc(alone.room)];
      return Object.keys(a.members).length === 2 && !Object.keys(a.held).length && Object.keys(b.members).length === 1 && !Object.keys(b.held).length;
    };
    assert.ok(await eventually(back, 5000), `seats not given back: ${JSON.stringify([await doc(call.room), await doc(alone.room)])}`);
    // Past the 30 s a kept seat lasts: had a seat stayed kept, the others would now have been told that person left
    await sleep(Math.max(0, sweptAt + 33000 - Date.now()));
    assert.ok(await back(), "a seat was lost later");
    assert.ok(!leftSeen(call.host, call.guest, alone.host, alone.asker, across.host, across.asker), "someone was told a person left");
  });

  it("tells someone whose request the sweep dropped to ask again, and leaves other requests waiting", async () => {
    const { reply, at, error } = await alone.answer;
    assert.deepEqual(reply, { retry: true }, error);
    assert.ok(at - resumedAt < 5000, `told after ${at - resumedAt} ms`);
    // The request in a room that was not the stalled copy's was not dropped: the host can still let them in
    const [request] = await requestsSeen(across.host, 1);
    assert.ok(request, "the host lost the request");
    assert.deepEqual(await ask(across.host, "room:admit", { room: across.room, id: request.id }), { ok: true });
    const { reply: entered } = await across.answer;
    assert.equal(entered?.peerId, across.host.id);
  });
});
