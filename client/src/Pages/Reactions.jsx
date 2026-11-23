import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MdOutlineAddReaction } from "react-icons/md";
import * as chat from "../Services/chat";

const SHOW_FOR = 3000;

// The reaction button (in the bar; on phones, where the bar is full, in the chat box): a row of emoji above it,
// sent over the chat channel, so only once chat is ready. Picking one closes it, as does a click elsewhere
// or Escape. end: the row lines up with the button's right edge instead of its middle
export const ReactionButton = ({ className, look, on, darkMode, boxClass = "", end = false }) => {
	const ready = useSyncExternalStore(chat.subscribe, () => chat.getState().ready);
	const [open, setOpen] = useState(false);
	const box = useRef(null);

	useEffect(() => {
		if (!open) return;
		const close = e => (e.type === "keydown" ? e.key === "Escape" : !box.current?.contains(e.target)) && setOpen(false);
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);
	useEffect(() => {
		if (!ready) setOpen(false);
	}, [ready]);

	return (
		<div ref={box} className={`relative ${boxClass}`}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				disabled={!ready}
				aria-expanded={open}
				aria-label="Send a reaction"
				title={ready ? "Send a reaction" : "Reactions work once the other person is connected"}
				className={`${className} ${open ? on : look} disabled:opacity-40 disabled:cursor-not-allowed`}
			>
				<MdOutlineAddReaction />
			</button>
			{open && (
				<div
					role="group"
					aria-label="Reactions"
					className={`absolute z-50 bottom-full mb-2 ${end ? "right-0" : "left-1/2 -translate-x-1/2"} flex gap-0.5 p-1 rounded-full shadow-xl border ` +
						(darkMode ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200")}
				>
					{chat.REACTIONS.map(emoji => (
						<button
							key={emoji}
							type="button"
							onClick={() => {
								chat.sendReaction(emoji);
								setOpen(false);
							}}
							aria-label={`React with ${emoji}`}
							className={`w-9 h-9 rounded-full text-xl leading-none transition-colors active:scale-90 ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}
						>
							{emoji}
						</button>
					))}
				</div>
			)}
		</div>
	);
};

// Reactions floating up for a few seconds: mine over your own tile, the other person's over their video
export const ReactionLayer = ({ mine, className }) => {
	const [items, setItems] = useState([]);

	useEffect(() => {
		let next = 0;
		const timers = new Set();
		const stop = chat.onReaction(reaction => {
			if (reaction.mine !== mine) return;
			const id = ++next;
			setItems(list => [...list, { id, emoji: reaction.emoji, x: Math.round(Math.random() * 48 - 24) }]);
			const timer = setTimeout(() => {
				timers.delete(timer);
				setItems(list => list.filter(item => item.id !== id));
			}, SHOW_FOR);
			timers.add(timer);
		});
		return () => {
			stop();
			timers.forEach(clearTimeout);
		};
	}, [mine]);

	// Started once per emoji; no CSS keyframes needed
	const float = el => {
		if (!el || el.dataset.floating) return;
		el.dataset.floating = "1";
		el.animate(
			[
				{ transform: "translateY(0) scale(0.5)", opacity: 0 },
				{ transform: "translateY(-24px) scale(1.15)", opacity: 1, offset: 0.12 },
				{ transform: "translateY(-150px) scale(1)", opacity: 0 },
			],
			{ duration: SHOW_FOR, easing: "ease-out", fill: "forwards" }
		);
	};

	return (
		<div className={`pointer-events-none ${className}`}>
			{items.map(item => (
				<span
					key={item.id}
					ref={float}
					role="img"
					aria-label={`${mine ? "You" : "They"} reacted ${item.emoji}`}
					className="absolute bottom-0 left-1/2 text-4xl drop-shadow-lg"
					style={{ marginLeft: `${item.x - 18}px` }}
				>
					{item.emoji}
				</span>
			))}
		</div>
	);
};
