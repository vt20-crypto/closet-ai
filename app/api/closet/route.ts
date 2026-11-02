import { NextResponse } from "next/server";

import { listItems } from "@/lib/closet";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listItems();
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list the closet.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
