/**
 * StockSense Intelligence Engine — Shared Types
 *
 * All interfaces and enums used across engine modules.
 * The engine is storage-agnostic: no Supabase imports here.
 * Dates are always Date objects internally, never strings.
 */

// ─── Core domain types ────────────────────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type ItemStatus = 'ok' | 'low' | 'out';

export type Category =
  | 'dairy'
  | 'produce'
  | 'meat'
  | 'fish'
  | 'bread'
  | 'frozen'
  | 'canned'
  | 'dry_goods'
  | 'beverages'
  | 'condiments'
  | 'household'
  | 'uncategorised';

export type TransactionType = 'purchase' | 'consumption' | 'waste' | 'correction' | 'gift' | 'return';

export type InputSource = 'tap' | 'whatsapp' | 'receipt' | 'photo' | 'manual' | 'system';

export type EstimateBasis = 'confirmed' | 'inferred' | 'stale' | 'default';

export type ConflictType = 'status_disagreement' | 'quantity_disagreement' | 'name_match' | 'found_after_out';

export type ReconciliationTrigger = 'photo' | 'manual' | 'checkin' | 'scheduled';

// ─── Item ─────────────────────────────────────────────────────────────────────

/**
 * Represents a tracked household stock item.
 * `currentQuantity` is derived from the transaction ledger via the accounting equation:
 * Opening Stock + Purchases − Consumption = Current Stock
 */
export interface Item {
  id: string;
  householdId: string;
  name: string;
  category: Category;
  /** Physical unit (e.g. 'units', 'ml', 'g', 'slices', 'portions') */
  unit: string;
  /** Current derived quantity — sum of all transactions */
  currentQuantity: number;
  /** Logical status: ok / low / out */
  status: ItemStatus;
  confidenceLevel: ConfidenceLevel;
  /** When the quantity was last physically confirmed (scan, manual count, photo) */
  lastConfirmedAt: Date | null;
  /** When the quantity was last updated by inference (consumption projection) */
  lastInferredAt: Date | null;
  /** Physical location in the household */
  location: 'fridge' | 'freezer' | 'cupboard';
  /** Whether this item is currently frozen (affects expiry logic) */
  frozen: boolean;
  createdAt: Date;
}

// ─── Transaction ──────────────────────────────────────────────────────────────

/**
 * An immutable ledger entry. Every stock change writes a transaction.
 * Never delete — corrections are new transactions.
 */
export interface Transaction {
  id: string;
  itemId: string;
  householdId: string;
  type: TransactionType;
  quantity: number;
  timestamp: Date;
  source: InputSource;
  /** Which FIFO batch this transaction drew from (for consumption/waste) */
  batchId?: string;
  /** Explicit expiry date provided at purchase time */
  expiryDate?: Date;
  notes?: string;
  /** Idempotency key — prevents duplicate processing (e.g. same receipt scanned twice) */
  idempotencyKey?: string;
}

// ─── FIFO Purchase Batch ──────────────────────────────────────────────────────

/**
 * A discrete purchase event. Consumption draws from the oldest batch first (FIFO).
 * Multiple batches of the same item can coexist (e.g. 3 eggs left from old pack + new 12-pack).
 */
export interface PurchaseBatch {
  id: string;
  itemId: string;
  /** How many units were originally purchased in this batch */
  quantity: number;
  /** How many units remain unconsumed */
  remainingQuantity: number;
  purchaseDate: Date;
  /** Calculated expiry. Priority: manual override > receipt date > category default */
  expiryDate: Date | null;
  /** Original source of this batch (receipt, manual, gift, etc.) */
  source: InputSource;
  /** True if item was frozen after purchase (extends expiryDate) */
  wasFrozen: boolean;
  createdAt: Date;
}

// ─── Consumption Rate ─────────────────────────────────────────────────────────

/**
 * Rolling consumption rate estimate for an item.
 * Uses exponential smoothing: new_rate = α × new_point + (1 − α) × old_rate
 * Falls back to categoryDefault when dataPointCount < 3.
 */
export interface ConsumptionRate {
  itemId: string;
  /** Units consumed per day */
  dailyRate: number;
  /** 0–1. Full confidence (1.0) at 10 data points. min(dataPointCount / 10, 1.0) */
  confidenceScore: number;
  /** Number of observed consumption events used in this estimate */
  dataPointCount: number;
  lastUpdated: Date;
  /** Category-level default rate (fallback when insufficient data) */
  categoryDefault: number;
}

// ─── Stock Estimate ───────────────────────────────────────────────────────────

/**
 * The engine's current best estimate of an item's quantity.
 * `basis` indicates how the estimate was derived.
 */
export interface StockEstimate {
  itemId: string;
  estimatedQuantity: number;
  confidence: ConfidenceLevel;
  /** confirmed = physically verified; inferred = projected from rate; stale = >7 days old; default = no data */
  basis: EstimateBasis;
  /** How many days since this was last physically confirmed */
  staleDays: number;
  lastConfirmedAt: Date | null;
}

// ─── Conflict ─────────────────────────────────────────────────────────────────

/**
 * Raised when two inputs contradict each other.
 * Both inputs are always preserved — conflicts are never silently discarded.
 */
export interface Conflict {
  id: string;
  itemId: string;
  conflictType: ConflictType;
  /** Serialised first input */
  input1: Record<string, unknown>;
  /** Serialised second input */
  input2: Record<string, unknown>;
  /** Which input won (or 'manual' if user resolved) */
  resolution: 'input1' | 'input2' | 'manual' | 'pending';
  resolvedAt: Date | null;
  resolvedBy: 'system' | 'user' | null;
  createdAt: Date;
}

// ─── Reconciliation Event ─────────────────────────────────────────────────────

/**
 * Snapshot of all item states at a point in time, used to reconcile
 * physical counts against the inferred ledger.
 */
export interface ItemSnapshot {
  itemId: string;
  confirmedQuantity: number;
  inferredQuantity: number;
  /** Absolute difference: confirmed − inferred */
  variance: number;
  /** Percentage variance vs inferred (null if inferred = 0) */
  variancePct: number | null;
}

export interface ReconciliationEvent {
  id: string;
  householdId: string;
  triggeredBy: ReconciliationTrigger;
  itemSnapshots: ItemSnapshot[];
  /** Map of itemId → variance amount */
  varianceMap: Record<string, number>;
  timestamp: Date;
}

// ─── Alert ────────────────────────────────────────────────────────────────────

export type AlertType = 'expiring_soon' | 'expired' | 'drift_detected' | 'conflict_raised' | 'low_stock' | 'out_of_stock' | 'reconciliation_needed' | 'categorisation_needed' | 'duplicate_detected';

export interface Alert {
  id: string;
  itemId?: string;
  type: AlertType;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  /** When this alert was raised */
  raisedAt: Date;
  /** When this alert expires / becomes irrelevant (null = until actioned) */
  expiresAt: Date | null;
  /** Whether the user has dismissed this alert */
  dismissed: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Shopping List ─────────────────────────────────────────────────────────────

export interface ShoppingListItem {
  itemId: string;
  itemName: string;
  category: Category;
  quantityNeeded: number;
  unit: string;
  /** Why this item was added to the list */
  reason: 'below_threshold' | 'predicted_runout' | 'manual';
  /** When we predict the item will run out (for predicted_runout) */
  predictedRunoutDate: Date | null;
  addedAt: Date;
}

// ─── Engine Inputs ────────────────────────────────────────────────────────────

/** NFC tap → status change */
export interface TapUpdateInput {
  type: 'tap_update';
  itemId: string;
  householdId: string;
  status: 'low' | 'out' | 'used_some';
  location?: string;
  timestamp: Date;
  source: 'tap';
}

/** Receipt scan → new stock purchases */
export interface PurchaseInput {
  type: 'purchase';
  itemId: string;
  householdId: string;
  quantity: number;
  expiryDate?: Date;
  source: InputSource;
  timestamp: Date;
  idempotencyKey?: string;
  notes?: string;
}

/** Manual / NL / WhatsApp → consumed quantity */
export interface ConsumptionLogInput {
  type: 'consumption_log';
  itemId: string;
  householdId: string;
  quantity: number;
  timestamp: Date;
  source: InputSource;
  notes?: string;
}

/** Fridge photo → ground truth snapshot of all visible items */
export interface PhotoReconciliationInput {
  type: 'photo_reconciliation';
  householdId: string;
  /** Items visible in the photo with confirmed quantities */
  items: Array<{ itemId: string; confirmedQuantity: number }>;
  timestamp: Date;
  idempotencyKey?: string;
}

/** User override — highest precedence input */
export interface ManualCorrectionInput {
  type: 'manual_correction';
  itemId: string;
  householdId: string;
  confirmedQuantity: number;
  notes?: string;
  timestamp: Date;
}

/** State change: frozen, gifted, returned to shop */
export interface StatusChangeInput {
  type: 'status_change';
  itemId: string;
  householdId: string;
  changeType: 'frozen' | 'gift_received' | 'returned' | 'cooked' | 'thawed';
  quantity?: number;
  expiryOverride?: Date;
  timestamp: Date;
  notes?: string;
}

/** WhatsApp Sunday check-in — soft reconciliation trigger */
export interface CheckInInput {
  type: 'check_in';
  householdId: string;
  /** Items included in the check-in (sparse — only what the user mentioned) */
  items: Array<{ itemId: string; status: ItemStatus; quantityEstimate?: number }>;
  timestamp: Date;
  source: 'whatsapp' | 'manual';
}

/** Union of all possible engine inputs */
export type EngineInput =
  | TapUpdateInput
  | PurchaseInput
  | ConsumptionLogInput
  | PhotoReconciliationInput
  | ManualCorrectionInput
  | StatusChangeInput
  | CheckInInput;

// ─── Engine Output ────────────────────────────────────────────────────────────

/** What the engine returns after processing any input */
export interface EngineOutput {
  /** Updated state for the affected item(s) */
  stateUpdates: StockEstimate[];
  /** New transactions written to the ledger */
  transactions: Transaction[];
  /** Alerts raised (expiry, drift, conflict) */
  alerts: Alert[];
  /** Conflicts raised by this input */
  conflicts: Conflict[];
  /** Updated shopping list items */
  shoppingListUpdates: ShoppingListItem[];
  /** Waste events that occurred (expiry sweep or return) */
  wasteEvents: Transaction[];
  /** If a duplicate was detected, the idempotency key that matched */
  duplicateDetected: string | null;
}
