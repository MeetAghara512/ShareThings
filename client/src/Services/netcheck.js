// The network check on the join screen, run only when the person clicks it: how reliably and how fast our server answers.

const PINGS = 5;
const PING_GAP = 300;
const PING_TIMEOUT = 2000;
// The server can be far away, so only an answer this slow (in ms) counts as a weak network
const SLOW = 800;
const LIMITED = "limited"; // the server's answer past its limit: says nothing about the network

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

// { good }, or { limited: true }
export const checkNetwork = async (socket, signal) => {
	const times = await roundTrips(socket, signal);
	if (times.includes(LIMITED)) return { limited: true };
	const answers = times.filter(t => t !== null).sort((a, b) => a - b);
	return { good: answers.length === PINGS && answers[Math.floor(PINGS / 2)] < SLOW };
};
