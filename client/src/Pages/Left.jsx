import React from "react";
import { Link, useLocation, useParams } from "react-router-dom";

// After leaving a call (or when it moved to another tab): Rejoin opens this room's join screen again,
// where nobody sees or hears you until you join. It never sends you anywhere by itself
const Left = ({ darkMode }) => {
	const { roomId } = useParams();
	const elsewhere = useLocation().state?.reason === "other-tab";

	return (
		<main className="min-h-[100vh] flex items-center justify-center px-6 py-12">
			<section className={`w-full max-w-sm px-8 py-10 rounded-2xl shadow-2xl text-center space-y-6 ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"}`}>
				<div className="space-y-2">
					<h1 className="text-2xl font-semibold">{elsewhere ? "This call was opened in another tab" : "You left the call"}</h1>
					<p className="text-sm opacity-70">
						{elsewhere ? "It goes on there, so it ended here." : "Room "}
						{!elsewhere && <span className="font-mono">{roomId}</span>}
					</p>
				</div>
				<div className="flex flex-col sm:flex-row gap-3 justify-center">
					<Link to={`/room/${encodeURIComponent(roomId)}`} className="px-6 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold">
						Rejoin
					</Link>
					<Link to="/" className={`px-6 py-2.5 rounded-full font-semibold border ${darkMode ? "border-gray-600 hover:bg-gray-700" : "border-gray-300 hover:bg-gray-100"}`}>
						Return to home
					</Link>
				</div>
			</section>
		</main>
	);
};

export default Left;
