// The secret in a room link, after the "#": /room/abc-defg-hij#k=<22 characters>. Browsers never send that
// part to a server, so ours never learns it. Only links made by Create Room have one; a typed code or an
// emailed invite (which passes through our server) does not, and such a call simply stays unproven.
const SECRET_BYTES = 16; // 128 bits

export const toText = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The bytes of a base64url text of exactly this size, or null (also for a non-canonical spelling of them)
export const fromText = (text, size) => {
	if (typeof text !== "string" || text.length > 64 || !/^[\w-]+$/.test(text)) return null;
	try {
		const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
		return bytes.length === size && toText(bytes) === text ? bytes : null;
	} catch {
		return null;
	}
};

export const newRoomHash = () => `#k=${toText(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))}`;

// A room made on a page that ran Google's script: that page only marks the link, and the fresh room page makes the
// secret before anything renders, so the script never sees it. A marker this tab did not set is dropped
const NEW_ROOM = "#new";
const NEW_ROOM_KEY = "sharethings.newRoom";

export const markNewRoom = path => {
	sessionStorage.setItem(NEW_ROOM_KEY, path);
	return path + NEW_ROOM;
};

export const finishNewRoom = () => {
	if (window.location.hash !== NEW_ROOM) return;
	const mine = sessionStorage.getItem(NEW_ROOM_KEY) === window.location.pathname;
	sessionStorage.removeItem(NEW_ROOM_KEY);
	window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (mine ? newRoomHash() : ""));
};

// The part of a link worth keeping: a well-formed secret, or nothing
export const cleanHash = hash => {
	const secret = new URLSearchParams((hash || "").slice(1)).get("k");
	return fromText(secret, SECRET_BYTES) ? `#k=${secret}` : "";
};

export const secretBytes = hash => fromText(cleanHash(hash).slice(3), SECRET_BYTES);
