try { process.loadEnvFile(__dirname + "/.env"); } catch {} // optional local server/.env

const express = require("express");
const http = require("http");
const { createHash, randomBytes } = require("crypto");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");
const { sendInvite } = require("./invite");
const { getIceServers } = require("./turn");
const { limitConnections, joinLimited, peekLimited } = require("./limits");
const liveStats = require("./stats");

const app = express();
const server = http.createServer(app);

// Answers at once; the page calls it on load so a sleeping free server starts waking up straight away
app.get("/health", (req, res) => res.type("text").send("ok"));

// Sites allowed to connect; invite emails only ever link to one of these
const ALLOWED_ORIGINS = [
  "https://sharethings-web.onrender.com",
  "http://localhost:3000"
];

// Connections start with long-polling, which the browser only allows from these sites (CORS). Local development
// and test servers on any port are allowed too: WebSockets were never origin-checked, so this opens nothing new
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const io = new Server(server, {
  cors: {
    origin: (origin, allow) => allow(null, !origin || ALLOWED_ORIGINS.includes(origin) || LOCAL.test(origin)),
    methods: ["GET", "POST"]
  }
});

// Too many new connections from one internet address are refused (see limits.js)
io.use(limitConnections);

// People online and calls in progress, for the first page (see stats.js)
const stats = liveStats(io);

const MAX_ROOM_SIZE = 2;
// A dropped connection keeps its seat this long, so the same browser tab can come back to its call
const SEAT_GRACE = 30000;
// Seats kept for dropped connections: room -> Map(clientId -> { id, name, seat, timer }). Memory only
const heldSeats = new Map();
// Who runs each room: room -> { key, away, removed }. key: the host's tab, decided here and never by a client.
// away: timer while that tab may be reloading. removed: tabs kept out until the room is empty. Memory only
const hosts = new Map();
const REMOVED = "You were removed from this call.";
const CANNOT_REMOVE = "You can't remove this person.";
// New on every start, so a client can tell "the server restarted and forgot all seats" from "my seat was given up"
const SERVER_ID = randomBytes(8).toString("hex");

// Bump when client and server must change together (same number as PROTOCOL_VERSION in
// client/src/Pages/VersionBanner.jsx). Every new connection is told it, so a tab opened before a deploy
// can offer a reload
const PROTOCOL_VERSION = 3;

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
// The random id a browser tab sends with room:join and room:peek, or null
const validClientId = id => (typeof id === "string" && /^[\w-]{16,64}$/.test(id) ? id : null);
// What the other person gets instead of the clientId, which would let them take this seat
const seatOf = clientId => clientId && createHash("sha256").update(clientId).digest("hex").slice(0, 16);

// Everyone with a place in the room except the asking tab: connected members and seats kept for dropped connections
function othersInRoom(room, socket, clientId) {
  // Every socket also sits in a room named after its own id; never report on those
  const ids = io.sockets.sockets.has(room) ? [] : [...(io.sockets.adapter.rooms.get(room) ?? [])];
  const members = ids.map(id => io.sockets.sockets.get(id)).filter(s => s && s !== socket && !(clientId && s.data.clientId === clientId));
  const kept = [...(heldSeats.get(room) ?? [])].filter(([id]) => id !== clientId).map(([, seat]) => seat);
  return [...members.map(s => s.data), ...kept];
}

// The same tab joins again: after a dropped connection (resume: the call goes on) or after a reload (a new call).
// It gets back its kept seat, or the seat of an older connection the server has not yet noticed is dead.
// Returns whether it had a seat to take back
function takeSeat(room, socket, clientId, resume) {
  socket.data.clientId = clientId;
  socket.data.seat = seatOf(clientId);
  if (!clientId) return false;
  const kept = heldSeats.get(room)?.get(clientId);
  const older = [...(io.sockets.adapter.rooms.get(room) ?? [])].map(id => io.sockets.sockets.get(id)).find(s => s && s !== socket && s.data.clientId === clientId);
  if (!kept && !older) return false;
  releaseSeat(room, clientId);
  if (older) {
    older.leave(room); // first, so its disconnect does not tell anyone it left
    older.disconnect(true);
  }
  if (!resume) socket.to(room).emit("user:left", { id: (kept ?? older).id });
  return true;
}

// A connection that dropped (not End Call, which disconnects on purpose) keeps its seat for SEAT_GRACE.
// If the tab is not back by then, the other person is told it left
function holdSeat(room, socket, reason) {
  const { clientId, name, seat } = socket.data;
  if (!clientId || reason === "client namespace disconnect") return false;
  releaseSeat(room, clientId);
  const timer = setTimeout(() => {
    releaseSeat(room, clientId);
    io.to(room).emit("user:left", { id: socket.id });
    settleHost(room);
  }, SEAT_GRACE);
  if (!heldSeats.has(room)) heldSeats.set(room, new Map());
  heldSeats.get(room).set(clientId, { id: socket.id, name, seat, timer });
  return true;
}

// The tab still has a place in the room: a kept seat, or an older connection not yet noticed as dead.
// Taking it back after a dropped connection is never refused or counted by the join limit
const ownsSeat = (room, clientId) => !!clientId && (!!heldSeats.get(room)?.has(clientId) ||
  [...(io.sockets.adapter.rooms.get(room) ?? [])].some(id => io.sockets.sockets.get(id)?.data.clientId === clientId));

function releaseSeat(room, clientId) {
  const seats = heldSeats.get(room);
  clearTimeout(seats?.get(clientId)?.timer);
  seats?.delete(clientId);
  if (seats?.size === 0) heldSeats.delete(room);
}

// A tab's key in the host and removed lists. The fallback has a ":", so no clientId can ever equal it
const tabOf = socket => socket.data.clientId ?? `socket:${socket.id}`;
const membersOf = room => [...(io.sockets.adapter.rooms.get(room) ?? [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);

// The first person into an empty room is the host; their tab stays host across a reload or a dropped connection
function noteHost(room, socket) {
  const host = hosts.get(room);
  if (!host) hosts.set(room, { key: tabOf(socket), away: null, removed: new Set() });
  else if (host.key === tabOf(socket)) {
    clearTimeout(host.away);
    host.away = null;
  }
}

// Closing and reloading a tab look the same from here, so the host gets SEAT_GRACE to come back before anyone takes over
function hostMayReturn(room, socket) {
  const host = hosts.get(room);
  if (!host || host.key !== socket.data.clientId || host.away) return;
  host.away = setTimeout(() => {
    host.away = null;
    settleHost(room);
  }, SEAT_GRACE);
}

// Someone left. If the host is gone for good, the person still here takes over and is told (someone with a kept
// seat hears it in their join answer). An empty room forgets its host and who was removed
function settleHost(room, leaving) {
  const host = hosts.get(room);
  if (!host || host.away) return;
  const here = membersOf(room).filter(s => s !== leaving);
  const kept = [...(heldSeats.get(room)?.keys() ?? [])];
  if (here.some(s => tabOf(s) === host.key) || kept.includes(host.key)) return;
  if (!here.length && !kept.length) return hosts.delete(room);
  host.key = here.length ? tabOf(here[0]) : kept[0];
  here[0]?.emit("room:host", { room });
}

io.on("connection", socket => {
  socket.emit("app:version", { version: PROTOCOL_VERSION });
  socket.emit("stats:update", stats.current());

  // Every event carries an object payload; drop anything else before a handler can throw on it
  socket.use(([, data], next) => {
    if (data !== null && typeof data === "object") next();
  });

  // Sign in (or out, with a null token). socket.data.user is the only identity the server trusts.
  socket.on("auth:google", async ({ token }, ack) => {
    socket.data.user = await verifyGoogleToken(token);
    if (typeof ack === "function") ack(socket.data.user);
  });

  // clientId: random per browser tab, so the tab gets its seat back after a dropped connection.
  // resume: the tab still has its call running and wants to keep it
  socket.on("room:join", async ({ room, name, clientId, resume }, ack) => {
    if (!ownsSeat(room, validClientId(clientId)) && joinLimited(socket, ack)) return;
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    // Every socket also sits in a room named after its own id; joining one of those would put a stranger "in the same room"
    if (io.sockets.sockets.has(room)) return ack({ full: true });
    if (hosts.get(room)?.removed.has(validClientId(clientId))) return ack({ full: true, removed: true, error: REMOVED });
    // Display name shown to the other member: plain text, at most 40 characters
    socket.data.name = (typeof name === "string" && name.trim().slice(0, 40).trim()) || "Guest";
    const tab = validClientId(clientId);
    if (othersInRoom(room, socket, tab).length >= MAX_ROOM_SIZE) return ack({ full: true });
    const resumed = takeSeat(room, socket, tab, resume === true);
    socket.join(room);
    noteHost(room, socket);

    const iceServers = await getIceServers();
    if (!socket.rooms.has(room)) return; // left or disconnected while waiting
    const peerId = [...io.sockets.adapter.rooms.get(room)].find(id => id !== socket.id) ?? null;
    const peerName = io.sockets.sockets.get(peerId)?.data.name ?? null;
    const peerSeat = io.sockets.sockets.get(peerId)?.data.seat ?? null;
    ack({ peerId, peerName, peerSeat, peerHeld: heldSeats.has(room), resumed, host: hosts.get(room)?.key === tabOf(socket), server: SERVER_ID, iceServers });
    socket.to(room).emit("user:joined", { id: socket.id, name: socket.data.name, seat: socket.data.seat });
  });

  // Call signaling only ever goes to the other person in the same room: never to a room name, never to a stranger.
  // Without this, anyone with a room link could send an offer to the room and receive the camera of whoever waits there.
  const inSameRoom = to =>
    typeof to === "string" && to !== socket.id && io.sockets.sockets.has(to) &&
    [...socket.rooms].some(room => !io.sockets.sockets.has(room) && io.sockets.adapter.rooms.get(room)?.has(to));

  // `restart`: an ICE restart of the running call (new network path), not a new call
  socket.on("user:call", ({ to, offer, restart }) => {
    if (inSameRoom(to)) io.to(to).emit("incomming:call", { from: socket.id, offer, restart: restart === true });
  });
  socket.on("call:accepted", ({ to, ans, restart }) => {
    if (inSameRoom(to)) io.to(to).emit("call:accepted", { from: socket.id, ans, restart: restart === true });
  });
  // ICE restarts are not getting through: ask the side that sent the first offer to restart, or start the connection over
  socket.on("call:restart-request", ({ to }) => {
    if (inSameRoom(to)) io.to(to).emit("call:restart-request", { from: socket.id });
  });
  socket.on("call:rebuild", ({ to }) => {
    if (inSameRoom(to)) io.to(to).emit("call:rebuild", { from: socket.id });
  });
  socket.on("ice:candidate", ({ to, candidate }) => {
    if (inSameRoom(to)) io.to(to).emit("ice:candidate", { from: socket.id, candidate });
  });
  // Camera / mic on or off (or missing), screen shared or not, camera paused by a weak network: the other side shows a placeholder, a muted icon or the screen
  socket.on("media:state", ({ to, video, audio, screen, hasCamera, hasMic, paused }) => {
    if (inSameRoom(to)) io.to(to).emit("media:state", { from: socket.id, video: video !== false, audio: audio !== false, screen: screen === true, hasCamera: hasCamera !== false, hasMic: hasMic !== false, paused: paused === true });
  });
  // How large this side shows the other person's camera and screen, and its quality setting, so the sender never
  // sends much more than is shown (see client/src/Services/quality.js)
  socket.on("view:size", ({ to, camera, screen, mode }) => {
    const size = s => (s && Number.isFinite(s.width) && Number.isFinite(s.height) ? { width: Math.min(8192, Math.max(0, Math.round(s.width))), height: Math.min(8192, Math.max(0, Math.round(s.height))) } : null);
    if (inSameRoom(to)) io.to(to).emit("view:size", { from: socket.id, camera: size(camera), screen: size(screen), mode: ["auto", "high", "saver"].includes(mode) ? mode : "auto" });
  });

  // Email the room link to a guest; see invite.js for the rules
  socket.on("invite:send", async (payload, ack) => {
    const result = await sendInvite(socket, payload, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID);
    if (typeof ack === "function") ack(result);
  });

  // Names of the people in a room, for the join screen. Does not join it.
  // A seat kept for this tab itself (its connection dropped, then it reloaded) is not counted
  socket.on("room:peek", ({ room, clientId }, ack) => {
    if (peekLimited(socket, ack)) return;
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    // Only how many: anyone with the room code can ask, so never who (names are shown once you are in the call)
    const count = othersInRoom(room, socket, validClientId(clientId)).length;
    ack({ count, full: count >= MAX_ROOM_SIZE });
  });

  // The first page asks when it opens, since it may open after the numbers were sent
  socket.on("stats:get", (data, ack) => typeof ack === "function" && ack(stats.current()));

  // closing: the tab is closing or reloading, so a host may be back in a moment
  socket.on("room:leave", ({ room, closing }) => {
    if (room === socket.id || !socket.rooms.has(room)) return;
    socket.to(room).emit("user:left", { id: socket.id });
    if (closing === true) hostMayReturn(room, socket);
    socket.leave(room);
    settleHost(room);
  });

  // Only the room's current host, and only for someone else in that room, connected or with a kept seat.
  // The same answer for every refusal. Their tab stays out until the room is empty
  socket.on("room:remove", ({ room, to }, ack) => {
    if (typeof ack !== "function") return;
    const host = hosts.get(room);
    if (!host || !socket.rooms.has(room) || host.key !== tabOf(socket)) return ack({ error: CANNOT_REMOVE });
    const member = membersOf(room).find(s => s.id === to);
    const held = [...(heldSeats.get(room) ?? [])].find(([, seat]) => seat.id === to);
    const tab = member ? tabOf(member) : held?.[0];
    if (!tab || tab === host.key) return ack({ error: CANNOT_REMOVE });
    host.removed.add(tab);
    releaseSeat(room, tab);
    membersOf(room).filter(s => tabOf(s) === tab).forEach(s => {
      s.leave(room);
      s.emit("room:removed", { room });
    });
    ack({ ok: true });
    socket.emit("user:left", { id: to });
  });

  socket.on("disconnecting", reason => {
    socket.rooms.forEach(room => {
      if (room === socket.id) return;
      if (!holdSeat(room, socket, reason)) socket.to(room).emit("user:left", { id: socket.id });
      settleHost(room, socket);
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`⚡️ Socket server listening on port ${PORT}`);
});
