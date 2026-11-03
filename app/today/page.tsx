"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { tapeLabel } from "@/lib/labels";
import { META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { slotRank } from "@/lib/outfits";

import { Sticker, Tape } from "../sticker";

const CITY_KEY = "closet-ai-city";

const MOODS = ["calm", "confident", "cozy", "bold", "lazy"] as const;
const OCCASIONS = ["work", "class", "date", "gym", "party", "errands"] as const;

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
  const [outfits, setOutfits] = useState<OutfitView[]>([]);
  const [itemCards, setItemCards] = useState<Record<string, ItemCard>>({});
  const [weather, setWeather] = useState<WeatherView | null>(null);
  const [dressCode, setDressCode] = useState<DressCodeView | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [shownKeys, setShownKeys] = useState<string[]>([]);
  const [status, setStatus] = useState("Pick a mood and an occasion to get dressed.");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [retryAction, setRetryAction] = useState<null | (() => void)>(null);

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

  async function fetchOutfits(exclude: string[], label: string, isRetry = false) {
    if (!mood || !occasion) {
      setStatus("Pick a mood and an occasion first.");
      return;
    }
    setBusy(true);
    setStatus(label);
    setRetryAction(null);
    const hiccupTimer = window.setTimeout(
      () => setStatus(`${META_HICCUP_MESSAGE} Retrying…`),
      8000,
    );
    try {
      const res = await fetch("/api/outfits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mood,
          occasion,
          occasionText: occasionText.trim() || undefined,
          destination: destination.trim() || undefined,
          lat: coords?.lat,
          lon: coords?.lon,
          city: city.trim() || undefined,
          exclude,
        }),
      });
      const body = (await res.json()) as {
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
        setOutfits([]);
        setStatus("Your closet can't make a full outfit yet.");
        return;
      }
      setMissing([]);
      const fresh = body.outfits ?? [];
      if (fresh.length === 0) {
        window.clearTimeout(hiccupTimer);
        setStatus(
          exclude.length > 0
            ? "That's every combination for this mood — try a different one."
            : "No outfits came back. Try again or change the mood.",
        );
        return;
      }
      window.clearTimeout(hiccupTimer);
      setOutfits(fresh);
      setItemCards(body.items ?? {});
      setWeather(body.weather ?? null);
      setDressCode(body.dressCode ?? null);
      setShownKeys((prev) => [...prev, ...fresh.map((o) => o.key)]);
      setStatus(
        `Outfit 1 of ${fresh.length} ready.${fresh.length > 1 ? " Swipe through them all." : ""}`,
      );
    } catch (err) {
      window.clearTimeout(hiccupTimer);
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE && !isRetry) {
        setStatus(`${META_HICCUP_MESSAGE} Retrying…`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fetchOutfits(exclude, label, true);
      }
      if ((err as { code?: string }).code === META_UNAVAILABLE_CODE) {
        setStatus("Meta's AI is still having trouble.");
        setRetryAction(() => () => {
          setRetryAction(null);
          void fetchOutfits(exclude, label);
        });
        return;
      }
      const message = err instanceof Error ? err.message : "Outfit picking failed.";
      setStatus(`Couldn't get outfits: ${message}`);
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
              onClick={() => setMood(m)}
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
              onClick={() => setOccasion(o)}
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

      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || !mood || !occasion}
          onClick={() => void fetchOutfits([], "Getting today's outfits…")}
          className="min-h-16 flex-1 rounded-full bg-(--primary) text-xl font-semibold text-(--primary-text) disabled:bg-(--disabled-bg) disabled:text-(--disabled-text)"
        >
          {busy ? "Picking…" : "Get outfits"}
        </button>
        {outfits.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void fetchOutfits(shownKeys, "Shuffling to new combinations…")}
            aria-label="Shuffle to new outfit combinations"
            className="min-h-16 rounded-full border border-(--border) px-6 text-xl font-semibold disabled:text-(--disabled-text)"
          >
            Shuffle
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

      {outfits.length > 0 && (
        <section aria-label="Outfits" className="flex flex-col gap-8">
          {weather && <p className="text-lg">{weatherLine(weather)}</p>}
          {outfits.map((outfit, index) => {
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
                aria-label={`Outfit ${index + 1} of ${outfits.length}`}
                className="flex flex-col gap-4 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
              >
                <h2 className="font-display text-2xl">
                  Outfit {index + 1} of {outfits.length}
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
                      <span className="flex h-40 items-center justify-center">
                        <Sticker
                          src={card.cutoutUrl}
                          alt={`${card.type} in ${card.primary_color}`}
                          seedId={id}
                          rich
                        />
                      </span>
                      <span className="-mt-2">
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
