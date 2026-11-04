// Date/time values for /style's When row and voice slot-fill. Pure.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function localISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(now: Date = new Date()): string {
  return localISO(now);
}

export function tomorrowISO(now: Date = new Date()): string {
  return localISO(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Resolve a spoken date reference to local YYYY-MM-DD. Handles ISO dates,
 * today/tomorrow, weekday names (next occurrence, today included), and
 * "june 3" style month+day (rolls to next year when past).
 */
export function resolveDateText(raw: string | null, now: Date = new Date()): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (text === "today") return todayISO(now);
  if (text === "tomorrow" || text === "tmrw") return tomorrowISO(now);
  const weekday = WEEKDAYS.indexOf(text);
  if (weekday >= 0) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
    return localISO(d);
  }
  const monthFirst = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  const dayFirst = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/);
  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const dayNum = Number(monthFirst?.[2] ?? dayFirst?.[1]);
  const month = monthName ? MONTHS.indexOf(monthName) : -1;
  if (month >= 0 && Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 31) {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let candidate = new Date(now.getFullYear(), month, dayNum);
    if (candidate.getMonth() !== month || candidate < startOfToday) {
      candidate = new Date(now.getFullYear() + 1, month, dayNum);
    }
    if (candidate.getMonth() !== month) return null; // e.g. Feb 30
    return localISO(candidate);
  }
  return null;
}

const TIME_WORDS: Record<string, "morning" | "afternoon" | "evening"> = {
  morning: "morning",
  breakfast: "morning",
  brunch: "morning",
  afternoon: "afternoon",
  lunch: "afternoon",
  midday: "afternoon",
  evening: "evening",
  dinner: "evening",
  drinks: "evening",
  night: "evening",
  tonight: "evening",
};

/** Normalize a spoken time word; unknown words stay null (no guessing). */
export function normalizeTimeOfDay(raw: string | null): "morning" | "afternoon" | "evening" | null {
  if (!raw) return null;
  return TIME_WORDS[raw.trim().toLowerCase()] ?? null;
}
