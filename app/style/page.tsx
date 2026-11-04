"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { tapeLabel } from "@/lib/labels";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { slotRank } from "@/lib/outfits";
import { buildSavedLook, type InventedItem } from "@/lib/render";
import { normalizeTimeOfDay, resolveDateText, tomorrowISO } from "@/lib/when";
import {
  applyMoreIdeas,
  createPager,
  currentPage,
  hasMore,
  nextPage,
  pageRange,
  type OutfitPagerState,
} from "@/lib/outfitPager";
import { speak, unlockSpeech } from "@/lib/speak";
import { stageStep } from "@/lib/stageNav";

import ItemEditor, { type EditableItem } from "../item-editor";
import { Sticker, Tape } from "../sticker";
import Stage from "./stage";
import StyleSheet from "./style-sheet";
import VoiceButton, { type VoiceSlots } from "./voice-button";

const CITY_KEY = "closet-ai-city";
const SESSION_KEY = "closet-ai-style-session";
/** Outage refire schedule: 30s, 60s, 120s, then the manual button only. */
const RETRY_DELAYS = [30_000, 60_000, 120_000];

interface SavedSession {
  v: 1;
  inputs: {
    mood: string | null;
    occasion: string | null;
    occasionText: string;
    destination: string;
    city: string;
    whenDate: string | null;
    timeOfDay: string | null;
    voiceRequested: boolean;
  };
  pager: OutfitPagerState<OutfitView> | null;
  itemCards: Record<string, ItemCard>;
  weather: WeatherView | null;
  dressCode: DressCodeView | null;
  relaxed: boolean;
  avatar?: { url: string; version: string } | null;
  renders?: Record<string, StageRecord>;
}

function isSavedSession(value: unknown): value is SavedSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.v !== 1) return false;
  const pager = s.pager as OutfitPagerState<OutfitView> | null;
  if (pager !== null) {
    if (typeof pager !== "object" || !Array.isArray(pager.list)) return false;
    if (typeof pager.index !== "number" || !Array.isArray(pager.seen)) return false;
    if (
      !pager.list.every(
        (o) => o && typeof o === "object" && typeof (o as { key?: unknown }).key === "string" && Array.isArray((o as { item_ids?: unknown }).item_ids),
      )
    ) {
      return false;
    }
  }
  if (typeof s.inputs !== "object" || s.inputs === null) return false;
  const maybeAvatar = s.avatar;
  if (maybeAvatar !== undefined && maybeAvatar !== null) {
    if (
      typeof maybeAvatar !== "object" ||
      typeof (maybeAvatar as { url?: unknown }).url !== "string" ||
      typeof (maybeAvatar as { version?: unknown }).version !== "string"
    ) {
      return false;
    }
  }
  const maybeRenders = (s as { renders?: unknown }).renders;
  if (maybeRenders !== undefined) {
    if (typeof maybeRenders !== "object" || maybeRenders === null) return false;
    for (const record of Object.values(maybeRenders as Record<string, unknown>)) {
      if (typeof record !== "object" || record === null) return false;
      const url = (record as { url?: unknown }).url;
      if (url !== null && url !== undefined && typeof url !== "string") return false;
    }
  }
  return true;
}

const MOODS = ["calm", "confident", "cozy", "bold", "lazy"] as const;
/** Sheet chips: errands/class map to Casual; gym stays reachable by voice/text. */
const OCCASIONS = ["work", "date night", "dinner", "brunch", "party", "casual"] as const;
const TIMES = ["morning", "afternoon", "evening"] as const;

interface OutfitView {
  item_ids: string[];
  reason: string;
  weather_note: string;
  key: string;
  /** Stamped client-side from the response that carried this card. */
  source: "ai" | "rules";
}

interface ItemCard {
  cutoutUrl: string;
  type: string;
  primary_color: string;
  /** Absent on items tagged before nicknames existed. */
  nickname?: string;
  slot: string;
}

interface WeatherView {
  highC: number;
  lowC: number;
  precipChancePct: number;
  windKph: number;
  placeName?: string;
}

interface DressCodeView {
  note: string | null;
  url: string | null;
  searched: boolean;
}

/** Server computes in °C; display °F for en-US, °C otherwise. */
function formatTemp(celsius: number): string {
  if (typeof navigator !== "undefined" && navigator.language === "en-US") {
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(celsius)}°C`;
}

function isEnUS(): boolean {
  return typeof navigator !== "undefined" && navigator.language === "en-US";
}

/** Server computes wind in kph; display mph for en-US, kph otherwise. */
function formatWind(kph: number): string {
  if (isEnUS()) return `${Math.round(kph * 0.621371)} mph`;
  return `${Math.round(kph)} kph`;
}

function weatherLine(weather: WeatherView): string {
  const place = weather.placeName ? `${weather.placeName}: ` : "";
  return (
    `${place}High ${formatTemp(weather.highC)}, low ${formatTemp(weather.lowC)}, ` +
    `${weather.precipChancePct}% rain, wind ${formatWind(weather.windKph)}.`
  );
}

const MISSING_HINTS: Record<string, string> = {
  tops: "a top (shirt, sweater, hoodie…)",
  bottoms: "pants, jeans, shorts or a skirt",
};

type StageRecord = {
  url: string | null;
  verified: boolean;
  invented: InventedItem[];
  note?: string;
  /** Image service was down: flat-lay stands in, one quiet retry pending. */
  outage?: boolean;
};

/** Full closet record for the garment detail dialog (fetched on tap). */
interface ClosetDetailItem {
  id: string;
  cutoutUrl: string;
  tags: {
    nickname?: string;
    type: string;
    primary_color: string;
    secondary_colors?: string[];
    formality: number;
    warmth: number;
    layer?: string;
    fabric_weight?: string;
    pattern?: string;
    seasons?: string[];
    distinguishing_note?: string;
    fit?: string;
    length?: string;
    sleeve?: string;
    rise?: string;
  };
}

/** Tap-a-garment detail: full tags + Edit, in a native bottom sheet. */
function GarmentDetailDialog({
  title,
  loading,
  item,
  onEdit,
  onClose,
}: {
  title: string;
  loading: boolean;
  item: ClosetDetailItem | null;
  onEdit: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="garment-detail-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mx-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-[20px] border border-(--border-soft) bg-(--surface) p-6 text-(--text) backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h2 id="garment-detail-title" className="min-w-0 flex-1 font-display text-2xl capitalize">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="min-h-11 shrink-0 rounded-full border border-(--border) px-5 text-base font-semibold"
          >
            Close
          </button>
        </div>
        {loading ? (
          <p className="text-lg">Loading…</p>
        ) : !item ? (
          <p className="text-lg">Couldn&apos;t load that piece.</p>
        ) : (
          <>
            <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-xl bg-(--paper) p-3">
              <Sticker
                src={item.cutoutUrl}
                alt={title}
                seedId={item.id}
                rich
              />
            </span>
            <dl className="flex flex-col gap-1 text-lg">
              <div className="flex gap-2">
                <dt className="font-semibold">Colors:</dt>
                <dd className="capitalize">
                  {[item.tags.primary_color, ...(item.tags.secondary_colors ?? [])].join(", ")}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold">Formality:</dt>
                <dd>{item.tags.formality} of 5</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold">Warmth:</dt>
                <dd>{item.tags.warmth} of 5</dd>
              </div>
              {item.tags.distinguishing_note && (
                <div className="flex gap-2">
                  <dt className="font-semibold">Note:</dt>
                  <dd>{item.tags.distinguishing_note}</dd>
                </div>
              )}
            </dl>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${title}`}
              className="min-h-14 w-full rounded-full border border-(--border) px-6 text-lg font-semibold"
            >
              Edit
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

function toGarmentEditable(item: ClosetDetailItem): EditableItem {
  return {
    id: item.id,
    label: `${item.tags.primary_color} ${item.tags.type}`,
    cutoutUrl: item.cutoutUrl,
    tags: {
      nickname: item.tags.nickname ?? "",
      type: item.tags.type,
      primary_color: item.tags.primary_color,
      fit: item.tags.fit ?? "n/a",
      length: item.tags.length ?? "n/a",
      sleeve: item.tags.sleeve ?? "n/a",
      rise: item.tags.rise ?? "n/a",
      formality: item.tags.formality,
      warmth: item.tags.warmth,
    },
  };
}

/** Store one record, dropping entries from older avatar versions. */
function storeRender(
  prev: Record<string, StageRecord>,
  version: string,
  key: string,
  record: StageRecord,
) {
  const next: Record<string, StageRecord> = {};
  for (const [storedKey, stored] of Object.entries(prev)) {
    if (storedKey.startsWith(`${version}|`)) next[storedKey] = stored;
  }
  next[key] = record;
  return next;
}

/** Tiny spark mark for the quiet credit line under each outfit. */
function SparkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 0l1.2 4.8L12 6 7.2 7.2 6 12 4.8 7.2 0 6l4.8-1.2z" />
    </svg>
  );
}

export default function TodayPage() {
  const [mood, setMood] = useState<string | null>(null);
  const [occasion, setOccasion] = useState<string | null>(null);
  const [occasionText, setOccasionText] = useState("");
  const [destination, setDestination] = useState("");
  const [city, setCity] = useState("");
  /** Local YYYY-MM-DD; null = today. */
  const [whenDate, setWhenDate] = useState<string | null>(null);
  const [timeOfDay, setTimeOfDay] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pager, setPager] = useState<OutfitPagerState<OutfitView> | null>(null);
  const pagerRef = useRef<OutfitPagerState<OutfitView> | null>(null);
  pagerRef.current = pager;
  const [itemCards, setItemCards] = useState<Record<string, ItemCard>>({});
  const [weather, setWeather] = useState<WeatherView | null>(null);
  const [dressCode, setDressCode] = useState<DressCodeView | null>(null);
  const [dressOpen, setDressOpen] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [status, setStatus] = useState("Pick a mood and an occasion to get dressed.");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [retryAction, setRetryAction] = useState<null | (() => void)>(null);
  const [heard, setHeard] = useState<string | null>(null);
  /** Transcript awaiting one-tap accept (auto-accepts after 3s). */
  const [pendingVoice, setPendingVoice] = useState<{ transcript: string; slots: VoiceSlots } | null>(null);
  const [heardDraft, setHeardDraft] = useState("");
  const pendingRef = useRef<{ transcript: string; slots: VoiceSlots } | null>(null);
  const draftRef = useRef("");
  const acceptTimer = useRef<number | null>(null);
  const [relaxed, setRelaxed] = useState(false);
  /** "Your closet changed · Refresh looks" pill, set on focus/visibility. */
  const [closetPill, setClosetPill] = useState(false);
  const looksStampRef = useRef<{ stamp: string; count: number } | null>(null);
  const [depletedKey, setDepletedKey] = useState<string | null>(null);
  const [ranKey, setRanKey] = useState<string | null>(null);
  const [rulesNoteKey, setRulesNoteKey] = useState<string | null>(null);
  /** Thumbs votes per outfit key; the next outfits call turns them into pair feedback. */
  const [votes, setVotes] = useState<Record<string, 1 | -1>>({});

  async function vote(outfitKey: string, itemIds: string[], value: 1 | -1) {
    const next = votes[outfitKey] === value ? 0 : value;
    const prev = votes[outfitKey];
    setVotes((current) => {
      const updated = { ...current };
      if (next === 0) delete updated[outfitKey];
      else updated[outfitKey] = next;
      return updated;
    });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outfitKey, itemIds, vote: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setVotes((current) => {
        const updated = { ...current };
        if (prev === undefined) delete updated[outfitKey];
        else updated[outfitKey] = prev;
        return updated;
      });
    }
  }
  const [voiceRequested, setVoiceRequested] = useState(false);

  // Stage: avatar spotlight for the selected look. Persisted for the session
  // so revisits paint instantly; the pointer fetch still refreshes it.
  const [avatar, setAvatar] = useState<{ url: string; version: string } | null | undefined>(undefined);
  // Storage outage: suppress the "Create your avatar" CTA (never on read error).
  const [avatarDown, setAvatarDown] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [showItems, setShowItems] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [refiring, setRefiring] = useState(false);
  const [renders, setRenders] = useState<Record<string, StageRecord>>({});
  const rendersRef = useRef<Record<string, StageRecord>>({});
  rendersRef.current = renders;
  const verifyLookRef = useRef<
    | ((
    outfit: OutfitView,
    record: { url: string | null; verified: boolean },
    version: string,
  ) => Promise<void>)
    | null
  >(null);
  /** Quiet outage retries (30s, 60s, 120s); timers cleared on unmount. */
  const retryTimers = useRef<number[]>([]);
  const retryAttempts = useRef(new Map<string, number>());
  /** Keys of the looks on the visible page; retries only fire for these. */
  const pageKeysRef = useRef<Set<string>>(new Set());
  const refireRef = useRef<((outfit: OutfitView, key: string, version: string) => Promise<boolean>) | null>(null);
  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      if (acceptTimer.current !== null) window.clearTimeout(acceptTimer.current);
    };
  }, []);
  const inflightRef = useRef<Set<string>>(new Set());
  const verifyInflightRef = useRef<Set<string>>(new Set());
  /** "Or choose" bottom sheet. */
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Garment detail dialog: item id, loaded record, loading flag. */
  const [garmentId, setGarmentId] = useState<string | null>(null);
  const [garmentItem, setGarmentItem] = useState<ClosetDetailItem | null>(null);
  const [garmentLoading, setGarmentLoading] = useState(false);
  const [garmentEditing, setGarmentEditing] = useState(false);
  const closetCache = useRef<Record<string, ClosetDetailItem> | null>(null);

  function resetStage() {
    setStageIndex(0);
    setShowItems(false);
    setSaveNote(null);
  }

  // The cards on screen: exactly the pager's current page (at most 3).
  const page = pager ? currentPage(pager) : [];
  pageKeysRef.current = new Set(page.map((outfit) => `${avatar?.version ?? "?"}|${outfit.key}`));
  const showShuffle = pager !== null && hasMore(pager);
  const showMoreIdeas = pager !== null && !hasMore(pager);

  // Get outfits unlocks with any single input or a completed voice request.
  const canRun =
    Boolean(mood) ||
    Boolean(occasion) ||
    occasionText.trim() !== "" ||
    destination.trim() !== "" ||
    whenDate !== null ||
    timeOfDay !== null ||
    voiceRequested;

  // "More ideas" stays disabled after an empty round until the inputs change:
  // depletion records the inputs key it happened under.
  const inputsKey = [
    mood ?? "",
    occasion ?? "",
    occasionText,
    destination,
    city,
    coords?.lat ?? "",
    coords?.lon ?? "",
    whenDate ?? "",
    timeOfDay ?? "",
  ].join("|");
  const moreDepleted = depletedKey !== null && depletedKey === inputsKey;
  // After results exist, Get outfits rests until the inputs change again.
  const getStale = pager !== null && ranKey === inputsKey;

  // Render records are keyed by avatar version + look: a Redo drops every
  // older record without a state-clearing effect.
  const renderKey = (lookKey: string) => `${avatar?.version ?? "?"}|${lookKey}`;

  /** Outage refires at 30s, 60s, 120s (max 3), visible page only. */
  const armOutageRetry = useCallback((outfit: OutfitView, key: string, version: string) => {
    const schedule = (attempt: number): void => {
      if (attempt >= RETRY_DELAYS.length) return;
      const timer = window.setTimeout(() => {
        void (async () => {
          // A swiped-away look waits for its return or the manual button.
          if (!pageKeysRef.current.has(key)) return;
          if (rendersRef.current[key]?.outage !== true) return;
          retryAttempts.current.set(key, attempt + 1);
          const ok = await refireRef.current?.(outfit, key, version);
          if (!ok) schedule(attempt + 1);
        })();
      }, RETRY_DELAYS[attempt] as number);
      retryTimers.current.push(timer);
    };
    schedule(retryAttempts.current.get(key) ?? 0);
  }, []);

  // The staged look: exactly one spotlight look at a time.
  const staged = page.length > 0 ? page[Math.min(stageIndex, page.length - 1)] : undefined;
  const stagedCards = staged
    ? staged.item_ids
        .map((id) => ({ id, card: itemCards[id] }))
        .filter((entry): entry is { id: string; card: ItemCard } => Boolean(entry.card))
        .sort((a, b) => slotRank(a.card.slot) - slotRank(b.card.slot))
    : [];

  /** Day · temp · place pill up top; opens the sheet for day/place edits. */
  const pillDay = whenDate === null ? "Today" : whenDate === tomorrowISO() ? "Tomorrow" : whenDate;
  const pillPlace = destination.trim() || city.trim() || weather?.placeName?.trim() || "anywhere";
  const pillLabel = weather
    ? `${pillDay} · ${formatTemp(weather.highC)} · ${pillPlace}`
    : `${pillDay} · ${pillPlace}`;

  function goStage(delta: number) {
    if (page.length === 0) return;
    // Swipe and arrows share one helper so they can never disagree.
    setStageIndex((index) => stageStep(index, delta, page.length));
    setShowItems(false);
    setSaveNote(null);
  }

  /** Back to the base outfit: clears looks but keeps every input. */
  function startOver() {
    setPager(null);
    resetStage();
    setShowItems(false);
    setSaveNote(null);
    setMissing([]);
    setStatus("Pick a mood and an occasion to get dressed.");
  }

  // Remember the last city across visits (loaded after mount: no SSR value).
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const saved = window.localStorage.getItem(CITY_KEY);
        if (saved) setCity(saved);
      } catch {
        // Private mode: city simply isn't remembered.
      }
    });
  }, []);

  async function readClosetVersion(): Promise<{ stamp: string; count: number } | null> {
    try {
      const res = await fetch("/api/closet/version", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { stamp?: unknown; count?: unknown };
      if (typeof body.stamp !== "string" || typeof body.count !== "number") return null;
      return { stamp: body.stamp, count: body.count };
    } catch {
      return null;
    }
  }

  // On return to the tab, compare the closet version with the one the
  // current looks were picked from. A mismatch shows a quiet refresh pill —
  // never a popup, never an auto re-run. At most one check per 60s.
  useEffect(() => {
    let lastCheck = 0;
    const check = () => {
      if (!pagerRef.current) return;
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void (async () => {
        const version = await readClosetVersion();
        if (!version) return;
        const prev = looksStampRef.current;
        if (!prev) {
          looksStampRef.current = version;
          return;
        }
        if (version.stamp !== prev.stamp || version.count !== prev.count) {
          setClosetPill(true);
        }
      })();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  // Restore the session's inputs + pager (e.g. back from /dress keeps results).
  // Mount-only sync from sessionStorage: setting state once on mount is the
  // whole point, so this effect is exempt from the cascading-render rule.
  /* eslint-disable react-hooks/set-state-in-effect -- single mount-only restore from sessionStorage */
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (!isSavedSession(saved)) return;
      setMood(saved.inputs.mood);
      setOccasion(saved.inputs.occasion);
      setOccasionText(saved.inputs.occasionText);
      setDestination(saved.inputs.destination);
      if (saved.inputs.city) handleCityChange(saved.inputs.city);
      setWhenDate(saved.inputs.whenDate);
      setTimeOfDay(saved.inputs.timeOfDay);
      setVoiceRequested(saved.inputs.voiceRequested);
      if (saved.pager) {
        setPager(saved.pager);
        resetStage();
        setItemCards(saved.itemCards ?? {});
        setWeather(saved.weather ?? null);
        setDressCode(saved.dressCode ?? null);
        setRelaxed(saved.relaxed === true);
        if (saved.avatar !== undefined) setAvatar(saved.avatar);
        if (saved.renders) setRenders(saved.renders);
        setStatus("Restored your last looks.");
      } else if (saved.avatar !== undefined) {
        setAvatar(saved.avatar);
      } else if (saved.renders) {
        setRenders(saved.renders);
      }
    } catch {
      // Corrupt session: start fresh.
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist inputs + results for the session (Save, and back-nav from /dress).
  // Avatar + renders ride along so revisits paint instantly.
  useEffect(() => {
    try {
      const saved: SavedSession = {
        v: 1,
        inputs: { mood, occasion, occasionText, destination, city, whenDate, timeOfDay, voiceRequested },
        pager,
        itemCards,
        weather,
        dressCode,
        relaxed,
        avatar: avatar === undefined ? undefined : avatar,
        renders,
      };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
    } catch {
      // Private mode: the session simply isn't restored.
    }
  }, [mood, occasion, occasionText, destination, city, whenDate, timeOfDay, voiceRequested, pager, itemCards, weather, dressCode, relaxed, avatar, renders]);

  // Load the avatar pointer once (no-store: a redo replaces it).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const body = (await res.json()) as {
          avatar?: { url: string; version: string } | null;
          code?: string;
        };
        if (cancelled) return;
        if (res.status === 503 && body.code === "storage_unavailable") {
          setAvatarDown(true);
          return;
        }
        setAvatarDown(false);
        setAvatar(res.ok ? (body.avatar ?? null) : null);
      } catch {
        if (!cancelled) setAvatar(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Preload the base avatar so the stage paints instantly on every visit.
  useEffect(() => {
    if (!avatar?.url) return;
    const img = new Image();
    img.src = avatar.url;
  }, [avatar?.url]);

  // First image for one look: returns the stored record, "no-avatar" when the
  // avatar is gone, or null when there is nothing to store (cached, in
  // flight). Failures store a flat-lay fallback record, never an error.
  const renderLook = useCallback(
    async (
      outfit: OutfitView,
    ): Promise<
      | { url: string | null; verified: boolean; invented: InventedItem[]; note?: string }
      | "no-avatar"
      | null
    > => {
      const key = `${avatar?.version ?? "?"}|${outfit.key}`;
      const existing = rendersRef.current[key];
      if (existing) return existing;
      if (!avatar || inflightRef.current.has(key)) return null;
      inflightRef.current.add(key);
      try {
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds: outfit.item_ids }),
        });
        const body = (await res.json()) as {
          url?: string | null;
          verified?: boolean;
          invented?: InventedItem[];
          note?: string;
          code?: string;
        };
        if (!res.ok) {
          if (body.code === "no-avatar") return "no-avatar";
          // Image outage: the flat-lay stands in with a calm note, and
          // quiet retries refire at 30s/60s/120s. Never an error banner.
          const outage = body.code === META_UNAVAILABLE_CODE;
          const fallback: StageRecord = {
            url: null,
            verified: false,
            invented: [],
            note: outage ? "Showing your pieces." : "Couldn't put this look on your avatar right now - here are the pieces.",
            ...(outage ? { outage: true as const } : {}),
          };
          const atVersion = avatar.version;
          setRenders((prev) => storeRender(prev, atVersion, key, fallback));
          if (outage) armOutageRetry(outfit, key, atVersion);
          return fallback;
        }
        const record = {
          url: body.url ?? null,
          verified: false,
          invented: [] as InventedItem[],
        };
        const atVersion = avatar.version;
        setRenders((prev) => storeRender(prev, atVersion, key, record));
        return record;
      } catch {
        const atVersion = avatar.version;
        const fallback = {
          url: null,
          verified: false,
          invented: [] as InventedItem[],
          note: "Couldn't put this look on your avatar right now - here are the pieces.",
        };
        setRenders((prev) => storeRender(prev, atVersion, key, fallback));
        return fallback;
      } finally {
        inflightRef.current.delete(key);
      }
    },
    [avatar, armOutageRetry],
  );

  // Background verification for one look: on a real failure the route
  // re-renders and the new URL swaps in (the <img> keeps old pixels until
  // the new ones decode, so there is no blank frame).
  const verifyLook = useCallback(
    async (
      outfit: OutfitView,
      record: { url: string | null; verified: boolean },
      version: string,
    ): Promise<void> => {
      const key = `${version}|${outfit.key}`;
      if (!record.url || record.verified || verifyInflightRef.current.has(key)) return;
      verifyInflightRef.current.add(key);
      try {
        const res = await fetch("/api/render/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds: outfit.item_ids }),
        });
        const body = (await res.json()) as {
          url?: string | null;
          verified?: boolean;
          invented?: InventedItem[];
          note?: string;
          code?: string;
        };
        if (!res.ok) {
          if (body.code === "no-avatar") setAvatar(null);
          return;
        }
        const next = {
          url: body.url ?? record.url,
          verified: body.verified === true,
          invented: body.invented ?? [],
          note: body.note,
        };
        setRenders((prev) => storeRender(prev, version, key, next));
      } catch {
        // Keep the first image.
      } finally {
        verifyInflightRef.current.delete(key);
      }
    },
    [],
  );
  verifyLookRef.current = verifyLook;

  /**
   * One refire against /api/render: swaps the flat-lay for the image with
   * the fade-in, then verifies in the background. True on success.
   */
  const refireRender = useCallback(
    async (outfit: OutfitView, key: string, version: string): Promise<boolean> => {
      if (rendersRef.current[key]?.outage !== true) return false;
      try {
        const retry = await fetch("/api/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds: outfit.item_ids }),
        });
        const retryBody = (await retry.json()) as { url?: string | null };
        if (!retry.ok || !retryBody.url) return false;
        const record: StageRecord = { url: retryBody.url, verified: false, invented: [] };
        setRenders((prev) => storeRender(prev, version, key, record));
        await verifyLookRef.current?.(outfit, record, version);
        return true;
      } catch {
        // The flat-lay stays; no error surfaces.
        return false;
      }
    },
    [],
  );
  refireRef.current = refireRender;

  /** Manual "Try on avatar" refire from the flat-lay. */
  async function manualRefire() {
    if (!staged || !avatar || refiring) return;
    setRefiring(true);
    try {
      const ok = await refireRef.current?.(staged, renderKey(staged.key), avatar.version);
      if (!ok) armOutageRetry(staged, renderKey(staged.key), avatar.version);
    } finally {
      setRefiring(false);
    }
  }

  // Render every look on the page in parallel (at most 3), then verify each
  // in the background. The user never waits on verification.
  useEffect(() => {
    if (!avatar || !pager) return;
    const current = currentPage(pager);
    if (current.length === 0) return;
    const version = avatar.version;
    let cancelled = false;
    for (const outfit of current.slice(0, 3)) {
      void (async () => {
        const record = await renderLook(outfit);
        if (cancelled || !record || record === "no-avatar") {
          if (record === "no-avatar" && !cancelled) setAvatar(null);
          return;
        }
        await verifyLook(outfit, record, version);
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [avatar, pager, renderLook, verifyLook]);

  // Persist the staged look for the upcoming Lookbook task (stub until then).
  function saveLook(outfit: OutfitView) {
    try {
      const look = buildSavedLook(outfit.item_ids, {
        date: whenDate,
        timeOfDay,
        place: destination.trim() || weather?.placeName?.trim() || null,
        renderUrl: renders[renderKey(outfit.key)]?.url ?? null,
      });
      window.sessionStorage.setItem("closet-ai-saved-look", JSON.stringify(look));
    } catch {
      // Private mode: the note below still confirms the tap.
    }
    setSaveNote("Lookbook is coming soon — this look is set aside for it.");
  }

  /** Open the garment detail dialog; closet records are fetched once and cached. */
  async function openGarment(id: string) {
    setGarmentId(id);
    setGarmentEditing(false);
    const cached = closetCache.current?.[id];
    if (cached) {
      setGarmentItem(cached);
      return;
    }
    setGarmentItem(null);
    setGarmentLoading(true);
    try {
      const res = await fetch("/api/closet", { cache: "no-store" });
      const body = (await res.json()) as { items?: ClosetDetailItem[] };
      if (res.ok && Array.isArray(body.items)) {
        const next: Record<string, ClosetDetailItem> = {};
        for (const item of body.items) next[item.id] = item;
        closetCache.current = next;
        setGarmentItem(next[id] ?? null);
      } else {
        setGarmentItem(null);
      }
    } catch {
      setGarmentItem(null);
    } finally {
      setGarmentLoading(false);
    }
  }

  /** Fresh pick with the current inputs, then read the first look aloud. */
  function runFresh() {
    void fetchOutfits([], "Getting your outfits…").then((run) => {
      if (run && run.outfits.length > 0) {
        speakOutfit(run.outfits[0], run.outfits.length, run.items, run.weather, run.dressCode);
      }
    });
  }

  /** Persist an edit-sheet draft; refreshes the look's nickname tape. */
  async function saveGarmentEdit(id: string, draft: Record<string, unknown>) {
    const res = await fetch(`/api/closet/items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = (await res.json()) as { item?: ClosetDetailItem; error?: string };
    const updated = body.item;
    if (!res.ok || !updated) throw new Error(body.error ?? `HTTP ${res.status}`);
    closetCache.current = { ...(closetCache.current ?? {}), [id]: updated };
    setGarmentItem(updated);
    setItemCards((prev) => {
      const card = prev[id];
      if (!card) return prev;
      return {
        ...prev,
        [id]: {
          ...card,
          type: updated.tags.type,
          primary_color: updated.tags.primary_color,
          nickname: updated.tags.nickname,
        },
      };
    });
    setGarmentEditing(false);
    setStatus("Saved.");
  }

  function handleCityChange(value: string) {
    setCity(value);
    try {
      window.localStorage.setItem(CITY_KEY, value);
    } catch {
      // Private mode: city simply isn't remembered.
    }
  }

  /** Status line counts the cards shown; each card's badge carries its origin. */
  function pageStatus(p: OutfitPagerState<OutfitView>): string {
    const n = currentPage(p).length;
    const range = pageRange(p);
    if (range.from <= 1) return `${n} ${n === 1 ? "look" : "looks"} for you.`;
    return `Look ${range.from}–${range.to}.`;
  }

  async function fetchOutfits(
    exclude: string[],
    label: string,
    isRetry = false,
    overrides?: {
      mood: string | null;
      occasion: string | null;
      occasionText: string;
      destination: string;
      city: string;
      date: string | null;
      timeOfDay: string | null;
    },
    mode: "fresh" | "more" = "fresh",
  ) {
    // Mood and occasion are optional hints; the pick works without them.
    const moodV = overrides?.mood ?? mood;
    const occasionV = overrides?.occasion ?? occasion;
    const occasionTextV = overrides?.occasionText ?? occasionText;
    const destinationV = overrides?.destination ?? destination;
    const cityV = overrides?.city ?? city;
    const dateV = overrides?.date ?? whenDate;
    const timeOfDayV = overrides?.timeOfDay ?? timeOfDay;
    setBusy(true);
    setStatus(label);
    setRetryAction(null);
    // "More ideas" appends; only a fresh pick resets the pager and flags.
    if (mode === "fresh") {
      setPager(null);
      resetStage();
      setDepletedKey(null);
      setRelaxed(false);
    }
    const hiccupTimer = window.setTimeout(
      () => setStatus(META_HICCUP_MESSAGE),
      8000,
    );
    try {
      const res = await fetch("/api/outfits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mood: moodV,
          occasion: occasionV,
          occasionText: occasionTextV.trim() || undefined,
          destination: destinationV.trim() || undefined,
          lat: coords?.lat,
          lon: coords?.lon,
          city: cityV.trim() || undefined,
          date: dateV ?? undefined,
          timeOfDay: timeOfDayV ?? undefined,
          exclude,
          // "More ideas" accepts weaker fits; the first pick wants only strong looks.
          ...(mode === "more" ? { minScore: 5 } : {}),
        }),
      });
      const body = (await res.json()) as {
        source?: "ai" | "rules";
        relaxed?: boolean;
        outfits?: OutfitView[];
        items?: Record<string, ItemCard>;
        weather?: WeatherView | null;
        dressCode?: DressCodeView | null;
        missing?: string[];
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        const failure = new Error(body.error ?? `HTTP ${res.status}`);
        (failure as { code?: string }).code = body.code;
        throw failure;
      }
      if ((body.missing ?? []).length > 0) {
        window.clearTimeout(hiccupTimer);
        setMissing(body.missing ?? []);
        setPager(null);
        resetStage();
        setStatus("Your closet can't make a full outfit yet.");
        return null;
      }
      setMissing([]);
      const fresh = body.outfits ?? [];
      const nextWeather = body.weather ?? null;
      const nextDress = body.dressCode ?? null;
      if (mode === "more") {
        window.clearTimeout(hiccupTimer);
        setWeather(nextWeather);
        setDressCode(nextDress);
        // Stamp every card with its own response's source; nothing carries over.
        const bodySource: "ai" | "rules" = body.source === "rules" ? "rules" : "ai";
        const stamped = fresh.map((o) => ({ ...o, source: bodySource }));
        // Appending to a pager captured before the await keeps every shown combo excluded.
        const folded = pager ? applyMoreIdeas(pager, stamped) : null;
        if (!folded || folded.depleted) {
          setDepletedKey(inputsKey);
          setStatus("No more good looks for this combination. Try another mood or occasion.");
          return null;
        }
        setPager(folded.state);
        resetStage();
        const merged = { ...itemCards, ...(body.items ?? {}) };
        setItemCards(merged);
        setStatus(folded.added === 1 ? "1 new look." : `${folded.added} new looks.`);
        return { outfits: currentPage(folded.state), items: merged, weather: nextWeather, dressCode: nextDress };
      }
      if (fresh.length === 0) {
        window.clearTimeout(hiccupTimer);
        // Source stays untouched on empty responses.
        setStatus("No outfits came back. Try again or change the mood.");
        return null;
      }
      // Stamp every card with its own response's source; nothing carries over.
      const bodySource: "ai" | "rules" = body.source === "rules" ? "rules" : "ai";
      setRelaxed(body.relaxed === true);
      // Remember the inputs these results were picked for (voice fills the
      // same overrides, so voice requests count as a change too).
      setRanKey(
        [
          moodV ?? "",
          occasionV ?? "",
          occasionTextV,
          destinationV,
          cityV,
          coords?.lat ?? "",
          coords?.lon ?? "",
          dateV ?? "",
          timeOfDayV ?? "",
        ].join("|"),
      );
      window.clearTimeout(hiccupTimer);
      const items = body.items ?? {};
      const started = createPager(fresh.map((o) => ({ ...o, source: bodySource })));
      setPager(started);
      resetStage();
      setItemCards(items);
      setWeather(nextWeather);
      setDressCode(nextDress);
      setStatus(pageStatus(started));
      // The looks now match the current closet; the pill rests until it moves.
      setClosetPill(false);
      void readClosetVersion().then((version) => {
        if (version) looksStampRef.current = version;
      });
      return { outfits: currentPage(started), items, weather: nextWeather, dressCode: nextDress };
    } catch (err) {
      window.clearTimeout(hiccupTimer);
      if ((err as { code?: string }).code === "storage_unavailable") {
        setStatus("Can't reach your closet right now. Your pieces are safe - try again in a minute.");
        return null;
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE && !isRetry) {
        setStatus(META_HICCUP_MESSAGE);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fetchOutfits(exclude, label, true, overrides, mode);
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        setStatus("Your stylist is still taking a breather.");
        setRetryAction(() => () => {
          setRetryAction(null);
          void fetchOutfits(exclude, label, false, overrides, mode);
        });
        return null;
      }
      const message = err instanceof Error ? err.message : "Outfit picking failed.";
      setStatus(`Couldn't get outfits: ${message}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setStatus("Geolocation isn't available — type a city instead.");
      return;
    }
    setLocating(true);
    setStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        setCoords({ lat, lon });
        setStatus(`Using your location (${lat.toFixed(2)}, ${lon.toFixed(2)}). Now get your outfits.`);
        setLocating(false);
      },
      (error) => {
        // 1 = permission denied, 2 = position unavailable, 3 = timeout.
        if (error.code === 1) {
          setStatus("Location is off for Safari. Type your city instead.");
        } else if (error.code === 3) {
          setStatus("Location timed out. Type your city instead.");
        } else {
          setStatus("Location unavailable. Type your city instead.");
        }
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }

  function speakOutfit(
    first: OutfitView,
    total: number,
    items: Record<string, ItemCard>,
    weatherV: WeatherView | null,
    dress: DressCodeView | null,
  ) {
    const names = first.item_ids.map((id) => {
      const card = items[id];
      return card ? tapeLabel(card) : "an item";
    });
    const parts = [
      total > 1 ? `Outfit 1 of ${total}: ${names.join(", ")}.` : `Today: ${names.join(", ")}.`,
      first.reason,
    ];
    if (weatherV) parts.push(`Weather: ${weatherLine(weatherV)} ${first.weather_note}`);
    if (dress?.note) parts.push(`Dress code: ${dress.note}`);
    const text = parts.join(" ");
    speak(text);
  }

  function reportVoice(message: string, speakIt = false) {
    setStatus(message);
    if (speakIt) speak(message);
  }

  function clearAcceptTimer() {
    if (acceptTimer.current !== null) {
      window.clearTimeout(acceptTimer.current);
      acceptTimer.current = null;
    }
  }

  function acceptVoice() {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setPendingVoice(null);
    clearAcceptTimer();
    const text = draftRef.current.trim() || pending.transcript;
    void applyVoice(text, pending.slots);
  }

  /** A fresh transcript waits for one tap (or 3s) so it can be edited first. */
  function offerVoice(transcript: string, slots: VoiceSlots) {
    pendingRef.current = { transcript, slots };
    setPendingVoice({ transcript, slots });
    draftRef.current = transcript;
    setHeardDraft(transcript);
    clearAcceptTimer();
    acceptTimer.current = window.setTimeout(() => {
      acceptTimer.current = null;
      acceptVoice();
    }, 3000);
  }

  async function applyVoice(transcript: string, slots: VoiceSlots) {
    const matchChip = (value: string | null, list: readonly string[]): string | null => {
      if (!value) return null;
      const clean = value.toLowerCase();
      return (list as readonly string[]).includes(clean) ? clean : null;
    };
    // Anything that isn't a chip word becomes occasion detail text.
    const moodV = matchChip(slots.mood, MOODS) ?? mood;
    const occasionV = matchChip(slots.occasion, OCCASIONS) ?? occasion;
    const extra = [slots.mood && !moodV ? slots.mood : null, slots.occasion && !occasionV ? slots.occasion : null]
      .filter(Boolean)
      .join(" ");
    const occasionTextV = [extra, slots.occasion_text ?? ""].filter(Boolean).join(" ");
    const destinationV = slots.destination ?? "";
    // Spoken date/time override the chip presets.
    const dateV = resolveDateText(slots.date_text);
    const timeOfDayV = normalizeTimeOfDay(slots.time);
    if (moodV) setMood(moodV);
    if (occasionV) setOccasion(occasionV);
    setOccasionText(occasionTextV);
    setDestination(destinationV);
    if (slots.city) handleCityChange(slots.city);
    if (dateV) setWhenDate(dateV);
    if (timeOfDayV) setTimeOfDay(timeOfDayV);
    setHeard(transcript);
    setVoiceRequested(true);
    const run = await fetchOutfits([], "Getting your outfits…", false, {
      mood: moodV,
      occasion: occasionV,
      occasionText: occasionTextV,
      destination: destinationV,
      city: slots.city ?? city,
      date: dateV ?? whenDate,
      timeOfDay: timeOfDayV ?? timeOfDay,
    });
    if (run && run.outfits.length > 0) {
      speakOutfit(run.outfits[0], run.outfits.length, run.items, run.weather, run.dressCode);
    }
  }

  /** ASR bias words: chips + closet nicknames/colors + date words + city. */
  const voiceKeywords = [
    ...new Set(
      [
        ...MOODS,
        ...OCCASIONS,
        "tomorrow",
        "tonight",
        "weekend",
        "birthday",
        "wedding",
        "interview",
        ...Object.values(itemCards).flatMap((card) => [card.nickname ?? "", card.primary_color ?? ""]),
        city,
      ]
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length > 0),
    ),
  ].slice(0, 50);

  // Stage wiring: one spotlight look at a time; the base avatar is always
  // underneath so swiping back (or to a still-rendering look) never blanks.
  const hasResults = page.length > 0;
  const stagedIndex = staged ? Math.min(stageIndex, page.length - 1) : 0;
  const stagedRecord: StageRecord | undefined =
    staged && avatar ? renders[renderKey(staged.key)] : undefined;
  const stagedRendering = Boolean(staged && avatar && !stagedRecord);
  const stagedFlatLay = Boolean(staged && stagedRecord && !stagedRecord.url);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 pb-[calc(7rem+env(safe-area-inset-bottom))] md:max-w-[960px] md:pb-6">
      <h1 className="sr-only">Style</h1>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label={`Day and place: ${pillLabel}. Change day or place.`}
          className="min-h-11 rounded-full border border-(--border) bg-(--surface) px-5 text-lg font-semibold"
        >
          <Tape label={pillLabel} seedId="day-place" />
        </button>
      </div>

      <Stage
        avatarUrl={avatar?.url ?? null}
        dressedUrl={stagedRecord?.url && !showItems ? (stagedRecord.url ?? null) : null}
        rendering={stagedRendering && !showItems}
        flatLay={
          staged && (showItems || stagedFlatLay) ? (
            <div className="absolute inset-0 overflow-y-auto bg-(--surface) p-4">
              <ul className="grid grid-cols-2 gap-3" aria-label="Look garments, laid flat">
                {stagedCards.map(({ id, card }) => (
                  <li
                    key={id}
                    className="flex aspect-[3/4] items-center justify-center rounded-xl bg-(--paper) p-2"
                  >
                    <Sticker
                      src={card.cutoutUrl}
                      alt={`${card.type} in ${card.primary_color}`}
                      seedId={id}
                    />
                  </li>
                ))}
              </ul>
              {stagedRecord?.note && !showItems && (
                <p className="pt-3 text-center text-lg text-(--text-muted)">{stagedRecord.note}</p>
              )}
              {stagedRecord?.outage && !showItems && (
                <div className="flex justify-center pt-3">
                  <button
                    type="button"
                    disabled={refiring}
                    onClick={() => void manualRefire()}
                    className="min-h-14 rounded-full border border-(--border) bg-(--surface) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
                  >
                    {refiring ? "Trying…" : "Try on avatar"}
                  </button>
                </div>
              )}
            </div>
          ) : undefined
        }
        announce={
          staged
            ? `Look ${stagedIndex + 1} of ${page.length}: ${staged.reason}`
            : "Your stage"
        }
        position={hasResults ? `${stagedIndex + 1} of ${page.length}` : "Your stage"}
        index={stagedIndex}
        total={page.length}
        onJump={(i) => {
          setStageIndex(i);
          setShowItems(false);
          setSaveNote(null);
        }}
        hasMany={page.length > 1}
        onPrev={() => goStage(-1)}
        onNext={() => goStage(1)}
        compact={hasResults}
        silhouetteCta={
          avatar === null && !avatarDown ? (
            <Link
              href="/studio"
              className="flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
            >
              Create your avatar
            </Link>
          ) : undefined
        }
      />

      <VoiceButton
        disabled={busy || locating}
        keywords={voiceKeywords}
        onResult={(transcript, slots) => offerVoice(transcript, slots)}
        report={reportVoice}
      />
      {pendingVoice ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-(--border) bg-(--surface) p-4">
          <label className="flex flex-col gap-2 text-lg">
            You said: (edit, then use it — or wait 3 seconds)
            <input
              type="text"
              value={heardDraft}
              onChange={(event) => {
                draftRef.current = event.target.value;
                setHeardDraft(event.target.value);
                clearAcceptTimer();
              }}
              maxLength={200}
              aria-label="Heard text, edit before accepting"
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
          <button
            type="button"
            onClick={acceptVoice}
            className="min-h-14 rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
          >
            Use this
          </button>
        </div>
      ) : (
        heard && (
          <p className="self-start">
            <Tape label={`You said: ${heard}`} seedId="you-said" />
          </p>
        )
      )}

      {!hasResults && (
        <div className="flex flex-col items-center gap-2">
          {!canRun && !busy && (
            <p className="text-lg text-(--text-muted)">Tell me about your day, or choose below.</p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setSheetOpen(true)}
            className="min-h-14 rounded-full px-6 text-lg font-semibold underline decoration-dotted underline-offset-4 disabled:text-(--disabled-text)"
          >
            Or choose
          </button>
        </div>
      )}
      {closetPill && pager && !busy && (
        <button
          type="button"
          onClick={() =>
            void fetchOutfits([], "Getting your outfits…").then((run) => {
              if (run && run.outfits.length > 0) {
                speakOutfit(run.outfits[0], run.outfits.length, run.items, run.weather, run.dressCode);
              }
            })
          }
          className="min-h-11 self-start rounded-full border border-(--border) px-5 text-base font-semibold"
        >
          Your closet changed · Refresh looks
        </button>
      )}

      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>
      {retryAction && (
        <button
          type="button"
          onClick={() => {
            const rerun = retryAction;
            setRetryAction(null);
            rerun();
          }}
          className="min-h-14 rounded-full bg-(--primary) text-lg font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          Try again
        </button>
      )}

      {missing.length > 0 && (
        <section aria-label="Closet gaps" className="flex flex-col gap-3">
          <p className="text-xl">
            Add {missing.map((m) => MISSING_HINTS[m] ?? m).join(" and ")} to get full outfits.
          </p>
          <Link
            href="/capture"
            className="inline-block min-h-14 rounded-full bg-(--primary) px-6 py-4 text-center text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
          >
            Add clothes
          </Link>
        </section>
      )}

      {staged && (
        <section aria-label="This look" className="flex flex-col gap-4">
          <h2 className="font-display text-3xl">Look {stagedIndex + 1}</h2>
          <p className="truncate text-lg">{staged.reason}</p>
          {dressCode?.note ? (
            <div className="flex flex-col items-start gap-2">
              <button
                type="button"
                aria-expanded={dressOpen}
                aria-label={`Dress code: ${dressCode.note}. ${dressOpen ? "Hide" : "Show"} details.`}
                onClick={() => setDressOpen((open) => !open)}
                className="max-w-full min-h-11 rounded-full border border-(--border) px-4 py-2 text-left text-[15px]"
              >
                <span className="block truncate">Dress code: {dressCode.note}</span>
              </button>
              {dressOpen && (
                <p className="text-lg">
                  {dressCode.note}{" "}
                  {dressCode.url && (
                    <a href={dressCode.url} target="_blank" rel="noreferrer" className="underline">
                      Source
                    </a>
                  )}
                </p>
              )}
            </div>
          ) : null}
          {staged.source === "rules" ? (
            <div>
              <button
                type="button"
                aria-expanded={rulesNoteKey === staged.key}
                onClick={() => setRulesNoteKey((k) => (k === staged.key ? null : staged.key))}
                className="flex min-h-11 items-center gap-1 text-[13px] text-(--text-muted) underline decoration-dotted underline-offset-4"
              >
                <SparkIcon />
                Quick pick
              </button>
              {rulesNoteKey === staged.key && (
                <p className="text-[13px] text-(--text-muted)">
                  AI was busy, so this pick uses simple style rules.
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-1 text-[13px] text-(--text-muted)">
              <SparkIcon />
              Styled by AI
            </p>
          )}
          <ul
            className="flex snap-x gap-3 overflow-x-auto pb-2"
            aria-label="Garments in this look"
          >
            {stagedCards.map(({ id, card }) => (
              <li key={id} className="w-28 shrink-0 snap-start">
                <button
                  type="button"
                  onClick={() => void openGarment(id)}
                  aria-label={`${card.type} in ${card.primary_color}. View details.`}
                  className="flex w-full flex-col items-center gap-1 rounded-2xl border border-(--border-soft) bg-(--surface-2) p-2"
                >
                  <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-xl bg-(--paper) p-1">
                    <Sticker
                      src={card.cutoutUrl}
                      alt={`${card.type} in ${card.primary_color}`}
                      seedId={id}
                    />
                  </span>
                  <span className="max-w-full">
                    <Tape label={tapeLabel(card)} seedId={id} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => saveLook(staged)}
              className="flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-4 text-lg font-semibold whitespace-nowrap text-(--primary-text)"
            >
              ♥ Save look
            </button>
            <Link
              href={`/dress?ids=${staged.item_ids.join(",")}`}
              className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap"
            >
              Get dressed
            </Link>
            {showShuffle && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  // Next page of strong looks: no AI call.
                  if (!pager) return;
                  const next = nextPage(pager);
                  setPager(next);
                  setStatus(pageStatus(next));
                }}
                aria-label="Shuffle to new outfit combinations"
                className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
              >
                Shuffle
              </button>
            )}
            {showMoreIdeas && (
              <button
                type="button"
                disabled={busy || moreDepleted}
                onClick={() => {
                  if (!pager) return;
                  void fetchOutfits(pager.seen, "Finding more ideas…", false, undefined, "more");
                }}
                aria-label="More ideas, asks AI again"
                className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap disabled:text-(--disabled-text)"
              >
                More ideas
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                unlockSpeech();
                speakOutfit(staged, page.length, itemCards, weather, dressCode);
              }}
              className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap"
            >
              Read it to me
            </button>
            <button
              type="button"
              aria-expanded={showItems}
              onClick={() => setShowItems((v) => !v)}
              className="flex min-h-14 items-center justify-center rounded-full border border-(--border) px-4 text-lg font-semibold whitespace-nowrap"
            >
              {showItems ? "Hide items" : "Show items"}
            </button>
          </div>
          {saveNote && (
            <p role="status" className="text-lg">
              {saveNote}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-2" role="group" aria-label={`Rate look ${stagedIndex + 1}`}>
              <button
                type="button"
                aria-pressed={votes[staged.key] === 1}
                aria-label={`Thumbs up for look ${stagedIndex + 1}`}
                onClick={() => void vote(staged.key, staged.item_ids, 1)}
                className={`flex min-h-11 min-w-11 items-center justify-center rounded-full border text-xl ${
                  votes[staged.key] === 1
                    ? "border-(--primary) bg-(--primary) text-(--primary-text)"
                    : "border-(--border)"
                }`}
              >
                👍
              </button>
              <button
                type="button"
                aria-pressed={votes[staged.key] === -1}
                aria-label={`Thumbs down for look ${stagedIndex + 1}`}
                onClick={() => void vote(staged.key, staged.item_ids, -1)}
                className={`flex min-h-11 min-w-11 items-center justify-center rounded-full border text-xl ${
                  votes[staged.key] === -1
                    ? "border-(--primary) bg-(--primary) text-(--primary-text)"
                    : "border-(--border)"
                }`}
              >
                👎
              </button>
            </div>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="min-h-11 px-2 text-base underline"
            >
              Change choices
            </button>
            <button
              type="button"
              onClick={startOver}
              className="min-h-11 px-2 text-base underline"
            >
              Start over
            </button>
          </div>
          {getStale && canRun && !busy && (
            <p className="text-lg text-(--text-muted)">Change mood or occasion for new looks</p>
          )}
        </section>
      )}

      {hasResults && relaxed && (
        <div className="flex flex-wrap items-center gap-3">
          <Tape label="Best with your current closet" seedId="relaxed" />
          <Link href="/capture" className="text-lg underline">
            Add clothes
          </Link>
        </div>
      )}
      {hasResults && weather && staged && (
        <p className="text-lg">
          {weatherLine(weather)} {staged.weather_note}
        </p>
      )}
      {garmentId && !garmentEditing && (
        <GarmentDetailDialog
          title={
            garmentItem
              ? `${garmentItem.tags.type} in ${garmentItem.tags.primary_color}`
              : "Garment"
          }
          loading={garmentLoading}
          item={garmentItem}
          onEdit={() => setGarmentEditing(true)}
          onClose={() => {
            setGarmentId(null);
            setGarmentItem(null);
          }}
        />
      )}
      {garmentEditing && garmentItem && (
        <ItemEditor
          item={toGarmentEditable(garmentItem)}
          onSave={(id, draft) => saveGarmentEdit(id, draft)}
          onClose={() => setGarmentEditing(false)}
        />
      )}
      {sheetOpen && (
        <StyleSheet
          moods={MOODS}
          occasions={OCCASIONS}
          times={TIMES}
          mood={mood}
          occasion={occasion}
          occasionText={occasionText}
          destination={destination}
          city={city}
          whenDate={whenDate}
          timeOfDay={timeOfDay}
          coords={coords}
          locating={locating}
          busy={busy}
          canRun={canRun}
          onMood={(v) => setMood(v ?? "")}
          onOccasion={(v) => setOccasion(v ?? "")}
          onOccasionText={setOccasionText}
          onDestination={setDestination}
          onCity={handleCityChange}
          onWhenDate={setWhenDate}
          onTimeOfDay={setTimeOfDay}
          onUseLocation={useMyLocation}
          onSubmit={runFresh}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </main>
  );
}
