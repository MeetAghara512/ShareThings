# ShareThings

Free one-to-one video calls in the browser, with screen sharing, chat and file sharing.
Audio, video, chat and files go directly between the two browsers (through an encrypted relay when a direct connection is impossible); the server only helps them find each other.

**Live:** https://sharethings-web.onrender.com

## Features

- **Join screen like Google Meet:** camera and microphone preview, device pickers, a microphone level meter, your name, and how many people are already in the room (names appear only after you join). You can still join with the camera or microphone blocked or missing.
- **Direct join:** no ringing. Rooms hold two people; once both are in, the call connects by itself. Rooms have codes like `abc-defg-hij`; share the link, or sign in with Google to send an email invite (with an optional meeting time).
- **Video:** HD camera (up to 1280×720 at 30 fps), mute and camera off, call timer and connection quality, and your own camera shown like a mirror. Quality adapts to the size of the other person's screen and to weak networks; on a very weak connection video pauses and audio continues. More options has Auto, High and Data saver.
- **Screen and camera together:** the other person sees your screen big and your camera small, and can swap them.
- **Chat and files** over the call's own connection. Files over 100 MB are offered first (Accept / Decline). Received files are written to the browser's storage as they arrive, checked block by block, and continue after a dropped connection or a page reload. Files can be paused, resumed and cancelled on both sides.
- **Auto-reconnect:** after a network drop the connection restarts, and your place in the call is kept for 30 seconds.
- **Phones and tablets:** the call and the chat fit on one screen.
- **Updates:** a tab opened before a new version was deployed offers a reload instead of breaking.
- **Security:** signaling only reaches the other person in the same room; per-address limits on connections, joins and room checks; the Xirsys account secret stays on the server, browsers only get short-lived TURN credentials; security headers (Content-Security-Policy and more).

## How it works

- **Signaling:** a Node.js server (Express + Socket.IO, in `server/`). Connections start with HTTP long-polling and upgrade to a WebSocket where the network allows it. The server passes offers, answers and ICE candidates between the two people in a room; it never sees the call's audio, video, chat or files.
- **Media:** WebRTC, one `RTCPeerConnection` per call, encrypted with DTLS-SRTP. Its audio, camera and screen lanes are set up once, so sharing the screen needs no renegotiation.
- **Connectivity:** STUN (Google) for a direct connection, and a TURN relay from Xirsys when one is configured, for networks that block direct connections. The server fetches the TURN credentials and shares them for 5 minutes.
- **Chat and files:** two WebRTC data channels on the same connection. Files go in 8 MB blocks, each checked with SHA-256. The receiver writes them to the browser's private storage (OPFS) from a Web Worker, then saves them where the person chose at Accept, or offers a Save link.
- **App:** React 18 and Vite (in `client/`). Tailwind CSS is loaded from its CDN in `client/index.html`; it is not a project dependency.

## Run it locally

Needs Node.js 20.19+ or 22.12+.

```bash
git clone https://github.com/MeetAghara512/ShareThings.git
cd ShareThings

# Terminal 1: the signaling server on port 5001 (on macOS, port 5000 is taken by AirPlay)
cd server
npm ci
PORT=5001 npm start

# Terminal 2: the app on http://localhost:3000
cd client
npm ci
REACT_APP_SOCKET_SERVER_URL=http://localhost:5001 npm start
```

Open http://localhost:3000 in two browser windows to try a call. On Windows, or to avoid typing the variables each time, put them in `server/.env` (`PORT=5001`) and `client/.env.local` (`REACT_APP_SOCKET_SERVER_URL=http://localhost:5001`) and run just `npm start`.

### Settings

Server (in `server/.env`, read at start, or in the environment). All are optional:

| Variable | What it is for |
|---|---|
| `PORT` | Port to listen on (default `5000`) |
| `XIRSYS_IDENT`, `XIRSYS_SECRET`, `XIRSYS_CHANNEL` | TURN relay from your Xirsys account. Without them only STUN is used, and calls between some networks cannot connect |
| `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Email invites, sent through the Gmail API |
| `INVITE_FROM_EMAIL` | Sender address for invites (default `sharethings.invites@gmail.com`) |
| `NODE_VERSION` | On Render only: the Node.js version to use, e.g. `22` |

App: `REACT_APP_SOCKET_SERVER_URL` is the signaling server's address; it is built into the app. Leave it unset when the app and the server are served from one address (the Docker setup below).

Google sign-in (only needed for email invites) works only on addresses registered for the app's Google OAuth client, such as `http://localhost:3000`. The sites allowed to use the server and to appear in invite links are listed in `ALLOWED_ORIGINS` in `server/index.js`; add yours there if you deploy somewhere else.

## Docker

```bash
docker compose up --build
```

Then open http://localhost:3000. nginx in the client container serves the app and passes `/socket.io/` and `/health` on to the server container, so the app needs no server address. The server's secrets come from your shell or from a `.env` file next to `docker-compose.yml`; they are never copied into an image.

## Deploy on Render

- **Server:** a Web Service with root directory `server`, build command `npm ci`, start command `npm start`, health check path `/health`, and the settings above as environment variables (`NODE_VERSION`, `XIRSYS_*`, `GMAIL_*`).
- **App:** a Static Site with root directory `client`, build command `npm ci && npm run build`, publish directory `build`, and `REACT_APP_SOCKET_SERVER_URL` set to the server's address. Also set:
  - **Redirects/Rewrites:** `/*` to `/index.html` as a Rewrite, so room links like `/room/abc-defg-hij` open the app.
  - **Headers** for path `/*`, with `<server host>` replaced by the server's host name (without it the app cannot reach the server):
    - `Content-Security-Policy`: `default-src 'self'; script-src 'self' https://cdn.tailwindcss.com https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; connect-src 'self' https://accounts.google.com/gsi/ https://<server host> wss://<server host>; frame-src https://accounts.google.com/gsi/; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
    - `X-Content-Type-Options`: `nosniff`
    - `Referrer-Policy`: `strict-origin-when-cross-origin`
    - `Permissions-Policy`: `camera=(self), microphone=(self), display-capture=(self)`

The free server sleeps when idle. The first visit wakes it, which can take up to a minute; the app says so while it waits.

## Privacy

Calls are not recorded and there is no user database. See the [Privacy Policy](client/public/privacy.html) and [Terms of Service](client/public/terms.html), served at `/privacy.html` and `/terms.html`.

## Project layout

```
client/              React app (Vite); nginx.conf and Dockerfile for Docker
  src/Pages/         screens: first page, join screen, call, chat panel
  src/Services/      WebRTC connection, chat, file transfer
server/
  index.js           signaling (Socket.IO), rooms and seats
  turn.js            TURN credentials from Xirsys, shared for a few minutes
  limits.js          per-address limits
  invite.js          email invites (Gmail API)
docker-compose.yml
```
