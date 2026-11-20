# 🚀 shareThings: Your P2P Screen Sharing & Video Calling Solution

Tired of complex video platforms and unreliable connections? **shareThings** brings you a seamless, peer-to-peer experience for real-time video calls and screen sharing—no middlemen, just direct connections for the fastest, most secure communication.

---

## 🔗 Live Demo

**shareThings** is deployed and available here:

> 🔗 **Live Website:** [shareThings Web](https://sharethings-web.onrender.com/)

---

## 🔥 Key Features

- 🎥 **Real-Time Video Calling**: One-to-one video calls over WebRTC with adaptive quality.
- 🖥️ **Screen Sharing**: Share your entire screen or specific application windows effortlessly.
- 🤝 **Peer-to-Peer Connection**: Direct media streams via STUN/TURN for minimal latency and bandwidth usage.
- 🔐 **Secure Signaling**: Socket.IO with encrypted channels for session negotiation.
- ⚡ **Low Latency**: Optimized for smooth audio/video even on slower networks.
- 🌐 **Cross-Platform**: Works in modern browsers without plugins.

---

## 🧠 How It Works

1. **Signaling**: Socket.IO on Node.js/Express handles room management and signaling messages.
2. **Peer Connection**: WebRTC RTCPeerConnection establishes direct media streams with STUN/TURN servers for NAT traversal.
3. **Media Streams**: 
   - `getUserMedia` captures audio and video streams from the user's devices.
   - `getDisplayMedia` captures screen or application window streams for sharing.
   - `addTrack` attaches these media tracks to the RTCPeerConnection and sends them to the remote peer.
4. **UI**: React.js + Tailwind CSS provides a responsive, intuitive interface.

---

## ⚡ Quick Start


### Clone & Install

```bash
# Clone the repo
git clone https://github.com/MeetAghara512/ShareThings.git
cd ShareThings
```

The project uses a **client/server** structure:
```
ShareThings/
├── client/       # React frontend
└── server/       # Node.js/Socket.IO signaling backend
```

Install dependencies:
```bash
# Backend setup
cd server && npm install

# Frontend setup
cd client && npm install
```

Backend environment variables: `PORT` (default `5000`) and, for TURN relay on strict networks, your Xirsys account's `XIRSYS_IDENT`, `XIRSYS_SECRET` and `XIRSYS_CHANNEL`. Without them the app falls back to STUN only.

---

## 📸 Screenshots
### Home Page
<p align="center">
  <img src="./Pictures/one.png" alt="Home Page" width="100%" />
</p>

### Wait for Connection
<p align="center">
  <img src="./Pictures/two.png" alt="Wait for Connection" width="100%" />
</p>

### Connected (Mobile View)
<p align="center">
  <img src="./Pictures/three.jpg" alt="Connected Mobile View" width="30%" height="40%" />
</p>


---

## 🔮 Future Enhancements

- 👥 **Multi-Party Calls** (group video & screen sharing)
- 💬 **In-Session Chat & File Transfer**
- 🎙️ **Call Recording & Playback**
- ✨ **Virtual Background & Blur Effects**
- 🔍 **Session Analytics & Usage Reports**

---

🎉 **shareThings – Screen, Stream, Succeed. Instant Collaboration! 🌐🎥**
