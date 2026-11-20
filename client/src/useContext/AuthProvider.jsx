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

	return (
		<AuthContext.Provider value={{ user, authenticate, signOut }}>
			{children}
		</AuthContext.Provider>
	);
};

let googleScript;
const loadGoogleScript = () =>
	(googleScript ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.onload = resolve;
		script.onerror = reject;
		document.head.appendChild(script);
	}));

export const GoogleSignInButton = () => {
	const { authenticate } = useAuth();
	const buttonRef = useRef(null);

	useEffect(() => {
		loadGoogleScript()
			.then(() => {
				if (!buttonRef.current) return;
				window.google.accounts.id.initialize({
					client_id: GOOGLE_CLIENT_ID,
					callback: ({ credential }) => authenticate(credential),
				});
				window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large" });
			})
			.catch(() => console.error("Google sign-in could not be loaded"));
	}, [authenticate]);

	return <div ref={buttonRef} />;
};
