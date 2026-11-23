import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaDesktop, FaVideoSlash, FaMicrophoneSlash } from "react-icons/fa";
import peer from "../Services/peer";
import recovery from "../Services/recovery";
import clientId, { renewClientId } from "../Services/clientId";
import { openDevices, openDevice, onGranted, permission, troubleOf } from "../Services/devices";
import { useSocket } from "../useContext/SocketProvider";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import CallStatus from "./CallStatus";
import Preview from "./Preview";
import ChatPanel, { useChatOpen } from "./ChatPanel";
import MutedWarning from "./MutedWarning";
import { FileDropOverlay, useFileDrop } from "./FileDrop";
import { ReactionLayer } from "./Reactions";
import { useCallShortcuts, keyText } from "../Services/shortcuts";
import * as chat from "../Services/chat";
import ControlBar, { DeviceHelp, MeetingCard } from "./ControlBar";
import { useAdaptiveQuality } from "../Services/quality";
import { setCallTitle } from "../Services/title";
import { noticeJoin } from "../Services/notify";
import JoinNotice from "./JoinNotice";
import JoinRequests from "./JoinRequests";
import PrivacyShield from "./PrivacyShield";
import { privateHash, setPrivateRoom } from "../Services/privateCheck";

// What the other side last told us about their camera, mic and shared screen (has*: there is a device at all)
const MEDIA_ON = { video: true, audio: true, screen: false, hasCamera: true, hasMic: true, paused: false };
const CONNECT_FAILED = "Could not connect. Reload the page to try again.";
// The other side answers within a second or two; if no answer arrives by then, it failed on their end
const CONNECT_TIMEOUT = 20000;
const CONNECTION_LOST = "Connection lost. Reload the page to try again.";
const OFFLINE_AFTER = 30000; // as long as the server keeps a seat: we may no longer be in the call and cannot be told

const RoomPage = ({ darkMode, toggleDarkMode }) => {
	const { roomId } = useParams();
	const { hash: linkHash } = useLocation(); // the private-link secret: stays in this browser, never sent to the server
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
	const [trouble, setTrouble] = useState({}); // { audio, video }: why a device does not work (see devices.jsx)
	const [help, setHelp] = useState(null); // the device whose fix is shown
	const [isHost, setIsHost] = useState(false); // only the server decides; it can remove the other person
	const [removing, setRemoving] = useState(null); // the socket id the "Remove?" question is about
	const [admission, setAdmission] = useState("joining"); // joining | asking (the host decides) | empty (nobody to ask) | null: in the room
	const [requests, setRequests] = useState([]); // host: people asking to join
	const [offline, setOffline] = useState(false); // no signaling for OFFLINE_AFTER and no call running

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
	const askedRef = useRef(new Set()); // requests the host was already notified of
	const troubleRef = useRef(trouble);
	troubleRef.current = trouble;
	const aloneRef = useRef(true); // for the join notification: only when someone arrives while we wait alone
	aloneRef.current = !remoteSocketId;

	const setCallState = useCallback(state => {
		callStateRef.current = state;
		setCallStateValue(state);
	}, []);

	const handleCutCall = () => {
		if (myStreamRef.current) myStreamRef.current.getTracks().forEach(t => t.stop());
		socket.disconnect();
		window.location.href = `/left/${encodeURIComponent(roomId)}${privateHash()}`; // "You left the call", with Rejoin
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

	// The host removed us or did not let us in: camera, mic, screen and connection stop now, and the server keeps this tab out
	const handleRemoved = useCallback((reason = "removed") => {
		recovery.stop();
		clearTimeout(connectTimerRef.current);
		myStreamRef.current?.getTracks().forEach(t => t.stop());
		myStreamRef.current = null;
		screenTrackRef.current?.stop();
		peer.reset();
		navigate(`/left/${encodeURIComponent(roomId)}`, { replace: true, state: { reason } });
	}, [navigate, roomId]);

	// Join the room; the server replies with who is already there and the ICE servers to use
	const joinRoom = useCallback(() => {
		socket.emit("room:join", { room: roomId, name: myName, clientId: clientId() }, ({ full, removed, denied, retry, error, peerId, peerName, peerSeat, host, server, iceServers }) => {
			if (retry) return setAdmission("empty");
			if (removed || denied) return handleRemoved(denied ? "denied" : "removed");
			if (full) {
				alert(error || "This room is full."); // error: too many attempts from this internet address
				return navigate("/");
			}
			iceServersRef.current = iceServers;
			serverRef.current = server;
			remoteSeatRef.current = peerSeat;
			setIsHost(host === true);
			setAdmission(null);
			// A call can start before this reply arrives (someone left and came straight back): keep its connection
			if (callStateRef.current === "idle") peer.reset(iceServers);
			setRemoteSocketId(peerId);
			setRemoteName(peerName);
		});
	}, [socket, roomId, myName, navigate, handleRemoved]);

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
		setTrouble(prefs.trouble ?? {});
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

	// Tell the other side whether we have a camera and a mic, whether they are on and whether we share our screen
	const hasCamera = !!myStream?.getVideoTracks().length;
	const hasMic = !!myStream?.getAudioTracks().length;

	// Video sized to the other screen, the camera smaller while we share, stepped down (or paused) on a weak network
	const { mode: qualityMode, setMode: setQualityMode, paused, onStats } = useAdaptiveQuality({
		socket, remoteSocketId, callStart, remoteStream, remoteScreen, isScreen,
		layout: `${remoteMedia.screen}-${swapped}-${chatOpen}-${callState}`,
		cameraTrack: myStream?.getVideoTracks()[0], cameraOn: hasCamera && !cameraOff,
	});

	useEffect(() => {
		if (callStart && remoteSocketId) socket.emit("media:state", { to: remoteSocketId, video: hasCamera && !cameraOff, audio: hasMic && !muted, screen: isScreen, hasCamera, hasMic, paused });
	}, [socket, remoteSocketId, callStart, cameraOff, muted, isScreen, hasCamera, hasMic, paused]);

	// The call state in the tab title (the chat puts its unread count in front); the normal title again on leaving
	useEffect(() => {
		if (!joined) return;
		const state = remoteSocketId ? `In call with ${remoteName || "someone"} \u00b7 ShareThings` : `Waiting\u2026 \u00b7 ${roomId}`;
		setCallTitle(muted ? `\ud83d\udd07 Muted \u00b7 ${state}` : remoteSocketId ? `\u25cf ${state}` : state);
	}, [joined, remoteSocketId, remoteName, muted, roomId]);
	useEffect(() => () => setCallTitle(null), []);

	const handleUserJoined = useCallback(({ id, name, seat }) => {
		const wasAlone = aloneRef.current;
		const sameTabBack = !!seat && seat === remoteSeatRef.current; // back from a reload: they never really left
		remoteSeatRef.current = seat ?? null;
		setRemoteSocketId(id);
		setRemoteName(name);
		if (wasAlone && !sameTabBack) noticeJoin(name); // only while this tab is in the background and notifications are allowed
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
	const handleUserLeft = useCallback(({ back } = {}) => {
		recovery.stop();
		resetCall();
		autoCalledRef.current = null; // the same person may come back with the same socket id (in-app Back, then join again)
		if (!back) remoteSeatRef.current = null; // really gone: coming back later is a new arrival
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
			tracksAddedRef.current = connection;
			// Always a mic lane and a camera lane, even without the device, so one can be turned on later with
			// no new offer. The offering side makes them (in this order); the answering side has them from the offer
			const answering = !!connection.remoteDescription;
			for (const kind of ["audio", "video"]) {
				const track = stream.getTracks().find(t => t.kind === kind) ?? null;
				const lane = answering ? peer.lane(kind) : connection.addTransceiver(track ?? kind, { direction: "sendrecv", streams: [stream] });
				if (!answering || !lane) continue;
				lane.direction = "sendrecv";
				lane.sender.setStreams?.(stream);
				if (track) await lane.sender.replaceTrack(track);
			}
			// After the mic and camera lanes, so the screen's is the second video lane. A share already running goes on it
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

	const handleMediaState = useCallback(({ video, audio, screen, hasCamera, hasMic, paused }) => {
		setRemoteMedia({ video: video !== false, audio: audio !== false, screen: screen === true, hasCamera: hasCamera !== false, hasMic: hasMic !== false, paused: paused === true });
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
		socket.emit("room:join", { room: roomId, name: myName, clientId: clientId(), resume: true }, ({ full, removed, denied, retry, error, peerId, peerName, peerSeat, peerHeld, resumed, host, server, iceServers }) => {
			if (retry) return rejoinRoom(); // nobody left to ask: the room is ours now
			if (removed || denied) return handleRemoved(denied ? "denied" : "removed");
			if (full) {
				alert(error || "This room is full.");
				return navigate("/");
			}
			setIsHost(host === true);
			setAdmission(null);
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
	}, [socket, roomId, myName, navigate, resetCall, handleRemoved]);

	const handleReconnect = useCallback(() => (callStateRef.current === "active" ? rejoinRoom() : handleUserLeft()), [rejoinRoom, handleUserLeft]);

	// The server only disconnects a tab on purpose when the same tab id joined from somewhere else (a copied tab in
	// a browser without BroadcastChannel). Say so and leave with a new id, rather than staying in a dead call
	useEffect(() => {
		if (!joined) return;
		const handleReplaced = reason => {
			if (reason !== "io server disconnect") return;
			renewClientId();
			navigate(`/left/${encodeURIComponent(roomId)}${privateHash()}`, { state: { reason: "other-tab" } });
			socket.connect();
		};
		socket.on("disconnect", handleReplaced);
		return () => socket.off("disconnect", handleReplaced);
	}, [joined, socket, navigate, roomId]);

	// Closing or reloading the tab: tell the server now (best effort). It keeps the seat briefly in case this is a reload
	useEffect(() => {
		if (!joined) return;
		const leave = () => socket.emit("room:leave", { room: roomId, closing: true });
		window.addEventListener("pagehide", leave);
		return () => window.removeEventListener("pagehide", leave);
	}, [joined, socket, roomId]);

	// The host removed us, the host left and we take over, we wait to be let in, or (host) who is waiting
	useEffect(() => {
		if (!joined) return;
		const onRemoved = ({ room }) => room === roomId && handleRemoved();
		const onHost = ({ room }) => room === roomId && setIsHost(true);
		// A call that is still running (its signaling came back after a server restart) stays on screen while asking
		const onWaiting = ({ room }) => {
			if (room !== roomId || peer.peer.connectionState === "connected") return;
			recovery.stop();
			resetCall();
			autoCalledRef.current = null;
			setRemoteSocketId(null);
			setRemoteName(null);
			setAdmission("asking");
		};
		const onRequests = ({ room, requests: list }) => {
			if (room !== roomId || !Array.isArray(list)) return;
			setRequests(list);
			list.filter(r => !askedRef.current.has(r.id)).forEach(r => {
				askedRef.current.add(r.id);
				noticeJoin(r.name, "wants to join");
			});
		};
		socket.on("room:removed", onRemoved);
		socket.on("room:host", onHost);
		socket.on("room:waiting", onWaiting);
		socket.on("room:requests", onRequests);
		return () => {
			socket.off("room:removed", onRemoved);
			socket.off("room:host", onHost);
			socket.off("room:waiting", onWaiting);
			socket.off("room:requests", onRequests);
		};
	}, [joined, socket, roomId, handleRemoved, resetCall]);

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

	// Their video comes straight from their browser, so our side closes the connection at once and does not rely on
	// theirs. The server handles the event first; if it refuses, the join in handleUserLeft finds them and the call reconnects
	const removeRemote = () => {
		const to = removing;
		setRemoving(null);
		if (to !== remoteSocketId) return;
		if (!socket.connected) return alert("You are reconnecting. Try again in a moment.");
		socket.emit("room:remove", { room: roomId, to }, ({ error }) => error && alert(error));
		chat.forgetPeer();
		handleUserLeft();
	};

	// Host: let someone in or not. The server checks that we are the host and that a seat is free
	const answerRequest = (event, id) => socket.emit(event, { room: roomId, id }, ({ error }) => error && alert(error));

	// The screen goes in its own lane next to the camera, so the camera and mic keep running.
	// While waiting alone there is no lane yet: setupMedia puts the screen on the next call
	const startShare = async () => {
		if (!navigator.mediaDevices?.getDisplayMedia) return; // phones: not possible (the button is hidden there)
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

	// A red mic or camera button: ask again where the browser still can (the click allows the prompt), else
	// show the fix. A device that starts goes into its lane with replaceTrack: no new offer
	const fixDevice = useCallback(async kind => {
		if (troubleRef.current[kind] === "system" || await permission(kind) === "denied") return setHelp(kind);
		try {
			const track = await openDevice(kind, prefsRef.current[kind === "video" ? "videoId" : "audioId"]);
			const current = myStreamRef.current;
			if (!current) return track.stop(); // left the room meanwhile
			const stream = new MediaStream([...current.getTracks(), track]);
			myStreamRef.current = stream;
			setMyStream(stream);
			await peer.lane(kind)?.sender.replaceTrack(track); // none while waiting alone: setupMedia adds it to the next call
			if (kind === "video") setCameraOff(false);
			else setMuted(false);
			setTrouble(t => ({ ...t, [kind]: null }));
			setHelp(null);
		} catch (e) {
			setTrouble(t => ({ ...t, [kind]: troubleOf(e) }));
			setHelp(kind);
		}
	}, []);

	// A device unplugged or blocked during the call: its lane goes quiet and its button turns red
	useEffect(() => {
		myStream?.getTracks().forEach(track => {
			track.onended = () => {
				const stream = new MediaStream(myStreamRef.current?.getTracks().filter(t => t !== track) ?? []);
				myStreamRef.current = stream;
				setMyStream(stream);
				peer.lane(track.kind)?.sender.replaceTrack(null).catch(() => {});
				setTrouble(t => ({ ...t, [track.kind]: "missing" }));
			};
		});
	}, [myStream]);

	// Allowed in the address bar during the call: the device starts by itself, unless it was turned off on
	// purpose. Then it is not opened at all (that would light the camera); its red button still opens it
	const offRef = useRef({});
	offRef.current = { audio: muted, video: cameraOff };
	useEffect(() => {
		if (!joined) return;
		const stops = ["audio", "video"].map(kind => onGranted(kind, () => troubleRef.current[kind] && !offRef.current[kind] && fixDevice(kind)));
		return () => stops.forEach(stop => stop());
	}, [joined, fixDevice]);

	// Long offline with the call down, we may have been removed without hearing it. Nothing stops by itself: a
	// reconnect must find the devices as they were, so the person gets a button instead
	useEffect(() => {
		if (!joined) return;
		let since = null;
		const id = setInterval(() => {
			since = socket.connected ? null : since ?? Date.now();
			setOffline(since !== null && Date.now() - since >= OFFLINE_AFTER && peer.peer.connectionState !== "connected");
		}, 1000);
		return () => clearInterval(id);
	}, [joined, socket]);

	// Each device goes through its usual "ended" path; its button then turns it back on
	const turnOffDevices = () => myStreamRef.current?.getTracks().forEach(track => {
		track.stop();
		track.onended?.();
		setTrouble(t => ({ ...t, [track.kind]: "off" }));
	});

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
	const fileDrop = useFileDrop(!!showRemote);
	// Their shared screen is big and their camera small, until they click the small tile to swap
	const remoteSharing = showRemote && remoteMedia.screen && remoteScreen;
	const bigStream = remoteSharing && !swapped ? remoteScreen : remoteStream;
	const smallStream = bigStream === remoteStream ? remoteScreen : remoteStream;
	const alone = !remoteSocketId;
	// A device with no track is shown as missing, even if the join screen never said why
	const deviceTrouble = { audio: hasMic ? null : trouble.audio || "missing", video: hasCamera ? null : trouble.video || "missing" };
	// ⌘/Ctrl+D mic, ⌘/Ctrl+E camera, ⌘/Ctrl+Shift+C chat, ⌘/Ctrl+Shift+S screen: the same as the bar's buttons
	useCallShortcuts({
		mic: deviceTrouble.audio ? () => fixDevice("audio") : handleToggleMic,
		camera: deviceTrouble.video ? () => fixDevice("video") : handleToggleCamera,
		chat: () => chat.setOpen(!chat.getState().open),
		share: isScreen ? stopShare : startShare,
	}, joined);
	// A first letter in a circle, for someone without a camera
	const avatar = (name, size) => (
		<span className={`${size} rounded-full bg-indigo-600 text-white font-semibold flex items-center justify-center uppercase`}>{(name || "?").trim().charAt(0)}</span>
	);

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
	const status = callStart && (
		<div className="flex items-center gap-3 min-w-0">
			<PrivacyShield remoteName={remoteName} darkMode={darkMode} />
			<CallStatus connection={peer.peer} since={callStart} reconnecting={reconnecting} onStats={onStats} />
		</div>
	);
	useEffect(() => setPrivateRoom(roomId, linkHash), [roomId, linkHash]);

	// iPhone Safari lays the keyboard over the page and leaves dvh as it was (it ignores interactive-widget), so
	// the chat input and the video would end up under the keyboard or panned away. While the visible part of the
	// page is smaller than the window, --app-height and --app-top fit the call to it (pinch zoom is left alone)
	useEffect(() => {
		const vv = window.visualViewport;
		if (!joined || !vv) return;
		const root = document.documentElement.style;
		const clear = () => {
			root.removeProperty("--app-height");
			root.removeProperty("--app-top");
		};
		const fit = () => {
			if (Math.abs(vv.scale - 1) > 0.01 || innerHeight - vv.height < 1) return clear();
			root.setProperty("--app-height", `${vv.height}px`);
			root.setProperty("--app-top", `${vv.offsetTop}px`);
		};
		fit();
		vv.addEventListener("resize", fit);
		vv.addEventListener("scroll", fit);
		return () => {
			vv.removeEventListener("resize", fit);
			vv.removeEventListener("scroll", fit);
			clear();
		};
	}, [joined]);

return (
	<div className={`${joined ? "relative top-[var(--app-top,0px)] h-[var(--app-height,100dvh)] overflow-hidden" : "min-h-screen"} flex flex-col transition-colors duration-500 ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
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
				{/* The stage fills the screen above the control bar: the page itself never scrolls. Below lg (phones,
				    tablets) with the chat open it keeps the top 40% (the chat sits under it, see ChatPanel); dvh follows the keyboard */}
				<main className={`flex-1 min-h-0 px-2 pt-2 sm:px-4 sm:pt-4 ${chatOpen ? "lg:pr-[26rem] max-lg:order-first max-lg:flex-none max-lg:h-[calc(var(--app-height,100dvh)*0.4)] max-lg:min-h-[160px]" : ""}`}>
					<div className="relative w-full h-full bg-black rounded-2xl overflow-hidden" {...fileDrop.handlers}>
						{fileDrop.over && <FileDropOverlay name={remoteName} />}
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
						{showRemote && (!remoteMedia.video || remoteMedia.paused) && bigStream === remoteStream && (
							<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-zinc-800 text-gray-300">
								{remoteMedia.hasCamera ? <FaVideoSlash size={40} /> : avatar(remoteName, "w-24 h-24 text-4xl")}
								<span>{remoteMedia.paused ? `${remoteName || "Their"}'s video is paused: weak connection` : remoteMedia.hasCamera ? "Camera off" : `${remoteName || "They"} has no camera`}</span>
							</div>
						)}
						{showRemote && (remoteName || !remoteMedia.audio) && (
							<span className="absolute bottom-4 left-4 max-w-[calc(100%-12rem)] flex items-center gap-1.5 px-2 py-1 rounded bg-black/60 text-white text-sm">
								{!remoteMedia.audio && <FaMicrophoneSlash className="shrink-0 text-red-400" title={remoteMedia.hasMic ? "Muted" : "No microphone"} />}
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
								{smallStream === remoteStream && (!remoteMedia.video || remoteMedia.paused) && (
									<div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-gray-300">
										{remoteMedia.hasCamera ? <FaVideoSlash size={24} /> : avatar(remoteName, "w-12 h-12 text-xl")}
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
							<div className={alone ? "absolute inset-0" : `absolute bottom-3 right-3 z-10 ${chatOpen ? "w-24" : "w-32"} sm:w-56 aspect-video border-white/70 border-2 rounded-lg overflow-hidden shadow-lg bg-zinc-800`}>
								<video
									autoPlay
									muted
									playsInline
									className="w-full h-full object-cover -scale-x-100"
									ref={(v) => v && v.srcObject !== myStream && (v.srcObject = myStream)}
								/>
								{(cameraOff || !hasCamera) && (
									<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-800 text-gray-300">
										{hasCamera ? <FaVideoSlash size={alone ? 40 : 24} /> : avatar(myName, alone ? "w-24 h-24 text-4xl" : "w-10 h-10 text-lg")}
										{alone && <span>{hasCamera ? "Your camera is off" : "You (no camera)"}</span>}
									</div>
								)}
								{!alone && <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-xs">{!hasCamera ? "You (no camera)" : isHost ? "You (host)" : "You"}</span>}
							</div>
						)}
						{!wide && status && (
							<div className="absolute top-3 left-3 z-10 px-2 py-1 rounded bg-black/60 text-white text-xs">{status}</div>
						)}
						{isScreen && (
							<div className={`absolute ${!wide && status ? "top-16" : "top-4"} left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold shadow flex items-center gap-2 whitespace-nowrap`}>
								<FaDesktop className="shrink-0" /> You are sharing your screen
							</div>
						)}
						{/* Reactions float up over the sender: theirs above their name, yours above your own tile */}
						{showRemote && <ReactionLayer mine={false} className="absolute z-20 bottom-12 left-4 w-24 h-0" />}
						{!alone && <ReactionLayer mine className={`absolute z-20 bottom-3 right-3 ${chatOpen ? "w-24" : "w-32"} sm:w-56 aspect-video`} />}
						{/* Small notices stack here, under what is already at the top (phone status, sharing, "Notify me"), so none covers another */}
						<div style={{ top: `${1 + 3 * ((!wide && status ? 1 : 0) + (isScreen ? 1 : 0) + (alone ? 1 : 0))}rem` }} className="absolute z-20 inset-x-2 flex flex-col items-center gap-2 pointer-events-none">
							{offline && (
								<div role="alert" className="max-w-full px-4 py-2 rounded-2xl bg-amber-500 text-black text-sm font-semibold shadow flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pointer-events-auto">
									You're offline
									{(hasCamera || hasMic) && <button type="button" onClick={turnOffDevices} className="underline">Turn off camera and mic</button>}
								</div>
							)}
							<MutedWarning stream={myStream} muted={muted} hint={`press ${keyText("mic")} or the mic button to unmute`} />
							{paused && (
								<div role="status" className="max-w-full px-4 py-2 rounded-full bg-amber-500 text-black text-sm font-semibold shadow text-center">
									Weak connection — video paused, audio continues
								</div>
							)}
						</div>
						{help && deviceTrouble[help] && (
							<DeviceHelp kind={help} trouble={deviceTrouble[help]} darkMode={darkMode} onClose={() => setHelp(null)} className="absolute z-30 bottom-3 left-1/2 -translate-x-1/2 w-[min(24rem,calc(100%-1.5rem))]" />
						)}
						{alone && !admission && <JoinNotice className={`absolute ${isScreen ? "top-16" : "top-4"} left-1/2 -translate-x-1/2 z-10`} />}
						{isHost && removing && removing === remoteSocketId && (
							<div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/60" onKeyDown={e => e.key === "Escape" && setRemoving(null)}>
								<div role="alertdialog" aria-modal="true" aria-label="Remove from the call" className={`w-full max-w-xs max-h-full overflow-y-auto p-4 rounded-xl shadow-2xl space-y-4 text-center ${darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"}`}>
									<p className="font-semibold break-words">Remove {remoteName || "this person"} from the call?</p>
									<div className="flex justify-center gap-3">
										<button type="button" autoFocus onClick={() => setRemoving(null)} className={`px-4 py-2 rounded-full font-semibold border ${darkMode ? "border-gray-600 hover:bg-gray-700" : "border-gray-300 hover:bg-gray-100"}`}>Cancel</button>
										<button type="button" onClick={removeRemote} className="px-4 py-2 rounded-full font-semibold bg-red-600 hover:bg-red-700 text-white">Remove</button>
									</div>
								</div>
							</div>
						)}
						{alone && (admission === "asking" || admission === "empty") && (
							<div role="status" className="absolute inset-0 z-20 flex items-center justify-center p-4 pointer-events-none">
								<div className="max-w-xs px-5 py-4 rounded-xl bg-black/75 text-white text-center space-y-3 pointer-events-auto">
									<p className={`font-semibold ${admission === "asking" ? "animate-pulse" : ""}`}>{admission === "asking" ? "Asking to join\u2026" : "Nobody is in the call right now"}</p>
									{admission === "asking" ? (
										<p className="text-sm opacity-80">You'll join when someone in the call lets you in.</p>
									) : (
										<button type="button" onClick={() => { setAdmission("joining"); joinRoom(); }} className="px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-700 font-semibold">Join now</button>
									)}
								</div>
							</div>
						)}
						{isHost && <JoinRequests requests={requests} darkMode={darkMode} onAdmit={id => answerRequest("room:admit", id)} onDeny={id => answerRequest("room:deny", id)} />}
						{infoOpen && !admission && (
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
					trouble={deviceTrouble}
					isScreen={isScreen}
					infoOpen={infoOpen}
					showInfo={admission !== "asking" && admission !== "empty"}
					onToggleMic={deviceTrouble.audio ? () => fixDevice("audio") : handleToggleMic}
					onToggleCamera={deviceTrouble.video ? () => fixDevice("video") : handleToggleCamera}
					onToggleShare={isScreen ? stopShare : startShare}
					onToggleInfo={() => setInfoOpen(!infoOpen)}
					onToggleDarkMode={toggleDarkMode}
					removeName={isHost && remoteSocketId ? remoteName || "the other person" : null}
					onRemove={() => setRemoving(remoteSocketId)}
					quality={qualityMode}
					onQuality={setQualityMode}
					onLeave={handleCutCall}
				/>
				<ChatPanel darkMode={darkMode} remoteName={remoteName} />
			</>
		)}
	</div>
);
};

export default RoomPage; //main
