// Email invites: a signed-in user who is waiting in a room can have the room link mailed to a guest.
// Sent through Brevo's HTTP API. Rate limits live in memory, so they reset when the server restarts.
const crypto = require("crypto");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Each limit maps a key (sender email, IP, recipient) to the timestamps of its recent invites
const LIMITS = {
  sender: { max: 5, windowMs: HOUR, sent: new Map(), error: "You have sent too many invites. Try again in an hour." },
  ip: { max: 10, windowMs: HOUR, sent: new Map(), error: "Too many invites from your network. Try again in an hour." },
  recipient: { max: 3, windowMs: DAY, sent: new Map(), error: "This person has already been invited several times today. Try again tomorrow." }
};

// Number of invites still inside the window; expired timestamps and empty keys are dropped
function recentCount({ sent, windowMs }, key, now) {
  const recent = (sent.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length) sent.set(key, recent);
  else sent.delete(key);
  return recent.length;
}

// Keys that are never used again would otherwise stay in memory forever
setInterval(() => {
  const now = Date.now();
  for (const limit of Object.values(LIMITS)) {
    for (const key of limit.sent.keys()) recentCount(limit, key, now);
  }
}, HOUR).unref();

const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const icsText = value =>
  String(value).replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n|\r/g, "\\n");

const icsDate = date => date.toISOString().replace(/[-:]|\.\d{3}/g, "");

function buildIcs({ start, link, name }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ShareThings//Invite//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@sharethings`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(new Date(start.getTime() + HOUR))}`,
    `SUMMARY:${icsText(`ShareThings call with ${name}`)}`,
    `DESCRIPTION:${icsText(`Join the call: ${link}`)}`,
    `URL:${link}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ]
    .map(line => line.replace(/(.{73})(?=.)/gu, "$1\r\n ")) // long lines continue on the next line after a space
    .join("\r\n") + "\r\n";
}

function buildEmail({ user, name, to, link, start }) {
  const time = start && start.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  const [hName, hEmail, hLink] = [name, user.email, link].map(escapeHtml);

  const email = {
    sender: { name: "ShareThings", email: process.env.INVITE_FROM_EMAIL || "sharethings.invites@gmail.com" },
    to: [{ email: to }],
    replyTo: { email: user.email, name },
    subject: `${name} invited you to a ShareThings call`,
    htmlContent:
      `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#18181b;max-width:480px">` +
      `<p><strong>${hName}</strong> (${hEmail}) invited you to a video call on ShareThings.</p>` +
      (time ? `<p><strong>When:</strong> ${escapeHtml(time)}<br>The attached calendar file shows this in your own time zone.</p>` : "") +
      `<p><a href="${hLink}" style="display:inline-block;padding:12px 24px;border-radius:9999px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold">Join the call</a></p>` +
      `<p>Or open this link in your browser:<br><a href="${hLink}">${hLink}</a></p>` +
      `<p style="font-size:12px;color:#71717a">Sent by ${hEmail} via ShareThings</p>` +
      `</div>`,
    textContent:
      `${name} (${user.email}) invited you to a video call on ShareThings.\n\n` +
      (time ? `When: ${time}\nThe attached calendar file shows this in your own time zone.\n\n` : "") +
      `Join the call: ${link}\n\n` +
      `Sent by ${user.email} via ShareThings\n`
  };
  if (start) {
    email.attachment = [{ name: "invite.ics", content: Buffer.from(buildIcs({ start, link, name })).toString("base64") }];
  }
  return email;
}

// Validates the request, sends the email and returns the ack: { ok: true } or { error }. Never throws.
async function sendInvite(socket, { to, room, when }, allowedOrigins) {
  try {
    const user = socket.data.user;
    if (!user) return { error: "Sign in with Google to send invites." };

    if (typeof room !== "string" || !room || room === socket.id || !socket.rooms.has(room)) {
      return { error: "You can only invite someone to a room you are in." };
    }

    to = typeof to === "string" ? to.trim().toLowerCase() : "";
    if (to.length > 254 || !EMAIL_RE.test(to)) return { error: "Enter a valid email address." };

    let start = null;
    if (when !== undefined && when !== null && when !== "") {
      start = new Date(typeof when === "string" ? when : NaN);
      const fromNow = start.getTime() - Date.now();
      if (!(fromNow > 0 && fromNow < YEAR)) return { error: "Pick a meeting time in the future, within one year." };
    }

    // The link is built here, never taken from the client, so this cannot be used to mail arbitrary links
    const { origin } = socket.handshake.headers;
    if (!allowedOrigins.includes(origin)) return { error: "Invites cannot be sent from this site." };
    const link = `${origin}/room/${encodeURIComponent(room)}`;

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return { error: "Email invites are not set up on this server." };

    const forwardedFor = socket.handshake.headers["x-forwarded-for"];
    const keys = {
      sender: user.email.toLowerCase(),
      ip: (typeof forwardedFor === "string" && forwardedFor.split(",")[0].trim()) || socket.handshake.address,
      recipient: to
    };
    const now = Date.now();
    for (const [type, limit] of Object.entries(LIMITS)) {
      if (recentCount(limit, keys[type], now) >= limit.max) return { error: limit.error };
    }
    // Count the invite before sending so parallel requests cannot slip past a limit; undone below if it is not sent
    for (const [type, { sent }] of Object.entries(LIMITS)) sent.set(keys[type], [...(sent.get(keys[type]) || []), now]);

    const name = String(user.name || user.email).replace(/\s+/g, " ").trim();
    let failure;
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildEmail({ user, name, to, link, start })),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) failure = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (err) {
      failure = err.message;
    }
    if (!failure) return { ok: true };

    console.error("Invite email was not sent:", failure);
    for (const [type, { sent }] of Object.entries(LIMITS)) {
      const list = sent.get(keys[type]) || [];
      const i = list.indexOf(now);
      if (i !== -1) list.splice(i, 1);
      if (!list.length) sent.delete(keys[type]);
    }
    return { error: "The invite could not be sent. Please try again later." };
  } catch (err) {
    console.error("Invite failed:", err.message);
    return { error: "The invite could not be sent. Please try again later." };
  }
}

module.exports = { sendInvite };
