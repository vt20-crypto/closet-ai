"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { tapeLabel } from "@/lib/labels";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { slotRank } from "@/lib/outfits";
import { buildSavedLook, type InventedItem } from "@/lib/render";
import { normalizeTimeOfDay, resolveDateText, todayISO, tomorrowISO } from "@/lib/when";
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

import { Sticker, Tape } from "../sticker";
import VoiceButton, { type VoiceSlots } from "./voice-button";

const CITY_KEY = "closet-ai-city";
const SESSION_KEY = "closet-ai-style-session";

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
  return typeof s.inputs === "object" && s.inputs !== null;
}

const MOODS = ["calm", "confident", "cozy", "bold", "lazy"] as const;
const OCCASIONS = ["work", "class", "date", "gym", "party", "errands", "brunch", "dinner"] as const;
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
};

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
  const [itemCards, setItemCards] = useState<Record<string, ItemCard>>({});
  const [weather, setWeather] = useState<WeatherView | null>(null);
  const [dressCode, setDressCode] = useState<DressCodeView | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [status, setStatus] = useState("Pick a mood and an occasion to get dressed.");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [retryAction, setRetryAction] = useState<null | (() => void)>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [relaxed, setRelaxed] = useState(false);
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

  // Stage: avatar spotlight for the selected look.
  const [avatar, setAvatar] = useState<{ url: string; version: string } | null | undefined>(undefined);
  const [stageIndex, setStageIndex] = useState(0);
  const [showItems, setShowItems] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [renders, setRenders] = useState<Record<string, StageRecord>>({});
  const rendersRef = useRef<Record<string, StageRecord>>({});
  rendersRef.current = renders;
  const inflightRef = useRef<Set<string>>(new Set());
  const verifyInflightRef = useRef<Set<string>>(new Set());
  const touchX = useRef<number | null>(null);

  function resetStage() {
    setStageIndex(0);
    setShowItems(false);
    setSaveNote(null);
  }

  // The cards on screen: exactly the pager's current page (at most 3).
  const page = pager ? currentPage(pager) : [];
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

  // The staged look: exactly one spotlight look at a time.
  const staged = page.length > 0 ? page[Math.min(stageIndex, page.length - 1)] : undefined;
  const stagedCards = staged
    ? staged.item_ids
        .map((id) => ({ id, card: itemCards[id] }))
        .filter((entry): entry is { id: string; card: ItemCard } => Boolean(entry.card))
        .sort((a, b) => slotRank(a.card.slot) - slotRank(b.card.slot))
    : [];
  const stagedRender = staged && avatar ? renders[renderKey(staged.key)] : undefined;
  const whenBits = [
    whenDate === null ? "Today" : whenDate === tomorrowISO() ? "Tomorrow" : whenDate,
    timeOfDay,
    destination.trim() || weather?.placeName?.trim() || null,
  ].filter((bit): bit is string => Boolean(bit));

  function goStage(delta: number) {
    if (page.length === 0) return;
    setStageIndex((index) => (index + delta + page.length) % page.length);
    setShowItems(false);
    setSaveNote(null);
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
        setStatus("Restored your last looks.");
      }
    } catch {
      // Corrupt session: start fresh.
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist inputs + results for the session (Save, and back-nav from /dress).
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
      };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
    } catch {
      // Private mode: the session simply isn't restored.
    }
  }, [mood, occasion, occasionText, destination, city, whenDate, timeOfDay, voiceRequested, pager, itemCards, weather, dressCode, relaxed]);

  // Load the avatar pointer once (no-store: a redo replaces it).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/avatar", { cache: "no-store" });
        const body = (await res.json()) as { avatar?: { url: string; version: string } | null };
        if (!cancelled) setAvatar(res.ok ? (body.avatar ?? null) : null);
      } catch {
        if (!cancelled) setAvatar(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          const fallback = {
            url: null,
            verified: false,
            invented: [] as InventedItem[],
            note: "Couldn't render this look — showing the items.",
          };
          const atVersion = avatar.version;
          setRenders((prev) => storeRender(prev, atVersion, key, fallback));
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
          note: "Couldn't render this look — showing the items.",
        };
        setRenders((prev) => storeRender(prev, atVersion, key, fallback));
        return fallback;
      } finally {
        inflightRef.current.delete(key);
      }
    },
    [avatar],
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
      () => setStatus(`${META_HICCUP_MESSAGE} Retrying…`),
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
      return { outfits: currentPage(started), items, weather: nextWeather, dressCode: nextDress };
    } catch (err) {
      window.clearTimeout(hiccupTimer);
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE && !isRetry) {
        setStatus(`${META_HICCUP_MESSAGE} Retrying…`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fetchOutfits(exclude, label, true, overrides, mode);
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        setStatus("Meta's AI is still having trouble.");
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

  const chipClass = (selected: boolean) =>
    `min-h-12 rounded-full border px-5 text-lg capitalize disabled:text-(--disabled-text) ${
      selected
        ? "border-(--primary) bg-(--primary) font-semibold text-(--primary-text)"
        : "border-(--border)"
    }`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <h1 className="font-display text-4xl">Style</h1>

      <section aria-label="Mood" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Mood</h2>
        <div className="flex flex-wrap gap-3">
          {MOODS.map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              aria-pressed={mood === m}
              onClick={() => setMood(mood === m ? "" : m)}
              className={chipClass(mood === m)}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Occasion" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Occasion</h2>
        <div className="flex flex-wrap gap-3">
          {OCCASIONS.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              aria-pressed={occasion === o}
              onClick={() => setOccasion(occasion === o ? "" : o)}
              className={chipClass(occasion === o)}
            >
              {o}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-2 text-lg">
          Anything more specific? (optional)
          <input
            type="text"
            value={occasionText}
            onChange={(event) => setOccasionText(event.target.value)}
            placeholder="e.g. rooftop birthday"
            maxLength={120}
            className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
          />
        </label>
        <label className="flex flex-col gap-2 text-lg">
          Destination (optional)
          <input
            type="text"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="e.g. The French Laundry"
            maxLength={120}
            className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
          />
        </label>
      </section>

      <section aria-label="When" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">When</h2>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            aria-pressed={whenDate === null}
            onClick={() => setWhenDate(null)}
            className={chipClass(whenDate === null)}
          >
            Today
          </button>
          <button
            type="button"
            disabled={busy}
            aria-pressed={whenDate === tomorrowISO()}
            onClick={() => setWhenDate(tomorrowISO())}
            className={chipClass(whenDate === tomorrowISO())}
          >
            Tomorrow
          </button>
          <label className="flex min-w-52 flex-1 items-center gap-3 text-lg">
            Or pick a date
            <input
              type="date"
              value={whenDate ?? todayISO()}
              min={todayISO()}
              onChange={(event) => {
                const picked = event.target.value;
                setWhenDate(!picked || picked === todayISO() ? null : picked);
              }}
              className="min-h-14 flex-1 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3" role="group" aria-label="Time of day">
          {TIMES.map((t) => (
            <button
              key={t}
              type="button"
              disabled={busy}
              aria-pressed={timeOfDay === t}
              onClick={() => setTimeOfDay(timeOfDay === t ? null : t)}
              className={chipClass(timeOfDay === t)}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Location" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Location</h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || locating}
            onClick={useMyLocation}
            className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
          >
            {coords ? "Location set ✓" : locating ? "Locating…" : "Use my location"}
          </button>
          <label className="flex min-w-52 flex-1 flex-col gap-2 text-lg">
            Or city
            <input
              type="text"
              value={city}
              onChange={(event) => handleCityChange(event.target.value)}
              placeholder="e.g. Lisbon"
              maxLength={120}
              className="min-h-14 rounded-2xl border border-(--border) bg-(--surface) px-4"
            />
          </label>
        </div>
      </section>

      <VoiceButton
        disabled={busy || locating}
        keywords={[...MOODS, ...OCCASIONS, "brunch", "birthday", "wedding", "interview"]}
        onResult={(transcript, slots) => void applyVoice(transcript, slots)}
        report={reportVoice}
      />
      {heard && (
        <p className="self-start">
          <Tape label={`You said: ${heard}`} seedId="you-said" />
        </p>
      )}

      {!canRun && !busy && (
        <p className="text-lg text-(--text-muted)">Pick a mood or occasion, or tap to talk.</p>
      )}
      <div className="flex flex-col gap-3 min-[480px]:flex-row">
        <button
          type="button"
          disabled={busy || !canRun || getStale}
          onClick={() =>
            void fetchOutfits([], "Getting your outfits…").then((run) => {
              if (run && run.outfits.length > 0) {
                speakOutfit(run.outfits[0], run.outfits.length, run.items, run.weather, run.dressCode);
              }
            })
          }
          className="min-h-16 w-full min-w-44 rounded-full bg-(--primary) text-xl font-semibold whitespace-nowrap text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text) min-[480px]:flex-1"
        >
          {busy ? "Picking…" : "Get outfits"}
        </button>
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
            className="min-h-16 w-full shrink-0 rounded-full border border-(--border) px-6 text-xl font-semibold whitespace-nowrap disabled:text-(--disabled-text) min-[480px]:w-auto"
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
            className="min-h-16 w-full shrink-0 rounded-full border border-(--border) px-6 text-xl font-semibold whitespace-nowrap disabled:text-(--disabled-text) min-[480px]:w-auto"
          >
            More ideas (asks AI again)
          </button>
        )}
      </div>
      {getStale && canRun && !busy && (
        <p className="text-lg text-(--text-muted)">Change mood or occasion for new looks</p>
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

      {dressCode?.searched ? (
        dressCode.note ? (
          <p className="text-lg">
            Dress code (searched): {dressCode.note}{" "}
            {dressCode.url && (
              <a
                href={dressCode.url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Source
              </a>
            )}
          </p>
        ) : (
          <p className="text-lg">No dress code found online.</p>
        )
      ) : null}

      {page.length > 0 && avatar === null && (
        <section
          aria-label="See it on you"
          className="flex flex-col gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
        >
          <h2 className="font-display text-2xl">See it on you</h2>
          <p className="text-lg">
            Create your avatar once — then every look is shown on you, in your style.
          </p>
          <Link
            href="/studio"
            className="flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-lg font-semibold text-(--primary-text)"
          >
            Create your avatar
          </Link>
        </section>
      )}

      {page.length > 0 && staged && avatar && (
        <section
          aria-label="Stage"
          onTouchStart={(event) => {
            touchX.current = event.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(event) => {
            const start = touchX.current;
            touchX.current = null;
            if (start === null || page.length < 2) return;
            const dx = (event.changedTouches[0]?.clientX ?? start) - start;
            if (dx <= -40) goStage(1);
            else if (dx >= 40) goStage(-1);
          }}
          className="flex flex-col gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
        >
          <p aria-live="polite" className="text-lg text-(--text-muted)">
            Look {stageIndex + 1} of {page.length}
          </p>
          <div className="overflow-hidden rounded-2xl bg-(--surface-2)">
            {stagedRender?.url && !showItems ? (
              <img
                src={stagedRender.url}
                alt={`Look ${stageIndex + 1} styled on your avatar`}
                className="aspect-[2/3] w-full object-cover"
              />
            ) : showItems || stagedRender ? (
              <ul className="grid grid-cols-2 gap-4 p-4" aria-label="Look garments, laid flat">
                {stagedCards.map(({ id, card }) => (
                  <li key={id} className="flex aspect-[3/4] items-center justify-center">
                    <Sticker
                      src={card.cutoutUrl}
                      alt={`${card.type} in ${card.primary_color}`}
                      seedId={id}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div
                role="status"
                className="flex aspect-[2/3] w-full items-center justify-center p-6 text-center"
              >
                <p className="text-lg text-(--text-muted)">Dressing your avatar…</p>
              </div>
            )}
          </div>
          {stagedRender?.url && !showItems && (
            <span
              aria-hidden="true"
              className="mx-auto -mt-2 h-3 w-2/3 rounded-full bg-(--border-soft) blur-[3px]"
            />
          )}
          {stagedRender && !stagedRender.url && stagedRender.note && (
            <p className="text-lg text-(--text-muted)">{stagedRender.note}</p>
          )}
          {whenBits.length > 0 && (
            <p>
              <Tape label={whenBits.join(" · ")} seedId={`${staged.key}-when`} />
            </p>
          )}
          <div className="flex flex-wrap gap-2" aria-label="Items in this look">
            {stagedCards.map(({ id, card }) => (
              <Tape key={id} label={tapeLabel(card)} seedId={id} />
            ))}
          </div>
          <p className="text-lg">{staged.reason}</p>
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
          <div className="flex gap-3">
            <button
              type="button"
              disabled={page.length < 2}
              onClick={() => goStage(-1)}
              aria-label="Previous look"
              className="flex min-h-14 flex-1 items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
            >
              ‹ Prev
            </button>
            <button
              type="button"
              disabled={page.length < 2}
              onClick={() => goStage(1)}
              aria-label="Next look"
              className="flex min-h-14 flex-1 items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
            >
              Next ›
            </button>
          </div>
          <button
            type="button"
            onClick={() => saveLook(staged)}
            className="flex min-h-14 w-full items-center justify-center rounded-full bg-(--primary) px-6 text-lg font-semibold whitespace-nowrap text-(--primary-text)"
          >
            Save look
          </button>
          {saveNote && (
            <p role="status" className="text-lg">
              {saveNote}
            </p>
          )}
          <Link
            href={`/dress?ids=${staged.item_ids.join(",")}`}
            className="flex min-h-14 w-full items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold"
          >
            Get dressed
          </Link>
          <div className="flex flex-col gap-3 min-[480px]:flex-row">
            <button
              type="button"
              onClick={() => {
                unlockSpeech();
                speakOutfit(staged, page.length, itemCards, weather, dressCode);
              }}
              className="flex min-h-14 flex-1 items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold whitespace-nowrap"
            >
              Read it to me
            </button>
            <button
              type="button"
              aria-expanded={showItems}
              onClick={() => setShowItems((v) => !v)}
              className="flex min-h-14 flex-1 items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold whitespace-nowrap"
            >
              {showItems ? "Hide items" : "Show items"}
            </button>
          </div>
        </section>
      )}

      {page.length > 0 && (
        <section aria-label="Outfits" className="flex flex-col gap-8">
          {relaxed && (
            <div className="flex flex-wrap items-center gap-3">
              <Tape label="Best with your current closet" seedId="relaxed" />
              <Link href="/capture" className="text-lg underline">
                Add clothes
              </Link>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (page.length > 0) {
                speakOutfit(page[0], page.length, itemCards, weather, dressCode);
              }
            }}
            className="min-h-14 self-start rounded-full border border-(--border) px-6 text-lg font-semibold"
          >
            Read again
          </button>
          {weather && <p className="text-lg">{weatherLine(weather)}</p>}
          {page.map((outfit, index) => {
            const cards = outfit.item_ids
              .map((id) => ({ id, card: itemCards[id] }))
              .filter((entry): entry is { id: string; card: ItemCard } => Boolean(entry.card))
              .sort((a, b) => slotRank(a.card.slot) - slotRank(b.card.slot));
            const occasionWord = (occasionText.trim().split(/\s+/)[0] || occasion || "").toLowerCase();
            const day = new Date().toLocaleDateString(undefined, { weekday: "short" });
            const tapeText =
              weather && occasionWord
                ? `${day} · ${formatTemp(weather.highC)} · ${occasionWord}`
                : weather
                  ? `${day} · ${formatTemp(weather.highC)}`
                  : null;
            return (
              <article
                key={outfit.key}
                aria-label={`Outfit ${index + 1} of ${page.length}`}
                className="flex flex-col gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
              >
                <h2 className="font-display text-2xl">
                  Outfit {index + 1} of {page.length}
                </h2>
                {tapeText && (
                  <p className="self-start">
                    <Tape label={tapeText} seedId={outfit.key} />
                  </p>
                )}
                {outfit.source === "rules" ? (
                  <div className="self-start">
                    <button
                      type="button"
                      aria-expanded={rulesNoteKey === outfit.key}
                      onClick={() =>
                        setRulesNoteKey((k) => (k === outfit.key ? null : outfit.key))
                      }
                      className="flex min-h-11 items-center gap-1 text-[13px] text-(--text-muted) underline decoration-dotted underline-offset-4"
                    >
                      <SparkIcon />
                      Quick pick
                    </button>
                    {rulesNoteKey === outfit.key && (
                      <p className="text-[13px] text-(--text-muted)">
                        AI was busy, so this pick uses simple style rules.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="flex items-center gap-1 self-start text-[13px] text-(--text-muted)">
                    <SparkIcon />
                    Styled by AI
                  </p>
                )}
                <ul
                  className="grid grid-cols-2 gap-4 rounded-2xl bg-(--surface-2) p-4 md:grid-cols-3"
                  aria-label="Outfit garments, laid flat"
                >
                  {cards.map(({ id, card }) => (
                    <li key={id} className="flex flex-col items-center gap-1">
                      <span className="flex aspect-[3/4] w-full items-center justify-center">
                        <Sticker
                          src={card.cutoutUrl}
                          alt={`${card.type} in ${card.primary_color}`}
                          seedId={id}
                          rich
                        />
                      </span>
                      <span className="mt-1">
                        <Tape label={tapeLabel(card)} seedId={id} />
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/dress?ids=${outfit.item_ids.join(",")}`}
                  className="flex min-h-14 w-full items-center justify-center rounded-full border border-(--border) px-6 text-lg font-semibold"
                >
                  Get dressed with me
                </Link>
                <p className="text-lg">{outfit.reason}</p>
                {weather && <p className="text-(--text-muted)">{outfit.weather_note}</p>}
                <div className="flex gap-3" role="group" aria-label={`Rate outfit ${index + 1}`}>
                  <button
                    type="button"
                    aria-pressed={votes[outfit.key] === 1}
                    aria-label={`Thumbs up for outfit ${index + 1}`}
                    onClick={() => void vote(outfit.key, outfit.item_ids, 1)}
                    className={`min-h-11 flex-1 rounded-full border px-4 text-base font-semibold ${
                      votes[outfit.key] === 1
                        ? "border-(--primary) bg-(--primary) text-(--primary-text)"
                        : "border-(--border)"
                    }`}
                  >
                    Loved it
                  </button>
                  <button
                    type="button"
                    aria-pressed={votes[outfit.key] === -1}
                    aria-label={`Thumbs down for outfit ${index + 1}`}
                    onClick={() => void vote(outfit.key, outfit.item_ids, -1)}
                    className={`min-h-11 flex-1 rounded-full border px-4 text-base font-semibold ${
                      votes[outfit.key] === -1
                        ? "border-(--primary) bg-(--primary) text-(--primary-text)"
                        : "border-(--border)"
                    }`}
                  >
                    Not for me
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
