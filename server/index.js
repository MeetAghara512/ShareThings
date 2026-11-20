const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://sharethings-web.onrender.com",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"]
  }
});

const MAX_ROOM_SIZE = 2;
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

  socket.on("room:join", async ({ email, room }, ack) => {
    if (typeof room !== "string" || !room || typeof ack !== "function") return;
    const members = io.sockets.adapter.rooms.get(room);
    if (members?.size >= MAX_ROOM_SIZE && !members.has(socket.id)) return ack({ full: true });
    socket.join(room);

    const iceServers = await getIceServers();
    if (!socket.rooms.has(room)) return; // left or disconnected while waiting
    const peerId = [...io.sockets.adapter.rooms.get(room)].find(id => id !== socket.id) ?? null;
    ack({ peerId, iceServers });
    socket.to(room).emit("user:joined", { email, id: socket.id });
  });

  socket.on("user:call", ({ to, offer }) =>
    io.to(to).emit("incomming:call", { from: socket.id, offer })
  );
  socket.on("call:accepted", ({ to, ans }) =>
    io.to(to).emit("call:accepted", { from: socket.id, ans })
  );
  socket.on("ice:candidate", ({ to, candidate }) =>
    io.to(to).emit("ice:candidate", { from: socket.id, candidate })
  );

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
