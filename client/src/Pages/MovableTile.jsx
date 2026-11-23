import React, { useEffect, useRef, useState } from "react";

const RATIO = 16 / 9;
const MIN_WIDTH = 96;
const MAX_SHARE = 0.7; // of the stage, so the video behind it stays visible
const GAP = 8; // kept free between the tile and the stage's edge
const MOVED = 4; // pixels before a press counts as a drag, so a plain click still works
const CORNERS = {
	nw: "top-0 left-0 cursor-nwse-resize border-t-2 border-l-2 rounded-tl-lg",
	ne: "top-0 right-0 cursor-nesw-resize border-t-2 border-r-2 rounded-tr-lg",
	sw: "bottom-0 left-0 cursor-nesw-resize border-b-2 border-l-2 rounded-bl-lg",
	se: "bottom-0 right-0 cursor-nwse-resize border-b-2 border-r-2 rounded-br-lg",
};

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const widest = stage => Math.max(MIN_WIDTH, Math.min(stage.clientWidth, stage.clientHeight * RATIO) * MAX_SHARE);

// The tile's place, kept fully on the stage
const bottomGap = stage => parseFloat(getComputedStyle(stage).getPropertyValue("--tile-bottom")) || GAP; // the floating control bar, where there is one

const fit = ({ left, top, width }, stage) => {
	const w = clamp(width, MIN_WIDTH, widest(stage));
	return {
		left: clamp(left, GAP, Math.max(GAP, stage.clientWidth - w - GAP)),
		top: clamp(top, GAP, Math.max(GAP, stage.clientHeight - w / RATIO - bottomGap(stage))),
		width: w,
	};
};

// Dragging a corner: the opposite corner stays where it is
const resized = (start, corner, dx, dy, stage) => {
	const west = corner.includes("w"), north = corner.includes("n");
	const right = start.left + start.width, bottom = start.top + start.width / RATIO;
	const growX = west ? -dx : dx, growY = (north ? -dy : dy) * RATIO;
	const room = Math.min((west ? right : stage.clientWidth - start.left) - GAP, (north ? bottom - GAP : stage.clientHeight - start.top - bottomGap(stage)) * RATIO);
	const width = clamp(start.width + (Math.abs(growX) > Math.abs(growY) ? growX : growY), MIN_WIDTH, Math.max(MIN_WIDTH, Math.min(room, widest(stage))));
	return { left: west ? right - width : start.left, top: north ? bottom - width / RATIO : start.top, width };
};

// A small video on the stage: drag it anywhere, or drag a corner to make it bigger or smaller.
// fixed: it fills the stage for now and keeps its place for later. overlay: what may float outside the frame
const MovableTile = ({ fixed = false, className, frameClass, title, overlay, children }) => {
	const ref = useRef(null);
	const moved = useRef(false);
	const stopDrag = useRef(null);
	const [box, setBox] = useState(null); // until the first drag, its classes place it

	useEffect(() => {
		const stage = ref.current.parentElement;
		const observer = new ResizeObserver(() => setBox(b => b && fit(b, stage)));
		observer.observe(stage);
		return () => {
			observer.disconnect();
			stopDrag.current?.();
		};
	}, []);

	const press = e => {
		if (fixed || e.button !== 0) return;
		stopDrag.current?.(); // a second finger takes over
		const stage = ref.current.parentElement;
		const s = stage.getBoundingClientRect(), t = ref.current.getBoundingClientRect();
		const start = { left: t.left - s.left, top: t.top - s.top, width: t.width };
		const corner = e.target.closest("[data-corner]")?.dataset.corner;
		const { clientX, clientY } = e;
		moved.current = false;
		const move = m => {
			const dx = m.clientX - clientX, dy = m.clientY - clientY;
			if (!moved.current && Math.hypot(dx, dy) < MOVED) return;
			moved.current = true;
			setBox(fit(corner ? resized(start, corner, dx, dy, stage) : { ...start, left: start.left + dx, top: start.top + dy }, stage));
		};
		const stop = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			stopDrag.current = null;
			setTimeout(() => (moved.current = false)); // after the click this release may cause
		};
		stopDrag.current = stop;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	};

	// The click that ends a drag is not a click on what is inside
	const skipClickAfterDrag = e => {
		if (!moved.current) return;
		e.preventDefault();
		e.stopPropagation();
	};

	const place = !fixed && box ? { left: box.left, top: box.top, width: box.width, right: "auto", bottom: "auto" } : undefined;
	return (
		<div
			ref={ref}
			style={place}
			title={fixed ? undefined : title}
			onPointerDown={press}
			onClickCapture={skipClickAfterDrag}
			className={`${className} ${fixed ? "" : "group cursor-move select-none touch-none"}`}
		>
			<div className={frameClass}>{children}</div>
			{overlay}
			{!fixed && Object.entries(CORNERS).map(([corner, look]) => (
				<span key={corner} data-corner={corner} aria-hidden="true" className={`absolute z-10 w-4 h-4 border-white opacity-0 transition-opacity before:absolute before:-inset-2 before:content-[''] group-hover:opacity-100 [@media(hover:none)]:opacity-50 ${look}`} />
			))}
		</div>
	);
};

export default MovableTile;
