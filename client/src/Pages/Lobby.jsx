import React, { useState, useCallback, useEffect } from "react";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate } from "react-router-dom";
import { FaMoon, FaSun } from "react-icons/fa";

const Lobby = ({ darkMode, toggleDarkMode }) => {
	const [email, setEmail] = useState("");
	const [room, setRoom] = useState("");
	const socket = useSocket();
	const navigate = useNavigate();

	const handleSubmit = useCallback(
		(e) => {
			e.preventDefault();
			socket.emit("room:join", { email, room });
		},
		[email, room, socket]
	);

	const handleJoinRoom = useCallback(
		(data) => {
			const { room } = data;
			navigate(`/room/${room}`);
		},
		[navigate]
	);

	useEffect(() => {
		socket.on("room:join", handleJoinRoom);
		return () => {
			socket.off("room:join", handleJoinRoom);
		};
	}, [socket, handleJoinRoom]);

	return (
		<div className={`min-h-screen w-full flex flex-col transition-colors duration-500 ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
		
			<div className="flex justify-between items-center p-4 shadow-md">
				<h2 className="text-xl font-bold">MeetVerse</h2>
				<button onClick={toggleDarkMode} className="rounded-full p-2 transition-all hover:scale-110">
					{darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
				</button>
			</div>

			<div className="flex flex-col items-center justify-center px-4 py-12 sm:py-20">
				<h2 className={`text-4xl font-extrabold mb-8 text-center ${darkMode ? "text-indigo-300" : "text-indigo-600"}`}>
					Join a Video Call Room
				</h2>

				<form
					onSubmit={handleSubmit}
					className={`w-full max-w-md px-6 py-8 rounded-xl shadow-2xl space-y-6 ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"
						}`}
				>
					<div>
						<label htmlFor="email" className="block text-sm font-medium mb-2">
							Your Email
						</label>
						<input
							type="email"
							id="email"
							required
							placeholder="you@example.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className={`w-full px-4 py-2 rounded-md border focus:outline-none focus:ring-2 text-sm ${darkMode
									? "bg-gray-700 border-gray-600 focus:ring-indigo-400 text-gray-100"
									: "border-gray-300 focus:ring-indigo-500"
								}`}
						/>
					</div>

					<div>
						<label htmlFor="room" className="block text-sm font-medium mb-2">
							Room Number
						</label>
						<input
							type="text"
							id="room"
							required
							placeholder="Enter room ID"
							value={room}
							onChange={(e) => setRoom(e.target.value)}
							className={`w-full px-4 py-2 rounded-md border focus:outline-none focus:ring-2 text-sm ${darkMode
									? "bg-gray-700 border-gray-600 focus:ring-indigo-400 text-gray-100"
									: "border-gray-300 focus:ring-indigo-500"
								}`}
						/>
					</div>

					<button
						type="submit"
						className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-md transition-all"
					>
						Join Room
					</button>
				</form>
			</div>
		</div>
	);
};

export default Lobby; //main