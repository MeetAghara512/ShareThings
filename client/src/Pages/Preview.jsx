import React, { useCallback, useEffect, useRef, useState } from "react";
import { FaVideo, FaVideoSlash, FaMicrophone, FaMicrophoneSlash, FaRedo } from "react-icons/fa";
import { openDevice, openEach, onGranted, permission, troubleOf, troubleText } from "../Services/devices";
import clientId from "../Services/clientId";
import { DeviceHelp, TroubleMark } from "./ControlBar";
import { useSocket, useSocketStatus } from "../useContext/SocketProvider";
import { useAuth } from "../useContext/AuthProvider";
import ServerStatus from "./ServerStatus";
import NetworkCheck from "./NetworkCheck";
import { pickSpeaker, refreshSpeakers, useSpeaker } from "./Speaker";

// Devices picked and name used on this browser
const CAMERA_KEY = "sharethings.camera";
const MIC_KEY = "sharethings.mic";
const NAME_KEY = "sharethings.name";
// How often the join screen re-checks who is in the room
const PEEK_INTERVAL = 4000;

// Only how many: the server does not say who is in a room before you join
const whoIsHere = count =>
	count === 0 ? "No one else is here yet" :
	count === 1 ? "1 person is in this call" :
	`${count} people are in this call`;

// Check camera and mic before joining. Nothing is sent to the room until Join.
const Preview = ({ darkMode, roomId, onJoin }) => {
	const socket = useSocket();
	const { status } = useSocketStatus();
	const [joining, setJoining] = useState(false); // Join now pressed while the server is still waking up
	const { user } = useAuth();
	const [stream, setStream] = useState(null);
	const [trouble, setTrouble] = useState({}); // { audio, video }: why a device does not work
	const [help, setHelp] = useState(null); // the device whose fix is shown
	const [loading, setLoading] = useState(true);
	const [slow, setSlow] = useState(false); // still waiting for the permission prompt
	const [attempt, setAttempt] = useState(0); // each camera request (also Retry) gets its own wait
	const [devices, setDevices] = useState({ video: [], audio: [] });
	const [videoId, setVideoId] = useState(() => localStorage.getItem(CAMERA_KEY) || "");
	const [audioId, setAudioId] = useState(() => localStorage.getItem(MIC_KEY) || "");
	const { speakers, id: speakerId } = useSpeaker();
	const [cameraOff, setCameraOff] = useState(false);
	const [muted, setMuted] = useState(false);
	const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || user?.name || "");
	const [peek, setPeek] = useState(null); // { count, full } once known

	const streamRef = useRef(null);
	const troubleRef = useRef(trouble);
	troubleRef.current = trouble;
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
		refreshSpeakers();
	}, []);

	const start = useCallback(async (video, audio) => {
		const request = ++requestRef.current;
		streamRef.current?.getTracks().forEach(t => t.stop());
		streamRef.current = null;
		setStream(null);
		setTrouble({});
		setHelp(null);
		setLoading(true);
		setAttempt(a => a + 1);
		// Mic and camera each on their own terms: a blocked camera does not stop the mic (an insecure page has neither)
		const { stream: s, trouble } = navigator.mediaDevices ? await openEach(video, audio) : { stream: new MediaStream(), trouble: { audio: "blocked", video: "blocked" } };
		// Switched device, retried or left the page meanwhile: drop this one
		if (request !== requestRef.current) return s.getTracks().forEach(t => t.stop());
		streamRef.current = s;
		setStream(s);
		setTrouble(trouble);
		// Show the devices actually in use (a saved one that is gone falls back to the default)
		const [camera] = s.getVideoTracks(), [mic] = s.getAudioTracks();
		if (camera) setVideoId(camera.getSettings().deviceId || "");
		if (mic) setAudioId(mic.getSettings().deviceId || "");
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

	// A red button: ask again where the browser still can (the click allows the prompt), else show the fix
	const fixDevice = useCallback(async kind => {
		const request = requestRef.current;
		if (troubleRef.current[kind] === "system" || await permission(kind) === "denied") return setHelp(kind);
		try {
			const track = await openDevice(kind, kind === "video" ? videoId : audioId);
			if (request !== requestRef.current) return track.stop();
			const s = new MediaStream([...(streamRef.current?.getTracks() ?? []), track]);
			streamRef.current = s;
			setStream(s);
			setTrouble(t => ({ ...t, [kind]: null }));
			setHelp(null);
			refreshDevices();
		} catch (e) {
			if (request !== requestRef.current) return;
			setTrouble(t => ({ ...t, [kind]: troubleOf(e) }));
			setHelp(kind);
		}
	}, [videoId, audioId, refreshDevices]);

	// Allowed in the address bar meanwhile: the device starts by itself
	useEffect(() => {
		const stops = ["audio", "video"].map(kind => onGranted(kind, () => troubleRef.current[kind] && fixDevice(kind)));
		return () => stops.forEach(stop => stop());
	}, [fixDevice]);

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
	}, [loading, attempt]);

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
		// Our own kept seat does not count. Over the server's limit the answer is { limited: true }: keep showing the last one
		const check = () => socket.emit("room:peek", { room: roomId, clientId: clientId() }, answer => !answer?.limited && setPeek(answer));
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
	// Joins with whatever works, even nothing: then you watch and listen
	const canJoin = displayName && !peek?.full && !peek?.invalid;
	// Real cameras take 1-3 s to open. A permission prompt left unanswered (slow) does not hold the join
	const opening = loading && !slow;
	// A server from before this change still sends names: then only their number is used
	const here = peek && whoIsHere(peek.count ?? peek.names?.length ?? 0);
	const without = ["video", "audio"].filter(kind => trouble[kind]);

	const handleJoin = e => {
		e?.preventDefault();
		if (!canJoin) return setJoining(false);
		// The server may still be waking up, or the camera still opening: join once both are ready (the button says Joining…)
		if (status !== "connected" || opening) return setJoining(true);
		localStorage.setItem(CAMERA_KEY, videoId);
		localStorage.setItem(MIC_KEY, audioId);
		localStorage.setItem(NAME_KEY, displayName);
		handedOverRef.current = true;
		// Prompt still unanswered: "blocked", so the call's buttons can ask again, not "no camera found"
		const joinTrouble = loading ? { audio: "blocked", video: "blocked" } : trouble;
		onJoin(streamRef.current ?? new MediaStream(), { videoId, audioId, cameraOff, muted, name: displayName, trouble: joinTrouble });
	};

	useEffect(() => {
		if (joining && status === "connected" && !opening) handleJoin();
	}, [joining, status, opening]);

	// Round on/off buttons on the preview, red when off (like Google Meet)
	const toggleClass = off => `w-12 h-12 rounded-full flex items-center justify-center text-white shadow-md transition-colors ` +
		(off ? "bg-red-600 hover:bg-red-700" : "bg-gray-800/70 hover:bg-gray-700/80 border border-white/40");

	const selectClass = `w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ` +
		(darkMode ? "bg-gray-700 border-gray-600" : "bg-white border-gray-300");

	// Browsers may hold audio until the first click; any click on the preview wakes the meter up.
	// Clicking Join closes the meter straight away, and Firefox then rejects the wake-up: nothing to do
	return (
		<div className="w-full max-w-4xl flex flex-col md:flex-row gap-6 items-center" onPointerDown={() => audioCtxRef.current?.resume().catch(() => {})}>
			<div className="relative w-full md:w-3/5 aspect-video bg-black rounded-2xl overflow-hidden shadow-lg border-4 border-gray-700">
				{/* Shown like a mirror; the other person gets the true picture */}
				{stream?.getVideoTracks().length > 0 && (
					<video
						autoPlay
						muted
						playsInline
						className="w-full h-full object-cover -scale-x-100"
						ref={(v) => v && v.srcObject !== stream && (v.srcObject = stream)}
					/>
				)}
				{!loading && (trouble.video || cameraOff) && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
						<FaVideoSlash size={40} />
						<span>{trouble.video ? troubleText("video", trouble.video) : "Camera is off"}</span>
					</div>
				)}
				{loading && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
						<p className="animate-pulse">Starting camera and microphone...</p>
						{slow && (
							<button
								onClick={() => start(videoId, audioId)}
								className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-colors"
							>
								<FaRedo /> Retry
							</button>
						)}
					</div>
				)}
				{/* Always there, like Google Meet: red with a "!" when the device is blocked or missing */}
				<div className="absolute bottom-4 inset-x-0 flex justify-center gap-4">
					<button
						type="button"
						onClick={() => trouble.audio ? fixDevice("audio") : setMuted(!muted)}
						aria-pressed={trouble.audio ? undefined : muted}
						aria-label={trouble.audio ? troubleText("audio", trouble.audio) : muted ? "Turn on microphone" : "Turn off microphone"}
						title={trouble.audio ? troubleText("audio", trouble.audio) : muted ? "Turn on microphone" : "Turn off microphone"}
						className={`relative ${toggleClass(muted || trouble.audio)}`}
					>
						{muted || trouble.audio ? <FaMicrophoneSlash size={18} /> : <FaMicrophone size={18} />}
						{trouble.audio && <TroubleMark />}
					</button>
					<button
						type="button"
						onClick={() => trouble.video ? fixDevice("video") : setCameraOff(!cameraOff)}
						aria-pressed={trouble.video ? undefined : cameraOff}
						aria-label={trouble.video ? troubleText("video", trouble.video) : cameraOff ? "Turn on camera" : "Turn off camera"}
						title={trouble.video ? troubleText("video", trouble.video) : cameraOff ? "Turn on camera" : "Turn off camera"}
						className={`relative ${toggleClass(cameraOff || trouble.video)}`}
					>
						{cameraOff || trouble.video ? <FaVideoSlash size={18} /> : <FaVideo size={18} />}
						{trouble.video && <TroubleMark />}
					</button>
				</div>
				{help && trouble[help] && (
					<DeviceHelp kind={help} trouble={trouble[help]} darkMode={darkMode} onClose={() => setHelp(null)} className="absolute top-3 inset-x-3" />
				)}
			</div>

			<form onSubmit={handleJoin} className={`w-full md:w-2/5 p-6 rounded-2xl shadow-lg space-y-4 ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"}`}>
				<div className="space-y-1">
					<h3 className="text-xl font-semibold">Ready to join?</h3>
					<ServerStatus />
					{peek && (
						<p className={`text-sm font-medium ${peek.full || peek.invalid ? "text-red-500" : "text-indigo-400"}`}>
							{peek.invalid || (peek.full ? `${here}. This room is full.` : here)}
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
				{speakers.length > 0 && (
					<label className="block space-y-1 text-sm">
						<span className="block font-medium">Speaker</span>
						<select value={speakerId} onChange={e => pickSpeaker(e.target.value)} className={selectClass}>
							{speakers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
						</select>
					</label>
				)}

				<NetworkCheck />

				{without.length > 0 && (
					<p className="text-sm text-amber-500">
						{without.length === 2 ? "No camera or microphone: you will join to watch and listen" : `${troubleText(without[0], trouble[without[0]])} — you will join without ${without[0] === "video" ? "video" : "sound"}`}
					</p>
				)}
				<button
					type="submit"
					disabled={!canJoin}
					className="w-full py-3 rounded-lg bg-indigo-600 text-white font-semibold transition-transform hover:bg-indigo-700 hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:bg-indigo-600"
				>
					{joining ? "Joining…" : "Join now"}
				</button>
			</form>
		</div>
	);
};

export default Preview;
