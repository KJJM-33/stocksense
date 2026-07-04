# Technical

Stack decisions and the reasoning behind them. This is a living doc — update it when a decision changes, don't just add a new one on top.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) + React, deployed as a PWA | Needs both static-fast pages (`/tap`) and server-side API routes (Twilio webhook, Anthropic vision calls that must keep the API key off the client). Next.js gives both in one deployable unit on Vercel. A plain Vite SPA would need a separate backend for the webhook/vision calls — unnecessary split for this scale. |
| Styling | Tailwind CSS | Fast to hit the "instant, no-frills utility" design target without a component library fighting the aesthetic. |
| Database | Supabase (Postgres) | Postgres gives proper relational integrity for the accounting-equation model (transactions as source of truth, items as derived state) plus built-in RLS for household-level isolation, Realtime for live dashboard updates, and Auth for the (optional) login path. One vendor instead of stitching Postgres + auth + realtime separately. |
| Messaging | Twilio (WhatsApp Business API + SMS) | Only mainstream provider with a usable WhatsApp Business API on a sandbox-first, low-volume basis. SMS as fallback for households without WhatsApp. |
| AI — vision & NL | Anthropic API, `claude-sonnet-4-6` | Used for: (1) initial fridge scan → structured JSON inventory, (2) receipt OCR/parsing → line items, (3) WhatsApp/SMS natural-language intent routing and replies. One model for all three keeps prompt patterns consistent and avoids juggling vendors. |
| Hosting | Vercel | Native Next.js deployment, generous free tier for this scale, trivial preview deployments for testing tag URLs before they're live. |
| PWA | `manifest.json` + service worker (Workbox via `next-pwa` or hand-rolled `sw.js`) | Installable home-screen icon and offline-capable inventory view without a native app build/store submission. |

## Data model

The system is built around **transactions as the source of truth**, not items. This is the accounting-equation principle:

```
Opening Stock + Purchases − Consumption = Current Stock
```

`items.quantity` and `items.status` are **derived**, not directly editable in the steady state. Every change — a tap, a receipt, a WhatsApp reply, the daily expiry sweep — writes a row to `transactions`. This gives:

- **Auditability**: "why does it think we're out of milk" has an answer (the transaction log).
- **Undoability**: a wrong update is a transaction to reverse, not a destructive overwrite.
- **Multiple writers, one ledger**: NFC tap, WhatsApp, receipt scan, and the dashboard can all write transactions concurrently without fighting over a single mutable row.

The only exception is the **initial stock scan**, which seeds `items` directly as opening stock (there's no prior transaction history to derive it from).

### Tables (see `supabase/schema.sql` for full DDL)

- `households` — top-level tenant. Everything else hangs off `household_id`.
- `members` — people in a household, linked to `auth.users` where logged in (NFC tap flow doesn't require a member to be resolved — it can log against the household directly).
- `items` — current derived state: name, category, quantity, unit, status (ok/low/out), expiry_date, inferred_expiry_days, last_updated, location.
- `transactions` — the ledger: type (purchase/consumption/adjustment/waste), item_id, quantity, source (nfc/receipt/photo/whatsapp/sms/manual), timestamp.
- `shopping_list` — item_id, quantity_needed, added_by, sent_to_whatsapp flag.

### RLS strategy

Every table carries `household_id` (directly or via `item_id` join). Policies restrict reads/writes to rows where `household_id` matches a household the authenticated user belongs to (via `members`). The `/tap` route is a deliberate, narrow exception: it operates without a logged-in user, so it uses a scoped service-role function (not a blanket service-role client) that can only insert a `transactions` row for a household resolved from the tag's URL parameter — it cannot read or write anything else.

## Why NFC tap has no login

The entire value proposition is "faster than not bothering." Any auth step kills that. The tap flow resolves the household from a fixed, pre-provisioned token embedded in the tag's URL path (not the household's UUID directly, to avoid leaking it) and writes one transaction. No session, no cookie dependency, no redirect. This is the single highest-priority engineering constraint in the whole system — every other feature can be slower.

## Passive consumption logic

A Supabase scheduled function (`pg_cron` + Edge Function, or a Vercel Cron hitting an API route) runs daily:

```sql
-- conceptual, see actual implementation in supabase/functions/
for each item where last_updated + inferred_expiry_days < now()
  and status != 'out'
  and not flagged consumed/restocked since:
    insert transaction (type='waste', source='system')
    update item.status = 'out'
```

`inferred_expiry_days` is set either by the vision model during initial scan (heuristics like milk=7, eggs=21, bread=5) or manually overridden per item. This is intentionally approximate — the goal is "mostly right without nagging," not perfect shelf-life tracking.

## Environment variables

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All Supabase client calls (client and server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client-side Supabase access (RLS-scoped) — `NEXT_PUBLIC_` prefix is required so the `/tap` flow can call it directly from the browser without a server round trip |
| `ANTHROPIC_API_KEY` | Server-side only — vision scan, receipt parsing, WhatsApp NL routing |
| `TWILIO_ACCOUNT_SID` | Server-side only — Twilio webhook + outbound messages |
| `TWILIO_AUTH_TOKEN` | Server-side only — Twilio webhook signature verification + outbound messages |
| `TWILIO_WHATSAPP_NUMBER` | Outbound WhatsApp send-from number |
| `NEXT_PUBLIC_APP_URL` | Client-exposed — used to build tag URLs, links in WhatsApp messages |
| `NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID` | Phase 1 only — the single household the `/tap` flow writes to. Set after running the one-time setup insert in `supabase/schema.sql`. Phase 2 (multi-household beta) replaces this with a per-tag token. |

`ANTHROPIC_API_KEY` and the Twilio credentials must never reach the client bundle — all calls that use them live in `app/api/**/route.ts` server routes, never in client components.

## Design system

- Background: `#0F1117` (near-black, not pure black — reduces OLED smear on fast taps)
- Status colours: OK `#4ADE80` (green), Low `#FBBF24` (amber), Out `#F87171` (red)
- Typography: bold, high-contrast, large tap targets — optimised for "glance while holding a basket," not for reading comfort
- No decorative elements on `/tap` — no logo, no hero copy, no onboarding tooltips. The input field is the first thing rendered.
