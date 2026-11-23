import React, { useState } from "react";
import { FaDownload } from "react-icons/fa";
import { extensionOf, linkOf } from "../Services/clipboard";

// A shared text, link or image in the chat. Everything is shown by React as text or as an <img>, and nothing
// opens or copies by itself
export const ClipBubble = ({ item }) => {
	const [copied, setCopied] = useState(false);

	if (item.clip === "image") {
		return (
			<div className="space-y-1.5">
				<img src={item.src} alt={item.mine ? "Image you shared" : `Image from ${item.name || "the other person"}`} draggable={false} referrerPolicy="no-referrer" className="block max-w-full max-h-48 rounded-lg" />
				<a href={item.src} download={`shared-image.${extensionOf(item.type)}`} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent hover:bg-accent-hover text-on-accent text-xs font-semibold">
					<FaDownload /> Save
				</a>
			</div>
		);
	}

	const link = linkOf(item.text);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(item.text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			window.prompt("Copy this:", item.text);
		}
	};
	return (
		<div className="space-y-1.5">
			<div className="max-h-48 overflow-y-auto" dir="auto">
				{link ? <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="underline">{link}</a> : item.text}
			</div>
			<button type="button" onClick={copy} className="px-3 py-1 rounded-full text-xs font-semibold bg-black/15 hover:bg-black/25">
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
};

// What is about to be shared: nothing is sent until Send is pressed here
export const ClipTray = ({ pending, canSend, onSend, onClose }) => {
	const error = pending.kind === "error";
	return (
		<div role="group" aria-label="Share from clipboard" className={`p-2 rounded-lg space-y-2 text-sm bg-raised`}>
			{error && <p role="alert">{pending.text}</p>}
			{pending.kind === "text" && <div className="max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{pending.text}</div>}
			{pending.kind === "image" && <img src={pending.src} alt="Image to share" draggable={false} className="block max-w-full max-h-24 rounded" />}
			{pending.kind === "large" && <p>This image is large, so it will be sent as a file: {pending.name}</p>}
			{pending.note && <p className="text-xs opacity-80">{pending.note}</p>}
			<div className="flex justify-end gap-1.5">
				<button type="button" onClick={onClose} className="px-3 py-1 rounded-full text-xs font-semibold bg-black/15 hover:bg-black/25">{error ? "Close" : "Cancel"}</button>
				{!error && <button type="button" onClick={onSend} disabled={!canSend} className="px-3 py-1 rounded-full text-xs font-semibold bg-accent hover:bg-accent-hover text-on-accent disabled:opacity-40 disabled:cursor-not-allowed">Send</button>}
			</div>
		</div>
	);
};
