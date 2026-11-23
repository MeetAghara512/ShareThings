import React, { useEffect, useState } from "react";
import { useSocket } from "../useContext/SocketProvider";

// With fewer people online the site would look empty, so nothing is shown below this
const SHOW_ONLINE_FROM = 5;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "🟢 128 people online · 23 calls in progress" on the first page, from the server's live counter
const LiveCount = () => {
	const socket = useSocket();
	const [stats, setStats] = useState(null);

	useEffect(() => {
		const update = data => Number.isInteger(data?.online) && Number.isInteger(data?.calls) && setStats(data);
		socket.on("stats:update", update);
		socket.emit("stats:get", {}, update); // the first numbers may have come before this page opened
		return () => socket.off("stats:update", update);
	}, [socket]);

	if (!stats || stats.online < SHOW_ONLINE_FROM) return null;
	return (
		<p className="text-sm text-muted">
			<span aria-hidden="true">{"🟢 "}</span>
			{count(stats.online, "person", "people")} online {"·"} {count(stats.calls, "call", "calls")} in progress
		</p>
	);
};

export default LiveCount;
