import { NextResponse } from "next/server";
import { list } from "@vercel/blob";

export const dynamic = "force-dynamic";

/**
 * Cheap closet fingerprint for the "closet changed" pill: the newest item
 * blob write plus the item count. Overwrites bump uploadedAt, so edits,
 * confirms and deletes all move the version without reading every JSON.
 */
export async function GET() {
  try {
    let cursor: string | undefined;
    let stamp = "";
    let count = 0;
    do {
      const page = await list({ prefix: "items/", cursor });
      for (const blob of page.blobs) {
        if (!blob.pathname.endsWith(".json")) continue;
        count += 1;
        const uploaded = new Date(blob.uploadedAt).toISOString();
        if (uploaded > stamp) stamp = uploaded;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return NextResponse.json({ stamp, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Version check failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
