import React, { useEffect, useRef, useState } from "react";
import { MdArrowBack, MdChevronLeft, MdChevronRight, MdClose, MdEvent } from "react-icons/md";

const FIRST_HOUR = 9; // the time a future day starts with
const LAST_DAY = 364; // the server accepts a meeting up to a year ahead
const FIVE_MINUTES = 5 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const sameDay = (a, b) => !!a && !!b && startOfDay(a).getTime() === startOfDay(b).getTime();
const dayText = d => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const timeText = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

// Blank cells up to the month's first weekday, then its days
const monthCells = month => {
	const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
	return [...Array(month.getDay()).fill(null), ...Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
};

// What the time fields start with: the chosen time, 9:00 AM on a future day, or the next five minutes today
const startTime = (day, value, now) => {
	if (sameDay(day, value)) return value;
	if (!sameDay(day, now)) return new Date(day.getFullYear(), day.getMonth(), day.getDate(), FIRST_HOUR);
	const soon = new Date(Math.ceil((now.getTime() + 1000) / FIVE_MINUTES) * FIVE_MINUTES);
	return sameDay(soon, now) ? soon : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59);
};

// The typed 12-hour time on that day, or null. A clock change can skip a time, so that counts as not valid
const fromFields = (day, { hour, minute, period }) => {
	const h = Number(hour), m = Number(minute);
	if (!hour || minute === "" || h < 1 || h > 12 || m > 59) return null;
	const hours = (h % 12) + (period === "PM" ? 12 : 0);
	const time = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, m);
	return time.getHours() === hours && time.getMinutes() === m ? time : null;
};

// Pick a day, then type any time. Set time closes it; so do the close button, Escape and a click elsewhere
const TimePicker = ({ value, onChange }) => {
	const [open, setOpen] = useState(false);
	const [month, setMonth] = useState(null);
	const [day, setDay] = useState(null); // the day whose time is being set
	const [fields, setFields] = useState({ hour: "", minute: "", period: "AM" });
	const box = useRef(null);
	const trigger = useRef(null);
	const hourRef = useRef(null);
	const minuteRef = useRef(null);
	const now = new Date();
	const today = startOfDay(now);
	const lastDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + LAST_DAY);

	const show = () => {
		setMonth(startOfMonth(value || now));
		setDay(null);
		setOpen(true);
	};
	const pickDay = d => {
		const time = startTime(d, value, now);
		setFields({ hour: String(time.getHours() % 12 || 12), minute: String(time.getMinutes()).padStart(2, "0"), period: time.getHours() < 12 ? "AM" : "PM" });
		setDay(d);
	};

	useEffect(() => {
		if (!open) return;
		const close = e => {
			if (e.type === "keydown" ? e.key !== "Escape" : box.current?.contains(e.target)) return;
			setOpen(false);
			if (e.type === "keydown") trigger.current?.focus();
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, [open]);

	// The meeting card scrolls: keep the open picker in view. With a mouse, the hour is ready to type over
	useEffect(() => {
		if (!open) return;
		const card = box.current?.closest("section");
		if (card) card.scrollTop = card.scrollHeight;
		if (day && window.matchMedia("(pointer: fine)").matches) hourRef.current?.select();
	}, [open, day]);

	const typeHour = e => {
		const hour = e.target.value.replace(/\D/g, "").slice(0, 2);
		setFields(f => ({ ...f, hour }));
		if (hour.length === 2 || Number(hour) > 1) minuteRef.current?.select(); // no hour starts with these and goes on
	};
	const typeMinute = e => {
		const minute = e.target.value.replace(/\D/g, "").slice(0, 2);
		setFields(f => ({ ...f, minute }));
	};
	const padMinute = () => setFields(f => (f.minute ? { ...f, minute: f.minute.padStart(2, "0") } : f));

	const time = day && fromFields(day, fields);
	const tooEarly = !!time && time <= now;
	const ready = !!time && !tooEarly;
	const confirm = () => {
		if (!ready) return;
		onChange(time);
		setOpen(false);
	};
	// Enter sets the time here; it must not send the invite around it
	const enterSets = e => {
		if (e.key !== "Enter") return;
		e.preventDefault();
		confirm();
	};

	const unavailable = d => d < today || d > lastDay || (sameDay(d, now) && now.getHours() === 23 && now.getMinutes() === 59);
	const iconButton = "w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xl transition-colors hover:bg-raised disabled:opacity-30 disabled:hover:bg-transparent";
	const timeInput = "min-w-0 flex-1 h-12 rounded-lg border border-line bg-raised text-center text-xl font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-accent";

	return (
		<div ref={box} className="space-y-2">
			<div className="relative">
				<button
					ref={trigger}
					type="button"
					onClick={() => (open ? setOpen(false) : show())}
					aria-expanded={open}
					aria-label={value ? `Meeting time: ${dayText(value)}, ${timeText(value)}. Change` : "Pick a meeting time"}
					className={`w-full h-11 pl-3 pr-10 rounded-xl border bg-ground flex items-center gap-2 text-left font-normal transition-colors hover:bg-raised ${open ? "border-accent" : "border-line"}`}
				>
					<MdEvent aria-hidden="true" className="shrink-0 text-lg text-muted" />
					<span className={`truncate ${value ? "" : "text-muted"}`}>{value ? `${dayText(value)}, ${timeText(value)}` : "Pick a date and time"}</span>
				</button>
				{value && (
					<button type="button" onClick={() => { onChange(null); setOpen(false); }} aria-label="Clear meeting time" title="Clear" className="absolute right-1 top-1 w-9 h-9 rounded-lg flex items-center justify-center text-lg text-muted hover:bg-raised">
						<MdClose />
					</button>
				)}
			</div>

			{open && (
				<div role="dialog" aria-label="Pick a meeting time" className="p-2 rounded-xl border border-line bg-ground font-normal">
					<div className="flex items-center gap-1 mb-1">
						{day ? (
							<button type="button" onClick={() => setDay(null)} aria-label="Back to dates" title="Back" className={iconButton}><MdArrowBack /></button>
						) : (
							<button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} disabled={month <= startOfMonth(today)} aria-label="Previous month" className={iconButton}><MdChevronLeft /></button>
						)}
						<span aria-live="polite" className="flex-1 min-w-0 text-center font-semibold truncate">
							{day ? dayText(day) : month.toLocaleDateString([], { month: "long", year: "numeric" })}
						</span>
						{!day && (
							<button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} disabled={new Date(month.getFullYear(), month.getMonth() + 1, 1) > lastDay} aria-label="Next month" className={iconButton}><MdChevronRight /></button>
						)}
						<button type="button" onClick={() => setOpen(false)} aria-label="Close date picker" title="Close" className={iconButton}><MdClose /></button>
					</div>

					{day ? (
						<div className="space-y-2 p-1">
							<div className="flex items-center gap-1.5">
								<input ref={hourRef} type="text" inputMode="numeric" autoComplete="off" aria-label="Hour" value={fields.hour} onChange={typeHour} onFocus={e => e.target.select()} onKeyDown={enterSets} className={timeInput} />
								<span aria-hidden="true" className="text-xl font-semibold">:</span>
								<input ref={minuteRef} type="text" inputMode="numeric" autoComplete="off" aria-label="Minutes" value={fields.minute} onChange={typeMinute} onBlur={padMinute} onFocus={e => e.target.select()} onKeyDown={enterSets} className={timeInput} />
								<div role="group" aria-label="AM or PM" className="ml-1 h-12 shrink-0 flex rounded-lg overflow-hidden border border-line">
									{["AM", "PM"].map(period => (
										<button
											key={period}
											type="button"
											aria-pressed={fields.period === period}
											onClick={() => setFields(f => ({ ...f, period }))}
											className={`w-11 text-xs font-semibold transition-colors ${fields.period === period ? "bg-accent text-on-accent" : "bg-raised hover:bg-line"}`}
										>
											{period}
										</button>
									))}
								</div>
							</div>
							{tooEarly && <p role="alert" className="text-xs text-red-500">Pick a time later than now.</p>}
							<button type="button" onClick={confirm} disabled={!ready} className="w-full h-10 rounded-lg bg-accent text-on-accent font-semibold transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent">
								Set time
							</button>
						</div>
					) : (
						<div className="grid grid-cols-7 gap-0.5 text-center">
							{WEEKDAYS.map(name => <span key={name} aria-hidden="true" className="py-1 text-[0.65rem] font-medium text-muted">{name.charAt(0)}</span>)}
							{monthCells(month).map((d, i) => d ? (
								<button
									key={d.getTime()}
									type="button"
									disabled={unavailable(d)}
									aria-pressed={sameDay(d, value)}
									aria-label={d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
									onClick={() => pickDay(d)}
									className={`aspect-square rounded-full text-xs transition-colors disabled:text-muted/40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${sameDay(d, value) ? "bg-accent text-on-accent font-semibold disabled:text-on-accent" : `hover:bg-raised ${sameDay(d, now) ? "ring-1 ring-inset ring-accent font-semibold" : ""}`}`}
								>
									{d.getDate()}
								</button>
							) : <span key={`blank-${i}`} />)}
						</div>
					)}
				</div>
			)}
		</div>
	);
};

export default TimePicker;
