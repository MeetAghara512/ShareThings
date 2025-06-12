class PeerService {
	constructor() {
		if (!this.peer) {
			this.peer = new RTCPeerConnection({
				iceServers: [
					{
						urls: [
							"stun:stun.l.google.com:19302",
							"stun:global.stun.twilio.com:3478",
						],
					},
				],
			});
		}
	}

	async getAnswer(offer) {
		if (this.peer) {
			await this.peer.setRemoteDescription(new RTCSessionDescription(offer));
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
