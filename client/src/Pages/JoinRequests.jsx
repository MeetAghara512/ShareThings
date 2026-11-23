import React from "react";

// Host only: who is asking to join. The name is what they typed, shown as plain text.
// inline: on phones it takes its place in the column of notices, so it covers none of them.
// tile: the swap tile is in the top right corner, so on wider screens the card goes under it.
// belowStatus: during a call the status row is at the top of narrow stages, so the card starts under it
const JoinRequests = ({ requests, inline, tile, belowStatus, onAdmit, onDeny }) => {
	if (!requests.length) return null;
	return (
		<section aria-label="People asking to join" style={inline ? undefined : tile ? { top: "8.25rem", maxHeight: "calc(100% - 8.75rem)" } : belowStatus ? { top: "4rem", maxHeight: "calc(100% - 4.5rem)" } : undefined} className={inline ? "w-full max-w-sm min-h-0 overflow-y-auto space-y-2 pointer-events-auto" : "absolute z-30 top-3 inset-x-2 sm:inset-x-auto sm:right-4 sm:w-80 max-h-[calc(100%-1.5rem)] overflow-y-auto space-y-2"}>
			{requests.map(({ id, name }) => (
				<div key={id} role="alert" className={`p-3 rounded-xl shadow-2xl text-sm space-y-2 bg-surface text-ink`}>
					<p className="font-semibold break-words">{name} wants to join</p>
					<div className="flex justify-end gap-2">
						<button type="button" onClick={() => onDeny(id)} aria-label={`Deny ${name}`} className={`px-4 py-1.5 rounded-full font-semibold border border-line hover:bg-raised`}>Deny</button>
						<button type="button" onClick={() => onAdmit(id)} aria-label={`Admit ${name}`} className="px-4 py-1.5 rounded-full font-semibold bg-accent hover:bg-accent-hover text-on-accent">Admit</button>
					</div>
				</div>
			))}
		</section>
	);
};

export default JoinRequests;
