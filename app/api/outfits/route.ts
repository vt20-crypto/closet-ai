import { NextResponse } from "next/server";

import { listItems } from "@/lib/closet";
import {
  createRetryBudget,
  isOutageError,
  META_HICCUP_MESSAGE,
  META_UNAVAILABLE_CODE,
} from "@/lib/meta/retry";
import { fetchDressCode, styleRankOutfits } from "@/lib/meta/spark";
import {
  arrangeForPages,
  countCoverage,
  coverageMissing,
  outfitKey,
  slotForType,
  validateOutfits,
  wearableItems,
  type MissingCategory,
  type RawOutfit,
} from "@/lib/outfits";
import { applyScoreThreshold } from "@/lib/outfitScores";
import {
  generateCandidates,
  pairAdjustments,
  resolveOccasion,
  ruleWeatherNote,
  type LookVote,
  type RuleItem,
  type StyleContext,
  type StyleProfile,
} from "@/lib/styleRules";
import { hashKey, readCache, writeCache } from "@/lib/cache";
import { geocodeCity, getWeatherForDate, type WeatherSummary } from "@/lib/weather";

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
      minScore?: unknown;
      date?: unknown;
      timeOfDay?: unknown;
    };
    // When: local YYYY-MM-DD or null for today; time of day or null.
    const dateISO =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    const timeOfDay =
      body.timeOfDay === "morning" || body.timeOfDay === "afternoon" || body.timeOfDay === "evening"
        ? body.timeOfDay
        : null;
    // First-pass AI threshold is 7; "More ideas" passes minScore 5.
    const threshold = body.minScore === 5 ? 5 : 7;
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

    // Full listing stays server-side; the model sees a compact slice.
    // Laundry pieces sit out of coverage, picks and counts.
    const items = wearableItems(await listItems());
    const counts = countCoverage(items);
    const missing: MissingCategory[] = coverageMissing(counts);
    if (missing.length > 0) {
      console.log(`outfits total_ms=${Math.round(performance.now() - tAll)} missing=${missing.join(",")}`);
      return NextResponse.json({ outfits: [], missing });
    }

    const lat = cleanNumber(body.lat);
    const lon = cleanNumber(body.lon);
    const city = cleanText(body.city);
    // Dress-code lookup runs only for a typed venue/destination, never for
    // occasion text alone.
    const venue = destination;
    // Separate budgets so dress can never starve the pick. Date.now-based:
    // sleepWithinBudget compares against Date.now(), so a performance.now()
    // value here would silently disable every retry.
    const dressBudget = createRetryBudget(Date.now() + 8_000);
    const pickBudget = createRetryBudget(Date.now() + 25_000);

    // Outfit-response cache (30 min). The key ignores excludes: cached sets
    // are filtered per request, and only exclude-free responses are stored.
    const latestCreatedAt = items.reduce((m, item) => (item.createdAt > m ? item.createdAt : m), "");
    // Edits bump updatedAt: the newest change joins the key so edited items bust the cache.
    const latestChange = items.reduce(
      (m, item) => ((item.updatedAt ?? item.createdAt) > m ? (item.updatedAt ?? item.createdAt) : m),
      latestCreatedAt,
    );
    const locKey =
      lat !== null && lon !== null ? `${lat.toFixed(2)},${lon.toFixed(2)}` : `city:${(city ?? "").toLowerCase()}`;
    // Style profile + feedback shape the ranking, so they join the key.
    const profile = await readCache<StyleProfile>("profile/style", Number.POSITIVE_INFINITY).then(
      (r) => (r.hit && r.data && typeof r.data === "object" ? (r.data as StyleProfile) : {}),
    );
    const feedbackVotes = await readCache<LookVote[]>("feedback/looks", Number.POSITIVE_INFINITY).then(
      (r) => (r.hit && Array.isArray(r.data) ? (r.data as LookVote[]) : []),
    );
    const profileHash = hashKey(
      JSON.stringify({
        style: profile.style ?? null,
        undertone: profile.undertone ?? null,
        strictness: profile.strictness ?? null,
      }),
    );
    const outfitCacheKey = `outfits/${hashKey(
      JSON.stringify({
        m: mood,
        o: occasion,
        ot: occasionText,
        d: destination,
        loc: locKey,
        c: `${latestChange}:${items.length}`,
        day: new Date().toISOString().slice(0, 10),
        when: dateISO,
        tod: timeOfDay,
        p: profileHash,
        f: feedbackVotes.length,
      }),
    )}`;
    interface CachedOutfit {
      item_ids: string[];
      reason: string;
      weather_note: string;
      key: string;
      score?: number;
    }
    interface CachedItemCard {
      cutoutUrl: string;
      type: string;
      primary_color: string;
      nickname: string;
      slot: string;
    }
    interface CachedResponse {
      outfits: CachedOutfit[];
      items: Record<string, CachedItemCard>;
      weather: WeatherSummary | null;
      dressCode: { note: string | null; url: string | null; citations: number } | null;
      source: "ai" | "rules";
    }
    const cached = await readCache<CachedResponse>(outfitCacheKey, 30 * 60 * 1000);
    const cachedAll = cached.hit && cached.data ? cached.data.outfits : [];

    let weather: WeatherSummary | null = null;
    let dressCode: { note: string | null; url: string | null; citations: number } | null = null;
    let weatherMs = 0;
    let dressMs = 0;
    let sparkMs = 0;
    let cacheStatus = "miss";
    let source: "ai" | "rules" = "ai";
    let relaxed = false;
    let picked: CachedOutfit[] = [];
    let combosGenerated = 0;
    let afterFilters = 0;
    let ruleRelaxed: string | null = null;
    let topRuleScore = 0;
    const itemCards: Record<string, CachedItemCard> = {};

    const eligibleCached = cachedAll.filter((o) => !excludeKeys.has(o.key));
    if (eligibleCached.length > 0 && cached.data) {
      cacheStatus = "hit";
      // The stored source belongs to these outfits: a cached rules fallback
      // must never be re-served as AI output. Pre-source caches read as ai,
      // which is all they ever stored (fallbacks are never cached).
      source = cached.data.source === "rules" ? "rules" : "ai";
      // Score gate: strong outfits first; relaxes to the top 2 at/above 5
      // so the result is never empty when valid outfits exist.
      const gate = applyScoreThreshold(eligibleCached, threshold);
      // Page order: spread repeated pieces across the 3 looks when possible.
      picked = arrangeForPages(gate.picked, items);
      relaxed = gate.relaxed;
      weather = cached.data.weather;
      dressCode = cached.data.dressCode;
      const usedIds = new Set(picked.flatMap((o) => o.item_ids));
      for (const [id, card] of Object.entries(cached.data.items)) {
        if (usedIds.has(id)) itemCards[id] = card;
      }
    } else {
      if (cached.hit) cacheStatus = "miss-shown";
      const weatherPromise: Promise<WeatherSummary | null> = (async () => {
        const t = performance.now();
        try {
          if (lat !== null && lon !== null) return getWeatherForDate(lat, lon, dateISO);
          if (city) {
            const geo = await geocodeCity(city);
            if (geo) {
              const summary = await getWeatherForDate(geo.lat, geo.lon, dateISO);
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
      [weather, dressCode] = await Promise.all([weatherPromise, dressPromise]);

      const weatherLine = weather
        ? `High ${weather.highC}°C, low ${weather.lowC}°C, ${weather.precipChancePct}% precipitation chance, wind ${weather.windKph} kph.`
        : null;
      const whenLine =
        dateISO || timeOfDay ? `${dateISO ?? "today"}${timeOfDay ? `, ${timeOfDay}` : ""}` : null;

      // Deterministic styling engine: enumerate and score complete outfits
      // in code, then let Spark rank the top candidates as final stylist.
      const ruleItems: RuleItem[] = items.map((item) => ({
        id: item.id,
        type: item.tags.type,
        primary_color: item.tags.primary_color,
        secondary_colors: item.tags.secondary_colors,
        formality: item.tags.formality,
        warmth: item.tags.warmth,
        layer: item.tags.layer,
        fabric_weight: item.tags.fabric_weight,
        pattern: item.tags.pattern,
        nickname: item.tags.nickname ?? "",
        distinguishing_note: item.tags.distinguishing_note,
        fit: item.tags.fit,
        length: item.tags.length,
        sleeve: item.tags.sleeve,
        rise: item.tags.rise,
      }));
      const styleCtx: StyleContext = {
        items: ruleItems,
        weather: weather
          ? {
              highC: weather.highC,
              lowC: weather.lowC,
              precipPct: weather.precipChancePct,
              humidityPct: weather.humidityPct,
            }
          : { highC: 20, lowC: 14, precipPct: 0, humidityPct: 0 },
        occasion: resolveOccasion(occasionChip, occasionText),
        mood,
        profile,
        pairScores: pairAdjustments(feedbackVotes),
        // No wear log exists yet; rotation scoring skips when empty.
        wearDays: {},
        seed: outfitCacheKey,
      };
      const { candidates, stats } = generateCandidates(styleCtx);
      combosGenerated = stats.generated;
      afterFilters = stats.afterFilters;
      ruleRelaxed = stats.relaxed;
      topRuleScore = stats.topScore;
      console.log(
        `outfits combos_generated=${stats.generated} sampled=${stats.sampled} ` +
          `after_filters=${stats.afterFilters} rule_relaxed=${stats.relaxed ?? "none"} ` +
          `top_rule=${stats.topScore.toFixed(2)}`,
      );
      const weatherNote = ruleWeatherNote(weather ? styleCtx.weather : null);
      // Rule candidates go through the same validator as model picks: an
      // engine structure bug must surface in the logs, never on the user.
      const checked = validateOutfits({
        items,
        raw: candidates.map((c) => ({
          item_ids: [...c.itemIds],
          reason: c.reason,
          weather_note: weatherNote,
          score: c.score,
        })),
      });
      const ruleInvalid = candidates.length - checked.valid.length;
      console.log(
        `outfits combos_generated=${stats.generated} sampled=${stats.sampled} ` +
          `after_filters=${stats.afterFilters} rule_relaxed=${stats.relaxed ?? "none"} ` +
          `top_rule=${stats.topScore.toFixed(2)} rule_invalid=${ruleInvalid}`,
      );
      if (checked.problems.length > 0) {
        console.log(
          `outfits rule_invalid_sample=${checked.problems
            .slice(0, 2)
            .map((p) => p.reasons.join(";"))
            .join(" | ")
            .slice(0, 200)}`,
        );
      }
      const candidateById = new Map(candidates.map((c) => [c.id, c]));
      // Already-shown combos never reach the model.
      const unseen: typeof candidates = [];
      for (const v of checked.valid) {
        if (excludeKeys.has(v.key)) continue;
        const c = candidateById.get(v.key);
        if (c) unseen.push(c);
      }
      const byRuleId = new Map(ruleItems.map((item) => [item.id, item]));
      const rankInput = {
        candidates: unseen.map((c) => ({
          id: c.id,
          ruleScore: Math.round(c.score * 100),
          items: c.itemIds.map((id) => {
            const it = byRuleId.get(id) as RuleItem;
            return {
              id,
              nickname: it.nickname || `${it.primary_color} ${it.type}`,
              type: it.type,
              primary_color: it.primary_color,
              formality: it.formality,
              warmth: it.warmth,
              layer: it.layer,
              pattern: it.pattern,
              fit: it.fit ?? "n/a",
              length: it.length ?? "n/a",
            };
          }),
        })),
        weatherLine,
        mood,
        occasion,
        destination,
        dressCodeNote: dressCode?.note ?? null,
        whenLine,
        retryProblems: null as string | null,
        budget: pickBudget,
      };

      const tSpark = performance.now();
      try {
        let allValid: CachedOutfit[];
        if (unseen.length === 0) {
          // Every candidate was already shown; nothing new to rank.
          allValid = [];
        } else {
          const rankOnce = async (problems: string | null) => {
            const picks = await styleRankOutfits({ ...rankInput, retryProblems: problems });
            const raw: RawOutfit[] = picks.map((p) => {
              const cand = candidateById.get(p.candidate_id);
              return {
                item_ids: cand ? [...cand.itemIds] : [],
                reason: p.reason,
                weather_note: weatherNote,
                score: p.score,
              };
            });
            return validateOutfits({ items, raw, excludeKeys });
          };
          const first = await rankOnce(null);
          if (first.valid.length === 0 && unseen.length > 0) {
            const retryProblems = first.problems
              .map((p) => `Outfit ${p.index + 1}: ${p.reasons.join("; ")}`)
              .join(" | ");
            allValid = (await rankOnce(retryProblems)).valid;
          } else {
            allValid = first.valid;
          }
        }
        const gate = applyScoreThreshold(allValid, threshold);
        // Page order: spread repeated pieces across the 3 looks when possible.
        picked = arrangeForPages(gate.picked, items);
        relaxed = gate.relaxed;
        // Store full validated sets only (no excludes); requests with
        // excludes read+filter the cache but never overwrite it. The whole
        // validated set is stored (not just the shown slice) so later
        // requests re-apply the threshold themselves.
        if (allValid.length > 0 && excludeKeys.size === 0) {
          const storeCards: Record<string, CachedItemCard> = {};
          const storeUsed = new Set(allValid.flatMap((o) => o.item_ids));
          for (const item of items) {
            if (storeUsed.has(item.id)) {
              storeCards[item.id] = {
                cutoutUrl: item.cutoutUrl,
                type: item.tags.type,
                primary_color: item.tags.primary_color,
                nickname: item.tags.nickname ?? "",
                slot: slotForType(item.tags.type),
              };
            }
          }
          await writeCache(outfitCacheKey, {
            outfits: allValid,
            items: storeCards,
            weather,
            dressCode,
            source,
          } satisfies CachedResponse);
        }
      } catch (err) {
        // Rule fallback only on outage signatures (model 404 / 429 / 5xx).
        // 400/401 and anything non-Meta throw to the 500 path as real errors.
        const outage = isOutageError(err);
        if (!outage) throw err;
        console.log(`outfits rank failed, using rule fallback: ${(err as Error).message.slice(0, 120)}`);
        // Top rule-scored unseen candidates with stylist-written reasons.
        picked = unseen.slice(0, 3).map((c) => ({
          item_ids: [...c.itemIds],
          reason: c.reason,
          weather_note: weatherNote,
          key: c.id,
        }));
        source = "rules";
      }
      sparkMs = Math.round(performance.now() - tSpark);

      const usedIds = new Set(picked.flatMap((o) => o.item_ids));
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
    }

    // A failed dress call continues without it: treated exactly like no venue
    // (hidden UI, "skipped" in logs). Only a ran search with a note counts.
    const dressFailed = venue !== null && !dressCode;
    const dressSearched = !!dressCode?.note;
    const dressCitations = dressCode?.citations ?? 0;
    const dressStatus = !venue || dressFailed ? "skipped" : dressSearched ? "searched" : "none";

    const totalMs = Math.round(performance.now() - tAll);
    const pickedTypes = picked
      .map((o) => o.item_ids.map((id) => itemCards[id]?.type ?? "?").join("+"))
      .join(" ");
    console.log(
      `outfits cache=${cacheStatus} weather_ms=${weatherMs} dress_ms=${dressMs} dress=${dressStatus} citations=${dressCitations} ` +
        `spark_ms=${sparkMs} total_ms=${totalMs} valid=${picked.length} threshold=${threshold} relaxed=${relaxed} source=${source} ` +
        `combos=${combosGenerated} filtered=${afterFilters} rule_relaxed=${ruleRelaxed ?? "none"} top_rule=${topRuleScore.toFixed(2)} ` +
        `chosen=[${picked.map((o) => o.key).join(",")}] occasion=${occasion ?? "-"} mood=${mood ?? "-"} types=${pickedTypes} when=${dateISO ?? "today"}:${timeOfDay ?? "-"}`,
    );
    return NextResponse.json({
      source,
      relaxed,
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
    const outage = isOutageError(err);
    if (outage) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
