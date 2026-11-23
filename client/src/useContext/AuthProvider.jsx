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

	// Signed in or out in another tab: a room sends people to the first page for this, so Google's script never runs next to its secret
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

// Google's script is loaded by the first click here, which then shows Google's own button. Until then nothing goes to Google
export const GoogleSignInButton = () => {
	const { authenticate } = useAuth();
	const buttonRef = useRef(null);
	const [step, setStep] = useState(() => (googleLoaded() ? "loading" : "idle")); // idle, loading, ready or failed

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
			{(step === "idle" || step === "failed") && (
				<button type="button" onClick={() => setStep("loading")} className="px-4 py-2 rounded-full border border-gray-400 font-medium hover:bg-gray-500/10">
					Sign in with Google
				</button>
			)}
			{step === "loading" && <p role="status" className="opacity-70">Loading Google sign-in…</p>}
			{step === "failed" && <p role="alert" className="text-red-500">Google sign-in could not be loaded. You can still join a call without signing in.</p>}
			<div ref={buttonRef} />
		</div>
	);
};
