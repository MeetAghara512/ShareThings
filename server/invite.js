// Email invites: a signed-in user who is waiting in a room can have the room link mailed to a guest.
// Sent from the app's own Gmail account through the Gmail API (HTTPS; the host blocks outbound SMTP).
// Rate limits are kept in the store (see store.js): in memory, so they reset when the server restarts, or in Redis.
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const MailComposer = require("nodemailer/lib/mail-composer");
const { clientAddress } = require("./limits");
const { getStore } = require("./store");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
// A bare address only: no display name, group or comment syntax that a mail parser would read differently
const EMAIL_RE = /^[^\s@<>"(),;:[\]\\]+@[^\s@<>"(),;:[\]\\]+\.[^\s@<>"(),;:[\]\\]+$/;

// Invites per sender email, per IP and per recipient mailbox, checked in this order
const LIMITS = {
  sender: { max: 5, windowMs: HOUR, error: "You have sent too many invites. Try again in an hour." },
  ip: { max: 10, windowMs: HOUR, error: "Too many invites from your network. Try again in an hour." },
  recipient: { max: 3, windowMs: DAY, error: "This person has already been invited several times today. Try again tomorrow." }
};

// Store keys are hashed, so email addresses never appear in plain text in a shared Redis
const limitKey = (type, value) => `invite:${type}:${crypto.createHash("sha256").update(value).digest("hex")}`;

// Addresses that reach the same mailbox share one per-recipient limit: +tags everywhere, dots for Gmail
function mailboxKey(address) {
  let [local, domain] = address.split("@");
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

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

// OAuth client for the Gmail account, created on first use; the library caches and refreshes the access token
let gmailClient;
async function gmailAccessToken(clientId) {
  if (!gmailClient) {
    gmailClient = new OAuth2Client(clientId, process.env.GMAIL_CLIENT_SECRET);
    gmailClient.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  }
  const { token } = await gmailClient.getAccessToken();
  if (!token) throw new Error("no access token");
  return token;
}

// The meeting time as the sender picked it: their time zone, on a 12-hour clock. A zone that is not real falls back to UTC
function meetingTime(start, timeZone) {
  const options = { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" };
  try {
    return start.toLocaleString("en-US", { ...options, timeZone: typeof timeZone === "string" && timeZone.length <= 64 ? timeZone : "UTC" }).replace(/\u202f/g, " ");
  } catch {
    return start.toLocaleString("en-US", { ...options, timeZone: "UTC" }).replace(/\u202f/g, " ");
  }
}

// Options for the MIME composer, which encodes the headers so user-derived values cannot add any
function buildEmail({ user, name, to, link, start, timeZone }) {
  const time = start && meetingTime(start, timeZone);

  // Plain text on purpose: a short note with one link is less likely to be filed as spam than a styled one
  const email = {
    from: { name: "ShareThings", address: process.env.INVITE_FROM_EMAIL || "sharethings.invites@gmail.com" },
    to: { address: to },
    replyTo: { name, address: user.email },
    subject: `Video call invitation from ${name}`,
    text:
      `Hi,\n\n` +
      `${name} (${user.email}) would like to have a video call with you on ShareThings.\n\n` +
      (time ? `When: ${time}\nThe attached calendar file shows this in your own time zone.\n\n` : "") +
      `To join, open this link in your browser:\n${link}\n\n` +
      `You can reply to this email to reach ${name}.\n\n` +
      `Sent by ${user.email} via ShareThings\n`,
    newline: "windows" // CRLF line endings throughout, as RFC 822 requires
  };
  if (start) {
    email.attachments = [{ filename: "invite.ics", content: buildIcs({ start, link, name }), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }];
  }
  return email;
}

// Validates the request, sends the email and returns the ack: { ok: true } or { error }. Never throws.
async function sendInvite(socket, { to, room, when, timeZone }, allowedOrigins, googleClientId, roomKey) {
  try {
    const user = socket.data.user;
    if (!user) return { error: "Sign in with Google to send invites." };

    if (!socket.rooms.has(roomKey(room))) {
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

    if (!process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return { error: "Email invites are not set up on this server. Copy the invite link above and send it yourself." };

    const keys = {
      sender: user.email.toLowerCase(),
      ip: clientAddress(socket),
      recipient: mailboxKey(to)
    };
    // Checked and counted in one step before sending, so parallel requests cannot slip past a limit; undone below if
    // it is not sent
    const limits = Object.entries(LIMITS).map(([type, { max, windowMs }]) => ({ key: limitKey(type, keys[type]), max, windowMs }));
    const counted = await getStore().take(limits);
    if (!counted.ok) return { error: Object.values(LIMITS)[counted.index].error };

    // The name the sender typed on the join screen, else their Google name; the verified email is always shown next to it.
    // "Guest" is what the server stores when no name was typed, so it does not count as a typed name.
    const typedName = socket.data.name !== "Guest" ? socket.data.name : null;
    const name = String(typedName || user.name || user.email).replace(/\s+/g, " ").trim();
    let failure;
    try {
      const token = await gmailAccessToken(googleClientId);
      const message = await new MailComposer(buildEmail({ user, name, to, link, start, timeZone })).compile().build();
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: message.toString("base64url") }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) failure = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (err) {
      failure = err.message;
    }
    if (!failure) return { ok: true };

    console.error("Invite email was not sent:", failure);
    await getStore().forget(limits, counted.mark);
    return { error: "The invite could not be sent. Copy the invite link above and send it yourself." };
  } catch (err) {
    console.error("Invite failed:", err.message);
    return { error: "The invite could not be sent. Copy the invite link above and send it yourself." };
  }
}

module.exports = { sendInvite };
