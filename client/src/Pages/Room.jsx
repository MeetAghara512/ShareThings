import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaDesktop, FaVideo, FaVideoSlash, FaMicrophone, FaMicrophoneSlash, FaLink, FaCheck } from "react-icons/fa";
import peer from "../Services/peer";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate, useParams } from "react-router-dom";
import InviteForm from "./InviteForm";
import CallStatus from "./CallStatus";

// What the other side last told us about their camera and mic
const MEDIA_ON = { video: true, audio: true };

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

	const myStreamRef = useRef(null);
	const callingRef = useRef(false);

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

	// Call is over (other user left or our signaling dropped): back to a clean waiting state
	const handleUserLeft = useCallback(() => {
		myStreamRef.current?.getTracks().forEach(t => t.stop());
		myStreamRef.current = null;
		setMyStream(null);
		setRemoteStream(null);
		setRemoteSocketId(null);
		setRemoteName(null);
		setIsScreen(false);
		setMuted(false);
		setCameraOff(false);
		setRemoteMedia(MEDIA_ON);
		setCallStart(null);
		setReconnecting(false);
		callingRef.current = false;
		peer.reset(); // right away, so a camera prompt that is still open knows the call is over
		joinRoom();
	}, [joinRoom]);

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

	// Outgoing call
	const handleCallUser = useCallback(async () => {
		if (callingRef.current) return; // ignore repeat clicks while the camera prompt is open
		callingRef.current = true;
		try {
			if (!(await setupMedia())) return;
			const offer = await peer.getOffer();
			socket.emit("user:call", { to: remoteSocketId, offer });
		} catch (e) {
			console.error("Call failed", e);
			callingRef.current = false;
		}
	}, [remoteSocketId, socket, setupMedia]);

	// Incoming call: apply the offer first so our tracks reuse its transceivers (no renegotiation)
	const handleIncomingCall = useCallback(async ({ from, offer }) => {
		await peer.setRemoteDescription(offer);
		if (!(await setupMedia())) return;
		const ans = await peer.getAnswer();
		socket.emit("call:accepted", { to: from, ans });
	}, [socket, setupMedia]);

	const handleCallAccepted = useCallback(async ({ ans }) => {
		await peer.setRemoteDescription(ans);
	}, []);

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
		socket.on("ice:candidate", handleIceCandidate);
		socket.on("media:state", handleMediaState);
		socket.io.on("reconnect", handleUserLeft);
		return () => {
			socket.off("user:joined", handleUserJoined);
			socket.off("user:left", handleUserLeft);
			socket.off("incomming:call", handleIncomingCall);
			socket.off("call:accepted", handleCallAccepted);
			socket.off("ice:candidate", handleIceCandidate);
			socket.off("media:state", handleMediaState);
			socket.io.off("reconnect", handleUserLeft);
		};
	}, [socket, handleUserJoined, handleUserLeft, handleIncomingCall, handleCallAccepted, handleIceCandidate, handleMediaState]);

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
				{remoteStream && (
					<video
						autoPlay
						playsInline
						className="w-full h-full object-contain"
						ref={(v) => v && v.srcObject !== remoteStream && (v.srcObject = remoteStream)}
					/>
				)}
				{remoteStream && !remoteMedia.video && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
						<FaVideoSlash size={40} />
						<span>Camera off</span>
					</div>
				)}
				{remoteStream && (remoteName || !remoteMedia.audio) && (
					<span className="absolute bottom-4 left-4 max-w-[calc(100%-12rem)] flex items-center gap-1.5 px-2 py-1 rounded bg-black/60 text-white text-sm">
						{!remoteMedia.audio && <FaMicrophoneSlash className="shrink-0 text-red-400" title="Muted" />}
						<span className="truncate">{remoteName}</span>
					</span>
				)}
				{callStart && <CallStatus connection={peer.peer} since={callStart} reconnecting={reconnecting} />}
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
				{!myStream && remoteSocketId && (
					<button
						onClick={handleCallUser}
						className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
					>
						<FaPhone /> Call
					</button>
				)}

				{myStream && (
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
