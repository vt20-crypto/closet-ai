import "server-only";

import { sleep, sleepWithinBudget, type RetryBudget } from "./retry";

/**
 * Muse Image (`muse-image-1.0`) via POST /v1/images/edits with a JSON body:
 * an `images` array of { image_url } data URLs, `reasoning_strength: "low"`,
 * all `tool_enablement` flags off, and `size` in documented "WxH" form.
 * Request shape verified against the spike (spikes/08-image-edits.ts) and
 * https://dev.meta.ai/docs/image-generation.
 */

const EDITS_URL = "https://api.meta.ai/v1/images/edits";
// 2:3 in the documented WxH form.
const IMAGE_SIZE = "1024x1536";
// 404 "model not found" gets these backoffs, then the route shows the hiccup.
const OUTAGE_BACKOFFS_MS = [1000, 2000, 4000];

export interface EditImageInput {
  /** Data URLs (selfies, cutouts) or public Blob URLs, 1–10 refs. */
  images: string[];
  prompt: string;
  /** Shared per-route retry deadline (never past maxDuration minus 5s). */
  budget?: RetryBudget;
}

async function gatedSleep(ms: number, budget?: RetryBudget): Promise<boolean> {
  if (budget) return sleepWithinBudget(ms, budget);
  await sleep(ms);
  return true;
}

function outageError(status: number, label: string): Error {
  // The 404 names the model id so isOutageError() recognizes it.
  const err = new Error(`image model muse-image-1.0 ${label} (HTTP ${status})`);
  (err as { status?: number }).status = status;
  return err;
}

/** Render via Muse Image edits. Returns the PNG bytes. Never logs images. */
export async function editImage(input: EditImageInput): Promise<Buffer> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set.");
  const body = (size: string | undefined) =>
    JSON.stringify({
      model: "muse-image-1.0",
      prompt: input.prompt,
      images: input.images.map((image_url) => ({ image_url })),
      n: 1,
      ...(size ? { size } : {}),
      reasoning_strength: "low",
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
    });
  let size: string | undefined = IMAGE_SIZE;
  let sizeRetried = false;
  let outageRounds = 0;
  let retried429 = false;
  for (;;) {
    const res = await fetch(EDITS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body(size),
    });
    if (res.ok) {
      const parsed = (await res.json()) as { data?: Array<{ b64_json?: string }> };
      const b64 = parsed.data?.[0]?.b64_json;
      if (!b64) throw new Error("image edits response had no data[0].b64_json");
      return Buffer.from(b64, "base64");
    }
    const text = (await res.text()).slice(0, 300);
    const status = res.status;
    if (status === 400 && /content_policy_violation/i.test(text)) {
      throw new Error(`content_policy_violation: ${text}`);
    }
    if (status === 400 && size && !sizeRetried) {
      // Once: the WxH size may be unsupported — retry without it.
      sizeRetried = true;
      size = undefined;
      continue;
    }
    const modelMissing = status === 404 && /model/i.test(text);
    if (modelMissing) {
      if (outageRounds >= OUTAGE_BACKOFFS_MS.length) throw outageError(status, "not found");
      const delay = OUTAGE_BACKOFFS_MS[outageRounds];
      outageRounds += 1;
      if (!(await gatedSleep(delay, input.budget))) throw outageError(status, "not found");
      continue;
    }
    if (status === 429 || status >= 500) {
      if (retried429) throw outageError(status, "unavailable");
      retried429 = true;
      const headerValue = res.headers.get("retry-after");
      const secs = headerValue ? Number(headerValue) : NaN;
      const delay = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 1000;
      if (!(await gatedSleep(delay, input.budget))) throw outageError(status, "unavailable");
      continue;
    }
    throw new Error(`image edits HTTP ${status}: ${text}`);
  }
}
