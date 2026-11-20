import React, { useState } from "react";
import { FaEnvelope } from "react-icons/fa";
import { useSocket } from "../useContext/SocketProvider";
import { useAuth, GoogleSignInButton } from "../useContext/AuthProvider";

// Shown while waiting in a room: a signed-in user can have the room link emailed to a guest
const InviteForm = ({ roomId, darkMode }) => {
	const socket = useSocket();
	const { user } = useAuth();

	const [to, setTo] = useState("");
	const [when, setWhen] = useState("");
	const [sending, setSending] = useState(false);
	const [status, setStatus] = useState(null); // { ok, text }

	if (!user) {
		return (
			<div className="flex flex-col items-center gap-2 text-sm">
				<GoogleSignInButton />
				<p className="opacity-60">Sign in to invite someone by email</p>
			</div>
		);
	}

	const handleSubmit = e => {
		e.preventDefault();
		const time = when ? new Date(when) : null;
		if (time && isNaN(time)) return setStatus({ ok: false, text: "Pick a valid meeting time." });
		setSending(true);
		setStatus(null);
		const payload = { to, room: roomId, when: time ? time.toISOString() : undefined };
		// The timeout re-enables the button if the server never answers (e.g. the connection dropped)
		socket.timeout(15000).emit("invite:send", payload, (err, res) => {
			setSending(false);
			if (err || !res?.ok) {
				return setStatus({ ok: false, text: res?.error || "The server did not respond. Please try again." });
			}
			setStatus({ ok: true, text: `Invite sent to ${to}` });
			setTo("");
		});
	};

	const inputClass = "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-400 text-sm font-normal " +
		(darkMode ? "bg-gray-700 border-gray-600 placeholder-gray-400" : "bg-white border-gray-300 placeholder-gray-500");

	return (
		<form onSubmit={handleSubmit} className="w-full max-w-xs flex flex-col gap-3 text-left text-sm">
			<label className="flex flex-col gap-1 font-medium">
				Invite by email
				<input
					type="email"
					required
					maxLength={254}
					placeholder="guest@example.com"
					value={to}
					onChange={e => setTo(e.target.value)}
					className={inputClass}
				/>
			</label>
			<label className="flex flex-col gap-1 font-medium">
				<span>Meeting time <span className="opacity-60 font-normal">(optional)</span></span>
				<input
					type="datetime-local"
					value={when}
					onChange={e => setWhen(e.target.value)}
					className={inputClass}
					style={{ colorScheme: darkMode ? "dark" : "light" }}
				/>
			</label>
			<button
				type="submit"
				disabled={sending}
				className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white px-5 py-2 rounded-full flex items-center justify-center gap-2 shadow-sm transition-colors"
			>
				<FaEnvelope /> {sending ? "Sending..." : "Send invite"}
			</button>
			{status && (
				<p role="status" className={`text-center ${status.ok ? "text-green-500" : "text-red-500"}`}>
					{status.text}
				</p>
			)}
		</form>
	);
};

export default InviteForm;
