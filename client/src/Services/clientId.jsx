// A random id for this browser tab, sent when joining a room so the server can give the tab its seat back
// after a dropped connection. It lasts as long as the tab (a reload keeps it); the other person never sees it
const KEY = "sharethings.clientId";

const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");

const load = () => {
	try {
		const saved = sessionStorage.getItem(KEY);
		if (saved) return saved;
		const id = fresh();
		sessionStorage.setItem(KEY, id);
		return id;
	} catch {
		return fresh(); // storage blocked: still works, until a reload
	}
};

export default load();
