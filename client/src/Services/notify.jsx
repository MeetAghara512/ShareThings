// "<name> joined your call" while this tab is in the background: a notification and a short, soft chime.
// Only after the person allowed notifications from the "Notify me" button; nothing at all if they said no
let audio = null;

export const notifyPermission = () => (typeof Notification === "undefined" ? "denied" : Notification.permission);

// From a click: ask once, and get the sound ready while the click allows audio
export const allowJoinNotice = async () => {
	try {
		audio ??= new AudioContext();
		audio.resume();
	} catch {}
	return Notification.requestPermission();
};

// Two quiet sine notes, rising
const chime = () => {
	audio ??= new AudioContext();
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

export const noticeJoin = name => {
	if (!document.hidden || notifyPermission() !== "granted") return;
	try {
		chime();
		const notice = new Notification(`${name || "Someone"} joined your call`, { icon: "/icon.svg", tag: "sharethings-join" });
		notice.onclick = () => {
			window.focus();
			notice.close();
		};
	} catch (e) {
		console.error("Join notification failed", e);
	}
};
