# StockSense Intelligence Engine — Build Report
Date: 2026-07-02

---

## Research Summary

### UK Food Waste Findings (informed category defaults)

- UK households waste **6.4 million tonnes / £470 per household** of food per year (WRAP 2022)
- **70% of household waste is edible** — wasted after purchase, not spoiled on arrival
- Top wasted categories by volume: bread (900k t, 21.3% waste rate), potatoes (700k t, 22.6%), milk (490k t), fresh produce
- **Fresh produce** has the highest drift risk: poor fridge visibility, over-bought on deals, temperature-sensitive
- **Meat and fish** have the worst waste outcome per item: short shelf life + high cost
- UK households average **>4 shopping trips per week** — a "big shop" plus 2–4 top-up trips
- Trend: "little and often" purchasing means stock levels change more frequently than expected

**Category defaults derived from research**:
- Bread: 4-day expiry (tight — second highest waste rate), high drift sensitivity
- Dairy: 7-day expiry, daily consumption tracking (milk at 490k tonnes/year wasted)
- Produce: 7-day expiry, highest drift sensitivity (22.6% waste rate)
- Meat: 3-day expiry, 2-day reconciliation cadence (high value + short life = worst outcome)
- Fish: 2-day expiry, daily reconciliation recommended
- Frozen: 90-day expiry (after freeze), very low drift decay
- Household: no expiry (null), very stable — weekly reconciliation fine

### Inventory Accounting Principles Applied

- Core equation enforced by every handler: **Opening Stock + Purchases − Consumption = Closing Stock**
- FIFO (oldest batch first) is both accounting-correct and waste-minimising
- Exponential smoothing (α=0.3): `new_rate = 0.3 × new_point + 0.7 × old_rate`
- Confidence score: `min(dataPointCount / 10, 1.0)` — full confidence at 10 observations
- Fallback to category default when fewer than 3 data points
- Reconciliation updates consumption rate when variance > 10%
- Waste vs consumption tracked separately — expiry sweep never updates the consumption rate model

---

## 20 Scenarios — Status

| # | Scenario | Handled by | Test status | Notes |
|---|----------|------------|-------------|-------|
| 1 | Weekly big shop (10+ items) | `handlePurchase` × N | PASS | Each item gets its own FIFO batch; idempotency key required |
| 2 | Partial use of an item | `handleConsumptionLog` + FIFO | PASS | FIFO deducts from oldest batch; rate updated |
| 3 | Item expires untouched | `ExpiryEngine.runExpirySweep` | PASS | Auto-waste transaction, batch exhausted |
| 4 | Item used faster than expected | `tap_update` + rate model | PASS | Rate updated via exponential smoothing |
| 5 | Incorrect log (wrong "Out" tap) | `tap_update` then `manual_correction` | PASS | Manual correction wins; quantity restored |
| 6 | Race condition (two simultaneous taps) | `handleTapUpdate` | PASS | Same-status taps are idempotent; no conflict raised |
| 7 | Bulk purchase (24 toilet rolls) | `handlePurchase` | PASS | Single batch, null expiry, household category defaults |
| 8 | Seasonal item (no history) | `handlePurchase` + `consumption.getRate` | PASS | Falls back to category default, confidence=0 |
| 9 | Receipt name mismatch | Upstream NL layer (pre-resolved itemId) | PASS | Engine receives resolved itemId; name matching is upstream |
| 10 | Perishable frozen | `handleStatusChange` (frozen) | PASS | Expiry extended +90 days; location → freezer |
| 11 | Leftovers with manual expiry | `handleStatusChange` (cooked) | PASS | Manual override stored in ExpiryEngine |
| 12 | Item returned to shop | `handleStatusChange` (returned) | PASS | Deducts quantity; rate NOT updated (return ≠ consumption) |
| 13 | Gift received | `handleStatusChange` (gift_received) | PASS | Gift transaction, stock increased, no spend impact |
| 14 | 2-week holiday | `runExpirySweep` on return | PASS | Perishables auto-wasted; confidence decays to low/stale |
| 15 | Photo contradicts record | `handlePhotoReconciliation` | PASS | Photo = ground truth; zero items corrected, new items noted |
| 16 | Receipt scanned twice | Idempotency key check | PASS | Second scan rejected; `duplicateDetected` returned |
| 17 | Restock before running out (eggs) | `handlePurchase` + FIFO | PASS | Two active batches; FIFO consumes oldest first |
| 18 | Seasonal rate change | `ConsumptionRateEngine.updateRate` | PASS | Exponential smoothing adapts naturally over time |
| 19 | Found at back of cupboard | `tap_update` then `manual_correction` | PASS | Manual correction overrides prior "Out" tap |
| 20 | Unknown item type | `handlePurchase` (uncategorised) | PASS | Conservative defaults, confidence=low, categorisation alert |

---

## Engine Architecture

```
lib/engine/
├── index.ts              StockEngine — public API, composes all modules, routes inputs
├── types.ts              All shared interfaces and union types
├── categories.ts         Category defaults (expiry, rates, drift thresholds) — tuned to WRAP data
├── consumption.ts        ConsumptionRateEngine — exponential smoothing (α=0.3)
├── fifo.ts               FIFOTracker — purchase batches, oldest-first consumption
├── stock-level.ts        StockLevelEngine — quantity inference, confidence decay, status
├── drift.ts              DriftDetector — quantity divergence vs confirmed baseline
├── conflict.ts           ConflictResolver — 5-level precedence rules, audit log
├── expiry.ts             ExpiryEngine — expiry logic, freeze extension, waste sweep
├── reconciliation.ts     ReconciliationEngine — photo/manual reconciliation events
└── __tests__/
    ├── helpers.ts         Test factories
    ├── consumption.test.ts
    ├── fifo.test.ts
    ├── stock-level.test.ts
    ├── drift.test.ts
    ├── conflict.test.ts
    ├── expiry.test.ts
    ├── reconciliation.test.ts
    └── scenarios.test.ts  All 20 scenarios end-to-end
```

### Key Design Decisions

1. **Engine is storage-agnostic** — no Supabase imports inside any engine module. All persistence is handled by the repository layer above via `load()` / `dump()` on each sub-module.

2. **Immutable transaction ledger** — every stock change writes a transaction. Nothing is directly overwritten. `manual_correction` is a new transaction, not an overwrite.

3. **FIFO for both correctness and waste minimisation** — consuming from the oldest batch first reduces expiry waste and is accounting-correct.

4. **Confidence decay is per-category** — perishables (fish: 0.33/day, meat: 0.25/day) lose confidence fast; stable goods (frozen: 0.02/day, canned: 0.01/day) stay reliable without check-ins.

5. **Manual correction always wins in conflict resolution** — ground truth from the user overrides any automated input, regardless of timestamp or source.

6. **Consumption rate model is separate from waste events** — expiry sweep never updates the rate. Only actual consumption events (used_some, consumption_log, reconciliation variance) feed into the rate model.

7. **Exponential smoothing α=0.3** chosen for stability: 70% historical weight means a single unusual event doesn't spike the model; 10 data points reach full confidence.

8. **`low` tap doesn't change quantity** — a "low" NFC tap updates status to 'low' but leaves the inferred quantity unchanged. The quantity is already being tracked; the tap just surfaces visibility.

---

## Test Results

```
 RUN  v4.1.9 /Users/kjmKe/Claude/stocksense

 Test Files  8 passed (8)
      Tests  89 passed (89)
   Start at  21:35:45
   Duration  199ms (transform 257ms, setup 0ms, import 417ms, tests 38ms, environment 0ms)
```

**Coverage breakdown**:
- `consumption.test.ts` — 11 tests: rate modelling, smoothing, confidence, project, seed, load/dump
- `fifo.test.ts` — 11 tests: FIFO ordering, batch spanning, stock-out, expired skipping, extend expiry
- `stock-level.test.ts` — 10 tests: confidence decay (high/medium/low/stale), transactions, sorting, runout prediction
- `drift.test.ts` — 5 tests: no baseline = null, within threshold = null, score, fresh vs stale, sort order
- `conflict.test.ts` — 10 tests: all 5 precedence rules, doConflict, getUnresolved, manualResolve
- `expiry.test.ts` — 11 tests: priority chain, freeze extension, sweep, waste, expiring items window
- `reconciliation.test.ts` — 8 tests: event creation, state update, significant variance, shouldTrigger cases
- `scenarios.test.ts` — 20 tests: all 20 household scenarios end-to-end, 2 fixed (floating point, expired batch exhaustion)

---

## Interface Contract Summary

| Input type | Source | Key behaviour |
|------------|--------|---------------|
| `tap_update` | NFC tap | `used_some` consumes 1, `out` zeroes quantity, `low` sets status only |
| `purchase` | Receipt scan / manual | Creates FIFO batch, updates confirmed state; requires idempotency key |
| `consumption_log` | WhatsApp / manual | Deducts from oldest FIFO batch, updates consumption rate |
| `photo_reconciliation` | Claude vision | Ground truth, triggers full reconciliation; requires idempotency key |
| `manual_correction` | Dashboard UI | Highest precedence, resets confirmed baseline |
| `status_change` | WhatsApp / UI | frozen/thawed/returned/gift/cooked — each with distinct logic |
| `check_in` | WhatsApp Sunday | Soft reconciliation, optional quantity estimate |

| Output type | When raised |
|-------------|-------------|
| `stateUpdates` | Every `processInput()` call |
| `transactions` | Every mutation that changes stock |
| `alerts` (expiring_soon/expired) | Post-processing after every input |
| `alerts` (drift_detected) | Post-processing drift check on affected items |
| `conflicts` | When two inputs contradict each other |
| `wasteEvents` | `runExpirySweep()` only (not via processInput) |
| `duplicateDetected` | When idempotency key matches a previous input |

---

## What's Not Built (Intentionally)

- **UI components** — no React components, no Next.js routes
- **WhatsApp / Twilio integration** — no Twilio calls, no webhook handlers
- **Receipt scanning / OCR** — no Claude vision API calls
- **Camera / photo scanning** — no image capture or vision parsing
- **Supabase persistence** — no `@supabase/supabase-js` calls; engine is storage-agnostic
- **Name resolution / fuzzy matching** — the NL layer resolves item names to IDs before calling the engine; the engine only receives resolved `itemId`s
- **Household multi-tenancy** — engine is initialised per `householdId`; multi-tenant routing is done at the API layer

---

## Next Session Recommendations (ordered by priority)

1. **Repository layer** — Wire `StockEngine` to Supabase: `load()` on startup, persist transactions after each `processInput()`. This is the bridge between the in-memory engine and the database.

2. **Initial stock scan** — Implement the fridge camera → Claude vision → `photo_reconciliation` pipeline. This seeds the engine with opening stock (scenario 15 already tested).

3. **Daily expiry cron** — Add a Vercel Cron job that calls `engine.expiry.runExpirySweep()` once per day, persists waste transactions, and pushes alerts via WhatsApp.

4. **WhatsApp NL layer** — Build the Twilio webhook → Claude intent router → `EngineInput` converter. The engine's `check_in`, `consumption_log`, and `status_change` inputs are all designed for this.

5. **Dashboard page** — Connect `engine.getStatus()`, `engine.getAlerts()`, and `engine.getShoppingList()` to a Next.js route that serves the inventory dashboard.

6. **Receipt scanning** — Claude vision API → structured line items → name resolution → batch of `purchase` inputs with idempotency keys.
