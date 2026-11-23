import React, { useState } from "react";
import { FaEnvelope } from "react-icons/fa";
import { useSocket } from "../useContext/SocketProvider";
import { SIGN_IN_PAGE, useAuth } from "../useContext/AuthProvider";
import TimePicker from "./TimePicker";

// Shown while waiting in a room: a signed-in user can have the room link emailed to a guest
const InviteForm = ({ roomId }) => {
	const socket = useSocket();
	const { user } = useAuth();

	const [to, setTo] = useState("");
	const [when, setWhen] = useState(null);
	const [sending, setSending] = useState(false);
	const [status, setStatus] = useState(null); // { ok, text }

	if (!user) {
		return (
			<div className="flex flex-col items-center gap-2 text-sm">
				{/* In another tab, because leaving this page would end the call. The sign-in reaches this tab by itself */}
				<a href={SIGN_IN_PAGE} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-full border border-line font-medium hover:bg-raised">
					Sign in (opens a new tab)
				</a>
				<p className="opacity-60 text-center">Sign in there to invite someone by email. This call stays open.</p>
			</div>
		);
	}

	const handleSubmit = e => {
		e.preventDefault();
		setSending(true);
		setStatus(null);
		const payload = { to, room: roomId, when: when ? when.toISOString() : undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
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

	const inputClass = "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-accent text-sm font-normal bg-ground border-line placeholder-muted";

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
			<div className="flex flex-col gap-1 font-medium">
				<span>Meeting time <span className="opacity-60 font-normal">(optional)</span></span>
				<TimePicker value={when} onChange={setWhen} />
			</div>
			<button
				type="submit"
				disabled={sending}
				className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent px-5 py-2 rounded-full flex items-center justify-center gap-2 shadow-sm transition-colors"
			>
				<FaEnvelope /> {sending ? "Sending..." : "Send invite"}
			</button>
			{status && (
				<p role="status" className={`text-center ${status.ok ? "text-green-500" : "text-red-500"}`}>
					{status.text}
					{/* New senders often land in Spam at first */}
					{status.ok && <span className="block mt-0.5 text-xs opacity-80">If it doesn't arrive in a minute, ask them to check Spam.</span>}
				</p>
			)}
		</form>
	);
};

export default InviteForm;
