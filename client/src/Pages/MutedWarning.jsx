import React, { useEffect, useState } from "react";
import { MdMicOff } from "react-icons/md";

const TICK = 50; // ms between level checks
const LOUD = 0.15; // on the join screen's meter scale (0-1): clearly above room noise
const HOLD = 400; // speech has short gaps: count this long after each loud moment as talking...
const RESET = 800; // ...and start over after this much quiet
const SPEECH_FOR = 1000; // talking this long while muted shows the reminder
const SHOW_FOR = 4000;
const AT_MOST_EVERY = 20000;
let lastShown = -Infinity; // for the whole page, so muting again does not bring it back sooner

// Talking while muted: after about a second of speech, a short reminder. The level is read from a copy of the
// mic track that stays enabled (the same level formula as the join screen's meter); the real track stays
// muted, so nothing reaches the other person
const MutedWarning = ({ stream, muted, hint = "press the mic button to unmute" }) => {
	const [shown, setShown] = useState(false);
	const track = muted ? stream?.getAudioTracks()[0] : null;

	useEffect(() => {
		setShown(false);
		if (!track || track.readyState !== "live") return;
		const copy = track.clone();
		copy.enabled = true;
		const ctx = new AudioContext();
		ctx.resume().catch(() => {});
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 2048; // about one tick of sound per read
		ctx.createMediaStreamSource(new MediaStream([copy])).connect(analyser);
		const data = new Uint8Array(analyser.fftSize);
		let talking = 0, lastLoud = -Infinity, hide = null;
		const id = setInterval(() => {
			analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (const v of data) sum += (v - 128) ** 2;
			const level = Math.min(1, (Math.sqrt(sum / data.length) / 128) * 4);
			const now = performance.now();
			if (level > LOUD) lastLoud = now;
			if (now - lastLoud < HOLD) talking += TICK;
			else if (now - lastLoud > RESET) talking = 0;
			if (talking >= SPEECH_FOR && Date.now() - lastShown >= AT_MOST_EVERY) {
				lastShown = Date.now();
				talking = 0;
				setShown(true);
				hide = setTimeout(() => setShown(false), SHOW_FOR);
			}
		}, TICK);
		return () => {
			clearInterval(id);
			clearTimeout(hide);
			copy.stop();
			ctx.close();
		};
	}, [track]);

	if (!shown) return null;
	return (
		<div role="status" className="w-max max-w-full px-4 py-2 rounded-full bg-black/80 text-white text-sm shadow-lg flex items-center gap-2">
			<MdMicOff className="shrink-0 text-lg text-red-400" />
			<span>You're muted — {hint}</span>
		</div>
	);
};

export default MutedWarning;
