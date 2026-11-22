try { process.loadEnvFile(__dirname + "/.env"); } catch {} // optional local server/.env

const express = require("express");
const http = require("http");
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

  socket.on("room:join", async ({ room, name }, ack) => {
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    // Every socket also sits in a room named after its own id; joining one of those would put a stranger "in the same room"
    if (io.sockets.sockets.has(room)) return ack({ full: true });
    // Display name shown to the other member: plain text, at most 40 characters
    socket.data.name = (typeof name === "string" && name.trim().slice(0, 40).trim()) || "Guest";
    const members = io.sockets.adapter.rooms.get(room);
    if (members?.size >= MAX_ROOM_SIZE && !members.has(socket.id)) return ack({ full: true });
    socket.join(room);

    const iceServers = await getIceServers();
    if (!socket.rooms.has(room)) return; // left or disconnected while waiting
    const peerId = [...io.sockets.adapter.rooms.get(room)].find(id => id !== socket.id) ?? null;
    const peerName = io.sockets.sockets.get(peerId)?.data.name ?? null;
    ack({ peerId, peerName, iceServers });
    socket.to(room).emit("user:joined", { id: socket.id, name: socket.data.name });
  });

  // Call signaling only ever goes to the other person in the same room: never to a room name, never to a stranger.
  // Without this, anyone with a room link could send an offer to the room and receive the camera of whoever waits there.
  const inSameRoom = to =>
    typeof to === "string" && to !== socket.id && io.sockets.sockets.has(to) &&
    [...socket.rooms].some(room => !io.sockets.sockets.has(room) && io.sockets.adapter.rooms.get(room)?.has(to));

  socket.on("user:call", ({ to, offer }) => {
    if (inSameRoom(to)) io.to(to).emit("incomming:call", { from: socket.id, offer });
  });
  socket.on("call:accepted", ({ to, ans }) => {
    if (inSameRoom(to)) io.to(to).emit("call:accepted", { from: socket.id, ans });
  });
  socket.on("ice:candidate", ({ to, candidate }) => {
    if (inSameRoom(to)) io.to(to).emit("ice:candidate", { from: socket.id, candidate });
  });
  // Camera / mic on or off (or missing) and screen shared or not, so the other side can show a placeholder, a muted icon and the screen
  socket.on("media:state", ({ to, video, audio, screen, hasCamera, hasMic }) => {
    if (inSameRoom(to)) io.to(to).emit("media:state", { from: socket.id, video: video !== false, audio: audio !== false, screen: screen === true, hasCamera: hasCamera !== false, hasMic: hasMic !== false });
  });

  // Email the room link to a guest; see invite.js for the rules
  socket.on("invite:send", async (payload, ack) => {
    const result = await sendInvite(socket, payload, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID);
    if (typeof ack === "function") ack(result);
  });

  // Names of the people in a room, for the join screen. Does not join it.
  socket.on("room:peek", ({ room }, ack) => {
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    // Every socket also sits in a room named after its own id; never report on those
    const ids = io.sockets.sockets.has(room) ? [] : [...(io.sockets.adapter.rooms.get(room) ?? [])];
    const others = ids.filter(id => id !== socket.id);
    ack({ names: others.map(id => io.sockets.sockets.get(id)?.data.name ?? "Guest"), full: others.length >= MAX_ROOM_SIZE });
  });

  socket.on("room:leave", ({ room }) => {
    if (room === socket.id || !socket.rooms.has(room)) return;
    socket.to(room).emit("user:left", { id: socket.id });
    socket.leave(room);
  });

  socket.on("disconnecting", () => {
    socket.rooms.forEach(room => {
      if (room !== socket.id) socket.to(room).emit("user:left", { id: socket.id });
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`⚡️ Socket server listening on port ${PORT}`);
});
