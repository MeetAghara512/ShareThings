import React, { useEffect, useRef, useState } from "react";
import { MdCheckCircle, MdWarning } from "react-icons/md";
import { useSocket, useSocketStatus } from "../useContext/SocketProvider";
import { checkNetwork } from "../Services/netcheck";

const RESULTS = {
	good: { Icon: MdCheckCircle, color: "text-green-500", text: "Good network" },
	weak: { Icon: MdWarning, color: "text-amber-500", text: "Weak network" },
	limited: { Icon: MdWarning, color: "text-amber-500", text: "Try again in a minute" },
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

	const shown = result && RESULTS[result.limited ? "limited" : result.good ? "good" : "weak"];
	return (
		<div className="flex flex-wrap items-center text-sm">
			<span aria-live="polite">
				{shown && <span className={`inline-flex items-center gap-1 mr-3 font-medium ${shown.color}`}><shown.Icon aria-hidden="true" /> {shown.text}</span>}
			</span>
			<button
				type="button"
				onClick={run}
				disabled={checking || status !== "connected"}
				className="font-medium text-accent-ink hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
			>
				{checking ? "Checking…" : result ? "Check again" : "Check my network"}
			</button>
		</div>
	);
};

export default NetworkCheck;
