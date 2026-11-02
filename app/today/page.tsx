"use client";

import Link from "next/link";
import { useState } from "react";

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
}

interface WeatherView {
  highC: number;
  lowC: number;
  precipChancePct: number;
  windKph: number;
  placeName?: string;
}

interface DressCodeView {
  note: string;
  url: string | null;
}

/** Server computes in °C; display °F for en-US, °C otherwise. */
function formatTemp(celsius: number): string {
  if (typeof navigator !== "undefined" && navigator.language === "en-US") {
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(celsius)}°C`;
}

function weatherLine(weather: WeatherView): string {
  const place = weather.placeName ? `${weather.placeName}: ` : "";
  return (
    `${place}High ${formatTemp(weather.highC)}, low ${formatTemp(weather.lowC)}, ` +
    `${weather.precipChancePct}% rain, wind ${weather.windKph} kph.`
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

  async function fetchOutfits(exclude: string[], label: string) {
    if (!mood || !occasion) {
      setStatus("Pick a mood and an occasion first.");
      return;
    }
    setBusy(true);
    setStatus(label);
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
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if ((body.missing ?? []).length > 0) {
        setMissing(body.missing ?? []);
        setOutfits([]);
        setStatus("Your closet can't make a full outfit yet.");
        return;
      }
      setMissing([]);
      const fresh = body.outfits ?? [];
      if (fresh.length === 0) {
        setStatus(
          exclude.length > 0
            ? "That's every combination for this mood — try a different one."
            : "No outfits came back. Try again or change the mood.",
        );
        return;
      }
      setOutfits(fresh);
      setItemCards(body.items ?? {});
      setWeather(body.weather ?? null);
      setDressCode(body.dressCode ?? null);
      setShownKeys((prev) => [...prev, ...fresh.map((o) => o.key)]);
      setStatus(
        `Outfit 1 of ${fresh.length} ready.${fresh.length > 1 ? " Swipe through them all." : ""}`,
      );
    } catch (err) {
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
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({ lat: position.coords.latitude, lon: position.coords.longitude });
        setStatus("Location set. Now get your outfits.");
        setLocating(false);
      },
      () => {
        setStatus("Location unavailable — type a city instead.");
        setLocating(false);
      },
      { timeout: 10_000 },
    );
  }

  const chipClass = (selected: boolean) =>
    `min-h-12 rounded-full border px-5 text-lg capitalize disabled:opacity-50 ${
      selected
        ? "border-black bg-black font-semibold text-white dark:border-white dark:bg-white dark:text-black"
        : "border-neutral-400"
    }`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">Today</h1>

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
            className="min-h-14 rounded-2xl border border-neutral-400 bg-transparent px-4"
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
            className="min-h-14 rounded-2xl border border-neutral-400 bg-transparent px-4"
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
            className="min-h-14 rounded-2xl border border-neutral-400 px-6 text-lg font-semibold disabled:opacity-50"
          >
            {coords ? "Location set ✓" : locating ? "Locating…" : "Use my location"}
          </button>
          <label className="flex min-w-52 flex-1 flex-col gap-2 text-lg">
            Or city
            <input
              type="text"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              placeholder="e.g. Lisbon"
              maxLength={120}
              className="min-h-14 rounded-2xl border border-neutral-400 bg-transparent px-4"
            />
          </label>
        </div>
      </section>

      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || !mood || !occasion}
          onClick={() => void fetchOutfits([], "Getting today's outfits…")}
          className="min-h-16 flex-1 rounded-2xl bg-black text-xl font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {busy ? "Picking…" : "Get outfits"}
        </button>
        {outfits.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void fetchOutfits(shownKeys, "Shuffling to new combinations…")}
            aria-label="Shuffle to new outfit combinations"
            className="min-h-16 rounded-2xl border border-neutral-400 px-6 text-xl font-semibold disabled:opacity-50"
          >
            Shuffle
          </button>
        )}
      </div>

      <p role="status" aria-live="polite" className="text-lg">
        {status}
      </p>

      {missing.length > 0 && (
        <section aria-label="Closet gaps" className="flex flex-col gap-3">
          <p className="text-xl">
            Add {missing.map((m) => MISSING_HINTS[m] ?? m).join(" and ")} to get full outfits.
          </p>
          <Link
            href="/capture"
            className="inline-block min-h-14 rounded-2xl bg-black px-6 py-4 text-center text-xl font-semibold text-white dark:bg-white dark:text-black"
          >
            Add clothes
          </Link>
        </section>
      )}

      {dressCode && (
        <p className="text-lg">
          Dress code: {dressCode.note}{" "}
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
      )}

      {outfits.length > 0 && (
        <section aria-label="Outfits" className="flex flex-col gap-6">
          {weather && <p className="text-lg">{weatherLine(weather)}</p>}
          {outfits.map((outfit, index) => (
            <article
              key={outfit.key}
              aria-label={`Outfit ${index + 1} of ${outfits.length}`}
              className="flex flex-col gap-3 rounded-2xl border border-neutral-300 p-4 dark:border-neutral-700"
            >
              <h2 className="text-2xl font-bold">
                Outfit {index + 1} of {outfits.length}
              </h2>
              <ul className="flex gap-2 overflow-x-auto" aria-label="Outfit garments">
                {outfit.item_ids.map((id) => {
                  const card = itemCards[id];
                  if (!card) return null;
                  return (
                    <li key={id} className="w-28 shrink-0">
                      <img
                        src={card.cutoutUrl}
                        alt={`${card.type} in ${card.primary_color}`}
                        loading="lazy"
                        className="w-full rounded-xl bg-neutral-100 object-contain dark:bg-neutral-800"
                      />
                      <p className="pt-1 text-base capitalize">{card.type}</p>
                    </li>
                  );
                })}
              </ul>
              <p className="text-lg">{outfit.reason}</p>
              {weather && <p>{outfit.weather_note}</p>}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
