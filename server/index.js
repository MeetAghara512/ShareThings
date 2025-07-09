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

const emailToSocketIdMap = new Map();
const socketidToEmailMap = new Map();

io.on("connection", socket => {

  socket.on("room:join", ({ email, room }) => {
    emailToSocketIdMap.set(email, socket.id);
    socketidToEmailMap.set(socket.id, email);
    socket.join(room);
    io.to(room).emit("user:joined", { email, id: socket.id });
    io.to(socket.id).emit("room:join", { email, room });
  });

  // room check
  socket.on("room:check", ({ roomId, selfId }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size > 1) {
      const other = [...room].find(id => id !== selfId);
      io.to(socket.id).emit("room:user", {
        exists: true,
        socketId: other,
        email: socketidToEmailMap.get(other)
      });
    } else {
      io.to(socket.id).emit("room:user", { exists: false });
    }
  });

  socket.on("user:call", ({ to, offer }) =>
    io.to(to).emit("incomming:call", { from: socket.id, offer })
  );
  socket.on("call:accepted", ({ to, ans }) =>
    io.to(to).emit("call:accepted", { from: socket.id, ans })
  );
  socket.on("peer:nego:needed", ({ to, offer }) =>
    io.to(to).emit("peer:nego:needed", { from: socket.id, offer })
  );
  socket.on("peer:nego:done", ({ to, ans }) =>
    io.to(to).emit("peer:nego:final", { from: socket.id, ans })
  );

  
  socket.on("disconnect", () => {
    const email = socketidToEmailMap.get(socket.id);
    emailToSocketIdMap.delete(email);
    socketidToEmailMap.delete(socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`⚡️ Socket server listening on port ${PORT}`);
});
