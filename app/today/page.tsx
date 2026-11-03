"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { tapeLabel } from "@/lib/labels";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { slotRank } from "@/lib/outfits";
import {
  applyMoreIdeas,
  createPager,
  currentPage,
  hasMore,
  nextPage,
  pageRange,
  type OutfitPagerState,
} from "@/lib/outfitPager";
import { speak } from "@/lib/speak";

import { Sticker, Tape } from "../sticker";
import VoiceButton, { type VoiceSlots } from "./voice-button";

const CITY_KEY = "closet-ai-city";

const MOODS = ["calm", "confident", "cozy", "bold", "lazy"] as const;
const OCCASIONS = ["work", "class", "date", "gym", "party", "errands", "brunch", "dinner"] as const;

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

export default function TodayPage() {
  const [mood, setMood] = useState<string | null>(null);
  const [occasion, setOccasion] = useState<string | null>(null);
  const [occasionText, setOccasionText] = useState("");
  const [destination, setDestination] = useState("");
  const [city, setCity] = useState("");
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
  const [voiceRequested, setVoiceRequested] = useState(false);

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
  ].join("|");
  const moreDepleted = depletedKey !== null && depletedKey === inputsKey;
  // After results exist, Get outfits rests until the inputs change again.
  const getStale = pager !== null && ranKey === inputsKey;

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
    },
    mode: "fresh" | "more" = "fresh",
  ) {
    // Mood and occasion are optional hints; the pick works without them.
    const moodV = overrides?.mood ?? mood;
    const occasionV = overrides?.occasion ?? occasion;
    const occasionTextV = overrides?.occasionText ?? occasionText;
    const destinationV = overrides?.destination ?? destination;
    const cityV = overrides?.city ?? city;
    setBusy(true);
    setStatus(label);
    setRetryAction(null);
    // "More ideas" appends; only a fresh pick resets the pager and flags.
    if (mode === "fresh") {
      setPager(null);
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
        ].join("|"),
      );
      window.clearTimeout(hiccupTimer);
      const items = body.items ?? {};
      const started = createPager(fresh.map((o) => ({ ...o, source: bodySource })));
      setPager(started);
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
    if (moodV) setMood(moodV);
    if (occasionV) setOccasion(occasionV);
    setOccasionText(occasionTextV);
    setDestination(destinationV);
    if (slots.city) handleCityChange(slots.city);
    setHeard(transcript);
    setVoiceRequested(true);
    const run = await fetchOutfits([], "Getting today's outfits…", false, {
      mood: moodV,
      occasion: occasionV,
      occasionText: occasionTextV,
      destination: destinationV,
      city: slots.city ?? city,
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
      <h1 className="font-display text-4xl">Today</h1>

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
            void fetchOutfits([], "Getting today's outfits…").then((run) => {
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
                  : `Outfit ${index + 1}`;
            return (
              <article
                key={outfit.key}
                aria-label={`Outfit ${index + 1} of ${page.length}`}
                className="flex flex-col gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
              >
                <h2 className="font-display text-2xl">
                  Outfit {index + 1} of {page.length}
                </h2>
                <p className="self-start">
                  <Link
                    href={`/dress?ids=${outfit.item_ids.join(",")}`}
                    className="inline-block min-h-11 px-1 py-2 text-lg underline"
                  >
                    Get dressed with me
                  </Link>
                </p>
                <p className="self-start">
                  <Tape label={tapeText} seedId={outfit.key} />
                </p>
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
                <p className="text-lg">{outfit.reason}</p>
                {weather && <p className="text-(--text-muted)">{outfit.weather_note}</p>}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
