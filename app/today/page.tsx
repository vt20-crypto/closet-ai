"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { tapeLabel } from "@/lib/labels";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { slotRank } from "@/lib/outfits";
import {
  appendMore,
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
  const [source, setSource] = useState<"ai" | "rules">("ai");
  const [relaxed, setRelaxed] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [voiceRequested, setVoiceRequested] = useState(false);

  // The cards on screen: exactly the pager's current page (at most 3).
  const page = pager ? currentPage(pager) : [];
  const showShuffle = pager !== null && hasMore(pager);
  const showMoreIdeas = pager !== null && !hasMore(pager) && !exhausted;

  // Get outfits unlocks with any single input or a completed voice request.
  const canRun =
    Boolean(mood) ||
    Boolean(occasion) ||
    occasionText.trim() !== "" ||
    destination.trim() !== "" ||
    voiceRequested;

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

  /** Status line for a pager: "N looks for you" on page 1, "Look 4–6" after. */
  function pageStatus(p: OutfitPagerState<OutfitView>): string {
    const range = pageRange(p);
    const n = currentPage(p).length;
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
      setExhausted(false);
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
        // Appending to a pager captured before the await keeps every shown combo excluded.
        const base = pager;
        if (!base || fresh.length === 0) {
          setExhausted(true);
          setStatus("That's all the strong looks for this — see below.");
          return null;
        }
        const grown = appendMore(base, fresh);
        if (grown === base) {
          setExhausted(true);
          setStatus("That's all the strong looks for this — see below.");
          return null;
        }
        setPager(grown);
        const merged = { ...itemCards, ...(body.items ?? {}) };
        setItemCards(merged);
        if (body.source === "rules") setSource("rules");
        setExhausted(false);
        setStatus(pageStatus(grown));
        return { outfits: currentPage(grown), items: merged, weather: nextWeather, dressCode: nextDress };
      }
      if (fresh.length === 0) {
        window.clearTimeout(hiccupTimer);
        // Source stays untouched on empty responses.
        setStatus("No outfits came back. Try again or change the mood.");
        return null;
      }
      setSource(body.source === "rules" ? "rules" : "ai");
      setRelaxed(body.relaxed === true);
      window.clearTimeout(hiccupTimer);
      const items = body.items ?? {};
      const started = createPager(fresh);
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
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || !canRun}
          onClick={() =>
            void fetchOutfits([], "Getting today's outfits…").then((run) => {
              if (run && run.outfits.length > 0) {
                speakOutfit(run.outfits[0], run.outfits.length, run.items, run.weather, run.dressCode);
              }
            })
          }
          className="min-h-16 flex-1 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
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
            className="min-h-16 rounded-full border border-(--border) px-6 text-xl font-semibold disabled:text-(--disabled-text)"
          >
            Shuffle
          </button>
        )}
        {showMoreIdeas && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!pager) return;
              void fetchOutfits(pager.seen, "Finding more ideas…", false, undefined, "more");
            }}
            aria-label="Get more outfit ideas"
            className="min-h-16 rounded-full border border-(--border) px-6 text-xl font-semibold disabled:text-(--disabled-text)"
          >
            More ideas
          </button>
        )}
      </div>

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

      {exhausted && page.length > 0 && missing.length === 0 && (
        <section
          aria-label="No more strong looks"
          className="flex flex-col gap-3 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
        >
          <h2 className="font-display text-2xl">That&apos;s all the strong looks for this</h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!pager) return;
              void fetchOutfits(pager.seen, "Finding more ideas…", false, undefined, "more");
            }}
            className="min-h-14 rounded-full border border-(--border) px-6 text-lg font-semibold disabled:text-(--disabled-text)"
          >
            More ideas (may be less perfect)
          </button>
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
          {source === "rules" && (
            <p className="self-start">
              <Tape label="Quick pick, AI unavailable" seedId="quick-pick" />
            </p>
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
                  <Tape label={tapeText} seedId={outfit.key} />
                </p>
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
