import React, { useEffect, useRef, useSyncExternalStore } from "react";

// Which speaker plays the other person. Only where the browser can switch outputs (setSinkId); elsewhere there
// is no picker and the sound plays as before
const CAN_PICK = "setSinkId" in HTMLMediaElement.prototype;
const SPEAKER_KEY = "sharethings.speaker";
const SLOW = 2000; // a speaker that does not answer must not hold back the call's sound

let state = { speakers: [], id: (CAN_PICK && localStorage.getItem(SPEAKER_KEY)) || "" };
const listeners = new Set();
const set = patch => {
	state = { ...state, ...patch };
	listeners.forEach(listener => listener());
};

// speakers: "" (the system default) and each device; empty when there is nothing to choose between
export const refreshSpeakers = async () => {
	if (!CAN_PICK) return;
	const list = (await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? []).filter(d => d.kind === "audiooutput" && d.deviceId);
	// "default" and Windows' "communications" are other names for a real device
	const devices = list.filter(d => d.deviceId !== "default" && d.deviceId !== "communications");
	// A saved speaker that is not listed (a headset can drop for a moment): the default for now, and back when it
	// returns. Nothing listed: no mic permission yet, which says nothing about it
	const saved = localStorage.getItem(SPEAKER_KEY) || "";
	const id = !list.length ? state.id : devices.some(d => d.deviceId === saved) ? saved : "";
	set({
		speakers: devices.length < 2 ? [] : [
			{ id: "", label: list.find(d => d.deviceId === "default")?.label || "System default" },
			...devices.map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` })),
		],
		id,
	});
};

const subscribe = listener => {
	if (!listeners.size && CAN_PICK) {
		navigator.mediaDevices?.addEventListener("devicechange", refreshSpeakers);
		refreshSpeakers();
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (!listeners.size) navigator.mediaDevices?.removeEventListener("devicechange", refreshSpeakers);
	};
};
export const useSpeaker = () => useSyncExternalStore(subscribe, () => state);

export const pickSpeaker = id => {
	if (id) localStorage.setItem(SPEAKER_KEY, id);
	else localStorage.removeItem(SPEAKER_KEY);
	set({ id });
};

// A speaker that fails: back to the default, so the call keeps its sound. The saved choice stays for when it returns
const fallBack = (id, error) => {
	console.error("Speaker could not be used", error);
	if (state.id !== id) return; // another one was picked meanwhile
	set({ id: "" });
};

const setOutput = async (element, id) => {
	if (!CAN_PICK || element.sinkId === id) return;
	const done = element.setSinkId(id).catch(e => fallBack(id, e));
	await Promise.race([done, new Promise(resolve => setTimeout(resolve, SLOW))]);
};

// The other person's sound. The speaker is set first, so it never starts on the wrong one
export const RemoteAudio = ({ stream }) => {
	const ref = useRef(null);
	const { id } = useSpeaker();

	useEffect(() => {
		const element = ref.current;
		let stale = false;
		setOutput(element, id).then(() => {
			if (!stale && element.srcObject !== stream) element.srcObject = stream;
		});
		return () => {
			stale = true;
		};
	}, [stream, id]);

	return <audio autoPlay ref={ref} />;
};
