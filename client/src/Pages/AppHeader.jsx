import React from "react";
import { Link } from "react-router-dom";
import { MdDarkMode, MdLightMode, MdVideocam } from "react-icons/md";

// The top of the pages outside a call: the name, whatever the page adds, and the theme button
const AppHeader = ({ darkMode, toggleDarkMode, children }) => (
	<header className="flex items-center justify-between gap-3 px-5 py-5 sm:px-8 lg:px-12">
		<Link to="/" className="flex items-center gap-2.5 min-w-0">
			<span className="w-9 h-9 shrink-0 rounded-xl bg-accent text-on-accent flex items-center justify-center text-xl">
				<MdVideocam aria-hidden="true" />
			</span>
			<span className="font-display text-xl sm:text-2xl font-bold truncate">ShareThings</span>
		</Link>
		<div className="flex items-center gap-2 min-w-0">
			{children}
			<button
				type="button"
				onClick={toggleDarkMode}
				aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
				title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
				className="w-11 h-11 shrink-0 rounded-full border border-line bg-surface flex items-center justify-center text-xl transition-colors hover:bg-raised"
			>
				{darkMode ? <MdLightMode /> : <MdDarkMode />}
			</button>
		</div>
	</header>
);

export default AppHeader;
