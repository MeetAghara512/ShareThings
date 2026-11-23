// "<name> joined your call" while this tab is in the background: a notification and a short, soft chime.
// Only after the person allowed notifications from the "Notify me" button; nothing at all if they said no
let audio = null;

// Android Chrome has Notification, but its constructor always throws a TypeError. Data that cannot be stored makes
// the other browsers refuse with a different error before anything is shown
const pageCanNotify = () => {
	if (typeof Notification === "undefined") return false;
	try {
		new Notification("", { data: () => {} }).close();
	} catch (e) {
		return e.name !== "TypeError";
	}
	return true;
};
let canNotify;

export const notifyPermission = () => ((canNotify ??= pageCanNotify()) ? Notification.permission : "denied");

// From a click: ask once, and get the sound ready while the click allows audio
export const allowJoinNotice = async () => {
	try {
		audio ??= new AudioContext();
		audio.resume().catch(() => {});
	} catch {}
	return Notification.requestPermission();
};

// Two quiet sine notes, rising
const chime = () => {
	audio ??= new AudioContext();
	audio.resume().catch(() => {});
	const now = audio.currentTime;
	for (const [frequency, at] of [[660, 0], [880, 0.16]]) {
		const tone = audio.createOscillator();
		const volume = audio.createGain();
		tone.type = "sine";
		tone.frequency.value = frequency;
		volume.gain.setValueAtTime(0, now + at);
		volume.gain.linearRampToValueAtTime(0.08, now + at + 0.02);
		volume.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
		tone.connect(volume).connect(audio.destination);
		tone.start(now + at);
		tone.stop(now + at + 0.4);
	}
};

export const noticeJoin = (name, what = "joined your call") => {
	// Android Chrome cannot show a page notification: whoever allowed them still gets the chime
	if (!document.hidden || globalThis.Notification?.permission !== "granted") return;
	try {
		chime();
		if (notifyPermission() !== "granted") return;
		const notice = new Notification(`${name || "Someone"} ${what}`, { icon: "/icon.svg", tag: "sharethings-join" });
		notice.onclick = () => {
			window.focus();
			notice.close();
		};
	} catch (e) {
		console.error("Join notification failed", e);
	}
};
