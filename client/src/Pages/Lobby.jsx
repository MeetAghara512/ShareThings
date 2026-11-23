import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MdAdd } from "react-icons/md";
import { useAuth, GoogleSignInButton, isSignInTab } from "../useContext/AuthProvider";
import AppHeader from "./AppHeader";
import ServerStatus from "./ServerStatus";
import LiveCount from "./LiveCount";
import { newRoomHash } from "../Services/roomSecret";

// A new room code like Google Meet's: 10 random letters as abc-defg-hij, 26^10 ≈ 141 trillion codes,
// so live rooms cannot be found by guessing. getRandomValues also works on plain-HTTP test pages.
const newRoomCode = () => {
	const letters = [...crypto.getRandomValues(new Uint32Array(10))].map(n => String.fromCharCode(97 + (n % 26))).join("");
	return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
};

// A drawing of a call, so the first page shows what the app is for
const CallPicture = () => (
	<div className="relative aspect-[16/10] rounded-3xl overflow-hidden bg-[#27343A]">
		<svg viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Two people on a video call" className="absolute inset-0 w-full h-full">
			<rect width="1280" height="800" fill="#27343A" />
			<rect width="430" height="800" fill="#2E3D44" />
			<rect x="880" y="170" width="320" height="12" fill="#43555D" />
			<rect x="910" y="102" width="36" height="68" fill="#B8A07A" />
			<rect x="950" y="118" width="28" height="52" fill="#6F8B85" />
			<rect x="982" y="92" width="32" height="78" fill="#C9775C" />
			<rect x="1020" y="112" width="26" height="58" fill="#8796A6" />
			<path d="M90 800V610q0-34 34-34h92q34 0 34 34v190z" fill="#1E282D" />
			<path d="M170 580c-70-40-90-120-70-190 50 30 80 90 70 190zm0 0c60-60 120-90 180-70-30 60-100 90-180 70z" fill="#5E8A68" />
			<path d="M340 800c20-180 140-260 300-260s280 80 300 260z" fill="#3D5A73" />
			<rect x="588" y="440" width="104" height="130" rx="42" fill="#B97F5D" />
			<ellipse cx="640" cy="340" rx="122" ry="146" fill="#C98F6B" />
			<path d="M518 330c-8-126 72-178 134-178 84 0 134 62 126 178-24-54-62-80-126-84-62 6-108 32-134 84z" fill="#231A17" />
		</svg>
		<div className="absolute right-4 bottom-4 w-[27%] aspect-video rounded-xl overflow-hidden border-2 border-white">
			<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="block w-full h-full">
				<rect width="320" height="180" fill="#4A3F3A" />
				<rect x="210" width="110" height="180" fill="#574A43" />
				<path d="M70 180c6-46 42-66 90-66s84 20 90 66z" fill="#A85B47" />
				<rect x="146" y="92" width="28" height="34" rx="12" fill="#8F6248" />
				<ellipse cx="160" cy="72" rx="34" ry="40" fill="#A97553" />
				<path d="M122 92c-14-54 12-78 40-78s52 24 38 78c-2-28-14-46-38-48-24 2-36 20-40 48z" fill="#17110F" />
			</svg>
		</div>
	</div>
);

const Lobby = ({ darkMode, toggleDarkMode }) => {
	const { user, signOut } = useAuth();
	const [room, setRoom] = useState("");
	const navigate = useNavigate();
	const signInOnly = isSignInTab(); // this tab was opened just for signing in

	// The sign-in tab's job is done: the other tabs got it through localStorage
	useEffect(() => {
		if (user && isSignInTab()) window.close();
	}, [user]);

	// Only a room made here gets a private-link secret: a typed code may already be someone else's room
	const createRoom = () => navigate(`/room/${encodeURIComponent(newRoomCode())}${newRoomHash()}`);
	const joinRoom = e => {
		e.preventDefault();
		if (room.trim()) navigate(`/room/${encodeURIComponent(room.trim())}`);
	};

	if (signInOnly) {
		return (
			<div className="min-h-screen flex items-center justify-center p-6">
				<section className="w-full max-w-sm p-8 rounded-3xl bg-surface text-center space-y-5">
					<h1 className="font-display text-2xl font-bold">Sign in to ShareThings</h1>
					{user ? <p className="text-muted">You're signed in. You can close this tab.</p> : <div className="flex justify-center"><GoogleSignInButton /></div>}
				</section>
			</div>
		);
	}

	return (
		<div className="min-h-screen w-full flex flex-col">
			<AppHeader darkMode={darkMode} toggleDarkMode={toggleDarkMode}>
				{user ? (
					<>
						<span className="hidden sm:block max-w-[14rem] truncate text-sm text-muted" title={user.email}>{user.email}</span>
						<button type="button" onClick={signOut} className="h-11 shrink-0 px-4 rounded-full border border-line bg-surface text-sm font-medium transition-colors hover:bg-raised">
							Sign out
						</button>
					</>
				) : (
					<GoogleSignInButton />
				)}
			</AppHeader>

			<main className="flex-1 w-full max-w-7xl mx-auto px-5 py-6 sm:px-8 lg:px-12 flex flex-col lg:flex-row lg:items-center gap-10 lg:gap-14">
				<section className="flex-1 min-w-0 space-y-7">
					<div className="space-y-4">
						<h1 className="font-display text-[2.6rem] sm:text-6xl lg:text-[4.1rem] leading-[1.04] font-bold tracking-tight">Face to face, right in your browser.</h1>
						<p className="text-lg text-muted">Private video calls with chat and files. Nothing to install.</p>
					</div>
					<form onSubmit={joinRoom} className="flex flex-wrap gap-3">
						<button type="button" onClick={createRoom} className="h-14 px-6 rounded-2xl bg-accent text-on-accent font-semibold flex items-center gap-2 transition-colors hover:bg-accent-hover">
							<MdAdd aria-hidden="true" className="text-2xl" /> New meeting
						</button>
						<div className="flex-1 min-w-[15rem] h-14 pl-4 pr-1.5 flex items-center gap-2 rounded-2xl border border-line bg-surface focus-within:ring-2 focus-within:ring-accent">
							<label htmlFor="room" className="sr-only">Room code</label>
							<input
								id="room"
								type="text"
								placeholder="Enter a room code"
								value={room}
								onChange={e => setRoom(e.target.value)}
								className="flex-1 min-w-0 bg-transparent placeholder-muted focus:outline-none"
							/>
							<button type="submit" disabled={!room.trim()} className="h-11 px-4 shrink-0 rounded-xl bg-raised text-sm font-semibold transition-colors hover:bg-line disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-raised">
								Join
							</button>
						</div>
					</form>
					<LiveCount />
					<ServerStatus />
				</section>
				<section className="w-full lg:w-[52%] shrink-0">
					<CallPicture />
				</section>
			</main>

			<footer className="p-5 flex justify-center gap-5 text-sm text-muted">
				<a href="/privacy.html" className="hover:text-ink">Privacy</a>
				<a href="/terms.html" className="hover:text-ink">Terms</a>
			</footer>
		</div>
	);
};

export default Lobby;
