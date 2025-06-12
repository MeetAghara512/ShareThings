import React, { useEffect, useCallback, useRef, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaDesktop, FaVideo, FaMicrophone, FaMicrophoneSlash } from "react-icons/fa";
import peer from "../Services/peer";
import { useSocket } from "../useContext/SocketProvider";
import { useParams } from "react-router-dom";

const RoomPage = ({ darkMode, toggleDarkMode }) => {
  const { roomId } = useParams();
  const socket = useSocket();

  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [myStream, setMyStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  // ▶️ Start with screen share
  const [isScreen, setIsScreen] = useState(false);
  const [muted, setMuted] = useState(false);

  const myStreamRef = useRef(null);
  const tracksAddedRef = useRef(false);

  const handleCutCall = () => {
    if (myStreamRef.current) myStreamRef.current.getTracks().forEach(t => t.stop());
    socket.disconnect();
    window.location.href = "https://sharethings-web.onrender.com";
  };

  // Room join logic
  useEffect(() => {
    if (!roomId || !socket.id) return;
    socket.emit("room:check", { roomId, selfId: socket.id });
    socket.on("room:user", ({ exists, socketId }) => {
      if (exists) setRemoteSocketId(socketId);
    });
    return () => socket.off("room:user");
  }, [roomId, socket]);

  const handleUserJoined = useCallback(({ id }) => {
    setRemoteSocketId(id);
  }, []);

  // Helpers to get streams
  const getScreenStream = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const getCameraStream = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  // Replace tracks without renegotiation
  const replaceTracks = async newStream => {
    const senders = peer.peer.getSenders();
    newStream.getAudioTracks().forEach(track => {
      const s = senders.find(s => s.track?.kind === "audio");
      if (s) s.replaceTrack(track);
    });
    newStream.getVideoTracks().forEach(track => {
      const s = senders.find(s => s.track?.kind === "video");
      if (s) s.replaceTrack(track);
    });
  };

  // Initial setup: add tracks/transceivers once
  const setupMedia = useCallback(async () => {
    if (myStreamRef.current) return myStreamRef.current;

    const stream = isScreen
      ? await getScreenStream()
      : await getCameraStream();

    myStreamRef.current = stream;
    setMyStream(stream);

    if (!tracksAddedRef.current) {
      peer.peer.addTransceiver("audio", { direction: "sendrecv" });
      peer.peer.addTransceiver("video", { direction: "sendrecv" });
      stream.getAudioTracks().forEach(t => peer.peer.addTrack(t, stream));
      stream.getVideoTracks().forEach(t => peer.peer.addTrack(t, stream));
      tracksAddedRef.current = true;
    }

    return stream;
  }, [isScreen]);

  // Outgoing call
  const handleCallUser = useCallback(async () => {
    await setupMedia();
    const offer = await peer.getOffer();
    socket.emit("user:call", { to: remoteSocketId, offer });
  }, [remoteSocketId, socket, setupMedia]);

  // Incoming call
  const handleIncomingCall = useCallback(async ({ from, offer }) => {
    await setupMedia();
    await peer.setRemoteDescription(offer);
    const ans = await peer.getAnswer(offer);
    socket.emit("call:accepted", { to: from, ans });
  }, [socket, setupMedia]);

  const handleCallAccepted = useCallback(async ({ ans }) => {
    await peer.setRemoteDescription(ans);
  }, []);

  // Renegotiation
  const handleNegoNeeded = useCallback(async () => {
    const offer = await peer.getOffer();
    socket.emit("peer:nego:needed", { offer, to: remoteSocketId });
  }, [remoteSocketId, socket]);

  useEffect(() => {
    peer.peer.addEventListener("negotiationneeded", handleNegoNeeded);
    return () => peer.peer.removeEventListener("negotiationneeded", handleNegoNeeded);
  }, [handleNegoNeeded]);

  const handleNegoIncoming = useCallback(async ({ from, offer }) => {
    await peer.setRemoteDescription(offer);
    const ans = await peer.getAnswer(offer);
    socket.emit("peer:nego:done", { to: from, ans });
  }, [socket]);

  const handleNegoFinal = useCallback(async ({ ans }) => {
    await peer.setRemoteDescription(ans);
  }, []);

  // Remote track
  useEffect(() => {
    peer.peer.addEventListener("track", ev => setRemoteStream(ev.streams[0]));
  }, []);

  // Socket events
  useEffect(() => {
    socket.on("user:joined", handleUserJoined);
    socket.on("incomming:call", handleIncomingCall);
    socket.on("call:accepted", handleCallAccepted);
    socket.on("peer:nego:needed", handleNegoIncoming);
    socket.on("peer:nego:final", handleNegoFinal);
    return () => {
      socket.off("user:joined", handleUserJoined);
      socket.off("incomming:call", handleIncomingCall);
      socket.off("call:accepted", handleCallAccepted);
      socket.off("peer:nego:needed", handleNegoIncoming);
      socket.off("peer:nego:final", handleNegoFinal);
    };
  }, [socket, handleUserJoined, handleIncomingCall, handleCallAccepted, handleNegoIncoming, handleNegoFinal]);

  // Toggle between screen & camera
  const handleToggleShare = useCallback(async () => {
    try {
      const newStream = isScreen
        ? await getCameraStream()
        : await getScreenStream();

      myStreamRef.current.getTracks().forEach(t => t.stop());
      myStreamRef.current = newStream;
      setMyStream(newStream);
      setIsScreen(!isScreen);
      await replaceTracks(newStream);
    } catch (e) {
      console.error("Toggle share failed", e);
    }
  }, [isScreen]);

  // Toggle mic on/off
  const handleToggleMic = () => {
    if (!myStreamRef.current) return;
    const enabled = !muted;
    myStreamRef.current.getAudioTracks().forEach(track => track.enabled = enabled);
    setMuted(!muted);
  };

  return (
    <div className={`min-h-screen flex flex-col ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
      <header className="flex justify-between items-center p-4 shadow border-b">
        <h2 className="text-xl font-bold">Video Call Room</h2>
        <button onClick={toggleDarkMode} className="p-2">
          {darkMode ? <FaSun /> : <FaMoon />}
        </button>
      </header>

      <main className="flex-grow flex flex-col items-center justify-center p-6">
        <p className="mb-4 text-lg">
          {remoteSocketId
            ? <span className="text-green-400">Connected</span>
            : <span className="text-red-500">Waiting for user...</span>}
        </p>

        <div className="relative w-full max-w-4xl h-[60vh] bg-black rounded overflow-hidden">
          {remoteStream && (
            <video
              autoPlay
              playsInline
              className="w-full h-full object-contain"
              ref={v => v && (v.srcObject = remoteStream)}
            />
          )}
          {myStream && (
            <div className="absolute bottom-4 right-4 w-32 h-24 border-white border-2 rounded overflow-hidden">
              <video
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
                ref={v => v && (v.srcObject = myStream)}
              />
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-4">
          {!myStream && remoteSocketId && (
            <button
              onClick={handleCallUser}
              className="bg-blue-600 text-white px-6 py-2 rounded-full flex items-center gap-2"
            >
              <FaPhone /> Call
            </button>
          )}

          {myStream && (
            <>
              <button
                onClick={handleToggleShare}
                className="bg-gray-700 text-white px-4 py-2 rounded-full flex items-center gap-2"
              >
                {isScreen ? <FaVideo /> : <FaDesktop />} 
                {isScreen ? "Use Camera" : "Share Screen"}
              </button>

              <button
                onClick={handleToggleMic}
                className="bg-gray-700 text-white px-4 py-2 rounded-full flex items-center gap-2"
              >
                {muted ? <FaMicrophoneSlash /> : <FaMicrophone />} 
                {muted ? "Unmute" : "Mute"}
              </button>

              <button
                onClick={handleCutCall}
                className="bg-red-600 text-white px-6 py-2 rounded-full flex items-center gap-2"
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

export default RoomPage;
