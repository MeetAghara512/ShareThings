import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaPhoneSlash, FaDesktop, FaVideo, FaVideoSlash, FaMicrophone, FaMicrophoneSlash, FaLink, FaCheck } from "react-icons/fa";
import peer from "../Services/peer";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate, useParams } from "react-router-dom";
import InviteForm from "./InviteForm";
import CallStatus from "./CallStatus";

// What the other side last told us about their camera and mic
const MEDIA_ON = { video: true, audio: true };
// An unanswered call gives up after this long
const RING_TIMEOUT = 30000;

const RoomPage = ({ darkMode, toggleDarkMode }) => {
	const { roomId } = useParams();
	const navigate = useNavigate();
	const socket = useSocket();

	const [remoteSocketId, setRemoteSocketId] = useState(null);
	const [myStream, setMyStream] = useState(null);
	const [remoteStream, setRemoteStream] = useState(null);
	const [remoteName, setRemoteName] = useState(null);
	// Display name chosen on the Lobby (same key as Lobby.jsx). Read once: a rename in another tab must not re-join mid-call
	const [myName] = useState(() => localStorage.getItem("sharethings.name"));

	const [isScreen, setIsScreen] = useState(false);
	const [muted, setMuted] = useState(false);
	const [cameraOff, setCameraOff] = useState(false);
	const [remoteMedia, setRemoteMedia] = useState(MEDIA_ON);
	const [callStart, setCallStart] = useState(null); // when the connection came up
	const [reconnecting, setReconnecting] = useState(false);
	const [copied, setCopied] = useState(false);

	// idle | calling (we ring them) | ringing (they ring us) | active
	const [callState, setCallStateValue] = useState("idle");
	const [incomingFrom, setIncomingFrom] = useState(null); // caller's id, once their offer is applied
	const [notice, setNotice] = useState(null); // "Call declined", "No answer", ...

	const myStreamRef = useRef(null);
	const callStateRef = useRef("idle"); // for socket handlers, which may run before a re-render
	const iceServersRef = useRef([]); // from the last join, for a fresh connection after a declined call
	const ringTimerRef = useRef(null);

	const setCallState = useCallback(state => {
		callStateRef.current = state;
		setCallStateValue(state);
	}, []);

	const handleCutCall = () => {
		if (myStreamRef.current) myStreamRef.current.getTracks().forEach(t => t.stop());
		socket.disconnect();
		window.location.href = "/";
	};

	const handleCopyLink = async () => {
		const link = window.location.href;
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			window.prompt("Copy this link:", link);
		}
	};

	// Join the room; the server replies with who is already there and the ICE servers to use
	const joinRoom = useCallback(() => {
		socket.emit("room:join", { room: roomId, name: myName }, ({ full, peerId, peerName, iceServers }) => {
			if (full) {
				alert("This room is full.");
				return navigate("/");
			}
			iceServersRef.current = iceServers;
			peer.reset(iceServers);
			setRemoteSocketId(peerId);
			setRemoteName(peerName);
		});
	}, [socket, roomId, myName, navigate]);

	// Leaving the page (e.g. browser Back) frees the camera, the connection and our place in the room
	useEffect(() => {
		// Room link opened without a name: ask for it on the Lobby first, which sends the user back here
		if (!myName) {
			navigate(`/?room=${encodeURIComponent(roomId)}`, { replace: true });
			return;
		}
		joinRoom();
		return () => {
			clearTimeout(ringTimerRef.current);
			myStreamRef.current?.getTracks().forEach(t => t.stop());
			myStreamRef.current = null;
			peer.reset();
			socket.emit("room:leave", { room: roomId });
		};
	}, [joinRoom, socket, roomId, myName, navigate]);

	// Send our ICE candidates to the other user and show their media when it arrives
	useEffect(() => {
		peer.onIceCandidate = candidate => socket.emit("ice:candidate", { to: remoteSocketId, candidate });
		peer.onTrack = setRemoteStream;
		// The call timer starts once media can flow, not when Call is clicked
		peer.onConnectionState = state => state === "connected" && setCallStart(start => start ?? Date.now());
		peer.onIceState = state => setReconnecting(state === "disconnected");
	}, [socket, remoteSocketId]);

	// Tell the other side whether our camera and mic are on (a shared screen counts as video)
	const videoOn = isScreen || !cameraOff;
	useEffect(() => {
		if (callStart && remoteSocketId) socket.emit("media:state", { to: remoteSocketId, video: videoOn, audio: !muted });
	}, [socket, remoteSocketId, callStart, videoOn, muted]);

	const handleUserJoined = useCallback(({ id, name }) => {
		setRemoteSocketId(id);
		setRemoteName(name);
	}, []);

	// Call is over or never started: camera off, fresh connection, Call button back
	const resetCall = useCallback(message => {
		clearTimeout(ringTimerRef.current);
		myStreamRef.current?.getTracks().forEach(t => t.stop());
		myStreamRef.current = null;
		setMyStream(null);
		setRemoteStream(null);
		setIsScreen(false);
		setMuted(false);
		setCameraOff(false);
		setRemoteMedia(MEDIA_ON);
		setCallStart(null);
		setReconnecting(false);
		setIncomingFrom(null);
		setCallState("idle");
		setNotice(message ?? null);
		peer.reset(iceServersRef.current); // right away, so a camera prompt that is still open knows the call is over
	}, [setCallState]);

	// Other user left or our signaling dropped: back to a clean waiting state
	const handleUserLeft = useCallback(() => {
		resetCall();
		setRemoteSocketId(null);
		setRemoteName(null);
		joinRoom();
	}, [resetCall, joinRoom]);

	// Notices like "Call declined" go away after a few seconds
	useEffect(() => {
		if (!notice) return;
		const id = setTimeout(() => setNotice(null), 5000);
		return () => clearTimeout(id);
	}, [notice]);

	// Camera + mic, added to the connection once per call
	const setupMedia = useCallback(async () => {
		if (myStreamRef.current) return true;
		const connection = peer.peer;
		const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
		if (connection !== peer.peer) {
			// The call ended while the camera prompt was open (e.g. browser Back): don't leave the camera on
			stream.getTracks().forEach(t => t.stop());
			return false;
		}
		myStreamRef.current = stream;
		setMyStream(stream);
		stream.getTracks().forEach(t => peer.peer.addTrack(t, stream));
		return true;
	}, []);

	// Outgoing call: rings until the other user accepts or declines, we cancel, or nobody answers
	const handleCallUser = useCallback(async () => {
		if (callStateRef.current !== "idle") return; // ignore repeat clicks while the camera prompt is open
		setCallState("calling");
		setNotice(null);
		const connection = peer.peer;
		try {
			if (!(await setupMedia())) return;
			const offer = await peer.getOffer();
			if (connection !== peer.peer) return; // cancelled meanwhile
			socket.emit("user:call", { to: remoteSocketId, offer });
			ringTimerRef.current = setTimeout(() => {
				socket.emit("call:cancelled", { to: remoteSocketId });
				resetCall("No answer");
			}, RING_TIMEOUT);
		} catch (e) {
			console.error("Call failed", e);
			if (connection === peer.peer) resetCall("Could not start the call");
		}
	}, [remoteSocketId, socket, setupMedia, resetCall, setCallState]);

	const handleCancelCall = () => {
		socket.emit("call:cancelled", { to: remoteSocketId });
		resetCall();
	};

	// Incoming call: apply the offer at once, so the caller's ICE candidates (sent before we answer)
	// are never lost, then ring. Their media stays hidden until we accept.
	const handleIncomingCall = useCallback(async ({ from, offer }) => {
		if (callStateRef.current !== "idle") return; // busy
		setCallState("ringing");
		setNotice(null);
		const connection = peer.peer;
		try {
			await peer.setRemoteDescription(offer);
		} catch (e) {
			console.error("Incoming call failed", e);
			if (connection !== peer.peer) return;
			socket.emit("call:declined", { to: from });
			return resetCall();
		}
		if (connection === peer.peer) setIncomingFrom(from); // not cancelled meanwhile
	}, [socket, resetCall, setCallState]);

	// Accept: our tracks reuse the offer's transceivers (no renegotiation), then answer
	const handleAccept = async () => {
		const from = incomingFrom;
		if (!from) return;
		setIncomingFrom(null);
		setCallState("active");
		const connection = peer.peer;
		try {
			if (!(await setupMedia())) return; // caller hung up while our camera prompt was open
			const ans = await peer.getAnswer();
			socket.emit("call:accepted", { to: from, ans });
		} catch (e) {
			console.error("Answer failed", e);
			if (connection !== peer.peer) return;
			socket.emit("call:declined", { to: from });
			resetCall("Could not start the call");
		}
	};

	const handleDecline = () => {
		if (!incomingFrom) return;
		socket.emit("call:declined", { to: incomingFrom });
		resetCall();
	};

	const handleCallAccepted = useCallback(async ({ ans }) => {
		if (callStateRef.current !== "calling") return; // we gave up already
		clearTimeout(ringTimerRef.current);
		setCallState("active");
		try {
			await peer.setRemoteDescription(ans);
		} catch (e) {
			console.error("Answer could not be applied", e);
		}
	}, [setCallState]);

	const handleCallDeclined = useCallback(() => {
		if (callStateRef.current === "calling") resetCall("Call declined");
	}, [resetCall]);

	// The caller cancelled or gave up
	const handleCallCancelled = useCallback(() => {
		if (callStateRef.current === "ringing" || callStateRef.current === "active") resetCall("Missed call");
	}, [resetCall]);

	const handleIceCandidate = useCallback(({ candidate }) => {
		peer.peer.addIceCandidate(candidate).catch(e => console.error("ICE candidate failed", e));
	}, []);

	const handleMediaState = useCallback(({ video, audio }) => {
		setRemoteMedia({ video: video !== false, audio: audio !== false });
	}, []);

	// Socket events
	useEffect(() => {
		socket.on("user:joined", handleUserJoined);
		socket.on("user:left", handleUserLeft);
		socket.on("incomming:call", handleIncomingCall);
		socket.on("call:accepted", handleCallAccepted);
		socket.on("call:declined", handleCallDeclined);
		socket.on("call:cancelled", handleCallCancelled);
		socket.on("ice:candidate", handleIceCandidate);
		socket.on("media:state", handleMediaState);
		socket.io.on("reconnect", handleUserLeft);
		return () => {
			socket.off("user:joined", handleUserJoined);
			socket.off("user:left", handleUserLeft);
			socket.off("incomming:call", handleIncomingCall);
			socket.off("call:accepted", handleCallAccepted);
			socket.off("call:declined", handleCallDeclined);
			socket.off("call:cancelled", handleCallCancelled);
			socket.off("ice:candidate", handleIceCandidate);
			socket.off("media:state", handleMediaState);
			socket.io.off("reconnect", handleUserLeft);
		};
	}, [socket, handleUserJoined, handleUserLeft, handleIncomingCall, handleCallAccepted, handleCallDeclined, handleCallCancelled, handleIceCandidate, handleMediaState]);

	// Switch between screen & camera: only the video track is swapped, the mic keeps running
	const switchVideo = async toScreen => {
		try {
			const source = toScreen
				? await navigator.mediaDevices.getDisplayMedia({ video: true })
				: await navigator.mediaDevices.getUserMedia({ video: true });
			const [track] = source.getVideoTracks();
			const current = myStreamRef.current;
			if (!current) return track.stop();
			if (!toScreen) track.enabled = !cameraOff; // back from sharing with the camera off: stay off

			await peer.peer.getSenders().find(s => s.track?.kind === "video")?.replaceTrack(track);
			current.getVideoTracks().forEach(t => t.stop());
			const stream = new MediaStream([...current.getAudioTracks(), track]);
			myStreamRef.current = stream;
			setMyStream(stream);
			setIsScreen(toScreen);
			// Browser's own "Stop sharing" button
			if (toScreen) track.onended = () => switchVideo(false);
		} catch (e) {
			console.error("Toggle share failed", e);
		}
	};

	// Toggle mic on/off
	const handleToggleMic = () => {
		if (!myStreamRef.current) return;
		myStreamRef.current.getAudioTracks().forEach(track => track.enabled = muted);
		setMuted(!muted);
	};

	// Toggle camera on/off; the shared screen is not affected
	const handleToggleCamera = () => {
		if (!myStreamRef.current || isScreen) return;
		myStreamRef.current.getVideoTracks().forEach(track => track.enabled = cameraOff);
		setCameraOff(!cameraOff);
	};

if (!myName) return null; // being redirected to the Lobby

	// While ringing the offer is already applied, but the caller is not shown until we accept
	const showRemote = remoteStream && callState === "active";

return (
	<div className={`min-h-screen flex flex-col transition-colors duration-500 ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
		<header className="flex justify-between items-center p-5 shadow border-b">
			<h2 className="text-2xl font-extrabold bg-gradient-to-r from-indigo-400 via-purple-500 to-pink-500 bg-clip-text text-transparent transition duration-300 hover:from-pink-500 hover:to-indigo-400">
				Video Call Room
			</h2>
			<button
				onClick={toggleDarkMode}
				className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition duration-300"
			>
				{darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
			</button>
		</header>

		<main className="flex-grow flex flex-col items-center justify-center p-6">
			<div className="mb-6 text-center">
				{!remoteSocketId ? (
					<div className="flex flex-col items-center gap-4">
					<div className="flex items-center justify-center gap-3">
						<svg
							className="animate-spin h-6 w-6 text-indigo-500"
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
						>
							<circle
								className="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								strokeWidth="4"
							></circle>
							<path
								className="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8v8z"
							></path>
						</svg>
						<span className="text-indigo-500 font-medium text-lg animate-pulse">
							Waiting for the other participant to join...
						</span>
					</div>
					<button
						onClick={handleCopyLink}
						className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-colors"
					>
						{copied ? <FaCheck /> : <FaLink />}
						{copied ? "Link copied!" : "Copy invite link"}
					</button>
					<InviteForm roomId={roomId} darkMode={darkMode} />
					</div>
				) : (
					<div className="px-4 py-2 rounded-full bg-green-100 text-green-800 font-semibold text-sm shadow inline-block max-w-full truncate">
						In a call with {remoteName}
					</div>
				)}
			</div>

			<div className="relative w-full max-w-4xl h-[60vh] bg-black rounded-2xl overflow-hidden shadow-lg border-4 border-gray-700">
				{showRemote && (
					<video
						autoPlay
						playsInline
						className="w-full h-full object-contain"
						ref={(v) => v && v.srcObject !== remoteStream && (v.srcObject = remoteStream)}
					/>
				)}
				{showRemote && !remoteMedia.video && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
						<FaVideoSlash size={40} />
						<span>Camera off</span>
					</div>
				)}
				{showRemote && (remoteName || !remoteMedia.audio) && (
					<span className="absolute bottom-4 left-4 max-w-[calc(100%-12rem)] flex items-center gap-1.5 px-2 py-1 rounded bg-black/60 text-white text-sm">
						{!remoteMedia.audio && <FaMicrophoneSlash className="shrink-0 text-red-400" title="Muted" />}
						<span className="truncate">{remoteName}</span>
					</span>
				)}
				{callStart && <CallStatus connection={peer.peer} since={callStart} reconnecting={reconnecting} />}
				{(incomingFrom || callState === "calling" || (callState === "idle" && notice)) && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-6 text-center text-white">
						{incomingFrom ? (
							<>
								<span className="max-w-full truncate text-2xl font-semibold">{remoteName || "Someone"} is calling</span>
								<div className="flex gap-4">
									<button
										onClick={handleAccept}
										className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
									>
										<FaPhone /> Accept
									</button>
									<button
										onClick={handleDecline}
										className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
									>
										<FaPhoneSlash /> Decline
									</button>
								</div>
							</>
						) : callState === "calling" ? (
							<>
								<span className="max-w-full truncate text-2xl font-semibold animate-pulse">Calling {remoteName}...</span>
								<button
									onClick={handleCancelCall}
									className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
								>
									<FaPhoneSlash /> Cancel
								</button>
							</>
						) : (
							<span className="text-xl text-gray-300">{notice}</span>
						)}
					</div>
				)}
				{myStream && (
					<div className="absolute bottom-4 right-4 w-36 h-28 border-white border-2 rounded-lg overflow-hidden shadow-md">
						<video
							autoPlay
							muted
							playsInline
							className="w-full h-full object-cover"
							ref={(v) => v && v.srcObject !== myStream && (v.srcObject = myStream)}
						/>
						{cameraOff && !isScreen && (
							<div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-gray-300">
								<FaVideoSlash size={24} />
							</div>
						)}
						<span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-xs">You</span>
					</div>
				)}
			</div>

			<div className="mt-8 flex gap-4 flex-wrap justify-center">
				{callState === "idle" && remoteSocketId && (
					<button
						onClick={handleCallUser}
						className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
					>
						<FaPhone /> Call
					</button>
				)}

				{myStream && callState === "active" && (
					<>
						<button
							onClick={() => switchVideo(!isScreen)}
							className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1"
						>
							{isScreen ? <FaVideo /> : <FaDesktop />}
							{isScreen ? "Use Camera" : "Share Screen"}
						</button>

						<button
							onClick={handleToggleCamera}
							disabled={isScreen}
							title={isScreen ? "Stop sharing your screen first" : undefined}
							className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
						>
							{cameraOff ? <FaVideoSlash /> : <FaVideo />}
							{cameraOff ? "Start Video" : "Stop Video"}
						</button>

						<button
							onClick={handleToggleMic}
							className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1"
						>
							{muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
							{muted ? "Unmute" : "Mute"}
						</button>

						<button
							onClick={handleCutCall}
							className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
						>
							<FaPhone /> End Call
						</button>
					</>
				)}
			</div>
		</main>
	</div>
);


};

export default RoomPage; //main
