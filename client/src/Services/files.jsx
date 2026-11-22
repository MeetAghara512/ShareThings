import peer from "./peer";
import { add, update, bump, parse, getPeerName, registerFiles } from "./chat";

// Files over the call's "files" data channel, from a few bytes to many GB (chat.jsx runs the channels).
//
//   sender                                        receiver
//   offer {id, key, name, size,             ->    up to 100 MB: taken at once; bigger: Accept. Either
//          modified, rate}                        way written to disk (private storage) as it arrives
//                                           <-    pull {id, from, seq}: send from block `from` on
//   run {id, from, seq}, binary pieces, and
//   block {id, index, hash} after each 8 MB ->    SHA-256 checked, written, then
//                                           <-    ack {id, have}: blocks safely stored
//   pause / resume / cancel {id, reason} go either way; decline {id, reason} comes from the receiver.
//
// The receiver always says where to continue, so a pause, a damaged block, a new connection and a
// reload all resume the same way. A transfer only continues with the same person (hello's "me").
// Received files never sit in memory: each block goes to the browser's private storage (OPFS), and a
// file picked at Accept gets the finished file streamed from there. Only browsers without private
// storage keep files, up to 100 MB, in memory.

const BLOCK = 8 * 1024 * 1024; // checked with SHA-256 and written to disk as one
const ACCEPT_OVER = 100 * 1024 * 1024; // bigger files wait for Accept; also the limit without private storage
const RELAY_ASK = 500 * 1024 * 1024; // over a relay, ask before sending more than this
const AHEAD = 2; // blocks sent ahead of what the receiver has stored, so its memory stays flat
const QUEUE_MAX = 1024 * 1024; // at most this much waiting in the channel, so the call keeps priority
const POOR_RATE = 128 * 1024; // bytes per second while the call quality is Poor
const SPARE = 64 * 1024 * 1024; // free space to keep on top of the file
const DAY = 24 * 60 * 60 * 1000;

const THEIR_STOP = { __proto__: null, space: "Stopped: not enough disk space on their side", write: "Stopped: they could not save the file", damaged: "Stopped: the file kept arriving damaged" };
const OUR_STOP = { __proto__: null, space: "Stopped: not enough disk space", write: "Stopped: the file could not be saved", damaged: "Stopped: the file kept arriving damaged" };
const DECLINED = { __proto__: null, space: "Declined: not enough free space on their device", write: "Declined: their browser could not save the file" };

const outgoing = []; // ours, in order; one at a time per person
const incoming = new Map(); // theirs, by id
const finished = new Set(); // ids fully received, so a late repeat of the offer is just confirmed
const unsaved = new Map(); // finished files still to be copied to the place picked at Accept, by item
const delivered = new Set(); // finished files in private storage offered for Save, deleted when leaving the room
let link = null; // the open channels, once both sides said hello
let inbound = null; // the incoming transfer the next binary pieces belong to
let callStats = {}; // from CallStatus: { quality, relay, bitrate }
let lastSpeed = 0;
let ticker = null;

export const setCallStats = stats => {
	callStats = stats || {};
};

const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
const sha = async data => hex(await crypto.subtle.digest("SHA-256", data));
const send = msg => link?.files.readyState === "open" && link.files.send(JSON.stringify(msg));
const blocksOf = size => Math.ceil(size / BLOCK);
const blockSize = (t, index) => Math.min(BLOCK, t.size - index * BLOCK);
const byItem = item => outgoing.find(t => t.item === item) || [...incoming.values()].find(t => t.item === item) || unsaved.get(item);
const moving = t => t.status === "sending" || t.status === "receiving";

const setStatus = (t, status, extra) => {
	t.status = status;
	if (moving(t)) ticker ??= setInterval(tick, 500);
	else t.mark = t.speed = t.ticks = undefined;
	update(t.item, { status, note: undefined, ...extra });
};

// Progress, speed and time left on screen, twice a second
const tick = () => {
	const now = Date.now();
	const busy = [...outgoing, ...incoming.values()].filter(moving);
	for (const t of busy) {
		const done = Math.min(t.size, t.mine ? Math.max(t.acked * BLOCK, t.sent - (link?.files.bufferedAmount || 0)) : t.got);
		if (t.mark) {
			const speed = ((done - t.mark.done) * 1000) / (now - t.mark.at);
			t.speed = t.speed === undefined ? speed : t.speed * 0.7 + speed * 0.3;
		}
		t.mark = { done, at: now };
		t.ticks = (t.ticks || 0) + 1;
		// Speed and time left only once the transfer is up to speed (after about 2 seconds)
		update(t.item, { done, speed: t.ticks > 4 ? Math.max(0, t.speed) : 0 });
	}
	if (!busy.length) {
		clearInterval(ticker);
		ticker = null;
	}
};

// Shown as text and used as the file name: no control or direction-changing characters, no path parts
const cleanName = name => {
	const n = String(name).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, "_").replace(/^[\s.]+/, "");
	return (n.length > 120 ? n.slice(0, 60) + "_" + n.slice(-59) : n) || "file";
};

// Files on disk being received, kept in IndexedDB so a reload can continue them:
// { part (its file in private storage), key, id, name, size, modified, from, room, target (the file picked at Accept, if any), at }
let database = null;
const records = (mode, use) => {
	database ??= new Promise((resolve, reject) => {
		const open = indexedDB.open("sharethings-files", 1);
		open.onupgradeneeded = () => open.result.createObjectStore("partials", { keyPath: "part" });
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
	return database.then(db => new Promise((resolve, reject) => {
		const tx = db.transaction("partials", mode);
		const request = use(tx.objectStore("partials"));
		tx.oncomplete = () => resolve(request.result);
		tx.onerror = tx.onabort = () => reject(tx.error);
	}));
};
const keepRecord = t => records("readwrite", s => s.put({ part: t.part, key: t.key, id: t.id, name: t.name, size: t.size, modified: t.modified, from: t.from, room: t.room, target: t.target || null, at: Date.now() })).catch(() => {});
const forget = part => records("readwrite", s => s.delete(part)).catch(() => {});
// Only the very same file continues a partial one: same key, size, name and last-modified time
const same = (x, msg) => x.key === msg.key && x.size === msg.size && x.name === cleanName(msg.name) && x.modified === msg.modified;

// Private storage (OPFS) is written by a worker: only workers get the fast synchronous file handles
const hasDisk = !!navigator.storage?.getDirectory;
const folder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("incoming-files", { create: true });
const diskFile = async part => (await (await folder()).getFileHandle(part)).getFile();
const discard = t => {
	if (!t.part) return;
	forget(t.part);
	folder().then(dir => dir.removeEntry(t.part)).catch(() => {});
};
const freeSpace = async () => {
	const space = await navigator.storage?.estimate?.().catch(() => null);
	return space ? space.quota - space.usage : Infinity;
};
const calls = new Map();
let worker = null;
let lastCall = 0;
const disk = (op, args, transfer = []) => new Promise((resolve, reject) => {
	if (!worker) {
		worker = new Worker(new URL("./opfsWorker.js", import.meta.url), { type: "module" });
		worker.onmessage = ({ data }) => {
			const call = calls.get(data.call);
			calls.delete(data.call);
			if (data.error) call?.reject(new DOMException(data.message, data.error));
			else call?.resolve(data.result);
		};
		worker.onerror = () => {
			calls.forEach(call => call.reject(new DOMException("Private storage is not available", "NotSupportedError")));
			calls.clear();
			worker = null;
		};
	}
	calls.set(++lastCall, { resolve, reject });
	worker.postMessage({ call: lastCall, op, ...args }, transfer);
});

// Where a received file goes. Every sink has: have (blocks already stored), write(bytes, at),
// close() -> link for Save (none for disk: see deliver), abort() deletes what was written
const diskSink = async t => {
	// Its own file, so sending the same file again never touches an earlier copy waiting to be saved
	const name = (t.part ??= `${t.key}-${Date.now().toString(36)}.part`);
	const length = await disk("open", { name });
	return {
		have: length >= t.size ? t.blocks : Math.floor(length / BLOCK),
		write: (bytes, at) => disk("write", { name, at, bytes }, [bytes]),
		close: () => disk("close", { name }),
		release: () => disk("close", { name }), // leaving the room: keep the file for a later visit
		abort: async () => {
			await disk("close", { name }).catch(() => {});
			discard(t);
		},
	};
};

// Only for browsers without private storage, and files up to 100 MB
const memorySink = () => {
	const parts = [];
	return {
		have: 0,
		write: async bytes => void parts.push(new Blob([bytes])),
		// Never opened by the page: the type stops a browser from showing it as a web page on our site
		close: async () => URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" })),
		abort: async () => void (parts.length = 0),
	};
};

// Leftovers from earlier visits: finished files, and unfinished ones not continued within a day
const tidy = async () => {
	const dir = await folder();
	const keep = new Set();
	for (const record of await records("readonly", s => s.getAll())) {
		const used = await diskFile(record.part).then(f => f.lastModified, () => 0);
		if (Math.max(record.at, used) > Date.now() - DAY) keep.add(record.part);
		else forget(record.part);
	}
	const names = [];
	for await (const name of dir.keys()) names.push(name);
	for (const name of names) if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
};
if (hasDisk) tidy().catch(() => {});

// Sending

export const sendFiles = list => {
	if (link?.version !== 2) return; // the other side runs an older version of the app (see ChatPanel)
	for (const file of list) {
		const t = { id: crypto.randomUUID(), file, name: file.name, size: file.size, blocks: blocksOf(file.size), peer: link.peer, mine: true, acked: 0, sent: 0, runs: 0 };
		t.item = add({ kind: "file", mine: true, to: getPeerName(), fileName: file.name, size: file.size, done: 0, status: "queued" });
		t.status = "queued";
		if (file.size) outgoing.push(t);
		else setStatus(t, "failed", { note: "Not sent: the file is empty" });
	}
	next();
};

// The first file in line for the person we are talking to goes next
const next = async () => {
	const t = link && outgoing.find(x => x.peer === link.peer);
	if (t?.status !== "queued") return;
	setStatus(t, "preparing");
	try {
		// The same file picked again after a reload gets the same key, so the receiver can continue it
		const first = await sha(await t.file.slice(0, BLOCK).arrayBuffer());
		t.key = (await sha(new TextEncoder().encode([t.name, t.size, t.file.lastModified, first].join("\n")))).slice(0, 32);
	} catch (e) {
		console.error("File not read", e);
		return end(t, "failed", { note: "Could not read the file" });
	}
	if (t.status !== "preparing") return; // cancelled meanwhile
	if (t.size > RELAY_ASK && callStats.relay) {
		return setStatus(t, "relay", { note: "Slow route: this call goes through a relay server, so a big file can take a long time. Send anyway?" });
	}
	offer(t);
};

const offer = t => {
	t.offered = true;
	setStatus(t, t.paused ? "paused" : t.accepted ? "waiting" : "offered");
	// For the receiver's time estimate: the speed of an earlier file in this call, else the call's own
	// bandwidth estimate, which is usually lower than what files get, so the time is an upper bound
	const rate = Math.round(lastSpeed || (callStats.bitrate || 0) / 8) || undefined;
	send({ type: "offer", id: t.id, key: t.key, name: t.name, size: t.size, modified: t.file.lastModified, rate, measured: lastSpeed > 0 || undefined, paused: t.paused || undefined });
};

export const sendAnyway = item => {
	const t = byItem(item);
	if (t?.status === "relay") offer(t);
};

const end = (t, status, extra) => {
	halt(t);
	if (outgoing.includes(t)) outgoing.splice(outgoing.indexOf(t), 1);
	setStatus(t, status, extra);
	next();
};

// Stop a send loop, or ignore further pieces of an incoming file
const halt = t => {
	t.runs++;
	t.wake?.();
	t.collect = null;
};

const onPull = msg => {
	const t = outgoing.find(x => x.id === msg.id);
	if (!t || t.peer !== link.peer || !Number.isSafeInteger(msg.from) || msg.from < 0 || msg.from > t.blocks || !Number.isSafeInteger(msg.seq)) return;
	t.accepted = true;
	t.paused = false;
	t.acked = msg.from;
	setStatus(t, "sending");
	run(t, msg.from, msg.seq);
};

// Until the queue drains, the receiver confirms, the time is up, or the transfer is paused or stopped
const wait = (t, channel, ms = 100) => new Promise(resolve => {
	const stop = new AbortController();
	const done = () => {
		clearTimeout(timer);
		stop.abort();
		resolve();
	};
	const timer = setTimeout(done, ms);
	channel?.addEventListener("bufferedamountlow", done, { signal: stop.signal });
	t.wake = done;
});

// Send blocks from `from` on, each followed by its SHA-256, staying a little ahead of the receiver
const run = async (t, from, seq) => {
	const token = ++t.runs;
	const l = link;
	const channel = l.files;
	const live = () => t.runs === token && t.status === "sending" && link === l;
	// The largest message both browsers accept, between 16 and 256 KB
	const piece = Math.max(16 * 1024, Math.min(256 * 1024, peer.peer.sctp?.maxMessageSize || 0));
	t.sent = from * BLOCK;
	try {
		channel.send(JSON.stringify({ type: "run", id: t.id, from, seq }));
		for (let index = from; index < t.blocks && live(); index++) {
			while (index - t.acked >= AHEAD && live()) await wait(t, channel);
			if (!live()) return;
			const bytes = await t.file.slice(index * BLOCK, (index + 1) * BLOCK).arrayBuffer();
			const hash = await sha(bytes);
			for (let at = 0; at < bytes.byteLength && live(); at += piece) {
				// The call comes first: a short queue, and a slow pace while its quality is Poor
				const poor = callStats.quality === "poor";
				while (channel.bufferedAmount > (poor ? 0 : QUEUE_MAX) && live()) await wait(t, channel);
				if (!live()) return;
				const chunk = new Uint8Array(bytes, at, Math.min(piece, bytes.byteLength - at));
				channel.send(chunk);
				t.sent = index * BLOCK + at + chunk.byteLength;
				if (poor) await wait(t, null, (chunk.byteLength / POOR_RATE) * 1000);
			}
			if (live()) channel.send(JSON.stringify({ type: "block", id: t.id, index, hash }));
		}
	} catch (e) {
		if (!live()) return;
		console.error("File not sent", e);
		send({ type: "cancel", id: t.id });
		end(t, "failed", { note: "Could not read the file" });
	}
};

const onAck = msg => {
	const t = outgoing.find(x => x.id === msg.id);
	if (!t || !Number.isSafeInteger(msg.have) || msg.have < t.acked || msg.have > t.blocks) return;
	t.acked = msg.have;
	t.wake?.();
	if (t.acked < t.blocks) return;
	lastSpeed = t.speed || lastSpeed;
	end(t, "sent", { done: t.size });
};

const onDecline = msg => {
	const t = outgoing.find(x => x.id === msg.id);
	if (t) end(t, "declined", { note: DECLINED[msg.reason] });
};

// Receiving

const receiver = ({ id, key, name, size, modified }) => ({ id, key, name: cleanName(name), size, modified, blocks: blocksOf(size), have: 0, got: 0, seq: 0, runs: 0, pending: 0, damaged: 0, chain: Promise.resolve() });

const onOffer = async msg => {
	const { id, key, name, size } = msg;
	// Only the 32 hex characters a sender makes for the key, a real size and a last-modified time
	if (!/^[0-9a-f]{32}$/.test(key) || typeof name !== "string" || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(msg.modified) || outgoing.some(t => t.id === id)) return;
	if (finished.has(id)) return send({ type: "ack", id, have: blocksOf(size) });
	let t = incoming.get(id);
	if (t && !same(t, msg)) return; // the same id for a different file
	t ||= [...incoming.values()].find(x => same(x, msg));
	if (t) {
		// The same file again: after a new connection, or picked again after the sender reloaded
		incoming.delete(t.id);
		incoming.set((t.id = id), t);
		t.paused ||= msg.paused === true;
		if (t.sink) return t.paused ? setStatus(t, "paused") : pull(t);
		// Listed again after a reload (restore): open its file and continue where it stopped
		if (t.accepted && t.status === "waiting") take(t, () => diskSink(t));
		return;
	}
	const rate = Number.isFinite(msg.rate) && msg.rate > 0 ? msg.rate : 0;
	t = Object.assign(receiver(msg), { status: "offered", from: getPeerName(), room: location.pathname });
	incoming.set(id, t);
	t.item = add({ kind: "file", mine: false, name: t.from, fileName: t.name, size, done: 0, status: "offered", eta: rate && size / rate, rough: msg.measured !== true });
	bump();
	const still = () => incoming.get(id) === t && t.status === "offered";
	if (!hasDisk) {
		if (size <= ACCEPT_OVER) return take(Object.assign(t, { accepted: true }), memorySink);
		send({ type: "decline", id, reason: "write" });
		return drop(t, "failed", "This browser can only receive files up to 100 MB");
	}
	const record = (await records("readonly", s => s.getAll()).catch(() => [])).find(r => same(r, msg));
	if (!still()) return;
	if (record) return take(Object.assign(t, { accepted: true, target: record.target, part: record.part }), () => diskSink(t)); // accepted before a reload
	const free = await freeSpace();
	if (!still()) return;
	if (size <= ACCEPT_OVER) return free < size + SPARE ? refuse(Object.assign(t, { accepted: true })) : take(Object.assign(t, { accepted: true }), () => diskSink(t));
	// Bigger files wait for Accept. When space is tight, say what they need: the file's size, and for a
	// moment twice that while it is copied to a place picked at Accept
	if (free < size + SPARE) update(t.item, { needs: size });
	else if (window.showSaveFilePicker && free < 2 * size + SPARE) update(t.item, { needs: 2 * size, moment: true });
};

const take = async (t, makeSink) => {
	if (!incoming.has(t.id)) return;
	setStatus(t, "receiving");
	try {
		t.sink = await makeSink();
	} catch (e) {
		console.error("Could not get ready to save the file", e);
		send({ type: "decline", id: t.id, reason: "write" });
		return drop(t, "failed", "This browser could not save the file");
	}
	if (!incoming.has(t.id)) return t.sink.abort();
	if (t.sink.release) keepRecord(t); // on disk: a reload can continue it
	t.have = t.sink.have;
	t.got = t.have * BLOCK;
	if (t.have === t.blocks) {
		send({ type: "ack", id: t.id, have: t.have });
		return complete(t);
	}
	if (t.paused) return setStatus(t, "paused");
	pull(t);
};

// Not enough free space for the copy in private storage
const refuse = t => {
	send({ type: "decline", id: t.id, reason: "space" });
	drop(t, "failed", "Not enough free space on this device", { needs: t.size });
};

export const accept = async item => {
	const t = byItem(item);
	if (t?.mine || t?.status !== "offered") return;
	setStatus(t, "receiving");
	// Where to save it at the end (Chrome / Edge); it is received into private storage first
	if (window.showSaveFilePicker) {
		try {
			t.target = await window.showSaveFilePicker({ suggestedName: t.name });
		} catch (e) {
			if (e.name !== "AbortError") console.error("Save dialog failed", e);
			else if (incoming.has(t.id)) {
				// Closed the save dialog: that is a no
				send({ type: "decline", id: t.id });
				return drop(t, "declined");
			}
		}
	}
	t.accepted = true;
	const free = await freeSpace();
	if (!incoming.has(t.id)) return; // cancelled meanwhile
	if (free < t.size + SPARE) return refuse(t);
	take(t, () => diskSink(t));
};

// Entering the room, also after a reload: list this room's unfinished files again (and finished ones
// not yet saved). They continue by themselves once the sender is back in the call
export const restore = async () => {
	if (!hasDisk) return;
	const known = record => incoming.has(record.id) || [...incoming.values(), ...unsaved.values()].some(x => x.key === record.key);
	try {
		for (const record of await records("readonly", s => s.getAll())) {
			if (known(record)) continue;
			const length = await diskFile(record.part).then(f => f.size, e => (e.name === "NotFoundError" ? null : -1));
			if (length === null) forget(record.part);
			if (!(length >= 0)) continue; // gone, or open in another tab

			const t = Object.assign(receiver(record), { part: record.part, from: record.from, room: record.room, target: record.target, accepted: true, status: "waiting" });
			t.have = length >= t.size ? t.blocks : Math.floor(length / BLOCK);
			if ((t.have < t.blocks && record.room !== location.pathname) || known(record)) continue;
			t.got = t.have * BLOCK;
			t.item = add({ kind: "file", mine: false, name: t.from, fileName: t.name, size: t.size, done: t.got, status: "waiting" });
			if (t.have < t.blocks) incoming.set(t.id, t);
			else deliver(t);
		}
	} catch (e) {
		console.error("Unfinished files not listed", e);
	}
};

export const decline = item => {
	const t = byItem(item);
	if (t?.mine || t?.status !== "offered") return;
	send({ type: "decline", id: t.id });
	drop(t, "declined");
};

// Ask for everything from the first block not yet stored; older pieces still on the way are ignored
const pull = t => {
	const seq = ++t.seq;
	t.collect = null;
	setStatus(t, "receiving");
	t.chain = t.chain.then(() => seq === t.seq && incoming.has(t.id) && send({ type: "pull", id: t.id, from: t.have, seq }));
};

const onRun = msg => {
	const t = incoming.get(msg.id);
	if (!t || msg.seq !== t.seq || msg.from !== t.have || t.status !== "receiving") return;
	t.collect = { index: t.have, pieces: [], bytes: 0 };
	t.got = t.have * BLOCK;
	inbound = t;
};

const onPiece = piece => {
	const t = inbound;
	const c = t?.collect;
	if (!c || t.status !== "receiving") return;
	c.pieces.push(piece);
	c.bytes += piece.byteLength;
	t.got += piece.byteLength;
	if (c.bytes > blockSize(t, c.index)) pull(t); // more than the block holds: ask for it again
};

const onBlock = msg => {
	const t = incoming.get(msg.id);
	const c = t?.collect;
	if (!c || t !== inbound || msg.index !== c.index || typeof msg.hash !== "string") return;
	if (c.bytes !== blockSize(t, c.index) || t.pending > AHEAD) return pull(t);
	t.collect = c.index + 1 < t.blocks ? { index: c.index + 1, pieces: [], bytes: 0 } : null;
	t.pending++;
	t.chain = t.chain.then(() => store(t, c, msg.hash));
};

// Check a block against the sender's SHA-256, then write it; a damaged block is asked for again
const store = async (t, c, hash) => {
	t.pending--;
	if (c.index !== t.have || !incoming.has(t.id)) return;
	const bytes = new Uint8Array(blockSize(t, c.index));
	c.pieces.reduce((at, piece) => (bytes.set(new Uint8Array(piece), at), at + piece.byteLength), 0);
	if ((await sha(bytes)) !== hash) {
		console.warn(`Block ${c.index + 1} of "${t.name}" arrived damaged; asking for it again`);
		return ++t.damaged > 3 ? stop(t, "damaged") : pull(t);
	}
	try {
		await t.sink.write(bytes.buffer, c.index * BLOCK);
	} catch (e) {
		console.error("File not written", e);
		return incoming.has(t.id) && stop(t, e.name === "QuotaExceededError" ? "space" : "write");
	}
	if (!incoming.has(t.id)) return;
	t.damaged = 0;
	t.have = c.index + 1;
	send({ type: "ack", id: t.id, have: t.have });
	if (t.have === t.blocks) complete(t);
};

const complete = async t => {
	lastSpeed = t.speed || lastSpeed;
	incoming.delete(t.id);
	finished.add(t.id);
	if (inbound === t) inbound = null;
	try {
		const url = await t.sink.close();
		if (url) setStatus(t, "done", { url, done: t.size });
		else await deliver(t);
	} catch (e) {
		console.error("File not saved", e);
		t.sink.abort();
		setStatus(t, "failed", { note: OUR_STOP[e.name === "QuotaExceededError" ? "space" : "write"] });
	}
};

// The whole file is on disk: copy it to the place picked at Accept, or offer it for Save. The link
// points at the file on disk, so saving it never loads it into memory
const deliver = async t => {
	if (t.target) return save(t);
	forget(t.part);
	delivered.add(t.part);
	const url = URL.createObjectURL(new Blob([await diskFile(t.part)], { type: "application/octet-stream" }));
	setStatus(t, "done", { url, done: t.size });
};

// Stream the finished file from private storage into the file picked at Accept, then delete the copy.
// After a reload the browser may need a click to allow writing there again: that is the Save button
const save = async (t, ask = false) => {
	unsaved.set(t.item, t);
	const mode = { mode: "readwrite" };
	let allowed = (await t.target.queryPermission?.(mode).catch(() => "denied")) === "granted";
	if (!allowed && ask) allowed = (await t.target.requestPermission?.(mode).catch(() => "denied")) === "granted";
	if (!allowed && !ask) return setStatus(t, "unsaved", { done: t.size });
	if (!allowed) {
		// Not allowed there: offer it as a normal download instead
		unsaved.delete(t.item);
		t.target = null;
		return deliver(t);
	}
	setStatus(t, "saving", { done: t.size });
	try {
		await (await diskFile(t.part)).stream().pipeTo(await t.target.createWritable());
	} catch (e) {
		console.error("File not saved", e);
		const note = e.name === "QuotaExceededError" ? "Not enough disk space to save it there. Free some space, then press Save" : "Could not save it there. Press Save to try again";
		return setStatus(t, "unsaved", { done: t.size, note });
	}
	unsaved.delete(t.item);
	discard(t);
	setStatus(t, "saved", { done: t.size });
};

export const saveFile = item => {
	const t = unsaved.get(item);
	if (t?.status === "unsaved") save(t, true);
};

// Forget an incoming file and delete what was written
const drop = (t, status, note, extra) => {
	incoming.delete(t.id);
	if (inbound === t) inbound = null;
	t.collect = null;
	if (t.sink) t.sink.abort();
	else if (t.accepted && hasDisk) discard(t);
	setStatus(t, status, { note, ...extra });
};

const stop = (t, reason) => {
	send({ type: "cancel", id: t.id, reason });
	drop(t, "failed", OUR_STOP[reason]);
};

// Both sides

export const pause = item => {
	const t = byItem(item);
	if (!t || !moving(t)) return;
	t.paused = true;
	halt(t);
	setStatus(t, "paused");
	send({ type: "pause", id: t.id });
};

export const resume = item => {
	const t = byItem(item);
	if (t?.status !== "paused" || !link) return;
	t.paused = false;
	if (!t.mine) return pull(t);
	setStatus(t, "sending");
	send({ type: "resume", id: t.id });
};

export const cancel = item => {
	const t = byItem(item);
	if (!t) return;
	if (!t.mine || t.offered) send({ type: "cancel", id: t.id });
	if (t.mine) end(t, "cancelled");
	else drop(t, "cancelled");
};

const onPause = msg => {
	const t = outgoing.find(x => x.id === msg.id) || incoming.get(msg.id);
	if (!t || !moving(t)) return;
	t.paused = true;
	halt(t);
	setStatus(t, "paused");
};

const onResume = msg => {
	const t = incoming.get(msg.id);
	if (t?.status !== "paused") return;
	t.paused = false;
	pull(t);
};

const onCancel = msg => {
	const t = outgoing.find(x => x.id === msg.id);
	if (t) return end(t, THEIR_STOP[msg.reason] ? "failed" : "cancelled", { note: THEIR_STOP[msg.reason] });
	const r = incoming.get(msg.id);
	if (r) drop(r, "cancelled");
};

// An older version of the app sends "file-start": say no, so it does not wait forever
const onOldStart = msg => send({ type: "file-cancel", id: msg.id });

const HANDLERS = { __proto__: null, offer: onOffer, pull: onPull, run: onRun, block: onBlock, ack: onAck, decline: onDecline, pause: onPause, resume: onResume, cancel: onCancel, "file-start": onOldStart };

registerFiles({
	up(l) {
		link = l;
		l.files.bufferedAmountLowThreshold = 256 * 1024;
		// The same person is back (a new connection, or their page reloaded): offer our unfinished file again
		const t = outgoing.find(x => x.peer === l.peer);
		if (t?.offered) offer(t);
		next();
	},
	// Connection gone: unfinished files wait, and continue when the same person is back
	down(l) {
		if (link !== l) return;
		link = inbound = null;
		for (const t of [...outgoing, ...incoming.values()]) {
			if (!moving(t) && t.status !== "paused") continue;
			halt(t);
			setStatus(t, "waiting");
		}
	},
	message(l, data) {
		if (data instanceof ArrayBuffer) return onPiece(data);
		const msg = parse(data);
		if (typeof msg?.id === "string" && msg.id.length <= 64) HANDLERS[msg.type]?.(msg);
	},
	// Leaving the room: stop everything; unfinished files in private storage stay for a later visit
	clear() {
		outgoing.forEach(halt);
		outgoing.length = 0;
		for (const t of incoming.values()) (t.sink?.release ?? t.sink?.abort)?.().catch(() => {});
		incoming.clear();
		unsaved.clear();
		finished.clear();
		inbound = null;
		// Finished files offered for Save go too (the links are gone with the chat); files waiting to be
		// saved to a picked place stay until then, or a day
		delivered.forEach(part => folder().then(dir => dir.removeEntry(part)).catch(() => {}));
		delivered.clear();
	},
});
