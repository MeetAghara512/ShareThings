import React from "react";
import { useState, useCallback, useEffect } from "react";
import { useSocket } from "../useContext/SocketProvider";
import { useNavigate } from "react-router-dom";
import { FaMoon, FaSun } from "react-icons/fa"; // for dark/light toggle icons

const Lobby = ({ darkMode, toggleDarkMode }) => {
  const [email, setEmail] = useState("");
  const [room, setRoom] = useState("");
  const socket = useSocket();
  const navigate = useNavigate();

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      socket.emit("room:join", { email, room });
      // console.log(email, 
      // room);
    },
    [email, room, socket]
  );

  const handleJoinRoom = useCallback(
    (data) => {
      const { email, room } = data;
      console.log(email, room);
      navigate(`/room/${room}`);
    },
    [navigate]
  );

  useEffect(() => {
    socket.on("room:join", handleJoinRoom);
    return () => {
      socket.off("room:join", handleJoinRoom);
    };
  }, [socket, handleJoinRoom]);

return (
  <>
    <div className="flex justify-end max-w-md mx-auto pt-6 px-4 sm:pt-10 sm:px-0">
      <button
        onClick={toggleDarkMode}
        className={`p-2 rounded-md shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 ${
          darkMode
            ? "bg-yellow-400 text-gray-900 hover:bg-yellow-500 focus:ring-yellow-300"
            : "bg-gray-800 text-white hover:bg-gray-700 focus:ring-gray-500"
        } transition`}
        aria-label="Toggle Dark Mode"
        title="Toggle Dark Mode"
      >
        {darkMode ? <FaSun size={20} /> : <FaMoon size={20} />}
      </button>
    </div>

    <div
      className={`text-3xl sm:text-4xl font-bold text-center my-6 sm:my-8 ${
        darkMode ? "text-indigo-300" : "text-indigo-600"
      }`}
    >
      Lobby Screen
    </div>

    <form
      onSubmit={handleSubmit}
      className={`max-w-xs sm:max-w-md mx-auto p-6 sm:p-8 rounded-lg shadow-md space-y-5 sm:space-y-6 ${
        darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900"
      }`}
    >
      <div>
        <label
          htmlFor="email"
          className={`block text-sm sm:text-base font-medium mb-1 sm:mb-2 ${
            darkMode ? "text-gray-300" : "text-gray-700"
          }`}
        >
          Email
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`w-full px-3 py-2 sm:px-4 sm:py-2 border rounded-md focus:outline-none focus:ring-2 ${
            darkMode
              ? "border-gray-600 bg-gray-700 focus:ring-indigo-400 text-gray-100"
              : "border-gray-300 focus:ring-indigo-500 text-gray-900"
          } text-sm sm:text-base`}
          placeholder="you@example.com"
          required
        />
      </div>

      <div>
        <label
          htmlFor="room"
          className={`block text-sm sm:text-base font-medium mb-1 sm:mb-2 ${
            darkMode ? "text-gray-300" : "text-gray-700"
          }`}
        >
          Room Number
        </label>
        <input
          type="text"
          id="room"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          className={`w-full px-3 py-2 sm:px-4 sm:py-2 border rounded-md focus:outline-none focus:ring-2 ${
            darkMode
              ? "border-gray-600 bg-gray-700 focus:ring-indigo-400 text-gray-100"
              : "border-gray-300 focus:ring-indigo-500 text-gray-900"
          } text-sm sm:text-base`}
          placeholder="Enter room number"
          required
        />
      </div>

      <button
        type="submit"
        className="w-full bg-indigo-600 text-white py-2.5 sm:py-3 rounded-md hover:bg-indigo-700 transition font-semibold text-sm sm:text-base"
      >
        Join
      </button>
    </form>
  </>
);
};
export default Lobby;