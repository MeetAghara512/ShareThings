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

// The part of a link worth keeping: a well-formed secret, or nothing
export const cleanHash = hash => {
	const secret = new URLSearchParams((hash || "").slice(1)).get("k");
	return fromText(secret, SECRET_BYTES) ? `#k=${secret}` : "";
};

export const secretBytes = hash => fromText(cleanHash(hash).slice(3), SECRET_BYTES);
