import { NextResponse } from "next/server";

import { logBlobUsage } from "@/lib/blobStore";
import { listItems } from "@/lib/closet";
import { isStorageUnavailable, storageUnavailableResponse } from "@/lib/storage";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listItems();
    logBlobUsage("closet");
    return NextResponse.json({ items });
  } catch (err) {
    logBlobUsage("closet");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    const message = err instanceof Error ? err.message : "Could not list the closet.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
