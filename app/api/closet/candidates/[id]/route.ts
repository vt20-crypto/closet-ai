import { NextResponse } from "next/server";

import { logBlobUsage } from "@/lib/blobStore";
import { deleteCandidate, getCandidate, saveCandidate } from "@/lib/closet";
import { validateItemEdit } from "@/lib/itemEdit";
import { isStorageUnavailable, storageUnavailableResponse } from "@/lib/storage";
import { untaggedFallback } from "@/lib/meta/spark";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing candidate id." }, { status: 400 });
    await deleteCandidate(id);
    logBlobUsage("closet/candidates-delete");
    return NextResponse.json({ deleted: id });
  } catch (err) {
    logBlobUsage("closet/candidates-delete");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    const message = err instanceof Error ? err.message : "Could not delete the candidate.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Edit a not-yet-confirmed candidate's tags (untagged ones start blank). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing candidate id." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send JSON: fields to change." }, { status: 400 });
    }
    const candidate = await getCandidate(id);
    if (!candidate) return NextResponse.json({ error: "Unknown candidate." }, { status: 404 });
    const base = candidate.tags ?? untaggedFallback(candidate.nouns);
    const { tags, error } = validateItemEdit(body, base);
    if (!tags) return NextResponse.json({ error }, { status: 400 });
    const updated = { ...candidate, tags: { ...base, ...tags } };
    await saveCandidate(updated);
    logBlobUsage("closet/candidates-patch");
    return NextResponse.json({ candidate: updated });
  } catch (err) {
    logBlobUsage("closet/candidates-patch");
    if (isStorageUnavailable(err)) return storageUnavailableResponse();
    const message = err instanceof Error ? err.message : "Could not save the candidate.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
