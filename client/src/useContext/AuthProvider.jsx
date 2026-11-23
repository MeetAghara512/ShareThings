import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { FcGoogle } from "react-icons/fc";
import { useSocket } from "./SocketProvider";

// Public identifier of the Google OAuth client (not a secret). Must match GOOGLE_CLIENT_ID in server/index.js
const GOOGLE_CLIENT_ID = "123263407226-ltqv9qfv6s58ocr5nvgk2vggoa0addhf.apps.googleusercontent.com";
const GOOGLE_SIGN_IN = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_KEY = "sharethings.googleToken";
const PENDING_KEY = "sharethings.signIn"; // what this tab asked Google for

// A new tab that goes straight to Google, for signing in during a call without leaving it
export const SIGN_IN_PAGE = "/?signin=1";
const opensGoogle = new URLSearchParams(window.location.search).has("signin");

const randomText = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

// Sign-in happens on Google's own page, so no Google code ever runs on ours, next to a room's secret
const goToGoogle = (tab = false) => {
	const state = randomText(), nonce = randomText();
	sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, nonce, tab }));
	const query = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: `${window.location.origin}/`,
		response_type: "id_token",
		scope: "openid email profile",
		prompt: "select_account",
		state,
		nonce,
	});
	window.location[tab ? "replace" : "assign"](`${GOOGLE_SIGN_IN}?${query}`);
};

const nonceOf = token => {
	try {
		return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).nonce;
	} catch {
		return null;
	}
};

// Back from Google: the token leaves the address bar first, and is kept only if this tab asked for it
const finishSignIn = () => {
	const answer = new URLSearchParams(window.location.hash.slice(1));
	if (window.location.pathname !== "/" || !(answer.has("id_token") || answer.has("error"))) return {};
	window.history.replaceState(null, "", "/");
	const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY)) ?? {};
	sessionStorage.removeItem(PENDING_KEY);
	const token = answer.get("id_token");
	const valid = token && answer.get("state") === pending.state && nonceOf(token) === pending.nonce;
	if (valid) localStorage.setItem(TOKEN_KEY, token);
	return { tab: pending.tab, failed: !!pending.state && !valid };
};

const returned = finishSignIn();
if (opensGoogle) goToGoogle(true);

// This tab exists only to sign in during a call
export const isSignInTab = () => opensGoogle || !!returned.tab;

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
	const socket = useSocket();
	const [user, setUser] = useState(null);
	const [checking, setChecking] = useState(() => !!localStorage.getItem(TOKEN_KEY)); // a saved sign-in waits for the server's answer

	// The server verifies the Google token and replies with the verified user, or null.
	// The email is never taken from anything the browser could type or edit.
	const authenticate = useCallback(token => {
		socket.emit("auth:google", { token }, verified => {
			setUser(verified);
			setChecking(false);
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

	// Signed in or out in another tab, such as the one opened during a call
	useEffect(() => {
		const sync = e => e.key === TOKEN_KEY && authenticate(e.newValue);
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, [authenticate]);

	return (
		<AuthContext.Provider value={{ user, checking, signOut }}>
			{children}
		</AuthContext.Provider>
	);
};

export const GoogleSignInButton = () => {
	const { checking } = useAuth();
	if (opensGoogle) return <p role="status" className="text-sm text-muted">Opening Google…</p>;
	if (checking) return <p role="status" className="text-sm text-muted">Signing in…</p>;
	return (
		<div className="relative">
			<button type="button" aria-label="Sign in with Google" onClick={() => goToGoogle(isSignInTab())} className="h-11 inline-flex items-center gap-2.5 px-4 rounded-full border border-line bg-surface text-sm font-medium transition-colors hover:bg-raised">
				<FcGoogle className="text-lg" /> Sign in
			</button>
			{returned.failed && <p role="alert" className="absolute z-10 right-0 top-full mt-2 px-3 py-1.5 rounded-lg bg-surface w-48 text-sm text-red-500 shadow-lg">Sign-in did not finish. Try again.</p>}
		</div>
	);
};
