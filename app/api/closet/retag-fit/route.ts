import { NextResponse } from "next/server";

import { listItems, saveItem } from "@/lib/closet";
import { flattenForTag } from "@/lib/cutout";
import { createRetryBudget, isOutageError } from "@/lib/meta/retry";
import { tagFit } from "@/lib/meta/spark";

export const maxDuration = 120;

/**
 * Fit backfill: re-runs Spark (low effort) on every closet item missing the
 * fit axes, asking ONLY for fit/length/sleeve/rise, and merges the result
 * into the item record (bumping updatedAt). Concurrency 4. Logs counts only.
 */
export async function POST() {
  const started = Date.now();
  const budget = createRetryBudget(started + 100_000);
  try {
    const items = await listItems();
    const stale = items.filter((item) => !item.tags || !item.tags.fit);
    let updated = 0;
    let failed = 0;
    const queue = [...stale];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        try {
          const res = await fetch(item.cutoutUrl, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const flat = await flattenForTag(Buffer.from(await res.arrayBuffer()));
          const axes = await tagFit(
            `data:image/jpeg;base64,${flat.toString("base64")}`,
            item.tags?.type ?? "garment",
            budget,
          );
          await saveItem(
            {
              ...item,
              tags: { ...item.tags, ...axes },
              updatedAt: new Date().toISOString(),
            },
            { allowOverwrite: true },
          );
          updated += 1;
        } catch {
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    console.log(
      `retag-fit ms=${Date.now() - started} scanned=${items.length} stale=${stale.length} updated=${updated} failed=${failed}`,
    );
    return NextResponse.json({ updated, failed, total: stale.length });
  } catch (err) {
    if (isOutageError(err)) {
      return NextResponse.json(
        { error: "Meta's AI is having a hiccup. Try again.", code: "meta_unavailable" },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Retag failed.";
    console.log(`retag-fit ERROR ${message.slice(0, 160)}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
