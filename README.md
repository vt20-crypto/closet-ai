# Closet AI

Outfits from the clothes you already own. Photo your closet, get daily outfit picks for your weather, mood and plans.

Built during the **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)** (Indie track, "Build for Your World").

## Meta models used

| Feature | Model / endpoint | Status |
|---|---|---|
| Health check | `muse-spark-1.3`, Responses API | live |
| _more rows to fill in as features land_ | | |

## Built during the hackathon

- 2026-10-30: foundation — Next.js scaffold, `/api/health` (Spark), `/capture` photo upload to Vercel Blob, home page.

## Third-party code

_(empty for now — cookbook code reused later keeps its header + license note and gets listed here)_

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
