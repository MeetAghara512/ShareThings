class PeerService {
	constructor() {
		this.reset();
	}

	// A fresh connection per call. iceServers (with short-lived TURN credentials) come from the server.
	reset(iceServers = []) {
		this.peer?.close();
		this.peer = new RTCPeerConnection({ iceServers });
		this.peer.onicecandidate = e => e.candidate && this.onIceCandidate?.(e.candidate);
		this.peer.ontrack = e => this.onTrack?.(e.streams[0]);
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
