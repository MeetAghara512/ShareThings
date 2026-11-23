import { add, bump, chatLink, getPeerName, getState, registerClip } from "./chat";
import * as files from "./files";

// Shared clipboard, over the call's chat channel. The clipboard is only ever read when the person presses the
// button or pastes into the message box, and nothing leaves until they press Send on the preview.
//
//   { type: "clip", kind: "text", text }
//   { type: "clip", kind: "image", id, part, parts, data }   base64, in order, 12000 characters a part
//
// What arrives is untrusted: text is shown as text, a link only if it is a plain http(s) address, and an image
// only if its first bytes are PNG, JPEG, GIF or WebP (never SVG, never the type the sender claims), within the limits.

export const MAX_CLIP_TEXT = 8000;
const MAX_MESSAGE = 16000; // what the chat channel's reader accepts, with room to spare
const MAX_IMAGE = 2 * 1024 * 1024; // larger images go through the normal file transfer
const MAX_PIXELS = 16000000;
const MAX_IMAGES = 20; // received per call: each stays in memory until leaving the room
const PART = 12000; // a multiple of 4, so every part is valid base64 by itself
const MAX_PARTS = Math.ceil((MAX_IMAGE * 4) / 3 / PART);
const HIGH_WATER = 256 * 1024; // the call and other messages keep priority
const RATE = { count: 5, per: 3000 };
const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_TYPES = Object.keys(EXTENSION);

export const extensionOf = type => EXTENSION[type] || "img";

const withinRate = times => {
	const now = Date.now();
	while (times.length && now - times[0] >= RATE.per) times.shift();
	if (times.length >= RATE.count) return false;
	times.push(now);
	return true;
};
const sentTimes = [];
const receivedTimes = [];

// No control or direction-changing characters: they could make text read differently than it is
const clean = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();

// The address if the whole text is one plain http(s) link. With a user name in it (https://bank.com@evil.com) it stays text
export const linkOf = text => {
	if (/\s/.test(text)) return null;
	try {
		const url = new URL(text);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
};

const imageType = b => {
	const at = (start, ...values) => values.every((v, i) => b[start + i] === v);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return null;
};

// Reads only the size first, so a tiny file that unpacks to a giant picture is never put on screen
const fitsOnScreen = src => new Promise(resolve => {
	const image = new Image();
	image.onload = () => resolve(image.naturalWidth > 0 && image.naturalWidth * image.naturalHeight <= MAX_PIXELS);
	image.onerror = () => resolve(false);
	image.src = src;
});

const asBase64 = blob => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).split(",")[1]);
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
});

const failed = text => ({ kind: "error", text });

const pendingText = text => {
	const value = clean(text);
	if (!value) return failed("There is no text or image on your clipboard.");
	if (value.length > MAX_CLIP_TEXT) return failed(`That text is too long to share here (limit ${MAX_CLIP_TEXT} characters).`);
	return { kind: "text", text: value };
};

const pendingImage = async blob => {
	const type = imageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
	if (!type) return failed("Only PNG, JPEG, GIF and WebP images can be shared this way.");
	const name = `clipboard-image.${EXTENSION[type]}`;
	if (blob.size > MAX_IMAGE) return { kind: "large", file: new File([blob], name, { type }), name };
	const data = await asBase64(blob);
	const src = `data:${type};base64,${data}`;
	if (!(await fitsOnScreen(src))) return failed("That image is too large to show.");
	return { kind: "image", type, src, data };
};

// Only from the button's click: the browser may ask for permission
export const readClipboard = async () => {
	try {
		if (navigator.clipboard?.read) {
			for (const item of await navigator.clipboard.read()) {
				const type = item.types.find(t => IMAGE_TYPES.includes(t));
				if (type) return await pendingImage(await item.getType(type));
				if (item.types.includes("text/plain")) return pendingText(await (await item.getType("text/plain")).text());
			}
			return failed("There is no text or image on your clipboard.");
		}
		if (navigator.clipboard?.readText) return pendingText(await navigator.clipboard.readText());
	} catch (e) {
		console.error("Clipboard not read", e);
	}
	return failed("Your browser did not allow reading the clipboard. Paste into the message box instead.");
};

// Pasting into the message box: text goes in the box as usual, an image gets a preview. Null when it is not an image
export const fromPaste = data => {
	if (data?.types?.includes("text/plain")) return null;
	const image = [...(data?.files || [])].find(f => IMAGE_TYPES.includes(f.type));
	return image ? pendingImage(image).catch(() => failed("That image could not be read.")) : null;
};

let sendingImage = false;

const sendImage = async (link, { data }) => {
	const id = crypto.randomUUID();
	const parts = Math.ceil(data.length / PART);
	for (let part = 0; part < parts; part++) {
		while (link.chat.bufferedAmount > HIGH_WATER) {
			await new Promise(resolve => setTimeout(resolve, 20));
			if (chatLink() !== link) return false;
		}
		if (chatLink() !== link) return false;
		link.chat.send(JSON.stringify({ type: "clip", kind: "image", id, part, parts, data: data.slice(part * PART, (part + 1) * PART) }));
	}
	return true;
};

// The person pressed Send on the preview. Returns an error to show, or null
export const sendPending = async pending => {
	const link = chatLink();
	if (!link) return failed("Not connected to the other person.");
	if (pending.kind === "large") {
		files.sendFiles([pending.file]); // the normal file flow, with its Accept rule
		return null;
	}
	if (pending.kind === "image" && sendingImage) return { ...pending, note: "Still sending the previous image." };
	if (!withinRate(sentTimes)) return { ...pending, note: "Wait a moment before sharing again." };
	try {
		if (pending.kind === "text") {
			const message = JSON.stringify({ type: "clip", kind: "text", text: pending.text });
			if (message.length > MAX_MESSAGE) return failed("That text is too long to share here.");
			link.chat.send(message);
			add({ kind: "clip", clip: "text", mine: true, text: pending.text });
		} else {
			sendingImage = true; // its parts must not mix with another image's
			if (!(await sendImage(link, pending))) return failed("The connection changed. Try again.");
			add({ kind: "clip", clip: "image", mine: true, src: pending.src, type: pending.type });
		}
	} catch (e) {
		console.error("Clipboard not sent", e);
		return failed("Could not send it. Try again.");
	} finally {
		if (pending.kind === "image") sendingImage = false;
	}
	return null;
};

// Receiving
let incoming = null; // the image arriving now
const imagesShown = () => getState().items.filter(item => item.clip === "image" && !item.mine).length;

const receiveImage = async (link, { id, part, parts, data }) => {
	const valid = typeof id === "string" && id.length <= 36 && Number.isInteger(part) && Number.isInteger(parts) &&
		parts >= 1 && parts <= MAX_PARTS && part >= 0 && part < parts && typeof data === "string";
	if (!valid) return void (incoming = null);
	if (part === 0) incoming = imagesShown() < MAX_IMAGES && withinRate(receivedTimes) ? { link, id, parts, chunks: [], bytes: 0 } : null;
	const t = incoming;
	if (t?.link !== link || t.id !== id || t.parts !== parts || t.chunks.length !== part) return void (incoming = null);
	const last = part === parts - 1;
	const wellFormed = data.length > 0 && data.length % 4 === 0 && data.length <= PART && (last || data.length === PART) &&
		(last ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(data);
	t.bytes += (data.length / 4) * 3 - (data.match(/=+$/)?.[0].length || 0);
	if (!wellFormed || t.bytes > MAX_IMAGE) return void (incoming = null);
	t.chunks.push(data);
	if (!last) return;
	incoming = null;
	const type = imageType(Uint8Array.from(atob(t.chunks[0].slice(0, 32)), c => c.charCodeAt(0)));
	const src = type && `data:${type};base64,${t.chunks.join("")}`;
	const name = getPeerName();
	if (!src || !(await fitsOnScreen(src))) return void add({ kind: "note", text: `An image from ${name || "the other person"} could not be shown` });
	if (chatLink() !== link) return;
	add({ kind: "clip", clip: "image", mine: false, name, src, type });
	bump();
};

registerClip({
	message(link, msg) {
		if (msg.kind === "image") return void receiveImage(link, msg);
		if (msg.kind !== "text" || typeof msg.text !== "string" || msg.text.length > MAX_CLIP_TEXT) return;
		const text = clean(msg.text);
		if (!text || !withinRate(receivedTimes)) return;
		add({ kind: "clip", clip: "text", mine: false, name: getPeerName(), text });
		bump();
	},
});
