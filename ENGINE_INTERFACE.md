# StockSense Intelligence Engine — Interface Contract
Date: 2026-07-02

This document is the integration guide for every system that touches the engine.
Read this before writing any WhatsApp handler, NFC tap processor, receipt scanner,
photo scanner, or dashboard component.

---

## Architecture

```
[NFC Tap]  [WhatsApp]  [Receipt Scan]  [Photo Scan]  [Manual]  [System Cron]
     │           │             │              │            │           │
     └───────────┴─────────────┴──────────────┴────────────┴───────────┘
                                     │
                            EngineInput (union type)
                                     │
                           StockEngine.processInput()
                                     │
                            EngineOutput (always)
                                     │
                    ┌────────────────┼──────────────────┐
             stateUpdates      transactions         alerts / conflicts
                    │                │                   │
             Repository Layer  Supabase write      Alert queue
             (Supabase update)
```

The engine is **storage-agnostic**. It works in plain TypeScript with in-memory state.
The repository layer above it handles Supabase reads/writes. The engine never imports
`@supabase/supabase-js`.

---

## All Input Types

### 1. `tap_update` — NFC tap → status change

**Handler**: `handleTapUpdate` in `StockEngine`
**Source**: The `/tap` NFC flow in `app/tap/`

```typescript
interface TapUpdateInput {
  type: 'tap_update';
  itemId: string;           // must already exist in the engine
  householdId: string;
  status: 'low' | 'out' | 'used_some';
  location?: string;        // 'fridge' | 'freezer' | 'cupboard'
  timestamp: Date;
  source: 'tap';
}
```

**Example**:
```json
{
  "type": "tap_update",
  "itemId": "550e8400-e29b-41d4-a716-446655440000",
  "householdId": "hh-abc123",
  "status": "used_some",
  "location": "fridge",
  "timestamp": "2026-07-02T08:30:00.000Z",
  "source": "tap"
}
```

**Behaviour**:
- `used_some` → consumption of 1 unit, consumption rate updated
- `out` → quantity set to 0 (correction transaction)
- `low` → status set to 'low', quantity unchanged, audit transaction logged

---

### 2. `purchase` — Receipt scan → new stock

**Handler**: `handlePurchase` in `StockEngine`
**Source**: Receipt OCR pipeline (Claude vision → structured JSON → engine)

```typescript
interface PurchaseInput {
  type: 'purchase';
  itemId: string;
  householdId: string;
  quantity: number;
  expiryDate?: Date;        // from receipt barcode/date print
  source: InputSource;      // usually 'receipt', could be 'manual'
  timestamp: Date;
  idempotencyKey?: string;  // REQUIRED for receipts: hash of receipt content
  notes?: string;
}
```

**Example**:
```json
{
  "type": "purchase",
  "itemId": "item-milk-123",
  "householdId": "hh-abc123",
  "quantity": 2,
  "expiryDate": "2026-07-09T00:00:00.000Z",
  "source": "receipt",
  "timestamp": "2026-07-02T10:15:00.000Z",
  "idempotencyKey": "sha256-of-receipt-content",
  "notes": "Tesco - Whole Milk 2L"
}
```

**Behaviour**:
- Creates a FIFO batch
- Updates item quantity and confirms it
- Expiry alert raised if batch expires within 3 days of purchase

---

### 3. `consumption_log` — Manual / NL / WhatsApp → consumed quantity

**Handler**: `handleConsumptionLog` in `StockEngine`
**Source**: WhatsApp NL parsing, manual UI input

```typescript
interface ConsumptionLogInput {
  type: 'consumption_log';
  itemId: string;
  householdId: string;
  quantity: number;         // pre-parsed by NL layer (e.g. "half" → 0.5)
  timestamp: Date;
  source: InputSource;      // 'whatsapp' | 'manual'
  notes?: string;
}
```

**Example**:
```json
{
  "type": "consumption_log",
  "itemId": "item-butter-456",
  "householdId": "hh-abc123",
  "quantity": 0.5,
  "timestamp": "2026-07-02T13:00:00.000Z",
  "source": "whatsapp",
  "notes": "used half the butter for cooking"
}
```

**Behaviour**:
- Deducts from oldest FIFO batch first
- Updates consumption rate model
- Raises `out_of_stock` alert if quantity reaches 0

---

### 4. `photo_reconciliation` — Fridge photo → ground truth snapshot

**Handler**: `handlePhotoReconciliation` in `StockEngine`
**Source**: Claude vision API → structured item list

```typescript
interface PhotoReconciliationInput {
  type: 'photo_reconciliation';
  householdId: string;
  items: Array<{
    itemId: string;
    confirmedQuantity: number;
  }>;
  timestamp: Date;
  idempotencyKey?: string;  // REQUIRED: hash of photo metadata to prevent reprocessing
}
```

**Example**:
```json
{
  "type": "photo_reconciliation",
  "householdId": "hh-abc123",
  "items": [
    { "itemId": "item-milk-123", "confirmedQuantity": 1 },
    { "itemId": "item-eggs-789", "confirmedQuantity": 6 },
    { "itemId": "item-butter-456", "confirmedQuantity": 0 }
  ],
  "timestamp": "2026-07-02T18:00:00.000Z",
  "idempotencyKey": "photo-sha256-abc"
}
```

**Behaviour**:
- Highest-confidence automated input (beats tap, beats WhatsApp)
- Triggers a full reconciliation event
- Updates confirmed state for all items in the photo
- Items with >30% variance flagged in `alerts`
- Consumption rates updated for items with >10% variance

---

### 5. `manual_correction` — User override (highest precedence)

**Handler**: `handleManualCorrection` in `StockEngine`
**Source**: Dashboard UI "correct quantity" input

```typescript
interface ManualCorrectionInput {
  type: 'manual_correction';
  itemId: string;
  householdId: string;
  confirmedQuantity: number;
  notes?: string;
  timestamp: Date;
}
```

**Example**:
```json
{
  "type": "manual_correction",
  "itemId": "item-pasta-321",
  "householdId": "hh-abc123",
  "confirmedQuantity": 2,
  "notes": "Found 2 packets at back of cupboard",
  "timestamp": "2026-07-02T19:30:00.000Z"
}
```

**Behaviour**:
- Always wins over any prior state (highest precedence in conflict resolution)
- Immediately resets confirmed baseline to this quantity
- Confidence set to 'high'
- No rate update (corrections are data quality events, not consumption events)

---

### 6. `status_change` — Frozen, gifted, returned, cooked, thawed

**Handler**: `handleStatusChange` in `StockEngine`
**Source**: Manual UI, WhatsApp NL parsing

```typescript
interface StatusChangeInput {
  type: 'status_change';
  itemId: string;
  householdId: string;
  changeType: 'frozen' | 'gift_received' | 'returned' | 'cooked' | 'thawed';
  quantity?: number;        // required for 'returned' and 'gift_received'
  expiryOverride?: Date;    // required for 'cooked' (e.g. cooked rice: +3 days)
  timestamp: Date;
  notes?: string;
}
```

**Examples**:
```json
// Chicken frozen
{ "type": "status_change", "itemId": "item-chicken", "householdId": "hh-1",
  "changeType": "frozen", "timestamp": "2026-07-02T09:00:00.000Z" }

// Cooked rice — 3-day manual expiry
{ "type": "status_change", "itemId": "item-rice-cooked", "householdId": "hh-1",
  "changeType": "cooked", "expiryOverride": "2026-07-05T00:00:00.000Z",
  "timestamp": "2026-07-02T19:00:00.000Z" }

// Wine gifted
{ "type": "status_change", "itemId": "item-wine", "householdId": "hh-1",
  "changeType": "gift_received", "quantity": 1, "timestamp": "2026-07-02T20:00:00.000Z" }
```

**Behaviour per changeType**:
- `frozen`: extends all active batch expiries by category `freezerExtensionDays`, updates location to 'freezer'
- `thawed`: location → 'fridge', optional expiry override for thaw date
- `returned`: reduces quantity (return transaction), does NOT update consumption rate
- `gift_received`: adds stock (gift transaction), does NOT count toward household spend
- `cooked`: applies manual expiry override to active batches

---

### 7. `check_in` — WhatsApp Sunday check-in

**Handler**: `handleCheckIn` in `StockEngine`
**Source**: WhatsApp weekly check-in flow (parsed by NL layer)

```typescript
interface CheckInInput {
  type: 'check_in';
  householdId: string;
  items: Array<{
    itemId: string;
    status: 'ok' | 'low' | 'out';
    quantityEstimate?: number;
  }>;
  timestamp: Date;
  source: 'whatsapp' | 'manual';
}
```

**Example**:
```json
{
  "type": "check_in",
  "householdId": "hh-abc123",
  "items": [
    { "itemId": "item-milk", "status": "low", "quantityEstimate": 1 },
    { "itemId": "item-eggs", "status": "ok" }
  ],
  "timestamp": "2026-07-02T19:00:00.000Z",
  "source": "whatsapp"
}
```

**Behaviour**:
- Soft reconciliation — less authoritative than photo or manual correction
- If `quantityEstimate` provided: creates a correction transaction
- Status-only (no quantity): no transaction created, status updated

---

## All Output Types

Every `processInput()` call returns `EngineOutput`:

```typescript
interface EngineOutput {
  stateUpdates: StockEstimate[];         // updated state for affected items
  transactions: Transaction[];           // new transactions written to the ledger
  alerts: Alert[];                       // expiry warnings, drift flags, conflicts
  conflicts: Conflict[];                 // conflicts raised by this input
  shoppingListUpdates: ShoppingListItem[]; // updated shopping list
  wasteEvents: Transaction[];            // waste transactions (expiry sweep)
  duplicateDetected: string | null;      // idempotency key if duplicate found
}
```

### `state_update` — New item state after processing

```typescript
interface StockEstimate {
  itemId: string;
  estimatedQuantity: number;
  confidence: 'high' | 'medium' | 'low';
  basis: 'confirmed' | 'inferred' | 'stale' | 'default';
  staleDays: number;
  lastConfirmedAt: Date | null;
}
```

### `alert` — Expiry warning, drift flag, conflict notification

```typescript
interface Alert {
  id: string;
  itemId?: string;
  type: 'expiring_soon' | 'expired' | 'drift_detected' | 'conflict_raised'
      | 'low_stock' | 'out_of_stock' | 'reconciliation_needed'
      | 'categorisation_needed' | 'duplicate_detected';
  message: string;
  severity: 'info' | 'warning' | 'critical';
  raisedAt: Date;
  expiresAt: Date | null;
  dismissed: boolean;
  metadata?: Record<string, unknown>;
}
```

### `shopping_list_update` — Updated shopping list

```typescript
interface ShoppingListItem {
  itemId: string;
  itemName: string;
  category: Category;
  quantityNeeded: number;
  unit: string;
  reason: 'below_threshold' | 'predicted_runout' | 'manual';
  predictedRunoutDate: Date | null;
  addedAt: Date;
}
```

### `waste_event` — Logged waste transaction

Returned by `runExpirySweep()` (not via `processInput`). Each waste event includes:
```typescript
interface WasteEvent {
  batchId: string;
  itemId: string;
  quantity: number;
  expiryDate: Date;
  detectedAt: Date;
  transaction: Transaction;  // type='waste', source='system'
}
```

### `conflict_raised` — Conflict requiring resolution

```typescript
interface Conflict {
  id: string;
  itemId: string;
  conflictType: 'status_disagreement' | 'quantity_disagreement'
              | 'name_match' | 'found_after_out';
  input1: Record<string, unknown>;  // both inputs always preserved
  input2: Record<string, unknown>;
  resolution: 'input1' | 'input2' | 'manual' | 'pending';
  resolvedAt: Date | null;
  resolvedBy: 'system' | 'user' | null;
  createdAt: Date;
}
```

---

## Precedence and Conflict Rules

When two inputs contradict each other, the engine applies these rules in order:

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | `manual` | User corrects quantity via dashboard |
| 2 | `photo` | Fridge scan via Claude vision |
| 3 | `receipt` | Structured receipt data |
| 4 | `whatsapp` / `sms` | Natural language update |
| 5 | `tap` | NFC tap status |
| 6 (lowest) | `system` | System-inferred / expiry sweep |

**When same source type**: more recent timestamp wins.

**All conflicts are logged** — both inputs are preserved in `Conflict.input1` and `Conflict.input2`. The losing input is never silently discarded.

**Auto-resolved conflicts**: rules 1–4 above are applied automatically.

**Pending conflicts**: raised when the engine cannot auto-resolve (e.g. name matching at 50–80% confidence). These appear in `getUnresolved()` and require user action via `manualResolve(conflictId, 'input1' | 'input2')`.

---

## Idempotency

Every structured input that may arrive more than once (receipts, photo scans) **must** include an `idempotencyKey`. The engine rejects duplicate keys with `duplicateDetected` set in the output.

**How to generate an idempotency key**:
- Receipts: SHA-256 hash of (store name + date + total amount + item count)
- Photo scans: SHA-256 hash of (photo timestamp + household ID + camera device ID)
- WhatsApp: message SID from Twilio (globally unique)

**Engine behaviour on duplicate**:
```
if (processedKeys.has(input.idempotencyKey)) {
  return emptyOutput(input.idempotencyKey);
  // No state change. duplicateDetected = the key that matched.
}
```

---

## Error States

The engine never throws on bad input — it degrades gracefully:

| Scenario | Engine response |
|----------|----------------|
| Unknown `itemId` | Returns empty/zero estimate. Register item first via `registerItem()`. |
| Duplicate idempotency key | Returns empty output with `duplicateDetected` set. |
| Consumption > available stock | Deducts available stock, `stockedOut: true` in ConsumeResult. |
| Category has no expiry | `expiryDate: null` on all batches, no expiry sweep entries. |
| No consumption history | Falls back to category default rate, confidence=0. |
| Item not yet confirmed | Confidence='low', basis='inferred' or 'default'. |

---

## Integration Checklist

For each new integration layer, verify:

- [ ] Every structured input has an `idempotencyKey`
- [ ] `itemId` is resolved before calling `processInput` (name resolution is upstream of the engine)
- [ ] `quantity` is a positive number in the item's `unit` (not a raw string like "half")
- [ ] `timestamp` is a `Date` object (not a string)
- [ ] Call `engine.registerItem()` before the first input for any new item
- [ ] Check `output.duplicateDetected` before acting on output
- [ ] Check `output.conflicts` for any new conflicts requiring user resolution
- [ ] Run `engine.expiry.runExpirySweep()` once daily (system cron)
