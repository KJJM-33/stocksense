# Features

Tracks what's actually built vs planned. Update this whenever a feature moves status — this file should always reflect reality, not intent. Cross-check against [ROADMAP.md](ROADMAP.md) for phase context.

## Status key

- ✅ Implemented and working
- 🚧 In progress
- ⬜ Planned, not started

## Core data layer

| Feature | Status | Notes |
|---|---|---|
| Supabase schema (`households`, `members`, `items`, `transactions`, `shopping_list`) | ✅ | `supabase/schema.sql` |
| RLS policies — household-level isolation | ✅ | Standard policies on all tables; `/tap` uses a scoped insert function instead of blanket service-role access |
| Derived `items.status` from transaction ledger | ✅ | Computed via trigger/function on transaction insert |

## NFC tap flow

| Feature | Status | Notes |
|---|---|---|
| `/tap` route — no login, search/voice input | ✅ | |
| Quick-select buttons for top 8 household items | ✅ | Seeded list, editable later |
| Status selector (Low / Out / Used some) | ✅ | |
| One-tap submit → transaction write | ✅ | |
| `/tap/[location]` (fridge/freezer/cupboard) | ✅ | |
| Sub-5-second load on mobile | ✅ | No client-side data fetch blocking first paint; household resolved async |

## Initial stock scan

| Feature | Status | Notes |
|---|---|---|
| Camera capture interface | ⬜ | |
| Anthropic vision call → structured JSON (name, quantity, unit, category, inferred_expiry_days) | ⬜ | |
| Confirmation screen before save | ⬜ | |
| Seeds opening stock in `items` | ⬜ | |

## WhatsApp / SMS intelligence layer

| Feature | Status | Notes |
|---|---|---|
| Twilio webhook handler | ⬜ | |
| Receipt photo → parse → update stock → confirm | ⬜ | |
| NL question ("do we have eggs?") → query → reply | ⬜ | |
| NL update ("used the last of the milk") → transaction → confirm | ⬜ | |
| Sunday weekly check-in (low-stock list → reply → auto-update) | ⬜ | Needs a scheduled trigger (Vercel Cron / Supabase pg_cron) |

## Receipt scanning

| Feature | Status | Notes |
|---|---|---|
| Camera/upload flow | ⬜ | |
| Anthropic API line-item extraction | ⬜ | |
| Fuzzy-match against known items + UK supermarket naming | ⬜ | |
| Unrecognised item flagging for manual categorisation | ⬜ | |
| Confirmation screen before commit | ⬜ | |

## Inventory dashboard

| Feature | Status | Notes |
|---|---|---|
| Grouped by location (fridge/freezer/cupboard) | ⬜ | |
| Traffic-light status | ⬜ | |
| Expiry warnings highlighted | ⬜ | |
| Auto-generated shopping list from Low/Out | ✅ | Dashboard shopping list section (`app/dashboard/page.tsx`) — Out/Low items grouped by location |
| One-tap send shopping list to WhatsApp | ✅ | `wa.me` deep-link share button on the shopping list section |
| Prominent search bar | ⬜ | |

## Passive logic & alerts

| Feature | Status | Notes |
|---|---|---|
| Daily expiry sweep (auto-mark Out + waste transaction) | ✅ | `expire_stale_items()` in `supabase/schema.sql`, scheduled daily 03:00 via pg_cron (enabled 2026-09-24) |
| Expiry alerts (push + WhatsApp, grouped) | 🚧 | In-app only: dashboard Expiring Soon section (≤3 days, grouped by location) + WhatsApp copy-list link. No push or automatic WhatsApp alert yet |

## PWA

| Feature | Status | Notes |
|---|---|---|
| `manifest.json` | ✅ | |
| Service worker — offline inventory view | ✅ | `public/sw.js` — network-first with cache fallback; precaches `/`, `/tap`, `/dashboard` |
| iOS/Android installable | ✅ | Manifest + icons in place; verify install prompt once dashboard exists |
