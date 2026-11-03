import { NextResponse } from "next/server";

import { listItems } from "@/lib/closet";
import {
  createRetryBudget,
  isTransientModel404,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { fetchDressCode, pickOutfits } from "@/lib/meta/spark";
import {
  countCoverage,
  coverageMissing,
  outfitKey,
  slotForType,
  validateOutfits,
  type MissingCategory,
} from "@/lib/outfits";
import { fallbackOutfits } from "@/lib/fallbackOutfits";
import { geocodeCity, getWeather, type WeatherSummary } from "@/lib/weather";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_TEXT = 120;

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, MAX_TEXT);
  return trimmed.length > 0 ? trimmed : null;
}

function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function POST(request: Request) {
  const tAll = performance.now();
  try {
    const body = (await request.json()) as {
      mood?: unknown;
      occasion?: unknown;
      occasionText?: unknown;
      destination?: unknown;
      lat?: unknown;
      lon?: unknown;
      city?: unknown;
      exclude?: unknown;
    };
    // Mood and occasion are both optional; nulls flow into the pick and the fallback.
    const mood = cleanText(body.mood);
    const occasionChip = cleanText(body.occasion);
    const occasionText = cleanText(body.occasionText);
    const destination = cleanText(body.destination);
    const occasion = occasionChip
      ? occasionText
        ? `${occasionChip} (${occasionText})`
        : occasionChip
      : occasionText;
    const excludeKeys = new Set<string>();
    if (Array.isArray(body.exclude)) {
      for (const combo of body.exclude) {
        if (Array.isArray(combo) && combo.every((id) => typeof id === "string")) {
          excludeKeys.add(outfitKey(combo as string[]));
        }
      }
    }

    const items = await listItems();
    const counts = countCoverage(items);
    const missing: MissingCategory[] = coverageMissing(counts);
    if (missing.length > 0) {
      console.log(`outfits total_ms=${Math.round(performance.now() - tAll)} missing=${missing.join(",")}`);
      return NextResponse.json({ outfits: [], missing });
    }

    const lat = cleanNumber(body.lat);
    const lon = cleanNumber(body.lon);
    const city = cleanText(body.city);
    const venue = destination ?? occasionText;
    // Separate budgets so dress can never starve the pick. Date.now-based:
    // sleepWithinBudget compares against Date.now(), so a performance.now()
    // value here would silently disable every retry.
    const dressBudget = createRetryBudget(Date.now() + 8_000);
    const pickBudget = createRetryBudget(Date.now() + 25_000);

    let weatherMs = 0;
    let dressMs = 0;
    const weatherPromise: Promise<WeatherSummary | null> = (async () => {
      const t = performance.now();
      try {
        if (lat !== null && lon !== null) return getWeather(lat, lon);
        if (city) {
          const geo = await geocodeCity(city);
          if (geo) {
            const summary = await getWeather(geo.lat, geo.lon);
            return summary ? { ...summary, placeName: geo.name } : null;
          }
        }
        return null;
      } finally {
        weatherMs = Math.round(performance.now() - t);
      }
    })();
    const dressPromise = (async () => {
      const t = performance.now();
      try {
        return venue ? await fetchDressCode(venue, dressBudget) : null;
      } finally {
        dressMs = Math.round(performance.now() - t);
      }
    })();
    const [weather, dressCode] = await Promise.all([weatherPromise, dressPromise]);
    // A failed dress call continues without it: treated exactly like no venue
    // (hidden UI, "skipped" in logs). Only a ran search with a note counts.
    const dressFailed = venue !== null && !dressCode;
    const dressSearched = !!dressCode?.note;
    const dressCitations = dressCode?.citations ?? 0;
    const dressStatus = !venue || dressFailed ? "skipped" : dressSearched ? "searched" : "none";

    const weatherLine = weather
      ? `High ${weather.highC}°C, low ${weather.lowC}°C, ${weather.precipChancePct}% precipitation chance, wind ${weather.windKph} kph.`
      : null;
    const closet = items.map((item) => ({
      id: item.id,
      type: item.tags.type,
      primary_color: item.tags.primary_color,
      formality: item.tags.formality,
      warmth: item.tags.warmth,
      layer: item.tags.layer,
    }));

    const baseInput = {
      closet,
      weatherLine,
      mood,
      occasion,
      destination,
      dressCodeNote: dressCode?.note ?? null,
      excludeKeys: [...excludeKeys],
      retryProblems: null as string | null,
      budget: pickBudget,
    };

    const tSpark = performance.now();
    let source: "ai" | "rules" = "ai";
    let picked: { item_ids: string[]; reason: string; weather_note: string; key: string }[] = [];
    try {
      const raw = await pickOutfits(baseInput);
      const { valid, problems } = validateOutfits({ items, raw, excludeKeys });
      if (valid.length === 0 && raw.length > 0) {
        const retryProblems = problems
          .map((p) => `Outfit ${p.index + 1}: ${p.reasons.join("; ")}`)
          .join(" | ");
        const rawRetry = await pickOutfits({ ...baseInput, retryProblems });
        picked = validateOutfits({ items, raw: rawRetry, excludeKeys }).valid;
      } else {
        picked = valid;
      }
    } catch (err) {
      // Rule fallback only on outage signatures (model 404 / 429 / 5xx).
      // 400/401 and anything non-Meta throw to the 500 path as real errors.
      const status = (err as { status?: number })?.status;
      const outage =
        isTransientModel404(err) || status === 429 || (typeof status === "number" && status >= 500);
      if (!outage) throw err;
      console.log(`outfits pick failed, using rule fallback: ${(err as Error).message.slice(0, 120)}`);
      const fbItems = items.map((item) => ({
        id: item.id,
        tags: {
          type: item.tags.type,
          primary_color: item.tags.primary_color,
          formality: item.tags.formality,
          warmth: item.tags.warmth,
          layer: item.tags.layer,
          pattern: item.tags.pattern,
          nickname: item.tags.nickname ?? "",
        },
      }));
      // Seed = request date + exclude count: each Shuffle surfaces new combos.
      const ruleSeed = `${new Date().toISOString().slice(0, 10)}:${excludeKeys.size}`;
      picked = fallbackOutfits(
        fbItems,
        weather ? { highC: weather.highC, lowC: weather.lowC } : { highC: 20, lowC: 14 },
        mood,
        occasionChip,
        [...excludeKeys],
        ruleSeed,
      ).map((o) => ({ ...o, weather_note: "", key: outfitKey(o.item_ids) }));
      source = "rules";
    }
    const sparkMs = Math.round(performance.now() - tSpark);

    const usedIds = new Set(picked.flatMap((o) => o.item_ids));
    const itemCards: Record<string, { cutoutUrl: string; type: string; primary_color: string; nickname: string; slot: string }> = {};
    for (const item of items) {
      if (usedIds.has(item.id)) {
        itemCards[item.id] = {
          cutoutUrl: item.cutoutUrl,
          type: item.tags.type,
          primary_color: item.tags.primary_color,
          nickname: item.tags.nickname ?? "",
          slot: slotForType(item.tags.type),
        };
      }
    }

    const totalMs = Math.round(performance.now() - tAll);
    console.log(
      `outfits weather_ms=${weatherMs} dress_ms=${dressMs} dress=${dressStatus} citations=${dressCitations} ` +
        `spark_ms=${sparkMs} total_ms=${totalMs} valid=${picked.length} source=${source}`,
    );
    return NextResponse.json({
      source,
      outfits: picked.map(({ item_ids, reason, weather_note, key }) => ({
        item_ids,
        reason,
        weather_note,
        key,
      })),
      items: itemCards,
      weather,
      dressCode: {
        note: dressCode?.note ?? null,
        url: dressCode?.url ?? null,
        searched: dressSearched,
      },
      missing: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Outfit picking failed.";
    console.log(`outfits ERROR ${message.slice(0, 160)}`);
    // Only outage signatures become the friendly hiccup; 400/401 and other
    // failures surface with their real message.
    const status = (err as { status?: number })?.status;
    const outage =
      isTransientModel404(err) || status === 429 || (typeof status === "number" && status >= 500);
    if (outage) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
