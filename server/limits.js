// Limits per internet address, so one address cannot flood the free server with connections, joins or
// "who is here" checks. Counts are kept over a sliding window in the store (see store.js): in this process's memory,
// or in Redis when REDIS_URL is set.

const { isIP } = require("net");
const { getStore } = require("./store");

const WINDOW_MS = Number(process.env.LIMIT_WINDOW_MS) || 60 * 1000; // a shorter window can be set for tests
const MAX_CONNECTIONS = 30; // new socket connections per address
const MAX_JOINS = 30; // room:join per address
const MAX_PEEKS = 120; // room:peek per address: generous, since a whole office can share one address
const MAX_PEEKS_PER_SOCKET = 30; // room:peek per socket: an open join screen asks every 4 s, 15 times a minute
const MAX_STATS_PER_SOCKET = 60; // stats:get per socket: the first page asks once, a network check 5 times
const TOO_MANY = "Too many attempts, wait a minute and try again";

const ipOf = value => (typeof value === "string" && isIP(value.trim()) ? value.trim() : null);

// One key per client: IPv4 as it is (also when written as ::ffff:a.b.c.d), IPv6 by its /64, the block one customer gets
function addressKey(address) {
  const plain = String(address).split("%")[0];
  if (isIP(plain) !== 6) return address;
  const [head, tail] = new URL(`http://[${plain}]`).hostname.slice(1, -1).split("::"); // lower case, no leading zeros, IPv4 part in hex
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.slice(0, 5).every(g => g === "0") && groups[5] === "ffff") {
    const [high, low] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// The client's internet address. On Render (which always sets RENDER) every request passes Cloudflare, which
// overwrites cf-connecting-ip. Anywhere else a client could send that header itself, so it is ignored there.
// A client can also write anything at the start of x-forwarded-for: only the last entry, added by our own proxy, counts
function clientAddress(socket) {
  const { "cf-connecting-ip": edgeIp, "x-forwarded-for": forwardedFor } = socket.handshake.headers;
  return addressKey((process.env.RENDER && ipOf(edgeIp)) || (typeof forwardedFor === "string" && ipOf(forwardedFor.split(",").pop())) || socket.handshake.address);
}

// A direct connection from this machine (local development, the test suites) is never limited. On the host every
// client comes through its proxy, which always adds the forwarding headers
function isLocal(socket) {
  const { "cf-connecting-ip": edgeIp, "x-forwarded-for": forwardedFor } = socket.handshake.headers;
  return !edgeIp && !forwardedFor && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.handshake.address);
}

// One counter: what is counted (connections, joins...), for whom (an address or a socket id), and how many fit the window
const limit = (name, id, max) => ({ key: `limit:${name}:${id}`, max, windowMs: WINDOW_MS });

// Counts the request and says yes, or says no without counting it
const allow = async (name, id, max) => (await getStore().take([limit(name, id, max)])).ok;

// Socket.IO middleware: refuses a new connection over the limit
async function limitConnections(socket, next) {
  if (isLocal(socket) || await allow("connections", clientAddress(socket), MAX_CONNECTIONS)) return next();
  next(new Error("Too many connections, wait a minute"));
}

// True (after answering) when this room:join is over the limit
async function joinLimited(socket, ack) {
  if (isLocal(socket) || await allow("joins", clientAddress(socket), MAX_JOINS)) return false;
  if (typeof ack === "function") ack({ full: true, error: TOO_MANY });
  return true;
}

// True (after answering) when this room:peek is over the socket's or the address's limit. It is counted on both only
// when both are under, as one step
async function peekLimited(socket, ack) {
  if (isLocal(socket)) return false;
  const counted = await getStore().take([limit("socketPeeks", socket.id, MAX_PEEKS_PER_SOCKET), limit("peeks", clientAddress(socket), MAX_PEEKS)]);
  if (counted.ok) return false;
  if (typeof ack === "function") ack({ limited: true });
  return true;
}

// True when this stats:get is over the socket's limit. It is then answered { limited: true }, so the join screen's
// network check says to try again later instead of calling a good connection weak
const statsLimited = async socket => !isLocal(socket) && !(await allow("socketStats", socket.id, MAX_STATS_PER_SOCKET));

// True when this address already has max of the people waiting to be let in to one room (their addresses, as asked)
const waitingLimited = (socket, addresses, max) => !isLocal(socket) && addresses.filter(address => address === clientAddress(socket)).length >= max;

module.exports = { clientAddress, limitConnections, joinLimited, peekLimited, statsLimited, waitingLimited };
