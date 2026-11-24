import React, { useEffect, useRef, useState } from "react";
import { MdMic, MdMicOff, MdVideocam, MdVideocamOff, MdPresentToAll, MdCallEnd, MdInfoOutline, MdLightMode, MdDarkMode, MdContentCopy, MdCheck, MdClose, MdMailOutline, MdMoreVert, MdPersonRemove, MdPictureInPictureAlt } from "react-icons/md";
import { ChatButton, useChatOpen } from "./ChatPanel";
import { ReactionButton } from "./Reactions";
import InviteForm from "./InviteForm";
import { HELP, troubleText } from "../Services/devices";
import { CAN_SHARE_SCREEN, keyText, ariaKeys } from "../Services/shortcuts";
import { MODES } from "../Services/quality";
import { pickSpeaker, useSpeaker } from "./Speaker";

// A red mic or camera button's "!": the device is blocked or missing
export const TroubleMark = () => (
	<span aria-hidden="true" className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-400 text-black text-xs font-bold flex items-center justify-center">!</span>
);

// How to get a blocked or missing device working, shown after a click on its red button
export const DeviceHelp = ({ kind, trouble, onClose, className = "" }) => (
	<div role="alert" className={`p-3 pr-9 rounded-2xl shadow-2xl text-sm relative bg-surface text-ink ${className}`}>
		<p className="font-semibold">{troubleText(kind, trouble)}</p>
		<p className="text-muted">{HELP[trouble](kind)}</p>
		<button type="button" onClick={onClose} title="Close" aria-label="Close help" className="absolute top-2 right-2 p-1 rounded-full text-lg hover:bg-raised">
			<MdClose />
		</button>
	</div>
);

// "More options": video quality, speaker, popping out the video, the theme and, for the host, removing the
// other person. On phones also the meeting details, which have no room in the bar
const MoreMenu = ({ darkMode, quality, onQuality, onPopOut, onInfo, onToggleDarkMode, removeName, onRemove, className }) => {
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
	const item = "w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-raised";
	const radio = on => `w-3 h-3 shrink-0 rounded-full border-2 ${on ? "bg-accent border-accent" : "border-muted"}`;
	return (
		<div ref={ref} className="sm:relative">
			<button type="button" onClick={() => setOpen(!open)} title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={open} className={className}>
				<MdMoreVert />
			</button>
			{open && (
				<div role="menu" aria-label="More options" className="absolute max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[4.25rem] z-50 sm:bottom-full sm:right-0 sm:mb-3 sm:w-72 max-h-[calc(100dvh-6rem)] lg:max-h-[calc(100dvh-8rem)] overflow-y-auto py-2 rounded-2xl border border-line shadow-2xl text-sm bg-surface text-ink">
					<p className="px-4 pb-1 text-xs font-semibold uppercase text-muted">Video quality</p>
					{Object.entries(MODES).map(([value, label]) => (
						<button key={value} type="button" role="menuitemradio" aria-checked={quality === value} onClick={choose(() => onQuality(value))} className={item}>
							<span className={radio(quality === value)} />
							<span>{label}</span>
						</button>
					))}
					{speakers.length > 0 && (
						<>
							<div className="my-2 border-t border-line" />
							<p className="px-4 pb-1 text-xs font-semibold uppercase text-muted">Speaker</p>
							{speakers.map(s => (
								<button key={s.id} type="button" role="menuitemradio" aria-checked={speakerId === s.id} onClick={choose(() => pickSpeaker(s.id))} className={item}>
									<span className={radio(speakerId === s.id)} />
									<span className="truncate">{s.label}</span>
								</button>
							))}
						</>
					)}
					<div className="my-2 border-t border-line" />
					{onInfo && (
						<button type="button" role="menuitem" onClick={choose(onInfo)} className={`${item} sm:hidden`}>
							<MdInfoOutline className="text-lg" /> Meeting details
						</button>
					)}
					{onPopOut && (
						<button type="button" role="menuitem" onClick={choose(onPopOut)} className={item}>
							<MdPictureInPictureAlt className="text-lg" /> Pop out video
						</button>
					)}
					<button type="button" role="menuitem" onClick={choose(onToggleDarkMode)} className={item}>
						{darkMode ? <MdLightMode className="text-lg" /> : <MdDarkMode className="text-lg" />}
						{darkMode ? "Switch to light mode" : "Switch to dark mode"}
					</button>
					{removeName && (
						<button type="button" role="menuitem" onClick={choose(onRemove)} className={`${item} text-red-500`}>
							<MdPersonRemove className="text-lg shrink-0" />
							<span className="truncate">Remove {removeName}</span>
						</button>
					)}
				</div>
			)}
		</div>
	);
};

// The call's one bar of controls. From 1024px it floats over the video, centered on it; below that it is a row
// under the video. trouble: a mic or camera that is blocked or missing; its button is red with a "!" and its click tries to fix it.
// waiting: not let in yet, so only what works on your own side is shown: mic, camera, More and Leave
const ControlBar = ({ darkMode, muted, cameraOff, trouble = {}, isScreen, infoOpen, quality, onQuality, onPopOut, onToggleMic, onToggleCamera, onToggleShare, onToggleInfo, onToggleDarkMode, removeName, onRemove, onLeave, waiting = false }) => {
	const chatOpen = useChatOpen();
	const round = "w-10 h-10 sm:w-[3.25rem] sm:h-[3.25rem] shrink-0 rounded-2xl flex items-center justify-center text-xl transition-colors";
	const idle = "bg-raised hover:bg-line text-ink";
	const off = "bg-danger hover:bg-danger-hover text-white";
	const on = "bg-accent hover:bg-accent-hover text-on-accent";
	// Icon only: the label is the tooltip and what screen readers say
	const button = (label, onClick, look, icon, mark, shortcut) => (
		<button type="button" onClick={onClick} title={shortcut ? `${label} (${keyText(shortcut)})` : label} aria-label={label} aria-keyshortcuts={shortcut && ariaKeys(shortcut)} className={`relative ${round} ${look}`}>
			{icon}
			{mark && <TroubleMark />}
		</button>
	);

	return (
		<footer className={`shrink-0 lg:z-30 flex justify-center p-2 sm:px-4 lg:fixed lg:inset-x-0 lg:bottom-5 lg:p-0 lg:pointer-events-none ${chatOpen ? "lg:pr-[26rem]" : ""}`}>
			<div className="lg:pointer-events-auto max-w-full flex items-center gap-1 sm:gap-2 p-1.5 sm:p-2.5 rounded-3xl border border-line bg-surface/95 shadow-2xl">
				{trouble.audio
					? button(troubleText("audio", trouble.audio), onToggleMic, off, <MdMicOff />, true, "mic")
					: button(muted ? "Turn on microphone" : "Turn off microphone", onToggleMic, muted ? off : idle, muted ? <MdMicOff /> : <MdMic />, false, "mic")}
				{trouble.video
					? button(troubleText("video", trouble.video), onToggleCamera, off, <MdVideocamOff />, true, "camera")
					: button(cameraOff ? "Turn on camera" : "Turn off camera", onToggleCamera, cameraOff ? off : idle, cameraOff ? <MdVideocamOff /> : <MdVideocam />, false, "camera")}
				{CAN_SHARE_SCREEN && !waiting && button(isScreen ? "Stop sharing" : "Share screen", onToggleShare, isScreen ? on : idle, <MdPresentToAll />, false, "share")}
				{!waiting && <ChatButton className={round} look={idle} />}
				{!waiting && <ReactionButton className={round} look={idle} on={on} />}
				{!waiting && button("Meeting details", onToggleInfo, `${infoOpen ? on : idle} max-sm:hidden`, <MdInfoOutline />)}
				<MoreMenu darkMode={darkMode} quality={quality} onQuality={onQuality} onPopOut={onPopOut} onInfo={waiting ? null : onToggleInfo} onToggleDarkMode={onToggleDarkMode} removeName={removeName} onRemove={onRemove} className={`${round} ${idle}`} />
				<span aria-hidden="true" className="hidden sm:block w-px h-8 mx-0.5 bg-line" />
				<button type="button" onClick={onLeave} title="Leave call" aria-label="Leave call" className={`${round} !w-[3.25rem] sm:!w-[4.5rem] ${off}`}>
					<MdCallEnd />
				</button>
			</div>
		</footer>
	);
};

// "Your meeting is ready", bottom-left on the stage: the link to share and the email invite
export const MeetingCard = ({ roomId, alone, copied, onCopy, onClose }) => {
	const [inviting, setInviting] = useState(false);
	const link = `${window.location.host}${window.location.pathname}`;

	return (
		<section
			aria-label="Meeting details"
			className="absolute z-20 inset-x-2 bottom-2 sm:inset-x-auto sm:left-4 sm:bottom-4 lg:bottom-28 sm:w-80 max-h-[calc(100%-1rem)] lg:max-h-[calc(100%-8rem)] overflow-y-auto p-4 rounded-2xl border border-line shadow-2xl space-y-3 text-sm bg-surface text-ink"
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="font-display text-lg font-semibold">{alone ? "Your meeting is ready" : "Meeting details"}</h3>
				<button type="button" onClick={onClose} title="Close" aria-label="Close" className="-m-1 p-1 rounded-full text-lg hover:bg-raised">
					<MdClose />
				</button>
			</div>
			{alone && <p className="font-medium">You're the only one here</p>}
			<p className="text-muted">Share this link with the people you want in the call.</p>
			<div className="flex items-center gap-2 pl-3 rounded-xl bg-raised">
				<span className="flex-1 min-w-0 truncate" title={link}>{link}</span>
				<button type="button" onClick={onCopy} title={copied ? "Link copied" : "Copy link"} aria-label={copied ? "Link copied" : "Copy link"} className="p-2.5 rounded-xl text-lg hover:bg-line">
					{copied ? <MdCheck className="text-accent-ink" /> : <MdContentCopy />}
				</button>
			</div>
			{inviting ? (
				<InviteForm roomId={roomId} />
			) : (
				<button type="button" onClick={() => setInviting(true)} className="flex items-center gap-2 font-medium text-accent-ink hover:underline">
					<MdMailOutline className="text-lg" /> Invite by email
				</button>
			)}
		</section>
	);
};

export default ControlBar;
