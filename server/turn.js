// ICE servers for the browsers: STUN, plus TURN relay credentials from Xirsys when configured.
//
// Credentials are asked for with an hour's lifetime (Xirsys's default is 60 seconds) and shared by
// everyone who joins in the next 5 minutes, so a join usually needs no request to Xirsys and the
// free API quota lasts longer. Even the last person given cached credentials can start (or restart)
// relayed connections with them for 55 more minutes. Joins that arrive while a request is on its way
// wait for that one request. When Xirsys fails, STUN only is used and Xirsys is asked again after 30 s.

const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];
const LIFETIME = 60 * 60; // seconds the credentials can open new relay allocations
const SHARE_FOR = 5 * 60 * 1000; // how long one set of credentials is handed out
const RETRY_AFTER = 30 * 1000; // after a failure

let cached = null; // { servers, until }
let pending = null;

async function askXirsys({ XIRSYS_IDENT, XIRSYS_SECRET, XIRSYS_CHANNEL }) {
  const res = await fetch(`https://global.xirsys.net/_turn/${XIRSYS_CHANNEL}?format=urls&expire=${LIFETIME}`, {
    method: "PUT",
    headers: {
      Authorization: "Basic " + Buffer.from(`${XIRSYS_IDENT}:${XIRSYS_SECRET}`).toString("base64"),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ format: "urls" }),
    signal: AbortSignal.timeout(5000)
  });
  const { s, v } = await res.json();
  if (s !== "ok") throw new Error(v);
  return [].concat(v.iceServers);
}

async function getIceServers() {
  const env = process.env;
  if (!env.XIRSYS_IDENT || !env.XIRSYS_SECRET || !env.XIRSYS_CHANNEL) return STUN_ONLY;
  if (cached && Date.now() < cached.until) return cached.servers;
  pending ??= askXirsys(env)
    .then(
      servers => (cached = { servers, until: Date.now() + SHARE_FOR }).servers,
      err => {
        console.error("TURN credentials unavailable, using STUN only:", err.message);
        return (cached = { servers: STUN_ONLY, until: Date.now() + RETRY_AFTER }).servers;
      }
    )
    .finally(() => { pending = null; });
  return pending;
}

module.exports = { getIceServers, STUN_ONLY };
