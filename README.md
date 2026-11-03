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

## Built during the hackathon

- 2026-10-30: foundation — Next.js scaffold, `/api/health` (Spark), `/capture` photo upload to Vercel Blob, home page.
- 2026-11-02: capture pipeline — photo → SAM 3.1 cutouts (14 nouns in parallel) → confidence ≥ 0.90 + area ≥ 2% + cross-noun IoU dedupe + footwear-pair merge → Spark tags + `is_single_garment` gate → Keep/Discard confirm into per-item Blob storage (`items/`, `candidates/`) → `/closet` grid grouped by type.
- 2026-11-02: unscanned-photo backlog — `/capture` splits photos into "Not scanned yet" / "Scanned" with per-photo "Find clothes", "Scan all" (sequential), "Scan again", and photo delete; `/api/segment` takes a `photoPathname` in our own `photos/` store only (no arbitrary URLs); per-photo scan records in `photos-meta/` track `{ scannedAt, candidateIds, keptIds }`.
- 2026-11-02: daily outfits — `/today` (mood/occasion chips, destination, geolocation + city fallback, 1–3 outfit collages, shuffle); `/api/outfits` fetches Open-Meteo forecast server-side, runs a separate Spark dress-code lookup (URL only from `url_citation`), counts closet coverage in code (no model call when incomplete), picks outfits via strict-JSON Spark with server-side ID/completeness validation + one retry, excludes session-shown combos; °C server-side, °F display for en-US.
- 2026-11-02: production-log fixes + crop — per-noun SAM logging with 429/5xx retry and concurrency 5 (all-error returns "Couldn't scan, try again"); faster tagging via 768px flattened JPEGs with per-unit `tag_ms`; tag errors retried once then shown untagged; gate rejections kept in a collapsed "Not sure these are clothes" list with Keep anyway; rescan-safe overwrites for candidates/meta only; live home-page health with Recheck; optional crop step (custom touch + keyboard-accessible cropper, no new dependencies) before upload.
- 2026-11-03: theme system + dark-mode audit — CSS tokens (light/dark/Auto via `data-theme`, saved choice, pre-paint script, 3-way switch in top nav + Home), all screens converted, light checkerboard kept in both modes, contrast gate `scripts/check-contrast.mjs` (text ≥ 4.5:1, borders/focus ≥ 3:1).

## Third-party code

- SAM stream-event shim (`lib/meta/sam.ts`): adapted from Meta's MIT-licensed cookbook [`07_sam/01_api_basics`](https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/01_api_basics) (`typescript/sam-api.ts`) — synthesizes `response.output_text.done` from `response.content_part.done`.
- Mask-to-cutout mapping (`lib/cutout.ts`): adapted from Meta's MIT-licensed cookbook [`07_sam/02_video_to_sticker_pack`](https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/02_video_to_sticker_pack) (`create-segmented-gif.mjs`) — mask raster scaled into its box, hole fill, alpha cutout, crop to box + padding. Ported via `spikes/01-sam-cutout.ts`.

## Not Meta

- Spoken replies: browser `speechSynthesis`, not a Meta model.
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
