import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaDesktop, FaVideo, FaVideoSlash, FaMicrophone, FaMicrophoneSlash, FaLink, FaCheck } from "react-icons/fa";
import peer from "../Services/peer";
import { openDevices } from "../Services/devices";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate, useParams } from "react-router-dom";
import InviteForm from "./InviteForm";
import CallStatus from "./CallStatus";
import Preview from "./Preview";
import ChatPanel, { ChatButton, useChatOpen } from "./ChatPanel";

// What the other side last told us about their camera, mic and shared screen
const MEDIA_ON = { video: true, audio: true, screen: false };
// While the screen is shared the camera only fills a small tile, so the screen gets the bandwidth
const CAMERA_WHILE_SHARING = { maxBitrate: 150000, scaleResolutionDownBy: 2 };
const CONNECT_FAILED = "Could not connect. Reload the page to try again.";
// The other side answers within a second or two; if no answer arrives by then, it failed on their end
const CONNECT_TIMEOUT = 20000;

const RoomPage = ({ darkMode, toggleDarkMode }) => {
	const { roomId } = useParams();
	const navigate = useNavigate();
	const socket = useSocket();

	const [remoteSocketId, setRemoteSocketId] = useState(null);
	const [myStream, setMyStream] = useState(null);
	const [remoteStream, setRemoteStream] = useState(null);
	const [remoteScreen, setRemoteScreen] = useState(null); // their screen lane, shown while they share
	const [swapped, setSwapped] = useState(false); // their camera big and their screen small
	const [remoteName, setRemoteName] = useState(null);
	const [myName, setMyName] = useState(null); // typed on the join screen
	const [joined, setJoined] = useState(false); // false while on the preview

	const [isScreen, setIsScreen] = useState(false);
	const [muted, setMuted] = useState(false);
	const [cameraOff, setCameraOff] = useState(false);
	const [remoteMedia, setRemoteMedia] = useState(MEDIA_ON);
	const [callStart, setCallStart] = useState(null); // when the connection came up
	const [reconnecting, setReconnecting] = useState(false);
	const [copied, setCopied] = useState(false);

	// idle | calling (we sent the offer) | active. Like Google Meet there is no ringing:
	// once both people are in the room the call connects on its own
	const [callState, setCallStateValue] = useState("idle");
	const [notice, setNotice] = useState(null); // shown if connecting failed
	const chatOpen = useChatOpen();

	const myStreamRef = useRef(null);
	const screenTrackRef = useRef(null); // our shared screen, kept for the next call like the camera
	const prefsRef = useRef({ videoId: "", audioId: "", cameraOff: false, muted: false }); // chosen on the preview
	const tracksAddedRef = useRef(null); // the connection our tracks were added to
	const callStateRef = useRef("idle"); // for socket handlers, which may run before a re-render
	const iceServersRef = useRef([]); // from the last join, for a fresh connection after a declined call
	const autoCalledRef = useRef(null); // the person we already started a call with, so a failure is not retried in a loop
	const connectTimerRef = useRef(null);

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

	// Join only after the preview, so nobody sees us before that.
	// Leaving the page (e.g. browser Back) frees the camera, the connection and our place in the room
	useEffect(() => {
		if (!joined) return;
		joinRoom();
		return () => {
			clearTimeout(connectTimerRef.current); // must not reset the connection of a later visit
			myStreamRef.current?.getTracks().forEach(t => t.stop());
			myStreamRef.current = null;
			screenTrackRef.current?.stop();
			peer.reset();
			socket.emit("room:leave", { room: roomId });
		};
	}, [joined, joinRoom, socket, roomId]);

	// The preview hands over its stream, so the call needs no second camera prompt
	const handleJoin = (stream, prefs) => {
		prefsRef.current = prefs;
		setMyName(prefs.name);
		myStreamRef.current = stream;
		setMyStream(stream);
		setCameraOff(prefs.cameraOff);
		setMuted(prefs.muted);
		setJoined(true);
	};

	// Send our ICE candidates to the other user and show their media when it arrives
	useEffect(() => {
		peer.onIceCandidate = candidate => socket.emit("ice:candidate", { to: remoteSocketId, candidate });
		peer.onTrack = setRemoteStream;
		peer.onScreenTrack = track => setRemoteScreen(new MediaStream([track]));
		// The call timer starts once media can flow, not when Call is clicked
		peer.onConnectionState = state => state === "connected" && setCallStart(start => start ?? Date.now());
		peer.onIceState = state => setReconnecting(state === "disconnected");
	}, [socket, remoteSocketId]);

	// Tell the other side whether our camera and mic are on and whether we share our screen
	useEffect(() => {
		if (callStart && remoteSocketId) socket.emit("media:state", { to: remoteSocketId, video: !cameraOff, audio: !muted, screen: isScreen });
	}, [socket, remoteSocketId, callStart, cameraOff, muted, isScreen]);

	// Shrink the camera while sharing and restore it afterwards (also on a call that starts mid-share)
	useEffect(() => {
		const camera = callStart && peer.peer.getSenders().find(s => s.track && s.track === myStreamRef.current?.getVideoTracks()[0]);
		const params = camera?.getParameters();
		if (!params?.encodings?.length) return;
		Object.assign(params.encodings[0], isScreen ? CAMERA_WHILE_SHARING : { maxBitrate: undefined, scaleResolutionDownBy: 1 });
		camera.setParameters(params).catch(e => console.error("Camera quality could not be changed", e));
	}, [callStart, isScreen]);

	const handleUserJoined = useCallback(({ id, name }) => {
		setRemoteSocketId(id);
		setRemoteName(name);
	}, []);

	// Call is over or never started: fresh connection. Like Google Meet, your camera, mic and
	// shared screen stay as they are, ready for whoever joins next
	const resetCall = useCallback(message => {
		clearTimeout(connectTimerRef.current);
		setRemoteStream(null);
		setRemoteScreen(null);
		setSwapped(false);
		setRemoteMedia(MEDIA_ON);
		setCallStart(null);
		setReconnecting(false);
		setCallState("idle");
		setNotice(message ?? null);
		peer.reset(iceServersRef.current); // right away, so a camera prompt that is still open knows the call is over
	}, [setCallState]);

	// Other user left or our signaling dropped: back to a clean waiting state
	const handleUserLeft = useCallback(() => {
		resetCall();
		autoCalledRef.current = null; // the same person may come back with the same socket id (in-app Back, then join again)
		setRemoteSocketId(null);
		setRemoteName(null);
		joinRoom();
	}, [resetCall, joinRoom]);

	// Camera + mic, added to the connection once per call: the preview's stream, or the chosen devices
	// again after an earlier call ended (which turned the camera off)
	const setupMedia = useCallback(async () => {
		const connection = peer.peer;
		let stream = myStreamRef.current;
		if (!stream) {
			const { videoId, audioId, cameraOff, muted } = prefsRef.current;
			stream = await openDevices(videoId, audioId);
			if (connection !== peer.peer) {
				// The call ended while the camera prompt was open (e.g. browser Back): don't leave the camera on
				stream.getTracks().forEach(t => t.stop());
				return false;
			}
			stream.getVideoTracks().forEach(t => t.enabled = !cameraOff);
			stream.getAudioTracks().forEach(t => t.enabled = !muted);
			myStreamRef.current = stream;
			setMyStream(stream);
		}
		if (tracksAddedRef.current !== connection) {
			stream.getTracks().forEach(t => connection.addTrack(t, stream));
			tracksAddedRef.current = connection;
			// Only after addTrack, which would put the camera in a free lane. A share already running goes on it
			const slot = peer.screenSlot(true);
			if (slot && screenTrackRef.current) await slot.sender.replaceTrack(screenTrackRef.current);
		}
		return true;
	}, []);

	// Start the call: send our offer, the other side answers on its own
	const handleCallUser = useCallback(async () => {
		if (callStateRef.current !== "idle") return;
		setCallState("calling");
		setNotice(null);
		const connection = peer.peer;
		try {
			if (!(await setupMedia())) return;
			const offer = await peer.getOffer();
			if (connection !== peer.peer) return; // the other person left meanwhile
			socket.emit("user:call", { to: remoteSocketId, offer });
			connectTimerRef.current = setTimeout(() => {
				if (callStateRef.current === "calling") resetCall(CONNECT_FAILED);
			}, CONNECT_TIMEOUT);
		} catch (e) {
			console.error("Call failed", e);
			if (connection === peer.peer) resetCall(CONNECT_FAILED);
		}
	}, [remoteSocketId, socket, setupMedia, resetCall, setCallState]);

	// Both people are in the room: connect. Exactly one side may send the offer, so the one with the
	// larger id does it, whichever joined first. Each person is called at most once.
	useEffect(() => {
		if (!joined || !remoteSocketId || callState !== "idle" || !socket.id || socket.id < remoteSocketId) return;
		if (autoCalledRef.current === remoteSocketId) return;
		autoCalledRef.current = remoteSocketId;
		handleCallUser();
	}, [joined, remoteSocketId, callState, socket, handleCallUser]);

	// Incoming call: answered at once. The offer is applied first, so the caller's ICE candidates are
	// never lost and our tracks reuse the offer's transceivers (no renegotiation)
	const handleIncomingCall = useCallback(async ({ from, offer }) => {
		if (callStateRef.current !== "idle") return; // already connecting
		setCallState("active");
		setNotice(null);
		const connection = peer.peer;
		try {
			await peer.setRemoteDescription(offer);
			if (!(await setupMedia())) return;
			const ans = await peer.getAnswer();
			if (connection !== peer.peer) return; // the other person left meanwhile
			socket.emit("call:accepted", { to: from, ans });
		} catch (e) {
			console.error("Answering failed", e);
			if (connection === peer.peer) resetCall(CONNECT_FAILED);
		}
	}, [socket, setupMedia, resetCall, setCallState]);

	const handleCallAccepted = useCallback(async ({ ans }) => {
		if (callStateRef.current !== "calling") return;
		clearTimeout(connectTimerRef.current);
		setCallState("active");
		try {
			await peer.setRemoteDescription(ans);
		} catch (e) {
			console.error("Answer could not be applied", e);
		}
	}, [setCallState]);

	const handleIceCandidate = useCallback(({ candidate }) => {
		peer.peer.addIceCandidate(candidate).catch(e => console.error("ICE candidate failed", e));
	}, []);

	const handleMediaState = useCallback(({ video, audio, screen }) => {
		setRemoteMedia({ video: video !== false, audio: audio !== false, screen: screen === true });
		if (screen !== true) setSwapped(false); // their next share starts with the screen big again
	}, []);

	// Socket events, once joined (a reconnect while on the preview must not join the room)
	useEffect(() => {
		if (!joined) return;
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
	}, [joined, socket, handleUserJoined, handleUserLeft, handleIncomingCall, handleCallAccepted, handleIceCandidate, handleMediaState]);

	// The screen goes in its own lane next to the camera, so the camera and mic keep running.
	// While waiting alone there is no lane yet: setupMedia puts the screen on the next call
	const startShare = async () => {
		try {
			const [track] = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks();
			if (!myStreamRef.current) return track.stop(); // left the room while choosing
			track.contentHint = "detail"; // sharp text rather than smooth motion
			screenTrackRef.current = track;
			track.onended = stopShare; // the browser's own "Stop sharing" button
			await peer.screenSlot()?.sender.replaceTrack(track);
			setIsScreen(true);
		} catch (e) {
			console.error("Screen share failed", e);
			stopShare();
		}
	};

	const stopShare = () => {
		const track = screenTrackRef.current;
		if (!track) return;
		screenTrackRef.current = null;
		peer.screenSlot()?.sender.replaceTrack(null).catch(e => console.error("Stop sharing failed", e));
		track.stop();
		setIsScreen(false);
	};

	// Toggle mic on/off
	const handleToggleMic = () => {
		if (!myStreamRef.current) return;
		myStreamRef.current.getAudioTracks().forEach(track => track.enabled = muted);
		setMuted(!muted);
	};

	// Toggle camera on/off; the shared screen is not affected
	const handleToggleCamera = () => {
		if (!myStreamRef.current) return;
		myStreamRef.current.getVideoTracks().forEach(track => track.enabled = cameraOff);
		setCameraOff(!cameraOff);
	};

	// While ringing the offer is already applied, but the caller is not shown until we accept
	const showRemote = remoteStream && callState === "active";
	// Their shared screen is big and their camera small, until they click the small tile to swap
	const remoteSharing = showRemote && remoteMedia.screen && remoteScreen;
	const bigStream = remoteSharing && !swapped ? remoteScreen : remoteStream;
	const smallStream = bigStream === remoteStream ? remoteScreen : remoteStream;

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

		<main className={`flex-grow flex flex-col items-center justify-center p-6 ${chatOpen ? "lg:pr-[26rem]" : ""}`}>
			{!joined ? (
				<Preview darkMode={darkMode} roomId={roomId} onJoin={handleJoin} />
			) : (
				<>
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
						{/* Their sound plays here, so swapping the videos never cuts it */}
						{showRemote && <audio autoPlay ref={(a) => a && a.srcObject !== remoteStream && (a.srcObject = remoteStream)} />}
						{showRemote && (
							<video
								autoPlay
								playsInline
								muted
								className="w-full h-full object-contain"
								ref={(v) => v && v.srcObject !== bigStream && (v.srcObject = bigStream)}
							/>
						)}
						{showRemote && !remoteMedia.video && bigStream === remoteStream && (
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
						{remoteSharing && (
							<button
								type="button"
								onClick={() => setSwapped(!swapped)}
								title="Swap screen and camera"
								aria-label="Swap screen and camera"
								className="absolute top-4 right-4 z-10 w-36 sm:w-48 aspect-video bg-black border-white border-2 rounded-lg overflow-hidden shadow-md transition-colors hover:border-indigo-400"
							>
								<video
									autoPlay
									playsInline
									muted
									className={`w-full h-full ${smallStream === remoteStream ? "object-cover" : "object-contain"}`}
									ref={(v) => v && v.srcObject !== smallStream && (v.srcObject = smallStream)}
								/>
								{smallStream === remoteStream && !remoteMedia.video && (
									<div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-gray-300">
										<FaVideoSlash size={24} />
									</div>
								)}
							</button>
						)}
						{callStart && <CallStatus connection={peer.peer} since={callStart} reconnecting={reconnecting} />}
						{remoteSocketId && callState !== "active" && (
							<div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white">
								<span className={`max-w-full text-xl ${notice ? "text-gray-300" : "font-semibold animate-pulse"}`}>
									{notice || `Connecting to ${remoteName || "the other person"}...`}
								</span>
							</div>
						)}
						{myStream && (
							<div className="absolute bottom-4 right-4 w-36 h-28 border-white border-2 rounded-lg overflow-hidden shadow-md">
								{/* Your own camera, shown like a mirror (as in Google Meet); the other person gets the true picture */}
								<video
									autoPlay
									muted
									playsInline
									className="w-full h-full object-cover -scale-x-100"
									ref={(v) => v && v.srcObject !== myStream && (v.srcObject = myStream)}
								/>
								{cameraOff && (
									<div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-gray-300">
										<FaVideoSlash size={24} />
									</div>
								)}
								<span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-xs">You</span>
							</div>
						)}
					</div>

					{isScreen && (
						<div className="mt-4 px-4 py-2 rounded-full bg-indigo-100 text-indigo-800 font-semibold text-sm shadow flex items-center gap-2">
							<FaDesktop /> You are sharing your screen
						</div>
					)}

					<div className="mt-8 flex gap-4 flex-wrap justify-center">
						{myStream && (
							<>
								<button
									onClick={isScreen ? stopShare : startShare}
									className={`${isScreen ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-700 hover:bg-gray-600"} text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1`}
								>
									<FaDesktop />
									{isScreen ? "Stop Sharing" : "Share Screen"}
								</button>

								<button
									onClick={handleToggleCamera}
									className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-full flex items-center gap-2 shadow-sm transition-transform hover:-translate-y-1"
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

								<ChatButton />

								<button
									onClick={handleCutCall}
									className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full flex items-center gap-2 shadow-md transition-transform hover:-translate-y-1"
								>
									<FaPhone /> End Call
								</button>
							</>
						)}
					</div>
					<ChatPanel darkMode={darkMode} remoteName={remoteName} />
				</>
			)}
		</main>
	</div>
);


};

export default RoomPage; //main
