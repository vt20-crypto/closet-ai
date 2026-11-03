import { NextResponse } from "next/server";

import { createRetryBudget, isMetaApiError, META_HICCUP_MESSAGE, META_UNAVAILABLE_CODE } from "@/lib/meta/retry";
import { parseVoiceSlots } from "@/lib/meta/spark";
import { transcribeWav } from "@/lib/meta/voice";

export const maxDuration = 30;

/** Browser-recorded WAV only: RIFF....WAVE magic, ~2 MB cap. */
function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length > 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

function cleanKeywords(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((w) => w.toLowerCase().replace(/[^a-z ]/g, "").trim())
    .filter((w) => w.length > 0 && w.length <= 24)
    .slice(0, 20);
}

export async function POST(req: Request) {
  const started = Date.now();
  // 25s retry budget inside the 30s route ceiling, like the other routes.
  const budget = createRetryBudget(started + 25_000);
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("audio/wav") && !contentType.startsWith("audio/x-wav")) {
    return NextResponse.json({ error: "Send a WAV recording (audio/wav)." }, { status: 400 });
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "Recording is empty or over ~2 MB." }, { status: 413 });
  }
  if (!isWav(bytes)) {
    return NextResponse.json({ error: "Send a WAV recording (audio/wav)." }, { status: 400 });
  }

  try {
    const keywords = cleanKeywords(new URL(req.url).searchParams.get("keywords"));
    const out = await transcribeWav(bytes, { keywords, budget });
    // Same request fills the form: map the transcript onto /today slots.
    const slots = await parseVoiceSlots(out.transcript, { budget });
    console.log(`transcribe route_ms=${Date.now() - started} bytes=${bytes.length}`);
    return NextResponse.json({ transcript: out.transcript, slots });
  } catch (err) {
    if (isMetaApiError(err)) {
      return NextResponse.json(
        { error: META_HICCUP_MESSAGE, code: META_UNAVAILABLE_CODE },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.log(`transcribe error=${JSON.stringify(message.slice(0, 200))} route_ms=${Date.now() - started}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
