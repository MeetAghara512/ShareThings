import peer from "./peer";

// Chat over the call's data channels, made in peer.reset(); files.jsx sends files on the "files"
// channel. Everything goes browser to browser, encrypted like the call; leaving the page clears the chat.
//
// "chat" channel, text: { type: "hello", v: 2, me }  { type: "chat", text }
// "me" is a random id for this browser tab, so a file transfer only continues with the same person.

export const MAX_TEXT = 2000;
const EARLY_MAX = 50; // file messages that may arrive just before the other side's hello

// Screen state, read with useSyncExternalStore
let state = { ready: false, filesOk: false, open: false, unread: 0, items: [] };
const listeners = new Set();
const set = patch => {
	state = { ...state, ...patch };
	listeners.forEach(listener => listener());
};
export const subscribe = listener => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
export const getState = () => state;

let lastId = 0; // ids of items on screen, never taken from the other side
export const add = item => {
	const id = ++lastId;
	set({ items: [...state.items, { ...item, id, at: Date.now() }] });
	return id;
};
export const update = (id, patch) => set({ items: state.items.map(i => (i.id === id ? { ...i, ...patch } : i)) });

let peerName = null;
export const setPeerName = name => {
	if (name) peerName = name;
};
export const getPeerName = () => peerName;

// Unread while the panel is closed or the tab is in the background
export const bump = () => (!state.open || document.hidden) && set({ unread: state.unread + 1 });
export const setOpen = open => set({ open, unread: open && !document.hidden ? 0 : state.unread });
document.addEventListener("visibilitychange", () => state.open && !document.hidden && state.unread && set({ unread: 0 }));

export const parse = data => {
	if (typeof data !== "string" || data.length > 16384) return null;
	try {
		const msg = JSON.parse(data);
		return msg && typeof msg === "object" ? msg : null;
	} catch {
		return null;
	}
};
const sendJson = (channel, msg) => channel.readyState === "open" && channel.send(JSON.stringify(msg));

// This tab's id; kept across a reload of the same tab
const me = (() => {
	try {
		const id = sessionStorage.getItem("sharethings.me") || crypto.randomUUID();
		sessionStorage.setItem("sharethings.me", id);
		return id;
	} catch {
		return crypto.randomUUID();
	}
})();

// files.jsx: up(link) once both sides said hello, down(link), message(link, data), clear()
let files = {};
export const registerFiles = hooks => {
	files = hooks;
};

// privateCheck.jsx: up(link) once both sides said hello, down(link), message(link, msg)
let proof = {};
export const registerProof = hooks => {
	proof = hooks;
};

// The current connection's channels. A new connection (peer.reset) ends the old one
let link = null;

const attach = (chat, fileChannel) => {
	endLink();
	const l = (link = { chat, files: fileChannel, ready: false, early: [] });
	fileChannel.binaryType = "arraybuffer";
	// Chat turns on when the other side's hello arrives, so a browser on an older build without chat
	// is never sent messages that go nowhere
	chat.onopen = () => sendJson(chat, { type: "hello", v: 2, me });
	chat.onmessage = e => l === link && onChat(l, e.data);
	fileChannel.onmessage = e => l === link && (l.ready ? files.message?.(l, e.data) : l.early.length < EARLY_MAX && l.early.push(e.data));
	chat.onclose = fileChannel.onclose = () => l === link && endLink();
};

// Connection gone (other person left, or a reconnect replaced it); unfinished files wait for them (files.jsx).
// No note here: a reconnect also ends the old connection while the call goes on (see peerLeft)
const endLink = () => {
	const l = link;
	link = null;
	if (!l) return;
	files.down?.(l);
	proof.down?.(l);
	set({ ready: false, filesOk: false });
};

// The other person really left the room (the server's user:left): noted under the conversation, if there is one
export const peerLeft = () => state.items.length > 0 && add({ kind: "note", text: `${peerName || "The other person"} left the call` });

peer.onDataChannels = attach;
if (peer.chat) attach(peer.chat, peer.files);

// Leaving the room page: nothing is kept
export const clearChat = () => {
	endLink();
	files.clear?.();
	state.items.forEach(i => i.url && URL.revokeObjectURL(i.url));
	set({ ready: false, filesOk: false, open: false, unread: 0, items: [] });
	if (peer.chat) attach(peer.chat, peer.files);
};

const onChat = (l, data) => {
	const msg = parse(data);
	if (msg?.type === "hello" && !l.ready) {
		l.ready = true;
		l.peer = typeof msg.me === "string" ? msg.me.slice(0, 64) : null;
		l.version = msg.v;
		// Files need the same version on both sides; chat works with any
		set({ ready: true, filesOk: msg.v === 2 });
		files.up?.(l);
		l.early.splice(0).forEach(early => files.message?.(l, early));
		proof.up?.(l);
	} else if (msg?.type === "proof" && l.ready) {
		proof.message?.(l, msg);
	} else if (msg?.type === "chat" && l.ready && typeof msg.text === "string" && msg.text.trim() && msg.text.length <= MAX_TEXT) {
		add({ kind: "text", mine: false, name: peerName, text: msg.text });
		bump();
	} else if (msg?.type === "reaction" && l.ready && REACTIONS.includes(msg.emoji) && withinRate(reactionTimes.theirs)) {
		reactionListeners.forEach(listener => listener({ emoji: msg.emoji, mine: false }));
	}
};

// Reactions: { type: "reaction", emoji } on the chat channel. Only these six are ever shown, at most 5 per 3 s
// from each side (extra taps, or a flood from the other side, are dropped)
export const REACTIONS = ["👍", "❤️", "😂", "👏", "🎉", "😮"];
const RATE = { count: 5, per: 3000 };
const reactionTimes = { mine: [], theirs: [] };
const withinRate = times => {
	const now = Date.now();
	while (times.length && now - times[0] >= RATE.per) times.shift();
	if (times.length >= RATE.count) return false;
	times.push(now);
	return true;
};
const reactionListeners = new Set();
// listener({ emoji, mine }) for every reaction shown; returns the unsubscribe
export const onReaction = listener => {
	reactionListeners.add(listener);
	return () => reactionListeners.delete(listener);
};
export const sendReaction = emoji => {
	const l = link;
	if (!l?.ready || !REACTIONS.includes(emoji) || !withinRate(reactionTimes.mine)) return false;
	try {
		l.chat.send(JSON.stringify({ type: "reaction", emoji }));
	} catch {
		return false;
	}
	reactionListeners.forEach(listener => listener({ emoji, mine: true }));
	return true;
};

export const sendText = text => {
	const l = link;
	text = text.trim();
	if (!l?.ready || !text || text.length > MAX_TEXT) return false;
	try {
		l.chat.send(JSON.stringify({ type: "chat", text }));
	} catch {
		return false;
	}
	add({ kind: "text", mine: true, text });
	return true;
};
