import { NextResponse } from "next/server";

import { logBlobUsage } from "@/lib/blobStore";
import { getClosetVersion } from "@/lib/closet";
import { isStorageUnavailable, storageUnavailableResponse } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Cheap closet fingerprint for the "closet changed" pill: newest item-blob
 * write plus the item count. Served from an in-memory stamp (60s max);
 * at most one list() per 60s even on a cold cache.
 */
export async function GET() {
  try {
    const version = await getClosetVersion();
    logBlobUsage("closet/version");
    return NextResponse.json(version);
  } catch (err) {
    logBlobUsage("closet/version");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    const message = err instanceof Error ? err.message : "Version check failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
