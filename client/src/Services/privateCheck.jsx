import peer from "./peer";
import { registerProof } from "./chat";
import { cleanHash, fromText, secretBytes, toText } from "./roomSecret";

// Proves that nobody sits between the two browsers, with no work for the people in the call.
//
// The browsers swap their key fingerprints through our signaling server, so a dishonest server could swap them
// and sit in the middle. Each side therefore reads the certificates DTLS really uses (getStats) and sends, on the
// chat channel, { type: "proof", v: 1, tag }: an HMAC-SHA-256, keyed with the secret in the room link, over
// [label, room, sender's fingerprint, receiver's fingerprint]. A middleman has other certificates and no secret,
// so he cannot make a tag that fits; the order of the two fingerprints means a tag cannot be sent back to its maker.
//
// verified: a valid tag for the certificates in use now. failed: a tag arrived and is wrong.
// private: anything else (no secret, no tag, or a browser that does not report certificates). Never green without proof.

const LABEL = "sharethings/private-check/v1";
const HEX_LENGTH = { "sha-256": 64, "sha-384": 96, "sha-512": 128 }; // only strong fingerprints count
const TAG_BYTES = 32;
const FAST = 500; // ms between looks until the certificates are known
const FAST_TRIES = 12;
const POLL = 3000; // afterwards: a restart relayed by the server must not be able to swap them unnoticed
const NO_TAG_AFTER = 8000; // until then a missing tag is "checking", not "no proof"
const MAX_TAGS = 8; // per connection and certificates: both honest sides send one

const START = { status: "private", reason: "waiting", encrypted: false, relay: undefined };
let state = START;
const listeners = new Set();
const publish = patch => {
	const next = { ...state, ...patch };
	if (Object.keys(next).every(k => next[k] === state[k])) return;
	state = next;
	listeners.forEach(listener => listener());
};
export const subscribe = listener => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
export const getState = () => state;

let room = null;
let hash = "";
let keyReady = Promise.resolve(null);
let check = null; // the current connection's check

// From the room page: this room and the "#" part of its link
export const setPrivateRoom = (roomId, linkHash) => {
	const clean = cleanHash(linkHash);
	if (roomId === room && clean === hash) return;
	room = roomId;
	hash = clean;
	const secret = secretBytes(clean);
	keyReady = secret && crypto.subtle
		? crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]).catch(() => null)
		: Promise.resolve(null);
	if (check) {
		Object.assign(check, { id: null, tag: null, fresh: false, sent: false, failed: false, tags: 0 });
		refresh(check);
	}
};
// To carry the secret along when leaving for the Rejoin page
export const privateHash = () => hash;

const fingerprint = cert => {
	const algorithm = cert?.fingerprintAlgorithm?.toLowerCase();
	const hex = cert?.fingerprint?.replace(/:/g, "").toLowerCase();
	return hex && hex.length === HEX_LENGTH[algorithm] && /^[0-9a-f]+$/.test(hex) ? `${algorithm}:${hex}` : null;
};

// What the browser measures. certs only when every transport is up and all use one and the same pair of certificates
const readConnection = async pc => {
	const report = await pc.getStats();
	const pairs = new Map();
	let complete = true, dtls = false, route, flagged;
	report.forEach(s => {
		if (s.type === "candidate-pair" && s.selected) flagged = s; // Firefox has no transport stats
		if (s.type !== "transport") return;
		if (s.selectedCandidatePairId) route = report.get(s.selectedCandidatePairId);
		if (s.dtlsState === "connected") dtls = true;
		const local = fingerprint(report.get(s.localCertificateId)), remote = fingerprint(report.get(s.remoteCertificateId));
		if (s.dtlsState === "connected" && local && remote) pairs.set(`${local} ${remote}`, { local, remote });
		else complete = false;
	});
	route ??= flagged;
	return {
		certs: complete && pairs.size === 1 ? [...pairs.values()][0] : null,
		id: complete && pairs.size === 1 ? [...pairs.keys()][0] : null,
		encrypted: dtls || pc.sctp?.transport?.state === "connected",
		relay: route ? [route.localCandidateId, route.remoteCandidateId].some(id => report.get(id)?.candidateType === "relay") : undefined,
	};
};

const signed = (from, to) => new TextEncoder().encode(JSON.stringify([LABEL, room, from, to]));

const sync = async c => {
	const usedHash = hash;
	const stale = () => check !== c || usedHash !== hash; // the connection or the link changed while waiting
	if (check !== c) return;
	const now = await readConnection(c.pc).catch(() => null);
	const key = await keyReady;
	if (stale()) return;
	const measured = { encrypted: !!now?.encrypted, relay: now?.relay };
	if (!hash) return publish({ ...measured, status: "private", reason: "no-link" });
	if (!key) return publish({ ...measured, status: "private", reason: "no-stats" });
	if (!now?.id) return publish({ ...measured, status: "private", reason: c.id || c.tries++ < FAST_TRIES ? "waiting" : "no-stats" });

	if (now.id !== c.id) {
		// Other certificates than before on this connection: nothing is proven for them yet
		Object.assign(c, { id: now.id, sent: false, failed: false, tags: 0 });
		if (!c.fresh) c.tag = null;
	}
	if (!c.sent) {
		const tag = await crypto.subtle.sign("HMAC", key, signed(now.certs.local, now.certs.remote));
		if (stale() || c.id !== now.id) return;
		if (c.link.chat.readyState === "open") {
			c.link.chat.send(JSON.stringify({ type: "proof", v: 1, tag: toText(new Uint8Array(tag)) }));
			c.sent = true;
		}
	}
	if (c.failed) {
		c.fresh = false; // what arrives after a wrong tag cannot turn it green
		return publish({ ...measured, status: "failed", reason: "wrong" });
	}
	if (c.tag === null) return publish({ ...measured, status: "private", reason: Date.now() - c.since < NO_TAG_AFTER ? "waiting" : "no-proof" });

	const tag = fromText(c.tag, TAG_BYTES);
	const valid = !!tag && await crypto.subtle.verify("HMAC", key, tag, signed(now.certs.remote, now.certs.local));
	if (stale() || c.id !== now.id) return;
	c.fresh = false;
	if (!valid) c.failed = true;
	publish({ ...measured, status: valid ? "verified" : "failed", reason: valid ? "proven" : "wrong" });
};

// One look at a time, in order
const refresh = c => (c.queue = c.queue.then(() => sync(c)).catch(e => console.error("Private check failed", e)));

const stop = () => {
	check?.stop();
	check = null;
};

registerProof({
	// Both sides said hello on a connection: a new connection always starts unproven
	up(link) {
		stop();
		publish(START);
		if (link.chat !== peer.chat) return;
		const pc = peer.peer;
		const c = { link, pc, since: Date.now(), id: null, tag: null, fresh: false, sent: false, failed: false, tags: 0, tries: 0, queue: Promise.resolve() };
		const wake = () => refresh(c);
		const dtls = pc.sctp?.transport;
		pc.addEventListener("connectionstatechange", wake);
		dtls?.addEventListener("statechange", wake);
		let timer;
		const tick = () => {
			timer = setTimeout(async () => {
				await refresh(c);
				if (check === c) tick();
			}, hash && !c.id && c.tries < FAST_TRIES ? FAST : POLL);
		};
		c.stop = () => {
			clearTimeout(timer);
			pc.removeEventListener("connectionstatechange", wake);
			dtls?.removeEventListener("statechange", wake);
		};
		check = c;
		wake();
		tick();
	},
	down(link) {
		if (check?.link !== link) return;
		stop();
		publish(START);
	},
	message(link, msg) {
		const c = check;
		if (c?.link !== link || msg.v !== 1 || c.tags >= MAX_TAGS) return;
		c.tags++;
		c.tag = typeof msg.tag === "string" ? msg.tag : "";
		c.fresh = true;
		refresh(c);
	},
});
