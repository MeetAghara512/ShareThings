// The network check on the join screen, run only when the person clicks it. It measures two things: how long our
// server takes to answer, and whether a direct route to the other person is likely. It does not measure speed.

const PINGS = 5;
const PING_GAP = 300;
const PING_TIMEOUT = 2000;
const ROUTE_TIMEOUT = 5000;
const SETTLE = 800; // after the first public address: the second STUN server's answer comes within moments
// The server can be far away, so only an answer this slow (in ms) counts as a weak network
const SLOW = 800;
const LIMITED = "limited"; // the server's answer past its limit: says nothing about the network
// Only for this check, no relay login. Two servers show a router that picks a new port per destination (symmetric
// NAT), which direct connections usually cannot get through
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// "candidate:1 1 udp 1677729535 203.0.113.5 46154 typ srflx raddr 10.0.0.2 rport 52100 ..."
const CANDIDATE = /^candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)(?: raddr (\S+) rport (\d+))?/i;

// The public address a STUN server saw, and the local port it belongs to (hidden by some browsers: then 0)
const publicAddress = text => {
	const [, protocol, address, port, type, base, basePort] = CANDIDATE.exec(text) ?? [];
	if (type !== "srflx" || protocol?.toLowerCase() !== "udp") return null;
	return { at: `${address}:${port}`, base: Number(basePort) ? `${base}:${basePort}` : null };
};

// "relay" when no STUN server answered, or when one local port got a different public address for each server.
// "unknown" when the browser hid the local port, so the addresses cannot be compared
const routeFrom = found => {
	if (!found.length) return "relay";
	const seen = new Map();
	let hidden = false;
	for (const { at, base } of found) {
		if (!base) {
			hidden = true;
			continue;
		}
		if (seen.has(base) && seen.get(base) !== at) return "relay";
		seen.set(base, at);
	}
	return hidden ? "unknown" : "direct";
};

// Gathers routes on a connection of its own that never connects: the camera and the mic are not involved
const findRoute = signal => new Promise(resolve => {
	if (typeof RTCPeerConnection === "undefined" || signal.aborted) return resolve(null);
	const found = [];
	let pc, timer;
	const finish = route => {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		if (pc) {
			pc.onicecandidate = null;
			pc.close();
		}
		resolve(route);
	};
	const stop = () => finish(null);
	const done = () => finish(routeFrom(found));
	try {
		pc = new RTCPeerConnection({ iceServers: STUN });
		pc.onicecandidate = e => {
			if (!e.candidate) return done();
			const address = publicAddress(e.candidate.candidate);
			if (!address) return;
			found.push(address);
			if (routeFrom(found) === "relay") return done();
			if (found.length === 1) {
				clearTimeout(timer);
				timer = setTimeout(done, SETTLE);
			}
		};
		pc.createDataChannel("check"); // gives ICE something to gather for
		pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(stop);
	} catch {
		return stop();
	}
	timer = setTimeout(done, ROUTE_TIMEOUT);
	signal.addEventListener("abort", stop);
});

// stats:get is the cheapest thing the server already answers, so the check adds no new event to it
const ping = socket => new Promise(resolve => {
	if (!socket.connected) return resolve(null);
	const sent = performance.now();
	socket.timeout(PING_TIMEOUT).emit("stats:get", {}, (err, answer) => resolve(err ? null : answer?.limited ? LIMITED : performance.now() - sent));
});

const roundTrips = async (socket, signal) => {
	const times = [];
	while (times.length < PINGS && !signal.aborted) {
		if (times.length) await new Promise(wake => setTimeout(wake, PING_GAP));
		times.push(await ping(socket));
		if (times.at(-1) === LIMITED) break;
	}
	return times;
};

// { asked, answered, ms (the middle answer), route ("direct", "relay", "unknown", or null if not checked), good }, or { limited: true }
export const checkNetwork = async (socket, signal) => {
	const [times, route] = await Promise.all([roundTrips(socket, signal), findRoute(signal)]);
	if (times.includes(LIMITED)) return { limited: true };
	const answers = times.filter(t => t !== null).sort((a, b) => a - b);
	const ms = answers.length ? Math.round(answers[Math.floor(answers.length / 2)]) : null;
	return { asked: times.length, answered: answers.length, ms, route, good: answers.length === PINGS && ms < SLOW };
};
