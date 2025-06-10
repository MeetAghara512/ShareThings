import React, { useEffect, useCallback, useState } from "react";
import { FaMoon, FaSun, FaPhone, FaPaperPlane } from "react-icons/fa";
import peer from "../Services/peer";
import { useSocket } from "../useContext/SocketProvider";
import { useParams } from "react-router-dom";

const RoomPage = ({ darkMode, toggleDarkMode }) => {
  const { roomId } = useParams();
  const socket = useSocket();
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [myStream, setMyStream] = useState();
  const [remoteStream, setRemoteStream] = useState();

  const handleCutCall = () => {
    if (myStream) {
      myStream.getTracks().forEach((track) => track.stop());
    }
    socket.disconnect();
    window.location.href = "https://sharethings-web.onrender.com";
  };

  useEffect(() => {
    if (!roomId || !socket.id) return;
    socket.emit("room:check", { roomId, selfId: socket.id });
    socket.on("room:user", (data) => {
      if (data.exists) setRemoteSocketId(data.socketId);
    });
    return () => socket.off("room:user");
  }, [roomId, socket.id, socket]);

  const handleUserJoined = useCallback(({ id }) => {
    setRemoteSocketId(id);
  }, []);

  const handleCallUser = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const offer = await peer.getOffer();
    socket.emit("user:call", { to: remoteSocketId, offer });
    setMyStream(stream);
  }, [remoteSocketId, socket]);

  const handleIncomingCall = useCallback(
    async ({ from, offer }) => {
      setRemoteSocketId(from);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      setMyStream(stream);
      const ans = await peer.getAnswer(offer);
      socket.emit("call:accepted", { to: from, ans });
    },
    [socket]
  );

  const sendStreams = useCallback(() => {
    if (!peer.peer || !myStream) return;
    myStream.getTracks().forEach((track) => peer.peer.addTrack(track, myStream));
  }, [myStream]);

  const handleCallAccepted = useCallback(({ ans }) => {
    peer.setLocalDescription(ans);
    sendStreams();
  }, [sendStreams]);

  const handleNegoNeeded = useCallback(async () => {
    const offer = await peer.getOffer();
    socket.emit("peer:nego:needed", { offer, to: remoteSocketId });
  }, [remoteSocketId, socket]);

  useEffect(() => {
    peer.peer.addEventListener("negotiationneeded", handleNegoNeeded);
    return () => peer.peer.removeEventListener("negotiationneeded", handleNegoNeeded);
  }, [handleNegoNeeded]);

  const handleNegoNeedIncoming = useCallback(async ({ from, offer }) => {
    const ans = await peer.getAnswer(offer);
    socket.emit("peer:nego:done", { to: from, ans });
  }, [socket]);

  const handleNegoNeedFinal = useCallback(async ({ ans }) => {
    await peer.setLocalDescription(ans);
  }, []);

  useEffect(() => {
    peer.peer.addEventListener("track", async (ev) => {
      const remoteStream = ev.streams;
      setRemoteStream(remoteStream[0]);
    });
  }, []);

  useEffect(() => {
    socket.on("user:joined", handleUserJoined);
    socket.on("incomming:call", handleIncomingCall);
    socket.on("call:accepted", handleCallAccepted);
    socket.on("peer:nego:needed", handleNegoNeedIncoming);
    socket.on("peer:nego:final", handleNegoNeedFinal);
    return () => {
      socket.off("user:joined", handleUserJoined);
      socket.off("incomming:call", handleIncomingCall);
      socket.off("call:accepted", handleCallAccepted);
      socket.off("peer:nego:needed", handleNegoNeedIncoming);
      socket.off("peer:nego:final", handleNegoNeedFinal);
    };
  }, [socket, handleUserJoined, handleIncomingCall, handleCallAccepted, handleNegoNeedIncoming, handleNegoNeedFinal]);

  return (
    <div className={`min-h-screen w-full flex flex-col transition-colors duration-500 ${darkMode ? "bg-zinc-900 text-white" : "bg-gray-100 text-gray-900"}`}>
      
      <div className="flex justify-between items-center p-4 shadow-md">
        <h2 className="text-xl font-bold">Video Call Room</h2>
        <button onClick={toggleDarkMode} className="rounded-full p-2 transition-all hover:scale-110">
          {darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
        </button>
      </div>

      <div className="flex flex-col items-center justify-center flex-grow px-4 py-2">
        <div className="mb-4 text-center">
          <p className="text-lg">
            {remoteSocketId ? (
              <span className="text-green-400 font-medium">Connected</span>
            ) : (
              <span className="text-red-500 font-medium">Waiting for user...</span>
            )}
          </p>
        </div>

        <div className="relative w-full max-w-5xl h-[70vh] rounded-xl overflow-hidden border border-gray-400 shadow-lg bg-black">
          {remoteStream && (
            <video
              autoPlay
              playsInline
              className="w-full h-full object-contain"
              ref={(video) => {
                if (video) video.srcObject = remoteStream;
              }}
            />
          )}

          {myStream && (
            <div className="absolute bottom-4 right-4 w-32 h-24 sm:w-40 sm:h-32 border-2 border-white rounded-md shadow-xl overflow-hidden z-20">
              <video
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
                ref={(video) => {
                  if (video) video.srcObject = myStream;
                }}
              />
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-4 flex-wrap justify-center">
          {remoteSocketId && !myStream && (
            <button onClick={handleCallUser} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-full shadow-md flex items-center gap-2">
              <FaPhone />
              Call
            </button>
          )}
          {myStream && (
            <>
              <button onClick={sendStreams} className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-full shadow-md flex items-center gap-2">
                <FaPaperPlane />
                Send Stream
              </button>
              <button onClick={handleCutCall} className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full shadow-md flex items-center gap-2">
                <FaPhone />
                End Call
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RoomPage;
