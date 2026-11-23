import React, { useState } from "react";
import { MdNotificationsActive, MdNotificationsNone } from "react-icons/md";
import { allowJoinNotice, notifyPermission } from "../Services/notify";

// While waiting alone: offer to be told when someone joins (a notification while this tab is in the background).
// Asks only when clicked; nothing is shown once notifications are blocked
const JoinNotice = ({ className }) => {
	const [permission, setPermission] = useState(notifyPermission);
	if (permission === "denied") return null;
	const look = `${className} flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 text-white text-sm whitespace-nowrap`;
	if (permission === "granted") {
		return (
			<p className={look}>
				<MdNotificationsActive className="shrink-0" /> You'll be notified when someone joins
			</p>
		);
	}
	return (
		<button type="button" onClick={async () => setPermission(await allowJoinNotice())} className={`${look} hover:bg-black/75 font-medium`}>
			<MdNotificationsNone className="shrink-0" /> Notify me when someone joins
		</button>
	);
};

export default JoinNotice;
