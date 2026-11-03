import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";

import {
  deletePhotoFamily,
  deletePhotoMeta,
  isPhotoPathname,
  listPhotoMeta,
} from "@/lib/photos";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { blobs } = await list({ prefix: "photos/" });
    const meta = await listPhotoMeta();
    return NextResponse.json({
      photos: blobs
        .filter((blob) => /\.(jpe?g|png|webp)$/i.test(blob.pathname))
        .map((blob) => ({ url: blob.url, pathname: blob.pathname })),
      meta,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list photos.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Delete a raw photo blob plus its scan meta. Kept closet items are never
 * touched: items/ and candidates/ blobs are left alone.
 */
export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { pathname?: unknown; deleteFamily?: unknown };
    if (!isPhotoPathname(body.pathname)) {
      return NextResponse.json(
        { error: "pathname must be a photo in our own store (photos/...)." },
        { status: 400 },
      );
    }
    if (body.deleteFamily === true) {
      const deleted = await deletePhotoFamily(body.pathname);
      return NextResponse.json({ deleted });
    }
    await del(body.pathname);
    try {
      await deletePhotoMeta(body.pathname);
    } catch {
      // Photo is gone; a missing meta record is not a failure.
    }
    return NextResponse.json({ deleted: body.pathname });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete the photo.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
