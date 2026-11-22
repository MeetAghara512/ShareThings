// A random id for this browser tab, sent when joining a room so the server can give the tab its seat back
// after a dropped connection. It lasts as long as the tab (a reload keeps it); the other person never sees it
const KEY = "sharethings.clientId";

const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");

const save = value => {
	try {
		sessionStorage.setItem(KEY, value);
	} catch {
		// storage blocked: still works, until a reload
	}
	return value;
};

let id = (() => {
	try {
		return sessionStorage.getItem(KEY);
	} catch {
		return null;
	}
})() || save(fresh());

// A new id, so this tab no longer claims the seat of another tab with the same one
export const renewClientId = () => (id = save(fresh()));

// "Duplicate tab" copies sessionStorage, so the copy starts with the original's id and would take over its
// seat. Each tab says hello when it opens; a tab told its id is already in use takes a new one
try {
	const tabs = new BroadcastChannel(KEY);
	tabs.onmessage = ({ data }) => {
		if (data?.id !== id) return;
		if (data.type === "hello") tabs.postMessage({ type: "taken", id });
		else if (data.type === "taken") renewClientId();
	};
	tabs.postMessage({ type: "hello", id });
} catch {
	// No BroadcastChannel: a copied tab can take the seat, and the original is told so (Room.jsx)
}

const clientId = () => id;
export default clientId;
