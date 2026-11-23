import { useEffect, useRef } from "react";

// Keyboard shortcuts in the call, as in Google Meet. ⌘ on a Mac and Ctrl elsewhere are shown; both work everywhere
const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent); // "macOS", "MacIntel"
// Phones cannot share their screen (iPhone Safari and Android Chrome have no getDisplayMedia): no button or shortcut there
export const CAN_SHARE_SCREEN = !!navigator.mediaDevices?.getDisplayMedia;

export const SHORTCUTS = [
	{ action: "mic", key: "D", shift: false, label: "Turn the microphone on or off" },
	{ action: "camera", key: "E", shift: false, label: "Turn the camera on or off" },
	{ action: "chat", key: "C", shift: true, label: "Open or close the chat" },
	{ action: "share", key: "S", shift: true, label: "Share your screen or stop" },
];
const find = action => SHORTCUTS.find(s => s.action === action);

// As shown to people: "⌘D", "⌘⇧C" on a Mac; "Ctrl+D", "Ctrl+Shift+C" elsewhere
export const keyText = action => {
	const { key, shift } = find(action);
	return MAC ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
};

// For aria-keyshortcuts on the button that does the same
export const ariaKeys = action => {
	const { key, shift } = find(action);
	const k = `${shift ? "Shift+" : ""}${key}`;
	return `Control+${k} Meta+${k}`;
};

// Runs actions[name] for its shortcut, never while typing in a field. preventDefault keeps the browser's own
// use of the keys (⌘D bookmarks the page) from firing too
export const useCallShortcuts = (actions, enabled) => {
	const latest = useRef(actions);
	latest.current = actions;

	useEffect(() => {
		if (!enabled) return;
		const handleKey = e => {
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			const shortcut = SHORTCUTS.find(s => e.code === `Key${s.key}` && s.shift === e.shiftKey && (s.action !== "share" || CAN_SHARE_SCREEN));
			const target = e.target;
			if (!shortcut || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName)) return;
			e.preventDefault();
			if (!e.repeat) latest.current[shortcut.action]?.();
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [enabled]);
};
