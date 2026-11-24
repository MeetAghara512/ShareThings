try { process.loadEnvFile(__dirname + "/.env"); } catch {} // optional local server/.env

const express = require("express");
const http = require("http");
const { createHash, randomBytes } = require("crypto");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");
const { sendInvite } = require("./invite");
const { getIceServers } = require("./turn");
const { clientAddress, limitConnections, joinLimited, peekLimited, statsLimited, waitingLimited } = require("./limits");
const { getStore } = require("./store");
const liveStats = require("./stats");

const app = express();
const server = http.createServer(app);

// Answers at once; the page calls it on load so a sleeping free server starts waking up straight away. While a
// configured Redis cannot be reached it still answers 200: calls in progress keep working (new ones are refused, so no
// copy ever starts a room of its own), and a failing health check would make the host restart the server and cut them
app.get("/health", (req, res) => res.type("text").send(getStore().ready() ? "ok" : "ok, redis down: limits not enforced, new calls refused"));

// Sites allowed to connect; invite emails only ever link to one of these
const ALLOWED_ORIGINS = [
  "https://sharethings-web.onrender.com",
  "http://localhost:3000"
];

// Connections start with a WebSocket. Long-polling, only the fallback where a WebSocket cannot be opened, is allowed by
// the browser only from these sites (CORS). Local development and test servers on any port are allowed too:
// WebSockets were never origin-checked, so this opens nothing new
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const io = new Server(server, {
  cors: {
    origin: (origin, allow) => allow(null, !origin || ALLOWED_ORIGINS.includes(origin) || LOCAL.test(origin)),
    methods: ["GET", "POST"]
  }
});
// With Redis, a message to a person or a room reaches them on whichever copy of the server they are connected to
const adapter = getStore().adapter();
if (adapter) io.adapter(adapter);

// Too many new connections from one internet address are refused (see limits.js)
io.use(limitConnections);

// People online and calls in progress, for the first page (see stats.js)
const stats = liveStats(io, getStore());


const MAX_ROOM_SIZE = 2;
// A dropped connection keeps its seat this long, so the same browser tab can come back to its call
const SEAT_GRACE = 30000;
// Rooms live in the store (see store.js), so with Redis every copy of the server sees the same ones: who is in each
// room and on which copy, seats kept for dropped connections, and who runs it (host: the host's tab, decided here and
// never by a client; removed, denied: tabs kept out until the room is empty; waiting: people asking to join)
const store = getStore();
const COPY = store.copyId;
// People connected to this copy who wait to be let in: request id -> { socket, ack, name, tab }. The host may be on
// another copy, so the answer can arrive through Redis
const pending = new Map();
const REMOVED = "You were removed from this call.";
const CANNOT_REMOVE = "You can't remove this person.";
const DENIED = "You were not let in.";
const CANNOT_ANSWER = "That request is no longer open.";
const NO_SEAT = "The call is full.";
const ASKING_ELSEWHERE = "You are already asking to join another room.";
const OPENED_ELSEWHERE = "This call was opened in another tab.";
const UNAVAILABLE = "Calls cannot start right now. Try again in a moment.";
const MAX_WAITING = 5; // people asking to join one room at the same time
const MAX_WAITING_PER_ADDRESS = 2; // of those, from one internet address
const TOO_MANY_WAITING = "Too many people are waiting, try again soon";
// Bump when client and server must change together (same number as PROTOCOL_VERSION in
// client/src/Pages/VersionBanner.jsx). Every new connection is told it, so a tab opened before a deploy
// can offer a reload
const PROTOCOL_VERSION = 4;

// Public identifier of the Google OAuth client (not a secret). Must match GOOGLE_CLIENT_ID in client/src/useContext/AuthProvider.jsx
const GOOGLE_CLIENT_ID = "123263407226-ltqv9qfv6s58ocr5nvgk2vggoa0addhf.apps.googleusercontent.com";
const googleClient = new OAuth2Client();

// Returns the user Google vouches for, or null when the token is missing, forged, expired or for another app
async function verifyGoogleToken(token) {
  if (typeof token !== "string") return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const { email, email_verified, name } = ticket.getPayload();
    return email_verified ? { email, name } : null;
  } catch {
    return null;
  }
}
// Room codes are free text: abc-defg-hij, older 8-character codes, or a name someone typed. Socket.IO also has a room
// per socket, named after its id, so ours get a prefix no socket id can have: any code is then just a room, live id or not
const ROOM_PREFIX = "code:";
const MAX_ROOM_CODE = 200;
const INVALID_ROOM = "This room link is not valid.";
const ROOM_EVENTS = new Set(["room:join", "room:peek", "room:leave", "room:remove", "room:admit", "room:deny"]);
const roomKey = code => (typeof code === "string" && code.trim() && code.length <= MAX_ROOM_CODE && !/[\x00-\x1f\x7f]/.test(code) ? ROOM_PREFIX + code : null);
const codeOf = key => key.slice(ROOM_PREFIX.length);

// The random id a browser tab sends with room:join and room:peek, or null
const validClientId = id => (typeof id === "string" && /^[\w-]{16,64}$/.test(id) ? id : null);
// What the other person gets instead of the clientId, which would let them take this seat
const seatOf = clientId => clientId && createHash("sha256").update(clientId).digest("hex").slice(0, 16);


// A tab's key in the host and removed lists. The fallback has a ":", so no clientId can ever equal it
const tabOf = socket => socket.data.clientId ?? `socket:${socket.id}`;
const memberTab = (id, member) => member.clientId ?? `socket:${id}`;
// Kept seats still running. Changes end the due ones first (see expireDue); this is for reads made without a change
const keptSeats = room => Object.entries(room.held).filter(([, seat]) => seat.until > Date.now());

// How many have a place in the room besides the asking tab: connected members and seats kept for dropped connections
function othersInRoom(room, socketId, clientId) {
  const members = Object.entries(room.members).filter(([id, member]) => id !== socketId && !(clientId && member.clientId === clientId));
  return members.length + keptSeats(room).filter(([id]) => id !== clientId).length;
}

// The tab still has a place in the room: a kept seat, or an older connection not yet noticed as dead.
// Taking it back after a dropped connection is never refused or counted by the join limit
const ownsSeat = (room, clientId) => !!clientId && (keptSeats(room).some(([id]) => id === clientId) ||
  Object.values(room.members).some(member => member.clientId === clientId));

// Every change to a room goes through here: one at a time per room, and seats or host waits that are due end first.
// effect(fn) runs fn once the change is saved, for messages to people
const change = (name, fn) => store.withRoom(name, (room, effect) => {
  expireDue(room, name, effect);
  return fn(room, effect);
});

// A kept seat whose tab did not come back, or a host who did not come back after a reload. Ended by a timer, or with
// Redis by whichever copy checks due rooms, so it still ends if the copy that started it has stopped
function expireDue(room, name, effect) {
  const now = Date.now();
  for (const [clientId, seat] of Object.entries(room.held)) {
    if (seat.until > now) continue;
    delete room.held[clientId];
    effect(() => io.to(name).emit("user:left", { id: seat.id }));
    settleHost(room, name, effect);
  }
  if (room.host?.awayUntil && room.host.awayUntil <= now) {
    room.host.awayUntil = 0;
    settleHost(room, name, effect);
  }
}
store.onDue(name => change(name, () => {}).catch(err => console.error("Room update failed:", err.message)));

// The same tab joins again: after a dropped connection (resume: the call goes on) or after a reload (a new call).
// It gets back its kept seat, or the seat of an older connection the server has not yet noticed is dead.
// Returns whether it had a seat to take back
function takeSeat(room, name, socketId, clientId, resume, effect) {
  if (!clientId) return false;
  const kept = room.held[clientId];
  const older = Object.keys(room.members).find(id => id !== socketId && room.members[id].clientId === clientId);
  if (!kept && !older) return false;
  delete room.held[clientId];
  if (older) {
    delete room.members[older]; // first, so its disconnect does not tell anyone it left
    effect(() => {
      io.in(older).socketsLeave(name);
      io.in(older).disconnectSockets(true);
    });
  }
  if (!resume) effect(() => io.to(name).except(socketId).emit("user:left", { id: kept?.id ?? older, back: true })); // the old connection ends, the person stays
  return true;
}

// A connection that dropped (not End Call, which disconnects on purpose) keeps its seat for SEAT_GRACE.
// If the tab is not back by then, the other person is told it left
function holdSeat(room, id, reason) {
  const { clientId, name, seat } = room.members[id];
  if (!clientId || reason === "client namespace disconnect") return false;
  delete room.held[clientId];
  room.held[clientId] = { id, name, seat, until: Date.now() + SEAT_GRACE };
  return true;
}

// The first person into an empty room is the host; their tab stays host across a reload or a dropped connection
function noteHost(room, tab) {
  if (!room.host) room.host = { key: tab, awayUntil: 0 };
  else if (room.host.key === tab) room.host.awayUntil = 0;
}

// Closing and reloading a tab look the same from here, so the host gets SEAT_GRACE to come back before anyone takes over
function hostMayReturn(room, socket) {
  if (!room.host || room.host.key !== socket.data.clientId || room.host.awayUntil) return;
  room.host.awayUntil = Date.now() + SEAT_GRACE;
}

// Someone left. If the host is gone for good, the person still here takes over and is told (someone with a kept
// seat hears it in their join answer) and gets the waiting list. An empty room forgets its host and who was removed;
// anyone still waiting is told, and whoever tries again first becomes the host
function settleHost(room, name, effect) {
  const host = room.host;
  if (!host || host.awayUntil) return;
  const here = Object.keys(room.members);
  const kept = Object.keys(room.held);
  if (here.some(id => memberTab(id, room.members[id]) === host.key) || kept.includes(host.key)) return;
  if (!here.length && !kept.length) {
    const waiting = room.waiting;
    Object.assign(room, { host: null, waiting: [], removed: [], denied: [] });
    for (const request of waiting) effect(() => answer(request, { retry: true }));
    return;
  }
  host.key = here.length ? memberTab(here[0], room.members[here[0]]) : kept[0];
  if (here.length) effect(() => io.to(here[0]).emit("room:host", { room: codeOf(name) }));
  sendRequests(room, name, effect);
}

// The room's host, if this socket is it and is in the room
const hostFor = (room, socket) => !!room.host && Object.hasOwn(room.members, socket.id) && room.host.key === tabOf(socket);

// The host's list of people asking to join: the name they typed and a random id for the answer, nothing else
function sendRequests(room, name, effect) {
  const host = room.host && Object.keys(room.members).find(id => memberTab(id, room.members[id]) === room.host.key);
  if (!host) return;
  const requests = room.waiting.map(({ id, name: typed }) => ({ id, name: typed }));
  effect(() => io.to(host).emit("room:requests", { room: codeOf(name), requests }));
}

// Asked only of someone new: not the first person, the host coming back, or a tab returning to its own seat
const mustAsk = (room, socket, tab) => !!room.host && !Object.hasOwn(room.members, socket.id) && !(tab && (tab === room.host.key || ownsSeat(room, tab)));

// Waits outside the Socket.IO room, so no signaling can reach them, and gets no TURN login. The join answer (ack) is
// held until the host decides. One request per connection, limits per address and per room; the refusal says nothing about the room
function askHost(room, name, socket, tab, typed, resume, ack, effect) {
  const mine = socket.data.request;
  if (mine && mine.room !== name) return { reply: { full: true, error: ASKING_ELSEWHERE } };
  const key = tab ?? `socket:${socket.id}`;
  if (mine) {
    room.waiting = room.waiting.filter(request => request.id !== mine.id);
    effect(() => pending.delete(mine.id));
  }
  for (const request of room.waiting.filter(request => request.key === key)) { // the same tab on a newer connection replaces its request
    room.waiting = room.waiting.filter(other => other !== request);
    effect(() => answer(request, { full: true, error: OPENED_ELSEWHERE }));
  }
  if (room.waiting.length >= MAX_WAITING || waitingLimited(socket, room.waiting.map(request => request.address), MAX_WAITING_PER_ADDRESS)) {
    effect(() => { socket.data.request = null; });
    sendRequests(room, name, effect);
    return { reply: { full: true, error: TOO_MANY_WAITING } };
  }
  const id = randomBytes(8).toString("hex");
  room.waiting.push({ id, key, tab, name: typed, resume, address: clientAddress(socket), socket: socket.id, copy: COPY });
  effect(() => {
    socket.data.request = { room: name, id };
    pending.set(id, { socket, ack, name: typed, tab });
    socket.emit("room:waiting", { room: codeOf(name) });
  });
  sendRequests(room, name, effect);
  return { asked: true };
}

// The answer to someone waiting, on this copy or, through Redis, on the copy they are connected to
function answer(request, reply) {
  if (request.copy !== COPY) return io.serverSideEmit("copy:answer", request.id, reply);
  const waiting = pending.get(request.id);
  if (!waiting) return;
  pending.delete(request.id);
  if (waiting.socket.data.request?.id === request.id) waiting.socket.data.request = null;
  waiting.ack(reply);
}
io.on("copy:answer", (id, reply) => answer({ id, copy: COPY }, reply));

// Let in by the host: the seat is already theirs, the copy they are connected to finishes the join. If they have
// gone meanwhile, the seat is let go as for a dropped connection
function admitted(request, name, resumed) {
  if (request.copy !== COPY) return io.serverSideEmit("copy:enter", request.id, request.socket, name, resumed);
  const waiting = pending.get(request.id);
  if (!waiting) return loseMembers(name, id => id === request.socket, "transport close").catch(err => console.error("Leave failed:", err.message));
  pending.delete(request.id);
  waiting.socket.data.request = null;
  finishEnter(name, waiting.socket, waiting.ack, { resumed, name: waiting.name, tab: waiting.tab }).catch(err => console.error("Join failed:", err.message));
}
io.on("copy:enter", (id, socket, name, resumed) => admitted({ id, socket, copy: COPY }, name, resumed));

// Stopped waiting: left, disconnected or went to another room. Gone from the host's list
async function dropRequest(socket) {
  const { room: name, id } = socket.data.request ?? {};
  socket.data.request = null;
  if (!id) return;
  pending.delete(id);
  await change(name, (room, effect) => {
    const left = room.waiting.filter(request => request.id !== id);
    if (left.length === room.waiting.length) return;
    room.waiting = left;
    sendRequests(room, name, effect);
  });
}

// The seat itself, as part of the change that decided to give it
function claimSeat(room, name, id, tab, typed, resume, copy, effect) {
  const resumed = takeSeat(room, name, id, tab, resume, effect);
  room.members[id] = { clientId: tab, name: typed, seat: seatOf(tab), copy };
  noteHost(room, tab ?? `socket:${id}`);
  return resumed;
}

// Gone from a room without a word: the connection closed, or (with Redis) the copy it was on stopped. A tab with an
// id keeps its seat for SEAT_GRACE, others are gone at once. Their requests to join other rooms go too
async function loseMembers(name, gone, reason, goneWaiting = () => false) {
  await change(name, (room, effect) => {
    let changed = false;
    for (const id of Object.keys(room.members).filter(id => gone(id, room.members[id]))) {
      if (!holdSeat(room, id, reason)) effect(() => io.to(name).emit("user:left", { id }));
      delete room.members[id];
      changed = true;
    }
    const waiting = room.waiting.filter(request => !goneWaiting(request));
    if (waiting.length !== room.waiting.length) {
      room.waiting = waiting;
      sendRequests(room, name, effect);
    }
    if (changed) settleHost(room, name, effect);
  });
}
store.onCopyLost((name, copy) => loseMembers(name, (id, member) => member.copy === copy, "transport close", request => request.copy === copy));

// Leaving a room on purpose (the leave button, a closing tab), or for another room (one room per connection)
async function leaveRoom(socket, name, closing) {
  await change(name, (room, effect) => {
    if (!Object.hasOwn(room.members, socket.id)) return;
    const guestMayReturn = closing && room.host?.key !== socket.data.clientId && holdSeat(room, socket.id, "closing");
    delete room.members[socket.id];
    if (!guestMayReturn) effect(() => socket.to(name).emit("user:left", { id: socket.id }));
    if (closing) hostMayReturn(room, socket);
    settleHost(room, name, effect);
  });
  socket.leave(name);
}

// Everything room:join decides in one change: refused, asked to wait, or given a seat (returned, to finish the join)
async function decideJoin(socket, { room: name, name: typed, clientId, resume }, ack) {
  const tab = validClientId(clientId);
  if (!(name && ownsSeat(await store.readRoom(name), tab)) && (await joinLimited(socket, ack))) return null;
  if (socket.disconnected || typeof ack !== "function") return null;
  if (!name) return void ack({ full: true, error: INVALID_ROOM });
  const key = tab ?? `socket:${socket.id}`;
  // Display name shown to the other member: plain text, at most 40 characters
  const shownName = (typeof typed === "string" && typed.trim().slice(0, 40).trim()) || "Guest";
  const decided = await change(name, (room, effect) => {
    if (room.removed.includes(key)) return { reply: { full: true, removed: true, error: REMOVED } };
    if (room.denied.includes(key)) return { reply: { full: true, denied: true, error: DENIED } };
    if (othersInRoom(room, socket.id, tab) >= MAX_ROOM_SIZE) return { reply: { full: true } };
    if (mustAsk(room, socket, tab)) return askHost(room, name, socket, tab, shownName, resume === true, ack, effect);
    const mine = socket.data.request;
    if (mine?.room === name) {
      room.waiting = room.waiting.filter(request => request.id !== mine.id);
      effect(() => {
        socket.data.request = null;
        pending.delete(mine.id);
      });
      sendRequests(room, name, effect);
    }
    return { enter: { resumed: claimSeat(room, name, socket.id, tab, shownName, resume === true, COPY, effect), name: shownName, tab } };
  });
  if (decided.reply) return void ack(decided.reply);
  if (!decided.enter) return null;
  await dropRequest(socket); // asking to join another room until now
  return decided.enter;
}

// The seat is taken: join the Socket.IO room and answer with who is there and the ICE servers
async function finishEnter(name, socket, ack, { resumed, name: typed, tab }) {
  // One room per connection: an accepted join leaves the previous one
  for (const other of [...socket.rooms]) if (other !== socket.id && other !== name) await leaveRoom(socket, other, false);
  // Closed while its seat was being given: its disconnect did not know about this room yet
  if (socket.disconnected) return loseMembers(name, id => id === socket.id, "transport close");
  socket.data.name = typed; // only now: a refused join must not change the name of a request already shown to a host
  socket.data.clientId = tab;
  socket.data.seat = seatOf(tab);
  socket.join(name);

  const iceServers = await getIceServers();
  if (!socket.rooms.has(name) || socket.disconnected) return; // left or disconnected while waiting
  const room = await store.readRoom(name);
  const peerId = Object.keys(room.members).find(id => id !== socket.id) ?? null;
  const peer = peerId && room.members[peerId];
  const isHost = room.host?.key === tabOf(socket);
  ack({ peerId, peerName: peer?.name ?? null, peerSeat: peer?.seat ?? null, peerHeld: keptSeats(room).length > 0, resumed, host: isHost, server: store.runId(), iceServers });
  socket.to(name).emit("user:joined", { id: socket.id, name: socket.data.name, seat: socket.data.seat });
  if (isHost) sendRequests(room, name, effect => effect());
}

// With Redis, a member whose connection closed while Redis could not be reached would stay in the room: this copy
// checks its own people every few seconds and lets go of those it no longer has, as for a dropped connection
if (store.shared) {
  setInterval(async () => {
    try {
      for (const name of await store.roomsOf(COPY)) {
        await loseMembers(name, (id, member) => member.copy === COPY && !io.sockets.sockets.has(id), "transport close", request => request.copy === COPY && !pending.has(request.id));
      }
    } catch {
      // Redis is still down; the next round tries again
    }
  }, 10000).unref();
}

io.on("connection", socket => {
  let joinCheck = null; // a join that has not taken its seat yet, if any (see room:join)
  socket.emit("app:version", { version: PROTOCOL_VERSION });
  socket.emit("stats:update", stats.current());

  // Every event carries an object payload; drop anything else before a handler can throw on it.
  // Room events get the internal room key, or null for a code that is not valid
  socket.use(([event, data], next) => {
    if (data === null || typeof data !== "object") return;
    if (ROOM_EVENTS.has(event)) data.room = roomKey(data.room);
    next();
  });

  // Sign in (or out, with a null token). socket.data.user is the only identity the server trusts.
  socket.on("auth:google", async ({ token }, ack) => {
    socket.data.user = await verifyGoogleToken(token);
    if (typeof ack === "function") ack(socket.data.user);
  });

  // clientId: random per browser tab, so the tab gets its seat back after a dropped connection.
  // resume: the tab still has its call running and wants to keep it
  socket.on("room:join", async (data, ack) => {
    // The checks can wait on Redis. A room:leave sent after this join waits until it has its seat, so it is never
    // handled first, and a connection that closed meanwhile does not join
    let seated;
    const check = (joinCheck = new Promise(r => (seated = r)));
    let entering = null;
    try {
      entering = await decideJoin(socket, data, ack);
    } catch (err) {
      console.error("Join failed:", err.message);
      if (typeof ack === "function" && !socket.disconnected) ack({ full: true, error: UNAVAILABLE });
    } finally {
      seated();
      if (joinCheck === check) joinCheck = null;
    }
    if (entering) await finishEnter(data.room, socket, ack, entering).catch(err => console.error("Join failed:", err.message));
  });

  // Call signaling only ever goes to the other person in the same room: never to a room name, never to a stranger.
  // Without this, anyone with a room link could send an offer to the room and receive the camera of whoever waits there.
  // The room's members are checked in the store, so the other person may be on another copy
  const inSameRoom = async to => {
    if (typeof to !== "string" || to === socket.id) return false;
    for (const room of socket.rooms) {
      if (room.startsWith(ROOM_PREFIX) && (await store.bothIn(room, socket.id, to).catch(() => false))) return true;
    }
    return false;
  };

  // `restart`: an ICE restart of the running call (new network path), not a new call
  socket.on("user:call", async ({ to, offer, restart }) => {
    if (await inSameRoom(to)) io.to(to).emit("incomming:call", { from: socket.id, offer, restart: restart === true });
  });
  socket.on("call:accepted", async ({ to, ans, restart }) => {
    if (await inSameRoom(to)) io.to(to).emit("call:accepted", { from: socket.id, ans, restart: restart === true });
  });
  // ICE restarts are not getting through: ask the side that sent the first offer to restart, or start the connection over
  socket.on("call:restart-request", async ({ to }) => {
    if (await inSameRoom(to)) io.to(to).emit("call:restart-request", { from: socket.id });
  });
  socket.on("call:rebuild", async ({ to }) => {
    if (await inSameRoom(to)) io.to(to).emit("call:rebuild", { from: socket.id });
  });
  socket.on("ice:candidate", async ({ to, candidate }) => {
    if (await inSameRoom(to)) io.to(to).emit("ice:candidate", { from: socket.id, candidate });
  });
  // Camera / mic on or off (or missing), screen shared or not, camera paused by a weak network: the other side shows a placeholder, a muted icon or the screen
  socket.on("media:state", async ({ to, video, audio, screen, hasCamera, hasMic, paused }) => {
    if (await inSameRoom(to)) io.to(to).emit("media:state", { from: socket.id, video: video !== false, audio: audio !== false, screen: screen === true, hasCamera: hasCamera !== false, hasMic: hasMic !== false, paused: paused === true });
  });
  // How large this side shows the other person's camera and screen, and its quality setting, so the sender never
  // sends much more than is shown (see client/src/Services/quality.js)
  socket.on("view:size", async ({ to, camera, screen, mode }) => {
    const size = s => (s && Number.isFinite(s.width) && Number.isFinite(s.height) ? { width: Math.min(8192, Math.max(0, Math.round(s.width))), height: Math.min(8192, Math.max(0, Math.round(s.height))) } : null);
    if (await inSameRoom(to)) io.to(to).emit("view:size", { from: socket.id, camera: size(camera), screen: size(screen), mode: ["auto", "high", "saver"].includes(mode) ? mode : "auto" });
  });

  // Email the room link to a guest; see invite.js for the rules
  socket.on("invite:send", async (payload, ack) => {
    const result = await sendInvite(socket, payload, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID, roomKey);
    if (typeof ack === "function") ack(result);
  });

  // How many people are in a room, for the join screen. Does not join it.
  // A seat kept for this tab itself (its connection dropped, then it reloaded) is not counted
  socket.on("room:peek", async ({ room, clientId }, ack) => {
    if (await peekLimited(socket, ack)) return;
    if (typeof ack !== "function") return;
    let count = 0;
    try {
      // Only how many: anyone with the room code can ask, so never who (names are shown once you are in the call)
      if (room) count = othersInRoom(await store.readRoom(room), socket.id, validClientId(clientId));
    } catch {
      return ack({ limited: true }); // no answer to give: the join screen keeps showing the last one
    }
    // names: only for tabs opened before the count existed, which crash without it. No real name. Remove after a release
    ack({ count, full: count >= MAX_ROOM_SIZE, names: Array(count).fill("Someone"), ...(!room && { invalid: INVALID_ROOM }) });
  });

  // The first page asks when it opens, since it may open after the numbers were sent
  socket.on("stats:get", async (data, ack) => typeof ack === "function" && ack((await statsLimited(socket)) ? { limited: true } : stats.current()));

  // closing: the tab is closing or reloading, so it may be back in a moment. A guest keeps their seat for SEAT_GRACE,
  // so a reload does not have to ask the host again; the host can still remove them meanwhile
  socket.on("room:leave", async ({ room, closing }) => {
    if (joinCheck) await joinCheck; // a join sent before this leave is handled first
    try {
      if (socket.data.request?.room === room) await dropRequest(socket);
      if (room && socket.rooms.has(room)) await leaveRoom(socket, room, closing === true);
    } catch (err) {
      console.error("Leave failed:", err.message);
    }
  });

  // Only the room's current host, and only for someone else in that room, connected or with a kept seat.
  // The same answer for every refusal. Their tab stays out until the room is empty
  socket.on("room:remove", async ({ room: name, to }, ack) => {
    if (typeof ack !== "function") return;
    const removed = name && await change(name, (room, effect) => {
      if (!hostFor(room, socket)) return false;
      const member = typeof to === "string" && Object.hasOwn(room.members, to) ? room.members[to] : null;
      const held = Object.entries(room.held).find(([, seat]) => seat.id === to);
      const tab = member ? memberTab(to, member) : held?.[0];
      if (!tab || tab === room.host.key) return false;
      if (!room.removed.includes(tab)) room.removed.push(tab);
      delete room.held[tab];
      for (const [id, other] of Object.entries(room.members)) {
        if (memberTab(id, other) !== tab) continue;
        delete room.members[id];
        effect(() => {
          io.in(id).socketsLeave(name);
          io.to(id).emit("room:removed", { room: codeOf(name) });
        });
      }
      return true;
    }).catch(() => false);
    if (!removed) return ack({ error: CANNOT_REMOVE });
    ack({ ok: true });
    socket.emit("user:left", { id: to, removed: true });
  });

  // Only the room's current host can answer someone waiting; admitting needs a free seat, which is taken for them in
  // the same change, so nobody else can take it meanwhile
  socket.on("room:admit", async ({ room: name, id }, ack) => {
    if (typeof ack !== "function") return;
    const result = name && await change(name, (room, effect) => {
      const request = hostFor(room, socket) && room.waiting.find(waiting => waiting.id === id);
      if (!request) return { error: CANNOT_ANSWER };
      if (othersInRoom(room, request.socket, request.tab) >= MAX_ROOM_SIZE) return { error: NO_SEAT };
      room.waiting = room.waiting.filter(waiting => waiting !== request);
      sendRequests(room, name, effect);
      return { request, resumed: claimSeat(room, name, request.socket, request.tab, request.name, request.resume, request.copy, effect) };
    }).catch(() => null);
    if (!result || result.error) return ack({ error: result?.error ?? CANNOT_ANSWER });
    ack({ ok: true });
    admitted(result.request, name, result.resumed);
  });

  socket.on("room:deny", async ({ room: name, id }, ack) => {
    if (typeof ack !== "function") return;
    const denied = name && await change(name, (room, effect) => {
      const request = hostFor(room, socket) && room.waiting.find(waiting => waiting.id === id);
      if (!request) return false;
      room.waiting = room.waiting.filter(waiting => waiting !== request);
      if (!room.denied.includes(request.key)) room.denied.push(request.key);
      effect(() => answer(request, { full: true, denied: true, error: DENIED }));
      sendRequests(room, name, effect);
      return true;
    }).catch(() => false);
    ack(denied ? { ok: true } : { error: CANNOT_ANSWER });
  });

  socket.on("disconnecting", reason => {
    const rooms = [...socket.rooms].filter(room => room.startsWith(ROOM_PREFIX));
    dropRequest(socket).catch(err => console.error("Leave failed:", err.message));
    for (const name of rooms) loseMembers(name, id => id === socket.id, reason).catch(err => console.error("Leave failed:", err.message));
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`⚡️ Socket server listening on port ${PORT}`);
});
