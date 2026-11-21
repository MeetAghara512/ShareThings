import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FaComments, FaDownload, FaFileAlt, FaPaperPlane, FaPaperclip, FaTimes } from "react-icons/fa";
import * as chat from "../Services/chat";

const useChat = () => useSyncExternalStore(chat.subscribe, chat.getState);
// On wide screens the room makes space for the open panel, so it never covers the call controls
export const useChatOpen = () => useChat().open;

const formatSize = bytes =>
	bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatTime = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// The Chat button in the call's button row, with the number of unread messages and files
export const ChatButton = () => {
	const { open, unread } = useChat();

	// Also in the tab title, for when the call is in a background tab
	useEffect(() => {
		if (!unread) return;
		const title = document.title;
		document.title = `(${unread}) ${title}`;
		return () => { document.title = title; };
	}, [unread]);

	return (
		<button
			onClick={() => chat.setOpen(!open)}
			aria-pressed={open}
			aria-label={unread ? `Chat, ${unread} unread` : "Chat"}
			className={`relative ${open ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-700 hover:bg-gray-600"} text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1`}
		>
			<FaComments /> Chat
			{unread > 0 && (
				<span className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-xs font-semibold flex items-center justify-center">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</button>
	);
};

const FileItem = ({ item }) => {
	const active = item.status === "queued" || item.status === "sending" || item.status === "receiving";
	const percent = Math.min(100, Math.floor((item.done / item.size) * 100)) || 0;
	const label = {
		queued: "Waiting...",
		sending: `${percent}%`,
		receiving: `${percent}%`,
		sent: "Sent",
		done: "Received",
		cancelled: "Cancelled",
	}[item.status] ?? item.note;

	return (
		<div className="w-56 max-w-full space-y-1.5">
			<div className="flex items-center gap-2 min-w-0">
				<FaFileAlt className="shrink-0 opacity-80" />
				<span className="truncate font-medium" title={item.fileName}>{item.fileName}</span>
			</div>
			<div className="flex items-center justify-between gap-2 text-xs">
				<span className="opacity-80">{formatSize(item.size)}</span>
				<span className={item.status === "failed" ? "text-red-400 font-medium" : "opacity-80"}>{label}</span>
			</div>
			{active && (
				<div className="flex items-center gap-2">
					<div
						role="progressbar"
						aria-label={`${item.fileName} progress`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						className="flex-1 h-1.5 rounded-full bg-black/20 overflow-hidden"
					>
						<div className="h-full bg-green-500 transition-[width]" style={{ width: `${percent}%` }} />
					</div>
					{item.cancellable !== false && (
						<button onClick={() => chat.cancelFile(item.id)} className="text-xs font-semibold underline-offset-2 hover:underline">
							Cancel
						</button>
					)}
				</div>
			)}
			{/* Saved only on click, never opened by the page */}
			{item.status === "done" && item.url && (
				<a
					href={item.url}
					download={item.fileName}
					className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-600 hover:bg-green-700 text-white text-xs font-semibold"
				>
					<FaDownload /> Save
				</a>
			)}
		</div>
	);
};

// Chat and file sharing with the other person. Mounted while in the room; shown when opened
const ChatPanel = ({ darkMode, remoteName }) => {
	const { ready, open, items } = useChat();
	const [text, setText] = useState("");
	const listRef = useRef(null);
	const fileRef = useRef(null);

	useEffect(() => chat.setPeerName(remoteName), [remoteName]);
	useEffect(() => chat.clearChat, []); // leaving the room: nothing is kept

	// Keep the newest message in view
	useEffect(() => {
		if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
	}, [items.length, open]);

	if (!open) return null;

	const handleSubmit = e => {
		e.preventDefault();
		if (chat.sendText(text)) setText("");
	};
	const handlePick = e => {
		chat.sendFiles([...e.target.files]);
		e.target.value = ""; // the same file can be picked again
	};
	const handleDrop = e => {
		e.preventDefault();
		if (ready) chat.sendFiles([...e.dataTransfer.files]);
	};

	const muted = darkMode ? "text-gray-400" : "text-gray-500";
	const iconButton = `shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed`;

	return (
		<aside
			aria-label="Chat"
			onDragOver={e => e.preventDefault()}
			onDrop={handleDrop}
			className={`fixed z-40 inset-x-0 bottom-0 h-[75vh] lg:inset-x-auto lg:right-4 lg:bottom-4 lg:top-24 lg:h-auto lg:w-96 flex flex-col rounded-t-2xl lg:rounded-2xl shadow-2xl border ` +
				(darkMode ? "bg-gray-800 border-gray-700 text-gray-100" : "bg-white border-gray-200 text-gray-900")}
		>
			<header className={`flex items-center justify-between gap-2 px-4 py-3 border-b ${darkMode ? "border-gray-700" : "border-gray-200"}`}>
				<h3 className="font-semibold truncate">{remoteName ? `Chat with ${remoteName}` : "Chat"}</h3>
				<button
					onClick={() => chat.setOpen(false)}
					aria-label="Close chat"
					className={`p-2 rounded-full ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}
				>
					<FaTimes />
				</button>
			</header>

			<div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
				<p className={`text-xs text-center ${muted}`}>
					Messages and files go straight to the other person and are not saved anywhere. Only open files from people you trust.
				</p>
				{items.map(item => item.kind === "note" ? (
					<p key={item.id} className={`text-xs text-center ${muted}`}>{item.text}</p>
				) : (
					<div key={item.id} className={`flex flex-col ${item.mine ? "items-end" : "items-start"}`}>
						<span className={`text-xs mb-0.5 max-w-full truncate ${muted}`}>
							{item.mine ? "You" : item.name || "Guest"}{" · "}{formatTime(item.at)}
						</span>
						<div className={`max-w-[85%] px-3 py-2 rounded-2xl whitespace-pre-wrap [overflow-wrap:anywhere] ` +
							(item.mine ? "bg-indigo-600 text-white" : darkMode ? "bg-gray-700" : "bg-gray-100")}
						>
							{item.kind === "text" ? item.text : <FileItem item={item} />}
						</div>
					</div>
				))}
			</div>

			<form onSubmit={handleSubmit} className={`p-3 space-y-2 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`}>
				{!ready && <p className={`text-xs ${muted}`}>Chat starts when the other person is connected.</p>}
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						disabled={!ready}
						aria-label="Send a file"
						title="Send a file (up to 100 MB)"
						className={`${iconButton} ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}
					>
						<FaPaperclip />
					</button>
					<input ref={fileRef} type="file" multiple hidden onChange={handlePick} />
					<input
						type="text"
						value={text}
						onChange={e => setText(e.target.value)}
						disabled={!ready}
						maxLength={chat.MAX_TEXT}
						placeholder="Type a message"
						aria-label="Message"
						className={`flex-1 min-w-0 px-4 py-2 rounded-full border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50 ` +
							(darkMode ? "bg-gray-700 border-gray-600 placeholder-gray-400" : "bg-white border-gray-300 placeholder-gray-500")}
					/>
					<button type="submit" disabled={!ready || !text.trim()} aria-label="Send" className={`${iconButton} bg-indigo-600 hover:bg-indigo-700 text-white`}>
						<FaPaperPlane />
					</button>
				</div>
			</form>
		</aside>
	);
};

export default ChatPanel;
