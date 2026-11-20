import React, { useEffect, useState } from "react";

// m:ss, or h:mm:ss after an hour
const formatDuration = seconds => {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds / 60) % 60;
	const s = String(seconds % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const QUALITY = {
	good: { bars: 3, color: "bg-green-500", text: "Good" },
	fair: { bars: 2, color: "bg-yellow-400", text: "Fair" },
	poor: { bars: 1, color: "bg-red-500", text: "Poor" },
};

// rtt in seconds, loss as a fraction
const rateQuality = (rtt, loss) =>
	rtt < 0.15 && loss < 0.02 ? "good" : rtt < 0.4 && loss < 0.08 ? "fair" : "poor";

// RTT of the candidate pair in use, plus video packets received and lost so far
const readStats = report => {
	let pair;
	let received = 0;
	let lost = 0;
	report.forEach(s => {
		if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
		if (s.type === "inbound-rtp" && s.kind === "video") {
			received += s.packetsReceived || 0;
			lost += Math.max(0, s.packetsLost || 0);
		}
	});
	// Firefox has no transport stats and flags the pair instead
	if (!pair) report.forEach(s => { if (s.type === "candidate-pair" && s.selected) pair = s; });
	return { rtt: pair?.currentRoundTripTime, received, lost };
};

// Call timer and connection quality; mounted only while the call is connected
const CallStatus = ({ connection, since, reconnecting }) => {
	const [now, setNow] = useState(Date.now);
	const [quality, setQuality] = useState(null);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	// Every 2s: round-trip time and the share of video packets lost since the previous poll
	useEffect(() => {
		let active = true;
		let last = { received: 0, lost: 0 };
		const id = setInterval(async () => {
			let stats;
			try {
				stats = readStats(await connection.getStats());
			} catch {
				return; // connection closed
			}
			if (!active) return;
			const received = stats.received - last.received;
			const lost = Math.max(0, stats.lost - last.lost);
			last = stats;
			const loss = received + lost > 0 ? lost / (received + lost) : 0;
			if (stats.rtt !== undefined) setQuality(rateQuality(stats.rtt, loss));
		}, 2000);
		return () => {
			active = false;
			clearInterval(id);
		};
	}, [connection]);

	const q = QUALITY[quality];
	return (
		<div className="absolute top-4 left-4 flex items-center gap-3 px-3 py-1 rounded bg-black/60 text-white text-sm">
			<span className="tabular-nums">{formatDuration(Math.max(0, Math.floor((now - since) / 1000)))}</span>
			{reconnecting ? (
				<span className="text-yellow-300 animate-pulse">Reconnecting...</span>
			) : q && (
				<span className="flex items-center gap-1.5" title={`${q.text} connection`}>
					<span className="flex items-end gap-0.5 h-3">
						{[1, 2, 3].map(n => (
							<span key={n} className={`w-1 rounded-sm ${n <= q.bars ? q.color : "bg-white/30"}`} style={{ height: `${n * 33}%` }} />
						))}
					</span>
					{q.text}
				</span>
			)}
		</div>
	);
};

export default CallStatus;
