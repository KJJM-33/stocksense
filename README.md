# StockSense

A household stock intelligence layer. It answers one question — **what do we have, and what's running low** — without ever requiring you to open an app.

## Product vision

Every household stock system fails for the same reason: the interface demands more effort than the value it returns. Apps get installed, used twice, and abandoned because checking stock means opening an app, finding the item, updating a quantity. StockSense inverts this: the *engine* (the accounting equation below) is decoupled from the *interface*. You interact through whichever channel is already in your hand at the moment you need it — a tap on the fridge door, a WhatsApp message, a text, a glance at a dashboard mid-shop.

**Core model — the accounting equation:**

```
Opening Stock + Purchases − Consumption = Current Stock
```

Every change to stock is a `transaction` (purchase, consumption, adjustment, or waste). Current stock is never edited directly — it's always derived from the transaction ledger. This means the system is auditable, undoable, and trustworthy in the way double-entry bookkeeping is trustworthy: you can always answer "why does it think we're out of milk?"

### The interfaces (all optional, all equivalent)

| Interface | Use case |
|---|---|
| **NFC tap** | Stuck on fridge/freezer/cupboard door. Tap with phone → log "low" or "out" in one motion, no login. |
| **WhatsApp / SMS** | Photo of a receipt, a quick "do we have eggs?", a reply to the Sunday check-in. |
| **Web dashboard** | Full inventory view, shopping list, search — for when you actually want to look at everything. |
| **Camera scan** | Point at the fridge, get structured inventory back. Point at a receipt, get stock updated. |

No interface is "the app." The web dashboard is just one more way in, not the primary one. The NFC tap is the most-used surface and is held to the highest standard for speed.

### Why this works for a household (not a business)

Commercial inventory tools assume someone's job is to maintain the system. A household has zero tolerance for that. StockSense's bet is that **passive inference** (expiry-based auto-depletion, photo-based scanning, receipt parsing) does 80% of the bookkeeping, and the remaining 20% is collapsed into the lowest-friction interaction available: a tap on a tag that's already on the door you're standing in front of.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Interfaces                           │
│  /tap (NFC)   WhatsApp/SMS (Twilio)   Web dashboard   Camera │
└───────────────┬───────────────┬───────────────┬─────────────┘
                │               │               │
                ▼               ▼               ▼
        ┌───────────────────────────────────────────┐
        │         Next.js app (Vercel)               │
        │  - App Router pages (PWA)                  │
        │  - API routes (Twilio webhook, vision)     │
        └───────────────┬─────────────────┬──────────┘
                         │                 │
                         ▼                 ▼
              ┌────────────────┐   ┌──────────────────┐
              │   Supabase     │   │  Anthropic API    │
              │ Postgres + RLS │   │ claude-sonnet-4-6  │
              │ Realtime + Auth│   │ vision + NL        │
              └────────────────┘   └──────────────────┘
```

**Data flow for every interface is the same:** interaction → resolve household + item(s) → write a `transactions` row → derived views recompute `items.status`. The interfaces never write to `items` directly except for the initial stock scan (which seeds opening stock).

See [TECHNICAL.md](TECHNICAL.md) for stack decisions, [ROADMAP.md](ROADMAP.md) for build phases, and [FEATURES.md](FEATURES.md) for what's actually shipped vs planned.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Anthropic + Twilio keys
npm run dev   # http://localhost:3102
```

Apply the schema in `supabase/schema.sql` to a new Supabase project (SQL editor → paste → run) before starting the app.

## Programming your NFC tags

You need blank NTAG213/215/216 stickers (cheap, widely available) and the **NFC Tools** app (free, iOS and Android).

1. Install **NFC Tools** from the App Store / Play Store.
2. Open the app → **Write** tab → **Add a record** → **URL/URI**.
3. Enter the URL for the tag you're programming (see table below), replacing `[APP_URL]` with your deployed app URL (e.g. `https://stocksense.vercel.app`).
4. Tap **Write** and hold your phone against the NFC sticker until it confirms.
5. Stick the tag on the relevant door.

| Tag | URL to write |
|---|---|
| Fridge | `[APP_URL]/tap/fridge` |
| Freezer | `[APP_URL]/tap/freezer` |
| Cupboard | `[APP_URL]/tap/cupboard` |

Tap any tag with an NFC-enabled phone (iPhone XS+ or any modern Android) — no app needed to *read* the tag, it opens straight in the browser. The `/tap` page (no location) is a generic fallback if you only have one tag.

**Test before sticking it down:** tap the tag once after writing, confirm it opens `/tap/fridge` (or the relevant route) in under 5 seconds on mobile data, then commit it to the door.
