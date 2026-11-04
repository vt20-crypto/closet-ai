# Closet AI

Outfits from the clothes you already own. Photo your closet, get daily outfit picks for your weather, mood and plans.

Built during the **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)** (Indie track, "Build for Your World").

## Meta models used

| Feature | Model / endpoint | Status |
|---|---|---|
| Health check | `muse-spark-1.3`, Responses API | live |
| Garment segmentation (`/api/segment`) | SAM 3.1 (`sam-3.1`), Responses API, streaming | live |
| Garment tagging + single-garment gate (`/api/segment`) | `muse-spark-1.3`, Responses API, strict JSON | live |
| Daily outfits + venue dress-code lookup (`/api/outfits`) | `muse-spark-1.3`, Responses API, strict JSON + `web_search` | live |
| Voice input + /today slot fill (`/api/transcribe`) | `muse-voice-transcribe-1.0` ASR + `muse-spark-1.3`, strict JSON | live |
| Dress-step camera check (`/api/dress/check`) | `muse-spark-1.3`, Responses API, strict JSON | live |
| Voice replan agent (`/api/dress/replan`) | `muse-spark-1.3`, Responses API, function tools | live |
| Stylized avatar (`/api/avatar`) | `muse-image-1.0`, `POST /v1/images/edits`, size `1024x1536` | live |
| Try-on render + verification (`/api/render`) | `muse-image-1.0` render, Spark strict-JSON `garments_match` / `invented_items` verify → re-render → flat-lay | live |

## Built during the hackathon

- 2026-10-30: foundation — Next.js scaffold, `/api/health` (Spark), `/capture` photo upload to Vercel Blob, home page.
- 2026-11-02: capture pipeline — photo → SAM 3.1 cutouts (14 nouns in parallel) → confidence ≥ 0.90 + area ≥ 2% + cross-noun IoU dedupe + footwear-pair merge → Spark tags + `is_single_garment` gate → Keep/Discard confirm into per-item Blob storage (`items/`, `candidates/`) → `/closet` grid grouped by type.
- 2026-11-02: unscanned-photo backlog — `/capture` splits photos into "Not scanned yet" / "Scanned" with per-photo "Find clothes", "Scan all" (sequential), "Scan again", and photo delete; `/api/segment` takes a `photoPathname` in our own `photos/` store only (no arbitrary URLs); per-photo scan records in `photos-meta/` track `{ scannedAt, candidateIds, keptIds }`.
- 2026-11-02: daily outfits — `/today` (mood/occasion chips, destination, geolocation + city fallback, 1–3 outfit collages, shuffle); `/api/outfits` fetches Open-Meteo forecast server-side, runs a separate Spark dress-code lookup (URL only from `url_citation`), counts closet coverage in code (no model call when incomplete), picks outfits via strict-JSON Spark with server-side ID/completeness validation + one retry, excludes session-shown combos; °C server-side, °F display for en-US.
- 2026-11-02: production-log fixes + crop — per-noun SAM logging with 429/5xx retry and concurrency 5 (all-error returns "Couldn't scan, try again"); faster tagging via 768px flattened JPEGs with per-unit `tag_ms`; tag errors retried once then shown untagged; gate rejections kept in a collapsed "Not sure these are clothes" list with Keep anyway; rescan-safe overwrites for candidates/meta only; live home-page health with Recheck; optional crop step (custom touch + keyboard-accessible cropper, no new dependencies) before upload.
- 2026-11-03: theme system + dark-mode audit — CSS tokens (light/dark/Auto via `data-theme`, saved choice, pre-paint script, 3-way switch in top nav + Home), all screens converted, light checkerboard kept in both modes, contrast gate `scripts/check-contrast.mjs` (text ≥ 4.5:1, borders/focus ≥ 3:1).
- 2026-11-03: "scrapbook closet" reskin — warm paper palette + Playfair Display / DM Sans / Caveat (OFL, self-hosted via `next/font/google`), sticker cutouts with id-seeded tilt and tape nickname labels, bento Home with weather sticker, sticker grids, layered outfit collages, espresso tab bar; tag schema gains `nickname` (≤ 2 words, falls back to "<color> <type>").
- 2026-11-03: voice on /today — tap-to-talk mic pill (Web Audio → 16 kHz mono 16-bit WAV in-browser, 20s cap, silence detect) → `/api/transcribe` (Muse Voice Transcribe ASR + Spark slot fill) fills the form and auto-runs outfits; outfit 1 read aloud via browser `speechSynthesis` + "Read again".

- 2026-11-03: get-dressed agent — `/dress` (linked from each outfit card) talks the user through one outfit item by item: full-screen tap target with the spoken instruction, rear-camera snapshot (`getUserMedia` + `<input capture>` fallback, ≤1024px) → `/api/dress/check` (Spark `low` effort compares snapshot vs target cutout + ≤3 same-type items, verdict match/wrong_item/unsure naming the visible difference, server-validated ids) → voice replan loop (`get_outfit_state`, `swap_item`, `mark_unavailable`, `finish`; cap 5 turns, repeat-3× stop, model picks same-slot replacements, invalid ids fall back to a deterministic pick) with a "How I decided" trace; repeat/back/skip/next handled on-device; Web Audio step sounds; finish flat-lay. See Best Agentic below.
- 2026-11-04: Avatar Studio + Stage — `/studio` (selfie → stylized 3D-animated full-body avatar via Muse Image, unguessable Blob paths, Redo deletes the old) and the Stage spotlight on `/style` (each look auto-rendered onto the avatar via `/api/render` with Spark verify → one re-render → flat-lay fallback, cache + next-look prefetch, swipe/Prev-Next, Save-look stub carrying date/time/place). See Best Creative below.
- 2026-11-04: outfit quality upgrade — deterministic styling engine (`lib/styleRules.ts`: enumerates complete outfits from the closet, hard filters warm/occasion/formality, weighted soft scores for color/proportion/pattern/mood/rotation/undertone/climate/feedback, diversity + relax ladder so results are never empty) proposes the top 15; Spark ranks 6 as final stylist (`styleRankOutfits`, score gate ≥7 else best ≥5 as now); fit schema (fit/length/sleeve/rise, all required with "n/a", per-type validation) with a `/api/closet/retag-fit` backfill; style profile + look thumbs in the Me sheet.
- 2026-11-04: fix pack 3 (Blob quota reliability) — storage failures surface as 503 `storage_unavailable` with one friendly line (never an empty closet or avatar CTA); 60s server caches for closet/avatar/version, exact-pathname cache reads, no-rewrite-when-unchanged writes, per-request `blob_usage` log lines; bulk-upload queue appends batches with per-row Waiting→Uploading→Scanning→Done/Failed+Retry; tile text clamps to 2 lines inside padded sticker wells.

## How styling works

- Pipeline: `lib/styleRules.ts` enumerates complete outfits from your closet (top+bottom or dress, + shoes, + mid/outer when the weather needs them; ~400 combos max), applies hard filters, scores the survivors with weighted soft rules, and keeps the top 15 (diverse tops/bottoms). Spark (`styleRankOutfits`) then picks and ranks 6 as the final stylist with a one-sentence reason each; your score gate (≥7, else best ≥5) and the pager stay as before. If Spark is down, the top rule-scored candidates show as "Quick pick" with a stylist-style rule reason.
- Hard filters: temperature band on the summed warmth (shoes excluded; soft score, hard-reject only 3+ outside the band, heavy coat above 24 °C, no outer below 5 °C or in rain); rain needs an outer layer and dry-friendly shoes; formality spread (outerwear excluded) ≤ 2 and inside the occasion range; shoe formality within 1 of the outfit median, no sneakers at formality ≥ 4. If fewer than 3 candidates survive, filters relax in order (warmth → occasion → spread 2 → 3) and the relax step is logged.
- Soft scores (weights in one `SCORE_WEIGHTS` object): color families and neutrals; fit/length/rise proportion pairings (neutral when an item lacks fit tags); pattern mixing (one bold max); mood mapping; rotation (items worn in the last 7 days dip, jeans/shoes dip less); skin-undertone bonus only when you set it in the Me sheet; hot+humid fit preference; venue strictness; your thumbs up/down history per item pair.
- Fit tags: every item carries `fit`/`length`/`sleeve`/`rise` (all required in the tag JSON, `"n/a"` where they don't apply), validated per garment type in code; `POST /api/closet/retag-fit` backfills existing items.
- Sources that shaped the rules: the 6-3-1 color proportion rule ([thevou.com](https://www.thevou.com)), pattern-mixing guidance ([harryrosen.com](https://www.harryrosen.com)), undertone palettes ([themodestman.com](https://www.themodestman.com)), type-aware outfit compatibility (Vasileva et al., ECCV 2018, [arxiv.org/abs/1803.09196](https://arxiv.org/abs/1803.09196)), and fashion compatibility learning (Han et al., 2017, [arxiv.org/abs/1707.05691](https://arxiv.org/abs/1707.05691)). Thresholds and weights are our own tuned heuristics, not the sources' numbers.

## Best Agentic: get-dressed agent

- Loop: `replanOutfit` (`lib/meta/spark.ts`) drives `runAgentLoop` (`lib/dressAgent.ts`) — model text ends the turn; `function_call` items run local tools and return as `function_call_output` with `previous_response_id`. Cap 5 turns; the same (tool, args) 3× stops the loop with a safe fallback line.
- Tools: `get_outfit_state` (plan summary), `swap_item(slot, item_id, reason)` (model picks from same-slot candidates carrying nickname/color/warmth/formality/layer + today's weather; server validates id, slot, availability, then falls back deterministically and logs it), `mark_unavailable(item_id)`, `finish`.
- Validation: every id the loop names is checked against the closet server-side (unknown `matched_item_id` forces `unsure`); `lib/dressAgent.test.ts` proves the cap, repeat-stop, valid-swap and invalid-swap-fallback paths with a fake model; `lib/dress.test.ts` locks the dressing order and state machine.
- Eyes-free: every response spoken (`speechSynthesis`), whole screen is one tap target, sounds per step, local repeat/back/skip/next (no AI call), trace shown as plain-language tool lines only.

## Best Creative: avatar try-on stage

- One selfie becomes a reusable character: `/studio` sends a ≤1024px selfie (never stored) to Muse Image with a neutral-base-layer, head-to-toe, vibe-driven-pose prompt; the stylized avatar is saved under an unguessable Blob path with the pointer in a small JSON, and Redo deletes the old file.
- Every outfit is staged on that character: `/api/render` dresses the avatar in the look's real cutouts under a strict garment-only prompt, then Spark verifies `{ garments_match, invented_items[] }` — a fail re-renders once naming the invented pieces, a second fail falls back to the flat-lay with an honest note. Renders cache by avatar version + sorted item ids; the next look prefetches silently.
- Privacy holds throughout: routes log timings and verdicts only, never images; the browser never calls Meta directly.

## Third-party code

- SAM stream-event shim (`lib/meta/sam.ts`): adapted from Meta's MIT-licensed cookbook [`07_sam/01_api_basics`](https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics) (`typescript/sam-api.ts`) — synthesizes `response.output_text.done` from `response.content_part.done`.
- Mask-to-cutout mapping (`lib/cutout.ts`): adapted from Meta's MIT-licensed cookbook [`07_sam/02_video_to_sticker_pack`](https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/02_video_to_sticker_pack) (`create-segmented-gif.mjs`) — mask raster scaled into its box, hole fill, alpha cutout, crop to box + padding. Ported via `spikes/01-sam-cutout.ts`.
- Fonts (OFL 1.1, self-hosted via `next/font/google`, no runtime request to Google): [Playfair Display](https://github.com/google/fonts/tree/main/ofl/playfairdisplay), [DM Sans](https://github.com/google/fonts/tree/main/ofl/dmsans), [Caveat](https://github.com/google/fonts/tree/main/ofl/caveat).
- ASR request shape (`lib/meta/voice.ts`): adapted from Meta's MIT-licensed cookbook [`06_muse_voice/01_voice_api_fundamentals`](https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals) (`utils.py transcribe_recording`) — multipart `request` JSON (`mode: PUSH_TO_TALK`, `model`, `audioEncoding: WAV`, optional `keywords`) + `audio` WAV part.
- Image edits (`lib/meta/image.ts`, ported via `spikes/08-image-edits.ts`): `POST /v1/images/edits` with a JSON `images` array, `reasoning_strength: "low"`, tool enablement off — the Image-on-Responses pattern from Meta's MIT-licensed cookbook [`05_muse_image/02_backyard_restyle`](https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/02_backyard_restyle).

## Not Meta

- Spoken replies (`speechSynthesis` outfit readout + "Read again", all `/dress` guidance/verdicts): browser Web Speech API, not a Meta model.
- Step sounds (`/dress` confirmation blips): Web Audio oscillator in the browser, not a Meta model.
- Weather: Open-Meteo (free, no key) — planned.
- Storage: Vercel Blob.

## Run locally

```bash
cd closet-ai
npm install
# add your key (never commit it):
printf 'MODEL_API_KEY=...\n' >> .env.local
npm run dev
```

Open http://localhost:3000. `/capture` uploads need `BLOB_READ_WRITE_TOKEN` (from `vercel env pull .env.local` after linking the Vercel project, or set it in `.env.local` yourself).
