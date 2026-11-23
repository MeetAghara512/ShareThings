import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FaMoon, FaSun } from "react-icons/fa";
import { useAuth, GoogleSignInButton } from "../useContext/AuthProvider";
import ServerStatus from "./ServerStatus";
import LiveCount from "./LiveCount";
import { newRoomHash } from "../Services/roomSecret";

// A new room code like Google Meet's: 10 random letters as abc-defg-hij, 26^10 ≈ 141 trillion codes,
// so live rooms cannot be found by guessing. getRandomValues also works on plain-HTTP test pages.
const newRoomCode = () => {
	const letters = [...crypto.getRandomValues(new Uint32Array(10))].map(n => String.fromCharCode(97 + (n % 26))).join("");
	return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
};

const Lobby = ({ darkMode, toggleDarkMode }) => {
	const { user, signOut } = useAuth();
	const [room, setRoom] = useState("");
	const navigate = useNavigate();

	const handleSubmit = useCallback(
		(e) => {
			e.preventDefault();
			// No room entered: create a new one with a random ID
			const roomId = room.trim() || newRoomCode();
			// Only a room made here gets a private-link secret: a typed code may already be someone else's room
			navigate(`/room/${encodeURIComponent(roomId)}${room.trim() ? "" : newRoomHash()}`);
		},
		[room, navigate]
	);

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
					<div className="space-y-2 text-sm">
						{user ? (
							<div className="flex items-center justify-between gap-3">
								<span className="truncate">Signed in as <strong>{user.email}</strong></span>
								<button type="button" onClick={signOut} className="underline shrink-0 hover:text-indigo-400">
									Sign out
								</button>
							</div>
						) : (
							<>
								<GoogleSignInButton />
								<p className="opacity-60">Optional. You can join a call without signing in.</p>
							</>
						)}
					</div>

					<div className="space-y-2">
						<label htmlFor="room" className="block text-sm font-medium">
							Room code <span className="opacity-60">(leave empty to create a new room)</span>
						</label>
						<input
							type="text"
							id="room"
							placeholder="abc-defg-hij"
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
						{room.trim() ? "Join Room" : "Create Room"}
					</button>
					<LiveCount />
					<ServerStatus />
				</form>
			</main>

			<footer className="p-5 text-center text-sm opacity-70">
				<a href="/privacy.html" className="underline hover:text-indigo-400">Privacy Policy</a>
				{" · "}
				<a href="/terms.html" className="underline hover:text-indigo-400">Terms of Service</a>
			</footer>
		</div>
	);
};

export default Lobby;
