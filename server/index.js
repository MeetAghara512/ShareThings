const { Server } = require("socket.io");

const io = new Server(8000, {
	cors: true,
});

const emailToSocketIdMap = new Map();
const socketidToEmailMap = new Map();

io.on("connection", (socket) => {
	console.log(`Socket Connected`, socket.id);
	socket.on("room:join", (data) => {
		const { email, room } = data;
		emailToSocketIdMap.set(email, socket.id);
		socketidToEmailMap.set(socket.id, email);
		socket.join(room);
		io.to(room).emit("user:joined", { email, id: socket.id });
		io.to(socket.id).emit("room:join", data);
	});


	socket.on("room:check", ({ roomId, selfId }) => {
		const room = io.sockets.adapter.rooms.get(roomId);

		if (room && room.size > 1) {
			const otherSocketIds = [...room].filter(id => id !== selfId); // exclude self
			const existingSocketId = otherSocketIds[0]; // get one other user
			const existingEmail = socketidToEmailMap.get(existingSocketId);

			socket.emit("room:user", {
				exists: true,
				socketId: existingSocketId,
				email: existingEmail,
			});
		} else {
			socket.emit("room:user", { exists: false });
		}
	});


	socket.on("user:call", ({ to, offer }) => {
		io.to(to).emit("incomming:call", { from: socket.id, offer });
	});

	socket.on("call:accepted", ({ to, ans }) => {
		io.to(to).emit("call:accepted", { from: socket.id, ans });
	});

	socket.on("peer:nego:needed", ({ to, offer }) => {
		// console.log("peer:nego:needed", offer);
		io.to(to).emit("peer:nego:needed", { from: socket.id, offer });
	});

	socket.on("peer:nego:done", ({ to, ans }) => {
		// console.log("peer:nego:done", ans);
		io.to(to).emit("peer:nego:final", { from: socket.id, ans });
	});
	socket.on("disconnect", () => {
		const email = socketidToEmailMap.get(socket.id);
		emailToSocketIdMap.delete(email);
		socketidToEmailMap.delete(socket.id);
	});
});