// The tab title, for when the call is in a background tab: the call state set by the room, with the chat's
// unread count in front, e.g. "(2) ● In call with Sam · ShareThings". Without a call state, the page's own title
const original = document.title;
let call = null;
let unread = 0;
const render = () => {
	document.title = (unread ? `(${unread}) ` : "") + (call ?? original);
};

export const setCallTitle = text => {
	call = text;
	render();
};
export const setUnreadTitle = count => {
	unread = count;
	render();
};
