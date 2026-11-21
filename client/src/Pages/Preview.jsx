import React, { useCallback, useEffect, useRef, useState } from "react";
import { FaVideo, FaVideoSlash, FaMicrophone, FaMicrophoneSlash, FaRedo } from "react-icons/fa";
import { openDevices } from "../Services/devices";
import clientId from "../Services/clientId";
import { useSocket } from "../useContext/SocketProvider";
import { useAuth } from "../useContext/AuthProvider";

// Devices picked and name used on this browser
const CAMERA_KEY = "sharethings.camera";
const MIC_KEY = "sharethings.mic";
const NAME_KEY = "sharethings.name";
// How often the join screen re-checks who is in the room
const PEEK_INTERVAL = 4000;

const whoIsHere = names =>
	names.length === 0 ? "No one else is here yet" :
	names.length === 1 ? `${names[0]} is in this call` :
	`${names.slice(0, -1).join(", ")} and ${names.at(-1)} are in this call`;

const describeError = e => {
	switch (e?.name) {
		case "NotAllowedError":
		case "SecurityError":
			return "Camera and microphone access is blocked. Allow it from the icon in your browser's address bar, then press Retry.";
		case "NotFoundError":
		case "OverconstrainedError":
			return "No camera or microphone was found. Connect one, then press Retry.";
		case "NotReadableError":
		case "AbortError":
			return "Your camera or microphone is busy or not working. Close other apps using it, or pick another device.";
		default:
			return "Could not start your camera and microphone. Press Retry.";
	}
};

// Check camera and mic before joining. Nothing is sent to the room until Join.
const Preview = ({ darkMode, roomId, onJoin }) => {
	const socket = useSocket();
	const { user } = useAuth();
	const [stream, setStream] = useState(null);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const [slow, setSlow] = useState(false); // still waiting for the permission prompt
	const [devices, setDevices] = useState({ video: [], audio: [] });
	const [videoId, setVideoId] = useState(() => localStorage.getItem(CAMERA_KEY) || "");
	const [audioId, setAudioId] = useState(() => localStorage.getItem(MIC_KEY) || "");
	const [cameraOff, setCameraOff] = useState(false);
	const [muted, setMuted] = useState(false);
	const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || user?.name || "");
	const [peek, setPeek] = useState(null); // { names, full } once known

	const streamRef = useRef(null);
	const requestRef = useRef(0); // only the latest camera request counts
	const handedOverRef = useRef(false);
	const meterRef = useRef(null);
	const audioCtxRef = useRef(null);

	// Labels (and real ids) only appear once access is granted
	const refreshDevices = useCallback(async () => {
		const list = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
		setDevices({
			video: list.filter(d => d.kind === "videoinput" && d.deviceId),
			audio: list.filter(d => d.kind === "audioinput" && d.deviceId),
		});
	}, []);

	const start = useCallback(async (video, audio) => {
		const request = ++requestRef.current;
		streamRef.current?.getTracks().forEach(t => t.stop());
		streamRef.current = null;
		setStream(null);
		setError(null);
		setLoading(true);
		try {
			if (!navigator.mediaDevices) throw new DOMException("Needs a secure page", "SecurityError");
			const s = await openDevices(video, audio);
			// Switched device, retried or left the page meanwhile: drop this one
			if (request !== requestRef.current) return s.getTracks().forEach(t => t.stop());
			streamRef.current = s;
			setStream(s);
			// Show the devices actually in use (a saved one that is gone falls back to the default)
			setVideoId(s.getVideoTracks()[0]?.getSettings().deviceId || "");
			setAudioId(s.getAudioTracks()[0]?.getSettings().deviceId || "");
		} catch (e) {
			if (request !== requestRef.current) return;
			console.error("Camera preview failed", e);
			setError(describeError(e));
		}
		setLoading(false);
		refreshDevices();
	}, [refreshDevices]);

	useEffect(() => {
		start(localStorage.getItem(CAMERA_KEY), localStorage.getItem(MIC_KEY));
		return () => {
			requestRef.current++; // a camera still opening is stopped when it arrives
			if (!handedOverRef.current) streamRef.current?.getTracks().forEach(t => t.stop());
		};
	}, [start]);

	useEffect(() => {
		const md = navigator.mediaDevices;
		md?.addEventListener("devicechange", refreshDevices);
		return () => md?.removeEventListener("devicechange", refreshDevices);
	}, [refreshDevices]);

	// The permission prompt may sit unanswered: offer Retry after a while instead of spinning forever
	useEffect(() => {
		setSlow(false);
		if (!loading) return;
		const id = setTimeout(() => setSlow(true), 10000);
		return () => clearTimeout(id);
	}, [loading]);

	useEffect(() => {
		stream?.getVideoTracks().forEach(t => t.enabled = !cameraOff);
	}, [stream, cameraOff]);
	useEffect(() => {
		stream?.getAudioTracks().forEach(t => t.enabled = !muted);
	}, [stream, muted]);

	// Mic level meter
	useEffect(() => {
		const track = stream?.getAudioTracks()[0];
		if (!track) return;
		const ctx = new AudioContext();
		audioCtxRef.current = ctx;
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 512;
		ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
		const data = new Uint8Array(analyser.fftSize);
		let frame;
		const draw = () => {
			analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (const v of data) sum += (v - 128) ** 2;
			const level = Math.min(1, (Math.sqrt(sum / data.length) / 128) * 4);
			if (meterRef.current) meterRef.current.style.width = `${Math.round(level * 100)}%`;
			frame = requestAnimationFrame(draw);
		};
		draw();
		return () => {
			cancelAnimationFrame(frame);
			audioCtxRef.current = null;
			ctx.close();
		};
	}, [stream]);

	// Signing in suggests the Google name, but never replaces what is already in the field
	const googleName = user?.name;
	useEffect(() => {
		if (googleName) setName(current => current || googleName);
	}, [googleName]);

	// Who is already in the room, kept fresh while this screen is open
	useEffect(() => {
		const check = () => socket.emit("room:peek", { room: roomId, clientId }, setPeek); // our own kept seat does not count
		check();
		const id = setInterval(check, PEEK_INTERVAL);
		return () => clearInterval(id);
	}, [socket, roomId]);

	const pickCamera = id => {
		localStorage.setItem(CAMERA_KEY, id);
		setVideoId(id);
		start(id, audioId);
	};
	const pickMic = id => {
		localStorage.setItem(MIC_KEY, id);
		setAudioId(id);
		start(videoId, id);
	};

	const displayName = name.trim();
	const canJoin = stream && displayName && !peek?.full;

	const handleJoin = e => {
		e.preventDefault();
		if (!canJoin) return;
		localStorage.setItem(CAMERA_KEY, videoId);
		localStorage.setItem(MIC_KEY, audioId);
		localStorage.setItem(NAME_KEY, displayName);
		handedOverRef.current = true;
		onJoin(streamRef.current, { videoId, audioId, cameraOff, muted, name: displayName });
	};

	// Round on/off buttons on the preview, red when off (like Google Meet)
	const toggleClass = off => `w-12 h-12 rounded-full flex items-center justify-center text-white shadow-md transition-colors ` +
		(off ? "bg-red-600 hover:bg-red-700" : "bg-gray-800/70 hover:bg-gray-700/80 border border-white/40");

	const selectClass = `w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ` +
		(darkMode ? "bg-gray-700 border-gray-600" : "bg-white border-gray-300");

	// Browsers may hold audio until the first click; any click on the preview wakes the meter up
	return (
		<div className="w-full max-w-4xl flex flex-col md:flex-row gap-6 items-center" onPointerDown={() => audioCtxRef.current?.resume()}>
			<div className="relative w-full md:w-3/5 aspect-video bg-black rounded-2xl overflow-hidden shadow-lg border-4 border-gray-700">
				{stream && (
					<video
						autoPlay
						muted
						playsInline
						className="w-full h-full object-cover"
						ref={(v) => v && v.srcObject !== stream && (v.srcObject = stream)}
					/>
				)}
				{stream && cameraOff && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
						<FaVideoSlash size={40} />
						<span>Camera is off</span>
					</div>
				)}
				{stream && (
					<div className="absolute bottom-4 inset-x-0 flex justify-center gap-4">
						<button
							type="button"
							onClick={() => setMuted(!muted)}
							aria-pressed={muted}
							aria-label={muted ? "Turn on microphone" : "Turn off microphone"}
							title={muted ? "Turn on microphone" : "Turn off microphone"}
							className={toggleClass(muted)}
						>
							{muted ? <FaMicrophoneSlash size={18} /> : <FaMicrophone size={18} />}
						</button>
						<button
							type="button"
							onClick={() => setCameraOff(!cameraOff)}
							aria-pressed={cameraOff}
							aria-label={cameraOff ? "Turn on camera" : "Turn off camera"}
							title={cameraOff ? "Turn on camera" : "Turn off camera"}
							className={toggleClass(cameraOff)}
						>
							{cameraOff ? <FaVideoSlash size={18} /> : <FaVideo size={18} />}
						</button>
					</div>
				)}
				{!stream && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
						{error ? <p className="text-red-300">{error}</p> : <p className="animate-pulse">Starting camera and microphone...</p>}
						{(error || slow) && (
							<button
								onClick={() => start(videoId, audioId)}
								className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-colors"
							>
								<FaRedo /> Retry
							</button>
						)}
					</div>
				)}
			</div>

			<form onSubmit={handleJoin} className={`w-full md:w-2/5 p-6 rounded-2xl shadow-lg space-y-4 ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"}`}>
				<div className="space-y-1">
					<h3 className="text-xl font-semibold">Ready to join?</h3>
					{peek && (
						<p className={`text-sm font-medium ${peek.full ? "text-red-500" : "text-indigo-400"}`}>
							{peek.full ? `${whoIsHere(peek.names)}. This room is full.` : whoIsHere(peek.names)}
						</p>
					)}
					<p className="text-sm opacity-60">No one in the room can see or hear you until you join.</p>
				</div>

				<label className="block space-y-1 text-sm">
					<span className="block font-medium">Your name</span>
					<input
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="Shown to the other person"
						required
						maxLength={40}
						autoComplete="name"
						className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ` +
							(darkMode ? "bg-gray-700 border-gray-600 placeholder-gray-400" : "bg-white border-gray-300 placeholder-gray-500")}
					/>
				</label>

				<div className="space-y-1 text-sm">
					<span className="block font-medium">Microphone level{muted && " (muted)"}</span>
					<div aria-label="Microphone level" className={`h-2 rounded-full overflow-hidden ${darkMode ? "bg-gray-600" : "bg-gray-200"}`}>
						<div ref={meterRef} className="h-full bg-green-500" style={{ width: "0%" }} />
					</div>
				</div>

				{devices.video.length > 0 && (
					<label className="block space-y-1 text-sm">
						<span className="block font-medium">Camera</span>
						<select value={videoId} onChange={e => pickCamera(e.target.value)} className={selectClass}>
							{devices.video.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
						</select>
					</label>
				)}
				{devices.audio.length > 0 && (
					<label className="block space-y-1 text-sm">
						<span className="block font-medium">Microphone</span>
						<select value={audioId} onChange={e => pickMic(e.target.value)} className={selectClass}>
							{devices.audio.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
						</select>
					</label>
				)}

				<button
					type="submit"
					disabled={!canJoin}
					className="w-full py-3 rounded-lg bg-indigo-600 text-white font-semibold transition-transform hover:bg-indigo-700 hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:bg-indigo-600"
				>
					Join now
				</button>
			</form>
		</div>
	);
};

export default Preview;
