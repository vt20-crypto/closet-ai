import "server-only";

import OpenAI from "openai";

const BASE_URL = "https://api.meta.ai/v1";

let cached: OpenAI | null = null;

/**
 * Shared Meta Model API client. The SDK does not read MODEL_API_KEY itself,
 * so the key is passed explicitly. The client is created lazily so importing
 * this module (e.g. during `next build`) never throws when the key is absent.
 */
export function getMetaClient(): OpenAI {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MODEL_API_KEY is not set. Add it to .env.local (local dev) or the Vercel project environment variables.",
    );
  }
  if (!cached) {
    cached = new OpenAI({ baseURL: BASE_URL, apiKey });
  }
  return cached;
}
