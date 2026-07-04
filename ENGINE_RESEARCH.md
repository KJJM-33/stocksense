# StockSense Intelligence Engine — Research Brief
Date: 2026-07-02

---

## 1a. UK Food Waste & Grocery Pain Points

### Scale and Cost
- **6.4 million tonnes** of household food waste per year in the UK (WRAP 2022, most recent full-year data)
- Households account for **70% of all UK food waste**
- **70% of household waste is edible** — not spoiled on arrival, wasted after purchase
- Average UK household wastes food worth **£470/year**; families of four waste **£700/year**
- This equates to roughly **1 in every 5 bags of shopping** being thrown away

### Top Wasted Categories (by volume)
| Rank | Category | Estimated Annual Waste | Key Driver |
|------|----------|----------------------|------------|
| 1 | Bread | 900,000 tonnes | Goes stale fast, bought in standard sizes larger than needed |
| 2 | Potatoes | 700,000 tonnes | Bought in large bags, spoil unevenly, poor fridge visibility |
| 3 | Milk | 490,000 tonnes | Expiry misread, open cartons forgotten |
| 4 | Bananas | 190,000 tonnes | Ripen faster than used |
| 5 | Left-overs / cooked meals | High | Not eaten next day, forgotten in fridge |
| 6 | Pork / Poultry | Significant | Short shelf life, over-bought on deals |
| 7 | Fresh produce (carrots, broccoli) | 21%+ waste rate | Over-bought, forgotten at bottom of fridge |

By **waste rate %**: potatoes (22.6%), bread (21.3%), broccoli (21%) — fresh produce dominates.

### Why Stock Drifts From Reality
1. **Poor fridge/cupboard visibility** — items at the back go unseen and expire
2. **Impulse over-buying on deals** — 3-for-2 promotions create excess that can't be consumed in time
3. **Inaccurate mental models** — people think they "have milk" when they don't, or vice versa
4. **Multiple shoppers with no coordination** — two people buy bread independently
5. **No expiry tracking** — people rely on memory rather than dates
6. **Infrequent checking** — opened items are mentally "still there" but gradually consumed

### UK Shopping Frequency
- Average UK household makes **slightly over 4 shopping trips per week** (2024 NielsenIQ data)
- Clear split: 1 **"big shop"** (weekly, £60–80+) + multiple **"top-up shops"** (2–4/week, ~£10–18 each)
- **71% of consumers** buy at least part of their groceries online (2024)
- Trend: shift to "little and often" driven by cost-consciousness and smaller store formats
- Basket sizes shrinking (avg £18.62 in smaller trips) but trip frequency up 7%

### Implications for Engine Design
- **Bread, produce (potatoes, carrots, broccoli), and dairy (milk)** need the tightest expiry defaults — highest waste rates
- **Produce** drifts fastest: high waste rate, inconsistent consumption, temperature-sensitive
- **Dairy** needs daily consumption tracking (milk consumed continuously, not in discrete events)
- Reconciliation should trigger at minimum **weekly** (matching "big shop" cadence) — but realistically needed every 2–3 days for perishables
- **Meat and fish** are high-value and high-risk: short shelf life + expensive = worst waste outcome per item
- The "forgotten at the back" problem means drift detection must flag items **unseen > 5 days** for high-perishability categories

---

## 1b. Inventory Accounting Principles Applied

### Core Equation
```
Opening Stock + Purchases − Consumption = Closing Stock
```
Every state change in the engine must trace back to this equation. `items.quantity` is always a derived result, never directly set (except initial seed).

### FIFO for Household Stock
FIFO (First In, First Out) means consuming from the oldest purchase batch first:
- When 12 eggs were bought on Monday and 6 more on Friday, and you use 3 eggs on Sunday — the 3 come from the Monday batch (oldest)
- This is nutritionally/safety-correct: older stock should be consumed first to minimise waste
- Practically implemented as a list of `PurchaseBatch` records sorted by purchase date ascending
- Each batch tracks: quantity purchased, remaining quantity, purchase date, expiry date
- Consumption deducts from batch[0] first; when exhausted, moves to batch[1], etc.
- A batch with `remainingQuantity = 0` is closed (archived, not deleted — for audit)

### Stock Reconciliation
- Reconciliation = confirming physical count vs ledger balance and calculating variance
- `Variance = Confirmed Physical Count − Ledger (Inferred) Quantity`
- Positive variance: more stock than expected (under-recorded consumption, or receipt counted twice → would give negative variance)
- Negative variance: less stock than expected (unrecorded consumption, waste, or theft)
- Reconciliation events update the consumption rate model if variance exceeds a threshold (>10%)
- Reconciliation confidence: high (photo/manual count), medium (WhatsApp check-in), low (tap status only)

### Consumption Rate Modelling
- **Exponential smoothing** (single, since no clear trend/seasonality at item level): `new_rate = α × new_data_point + (1 − α) × old_rate`
- Alpha = 0.3: weights recent data 30%, history 70% — stable but responsive
- Falls back to **category default** if < 3 data points
- Confidence score = `min(dataPointCount / 10, 1.0)` — reaches full confidence at 10 data points
- **Projected consumption** = `dailyRate × daysDelta` — used to infer current stock without a check-in
- Seasonal variation (scenario 18) captured by re-weighting: when season changes, lower alpha temporarily (more responsive) for ~2 weeks, then stabilise

### Variance Analysis
- **Expected consumption**: `projectedConsumption = dailyRate × days since last confirmation`
- **Actual consumption** (at reconciliation): `confirmedClosing − (confirmedOpening − projectedConsumption)`
- If actual consumption differs from expected by >20%: update rate, flag for review
- Variance categories:
  - **Consumption variance**: faster/slower than modelled rate
  - **Waste variance**: unplanned — item expired, was damaged, or discarded
  - **Error variance**: data entry mistake (scenario 5, 16) — negative feedback into confidence score

---

## 1c. 20 Household Scenarios

### Scenario 1: Weekly Big Shop Arrives (10+ items purchased at once from receipt)
- **Inputs**: Receipt scan → list of line items [{name, quantity, price, expiryDate?}]
- **Engine must**:
  1. Match each line item to existing items (fuzzy name match, see Scenario 9)
  2. For matched items: create a `PurchaseBatch` per line item, add to FIFO queue
  3. For unmatched items: create new item record + first batch
  4. Run drift check after all batches inserted (stock likely just went "ok" for many items)
  5. Check for duplicate receipt (idempotency key = receipt hash or timestamp+store)
- **Output**: N purchase transactions logged, N batches created, shopping list cleared for restocked items, confidence raised to "high" for all affected items

### Scenario 2: Partial Use of an Item (half a pack of butter used)
- **Inputs**: `consumption_log` via tap/WhatsApp — "used half the butter"
- **Engine must**:
  1. Parse quantity: "half" → 0.5 units (NL parsing upstream, engine receives normalised value)
  2. Apply `consumeQuantity(itemId, 0.5)` via FIFO tracker
  3. Update consumption rate with new data point
  4. Run drift check (may now be below threshold → trigger shopping list)
- **Output**: Consumption transaction logged, FIFO batch[0] decremented by 0.5, rate updated

### Scenario 3: Item Expires Untouched (yoghurt hits expiry date with no consumption logged)
- **Inputs**: Daily expiry sweep (system-triggered, `runExpirySweep()`)
- **Engine must**:
  1. For each batch where `expiryDate < now` and `remainingQuantity > 0`
  2. Create waste transaction for remaining quantity
  3. Mark batch as exhausted
  4. Update item status if all batches exhausted
  5. Log waste event for reporting
- **Output**: Waste transaction, item status → 'out', waste event in alert queue. Consumption rate NOT updated (waste ≠ consumption — tracked separately)

### Scenario 4: Item Used Faster Than Expected (milk gone in 3 days vs 7-day default)
- **Inputs**: Reconciliation or "Out" tap 3 days after purchase
- **Engine must**:
  1. Calculate actual consumption rate: 1 unit / 3 days = 0.33/day vs default 0.14/day
  2. Run `updateRate(itemId, 0.33)` — exponential smooth with existing rate
  3. With only 1 data point: confidence stays low, falls back to blend of new data and category default
  4. Flag item for shorter restock cycle on shopping list
- **Output**: Rate updated upward, shopping list trigger sooner next time, confidence score updated

### Scenario 5: Incorrect Log (marks eggs as "Out" when 6 left)
- **Inputs**: `tap_update` with status="out", then `manual_correction` with quantity=6
- **Engine must**:
  1. Log the "out" adjustment transaction (source: nfc)
  2. When correction arrives: `manual_correction` wins (highest precedence)
  3. Create adjustment transaction with confirmed quantity=6
  4. Log conflict with both inputs, mark resolved by correction
  5. Reduce confidence score for this item slightly (reflects data quality issue)
- **Output**: Item restored to quantity=6, conflict logged and auto-resolved, confidence slightly reduced

### Scenario 6: Race Condition — Two People Tap "Low" on Milk Simultaneously
- **Inputs**: Two `tap_update` inputs for same item within <1 second, both status="low"
- **Engine must**:
  1. Both transactions are written to the ledger (transactions are append-only)
  2. Both say "low" — they agree, so no conflict
  3. `apply_transaction` trigger runs for each; second one is idempotent (status already "low")
  4. If they disagreed (one "low", one "out"): raise conflict, apply most recent, log both
- **Output**: Two transactions logged, item status = "low", no conflict raised (they agreed). If disagreement: conflict raised, most-recent wins, both preserved

### Scenario 7: Bulk Purchase (24 toilet rolls)
- **Inputs**: `purchase` — 24 units, single batch
- **Engine must**:
  1. Create one `PurchaseBatch` with quantity=24, purchase date now
  2. Expiry: household paper goods → category default "never expires" (expiryDate = null)
  3. Item status → "ok" (well above threshold)
  4. Daily consumption rate for toilet rolls ≈ 0.14/day (1 roll/week) → at current rate, 24 rolls ≈ 171 days stock
  5. Shopping list: remove from list, set next-trigger-date = ~150 days out
- **Output**: Batch created, item stocked at 24 units, no expiry concern, shopping list updated with long restock horizon

### Scenario 8: Seasonal Item (Christmas stuffing mix — no consumption history)
- **Inputs**: `purchase` for item with no prior history, category="dry goods/seasonal"
- **Engine must**:
  1. No consumption rate history → use category default (dry goods: 0.1/day — very low)
  2. Confidence = 0 (0 data points) → explicitly marked as "no history"
  3. Expiry from packaging or category default (dried goods: 365 days)
  4. Do NOT project consumption without data — mark estimate basis as "default"
  5. Suggest reconciliation check after first use to seed rate data
- **Output**: Item created with category default rate, confidence=low, basis="default"

### Scenario 9: Receipt Item Name Doesn't Match Inventory ("Whole Milk 2L" vs "Milk")
- **Inputs**: Receipt line item "Whole Milk 2L Organic", system has item named "Milk"
- **Engine must**:
  1. Fuzzy match: normalise both → strip size, brand, descriptor → "milk" vs "milk" → match
  2. If match confidence > 0.8: auto-match, log the mapping for future use
  3. If match confidence 0.5–0.8: raise a `conflict` of type "name_match" → queue for user confirmation
  4. If match confidence < 0.5: create new item, flag for review
  5. Store canonical name in item, store alias in a name_aliases field
- **Output**: Purchase attributed to correct existing item "Milk", alias recorded

### Scenario 10: Perishable Bought Then Frozen (chicken breast — freezing extends shelf life)
- **Inputs**: `purchase` for chicken (expiry 3 days), then `status_change` type="frozen"
- **Engine must**:
  1. Purchase creates batch with expiry = purchase_date + 3 days
  2. Freeze event received: update batch expiry = freeze_date + freezer_default (90 days for chicken)
  3. Move item location from "fridge" to "freezer"
  4. Adjust consumption rate model: frozen items consumed less frequently → use frozen category rate
- **Output**: Batch expiry extended by 90 days, location updated, alert cleared, rate model switched to frozen mode

### Scenario 11: Leftovers Extending Shelf Life (cooked rice — "eat within 3 days")
- **Inputs**: `status_change` type="cooked" or `manual_correction` with new expiry override
- **Engine must**:
  1. Cooked rice is a new item or transformation of "Rice" (different item — record as new)
  2. Engine receives: item_id for "Cooked Rice", quantity=2 portions, manual_expiry=now+3days
  3. Manual expiry override takes highest priority
  4. Expiry engine stores manual_expiry_override, skips category default
  5. Runs expiry sweep normally against the override date
- **Output**: New item "Cooked Rice" with 3-day manual expiry, linked to original rice item if provided

### Scenario 12: Item Returned to Shop (milk spoiled on arrival)
- **Inputs**: `status_change` type="returned" with quantity
- **Engine must**:
  1. Create transaction type="adjustment" (not waste — the loss is borne by the retailer)
  2. Quantity decremented from FIFO batch for that purchase
  3. Mark batch as partially/fully returned — different from waste or consumption
  4. Do NOT update consumption rate (return is not a consumption data point)
  5. Shopping list: add item back if now below threshold
- **Output**: Adjustment transaction, batch quantity reduced, rate unchanged, shopping list updated

### Scenario 13: Item Gifted (bottle of wine brought home — not a purchase)
- **Inputs**: `status_change` type="gift_received", item_name, quantity
- **Engine must**:
  1. Treat as a purchase (increases stock) but source="gift"
  2. Create PurchaseBatch with source="gift" — distinguishes from shop purchase for analytics
  3. Price = null (no cost — not counted in household spend)
  4. Expiry: use category default or user override
  5. FIFO queue: add normally (gift received today, consume before older stock if that's what FIFO dictates)
- **Output**: Gift transaction logged, stock increased, no spend impact

### Scenario 14: Long Holiday (2 weeks, nothing logged)
- **Inputs**: No inputs for 14 days, then user returns and taps
- **Engine must**:
  1. During the 14 days: daily expiry sweep runs, marks perishables as likely wasted
  2. Confidence decays: items move from medium to low confidence after 7 days, to "stale" after 14
  3. On return: `check_in` or photo reconciliation expected — engine prompts via alert
  4. Projected consumption model still runs but confidence is flagged as "stale"
  5. All perishables that hit expiry during absence are waste-transacted automatically
  6. User should be prompted to do a full reconciliation scan on return
- **Output**: Multiple waste transactions logged during absence, confidence degraded across board, reconciliation prompt on next interaction

### Scenario 15: Fridge Photo Contradicts Stock Record (2 items not in system, 1 missing item system thinks is there)
- **Inputs**: `photo_reconciliation` with item snapshots [{name, quantity, location}]
- **Engine must**:
  1. For each item in photo: match against current ledger
  2. Items in photo but not in system: create new items (source="photo_scan")
  3. Items in system but not in photo: raise conflict — system says present, photo says absent
  4. For the "missing" item: photo is ground truth (higher precedence than inferred state)
  5. Apply corrections via `triggerReconciliation()`, update confidence to "high" for all photo-confirmed items
  6. Log the variance for each item in the `ReconciliationEvent`
- **Output**: 2 new items created, 1 item corrected to quantity=0 (waste transaction), confidence elevated for photo-confirmed items

### Scenario 16: Receipt Scanned Twice (same Tesco receipt processed twice)
- **Inputs**: Two `purchase` inputs with same idempotency_key (receipt hash)
- **Engine must**:
  1. Check `idempotency_key` against processed receipts log
  2. If key already seen: reject second processing, return `duplicate_detected` output
  3. Do NOT create any transactions from the duplicate
  4. Log the duplicate attempt for audit purposes
- **Output**: First scan processed normally; second scan returns duplicate_detected, no state change

### Scenario 17: Partial Consumption Then Restocked Before Running Out (eggs: 3 left, new 12-pack bought)
- **Inputs**: Ongoing consumption transactions showing 3 eggs remaining, then purchase of 12
- **Engine must**:
  1. FIFO queue: existing 3-egg batch (batch A, older) + new 12-egg batch (batch B)
  2. Total stock = 15 eggs
  3. Future consumption will draw from batch A (3 remaining) before batch B (12)
  4. Expiry: batch A expires sooner — expiry sweep monitors it first
  5. Shopping list: removed (15 eggs well above threshold)
- **Output**: Two active batches in FIFO queue, total stock = 15, expiry tracking on oldest batch

### Scenario 18: Consumption Rate Changes Over Time (summer: more salad; winter: more soup)
- **Inputs**: Ongoing consumption transactions over months showing seasonal pattern
- **Engine must**:
  1. Exponential smoothing with α=0.3 naturally adapts over time — no special seasonal logic needed
  2. As summer transactions arrive (salad up, soup down), rates update via normal smoothing
  3. If rate changes by >50% in 14 days: flag as "rapid rate change" — could be seasonal or error
  4. Confidence score drops slightly when rapid change detected (uncertainty increases)
  5. After 10 data points at new rate, confidence restores to high
- **Output**: Rate adapts automatically, rapid-change flag raised for review if shift is large

### Scenario 19: Item Marked Out But Found at Back of Cupboard
- **Inputs**: Item status="out" (from prior tap), then `manual_correction` with found quantity
- **Engine must**:
  1. `manual_correction` has highest precedence — overrides any prior state
  2. Create adjustment transaction: quantity = found amount, source="manual", note="found in cupboard"
  3. If prior "out" transaction was an NFC tap: raise informational conflict (not blocking)
  4. Update confidence: manual corrections after "out" state reduce confidence score slightly
  5. Remove from shopping list if it had been added
- **Output**: Item restored with found quantity, shopping list updated, conflict logged as "found_after_out"

### Scenario 20: New Item Type Never Seen Before, No Category Match
- **Inputs**: Purchase or tap with item name that doesn't match any known category
- **Engine must**:
  1. Create item with category="uncategorised"
  2. Use most conservative category defaults (expiry: 14 days, rate: 0.1/day) to avoid silent waste
  3. Confidence = "low" explicitly because no category model available
  4. Flag item for user to assign a category manually
  5. Once user assigns category, backfill defaults and re-estimate
- **Output**: Item created with conservative defaults, categorisation alert raised, user prompted to classify

---

## Key Design Decisions Derived from Research

1. **Tight expiry defaults for top-waste categories**: bread (3–5 days), potatoes (14 days), milk (7 days), fresh produce (5–7 days), meat/fish (2–3 days)
2. **Produce and dairy need the highest drift-check frequency** — these categories waste the most by volume
3. **Reconciliation cadence**: weekly minimum (matching UK shopping frequency), 2–3 days for perishable categories
4. **Exponential smoothing α=0.3** balances stability with adaptability — right for irregular household consumption
5. **FIFO is both accounting-correct and waste-minimising** — oldest stock consumed first reduces expiry waste
6. **Manual corrections always win** — user ground truth beats any inferred state
7. **Photo reconciliation is the highest-confidence automated input** — beats tap, beats WhatsApp
8. **Idempotency on all structured inputs** (receipts, photo scans) — duplicate prevention is critical
