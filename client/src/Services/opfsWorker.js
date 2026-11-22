// Writes received files into the browser's private storage (OPFS) for files.jsx. Only a worker can
// open the synchronous file handles, which write each block straight to disk.
const open = new Map(); // file name -> sync access handle

const folder = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("incoming-files", { create: true });

onmessage = async ({ data: { call, op, name, at, bytes } }) => {
	try {
		let result;
		if (op === "open") {
			const file = await (await folder()).getFileHandle(name, { create: true });
			const handle = await file.createSyncAccessHandle();
			open.set(name, handle);
			result = handle.getSize();
		} else if (op === "write") {
			const handle = open.get(name);
			if (handle.write(new Uint8Array(bytes), { at }) !== bytes.byteLength) throw new DOMException("The disk is full", "QuotaExceededError");
			handle.flush();
		} else if (op === "close") {
			open.get(name)?.close();
			open.delete(name);
		}
		postMessage({ call, result });
	} catch (e) {
		postMessage({ call, error: e.name, message: e.message });
	}
};
