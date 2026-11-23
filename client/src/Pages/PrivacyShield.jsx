import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MdClose, MdGppBad, MdOutlineShield, MdVerifiedUser } from "react-icons/md";
import * as privacy from "../Services/privateCheck";

const LOOK = {
	verified: { Icon: MdVerifiedUser, color: "text-green-500", title: "Verified private" },
	private: { Icon: MdOutlineShield, color: "opacity-80", title: "Private" },
	failed: { Icon: MdGppBad, color: "text-red-500", title: "Could not verify this connection" },
};

const explain = (reason, who) => ({
	proven: `Verified with your link: nobody is between you and ${who}, not even our server. This relies on the ShareThings page your browser loaded.`,
	waiting: "Checking this connection…",
	"no-link": "Not proven: you did not open this call from its private link, so nobody can be ruled out in between.",
	"no-proof": `Not proven: ${who} did not open the private link. A typed code or an emailed invite has no proof.`,
	"no-stats": "Not proven: this browser does not report the keys of the connection.",
	wrong: `A check from ${who} did not match. Someone could be in between, or they opened a different link. Do not share anything sensitive; leave and start a new call from a fresh link.`,
}[reason]);

// The shield next to the call status; tapping it shows what the browser itself measured
const PrivacyShield = ({ remoteName, darkMode }) => {
	const state = useSyncExternalStore(privacy.subscribe, privacy.getState);
	const [open, setOpen] = useState(false);
	const button = useRef(null);
	const panel = useRef(null);
	const { Icon, color, title } = LOOK[state.status];
	const who = remoteName || "the other person";

	// A failed check must be seen, not just a small icon turning red
	useEffect(() => {
		if (state.status === "failed") setOpen(true);
	}, [state.status]);

	useEffect(() => {
		if (!open) return;
		const close = e => (e.type === "keydown" ? e.key === "Escape" : !panel.current?.contains(e.target) && !button.current?.contains(e.target)) && setOpen(false);
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);

	return (
		<>
			<button ref={button} type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={title} title={title} className={`flex items-center gap-1 min-w-0 rounded ${color}`}>
				<Icon className="shrink-0 text-base" />
				<span className={`truncate ${state.status === "failed" ? "" : "max-sm:sr-only"}`}>{title}</span>
			</button>
			{/* In a portal: the stage clips what is inside it */}
			{open && createPortal(
				<section
					ref={panel}
					role="dialog"
					aria-label="Connection privacy"
					className={`fixed z-50 left-3 right-3 top-[calc(var(--app-top,0px)+3.5rem)] md:left-6 md:right-auto md:top-auto md:bottom-20 md:w-80 max-h-[calc(100dvh-5rem)] overflow-y-auto p-4 rounded-xl shadow-2xl space-y-3 text-sm ` +
						(darkMode ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900")}
				>
					<div className="flex items-start justify-between gap-2">
						<h3 className={`flex items-center gap-1.5 text-base font-semibold ${state.status === "private" ? "" : color}`}><Icon className="shrink-0" /> {title}</h3>
						<button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close" className={`-m-1 p-1 rounded-full text-lg ${darkMode ? "hover:bg-gray-700" : "hover:bg-gray-100"}`}>
							<MdClose />
						</button>
					</div>
					<ul className="list-disc pl-5 space-y-1">
						{state.encrypted && <li>Encrypted</li>}
						{state.relay === false && <li>Direct between your two devices</li>}
						{state.relay === true && <li>Through an encrypted relay that cannot see the call</li>}
						{state.encrypted && state.status === "verified" && <li>Only you and {who}</li>}
						{state.encrypted && state.status === "private" && <li>One connection, to the person shown as {who}</li>}
					</ul>
					<p className="opacity-80">{explain(state.reason, who)}</p>
				</section>,
				document.body
			)}
		</>
	);
};

export default PrivacyShield;
