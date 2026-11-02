import { NextResponse } from "next/server";

import { confirmCandidate, saveItem, type ClosetItem } from "@/lib/closet";
import { flattenForTag } from "@/lib/cutout";
import { tagGarment, untaggedFallback } from "@/lib/meta/spark";
import { isPhotoPathname, recordKept } from "@/lib/photos";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { candidateIds?: unknown };
    if (!Array.isArray(body.candidateIds) || body.candidateIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "candidateIds must be a string array." }, { status: 400 });
    }
    const items: ClosetItem[] = [];
    for (const id of body.candidateIds as string[]) {
      try {
        const candidate = await confirmCandidate(id);
        // Untagged candidates (the tag call errored twice) get one more tag
        // attempt at confirm time; a fallback keeps the keep working.
        let confirmed: ClosetItem = { ...candidate, tags: candidate.tags ?? untaggedFallback(candidate.nouns) };
        if (!candidate.tags) {
          try {
            const res = await fetch(candidate.cutoutUrl);
            if (res.ok) {
              const flat = await flattenForTag(Buffer.from(await res.arrayBuffer()));
              const result = await tagGarment(`data:image/jpeg;base64,${flat.toString("base64")}`);
              if (!result.errored) confirmed = { ...candidate, tags: result.tags };
            }
          } catch {
            // Fallback tags already set; the keep succeeds regardless.
          }
          await saveItem(confirmed);
        }
        items.push(confirmed);
        // Bookkeeping only: a meta failure must not undo the confirm.
        if (confirmed.photoPathname && isPhotoPathname(confirmed.photoPathname)) {
          try {
            await recordKept(confirmed.photoPathname, [confirmed.id]);
          } catch (err) {
            console.log(
              `confirm meta photo=${confirmed.photoPathname} ERROR ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Confirm failed.";
        return NextResponse.json({ error: message, confirmed: items }, { status: 404 });
      }
    }
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Confirm failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
