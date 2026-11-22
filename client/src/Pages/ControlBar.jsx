import React, { useEffect, useState } from "react";
import { MdMic, MdMicOff, MdVideocam, MdVideocamOff, MdPresentToAll, MdCallEnd, MdInfoOutline, MdLightMode, MdDarkMode, MdContentCopy, MdCheck, MdClose, MdMailOutline } from "react-icons/md";
import { ChatButton } from "./ChatPanel";
import InviteForm from "./InviteForm";

// Time of day, as in the corner of Google Meet
const Clock = () => {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 1000);
		return () => clearInterval(id);
	}, []);
	return <span className="tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
};

// The call's one row of controls, like Google Meet: time, room and call status on the left, round
// icon buttons in the middle, meeting details and the theme on the right
const ControlBar = ({ darkMode, roomId, status, muted, cameraOff, isScreen, infoOpen, onToggleMic, onToggleCamera, onToggleShare, onToggleInfo, onToggleDarkMode, onLeave }) => {
	const round = "w-10 h-10 sm:w-12 sm:h-12 shrink-0 rounded-full flex items-center justify-center text-xl transition-colors";
	const idle = darkMode ? "bg-gray-700 hover:bg-gray-600 text-white" : "bg-gray-200 hover:bg-gray-300 text-gray-800";
	const off = "bg-red-600 hover:bg-red-700 text-white";
	const on = "bg-indigo-600 hover:bg-indigo-700 text-white";
	const plain = darkMode ? "hover:bg-gray-700" : "hover:bg-gray-200";
	// Icon only: the label is the tooltip and what screen readers say
	const button = (label, onClick, look, icon) => (
		<button type="button" onClick={onClick} title={label} aria-label={label} className={`${round} ${look}`}>
			{icon}
		</button>
	);

	return (
		<footer className="shrink-0 flex md:grid md:grid-cols-[1fr_auto_1fr] items-center justify-between gap-2 px-3 sm:px-6 py-3">
			<div className="hidden md:flex items-center gap-3 min-w-0 text-sm">
				<Clock />
				<span className="opacity-40" aria-hidden="true">|</span>
				<span className="truncate" title="Room code">{roomId}</span>
				{status}
			</div>

			<div className="flex items-center gap-2 sm:gap-3">
				{button(muted ? "Turn on microphone" : "Turn off microphone", onToggleMic, muted ? off : idle, muted ? <MdMicOff /> : <MdMic />)}
				{button(cameraOff ? "Turn on camera" : "Turn off camera", onToggleCamera, cameraOff ? off : idle, cameraOff ? <MdVideocamOff /> : <MdVideocam />)}
				{button(isScreen ? "Stop sharing" : "Share screen", onToggleShare, isScreen ? on : idle, <MdPresentToAll />)}
				<ChatButton className={round} look={idle} />
				<button type="button" onClick={onLeave} title="Leave call" aria-label="Leave call" className={`${round} w-14 sm:w-16 ${off}`}>
					<MdCallEnd />
				</button>
			</div>

			<div className="flex items-center justify-end gap-1 sm:gap-2">
				{button("Meeting details", onToggleInfo, infoOpen ? on : plain, <MdInfoOutline />)}
				{button(darkMode ? "Switch to light mode" : "Switch to dark mode", onToggleDarkMode, plain, darkMode ? <MdLightMode /> : <MdDarkMode />)}
			</div>
		</footer>
	);
};

// "Your meeting is ready", bottom-left on the stage: the link to share and the email invite
export const MeetingCard = ({ darkMode, roomId, alone, copied, onCopy, onClose }) => {
	const [inviting, setInviting] = useState(false);
	const link = `${window.location.host}${window.location.pathname}`;

	return (
		<section
			aria-label="Meeting details"
			className={`absolute z-20 inset-x-2 bottom-2 sm:inset-x-auto sm:left-4 sm:bottom-4 sm:w-80 max-h-[calc(100%-1rem)] overflow-y-auto p-4 rounded-xl shadow-2xl space-y-3 text-sm ` +
				(darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900")}
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="text-base font-semibold">{alone ? "Your meeting is ready" : "Meeting details"}</h3>
				<button type="button" onClick={onClose} title="Close" aria-label="Close" className={`-m-1 p-1 rounded-full text-lg ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}>
					<MdClose />
				</button>
			</div>
			{alone && <p className="font-medium">You're the only one here</p>}
			<p className="opacity-70">Share this link with the people you want in the call.</p>
			<div className={`flex items-center gap-2 pl-3 rounded-lg ${darkMode ? "bg-gray-700" : "bg-gray-100"}`}>
				<span className="flex-1 min-w-0 truncate" title={link}>{link}</span>
				<button type="button" onClick={onCopy} title={copied ? "Link copied" : "Copy link"} aria-label={copied ? "Link copied" : "Copy link"} className={`p-2.5 rounded-lg text-lg ${darkMode ? "hover:bg-gray-600" : "hover:bg-gray-200"}`}>
					{copied ? <MdCheck className="text-green-500" /> : <MdContentCopy />}
				</button>
			</div>
			{inviting ? (
				<InviteForm roomId={roomId} darkMode={darkMode} />
			) : (
				<button type="button" onClick={() => setInviting(true)} className="flex items-center gap-2 font-medium text-indigo-500 hover:text-indigo-400">
					<MdMailOutline className="text-lg" /> Invite by email
				</button>
			)}
		</section>
	);
};

export default ControlBar;
