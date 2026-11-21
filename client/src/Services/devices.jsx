// Open the chosen camera (and mic). Browsers ignore a deviceId that is not "exact", so a saved
// device is asked for exactly, and the default is used when it is gone.
export const openDevices = async (videoId, audioId, { audio = true } = {}) => {
	const listed = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).map(d => d.deviceId);
	const idsShown = listed.some(Boolean); // hidden until access is granted
	const pick = id => (id && (!idsShown || listed.includes(id)) ? { deviceId: { exact: id } } : true);
	try {
		return await navigator.mediaDevices.getUserMedia({ video: pick(videoId), audio: audio && pick(audioId) });
	} catch (e) {
		if (e.name !== "OverconstrainedError" && e.name !== "NotFoundError") throw e;
		return navigator.mediaDevices.getUserMedia({ video: true, audio });
	}
};
