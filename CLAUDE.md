@AGENTS.md

# StockSense

Household stock intelligence layer (Next.js App Router PWA, port 3102). Core model is the
accounting equation: Opening Stock + Purchases − Consumption = Current Stock. Interface is
decoupled from the engine — NFC tap, WhatsApp/SMS, web dashboard, and camera scan are all
equivalent entry points into the same transaction ledger. See `README.md` (product vision +
NFC tag setup), `TECHNICAL.md` (stack decisions, data model, RLS strategy), `ROADMAP.md`
(personal use → beta → product phases), `FEATURES.md` (implemented vs planned).

## Status (2026-06-29)

Phase 1, build order step 1-2 done: Supabase schema (`supabase/schema.sql`) and the `/tap` +
`/tap/[location]` NFC flow are live and tested (sub-50ms static page load, status-selector
flow verified with Playwright). Everything else in `FEATURES.md` is still ⬜.

## Run

```bash
cd ~/Claude/stocksense && npm run dev   # http://localhost:3102
```

Needs `.env.local` (copy from `.env.example`) — Supabase URL/anon key and
`NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID` at minimum to use `/tap`. Apply `supabase/schema.sql` in
the Supabase SQL editor first, then run the one-time household insert at the bottom of that
file to get the household id.

## Key design decision: `/tap` calls Supabase directly, no API route

The tap flow (`app/tap/TapClient.tsx`) calls `supabase.rpc('record_tap', ...)` straight from
the browser with the anon key — no Next.js API route in between. That's one fewer network hop
on the critical path, since the whole point of `/tap` is sub-5-second usability standing in
front of the fridge. `record_tap` is a `SECURITY DEFINER` Postgres function that validates the
household/status/location and only ever inserts one transaction — it's the one deliberate,
narrow exception to the otherwise-strict RLS (see TECHNICAL.md "Why NFC tap has no login").

## Next up (build order steps 3-8, see ROADMAP.md Phase 1)

Initial stock scan (camera → Claude vision → confirm) is next, then the WhatsApp/SMS layer,
then receipt scanning, then the inventory dashboard, then passive consumption + expiry alerts.
