import React, { useEffect, useState } from "react";
import { FaRedo } from "react-icons/fa";
import { useSocketStatus } from "../useContext/SocketProvider";

// A calm line while the server cannot be reached yet (the free server sleeps when idle), hidden once connected.
// Waits 1.5 s first, so a normal start never flashes it
const ServerStatus = () => {
	const { status, retry } = useSocketStatus();
	const [slow, setSlow] = useState(false);

	useEffect(() => {
		setSlow(false);
		if (status !== "connecting") return;
		const id = setTimeout(() => setSlow(true), 1500);
		return () => clearTimeout(id);
	}, [status]);

	if (status === "failed") {
		return (
			<p role="alert" className="text-sm text-red-500 flex flex-wrap items-center gap-x-2 gap-y-1">
				Can't reach the server. Check your internet, or try again.
				<button type="button" onClick={retry} className="inline-flex items-center gap-1.5 font-semibold underline hover:text-red-400">
					<FaRedo className="text-xs" /> Retry
				</button>
			</p>
		);
	}
	if (status !== "connecting" || !slow) return null;
	return (
		<p role="status" className="text-sm text-amber-500 animate-pulse">
			Waking up the server… this can take up to a minute the first time
		</p>
	);
};

export default ServerStatus;
