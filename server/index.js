try { process.loadEnvFile(__dirname + "/.env"); } catch {} // optional local server/.env

const express = require("express");
const http = require("http");
const { createHash, randomBytes } = require("crypto");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");
const { sendInvite } = require("./invite");

const app = express();
const server = http.createServer(app);

// Sites allowed to connect; invite emails only ever link to one of these
const ALLOWED_ORIGINS = [
  "https://sharethings-web.onrender.com",
  "http://localhost:3000"
];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

const MAX_ROOM_SIZE = 2;
// A dropped connection keeps its seat this long, so the same browser tab can come back to its call
const SEAT_GRACE = 30000;
// Seats kept for dropped connections: room -> Map(clientId -> { id, name, seat, timer }). Memory only
const heldSeats = new Map();
// New on every start, so a client can tell "the server restarted and forgot all seats" from "my seat was given up"
const SERVER_ID = randomBytes(8).toString("hex");

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
const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];

// Short-lived TURN credentials from Xirsys; falls back to STUN when not configured
async function getIceServers() {
  const { XIRSYS_IDENT, XIRSYS_SECRET, XIRSYS_CHANNEL } = process.env;
  if (!XIRSYS_IDENT || !XIRSYS_SECRET || !XIRSYS_CHANNEL) return STUN_ONLY;
  try {
    const res = await fetch(`https://global.xirsys.net/_turn/${XIRSYS_CHANNEL}`, {
      method: "PUT",
      headers: {
        Authorization: "Basic " + Buffer.from(`${XIRSYS_IDENT}:${XIRSYS_SECRET}`).toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ format: "urls" }),
      signal: AbortSignal.timeout(5000)
    });
    const { s, v } = await res.json();
    if (s !== "ok") throw new Error(v);
    return [].concat(v.iceServers);
  } catch (err) {
    console.error("TURN credentials unavailable, using STUN only:", err.message);
    return STUN_ONLY;
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
  }, SEAT_GRACE);
  if (!heldSeats.has(room)) heldSeats.set(room, new Map());
  heldSeats.get(room).set(clientId, { id: socket.id, name, seat, timer });
  return true;
}

function releaseSeat(room, clientId) {
  const seats = heldSeats.get(room);
  clearTimeout(seats?.get(clientId)?.timer);
  seats?.delete(clientId);
  if (seats?.size === 0) heldSeats.delete(room);
}

io.on("connection", socket => {

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
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    // Display name shown to the other member: plain text, at most 40 characters
    socket.data.name = (typeof name === "string" && name.trim().slice(0, 40).trim()) || "Guest";
    const tab = validClientId(clientId);
    if (othersInRoom(room, socket, tab).length >= MAX_ROOM_SIZE) return ack({ full: true });
    const resumed = takeSeat(room, socket, tab, resume === true);
    socket.join(room);

    const iceServers = await getIceServers();
    if (!socket.rooms.has(room)) return; // left or disconnected while waiting
    const peerId = [...io.sockets.adapter.rooms.get(room)].find(id => id !== socket.id) ?? null;
    const peerName = io.sockets.sockets.get(peerId)?.data.name ?? null;
    const peerSeat = io.sockets.sockets.get(peerId)?.data.seat ?? null;
    ack({ peerId, peerName, peerSeat, peerHeld: heldSeats.has(room), resumed, server: SERVER_ID, iceServers });
    socket.to(room).emit("user:joined", { id: socket.id, name: socket.data.name, seat: socket.data.seat });
  });

  // `restart`: an ICE restart of the running call (new network path), not a new call
  socket.on("user:call", ({ to, offer, restart }) =>
    io.to(to).emit("incomming:call", { from: socket.id, offer, restart: restart === true })
  );
  socket.on("call:accepted", ({ to, ans, restart }) =>
    io.to(to).emit("call:accepted", { from: socket.id, ans, restart: restart === true })
  );
  // ICE restarts are not getting through: ask the side that sent the first offer to restart, or start the connection over
  socket.on("call:restart-request", ({ to }) =>
    io.to(to).emit("call:restart-request", { from: socket.id })
  );
  socket.on("call:rebuild", ({ to }) =>
    io.to(to).emit("call:rebuild", { from: socket.id })
  );
  socket.on("ice:candidate", ({ to, candidate }) =>
    io.to(to).emit("ice:candidate", { from: socket.id, candidate })
  );
  // Camera / mic on or off and screen shared or not, so the other side can show a placeholder, a muted icon and the screen
  socket.on("media:state", ({ to, video, audio, screen }) =>
    io.to(to).emit("media:state", { from: socket.id, video: video !== false, audio: audio !== false, screen: screen === true })
  );

  // Email the room link to a guest; see invite.js for the rules
  socket.on("invite:send", async (payload, ack) => {
    const result = await sendInvite(socket, payload, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID);
    if (typeof ack === "function") ack(result);
  });

  // Names of the people in a room, for the join screen. Does not join it.
  // A seat kept for this tab itself (its connection dropped, then it reloaded) is not counted
  socket.on("room:peek", ({ room, clientId }, ack) => {
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    const others = othersInRoom(room, socket, validClientId(clientId));
    ack({ names: others.map(o => o.name ?? "Guest"), full: others.length >= MAX_ROOM_SIZE });
  });

  socket.on("room:leave", ({ room }) => {
    if (room === socket.id || !socket.rooms.has(room)) return;
    socket.to(room).emit("user:left", { id: socket.id });
    socket.leave(room);
  });

  socket.on("disconnecting", reason => {
    socket.rooms.forEach(room => {
      if (room !== socket.id && !holdSeat(room, socket, reason)) socket.to(room).emit("user:left", { id: socket.id });
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`⚡️ Socket server listening on port ${PORT}`);
});
