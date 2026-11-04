# AGENTS.md: Closet AI

Instructions for coding agents (Muse Code) working in this repo. Read this fully before every task.

## What this is
**Closet AI**: a mobile-first web app that dresses you from clothes you already own. It builds a closet from photos and video, recommends outfits for your weather, mood and plans, and talks you through getting dressed (it can help low-vision users dress independently).
Built for the **Meta Global AI Developer Hackathon** (Indie track, theme "Build for Your World"). **Submission deadline: Nov 4, 2026, 8 PM ET** (treat as a hard stop).

## Hackathon rules (breaking any = disqualification)
- The repo is **public**. **Never commit secrets.** `.env*` stays in `.gitignore`. Never print, log or echo API keys or tokens.
- **Only new work**, built during the event. Every feature must be listed in `README.md` → "Built during the hackathon".
- Code copied from Meta's cookbooks (MIT / Apache-2.0) keeps a header comment with the source URL and license, and is listed in `README.md` → "Third-party code".
- Only use assets we have rights to: the user's own photos, generated images, permissively licensed libraries.
- Every Meta call is a real use of Meta's models. Don't fake or hard-code model output in the product (the demo seed data is real model output, saved).

## Stack
- Next.js (App Router, TypeScript, Tailwind), deployed on **Vercel**. Package manager: **npm**.
- Meta Model API via the `openai` npm SDK: `new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY })`. **Pass the key explicitly** (the SDK does not read `MODEL_API_KEY`).
- `@meta-sam/parser` for SAM output. `sharp` for server-side image work.
- Storage: **Vercel Blob** (images, video, `closet.json`). One demo user, no auth.
- Weather: Open-Meteo (free, no key). Speech output: browser `speechSynthesis` (**not Meta**, so say so in the README).
- Env vars: `MODEL_API_KEY` (server only), `BLOB_READ_WRITE_TOKEN`. **Never** prefix secrets with `NEXT_PUBLIC_`.

## Architecture rules
- **The browser never calls api.meta.ai.** Every Meta call goes through a server route in `app/api/*` (there are no temporary browser tokens).
- All Meta helpers live in `lib/meta/` (one file per model: `spark.ts`, `sam.ts`, `image.ts`, `voice.ts`). Routes stay thin.
- Long routes (`segment`, `video`, `render`) set `export const maxDuration = 60` (or more) and stream where possible.
- Uploads: the browser resizes photos to **max 1600px JPEG** before upload. Videos go **browser → Vercel Blob directly** (client upload), never through a route body (~4.5 MB limit).
- Every model output that names closet items is **checked against the closet by ID** on the server. Never show an item that doesn't exist.

## Meta API conventions (verified by our spike, 2026-10-30)
- Use the **Responses API** (`client.responses.create`) for Spark and SAM.
- **Interactive Spark calls:** failover chain `muse-spark-1.3` → `muse-spark-1.2` → `muse-spark-1.1` → `muse-wonder-1.0` (each verified live with strict json_schema, input_image, and function tools; whitespace in strict JSON parses normally), `reasoning: { effort: "low" }` (pick/tag slots use `minimal`). Never use contributor models in the app (user photos). A 404 mentioning the model means that id is dead: move to the next id immediately with no backoff, mark it dead for 90s (in-memory circuit breaker, `lib/meta/retry.ts` `withModelFailover`/`markModelDead`/`isModelDead`), then allow it again. 429/5xx keep their existing backoff on the same id. Log `model_used` per call.
- **Structured output:** `text: { format: { type: "json_schema", name, schema, strict: true } }`. With strict, every object needs `additionalProperties: false` and all keys in `required`. Do NOT send `response_format` on Responses (it returns 400).
- **Tools:** function tools are top-level `{ type: "function", name, description, parameters }`. Built-in `{ type: "web_search" }` can be mixed in. `tool_choice` only accepts `"auto"`. Agent loops: `function_call` → run the tool → `function_call_output` + `previous_response_id`. **Cap at 5 steps**, and stop if the same (tool, args) repeats 3 times.
- **SAM 3.1** (`sam-3.1`): `stream: true`, **one specific noun per request** (shirt, t-shirt, pants, jeans, shorts, skirt, dress, jacket, sweater, hoodie, coat, shoe, sneaker, boot), run in **parallel**. Generic phrases ("clothing") fragment, so don't use them. `metadata: { include_confidence: "true" }` must be the **string** "true". Apply the cookbook **stream-event shim** (the API sends `response.content_part.done` but not `response.output_text.done`). **Masks are relative to the box**: draw the mask into the box, not the full frame.
- **Cutouts:** decode the mask → **fill enclosed holes** (tags, logos, prints inside the garment become garment) → apply as alpha → crop to the box with padding → transparent PNG.
- **Garment filter pipeline:** SAM confidence ≥ 0.90 AND mask area ≥ 2% of the image → Spark gate `is_single_garment` (in the spike it rejected 6/6 junk and 0/3 good) → user taps to confirm. Confidence alone is not enough.
- **Muse Image** (`muse-image-1.0`): `POST /v1/images/edits` with a JSON `images` array (1–10 refs), `reasoning_strength: "low"`, tool enablement off (image search, web search, shell), ≈9s. Prompt: "Dress the person ONLY in the provided garment images. Do not add, invent or substitute any clothing. Reference garments may have small missing areas; render them as complete, continuous garments. Keep face, body and pose unchanged."
- **Render verification:** after every try-on, send render + references to Spark (`garments_match`, `invented_items[]`). On failure, re-render once naming the invented items to remove. Still failing → flat-lay collage.
- **Voice** (`muse-voice-transcribe-1.0`): `POST /v1/asr/transcribe` with `Authorization: Bearer <MODEL_API_KEY>`, multipart with TWO parts — `request`: JSON (`{mode:"PUSH_TO_TALK", model:"muse-voice-transcribe-1.0", audioEncoding:"WAV"}`, optional `keywords[]`, `languageBias[]`) and `audio`: the WAV file. Response: `{sessionId, transcript, audioDurationMs, turns[]}` → use `.transcript`; log sessionId + durations (no `x-request-id` on this endpoint). **WAV only** (mono, 16-bit PCM, 16 kHz); the browser records with Web Audio and encodes WAV itself. **Never** use the realtime websocket from the browser. Shape verified live 2026-11-03 (200, 1.41s) from the MIT cookbook `06_muse_voice/01_voice_api_fundamentals`.
- Handle 429 with exponential backoff from 500 ms, honoring `Retry-After` (same id — only 404-model rotates). Handle 400 `content_policy_violation` gracefully.

## Product pipeline
1. **Capture**: single photo (rear camera), bed pile (one photo, many garments), or **video scan** (SAM video tracking; clips can come from Ray-Ban Meta glasses) → cutouts → filter → confirm.
2. **Tag**: Spark per cutout → `{ is_single_garment, rejection_reason, type, primary_color, secondary_colors, formality 1-5, warmth 1-5, layer base|mid|outer, fabric_weight, pattern, seasons[], distinguishing_note }`.
3. **Recommend**: mood + occasion + destination (+ optional web-search dress-code lookup) + Open-Meteo forecast → Spark returns outfits **by item ID** with a reason each → server validates the IDs → shuffle.
4. **Try-on**: **default is a stylized avatar generated ONCE from the user's selfie** (fashion-illustration / 3D-animated look, same skin tone, hair and build, plain grey base layer), saved and reused. "Use my real photo" is an option. Always render a complete outfit.
5. **Get-dressed agent** (snapshots, not live video): voice ask → pick → guide one item at a time → "check" snapshot → SAM cutout → Spark compares against **same-type closet items only** → match / wrong item / unsure → replan (e.g. "it's in the laundry") → finish. Every response is spoken. The whole screen is one button. Play a sound on each step (iOS has no vibration). Speech starts from a user tap.
6. Extras: rotation nudges (wear log), trip mode, gap analysis (**counted in code**, not guessed by the model).

## Scope (in priority order; don't build ahead of the current task)
- **Must:** capture + cutouts + filter · tagging + closet view · daily outfits + weather + shuffle + ID check · voice in + spoken out · get-dressed agent
- **Should:** video scan · stylized-avatar try-on + verification · rotation nudges · simple trip mode · dress-code web search
- **Could:** bed pile · gap analysis + Muse Image preview · real-photo try-on polish · Muse Wonder planner · open-weights (Spark Open on Fireworks)

## Accessibility (from day one, not later)
Semantic HTML, real `<button>`s with labels, visible focus, `aria-live` regions for spoken/status updates, large tap targets, high-contrast text, and it works with VoiceOver.

## Theme
All new UI uses the color tokens in `app/globals.css` (`bg-(--surface)`, `text-(--text)`, `border-(--border)` for controls, `border-(--border-soft)` for decorative edges only, etc.), never hard-coded colors or `dark:` classes. Disabled controls use `--disabled-bg`/`--disabled-text`, not opacity alone. Never place light text on `--pop` (dark `--pop-ink` only). Garment cutouts use `Sticker`/`Tape` in `app/sticker.tsx` (white die-cut is the one deliberate exception). Headings `font-display`, body `font-sans` (16px min), labels `font-hand`. Check new text pairs with `node scripts/check-contrast.mjs` (text ≥ 4.5:1, borders/focus ≥ 3:1).

## Working style
- Use `/plan` for anything bigger than a small fix and wait for approval.
- Keep diffs small and focused. One feature per task.
- Before saying "done": `npm run build` passes, `npm run lint` passes, and you've described exactly how to test it on a phone.
- **Don't commit or push.** The human does git. Suggest a one-line commit message at the end of each task.
- Append a short entry to `BUILD_LOG.md` after each task: date, what was built, which Meta models it uses.
- Never open or describe the user's personal photos (selfie) unless asked.
- If the docs and this file disagree, say so and ask. Don't guess API fields; check https://dev.meta.ai/docs.
