import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FaDownload, FaFileAlt, FaPaperPlane, FaPaperclip, FaTimes } from "react-icons/fa";
import { MdChatBubbleOutline, MdContentPaste } from "react-icons/md";
import * as chat from "../Services/chat";
import * as files from "../Services/files";
import { useSocket } from "../useContext/SocketProvider";
import { keyText, ariaKeys } from "../Services/shortcuts";
import { ClipBubble, ClipTray } from "./SharedClip";
import * as clipboard from "../Services/clipboard";
import { setUnreadTitle } from "../Services/title";

const useChat = () => useSyncExternalStore(chat.subscribe, chat.getState);
// On wide screens the room makes space for the open panel, so it never covers the call controls
export const useChatOpen = () => useChat().open;

const formatSize = bytes =>
	bytes < 1024 ? `${Math.round(bytes)} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatTime = at => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

// The round Chat button in the call's control bar, with the number of unread messages and files.
// className sets its shape and look its colours while closed; open, it is highlighted
export const ChatButton = ({ className, look }) => {
	const { open, unread } = useChat();

	// Also in the tab title, for when the call is in a background tab
	useEffect(() => {
		setUnreadTitle(unread);
		return () => setUnreadTitle(0);
	}, [unread]);

	return (
		<button
			onClick={() => chat.setOpen(!open)}
			aria-pressed={open}
			aria-label={unread ? `Chat, ${unread} unread` : "Chat"}
			title={`Chat (${keyText("chat")})`}
			aria-keyshortcuts={ariaKeys("chat")}
			className={`relative ${className} ${open ? "bg-accent hover:bg-accent-hover text-on-accent" : look}`}
		>
			<MdChatBubbleOutline />
			{unread > 0 && (
				<span className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-xs font-semibold flex items-center justify-center">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</button>
	);
};

const formatDuration = seconds =>
	seconds < 60 ? "under a minute" : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;

const LABELS = { queued: "Waiting to send", preparing: "Preparing...", sent: "Sent", done: "Received", saving: "Saving to the chosen place...", unsaved: "Finished. Press Save to put it where you chose", saved: "Saved", declined: "Declined", cancelled: "Cancelled" };

const FileItem = ({ item, remoteName, ready }) => {
	const percent = Math.min(100, Math.floor((item.done / item.size) * 100)) || 0;
	const moving = item.status === "sending" || item.status === "receiving";
	const left = item.speed > 0 && (item.size - item.done) / item.speed;
	const label = moving
		? [`${percent}%`, left !== false && `${formatSize(item.speed)}/s`, left !== false && `${formatDuration(left)} left`].filter(Boolean).join(" \u00b7 ")
		: item.status === "paused" ? (item.pausedByThem ? `Paused by ${remoteName || "the other person"} at ${percent}%` : `Paused at ${percent}%`)
		: item.status === "offered" ? (item.mine ? `Waiting for ${remoteName || "the other person"} to accept` : item.eta ? `${item.rough ? "Up to" : "About"} ${formatDuration(item.eta)} to receive` : "Wants to send you this file")
		// The other person left or is reloading; it continues by itself when both are in the call
		: item.status === "waiting" ? (item.mine ? `Paused \u2014 waiting for ${item.to || "the other person"}` : `Paused at ${percent}% \u00b7 ${ready ? "continuing\u2026" : `waiting for ${item.name || "the other person"}`}`)
		: item.note || LABELS[item.status];
	// Free space a large file needs, shown when it is tight
	const needs = item.needs && (item.status === "offered" || item.status === "failed") ? ` \u00b7 needs ${formatSize(item.needs)} free${item.moment ? " for a moment" : ""}` : "";
	const actions = item.status === "offered" && !item.mine ? [["Accept", files.accept, true], ["Decline", files.decline]]
		: item.status === "relay" ? [["Send anyway", files.sendAnyway, true], ["Cancel", files.cancel]]
		: moving ? [["Pause", files.pause], ["Cancel", files.cancel]]
		: item.status === "paused" ? (item.pausedByThem ? [["Cancel", files.cancel]] : [["Resume", files.resume, true], ["Cancel", files.cancel]])
		: item.status === "unsaved" ? [["Save", files.saveFile, true]]
		: ["queued", "preparing", "offered", "waiting"].includes(item.status) ? [["Cancel", files.cancel]]
		: [];

	return (
		<div className="w-56 max-w-full space-y-1.5">
			<div className="flex items-center gap-2 min-w-0">
				<FaFileAlt className="shrink-0 opacity-80" />
				<span className="truncate font-medium" title={item.fileName}>{item.fileName}</span>
			</div>
			<p className="text-xs">
				<span className="opacity-80">{formatSize(item.size)}</span>
				{label && <span className={item.status === "failed" ? "text-red-400 font-medium" : "opacity-80"}>{" \u00b7 "}{label}{needs}</span>}
			</p>
			{(moving || item.status === "paused" || item.status === "waiting") && (
				<div
					role="progressbar"
					aria-label={`${item.fileName} progress`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					className="h-1.5 rounded-full bg-black/20 overflow-hidden"
				>
					<div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
				</div>
			)}
			{actions.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{actions.map(([text, action, primary]) => (
						<button
							key={text}
							onClick={() => action(item.id)}
							className={`px-3 py-1 rounded-full text-xs font-semibold ${primary ? "bg-accent hover:bg-accent-hover text-on-accent" : "bg-black/15 hover:bg-black/25"}`}
						>
							{text}
						</button>
					))}
				</div>
			)}
			{/* Saved only on click, never opened by the page */}
			{item.status === "done" && item.url && (
				<a
					href={item.url}
					download={item.fileName}
					className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent hover:bg-accent-hover text-on-accent text-xs font-semibold"
				>
					<FaDownload /> Save
				</a>
			)}
		</div>
	);
};

// Chat and file sharing with the other person. Mounted while in the room; shown when opened
const ChatPanel = ({ remoteName }) => {
	const { ready, filesOk, open, items } = useChat();
	const [text, setText] = useState("");
	const [pending, setPending] = useState(null); // from the clipboard, waiting for Send
	const listRef = useRef(null);
	const fileRef = useRef(null);
	const socket = useSocket();

	// A waiting clipboard item was meant for this person: the next connection may be someone else.
	// A clipboard read still running when the connection changes is dropped too
	const connectionRef = useRef(0);
	useEffect(() => {
		if (ready) return;
		connectionRef.current++;
		setPending(null);
	}, [ready]);
	const setPendingHere = () => {
		const connection = connectionRef.current;
		return value => connection === connectionRef.current && setPending(value);
	};
	useEffect(() => chat.setPeerName(remoteName), [remoteName]);
	// Only a real departure gets a note; a reconnect also replaces the connection but the call goes on
	useEffect(() => {
		socket.on("user:left", chat.peerLeft);
		return () => socket.off("user:left", chat.peerLeft);
	}, [socket]);
	useEffect(() => chat.clearChat, []); // leaving the room: nothing is kept
	useEffect(() => void files.restore(), []); // files left unfinished by a reload or leaving the room continue

	// Keep the newest message in view
	useEffect(() => {
		if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
	}, [items.length, open]);
	// ...also when the list gets smaller, e.g. the phone keyboard opening under it
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const observer = new ResizeObserver(() => { list.scrollTop = list.scrollHeight; });
		observer.observe(list);
		return () => observer.disconnect();
	}, [open]);

	if (!open) return null;

	const handleSubmit = e => {
		e.preventDefault();
		if (chat.sendText(text)) setText("");
	};
	const handlePick = e => {
		files.sendFiles([...e.target.files]);
		e.target.value = ""; // the same file can be picked again
	};
	const handleDrop = e => {
		e.preventDefault();
		if (filesOk) files.sendFiles([...e.dataTransfer.files]);
	};

	const clipOk = ready && chat.clipReady();
	// The clipboard is read only here, on the button's click, or from a paste into the message box
	const handleClipboard = async () => {
		const show = setPendingHere();
		show(await clipboard.readClipboard());
	};
	const handlePaste = e => {
		const image = clipOk && clipboard.fromPaste(e.clipboardData);
		if (!image) return;
		e.preventDefault();
		image.then(setPendingHere());
	};
	const sendClip = async () => {
		const current = pending;
		const show = setPendingHere();
		setPending(null);
		const result = await clipboard.sendPending(current);
		// A failure is shown even after the connection changed: it holds nothing that could be sent
		if (result?.kind === "error") setPending(result);
		else show(result);
	};

	const muted = "text-muted";
	const iconButton = `shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed`;

	// Below lg (phones, tablets): not over the call but under it, between the video and the control bar (see Room.jsx)
	return (
		<aside
			aria-label="Chat"
			onDragOver={e => e.preventDefault()}
			onDrop={handleDrop}
			className={`fixed z-40 inset-x-0 bottom-0 h-[75vh] max-lg:static max-lg:order-first max-lg:flex-1 max-lg:min-h-0 max-lg:h-auto max-lg:mx-2 sm:max-lg:mx-4 max-lg:mt-2 max-lg:rounded-2xl max-lg:shadow-none lg:inset-x-auto lg:right-4 lg:bottom-4 lg:top-4 lg:h-auto lg:w-96 flex flex-col rounded-t-3xl lg:rounded-3xl shadow-2xl border bg-surface border-line text-ink`}
		>
			<header className={`flex items-center justify-between gap-2 px-4 py-3 border-b border-line`}>
				<h3 className="font-display text-lg font-semibold truncate">{remoteName ? `Chat with ${remoteName}` : "Chat"}</h3>
				<button
					onClick={() => chat.setOpen(false)}
					aria-label="Close chat"
					className={`p-2 rounded-full hover:bg-raised`}
				>
					<FaTimes />
				</button>
			</header>

			<div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
				<p className={`text-xs text-center ${muted}`}>
					Messages and files go straight to the other person and are not stored on any server. Only open files from people you trust.
				</p>
				{items.map(item => item.kind === "note" ? (
					<p key={item.id} className={`text-xs text-center ${muted}`}>{item.text}</p>
				) : (
					<div key={item.id} className={`flex flex-col ${item.mine ? "items-end" : "items-start"}`}>
						<span className={`text-xs mb-0.5 max-w-full truncate ${muted}`}>
							{item.mine ? "You" : item.name || "Guest"}{" · "}{formatTime(item.at)}
						</span>
						<div className={`max-w-[85%] px-3 py-2 rounded-2xl whitespace-pre-wrap [overflow-wrap:anywhere] ` +
							(item.mine && item.kind === "text" ? "bg-accent text-on-accent font-medium" : "bg-raised")}
						>
							{item.kind === "text" ? item.text : item.kind === "clip" ? <ClipBubble item={item} /> : <FileItem item={item} remoteName={remoteName} ready={ready} />}
						</div>
					</div>
				))}
			</div>

			<form onSubmit={handleSubmit} className={`p-3 space-y-2 border-t border-line`}>
				{!ready && <p className={`text-xs ${muted}`}>Chat starts when the other person is connected.</p>}
				{ready && !filesOk && <p className={`text-xs ${muted}`}>Ask them to reload the page to send files.</p>}
				{pending && <ClipTray pending={pending} canSend={clipOk} onSend={sendClip} onClose={() => setPending(null)} />}
				<div className="flex items-center gap-1 sm:gap-2">
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						disabled={!filesOk}
						aria-label="Send a file"
						title="Send a file"
						className={`${iconButton} hover:bg-raised`}
					>
						<FaPaperclip />
					</button>
					<input ref={fileRef} type="file" multiple hidden onChange={handlePick} />
					<button
						type="button"
						onClick={handleClipboard}
						disabled={!clipOk}
						aria-label="Share from clipboard"
						title="Share from clipboard"
						className={`${iconButton} text-lg hover:bg-raised`}
					>
						<MdContentPaste />
					</button>
					<input
						type="text"
						value={text}
						onChange={e => setText(e.target.value)}
						onKeyDown={e => e.key === "Escape" && chat.setOpen(false)}
						onPaste={handlePaste}
						disabled={!ready}
						maxLength={chat.MAX_TEXT}
						placeholder="Type a message"
						aria-label="Message"
						className={`flex-1 min-w-0 px-4 py-2 rounded-full border text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 bg-ground border-line placeholder-muted`}
					/>
					<button type="submit" disabled={!ready || !text.trim()} aria-label="Send" className={`${iconButton} bg-accent hover:bg-accent-hover text-on-accent`}>
						<FaPaperPlane />
					</button>
				</div>
			</form>
		</aside>
	);
};

export default ChatPanel;
