import React, { useEffect, useRef, useState } from "react";
import { MdMic, MdMicOff, MdVideocam, MdVideocamOff, MdPresentToAll, MdCallEnd, MdInfoOutline, MdLightMode, MdDarkMode, MdContentCopy, MdCheck, MdClose, MdMailOutline, MdMoreVert, MdPersonRemove, MdPictureInPictureAlt } from "react-icons/md";
import { ChatButton } from "./ChatPanel";
import { ReactionButton } from "./Reactions";
import InviteForm from "./InviteForm";
import { HELP, troubleText } from "../Services/devices";
import { CAN_SHARE_SCREEN, SHORTCUTS, keyText, ariaKeys } from "../Services/shortcuts";
import { MODES } from "../Services/quality";
import { pickSpeaker, useSpeaker } from "./Speaker";

// Time of day, as in the corner of Google Meet
const Clock = () => {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 1000);
		return () => clearInterval(id);
	}, []);
	return <span className="tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
};

// A red mic or camera button's "!": the device is blocked or missing
export const TroubleMark = () => (
	<span aria-hidden="true" className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-400 text-black text-xs font-bold flex items-center justify-center">!</span>
);

// How to get a blocked or missing device working, shown after a click on its red button
export const DeviceHelp = ({ kind, trouble, darkMode, onClose, className = "" }) => (
	<div role="alert" className={`p-3 pr-9 rounded-xl shadow-2xl text-sm relative ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"} ${className}`}>
		<p className="font-semibold">{troubleText(kind, trouble)}</p>
		<p className="opacity-80">{HELP[trouble](kind)}</p>
		<button type="button" onClick={onClose} title="Close" aria-label="Close help" className={`absolute top-2 right-2 p-1 rounded-full text-lg ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}>
			<MdClose />
		</button>
	</div>
);

const QUALITY_NOTES = {
	auto: "Sized to the other screen and your connection",
	high: "The best picture your connection allows",
	saver: "For mobile data: at most 360p",
};

// "More options": the video quality setting, the speaker, popping out the video, the theme and, for the host,
// removing the other person
const MoreMenu = ({ darkMode, quality, onQuality, onPopOut, onToggleDarkMode, removeName, onRemove, className }) => {
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	const { speakers, id: speakerId } = useSpeaker();

	// A click elsewhere or Escape closes it
	useEffect(() => {
		if (!open) return;
		const close = e => (e.type === "keydown" ? e.key === "Escape" : !ref.current?.contains(e.target)) && setOpen(false);
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);

	const choose = action => () => {
		action();
		setOpen(false);
	};
	const item = `w-full flex gap-3 px-4 py-2 text-left ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`;
	return (
		<div ref={ref} className="relative">
			<button type="button" onClick={() => setOpen(!open)} title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={open} className={className}>
				<MdMoreVert />
			</button>
			{open && (
				<div role="menu" aria-label="More options" className={`absolute z-50 bottom-full right-0 mb-2 w-72 max-h-[calc(100dvh-6rem)] overflow-y-auto py-2 rounded-xl shadow-2xl text-sm ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"}`}>
					<p className="px-4 pb-1 text-xs font-semibold uppercase opacity-60">Video quality</p>
					{Object.entries(MODES).map(([value, label]) => (
						<button key={value} type="button" role="menuitemradio" aria-checked={quality === value} onClick={choose(() => onQuality(value))} className={item}>
							<span className={`mt-1 w-3 h-3 shrink-0 rounded-full border-2 ${quality === value ? "bg-indigo-500 border-indigo-500" : "border-gray-400"}`} />
							<span>
								<span className="block font-medium">{label}</span>
								<span className="block text-xs opacity-60">{QUALITY_NOTES[value]}</span>
							</span>
						</button>
					))}
					{speakers.length > 0 && (
						<>
							<div className={`my-2 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`} />
							<p className="px-4 pb-1 text-xs font-semibold uppercase opacity-60">Speaker</p>
							{speakers.map(s => (
								<button key={s.id} type="button" role="menuitemradio" aria-checked={speakerId === s.id} onClick={choose(() => pickSpeaker(s.id))} className={`${item} items-center`}>
									<span className={`w-3 h-3 shrink-0 rounded-full border-2 ${speakerId === s.id ? "bg-indigo-500 border-indigo-500" : "border-gray-400"}`} />
									<span className="truncate">{s.label}</span>
								</button>
							))}
						</>
					)}
					<div className={`my-2 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`} />
					{onPopOut && (
						<button type="button" role="menuitem" onClick={choose(onPopOut)} className={`${item} items-center`}>
							<MdPictureInPictureAlt className="text-lg" /> Pop out video
						</button>
					)}
					<button type="button" role="menuitem" onClick={choose(onToggleDarkMode)} className={`${item} items-center`}>
						{darkMode ? <MdLightMode className="text-lg" /> : <MdDarkMode className="text-lg" />}
						{darkMode ? "Switch to light mode" : "Switch to dark mode"}
					</button>
					{removeName && (
						<button type="button" role="menuitem" onClick={choose(onRemove)} className={`${item} items-center text-red-500`}>
							<MdPersonRemove className="text-lg shrink-0" />
							<span className="truncate">Remove {removeName}</span>
						</button>
					)}
				</div>
			)}
		</div>
	);
};

// The call's one row of controls, like Google Meet: time, room and call status on the left, round
// icon buttons in the middle, meeting details and more options (video quality, theme) on the right.
// trouble: a mic or camera that is blocked or missing; its button is red with a "!" and its click tries to fix it
const ControlBar = ({ darkMode, roomId, status, muted, cameraOff, trouble = {}, isScreen, infoOpen, quality, onQuality, onPopOut, onToggleMic, onToggleCamera, onToggleShare, onToggleInfo, onToggleDarkMode, removeName, onRemove, onLeave, showInfo = true }) => {
	const round = "w-10 h-10 sm:w-12 sm:h-12 shrink-0 rounded-full flex items-center justify-center text-xl transition-colors";
	const idle = darkMode ? "bg-gray-700 hover:bg-gray-600 text-white" : "bg-gray-200 hover:bg-gray-300 text-gray-800";
	const off = "bg-red-600 hover:bg-red-700 text-white";
	const on = "bg-indigo-600 hover:bg-indigo-700 text-white";
	const plain = darkMode ? "hover:bg-gray-700" : "hover:bg-gray-200";
	// Icon only: the label is the tooltip and what screen readers say
	const button = (label, onClick, look, icon, mark, shortcut) => (
		<button type="button" onClick={onClick} title={shortcut ? `${label} (${keyText(shortcut)})` : label} aria-label={label} aria-keyshortcuts={shortcut && ariaKeys(shortcut)} className={`relative ${round} ${look}`}>
			{icon}
			{mark && <TroubleMark />}
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
				{trouble.audio
					? button(troubleText("audio", trouble.audio), onToggleMic, off, <MdMicOff />, true, "mic")
					: button(muted ? "Turn on microphone" : "Turn off microphone", onToggleMic, muted ? off : idle, muted ? <MdMicOff /> : <MdMic />, false, "mic")}
				{trouble.video
					? button(troubleText("video", trouble.video), onToggleCamera, off, <MdVideocamOff />, true, "camera")
					: button(cameraOff ? "Turn on camera" : "Turn off camera", onToggleCamera, cameraOff ? off : idle, cameraOff ? <MdVideocamOff /> : <MdVideocam />, false, "camera")}
				{CAN_SHARE_SCREEN && button(isScreen ? "Stop sharing" : "Share screen", onToggleShare, isScreen ? on : idle, <MdPresentToAll />, false, "share")}
				<ChatButton className={round} look={idle} />
				<ReactionButton className={round} look={idle} on={on} darkMode={darkMode} boxClass="hidden sm:block" />
				<button type="button" onClick={onLeave} title="Leave call" aria-label="Leave call" className={`${round} w-14 sm:w-16 ${off}`}>
					<MdCallEnd />
				</button>
			</div>

			<div className="flex items-center justify-end gap-1 sm:gap-2">
				{showInfo && button("Meeting details", onToggleInfo, infoOpen ? on : plain, <MdInfoOutline />)}
				<MoreMenu darkMode={darkMode} quality={quality} onQuality={onQuality} onPopOut={onPopOut} onToggleDarkMode={onToggleDarkMode} removeName={removeName} onRemove={onRemove} className={`${round} ${plain}`} />
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
			{/* Only where there is a keyboard and a mouse, not on phones */}
			<div className="hidden [@media(pointer:fine)]:block space-y-1.5 pt-1">
				<h4 className="font-medium">Keyboard shortcuts</h4>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					{SHORTCUTS.filter(s => s.action !== "share" || CAN_SHARE_SCREEN).map(s => (
						<React.Fragment key={s.action}>
							<dt><kbd className="font-mono text-xs">{keyText(s.action)}</kbd></dt>
							<dd className="opacity-80">{s.label}</dd>
						</React.Fragment>
					))}
					<dt><kbd className="font-mono text-xs">Esc</kbd></dt>
					<dd className="opacity-80">Close the chat while typing in it</dd>
				</dl>
			</div>
		</section>
	);
};

export default ControlBar;
