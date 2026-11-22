import peer from "./peer";

// Brings a call back after the network drops, without ending it:
// 1. ICE restart: both browsers look for a new network path for the same connection, so the tracks,
//    the call and its timer stay. Only the side that sent the first offer makes restart offers; the
//    other side asks it to. Each try gets ATTEMPT_WAIT, with a short pause between tries.
// 2. If RESTARTS tries fail, that side starts one brand-new connection (Room.jsx: startOver).
// 3. If that does not connect within REBUILD_WAIT either, the call is lost.
// Room.jsx calls update() on every connection state change and sets the callbacks below.
const UNSTABLE_WAIT = 4000; // "disconnected" often heals by itself
const RESTARTS = 4;
const ATTEMPT_WAIT = 10000;
const BACKOFF = [1000, 2000, 4000]; // pause before the 2nd, 3rd and 4th try
const REBUILD_WAIT = 15000;
const SIGNAL_WAIT = 60000; // longest wait for signaling to come back before a try can be sent

class CallRecovery {
	peerId = null; // the other person's socket id
	canSignal = () => false; // our signaling connection is up
	send = () => {}; // (event, payload): to the other person
	onRebuild = () => {}; // start a brand-new connection, and tell the other side to do the same
	onStale = () => {}; // (from): the other side tries to recover a call we no longer have
	onLost = () => {};

	pc = null; // the connection being watched
	wasConnected = false; // only a call that worked once is recovered
	phase = "idle"; // idle | unstable | restarting | backoff | waiting
	attempts = 0;
	timer = null;
	rebuildTimer = null;

	update() {
		if (peer.peer !== this.pc) this.follow(peer.peer);
		const state = this.pc.connectionState;
		if (state === "connected") return this.recovered();
		if (!this.wasConnected) return;
		if (state === "failed" && (this.phase === "idle" || this.phase === "unstable")) this.attempt();
		else if (state === "disconnected" && this.phase === "idle") this.later("unstable", UNSTABLE_WAIT, () => this.attempt());
	}

	// A new connection (the call started over): the old one's tries no longer apply, a rebuild still does
	follow(pc) {
		this.cancel();
		this.pc = pc;
		this.wasConnected = false;
		this.attempts = 0;
	}

	recovered() {
		this.cancel();
		this.wasConnected = true;
		this.attempts = 0;
		clearTimeout(this.rebuildTimer);
		this.rebuildTimer = null;
	}

	// Run fn after ms, unless the connection was replaced meanwhile
	later(phase, ms, fn) {
		clearTimeout(this.timer);
		this.phase = phase;
		const pc = this.pc;
		this.timer = setTimeout(() => (pc === peer.peer ? fn() : this.cancel()), ms);
	}

	cancel() {
		clearTimeout(this.timer);
		this.timer = null;
		this.phase = "idle";
	}

	async attempt() {
		const pc = this.pc;
		if (pc !== peer.peer) return this.cancel();
		if (!this.canSignal() || !this.peerId) {
			// Nobody to send it to: wait for signaling to come back (retryNow), but not forever
			if (this.phase !== "waiting") this.later("waiting", SIGNAL_WAIT, () => this.lose());
			return;
		}
		this.attempts++;
		this.later("restarting", ATTEMPT_WAIT, () => this.attemptFailed());
		if (!this.isOfferer()) return this.send("call:restart-request", {});
		try {
			// The previous restart offer got no answer
			if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
			const offer = await pc.createOffer({ iceRestart: true });
			await pc.setLocalDescription(offer);
			if (pc === peer.peer) this.send("user:call", { offer, restart: true });
		} catch (e) {
			console.error("ICE restart failed", e);
		}
	}

	attemptFailed() {
		if (this.pc.connectionState === "connected") return this.recovered();
		if (this.attempts < RESTARTS) return this.later("backoff", BACKOFF[this.attempts - 1], () => this.attempt());
		this.cancel();
		this.watchRebuild();
		if (this.isOfferer()) this.onRebuild(); // the other side waits for it
	}

	// A brand-new connection is being made: it must connect in time
	watchRebuild() {
		if (!this.rebuildTimer) this.rebuildTimer = setTimeout(() => this.lose(), REBUILD_WAIT);
	}

	lose() {
		this.stop();
		this.onLost();
	}

	// Signaling is back or the other person has a new socket id: try now instead of waiting
	retryNow() {
		if (this.phase === "unstable" || this.phase === "backoff" || this.phase === "waiting") this.attempt();
	}

	// The other side cannot get through and asks for a restart (we sent the first offer)
	restartRequested(from) {
		const pc = peer.peer;
		if (!pc.remoteDescription || pc.signalingState === "closed") return this.onStale(from);
		if (pc === this.pc && this.wasConnected && this.isOfferer() && this.phase !== "restarting") this.attempt();
	}

	// The other side restarted ICE: answer on the same connection, not as a new call
	async answer(from, offer) {
		const pc = peer.peer;
		if (!pc.remoteDescription || pc.signalingState !== "stable") return this.onStale(from);
		try {
			await pc.setRemoteDescription(offer);
			const ans = await pc.createAnswer();
			await pc.setLocalDescription(ans);
			if (pc === peer.peer) this.send("call:accepted", { to: from, ans, restart: true });
		} catch (e) {
			console.error("Answering the ICE restart failed", e);
		}
	}

	async applyAnswer(ans) {
		const pc = peer.peer;
		if (pc.signalingState !== "have-local-offer") return; // a late answer to an offer we already replaced
		try {
			await pc.setRemoteDescription(ans);
		} catch (e) {
			console.error("ICE restart answer could not be applied", e);
		}
	}

	isOfferer() {
		return this.pc.localDescription?.type === "offer";
	}

	// The call ended or we left the room
	stop() {
		this.cancel();
		this.attempts = 0;
		clearTimeout(this.rebuildTimer);
		this.rebuildTimer = null;
	}
}

export default new CallRecovery();
