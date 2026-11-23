import React, { useEffect, useRef, useState } from "react";
import { setCallStats } from "../Services/files";

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

// RTT of the candidate pair in use, plus video packets received and lost so far. Also whether the
// pair goes through a relay server, and its estimated upload speed (for file sharing); and for what we
// send, the share the other side reports lost (worst of audio and video) and the bytes sent per video lane
const readStats = report => {
	let pair;
	let received = 0;
	let lost = 0;
	let sentLoss = 0;
	const sentBytes = {};
	report.forEach(s => {
		if (s.type === "remote-inbound-rtp") sentLoss = Math.max(sentLoss, s.fractionLost || 0);
		if (s.type === "outbound-rtp" && s.kind === "video") sentBytes[s.mid] = s.bytesSent;
		if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
		if (s.type === "inbound-rtp" && s.kind === "video") {
			received += s.packetsReceived || 0;
			lost += Math.max(0, s.packetsLost || 0);
		}
	});
	// Firefox has no transport stats and flags the pair instead
	if (!pair) report.forEach(s => { if (s.type === "candidate-pair" && s.selected) pair = s; });
	const relay = [pair?.localCandidateId, pair?.remoteCandidateId].some(id => report.get(id)?.candidateType === "relay");
	return { rtt: pair?.currentRoundTripTime, received, lost, relay, bitrate: pair?.availableOutgoingBitrate, sentLoss, sentBytes };
};

// Call timer and connection quality, in the control bar; mounted only while the call is connected.
// onStats gets every poll's numbers (adaptive quality uses them, so the stats are read only once)
const CallStatus = ({ connection, since, reconnecting, onStats }) => {
	const [now, setNow] = useState(Date.now);
	const [quality, setQuality] = useState(null);
	const [theirs, setTheirs] = useState(false); // our side is better than the rating: it is their video that arrives badly
	const onStatsRef = useRef(onStats);
	onStatsRef.current = reconnecting ? null : onStats; // a dropped connection is handled by the reconnect, not by lowering video

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
			if (stats.rtt === undefined) return;
			const rated = rateQuality(stats.rtt, loss);
			setQuality(rated);
			setTheirs(QUALITY[rateQuality(stats.rtt, stats.sentLoss)].bars > QUALITY[rated].bars);
			setCallStats({ quality: rated, relay: stats.relay, bitrate: stats.bitrate }); // files slow down when Poor
			onStatsRef.current?.({ quality: rated, rtt: stats.rtt, loss, sentLoss: stats.sentLoss, sentBytes: stats.sentBytes, at: Date.now() });
		}, 2000);
		return () => {
			active = false;
			clearInterval(id);
			setCallStats(null);
		};
	}, [connection]);

	const q = QUALITY[quality];
	return (
		<div className="flex items-center gap-3 min-w-0">
			<span className="tabular-nums">{formatDuration(Math.max(0, Math.floor((now - since) / 1000)))}</span>
			{reconnecting ? (
				<span className="text-yellow-500 animate-pulse">Reconnecting...</span>
			) : q && (
				<span className="flex items-center gap-1.5 min-w-0" title={theirs ? "Their video is weak" : `${q.text} connection`}>
					<span className="flex items-end gap-0.5 h-3 shrink-0">
						{[1, 2, 3].map(n => (
							<span key={n} className={`w-1 rounded-sm ${n <= q.bars ? q.color : "bg-gray-400/40"}`} style={{ height: `${n * 33}%` }} />
						))}
					</span>
					{theirs ? "Their video is weak" : q.text}
				</span>
			)}
		</div>
	);
};

export default CallStatus;
