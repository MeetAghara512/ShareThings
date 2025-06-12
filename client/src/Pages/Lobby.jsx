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
		<div
			className={`min-h-screen w-full flex flex-col transition-colors duration-500 ` +
				(darkMode
					? "bg-gradient-to-br from-zinc-900 to-black text-white"
					: "bg-gradient-to-br from-gray-100 to-gray-200 text-gray-900")
			}
		>
			<header className="flex justify-between items-center p-5 shadow border-b">
						<h2 className="text-2xl font-extrabold bg-gradient-to-r from-indigo-400 via-purple-500 to-pink-500 bg-clip-text text-transparent transition duration-300 hover:from-pink-500 hover:to-indigo-400">
							ShareThings
						</h2>
						<button
							onClick={toggleDarkMode}
							className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition duration-300"
						>
							{darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
						</button>
					</header>


			<main className="flex-grow flex flex-col items-center justify-center px-6 py-12 sm:py-20">
				<h2
					className={`text-5xl font-extrabold mb-10 text-center transition-colors duration-500 ` +
						(darkMode ? "text-indigo-300" : "text-indigo-600")
					}
				>
					Join a Video Call Room
				</h2>

				<form
					onSubmit={handleSubmit}
					className={`w-full max-w-lg px-8 py-10 rounded-2xl shadow-2xl space-y-8 transition-transform duration-300 hover:scale-105 ` +
						(darkMode
							? "bg-gray-800 text-gray-100"
							: "bg-white text-gray-900")
					}
				>
					<div className="space-y-2">
						<label htmlFor="email" className="block text-sm font-medium">
							Your Email
						</label>
						<input
							type="email"
							id="email"
							required
							placeholder="you@example.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className={`w-full px-4 py-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all duration-300 text-sm ` +
								(darkMode
									? "bg-gray-700 border-gray-600 placeholder-gray-400 focus:border-indigo-500"
									: "border-gray-300 placeholder-gray-500 focus:border-indigo-600 hover:border-indigo-400")
							}
						/>
					</div>

					<div className="space-y-2">
						<label htmlFor="room" className="block text-sm font-medium">
							Room Number
						</label>
						<input
							type="text"
							id="room"
							required
							placeholder="Enter room ID"
							value={room}
							onChange={(e) => setRoom(e.target.value)}
							className={`w-full px-4 py-3 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all duration-300 text-sm ` +
								(darkMode
									? "bg-gray-700 border-gray-600 placeholder-gray-400 focus:border-indigo-500"
									: "border-gray-300 placeholder-gray-500 focus:border-indigo-600 hover:border-indigo-400")
							}
						/>
					</div>

					<button
						type="submit"
						className="w-full py-3 rounded-lg bg-indigo-600 text-white font-semibold text-lg transition-transform duration-300 hover:bg-indigo-700 hover:-translate-y-1 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
					>
						Join Room
					</button>
				</form>
			</main>
		</div>
	);
};

export default Lobby;
