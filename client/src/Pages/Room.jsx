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


  useEffect(() => {
    if (!roomId || !socket.id) return;

    socket.emit("room:check", {
      roomId,
      selfId: socket.id, // ✅ send your own socket ID
    });

    socket.on("room:user", (data) => {
      if (data.exists) {
        console.log("User present:", data.email, data.socketId, socket.id);
        setRemoteSocketId(data.socketId); // this is the *other* user
      } else {
        console.log("No user present");
      }
    });

    return () => {
      socket.off("room:user");
    };
  }, [roomId, socket.id, socket]);


  const handleUserJoined = useCallback(({ email, id }) => {
    // console.log(`Email ${email} joined room`);
    setRemoteSocketId(id);
  }, []);

  const handleCallUser = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: "user", // Uses front camera on mobile
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    const offer = await peer.getOffer();
    socket.emit("user:call", { to: remoteSocketId, offer });
    setMyStream(stream);
  }, [remoteSocketId, socket]);

  const handleIncomingCall = useCallback(
    async ({ from, offer }) => {
      setRemoteSocketId(from);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: "user", // Uses front camera on mobile
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      setMyStream(stream);
      // console.log("Incoming Call", from, offer);
      const ans = await peer.getAnswer(offer);
      socket.emit("call:accepted", { to: from, ans });
    },
    [socket]
  );

  const sendStreams = useCallback(() => {
    if (!peer.peer || !myStream) return;
    myStream.getTracks().forEach((track) => {
      peer.peer.addTrack(track, myStream);
    });
  }, [myStream]);

  const handleCallAccepted = useCallback(
    ({ from, ans }) => {
      peer.setLocalDescription(ans);
      // console.log("Call Accepted!");
      sendStreams();
    },
    [sendStreams]
  );

  const handleNegoNeeded = useCallback(async () => {
    const offer = await peer.getOffer();
    socket.emit("peer:nego:needed", { offer, to: remoteSocketId });
  }, [remoteSocketId, socket]);

  useEffect(() => {
    peer.peer.addEventListener("negotiationneeded", handleNegoNeeded);
    return () => {
      peer.peer.removeEventListener("negotiationneeded", handleNegoNeeded);
    };
  }, [handleNegoNeeded]);

  const handleNegoNeedIncoming = useCallback(
    async ({ from, offer }) => {
      const ans = await peer.getAnswer(offer);
      socket.emit("peer:nego:done", { to: from, ans });
    },
    [socket]
  );

  const handleNegoNeedFinal = useCallback(async ({ ans }) => {
    await peer.setLocalDescription(ans);
  }, []);

  useEffect(() => {
    peer.peer.addEventListener("track", async (ev) => {
      const remoteStream = ev.streams;
      // console.log("GOT TRACKS!!");
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
  }, [
    socket,
    handleUserJoined,
    handleIncomingCall,
    handleCallAccepted,
    handleNegoNeedIncoming,
    handleNegoNeedFinal,
  ]);

  return (
    <div
      className={`min-h-screen transition-colors duration-500 ${darkMode ? "bg-gray-900 text-gray-100" : "bg-white text-gray-900"
        } max-w-5xl mx-auto p-6`}
    >
      {/* Dark/Light Mode Toggle */}
      <div className="flex justify-end mb-4">
        <button
          onClick={toggleDarkMode}
          className={`p-2 rounded-md shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 ${darkMode
            ? "bg-yellow-400 text-gray-900 hover:bg-yellow-500 focus:ring-yellow-300"
            : "bg-gray-800 text-white hover:bg-gray-700 focus:ring-gray-500"
            } transition`}
          aria-label="Toggle Dark Mode"
          title="Toggle Dark Mode"
        >
          {darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
        </button>
      </div>

      <h1 className="text-4xl font-bold mb-6 text-center">Room Page</h1>

      <h4 className="text-lg mb-6 text-center">
        {remoteSocketId ? (
          <span className="text-green-400 font-semibold">Connected</span>
        ) : (
          <span className="text-red-500 font-semibold">No one in room</span>
        )}
      </h4>

      <div className="flex justify-center space-x-4 mb-8">
        {remoteSocketId && (
          <button
            onClick={handleCallUser}
            className="bg-blue-600 hover:bg-blue-700 active:scale-95 transform transition duration-200
              text-white font-medium py-2 px-6 rounded-md shadow-md flex items-center space-x-2"
            title="Call User"
            aria-label="Call User"
          >
            <FaPhone />
            <span>Call</span>
          </button>
        )}
        {myStream && (
          <button
            onClick={sendStreams}
            className="bg-green-600 hover:bg-green-700 active:scale-95 transform transition duration-200
              text-white font-medium py-2 px-6 rounded-md shadow-md flex items-center space-x-2"
            title="Send Stream"
            aria-label="Send Stream"
          >
            <FaPaperPlane />
            <span>Send Stream</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {myStream && (
          <div
            className={`flex flex-col items-center p-4 rounded-lg shadow-lg transition-transform duration-300
            hover:scale-[1.03] hover:shadow-xl
            ${darkMode ? "bg-gray-800 border border-gray-700" : "bg-white border border-gray-300"}`}
          >
            <h2 className="text-2xl font-semibold mb-3">My Screen Share</h2>
            <video
              autoPlay
              muted
              playsInline
              className="rounded border border-gray-400 shadow-md w-full max-w-md"
              height="300"
              width="500"
              ref={(video) => {
                if (video) video.srcObject = myStream;
              }}
            />
          </div>
        )}

        {remoteStream && (
          <div
            className={`flex flex-col items-center p-4 rounded-lg shadow-lg transition-transform duration-300
            hover:scale-[1.03] hover:shadow-xl
            ${darkMode ? "bg-gray-800 border border-gray-700" : "bg-white border border-gray-300"}`}
          >
            <h2 className="text-2xl font-semibold mb-3">Remote Screen Share</h2>
            <video
              autoPlay
              playsInline
              className="rounded border border-gray-400 shadow-md w-full max-w-md"
              height="300"
              width="500"
              ref={(video) => {
                if (video) video.srcObject = remoteStream;
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default RoomPage;