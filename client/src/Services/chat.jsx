import peer from "./peer";

// Chat and file sharing over the call's two data channels, made in peer.reset(). Everything goes
// browser to browser, encrypted like the call; nothing is stored, and leaving the page clears it.
//
// "chat" channel, text:  { type: "hello", v: 1 }  { type: "chat", text }
// "files" channel, in order: { type: "file-start", id, name, size }, binary chunks, { type: "file-end", id }
// Either side may stop a file with { type: "file-cancel", id }; the receiver confirms with { type: "file-received", id }

export const MAX_TEXT = 2000;
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // the receiver holds the whole file in memory until Save
const CHUNK = 16 * 1024; // a message size every browser handles
const BLOCK = 64 * CHUNK; // read from disk 1 MB at a time
const HIGH_WATER = 1024 * 1024; // pause while this much is waiting to go out...
const LOW_WATER = 256 * 1024; // ...and continue once it drops below this
const PROGRESS_EVERY = 200; // ms between progress updates on screen

// Screen state, read with useSyncExternalStore
let state = { ready: false, open: false, unread: 0, items: [] };
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
const add = item => {
	const id = ++lastId;
	set({ items: [...state.items, { ...item, id, at: Date.now() }] });
	return id;
};
const update = (id, patch) => set({ items: state.items.map(i => (i.id === id ? { ...i, ...patch } : i)) });

let peerName = null;
export const setPeerName = name => {
	if (name) peerName = name;
};

// Unread while the panel is closed or the tab is in the background
const bump = () => (!state.open || document.hidden) && set({ unread: state.unread + 1 });
export const setOpen = open => set({ open, unread: open && !document.hidden ? 0 : state.unread });
document.addEventListener("visibilitychange", () => state.open && !document.hidden && state.unread && set({ unread: 0 }));

const parse = data => {
	if (typeof data !== "string" || data.length > 16384) return null;
	try {
		const msg = JSON.parse(data);
		return msg && typeof msg === "object" ? msg : null;
	} catch {
		return null;
	}
};
const sendJson = (channel, msg) => channel.readyState === "open" && channel.send(JSON.stringify(msg));

// Shown as text and used as the download name: no control or direction-changing characters, no path parts
const cleanName = name => {
	const n = String(name).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, "_").replace(/^[\s.]+/, "");
	return (n.length > 120 ? n.slice(0, 60) + "_" + n.slice(-59) : n) || "file";
};

// The current connection's channels and transfers. A new connection (peer.reset) ends the old one
let link = null;

const attach = (chat, files) => {
	endLink();
	const l = (link = { chat, files, ready: false, queue: [], sending: null, incoming: null });
	files.binaryType = "arraybuffer";
	files.bufferedAmountLowThreshold = LOW_WATER;
	// Chat turns on when the other side's hello arrives, so a browser on an older build without chat
	// is never sent messages that go nowhere
	chat.onopen = () => sendJson(chat, { type: "hello", v: 1 });
	chat.onmessage = e => l === link && onChat(l, e.data);
	files.onmessage = e => l === link && onFiles(l, e.data);
	chat.onclose = files.onclose = () => l === link && endLink();
};

// Connection gone (other person left, or a reconnect replaced it): unfinished transfers fail, partial data is
// dropped. No note here: a reconnect also ends the old connection while the call goes on (see peerLeft)
const endLink = () => {
	const l = link;
	link = null;
	if (!l) return;
	for (const job of l.sending ? [l.sending, ...l.queue] : l.queue) {
		job.stopped = "lost";
		job.wake?.();
		clearInterval(job.tick);
		update(job.item, { status: "failed", note: "Connection lost" });
	}
	if (l.incoming && !l.incoming.discard) drop(l.incoming, { status: "failed", note: "Connection lost" });
	l.queue = [];
	l.sending = l.incoming = null;
	set({ ready: false });
};

// The other person really left the room (the server's user:left): noted under the conversation, if there is one
export const peerLeft = () => state.items.length > 0 && add({ kind: "note", text: `${peerName || "The other person"} left the call` });

peer.onDataChannels = attach;
if (peer.chat) attach(peer.chat, peer.files);

// Leaving the room page: nothing is kept
export const clearChat = () => {
	endLink();
	state.items.forEach(i => i.url && URL.revokeObjectURL(i.url));
	set({ ready: false, open: false, unread: 0, items: [] });
	if (peer.chat) attach(peer.chat, peer.files);
};

const onChat = (l, data) => {
	const msg = parse(data);
	if (msg?.type === "hello" && !l.ready) {
		l.ready = true;
		set({ ready: true });
	} else if (msg?.type === "chat" && l.ready && typeof msg.text === "string" && msg.text.trim() && msg.text.length <= MAX_TEXT) {
		add({ kind: "text", mine: false, name: peerName, text: msg.text });
		bump();
	}
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

// Sending: one file at a time, the rest wait in a queue
export const sendFiles = list => {
	const l = link;
	if (!l?.ready) return;
	for (const file of list) {
		const base = { kind: "file", mine: true, fileName: file.name, size: file.size, done: 0 };
		if (!file.size || file.size > MAX_FILE_SIZE) {
			add({ ...base, status: "failed", note: file.size ? "Not sent: larger than 100 MB" : "Not sent: the file is empty" });
			continue;
		}
		const item = add({ ...base, status: "queued" });
		l.queue.push({ id: crypto.randomUUID(), item, file, sent: 0 });
	}
	pump(l);
};

const pump = l => {
	if (l === link && l.ready && !l.sending && l.queue.length) sendFile(l, (l.sending = l.queue.shift()));
};

const finishJob = (l, job, patch) => {
	clearInterval(job.tick);
	update(job.item, patch);
	if (l.sending === job) l.sending = null;
	pump(l);
};

const sendFile = async (l, job) => {
	const { files } = l;
	const { file } = job;
	update(job.item, { status: "sending" });
	// Progress counts what has actually left the browser, not what is still queued
	job.tick = setInterval(() => update(job.item, { done: Math.max(0, job.sent - files.bufferedAmount) }), PROGRESS_EVERY);
	try {
		files.send(JSON.stringify({ type: "file-start", id: job.id, name: file.name, size: file.size }));
		for (let at = 0; at < file.size && !job.stopped; at += BLOCK) {
			const block = await file.slice(at, at + BLOCK).arrayBuffer();
			for (let i = 0; i < block.byteLength && !job.stopped; i += CHUNK) {
				// send() never waits, so wait here while the queue is full
				if (files.bufferedAmount > HIGH_WATER) {
					await new Promise(resolve => {
						job.wake = resolve;
						files.addEventListener("bufferedamountlow", resolve, { once: true });
					});
					if (job.stopped) break;
				}
				const chunk = new Uint8Array(block, i, Math.min(CHUNK, block.byteLength - i));
				files.send(chunk);
				job.sent += chunk.byteLength;
			}
		}
		if (job.stopped === "lost") return;
		if (job.stopped) {
			sendJson(files, { type: "file-cancel", id: job.id }); // marks the end for the receiver
			return finishJob(l, job, { status: "cancelled" });
		}
		files.send(JSON.stringify({ type: "file-end", id: job.id }));
		job.ended = true; // now waiting for file-received; too late to cancel
		update(job.item, { cancellable: false });
	} catch (e) {
		if (job.stopped === "lost" || l !== link) return;
		console.error("File not sent", e);
		try {
			sendJson(files, { type: "file-cancel", id: job.id });
		} catch {}
		finishJob(l, job, { status: "failed", note: "Could not send" });
	}
};

// Receiving
const onFiles = (l, data) => {
	if (data instanceof ArrayBuffer) return onChunk(l, data);
	const msg = parse(data);
	if (!l.ready || typeof msg?.id !== "string" || msg.id.length > 64) return;
	const job = l.sending?.id === msg.id ? l.sending : null;
	const incoming = l.incoming?.id === msg.id ? l.incoming : null;
	if (msg.type === "file-start") startIncoming(l, msg);
	else if (msg.type === "file-end" && incoming) endIncoming(l, incoming);
	else if (msg.type === "file-received" && job?.ended) finishJob(l, job, { status: "sent", done: job.file.size });
	else if (msg.type === "file-cancel" && job) {
		if (job.ended) return finishJob(l, job, { status: "cancelled" });
		job.stopped = "them";
		job.wake?.();
	} else if (msg.type === "file-cancel" && incoming) {
		if (!incoming.discard) drop(incoming, { status: "cancelled" });
		l.incoming = null;
	}
};

// Where a received file's bytes go. Kept in memory until Save (hence the size limit); writing
// straight to disk later only needs another sink with the same three calls
const memorySink = () => {
	let parts = [], pending = [];
	return {
		write(chunk) {
			pending.push(chunk);
			// Every 1 MB becomes a Blob, which the browser can keep outside the page's JavaScript memory
			if (pending.length === BLOCK / CHUNK) parts.push(new Blob(pending.splice(0)));
		},
		// Returns the link for Save. Never opened by the page: the type stops a browser from showing it as a web page on our site
		close: () => URL.createObjectURL(new Blob([...parts, ...pending], { type: "application/octet-stream" })),
		abort() {
			parts = pending = [];
		},
	};
};

// Stop keeping a file's data; its later chunks are ignored until the sender's file-end or file-cancel
const drop = (incoming, patch) => {
	update(incoming.item, patch);
	incoming.discard = true;
	incoming.sink?.abort();
};

const startIncoming = (l, msg) => {
	if (l.incoming && !l.incoming.discard) drop(l.incoming, { status: "failed", note: "Interrupted" });
	l.incoming = { id: msg.id, discard: true };
	if (typeof msg.name !== "string" || !Number.isSafeInteger(msg.size) || msg.size < 1) return sendJson(l.files, { type: "file-cancel", id: msg.id });
	const item = add({ kind: "file", mine: false, name: peerName, fileName: cleanName(msg.name), size: msg.size, done: 0, status: "receiving" });
	bump();
	if (msg.size > MAX_FILE_SIZE) {
		update(item, { status: "failed", note: "Refused: larger than 100 MB" });
		return sendJson(l.files, { type: "file-cancel", id: msg.id });
	}
	l.incoming = { id: msg.id, item, size: msg.size, received: 0, sink: memorySink(), shown: 0 };
};

const onChunk = (l, chunk) => {
	const incoming = l.incoming;
	if (!incoming || incoming.discard) return;
	incoming.received += chunk.byteLength;
	if (incoming.received > incoming.size) {
		drop(incoming, { status: "failed", note: "Stopped: more data than announced" });
		return sendJson(l.files, { type: "file-cancel", id: incoming.id });
	}
	incoming.sink.write(chunk);
	const now = Date.now();
	if (now - incoming.shown >= PROGRESS_EVERY) {
		incoming.shown = now;
		update(incoming.item, { done: incoming.received });
	}
};

const endIncoming = (l, incoming) => {
	l.incoming = null;
	if (incoming.discard) return;
	if (incoming.received !== incoming.size) {
		drop(incoming, { status: "failed", note: "Incomplete" });
		return sendJson(l.files, { type: "file-cancel", id: incoming.id });
	}
	update(incoming.item, { status: "done", done: incoming.size, url: incoming.sink.close() });
	sendJson(l.files, { type: "file-received", id: incoming.id });
};

// Cancel a file on either side
export const cancelFile = item => {
	const l = link;
	if (!l) return;
	const queued = l.queue.find(job => job.item === item);
	if (queued) {
		l.queue = l.queue.filter(job => job !== queued);
		return update(item, { status: "cancelled" });
	}
	if (l.sending?.item === item && !l.sending.ended) {
		l.sending.stopped = "me";
		return l.sending.wake?.();
	}
	const incoming = l.incoming;
	if (incoming?.item === item && !incoming.discard) {
		drop(incoming, { status: "cancelled" });
		sendJson(l.files, { type: "file-cancel", id: incoming.id });
	}
};
