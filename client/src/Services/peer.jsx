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
		pc.ontrack = e => this.onTrack?.(e.streams[0]);
		// State changes are only reported for the current connection
		pc.onconnectionstatechange = () => pc === this.peer && this.onConnectionState?.(pc.connectionState);
		pc.oniceconnectionstatechange = () => pc === this.peer && this.onIceState?.(pc.iceConnectionState);
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
