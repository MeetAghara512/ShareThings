import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaDesktop, FaVideoSlash, FaMicrophoneSlash } from "react-icons/fa";
import peer from "../Services/peer";
import recovery from "../Services/recovery";
import clientId, { renewClientId } from "../Services/clientId";
import { openDevices } from "../Services/devices";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate, useParams } from "react-router-dom";
import CallStatus from "./CallStatus";
import Preview from "./Preview";
import ChatPanel, { useChatOpen } from "./ChatPanel";
import ControlBar, { MeetingCard } from "./ControlBar";

// What the other side last told us about their camera, mic and shared screen
const MEDIA_ON = { video: true, audio: true, screen: false };
// While the screen is shared the camera only fills a small tile, so the screen gets the bandwidth
const CAMERA_WHILE_SHARING = { maxBitrate: 150000, scaleResolutionDownBy: 2 };
const CONNECT_FAILED = "Could not connect. Reload the page to try again.";
// The other side answers within a second or two; if no answer arrives by then, it failed on their end
const CONNECT_TIMEOUT = 20000;
const CONNECTION_LOST = "Connection lost. Reload the page to try again.";

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
	const [infoOpen, setInfoOpen] = useState(true); // the "Your meeting is ready" card

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
	const remoteSeatRef = useRef(null); // the other person's seat: the same when their connection drops and comes back
	const serverRef = useRef(null); // which run of the server we joined, to notice a restart

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
		socket.emit("room:join", { room: roomId, name: myName, clientId: clientId() }, ({ full, peerId, peerName, peerSeat, server, iceServers }) => {
			if (full) {
				alert("This room is full.");
				return navigate("/");
			}
			iceServersRef.current = iceServers;
			serverRef.current = server;
			remoteSeatRef.current = peerSeat;
			// A call can start before this reply arrives (someone left and came straight back): keep its connection
			if (callStateRef.current === "idle") peer.reset(iceServers);
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
		peer.onConnectionState = state => {
			if (state === "connected") setCallStart(start => start ?? Date.now());
			recovery.update();
		};
		peer.onIceState = state => setReconnecting(state !== "connected" && state !== "completed"); // incl. during an ICE restart
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

	const handleUserJoined = useCallback(({ id, name, seat }) => {
		remoteSeatRef.current = seat ?? null;
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
		recovery.stop();
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
	const handleIncomingCall = useCallback(async ({ from, offer, restart }) => {
		if (restart) return recovery.answer(from, offer); // same call, new network path
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

	const handleCallAccepted = useCallback(async ({ ans, restart }) => {
		if (restart) return recovery.applyAnswer(ans);
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

	// After a network drop (see Services/recovery.jsx). ICE restarts did not bring the call back, so drop
	// this connection and connect from scratch; as when joining, the larger id sends the offer
	const startOver = useCallback(tellOther => {
		if (tellOther) socket.emit("call:rebuild", { to: remoteSocketId });
		resetCall();
		autoCalledRef.current = remoteSocketId;
		recovery.watchRebuild();
		if (remoteSocketId && socket.id > remoteSocketId) handleCallUser();
	}, [socket, remoteSocketId, resetCall, handleCallUser]);

	// The other side is recovering a call that already ended here (e.g. "Connection lost"): start over together
	const handleStaleCall = useCallback(from => {
		if (callStateRef.current === "idle" && from === remoteSocketId) startOver(true);
	}, [remoteSocketId, startOver]);

	const handleRebuild = useCallback(({ from }) => {
		if (from === remoteSocketId) startOver(false);
	}, [remoteSocketId, startOver]);

	useEffect(() => {
		if (!joined) return;
		recovery.canSignal = () => socket.connected;
		recovery.send = (event, data) => socket.emit(event, { to: recovery.peerId, ...data });
		recovery.onRebuild = () => startOver(true);
		recovery.onStale = handleStaleCall;
		recovery.onLost = () => resetCall(CONNECTION_LOST);
		const handleRestartRequest = ({ from }) => recovery.restartRequested(from);
		socket.on("call:restart-request", handleRestartRequest);
		socket.on("call:rebuild", handleRebuild);
		return () => {
			socket.off("call:restart-request", handleRestartRequest);
			socket.off("call:rebuild", handleRebuild);
		};
	}, [joined, socket, startOver, handleStaleCall, handleRebuild, resetCall]);

	// A new socket id for the other person may mean they are reachable again
	useEffect(() => {
		recovery.peerId = remoteSocketId;
		if (remoteSocketId) recovery.retryNow();
	}, [remoteSocketId]);

	useEffect(() => () => recovery.stop(), []); // leaving the room

	// Our signaling connection dropped and came back during a call. Take our seat back (same tab id) and keep
	// the call if the other person is still the one we talk to: the server kept our seat, or it restarted and
	// forgot everyone. Otherwise the call is over on their side, so start fresh with whoever is in the room
	const rejoinRoom = useCallback(() => {
		// What we sent while offline waits in Socket.IO's buffer. The server only relays between people in the
		// same room, so the rejoin has to reach it first
		const queued = socket.sendBuffer.splice(0);
		socket.emit("room:join", { room: roomId, name: myName, clientId: clientId(), resume: true }, ({ full, peerId, peerName, peerSeat, peerHeld, resumed, server, iceServers }) => {
			if (full) {
				alert("This room is full.");
				return navigate("/");
			}
			const restarted = server !== serverRef.current;
			serverRef.current = server;
			iceServersRef.current = iceServers;
			const samePerson = peerId ? peerSeat === remoteSeatRef.current : resumed ? peerHeld : restarted;
			if ((resumed || restarted) && samePerson) {
				try {
					peer.peer.setConfiguration({ ...peer.peer.getConfiguration(), iceServers }); // fresh TURN login for ICE restarts
				} catch (e) {
					console.error("ICE servers not updated", e);
				}
				if (peerId && peerId !== recovery.peerId) setRemoteSocketId(peerId); // their new id; retried once it is set
				else recovery.retryNow();
				return;
			}
			recovery.stop();
			resetCall();
			autoCalledRef.current = null;
			remoteSeatRef.current = peerSeat;
			setRemoteSocketId(peerId);
			setRemoteName(peerName);
		});
		socket.sendBuffer.push(...queued);
	}, [socket, roomId, myName, navigate, resetCall]);

	const handleReconnect = useCallback(() => (callStateRef.current === "active" ? rejoinRoom() : handleUserLeft()), [rejoinRoom, handleUserLeft]);

	// The server only disconnects a tab on purpose when the same tab id joined from somewhere else (a copied tab in
	// a browser without BroadcastChannel). Say so and leave with a new id, rather than staying in a dead call
	useEffect(() => {
		if (!joined) return;
		const handleReplaced = reason => {
			if (reason !== "io server disconnect") return;
			renewClientId();
			alert("This call was opened in another tab, so it ended here.");
			navigate("/");
			socket.connect();
		};
		socket.on("disconnect", handleReplaced);
		return () => socket.off("disconnect", handleReplaced);
	}, [joined, socket, navigate]);

	// Closing or reloading the tab is leaving on purpose: free our seat now, not after the grace period (best effort)
	useEffect(() => {
		if (!joined) return;
		const leave = () => socket.emit("room:leave", { room: roomId });
		window.addEventListener("pagehide", leave);
		return () => window.removeEventListener("pagehide", leave);
	}, [joined, socket, roomId]);

	// Socket events, once joined (a reconnect while on the preview must not join the room)
	useEffect(() => {
		if (!joined) return;
		socket.on("user:joined", handleUserJoined);
		socket.on("user:left", handleUserLeft);
		socket.on("incomming:call", handleIncomingCall);
		socket.on("call:accepted", handleCallAccepted);
		socket.on("ice:candidate", handleIceCandidate);
		socket.on("media:state", handleMediaState);
		socket.io.on("reconnect", handleReconnect);
		return () => {
			socket.off("user:joined", handleUserJoined);
			socket.off("user:left", handleUserLeft);
			socket.off("incomming:call", handleIncomingCall);
			socket.off("call:accepted", handleCallAccepted);
			socket.off("ice:candidate", handleIceCandidate);
			socket.off("media:state", handleMediaState);
			socket.io.off("reconnect", handleReconnect);
		};
	}, [joined, socket, handleUserJoined, handleUserLeft, handleIncomingCall, handleCallAccepted, handleIceCandidate, handleMediaState, handleReconnect]);

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
	const alone = !remoteSocketId;

	// The meeting card shows while you wait alone and hides when someone joins; the info button toggles it
	useEffect(() => setInfoOpen(!remoteSocketId), [remoteSocketId]);

	// Call timer, quality and "Reconnecting...": in the control bar on wide screens; on phones, where the bar
	// has no room, in the stage's top-left corner. Shown in one place only, so the stats are read once
	const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(min-width: 768px)");
		const update = () => setWide(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const status = callStart && <CallStatus connection={peer.peer} since={callStart} reconnecting={reconnecting} />;

return (
	<div className={`${joined ? "h-[100dvh] overflow-hidden" : "min-h-screen"} flex flex-col transition-colors duration-500 ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
		{!joined ? (
			<>
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
					<Preview darkMode={darkMode} roomId={roomId} onJoin={handleJoin} />
				</main>
			</>
		) : (
			<>
				{/* The stage fills the screen above the control bar: the page itself never scrolls */}
				<main className={`flex-1 min-h-0 px-2 pt-2 sm:px-4 sm:pt-4 ${chatOpen ? "lg:pr-[26rem]" : ""}`}>
					<div className="relative w-full h-full bg-black rounded-2xl overflow-hidden">
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
						{remoteSocketId && callState !== "active" && (
							<div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white">
								<span className={`max-w-full text-xl ${notice ? "text-gray-300" : "font-semibold animate-pulse"}`}>
									{notice || `Connecting to ${remoteName || "the other person"}...`}
								</span>
							</div>
						)}
						{myStream && (
							// Your own camera, shown like a mirror (as in Google Meet; the other person gets the true picture).
							// Alone it fills the stage; with someone there it is a small tile bottom-right
							<div className={alone ? "absolute inset-0" : "absolute bottom-3 right-3 z-10 w-32 sm:w-56 aspect-video border-white/70 border-2 rounded-lg overflow-hidden shadow-lg bg-zinc-800"}>
								<video
									autoPlay
									muted
									playsInline
									className="w-full h-full object-cover -scale-x-100"
									ref={(v) => v && v.srcObject !== myStream && (v.srcObject = myStream)}
								/>
								{cameraOff && (
									<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
										<FaVideoSlash size={alone ? 40 : 24} />
										{alone && <span>Your camera is off</span>}
									</div>
								)}
								{!alone && <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-xs">You</span>}
							</div>
						)}
						{!wide && status && (
							<div className="absolute top-3 left-3 z-10 px-2 py-1 rounded bg-black/60 text-white text-xs">{status}</div>
						)}
						{isScreen && (
							<div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold shadow flex items-center gap-2 whitespace-nowrap">
								<FaDesktop className="shrink-0" /> You are sharing your screen
							</div>
						)}
						{infoOpen && (
							<MeetingCard darkMode={darkMode} roomId={roomId} alone={alone} copied={copied} onCopy={handleCopyLink} onClose={() => setInfoOpen(false)} />
						)}
					</div>
				</main>
				<ControlBar
					darkMode={darkMode}
					roomId={roomId}
					status={wide && status}
					muted={muted}
					cameraOff={cameraOff}
					isScreen={isScreen}
					infoOpen={infoOpen}
					onToggleMic={handleToggleMic}
					onToggleCamera={handleToggleCamera}
					onToggleShare={isScreen ? stopShare : startShare}
					onToggleInfo={() => setInfoOpen(!infoOpen)}
					onToggleDarkMode={toggleDarkMode}
					onLeave={handleCutCall}
				/>
				<ChatPanel darkMode={darkMode} remoteName={remoteName} />
			</>
		)}
	</div>
);
};

export default RoomPage; //main
