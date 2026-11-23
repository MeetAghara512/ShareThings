// Adaptive video quality, on top of what WebRTC already adapts by itself:
// - send only what the other screen needs: each side reports how large it shows the other's camera and screen
//   (CSS size × devicePixelRatio), and the sender caps that lane's resolution and bitrate to it
// - keep the call alive on a very weak network: Poor for ~10 s → camera at a floor; still failing ~10 s more →
//   camera video paused (audio never touched); back step by step after ~10 s of Good each
// - a setting: Auto, High (no size cap, still bandwidth-adaptive), Data saver (camera 360p / 300 kbps, screen 1 Mbps)
// All through RTCRtpSender.setParameters and replaceTrack on the existing lanes: no renegotiation.
import { useCallback, useEffect, useRef, useState } from "react";
import peer from "./peer";

export const MODES = { auto: "Auto", high: "High", saver: "Data saver" };
const MODE_KEY = "sharethings.quality";

// Caps; the strictest one wins. height: at most this tall; scale: at least this much smaller; kbps: at most this bitrate
const HD_KBPS = 2500; // Chrome's own ceiling for 720p; never asked above it
const SHARING = { scale: 2, kbps: 150 }; // our camera while we share the screen
const FLOOR = { height: 180, kbps: 150 }; // a weak network
const SAVER_CAMERA = { height: 360, kbps: 300 };
const SAVER_SCREEN = { kbps: 1000 };
const STEP = 5; // stats polls (every 2 s) in a row before stepping down or up: about 10 s

// A bitrate that suits a picture shown this large (2.5 Mbps for 1280x720, in proportion below, at least 150 kbps)
const kbpsFor = ({ width, height }) => Math.min(HD_KBPS, Math.max(150, Math.round((width * height) / (1280 * 720) * HD_KBPS)));

// Encoding for a track under the given caps
const encodingFor = (track, caps) => {
	const height = track?.getSettings().height || 720;
	let scale = 1, kbps = Infinity;
	for (const cap of caps) {
		if (cap.scale) scale = Math.max(scale, cap.scale);
		if (cap.height) scale = Math.max(scale, height / cap.height);
		if (cap.kbps) kbps = Math.min(kbps, cap.kbps);
	}
	return { scaleResolutionDownBy: Math.round(scale * 100) / 100, maxBitrate: kbps === Infinity ? undefined : kbps * 1000 };
};

// Changes a sender's first encoding (and how it degrades), only when something differs
const setEncoding = async (sender, encoding, degradationPreference) => {
	const params = sender.getParameters();
	const [current] = params.encodings || [];
	if (!current) return;
	if (current.scaleResolutionDownBy === encoding.scaleResolutionDownBy && current.maxBitrate === encoding.maxBitrate && params.degradationPreference === degradationPreference) return;
	Object.assign(current, encoding);
	params.degradationPreference = degradationPreference;
	await sender.setParameters(params).catch(e => console.error("Video quality could not be set", e));
};

// How large a video element shows its picture, in device pixels (object-fit taken into account)
const shownSize = video => {
	const box = video.getBoundingClientRect();
	if (!box.width || !box.height) return null;
	const { videoWidth: w, videoHeight: h } = video;
	const fit = !w || !h ? 1 : (getComputedStyle(video).objectFit === "cover" ? Math.max : Math.min)(box.width / w, box.height / h);
	return { width: Math.round((w ? w * fit : box.width) * devicePixelRatio), height: Math.round((h ? h * fit : box.height) * devicePixelRatio) };
};

export const useAdaptiveQuality = ({ socket, remoteSocketId, callStart, remoteStream, remoteScreen, layout, cameraTrack, cameraOn, isScreen }) => {
	const [mode, setModeState] = useState(() => {
		try { return MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : "auto"; } catch { return "auto"; }
	});
	const [level, setLevel] = useState(0); // 0 full, 1 floor, 2 camera paused
	const peerView = useRef(null); // { camera, screen, mode } from the other side
	const runs = useRef({ bad: 0, failing: 0, good: 0, sent: null });
	const queue = useRef(Promise.resolve());

	const setMode = useCallback(next => {
		setModeState(next);
		try { localStorage.setItem(MODE_KEY, next); } catch {}
	}, []);

	// Every cap that applies now, onto the camera and screen lanes
	const apply = useCallback(() => {
		const camera = peer.lane("video")?.sender, screen = peer.screenSlot()?.sender;
		const view = peerView.current;
		const sized = mode !== "high" && view?.mode !== "high";
		const saver = mode === "saver" || view?.mode === "saver";
		queue.current = queue.current.then(async () => {
			if (camera) {
				const want = level === 2 ? null : cameraTrack ?? null;
				if (camera.track !== want) await camera.replaceTrack(want).catch(() => {});
				const caps = [
					sized && view?.camera && { height: view.camera.height, kbps: kbpsFor(view.camera) },
					isScreen && SHARING,
					saver && SAVER_CAMERA,
					level >= 1 && FLOOR,
				].filter(Boolean);
				await setEncoding(camera, encodingFor(cameraTrack, caps), "maintain-framerate");
			}
			if (screen?.track) {
				const caps = [sized && view?.screen && { height: view.screen.height, kbps: kbpsFor(view.screen) }, saver && SAVER_SCREEN].filter(Boolean);
				await setEncoding(screen, encodingFor(screen.track, caps), "maintain-resolution");
			}
		});
	}, [mode, level, cameraTrack, isScreen]);

	useEffect(() => {
		if (callStart) apply();
	}, [callStart, apply]);

	// A new person starts at full quality with no size known yet
	useEffect(() => {
		peerView.current = null;
		runs.current = { bad: 0, failing: 0, good: 0, sent: null };
		setLevel(0);
	}, [remoteSocketId]);

	// The other side's sizes
	useEffect(() => {
		const onView = ({ from, camera, screen, mode }) => {
			if (from !== remoteSocketId) return;
			peerView.current = { camera, screen, mode };
			apply();
		};
		socket.on("view:size", onView);
		return () => socket.off("view:size", onView);
	}, [socket, remoteSocketId, apply]);

	// Ours: how large their camera and screen are shown here, sent when it changes (debounced)
	useEffect(() => {
		if (!callStart || !remoteSocketId) return;
		let timer, last = "";
		const measure = () => {
			const shown = stream => {
				const video = stream && [...document.querySelectorAll("main video")].find(v => v.srcObject === stream);
				return video ? shownSize(video) : null;
			};
			const view = { camera: shown(remoteStream), screen: shown(remoteScreen), mode };
			const key = JSON.stringify(view);
			if (key === last) return;
			last = key;
			socket.emit("view:size", { to: remoteSocketId, ...view });
		};
		const later = () => {
			clearTimeout(timer);
			timer = setTimeout(measure, 400);
		};
		later();
		const resized = new ResizeObserver(later);
		document.querySelectorAll("main, main video").forEach(el => resized.observe(el));
		// The picture's own size can change too (its first frames, a lower resolution): measure again now and then
		const again = setInterval(later, 5000);
		return () => {
			clearTimeout(timer);
			clearInterval(again);
			resized.disconnect();
		};
	}, [socket, remoteSocketId, callStart, remoteStream, remoteScreen, layout, mode]);

	// Fed by CallStatus's stats poll (every 2 s): step the camera down on a weak network, back up when it is good.
	// Only what we send counts: loss on the video we receive is the other person's upload, not ours
	const onStats = useCallback(({ rtt, sentLoss, sentBytes, at }) => {
		const r = runs.current;
		const cameraMid = peer.lane("video")?.mid;
		const bytes = sentBytes[cameraMid];
		const kbps = r.sent && bytes !== undefined ? ((bytes - r.sent.bytes) * 8) / (at - r.sent.at) : null;
		r.sent = bytes !== undefined ? { bytes, at } : null;
		const bad = rtt >= 0.4 || sentLoss >= 0.1;
		const failing = sentLoss >= 0.25 || (level < 2 && cameraOn && kbps !== null && kbps < 20);
		const good = rtt < 0.15 && sentLoss < 0.02;
		r.bad = bad ? r.bad + 1 : 0;
		r.failing = failing ? r.failing + 1 : 0;
		r.good = good ? r.good + 1 : 0;
		const step = next => {
			Object.assign(r, { bad: 0, failing: 0, good: 0 });
			setLevel(next);
		};
		if (level === 0 && r.bad >= STEP) step(1);
		else if (level === 1 && r.failing >= STEP) step(2);
		else if (level > 0 && r.good >= STEP) step(level - 1);
	}, [level, cameraOn]);

	return { mode, setMode, paused: level === 2, onStats };
};
