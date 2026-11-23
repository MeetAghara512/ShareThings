// Live counter for the first page: people online (one per browser tab) and calls in progress (rooms with two
// people). Only these two numbers ever leave the server: never names, room codes or addresses.
const EVERY = 5000; // at most one update to everyone this often, and only when a number changed

module.exports = function liveStats(io) {
  const nsp = io.of("/");

  // Counted from the connections that exist right now; ones refused by the limits never get here
  const current = () => {
    const tabs = new Set();
    // A tab's id (sent when it joins a room), so a tab with an old connection not yet gone counts once
    for (const socket of nsp.sockets.values()) tabs.add(socket.data.clientId || socket.id);
    let calls = 0;
    for (const [room, members] of nsp.adapter.rooms) {
      if (!nsp.sockets.has(room) && members.size === 2) calls++; // every connection also has a room of its own
    }
    return { online: tabs.size, calls };
  };

  let sent = current();
  let sentAt = 0;
  let timer = null;
  const changed = () => {
    timer ??= setTimeout(() => {
      timer = null;
      const now = current();
      if (now.online === sent.online && now.calls === sent.calls) return;
      sent = now;
      sentAt = Date.now();
      io.emit("stats:update", now);
    }, Math.max(0, sentAt + EVERY - Date.now()));
  };
  // Every connection joins a room of its own and leaves all rooms when it ends, so these cover connects too
  nsp.adapter.on("join-room", changed);
  nsp.adapter.on("leave-room", changed);

  return { current };
};
