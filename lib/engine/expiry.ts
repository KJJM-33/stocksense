/**
 * StockSense Intelligence Engine — Expiry Engine
 *
 * Manages expiry dates for purchase batches and detects waste events.
 * Expiry priority (highest to lowest):
 * 1. Manual override (user explicitly set an expiry date)
 * 2. Receipt date (expiry printed on packaging, parsed from receipt)
 * 3. Category default (calculated from purchase date + category.expiryDays)
 *
 * Special cases:
 * - Frozen items: expiry extended by freezerExtensionDays when status='frozen' applied
 * - Cooked leftovers: manual expiry override (e.g. cooked rice: +3 days)
 * - Never-expires category (household, canned): expiryDate = null
 */

import type { Category, Transaction } from './types';
import type { PurchaseBatch } from './types';
import type { FIFOTracker } from './fifo';
import { getCategoryDefaults } from './categories';
import { randomUUID } from 'crypto';

export interface WasteEvent {
  batchId: string;
  itemId: string;
  quantity: number;
  expiryDate: Date;
  detectedAt: Date;
  /** Corresponding waste transaction */
  transaction: Transaction;
}

export interface ExpiringItem {
  itemId: string;
  batchId: string;
  expiryDate: Date;
  remainingQuantity: number;
  /** Days until expiry (negative = already expired) */
  daysUntilExpiry: number;
}

/** Manual expiry overrides: itemId → override expiry date */
type ManualOverrideMap = Map<string, Date>;

export class ExpiryEngine {
  /** Manual expiry overrides set by users */
  private manualOverrides: ManualOverrideMap = new Map();

  constructor(private fifoTracker: FIFOTracker) {}

  /**
   * Returns the effective expiry date for an item/batch.
   * Priority: manual override > batch receipt date > category default.
   *
   * @param itemId - The item to check
   * @param category - The item's category
   * @param purchaseDate - When the item was purchased (used for category default calc)
   * @param batchId - Optional: if provided, returns batch-specific expiry
   * @returns Expiry Date, or null if never expires
   */
  getExpiry(
    itemId: string,
    category: Category,
    purchaseDate: Date,
    batchId?: string
  ): Date | null {
    // 1. Manual override wins
    const manualOverride = this.manualOverrides.get(batchId ?? itemId);
    if (manualOverride) return manualOverride;

    // 2. Batch-level expiry (set from receipt or during addBatch)
    if (batchId) {
      const batches = this.fifoTracker.getActiveBatches(itemId);
      const batch = batches.find((b) => b.id === batchId);
      if (batch?.expiryDate) return batch.expiryDate;
    }

    // 3. Category default
    const defaults = getCategoryDefaults(category);
    if (defaults.expiryDays === null) return null;

    const expiry = new Date(purchaseDate);
    expiry.setDate(expiry.getDate() + defaults.expiryDays);
    return expiry;
  }

  /**
   * Sets a manual expiry override for an item or batch.
   * Manual overrides have the highest priority and override everything.
   *
   * @param key - itemId or batchId to override
   * @param expiryDate - The override expiry date
   */
  setManualOverride(key: string, expiryDate: Date): void {
    this.manualOverrides.set(key, expiryDate);
  }

  /**
   * Applies the frozen status to a batch, extending its expiry by the category's
   * freezerExtensionDays. No-op if the category doesn't support freezing.
   *
   * @param batchId - The batch to freeze
   * @param itemId - The item the batch belongs to
   * @param category - The item's category
   * @param frozenAt - When the item was frozen (defaults to now)
   */
  applyFreezeExtension(
    batchId: string,
    itemId: string,
    category: Category,
    frozenAt: Date = new Date()
  ): Date | null {
    const defaults = getCategoryDefaults(category);
    if (defaults.freezerExtensionDays === null) return null;

    const batches = this.fifoTracker.getActiveBatches(itemId);
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return null;

    const newExpiry = new Date(frozenAt);
    newExpiry.setDate(newExpiry.getDate() + defaults.freezerExtensionDays);
    this.fifoTracker.extendBatchExpiry(batchId, itemId, newExpiry);
    return newExpiry;
  }

  /**
   * Runs the daily expiry sweep across all tracked items.
   * For each expired batch with remaining stock:
   *   1. Logs a waste transaction
   *   2. Exhausts the batch
   *   3. Returns a WasteEvent record
   *
   * This should be called once per day (system-triggered).
   *
   * @param itemIds - Items to sweep (all items if omitted)
   * @param householdId - Household ID for transaction records
   * @param asOf - Reference date (defaults to now)
   * @returns Array of WasteEvents for items that were swept
   */
  runExpirySweep(
    itemIds: string[],
    householdId: string,
    asOf: Date = new Date()
  ): WasteEvent[] {
    const wasteEvents: WasteEvent[] = [];
    const expiredBatches = this.fifoTracker.getExpiredBatches(undefined, asOf);

    for (const batch of expiredBatches) {
      if (!itemIds.includes(batch.itemId)) continue;
      if (batch.remainingQuantity <= 0) continue;

      const wasteTransaction: Transaction = {
        id: randomUUID(),
        itemId: batch.itemId,
        householdId,
        type: 'waste',
        quantity: batch.remainingQuantity,
        timestamp: asOf,
        source: 'system',
        batchId: batch.id,
        notes: `Auto-waste: batch expired ${batch.expiryDate?.toISOString().split('T')[0]}`,
      };

      wasteEvents.push({
        batchId: batch.id,
        itemId: batch.itemId,
        quantity: batch.remainingQuantity,
        expiryDate: batch.expiryDate!,
        detectedAt: asOf,
        transaction: wasteTransaction,
      });

      // Exhaust the batch
      this.fifoTracker.exhaustBatch(batch.id, batch.itemId);
    }

    return wasteEvents;
  }

  /**
   * Returns items expiring within N days, sorted soonest first.
   *
   * @param itemIds - Items to check
   * @param withinDays - Lookahead window in days
   * @param asOf - Reference date (defaults to now)
   * @returns ExpiringItem records sorted by expiryDate ASC
   */
  getExpiringItems(
    itemIds: string[],
    withinDays: number,
    asOf: Date = new Date()
  ): ExpiringItem[] {
    const result: ExpiringItem[] = [];

    for (const itemId of itemIds) {
      const expiringBatches = this.fifoTracker.getBatchesExpiringWithin(itemId, withinDays, asOf);
      for (const batch of expiringBatches) {
        if (!batch.expiryDate) continue;
        const daysUntilExpiry =
          (batch.expiryDate.getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24);
        result.push({
          itemId,
          batchId: batch.id,
          expiryDate: batch.expiryDate,
          remainingQuantity: batch.remainingQuantity,
          daysUntilExpiry,
        });
      }
    }

    return result.sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
  }

  /**
   * Returns true if an item should trigger a reconciliation check based on expiry proximity.
   * Items expiring within 3 days should always be verified.
   *
   * @param itemId - The item to check
   * @param asOf - Reference date (defaults to now)
   * @returns true if reconciliation is needed due to expiry proximity
   */
  needsExpiryReconciliation(itemId: string, asOf: Date = new Date()): boolean {
    const urgentBatches = this.fifoTracker.getBatchesExpiringWithin(itemId, 3, asOf);
    return urgentBatches.length > 0;
  }

  /**
   * Returns the manual override map (for persistence).
   * @returns Map of key → override Date
   */
  getManualOverrides(): Record<string, Date> {
    const result: Record<string, Date> = {};
    for (const [key, date] of this.manualOverrides.entries()) {
      result[key] = date;
    }
    return result;
  }

  /**
   * Loads manual overrides from persistent storage.
   * @param overrides - Record of key → override Date
   */
  loadManualOverrides(overrides: Record<string, Date>): void {
    for (const [key, date] of Object.entries(overrides)) {
      this.manualOverrides.set(key, date);
    }
  }
}
