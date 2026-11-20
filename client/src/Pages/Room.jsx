import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaDesktop, FaVideo, FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";
import peer from "../Services/peer";
import { useSocket } from "../useContext/SocketProvider";
import { useLocation, useNavigate, useParams } from "react-router-dom";

const RoomPage = ({ darkMode, toggleDarkMode }) => {
	const { roomId } = useParams();
	const email = useLocation().state?.email;
	const navigate = useNavigate();
	const socket = useSocket();

	const [remoteSocketId, setRemoteSocketId] = useState(null);
	const [myStream, setMyStream] = useState(null);
	const [remoteStream, setRemoteStream] = useState(null);

	const [isScreen, setIsScreen] = useState(false);
	const [muted, setMuted] = useState(false);

	const myStreamRef = useRef(null);
	const callingRef = useRef(false);

	const handleCutCall = () => {
		if (myStreamRef.current) myStreamRef.current.getTracks().forEach(t => t.stop());
		socket.disconnect();
		window.location.href = "/";
	};

	// Join the room; the server replies with who is already there and the ICE servers to use
	const joinRoom = useCallback(() => {
		socket.emit("room:join", { email, room: roomId }, ({ full, peerId, iceServers }) => {
			if (full) {
				alert("This room is full.");
				return navigate("/");
			}
			peer.reset(iceServers);
			setRemoteSocketId(peerId);
		});
	}, [socket, email, roomId, navigate]);

	// Leaving the page (e.g. browser Back) frees the camera, the connection and our place in the room
	useEffect(() => {
		joinRoom();
		return () => {
			myStreamRef.current?.getTracks().forEach(t => t.stop());
			myStreamRef.current = null;
			peer.reset();
			socket.emit("room:leave", { room: roomId });
		};
	}, [joinRoom, socket, roomId]);

	// Send our ICE candidates to the other user and show their media when it arrives
	useEffect(() => {
		peer.onIceCandidate = candidate => socket.emit("ice:candidate", { to: remoteSocketId, candidate });
		peer.onTrack = setRemoteStream;
	}, [socket, remoteSocketId]);

	const handleUserJoined = useCallback(({ id }) => {
		setRemoteSocketId(id);
	}, []);

	// Call is over (other user left or our signaling dropped): back to a clean waiting state
	const handleUserLeft = useCallback(() => {
		myStreamRef.current?.getTracks().forEach(t => t.stop());
		myStreamRef.current = null;
		setMyStream(null);
		setRemoteStream(null);
		setRemoteSocketId(null);
		setIsScreen(false);
		setMuted(false);
		callingRef.current = false;
		joinRoom();
	}, [joinRoom]);

	// Camera + mic, added to the connection once per call
	const setupMedia = useCallback(async () => {
		if (myStreamRef.current) return;
		const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
		myStreamRef.current = stream;
		setMyStream(stream);
		stream.getTracks().forEach(t => peer.peer.addTrack(t, stream));
	}, []);

	// Outgoing call
	const handleCallUser = useCallback(async () => {
		if (callingRef.current) return; // ignore repeat clicks while the camera prompt is open
		callingRef.current = true;
		try {
			await setupMedia();
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
		await setupMedia();
		const ans = await peer.getAnswer();
		socket.emit("call:accepted", { to: from, ans });
	}, [socket, setupMedia]);

	const handleCallAccepted = useCallback(async ({ ans }) => {
		await peer.setRemoteDescription(ans);
	}, []);

	const handleIceCandidate = useCallback(({ candidate }) => {
		peer.peer.addIceCandidate(candidate).catch(e => console.error("ICE candidate failed", e));
	}, []);

	// Socket events
	useEffect(() => {
		socket.on("user:joined", handleUserJoined);
		socket.on("user:left", handleUserLeft);
		socket.on("incomming:call", handleIncomingCall);
		socket.on("call:accepted", handleCallAccepted);
		socket.on("ice:candidate", handleIceCandidate);
		socket.io.on("reconnect", handleUserLeft);
		return () => {
			socket.off("user:joined", handleUserJoined);
			socket.off("user:left", handleUserLeft);
			socket.off("incomming:call", handleIncomingCall);
			socket.off("call:accepted", handleCallAccepted);
			socket.off("ice:candidate", handleIceCandidate);
			socket.io.off("reconnect", handleUserLeft);
		};
	}, [socket, handleUserJoined, handleUserLeft, handleIncomingCall, handleCallAccepted, handleIceCandidate]);

	// Switch between screen & camera: only the video track is swapped, the mic keeps running
	const switchVideo = async toScreen => {
		try {
			const source = toScreen
				? await navigator.mediaDevices.getDisplayMedia({ video: true })
				: await navigator.mediaDevices.getUserMedia({ video: true });
			const [track] = source.getVideoTracks();
			const current = myStreamRef.current;
			if (!current) return track.stop();

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
				) : (
					<div className="px-4 py-2 rounded-full bg-green-100 text-green-800 font-semibold text-sm shadow inline-block">
						You are now connected! Enjoy your call 🎉
					</div>
				)}
			</div>

			<div className="relative w-full max-w-4xl h-[60vh] bg-black rounded-2xl overflow-hidden shadow-lg border-4 border-gray-700">
				{remoteStream && (
					<video
						autoPlay
						playsInline
						className="w-full h-full object-contain"
						ref={(v) => v && (v.srcObject = remoteStream)}
					/>
				)}
				{myStream && (
					<div className="absolute bottom-4 right-4 w-36 h-28 border-white border-2 rounded-lg overflow-hidden shadow-md">
						<video
							autoPlay
							muted
							playsInline
							className="w-full h-full object-cover"
							ref={(v) => v && (v.srcObject = myStream)}
						/>
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
