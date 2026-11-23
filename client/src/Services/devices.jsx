// Camera and mic. Browsers ignore a deviceId that is not "exact", so a saved device is asked for
// exactly, and the default is used when it is gone. Without a size the camera opens at 640x480, so it
// is asked for HD; only as "ideal", so a weaker camera still opens at the best it can do
const HD = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const any = kind => (kind === "video" ? HD : true);
const pick = (listed, id, kind) => (id && (!listed.some(Boolean) || listed.includes(id)) ? { ...(kind === "video" && HD), deviceId: { exact: id } } : any(kind));
const listed = async kind => (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(d => !kind || d.kind === kind + "input").map(d => d.deviceId);

// One device on its own: "audio" or "video". Resolves to its track
export const openDevice = async (kind, id) => {
	const want = pick(await listed(kind), id, kind);
	try {
		return (await navigator.mediaDevices.getUserMedia({ [kind]: want })).getTracks()[0];
	} catch (e) {
		if (want === any(kind) || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
		return (await navigator.mediaDevices.getUserMedia({ [kind]: any(kind) })).getTracks()[0];
	}
};

// What the site may do with a device: "granted", "denied", "prompt", or null where the browser does not say
export const permission = async kind => {
	try {
		return (await navigator.permissions.query({ name: kind === "video" ? "camera" : "microphone" })).state;
	} catch {
		return null;
	}
};

// Why a device does not work: blocked (by the browser), system (by the computer's settings), busy (in use
// by another app) or missing
export const troubleOf = e =>
	e?.name === "NotAllowedError" || e?.name === "SecurityError" ? (/system/i.test(e.message) ? "system" : "blocked") :
	e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "missing" : "busy";

// Camera and mic, asked together first (one permission prompt), then one by one if that fails, so a
// blocked or missing camera never takes the mic down with it. Resolves to the stream of what works
// (maybe empty) and each kind's trouble. After a refusal no device is asked again by itself unless
// the refusal is explained (another device is blocked, or the computer blocks it): a dismissed prompt
// is never shown twice
export const openEach = async (videoId, audioId, off = {}) => { // off: devices turned off, which are not opened
	const ids = { video: videoId, audio: audioId };
	try {
		const all = await listed();
		return { stream: await navigator.mediaDevices.getUserMedia({ video: !off.video && pick(all, videoId, "video"), audio: !off.audio && pick(all, audioId, "audio") }), trouble: {} };
	} catch (e) {
		const states = { video: await permission("video"), audio: await permission("audio") };
		const refused = troubleOf(e) === "blocked" && !Object.values(states).includes("denied");
		const tracks = [], trouble = {};
		for (const kind of ["audio", "video"]) {
			if (off[kind]) continue;
			if (states[kind] === "denied" || (refused && states[kind] !== "granted")) {
				trouble[kind] = "blocked";
				continue;
			}
			try {
				tracks.push(await openDevice(kind, ids[kind]));
			} catch (err) {
				trouble[kind] = troubleOf(err);
			}
		}
		return { stream: new MediaStream(tracks), trouble };
	}
};

// Calls back when the site is allowed to use the device, e.g. after the user clicks Allow in the address bar
export const onGranted = (kind, callback) => {
	let status, gone = false;
	navigator.permissions?.query({ name: kind === "video" ? "camera" : "microphone" }).then(s => {
		if (gone) return;
		status = s;
		s.onchange = () => s.state === "granted" && callback();
	}).catch(() => {});
	return () => {
		gone = true;
		if (status) status.onchange = null;
	};
};

// The same, for code that wants a single stream: what works of camera and mic, or the error if nothing does
export const openDevices = async (videoId, audioId, off = {}) => {
	const { stream, trouble } = await openEach(videoId, audioId, off);
	if (!stream.getTracks().length && !off.video && !off.audio) throw new DOMException("No camera or microphone", trouble.video === "blocked" ? "NotAllowedError" : "NotFoundError");
	return stream;
};

// What is wrong, in a few words (also the red button's label)
export const troubleText = (kind, trouble) => {
	const device = kind === "video" ? "Camera" : "Microphone";
	return {
		blocked: `${device} is blocked`,
		system: `${device} is blocked by your computer`,
		busy: `${device} is in use by another app`,
		missing: `No ${device.toLowerCase()} found`,
		off: `${device} is off`,
	}[trouble];
};

// The fix to show for a device that does not work
export const HELP = {
	blocked: kind => `Click the ${kind === "video" ? "camera" : "microphone"} icon in the address bar → Allow → done.`,
	system: () => "Your computer blocks it: System Settings → Privacy & Security → Camera / Microphone → turn on your browser, then reload.",
	busy: kind => `Close other apps using the ${kind === "video" ? "camera" : "microphone"}, then try again.`,
	missing: kind => `No ${kind === "video" ? "camera" : "microphone"} found. Connect one, then try again.`,
	off: kind => `Press the ${kind === "video" ? "camera" : "microphone"} button to turn it back on.`,
};
