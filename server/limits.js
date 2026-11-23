// Limits per internet address, so one address cannot flood the free server with connections, joins or
// "who is here" checks. Counts live in memory over a sliding window and reset when the server restarts.

const { isIP } = require("net");

const WINDOW_MS = Number(process.env.LIMIT_WINDOW_MS) || 60 * 1000; // a shorter window can be set for tests
const MAX_CONNECTIONS = 30; // new socket connections per address
const MAX_JOINS = 30; // room:join per address
const MAX_PEEKS = 120; // room:peek per address: generous, since a whole office can share one address
const MAX_PEEKS_PER_SOCKET = 30; // room:peek per socket: an open join screen asks every 4 s, 15 times a minute
const MAX_STATS_PER_SOCKET = 60; // stats:get per socket: the first page asks once, a network check 5 times
const TOO_MANY = "Too many attempts, wait a minute and try again";

const ipOf = value => (typeof value === "string" && isIP(value.trim()) ? value.trim() : null);

// The client's internet address. On Render (which always sets RENDER) every request passes Cloudflare, which
// overwrites cf-connecting-ip. Anywhere else a client could send that header itself, so it is ignored there.
// A client can also write anything at the start of x-forwarded-for: only the last entry, added by our own proxy, counts
function clientAddress(socket) {
  const { "cf-connecting-ip": edgeIp, "x-forwarded-for": forwardedFor } = socket.handshake.headers;
  return (process.env.RENDER && ipOf(edgeIp)) || (typeof forwardedFor === "string" && ipOf(forwardedFor.split(",").pop())) || socket.handshake.address;
}

// A direct connection from this machine (local development, the test suites) is never limited. On the host every
// client comes through its proxy, which always adds the forwarding headers
function isLocal(socket) {
  const { "cf-connecting-ip": edgeIp, "x-forwarded-for": forwardedFor } = socket.handshake.headers;
  return !edgeIp && !forwardedFor && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.handshake.address);
}

// Each map: key (address or socket id) -> times of its recent requests
const counts = { connections: new Map(), joins: new Map(), peeks: new Map(), socketPeeks: new Map(), socketStats: new Map() };

// The key's requests still inside the window (stored back, so the caller can add the new one)
function recent(map, key, now) {
  const times = (map.get(key) || []).filter(t => now - t < WINDOW_MS);
  map.set(key, times);
  return times;
}

// Counts the request and says yes, or says no without counting it
function allow(map, key, max) {
  const now = Date.now();
  const times = recent(map, key, now);
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

// Keys that are never used again would otherwise stay in memory forever
setInterval(() => {
  const now = Date.now();
  for (const map of Object.values(counts)) {
    for (const key of map.keys()) if (!recent(map, key, now).length) map.delete(key);
  }
}, WINDOW_MS).unref();

// Socket.IO middleware: refuses a new connection over the limit
function limitConnections(socket, next) {
  if (isLocal(socket) || allow(counts.connections, clientAddress(socket), MAX_CONNECTIONS)) return next();
  next(new Error("Too many connections, wait a minute"));
}

// True (after answering) when this room:join is over the limit
function joinLimited(socket, ack) {
  if (isLocal(socket) || allow(counts.joins, clientAddress(socket), MAX_JOINS)) return false;
  if (typeof ack === "function") ack({ full: true, error: TOO_MANY });
  return true;
}

// True (after answering) when this room:peek is over the socket's or the address's limit
function peekLimited(socket, ack) {
  if (isLocal(socket)) return false;
  const now = Date.now();
  const mine = recent(counts.socketPeeks, socket.id, now), address = recent(counts.peeks, clientAddress(socket), now);
  if (mine.length < MAX_PEEKS_PER_SOCKET && address.length < MAX_PEEKS) {
    mine.push(now);
    address.push(now);
    return false;
  }
  if (typeof ack === "function") ack({ limited: true });
  return true;
}

// True when this stats:get is over the socket's limit. It then gets no answer, so the join screen's network check
// counts it as a lost round trip, never as a good one
const statsLimited = socket => !isLocal(socket) && !allow(counts.socketStats, socket.id, MAX_STATS_PER_SOCKET);

// True when this address already has max of the sockets waiting to be let in to one room
const waitingLimited = (socket, waiting, max) => !isLocal(socket) && waiting.filter(s => clientAddress(s) === clientAddress(socket)).length >= max;

module.exports = { clientAddress, limitConnections, joinLimited, peekLimited, statsLimited, waitingLimited };
