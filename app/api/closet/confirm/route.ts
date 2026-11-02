import { NextResponse } from "next/server";

import { confirmCandidate } from "@/lib/closet";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { candidateIds?: unknown };
    if (!Array.isArray(body.candidateIds) || body.candidateIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "candidateIds must be a string array." }, { status: 400 });
    }
    const items = [];
    for (const id of body.candidateIds as string[]) {
      try {
        items.push(await confirmCandidate(id));
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
