class PeerService {
	constructor() {
		this.reset();
	}

	// A fresh connection per call. iceServers (with short-lived TURN credentials) come from the server.
	reset(iceServers = []) {
		this.peer?.close();
		const pc = new RTCPeerConnection({ iceServers });
		this.peer = pc;
		pc.onicecandidate = e => e.candidate && this.onIceCandidate?.(e.candidate);
		// The screen lane's track comes without a stream: passing on its streams[0] (undefined) would blank the camera
		pc.ontrack = e => e.transceiver === this.screenSlot() ? this.onScreenTrack?.(e.track) : this.onTrack?.(e.streams[0]);
		// State changes are only reported for the current connection
		pc.onconnectionstatechange = () => pc === this.peer && this.onConnectionState?.(pc.connectionState);
		pc.oniceconnectionstatechange = () => pc === this.peer && this.onIceState?.(pc.iceConnectionState);
		// Chat and files (see chat.jsx). Agreed in advance on both sides, so the call's one offer/answer
		// already includes them and nothing needs renegotiating later
		this.chat = pc.createDataChannel("chat", { negotiated: true, id: 0 });
		this.files = pc.createDataChannel("files", { negotiated: true, id: 1 });
		this.onDataChannels?.(this.chat, this.files);
	}

	// The mic's or the camera's lane: the first transceiver of that kind (the screen's is the second video one)
	lane(kind) {
		return this.peer.getTransceivers().find(t => t.receiver.track.kind === kind) ?? null;
	}

	// A second video lane, after the camera's, for a shared screen. It is part of the first offer, so sharing
	// later needs no new one. The offering side adds it once the camera is added (addTrack would take a free
	// lane); the answering side gets it from the offer and must be able to send on it too.
	screenSlot(create = false) {
		const pc = this.peer;
		let slot = pc.getTransceivers().filter(t => t.receiver.track.kind === "video")[1];
		if (create && !slot && !pc.remoteDescription) slot = pc.addTransceiver("video", { direction: "sendrecv" });
		if (create && slot) slot.direction = "sendrecv";
		return slot ?? null;
	}

	async getAnswer() {
		if (this.peer) {
			const ans = await this.peer.createAnswer();
			await this.peer.setLocalDescription(ans);
			return ans;
		}
	}

	async getOffer() {
		if (this.peer) {
			const offer = await this.peer.createOffer();
			await this.peer.setLocalDescription(offer);
			return offer;
		}
	}

	async setLocalDescription(sdp) {
		if (this.peer) {
			await this.peer.setLocalDescription(new RTCSessionDescription(sdp));
		}
	}

	async setRemoteDescription(sdp) {
		if (this.peer) {
			await this.peer.setRemoteDescription(new RTCSessionDescription(sdp));
		}
	}
}

export default new PeerService(); //main
