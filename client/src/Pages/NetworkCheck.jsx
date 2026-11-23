import React, { useEffect, useRef, useState } from "react";
import { useSocket, useSocketStatus } from "../useContext/SocketProvider";
import { checkNetwork } from "../Services/netcheck";

const ROUTE_TEXT = {
	direct: "A direct connection is likely",
	relay: "Your call may need to go through a relay",
	unknown: "Could not tell whether a direct connection is likely",
};

// "Good / Weak network" on the join screen. Nothing runs until the button is clicked
const NetworkCheck = () => {
	const socket = useSocket();
	const { status } = useSocketStatus();
	const [checking, setChecking] = useState(false);
	const [result, setResult] = useState(null);
	const runRef = useRef(null);

	useEffect(() => () => runRef.current?.abort(), []); // Join pressed during a check: stop it

	const run = async () => {
		const current = runRef.current = new AbortController();
		setChecking(true);
		setResult(null);
		const answer = await checkNetwork(socket, current.signal);
		if (current.signal.aborted) return;
		setResult(answer);
		setChecking(false);
	};

	return (
		<div className="space-y-1 text-sm">
			<button
				type="button"
				onClick={run}
				disabled={checking || status !== "connected"}
				className="font-medium text-indigo-500 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
			>
				{checking ? "Checking network…" : result ? "Check again" : "Check my network"}
			</button>
			<div aria-live="polite">
				{result?.limited && <p className="font-medium text-amber-500">Too many checks, try again in a minute</p>}
				{result && !result.limited && (
					<>
						<p className={`font-medium ${result.good ? "text-green-500" : "text-amber-500"}`}>{result.good ? "Good network" : "Weak network"}</p>
						<p className="opacity-70">
							{result.answered ? `Server answered ${result.answered} of ${result.asked} checks, typically in ${result.ms} ms` : "The server did not answer"}
						</p>
						{ROUTE_TEXT[result.route] && <p className="opacity-70">{ROUTE_TEXT[result.route]}</p>}
						<p className="opacity-60">Upload and download speed are not measured.</p>
					</>
				)}
			</div>
		</div>
	);
};

export default NetworkCheck;
