import "server-only";

import {
  isTransientModel404,
  logModel404Retry,
  model404RetryDelayMs,
  sleep,
  sleepWithinBudget,
  type RetryBudget,
} from "./retry";

// Request shape adapted from Meta's MIT-licensed cookbook
// 06_muse_voice/01_voice_api_fundamentals (utils.py transcribe_recording):
// multipart "request" JSON part + "audio" WAV part. Native fetch + FormData;
// the openai SDK is not used for this endpoint.
const ASR_URL = "https://api.meta.ai/v1/asr/transcribe";
const MODEL = "muse-voice-transcribe-1.0";

export interface Transcription {
  transcript: string;
  sessionId: string;
  audioDurationMs: number;
}

type StatusError = Error & { status?: number; headers?: Headers };

function asrError(status: number, body: string, headers: Headers): StatusError {
  const err = new Error(`ASR HTTP ${status}: ${body.slice(0, 200)}`) as StatusError;
  err.status = status;
  err.headers = headers;
  return err;
}

function retryAfterMs(err: StatusError): number | null {
  try {
    const raw = err.headers?.get("retry-after");
    if (raw) {
      const secs = Number(raw);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    }
  } catch {
    // No usable header; fall through to exponential backoff.
  }
  return null;
}

/**
 * Transcribe a 16 kHz mono 16-bit PCM WAV. Never throws Meta errors raw:
 * 404-model, 429 and 5xx are retried within the shared budget, everything
 * else (400 malformed, 401, 413, content errors) fails fast. Logs carry
 * session + durations only, never the transcript.
 */
export async function transcribeWav(
  wav: Uint8Array,
  opts: { keywords?: string[]; budget?: RetryBudget } = {},
): Promise<Transcription> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MODEL_API_KEY is not set. Add it to .env.local (local dev) or the Vercel project environment variables.",
    );
  }
  const requestJson: Record<string, unknown> = {
    mode: "PUSH_TO_TALK",
    model: MODEL,
    audioEncoding: "WAV",
  };
  if (opts.keywords && opts.keywords.length > 0) requestJson.keywords = opts.keywords;

  const started = Date.now();
  let retries404 = 0;
  let retriesBackoff = 0;
  for (;;) {
    try {
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(requestJson)], { type: "application/json" }));
      form.append("audio", new Blob([wav as BlobPart], { type: "audio/wav" }), "voice.wav");
      const res = await fetch(ASR_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) throw asrError(res.status, await res.text().catch(() => ""), res.headers);
      const body = (await res.json()) as {
        transcript?: unknown;
        sessionId?: unknown;
        audioDurationMs?: unknown;
      };
      if (typeof body.transcript !== "string" || body.transcript.length === 0) {
        throw new Error("ASR response had no transcript");
      }
      const out: Transcription = {
        transcript: body.transcript,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
        audioDurationMs: typeof body.audioDurationMs === "number" ? body.audioDurationMs : 0,
      };
      console.log(
        `asr session=${out.sessionId || "-"} audio_ms=${out.audioDurationMs} ` +
          `chars=${out.transcript.length} total_ms=${Date.now() - started}`,
      );
      return out;
    } catch (err) {
      const status = (err as StatusError)?.status;
      if (isTransientModel404(err) && retries404 < 4) {
        logModel404Retry("transcribe", retries404, err);
        const delay = model404RetryDelayMs(retries404);
        retries404 += 1;
        if (opts.budget && !(await sleepWithinBudget(delay, opts.budget))) throw err;
        if (!opts.budget) await sleep(delay);
        continue;
      }
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (retryable && retriesBackoff < 3) {
        const delay = retryAfterMs(err as StatusError) ?? 500 * 2 ** retriesBackoff;
        retriesBackoff += 1;
        console.log(`asr retry=${retriesBackoff}/3 status=${status} delay_ms=${delay}`);
        if (opts.budget && !(await sleepWithinBudget(delay, opts.budget))) throw err;
        if (!opts.budget) await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}
