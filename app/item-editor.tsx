"use client";

import { useEffect, useRef, useState } from "react";

import { allowedFitAxes } from "@/lib/meta/tagSchema";

/** Minimal tags the edit sheet reads and writes (closet items + candidates). */
export interface EditableTags {
  nickname?: string;
  type: string;
  primary_color: string;
  fit?: string;
  length?: string;
  sleeve?: string;
  rise?: string;
  formality: number;
  warmth: number;
}

export interface EditableItem {
  id: string;
  label: string;
  cutoutUrl?: string;
  tags: EditableTags;
}

interface ItemEditorProps {
  item: EditableItem;
  /** Persist the draft; resolve with the saved tags or throw. */
  onSave: (id: string, draft: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

function ChipRow(props: {
  label: string;
  options: string[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold capitalize">{props.label}</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label={props.label}>
        {props.options.map((option) => {
          const selected = props.value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => props.onPick(option)}
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

function Stepper(props: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-lg font-semibold">{props.label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`Decrease ${props.label}`}
          disabled={props.value <= 1}
          onClick={() => props.onChange(Math.max(1, props.value - 1))}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-(--border) text-xl disabled:text-(--disabled-text)"
        >
          −
        </button>
        <span aria-live="polite" className="min-w-6 text-center text-lg">
          {props.value}
        </span>
        <button
          type="button"
          aria-label={`Increase ${props.label}`}
          disabled={props.value >= 5}
          onClick={() => props.onChange(Math.min(5, props.value + 1))}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-(--border) text-xl disabled:text-(--disabled-text)"
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Bottom sheet editor for garment tags: nickname, type, color, the fit axes
 * valid for the current type, and warmth/formality steppers. Compact chips,
 * no long form. Closing without saving discards the draft.
 */
export default function ItemEditor({ item, onSave, onClose }: ItemEditorProps) {
  const [nickname, setNickname] = useState(item.tags.nickname ?? "");
  const [type, setType] = useState(item.tags.type);
  const [color, setColor] = useState(item.tags.primary_color);
  const [fit, setFit] = useState(item.tags.fit ?? "n/a");
  const [length, setLength] = useState(item.tags.length ?? "n/a");
  const [sleeve, setSleeve] = useState(item.tags.sleeve ?? "n/a");
  const [rise, setRise] = useState(item.tags.rise ?? "n/a");
  const [formality, setFormality] = useState(item.tags.formality);
  const [warmth, setWarmth] = useState(item.tags.warmth);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Native dialog: focus trapped, Esc closes, backdrop tap closes.
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const axes = allowedFitAxes(type || item.tags.type);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(item.id, {
        nickname,
        type: type.trim(),
        primary_color: color.trim(),
        fit,
        length,
        sleeve,
        rise,
        formality,
        warmth,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="item-editor-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mx-auto max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-t-[20px] border border-(--border-soft) bg-(--surface) p-6 text-(--text) backdrop:bg-black/50"
    >
        <div className="flex flex-col gap-4">
          <h2 id="item-editor-title" className="font-display text-2xl">
            Edit {item.label}
          </h2>
          <label className="flex flex-col gap-2 text-lg">
            Nickname (≤ 2 words)
            <input
              type="text"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={16}
              placeholder="Daily Levi's"
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-2 text-lg">
              Type
              <input
                type="text"
                value={type}
                onChange={(event) => setType(event.target.value)}
                maxLength={60}
                className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
              />
            </label>
            <label className="flex flex-col gap-2 text-lg">
              Color
              <input
                type="text"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                maxLength={40}
                className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
              />
            </label>
          </div>
          {axes.fit.length > 0 && (
            <ChipRow label="Fit" options={[...axes.fit, "n/a"]} value={fit} onPick={setFit} />
          )}
          {axes.length.length > 0 && (
            <ChipRow label="Length" options={[...axes.length, "n/a"]} value={length} onPick={setLength} />
          )}
          {axes.sleeve.length > 0 && (
            <ChipRow label="Sleeve" options={[...axes.sleeve, "n/a"]} value={sleeve} onPick={setSleeve} />
          )}
          {axes.rise.length > 0 && (
            <ChipRow label="Rise" options={[...axes.rise, "n/a"]} value={rise} onPick={setRise} />
          )}
          <Stepper label="Warmth" value={warmth} onChange={setWarmth} />
          <Stepper label="Formality" value={formality} onChange={setFormality} />
          {error && (
            <p role="alert" className="text-lg">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="min-h-14 flex-1 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="min-h-14 flex-1 rounded-full border border-(--border) px-6 text-lg font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
    </dialog>
  );
}
