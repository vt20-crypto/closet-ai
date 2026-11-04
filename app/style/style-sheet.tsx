"use client";

import { useEffect, useRef } from "react";

import { todayISO, tomorrowISO } from "@/lib/when";

interface StyleSheetProps {
  moods: readonly string[];
  occasions: readonly string[];
  times: readonly string[];
  mood: string | null;
  occasion: string | null;
  occasionText: string;
  destination: string;
  city: string;
  whenDate: string | null;
  timeOfDay: string | null;
  coords: { lat: number; lon: number } | null;
  locating: boolean;
  busy: boolean;
  canRun: boolean;
  onMood: (value: string | null) => void;
  onOccasion: (value: string | null) => void;
  onOccasionText: (value: string) => void;
  onDestination: (value: string) => void;
  onCity: (value: string) => void;
  onWhenDate: (value: string | null) => void;
  onTimeOfDay: (value: string | null) => void;
  onUseLocation: () => void;
  onSubmit: () => void;
  onClose: () => void;
}

function ChipRow({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly string[];
  value: string | null;
  onPick: (value: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold capitalize">{label}</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {options.map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onPick(selected ? null : option)}
              className={`min-h-11 rounded-full border px-4 text-base capitalize ${
                selected
                  ? "border-(--primary) bg-(--primary) font-semibold text-(--primary-text)"
                  : "border-(--border)"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Or choose" bottom sheet: compact When / Occasion / Mood / Where groups
 * plus one primary "Style me". Native dialog for focus trap + Esc.
 */
export default function StyleSheet(props: StyleSheetProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const chip = (selected: boolean, extra = "") =>
    `min-h-11 rounded-full border px-4 text-base capitalize ${selected ? "border-(--primary) bg-(--primary) font-semibold text-(--primary-text)" : "border-(--border)"} ${extra}`;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="style-sheet-title"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mx-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-[20px] border border-(--border-soft) bg-(--surface) p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-(--text) backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <h2 id="style-sheet-title" className="min-w-0 flex-1 font-display text-2xl">
            Choose your day
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="min-h-11 shrink-0 rounded-full border border-(--border) px-5 text-base font-semibold"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">When</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="When">
            <button
              type="button"
              aria-pressed={props.whenDate === null}
              onClick={() => props.onWhenDate(null)}
              className={chip(props.whenDate === null)}
            >
              Today
            </button>
            <button
              type="button"
              aria-pressed={props.whenDate === tomorrowISO()}
              onClick={() => props.onWhenDate(tomorrowISO())}
              className={chip(props.whenDate === tomorrowISO())}
            >
              Tomorrow
            </button>
            <label className="flex min-w-52 flex-1 items-center gap-2 text-base">
              Or pick a date
              <input
                type="date"
                value={props.whenDate ?? todayISO()}
                min={todayISO()}
                onChange={(event) => {
                  const picked = event.target.value;
                  props.onWhenDate(!picked || picked === todayISO() ? null : picked);
                }}
                className="min-h-11 flex-1 rounded-2xl border border-(--border) bg-(--surface) px-3"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Time of day">
            {props.times.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={props.timeOfDay === t}
                onClick={() => props.onTimeOfDay(props.timeOfDay === t ? null : t)}
                className={chip(props.timeOfDay === t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <ChipRow label="Occasion" options={props.occasions} value={props.occasion} onPick={props.onOccasion} />
        <ChipRow label="Mood" options={props.moods} value={props.mood} onPick={props.onMood} />

        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">Where (optional)</h3>
          <label className="flex flex-col gap-2 text-base">
            Anything more specific?
            <input
              type="text"
              value={props.occasionText}
              onChange={(event) => props.onOccasionText(event.target.value)}
              placeholder="e.g. rooftop birthday"
              maxLength={120}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
          <label className="flex flex-col gap-2 text-base">
            Destination
            <input
              type="text"
              value={props.destination}
              onChange={(event) => props.onDestination(event.target.value)}
              placeholder="e.g. The French Laundry"
              maxLength={120}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={props.busy || props.locating}
              onClick={props.onUseLocation}
              className="min-h-11 rounded-full border border-(--border) px-5 text-base font-semibold disabled:text-(--disabled-text)"
            >
              {props.coords ? "Location set ✓" : props.locating ? "Locating…" : "Use my location"}
            </button>
            <label className="flex min-w-44 flex-1 items-center gap-2 text-base">
              Or city
              <input
                type="text"
                value={props.city}
                onChange={(event) => props.onCity(event.target.value)}
                placeholder="e.g. Lisbon"
                maxLength={120}
                className="min-h-11 flex-1 rounded-2xl border border-(--border) bg-(--surface) px-3"
              />
            </label>
          </div>
        </div>

        {!props.canRun && !props.busy && (
          <p className="text-lg text-(--text-muted)">Pick a mood or occasion first — or just go back and talk.</p>
        )}
        <button
          type="button"
          disabled={props.busy || !props.canRun}
          onClick={() => {
            props.onSubmit();
            dialogRef.current?.close();
          }}
          className="min-h-14 w-full rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          {props.busy ? "Picking…" : "Style me"}
        </button>
      </div>
    </dialog>
  );
}
