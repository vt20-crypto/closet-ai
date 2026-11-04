# Closet AI: Business and Operating Model

Status: hackathon draft. Figures marked "est." are planning assumptions, not billing data. Spark text pricing is not final.

## 1. Unit costs

| Item | Measured / known | Unit cost |
|---|---|---|
| Muse Image avatar and try-on render | ~7-12 s per image, limit 150 rpm | ~$0.01 / image |
| Spark text calls (outfits, tagging, verify, voice slot fill) | Small JSON-schema calls | TBD per Meta pricing |
| SAM 3.1 closet scan | 16 parallel noun-phrase calls per photo | 16 calls per photo (listed SAM rate in HACKATHON_NOTES.md is $2.50 / 1k images, ~$0.04 / photo if each call is billed as one image) |
| Voice transcription | One clip per voice request | Priced per audio hour (see HACKATHON_NOTES.md); a few seconds per clip, negligible |
| Vercel Blob storage | Cutouts, generated avatar, cached renders | Per GB-month plus transfer, small at this scale |
| Vercel functions | API routes, scan fan-out, render proxy | Per invocation and duration; scan fan-out is the heaviest |

Scans and renders dominate cost. Text calls are expected to be a small fraction until Spark pricing is confirmed.

## 2. Plans

| Limit | Free | Plus (~$4.99/mo suggested) |
|---|---|---|
| Avatar create / redo | 3 per 7 days | 10 per 7 days |
| Try-on renders | 20 / day (cached renders free) | 100 / day |
| Closet scans | 15 photos / day | 60 photos / day |
| Outfit requests | 10 / day | 50 / day |
| Get-dressed sessions | 3 / day | Unlimited |
| Lookbook saves | Unlimited | Unlimited |
| Priority rendering | No | Yes |
| Multiple avatars | No | Later |
| Trip mode | No | Yes |

- Each avatar redo replaces the current avatar, after a confirm warning.
- "Shuffle" through already-fetched looks is free. "More ideas" fetches new looks and counts as an outfit request.
- Limits reset on a rolling window. The UI shows remaining counts and when they refresh.
- Limits are enforced server-side, not in the client.

## 3. Why these limits (est. cost per active user per day)

Assumes ~$0.04 per scanned photo (including SAM fan-out), ~$0.01 per render, ~$0.01 per outfit request, ~$0.015 per get-dressed session. Spark text costs are placeholders.

| Scenario | Usage / day | Cost / day | Cost / month |
|---|---|---|---|
| Free, typical | 3 renders, 2 outfits, 1 scan photo (amortised), 0-1 get-dressed | ~$0.10 | ~$3 |
| Free, at every cap | 20 renders, 10 outfits, 15 scans, 3 get-dressed | ~$1.00 | not sustained; scans are mostly one-time onboarding |
| Plus, typical | 5 renders, 4 outfits, 0.5 scan photo, 1 get-dressed | ~$0.14 | ~$4 |
| Plus, at every cap | 100 renders, 50 outfits, 60 scans | ~$4+ | worst case, rare |

Reading the table:
- Caps bound the worst case, so one heavy user cannot erase the margin of many typical ones. The scan cap matters most because a scan is ~4x a render.
- Plus margin on a typical user is thin (roughly 20% before app store fees) at these assumptions. Levers: higher cache hit rate, scan cost per photo, Spark pricing, annual billing.
- Revisit all numbers once real usage and Meta pricing are known.

## 4. Cost controls already built

| Control | Effect |
|---|---|
| Render cache keyed by avatar version + items | Repeat try-ons cost nothing |
| Outfit cache, 30 min | Repeat outfit requests reuse results |
| Dress-code cache, 24 h | One lookup per occasion per day |
| Weather cache, 15 min | Fewer weather API calls |
| Local shuffle / pager | Browsing fetched looks makes no API calls |
| Rule-based fallback when AI is unavailable | Outfits still work, no model spend |
| Model failover chain | Outages degrade gracefully rather than fail |

## 5. Privacy as a product feature

- The selfie is never stored. Only the generated avatar is kept.
- The browser never calls Meta directly. All model calls go through the server.
- Users can delete their avatar.

## 6. Roadmap monetisation

| Idea | Model |
|---|---|
| Complete-the-look shopping | Affiliate revenue on suggested items that fill gaps in an outfit |
| Trip packing | Plus feature: multi-day, weather-aware packing lists |
| Wardrobe gap analysis | Plus feature that also feeds the shopping/affiliate funnel |

## 7. Hackathon note

During the demo, limits are shown in the UI but enforcement is lenient (demo user), so the flow is not interrupted. The enforcement path and server-side limits described above are the intended production behaviour.
