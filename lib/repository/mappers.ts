/**
 * StockSense Repository — DB ↔ Engine Type Mappers
 *
 * Converts between Postgres snake_case rows and the engine's camelCase types.
 * The only non-obvious mappings:
 *   DB source 'nfc'        ↔ engine source 'tap'  (NFC is the physical mechanism; tap is the UX action)
 *   DB type   'adjustment' ↔ engine type 'correction' (same semantics, different name history)
 */

import type {
  Category,
  ConsumptionRate,
  InputSource,
  Item,
  PurchaseBatch,
  Transaction,
  TransactionType,
} from '../engine/types';
import type { ConsumptionRateRow, ItemRow, PurchaseBatchRow, TransactionRow } from './types';

// ─── DB → Engine ─────────────────────────────────────────────────────────────

export function itemRowToItem(row: ItemRow): Item {
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    category: row.category as Category,
    unit: row.unit,
    currentQuantity: row.quantity,
    status: row.status,
    confidenceLevel: row.confidence_level,
    lastConfirmedAt: row.last_confirmed_at ? new Date(row.last_confirmed_at) : null,
    lastInferredAt: row.last_inferred_at ? new Date(row.last_inferred_at) : null,
    location: row.location,
    frozen: row.frozen,
    createdAt: new Date(row.created_at),
  };
}

export function transactionRowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    itemId: row.item_id,
    householdId: row.household_id,
    type: dbTypeToEngineType(row.type),
    quantity: row.quantity ?? 0,
    timestamp: new Date(row.created_at),
    source: dbSourceToEngineSource(row.source),
    batchId: row.batch_id ?? undefined,
    expiryDate: row.expiry_date ? new Date(row.expiry_date) : undefined,
    notes: row.note ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
  };
}

export function batchRowToBatch(row: PurchaseBatchRow): PurchaseBatch {
  return {
    id: row.id,
    itemId: row.item_id,
    quantity: row.quantity,
    remainingQuantity: row.remaining_quantity,
    purchaseDate: new Date(row.purchase_date),
    expiryDate: row.expiry_date ? new Date(row.expiry_date) : null,
    source: dbSourceToEngineSource(row.source),
    wasFrozen: row.was_frozen,
    createdAt: new Date(row.created_at),
  };
}

export function rateRowToRate(row: ConsumptionRateRow): ConsumptionRate {
  return {
    itemId: row.item_id,
    dailyRate: row.daily_rate,
    confidenceScore: row.confidence_score,
    dataPointCount: row.data_point_count,
    lastUpdated: new Date(row.last_updated),
    categoryDefault: row.category_default,
  };
}

// ─── Engine → DB ──────────────────────────────────────────────────────────────

/** Maps engine source ('tap') to DB source ('nfc'). */
export function engineSourceToDB(source: InputSource): string {
  return source === 'tap' ? 'nfc' : source;
}

/** Maps engine transaction type to DB type. */
export function engineTypeToDB(type: TransactionType): string {
  // Both 'adjustment' and 'correction' are now valid in the DB constraint.
  // Use 'correction' for new writes (clearer semantic).
  return type;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function dbTypeToEngineType(type: string): TransactionType {
  if (type === 'adjustment') return 'correction';
  return type as TransactionType;
}

function dbSourceToEngineSource(source: string): InputSource {
  if (source === 'nfc') return 'tap';
  if (source === 'sms') return 'whatsapp'; // SMS and WhatsApp are same handler
  return source as InputSource;
}
