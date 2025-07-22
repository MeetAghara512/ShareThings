class PeerService {
	constructor() {
		if (!this.peer) {
			this.peer = new RTCPeerConnection({
				iceServers: [
					{ urls: "stun:ss-turn1.xirsys.com" },
					{
						urls: [
							"turn:ss-turn1.xirsys.com:80?transport=udp",
							"turn:ss-turn1.xirsys.com:3478?transport=udp",
							"turn:ss-turn1.xirsys.com:80?transport=tcp",
							"turn:ss-turn1.xirsys.com:3478?transport=tcp",
							"turns:ss-turn1.xirsys.com:443?transport=tcp",
							"turns:ss-turn1.xirsys.com:5349?transport=tcp"
						],
						username: "",
						credential: ""
					}
				]
			});

			// this.peer.onicecandidate = (event) => {
			// 	if (event.candidate) {
			// 		// console.log("🧊 ICE Candidate:", event.candidate.candidate);
			// 	}
			// };
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
