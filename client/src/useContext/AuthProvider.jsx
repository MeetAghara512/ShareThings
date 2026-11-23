import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSocket } from "./SocketProvider";

// Public identifier of the Google OAuth client (not a secret). Must match GOOGLE_CLIENT_ID in server/index.js
const GOOGLE_CLIENT_ID = "123263407226-ltqv9qfv6s58ocr5nvgk2vggoa0addhf.apps.googleusercontent.com";
const TOKEN_KEY = "sharethings.googleToken";

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
	const socket = useSocket();
	const [user, setUser] = useState(null);

	// The server verifies the Google token and replies with the verified user, or null.
	// The email is never taken from anything the browser could type or edit.
	const authenticate = useCallback(token => {
		socket.emit("auth:google", { token }, verified => {
			setUser(verified);
			if (verified) localStorage.setItem(TOKEN_KEY, token);
			else localStorage.removeItem(TOKEN_KEY);
		});
	}, [socket]);

	const signOut = useCallback(() => authenticate(null), [authenticate]);

	// Sign-in belongs to the socket connection, so restore it on every (re)connect
	useEffect(() => {
		const restore = () => {
			const token = localStorage.getItem(TOKEN_KEY);
			if (token) authenticate(token);
		};
		socket.on("connect", restore);
		if (socket.connected) restore();
		return () => socket.off("connect", restore);
	}, [socket, authenticate]);

	// Signed in or out in another tab: sign-in always runs in a tab of its own, so Google's script never runs next to a room's secret
	useEffect(() => {
		const sync = e => e.key === TOKEN_KEY && authenticate(e.newValue);
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, [authenticate]);

	return (
		<AuthContext.Provider value={{ user, authenticate, signOut }}>
			{children}
		</AuthContext.Provider>
	);
};

// Sign-in runs in a new tab of its own: Google's script could read any room link in the history of the tab it runs in
export const SIGN_IN_PAGE = "/?signin=1";
const SIGN_IN_CHANNEL = "sharethings.signin"; // the new tab says here that it opened
const TAB_WAIT = 4000; // no word from it by then: the browser blocked it
const hasRoomInHistory = () => !!window.navigation?.entries().some(({ url }) => url && /^\/(room|left)\//.test(new URL(url).pathname));
export const isSignInTab = () => new URLSearchParams(window.location.search).has("signin") && !window.opener && !hasRoomInHistory();

let googleScript;
// With Google's script on this page, Back and Forward are fresh page loads too, so a room never shares a page with it
const freshPageOnHistory = e => {
	e.stopImmediatePropagation();
	window.location.reload();
};
const loadGoogleScript = () =>
	(googleScript ??= new Promise((resolve, reject) => {
		window.addEventListener("popstate", freshPageOnHistory, true);
		const script = document.createElement("script");
		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.onload = resolve;
		script.onerror = () => {
			script.remove();
			googleScript = null; // the next click tries again
			window.removeEventListener("popstate", freshPageOnHistory, true);
			reject(new Error("Google's script did not load"));
		};
		document.head.appendChild(script);
	}));

export const googleLoaded = () => !!googleScript;

// Opens the sign-in tab. Only there does Google's script load and show Google's own button
export const GoogleSignInButton = () => {
	const { authenticate } = useAuth();
	const buttonRef = useRef(null);
	// In the sign-in tab: loading, ready or failed. In any other: idle, opening, opened or blocked
	const [step, setStep] = useState(() => (isSignInTab() ? "loading" : "idle"));

	const start = () => {
		if (isSignInTab()) return setStep("loading");
		setStep("opening");
		window.open(SIGN_IN_PAGE, "_blank", "noopener,noreferrer"); // returns nothing with noopener: the new tab reports back
	};

	useEffect(() => {
		if (!isSignInTab() || !window.BroadcastChannel) return;
		const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
		channel.postMessage("opened");
		channel.close();
	}, []);

	useEffect(() => {
		if (step !== "opening" && step !== "blocked") return;
		if (!window.BroadcastChannel) return setStep("opened");
		const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
		channel.onmessage = () => setStep("opened");
		const id = step === "opening" && setTimeout(() => setStep("blocked"), TAB_WAIT);
		return () => {
			clearTimeout(id);
			channel.close();
		};
	}, [step]);

	useEffect(() => {
		if (step !== "loading") return;
		let current = true;
		loadGoogleScript()
			.then(() => {
				if (!current) return;
				window.google.accounts.id.initialize({
					client_id: GOOGLE_CLIENT_ID,
					callback: ({ credential }) => authenticate(credential),
				});
				window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large" });
				setStep("ready");
			})
			.catch(() => {
				console.error("Google sign-in could not be loaded");
				if (current) setStep("failed");
			});
		return () => {
			current = false;
		};
	}, [step, authenticate]);

	return (
		<div className="flex flex-col items-start gap-2">
			{["idle", "opened", "blocked", "failed"].includes(step) && (
				<button type="button" onClick={start} className="px-4 py-2 rounded-full border border-gray-400 font-medium hover:bg-gray-500/10">
					Sign in with Google
				</button>
			)}
			{step === "opening" && <p role="status" className="opacity-70">Opening the sign-in tab…</p>}
			{step === "opened" && <p role="status" className="opacity-70">Finish signing in in the new tab.</p>}
			{step === "blocked" && <p role="alert" className="text-red-500">The sign-in tab could not open. Allow pop-ups for this site and try again. You can still join a call without signing in.</p>}
			{step === "loading" && <p role="status" className="opacity-70">Loading Google sign-in…</p>}
			{step === "failed" && <p role="alert" className="text-red-500">Google sign-in could not be loaded. You can still join a call without signing in.</p>}
			<div ref={buttonRef} />
		</div>
	);
};
