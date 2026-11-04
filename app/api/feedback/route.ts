import { NextResponse } from "next/server";

import { readJsonFromStore, writeJsonToStore } from "@/lib/blobStore";
import { getBlobStore } from "@/lib/cache";
import type { LookVote } from "@/lib/styleRules";

const PATH = "feedback/looks.json";
const MAX_VOTES = 200;

interface StoredVote extends LookVote {
  at: string;
}

/** One vote per look: thumbs up/down on a look card, used for pair feedback. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: outfitKey, itemIds, vote." }, { status: 400 });
  }
  const input = (body ?? {}) as { outfitKey?: unknown; itemIds?: unknown; vote?: unknown };
  if (typeof input.outfitKey !== "string" || input.outfitKey === "") {
    return NextResponse.json({ error: "outfitKey is required." }, { status: 400 });
  }
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0 || input.itemIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "itemIds must be a non-empty string array." }, { status: 400 });
  }
  if (input.vote !== 1 && input.vote !== -1 && input.vote !== 0) {
    return NextResponse.json({ error: "vote must be 1, -1 or 0 (remove)." }, { status: 400 });
  }
  try {
    const store = getBlobStore();
    const { data } = await readJsonFromStore<StoredVote[]>(store, PATH, Number.POSITIVE_INFINITY);
    const votes = (Array.isArray(data) ? data : []).filter((vote) => vote.key !== input.outfitKey);
    if (input.vote !== 0) {
      votes.unshift({
        key: input.outfitKey as string,
        itemIds: input.itemIds as string[],
        vote: input.vote as 1 | -1,
        at: new Date().toISOString(),
      });
    }
    await writeJsonToStore(store, PATH, votes.slice(0, MAX_VOTES));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not save the vote." }, { status: 500 });
  }
}
