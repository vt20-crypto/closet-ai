import { NextResponse } from "next/server";

import { readJsonFromStore, writeJsonToStore } from "@/lib/blobStore";
import { getBlobStore } from "@/lib/cache";
import type { StyleProfile } from "@/lib/styleRules";

const PATH = "profile/style.json";

const STYLES = ["classic", "minimal", "streetwear", "relaxed", "smart", "bold"];
const UNDERTONES = ["warm", "cool", "neutral", "not sure"];
const STRICTNESS = ["relaxed", "standard", "conservative"];

/** Style profile (all optional, user-chosen). Undertone is never inferred. */
export async function GET() {
  const { data } = await readJsonFromStore<StyleProfile>(
    getBlobStore(),
    PATH,
    Number.POSITIVE_INFINITY,
  );
  return NextResponse.json({ profile: data ?? {} });
}

function cleanList(value: unknown, allowed: string[]): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: style profile." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Send JSON: style profile." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (!["style", "undertone", "strictness"].includes(key)) {
      return NextResponse.json({ error: `Unknown profile field: ${key}.` }, { status: 400 });
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      return NextResponse.json({ error: `${key} must be a string or null.` }, { status: 400 });
    }
  }
  const profile: StyleProfile = {
    style: cleanList(input.style, STYLES),
    undertone: cleanList(input.undertone, UNDERTONES) as StyleProfile["undertone"],
    strictness: cleanList(input.strictness, STRICTNESS) as StyleProfile["strictness"],
  };
  try {
    await writeJsonToStore(getBlobStore(), PATH, profile);
  } catch {
    return NextResponse.json({ error: "Could not save the profile." }, { status: 500 });
  }
  return NextResponse.json({ profile });
}
