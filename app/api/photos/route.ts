import { NextResponse } from "next/server";
import { list } from "@vercel/blob";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { blobs } = await list({ prefix: "photos/" });
    return NextResponse.json({
      photos: blobs
        .filter((blob) => /\.(jpe?g|png|webp)$/i.test(blob.pathname))
        .map((blob) => ({ url: blob.url, pathname: blob.pathname })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list photos.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
