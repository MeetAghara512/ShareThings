import React, { useEffect, useState } from "react";
import { FaRedo } from "react-icons/fa";
import { useSocket } from "../useContext/SocketProvider";
import peer from "../Services/peer";

// Bump when client and server must change together (same number as PROTOCOL_VERSION in server/index.js).
// The server sends its number on every new connection ("app:version")
export const PROTOCOL_VERSION = 1;
// No number this long after connecting: the server is from before this check, so older than this tab
const SILENT_SERVER = 5000;

const inCall = () => ["connecting", "connected", "disconnected"].includes(peer.peer?.connectionState);

// A line at the top when this tab and the server speak different versions, typically a tab opened before a
// deploy. It never reloads by itself: during a call the reload is only offered, for after the call
const VersionBanner = () => {
	const socket = useSocket();
	const [server, setServer] = useState(PROTOCOL_VERSION);
	const [calling, setCalling] = useState(inCall);

	useEffect(() => {
		let timer;
		const onVersion = data => {
			clearTimeout(timer);
			if (Number.isInteger(data?.version)) setServer(data.version);
		};
		const onConnect = () => {
			clearTimeout(timer);
			timer = setTimeout(() => setServer(0), SILENT_SERVER);
		};
		socket.on("app:version", onVersion);
		socket.on("connect", onConnect);
		if (socket.connected) onConnect();
		return () => {
			clearTimeout(timer);
			socket.off("app:version", onVersion);
			socket.off("connect", onConnect);
		};
	}, [socket]);

	// Only while the versions differ: is a call going on right now?
	const differs = server !== PROTOCOL_VERSION;
	useEffect(() => {
		if (!differs) return;
		setCalling(inCall());
		const id = setInterval(() => setCalling(inCall()), 2000);
		return () => clearInterval(id);
	}, [differs]);

	if (!differs) return null;
	if (server < PROTOCOL_VERSION) {
		return (
			<p role="status" className="px-4 py-2 text-center text-sm font-medium bg-amber-500 text-black">
				The server is updating, try again in a minute
			</p>
		);
	}
	return (
		<p role="status" className="px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm font-medium bg-indigo-600 text-white">
			{calling ? "A new version of ShareThings is available. Reload after your call, so it is not cut off" : "A new version of ShareThings is available —"}
			<button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white text-indigo-700 font-semibold hover:bg-indigo-50">
				<FaRedo className="text-xs" /> {calling ? "Reload now" : "Reload"}
			</button>
		</p>
	);
};

export default VersionBanner;
