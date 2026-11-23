import React, { useEffect, useState } from "react";
import { MdUploadFile } from "react-icons/md";
import * as chat from "../Services/chat";
import * as files from "../Services/files";

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");

// Files only: a dragged folder has no contents to read
const droppedFiles = data => {
	const items = [...(data.items || [])].filter(item => item.kind === "file");
	if (!items.length) return [...data.files];
	return items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()).filter(Boolean);
};

// Drag files onto the other person's video: they go through the normal file transfer, with its Accept rule.
// The chat opens so the progress is visible
export const useFileDrop = active => {
	const [over, setOver] = useState(false);

	useEffect(() => {
		if (!active) setOver(false);
	}, [active]);

	// Anywhere else on the page, a dropped file must not open in this tab and end the call
	useEffect(() => {
		const stay = e => {
			if (e.defaultPrevented || !hasFiles(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "none";
		};
		window.addEventListener("dragover", stay);
		window.addEventListener("drop", stay);
		return () => {
			window.removeEventListener("dragover", stay);
			window.removeEventListener("drop", stay);
		};
	}, []);

	const onDragOver = e => {
		if (!active || !hasFiles(e)) return;
		e.preventDefault(); // otherwise the browser opens the file and leaves the call
		e.dataTransfer.dropEffect = chat.getState().filesOk ? "copy" : "none";
		setOver(true);
	};
	const onDragLeave = e => {
		if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
	};
	const onDrop = e => {
		if (!active || !hasFiles(e)) return;
		e.preventDefault();
		setOver(false);
		if (!chat.getState().filesOk) return;
		const list = droppedFiles(e.dataTransfer);
		if (!list.length) return;
		files.sendFiles(list);
		chat.setOpen(true);
	};
	return { over, handlers: { onDragEnter: onDragOver, onDragOver, onDragLeave, onDrop } };
};

export const FileDropOverlay = ({ name }) => {
	const ok = chat.getState().filesOk;
	return (
		<div className="absolute inset-0 z-30 pointer-events-none flex flex-col items-center justify-center gap-2 p-6 text-center bg-black/80 text-white border-2 border-dashed border-accent rounded-3xl">
			<MdUploadFile className="text-5xl" />
			<span className="font-semibold">{ok ? `Drop to send to ${name || "the other person"}` : "Files cannot be sent yet"}</span>
		</div>
	);
};
