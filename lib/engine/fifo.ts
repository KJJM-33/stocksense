/**
 * StockSense Intelligence Engine — FIFO Tracker
 *
 * Tracks stock across multiple purchase batches using First In, First Out.
 * Consuming from the oldest batch first is both accounting-correct and
 * waste-minimising (older stock is consumed before it expires).
 *
 * The accounting equation applies per-batch:
 *   batch.remainingQuantity = batch.quantity − Σ(consumption transactions for this batch)
 */

import type { PurchaseBatch, InputSource } from './types';
import { randomUUID } from 'crypto';

/**
 * Result of consuming quantity from the FIFO queue.
 */
export interface ConsumeResult {
  /** Total quantity actually consumed (may be less than requested if stock ran out) */
  totalConsumed: number;
  /** Which batches were drawn from and by how much */
  batchDraws: Array<{ batchId: string; quantityDrawn: number }>;
  /** True if the requested quantity exceeded available stock */
  stockedOut: boolean;
  /** Remaining unfulfilled quantity (if stockedOut) */
  unfulfilledQuantity: number;
}

/**
 * Manages FIFO purchase batches for a set of items.
 * Storage-agnostic: load/dump for persistence at the repository layer.
 */
export class FIFOTracker {
  /** Map of itemId → list of batches, sorted by purchaseDate ASC */
  private batches: Map<string, PurchaseBatch[]> = new Map();

  /**
   * Records a new purchase batch. Inserted in purchase-date order.
   *
   * @param params - Batch parameters
   * @returns The created PurchaseBatch
   */
  addBatch(params: {
    itemId: string;
    quantity: number;
    purchaseDate: Date;
    expiryDate: Date | null;
    source: InputSource;
  }): PurchaseBatch {
    const batch: PurchaseBatch = {
      id: randomUUID(),
      itemId: params.itemId,
      quantity: params.quantity,
      remainingQuantity: params.quantity,
      purchaseDate: params.purchaseDate,
      expiryDate: params.expiryDate,
      source: params.source,
      wasFrozen: false,
      createdAt: new Date(),
    };

    const existing = this.batches.get(params.itemId) ?? [];
    // Insert in purchase-date order (oldest first)
    existing.push(batch);
    existing.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());
    this.batches.set(params.itemId, existing);

    return batch;
  }

  /**
   * Deducts quantity from the oldest non-expired, non-exhausted batch first (FIFO).
   * If the oldest batch is exhausted, moves to the next batch.
   *
   * @param itemId - The item to consume stock from
   * @param quantity - How much to consume
   * @param asOf - The reference date (defaults to now). Expired batches are skipped.
   * @returns ConsumeResult describing which batches were drawn from
   */
  consumeQuantity(itemId: string, quantity: number, asOf: Date = new Date()): ConsumeResult {
    const batches = this.batches.get(itemId) ?? [];
    let remaining = quantity;
    const batchDraws: Array<{ batchId: string; quantityDrawn: number }> = [];

    for (const batch of batches) {
      if (remaining <= 0) break;
      if (batch.remainingQuantity <= 0) continue;
      // Skip expired batches — they should be handled by the expiry sweep, not consumed
      if (batch.expiryDate && batch.expiryDate < asOf) continue;

      const draw = Math.min(batch.remainingQuantity, remaining);
      batch.remainingQuantity -= draw;
      remaining -= draw;
      batchDraws.push({ batchId: batch.id, quantityDrawn: draw });
    }

    const totalConsumed = quantity - remaining;
    return {
      totalConsumed,
      batchDraws,
      stockedOut: remaining > 0,
      unfulfilledQuantity: remaining,
    };
  }

  /**
   * Returns all active (non-exhausted) batches for an item, oldest first.
   *
   * @param itemId - The item to query
   * @param asOf - Reference date (defaults to now). Does not filter expired batches here —
   *   the expiry sweep handles that. Expired but unswept batches still show as active.
   * @returns Active batches sorted by purchaseDate ASC
   */
  getActiveBatches(itemId: string, asOf?: Date): PurchaseBatch[] {
    const batches = this.batches.get(itemId) ?? [];
    return batches.filter((b) => b.remainingQuantity > 0);
  }

  /**
   * Returns the total available stock for an item across all active batches.
   * Does not exclude expired batches — call expirySweep first to clean those up.
   *
   * @param itemId - The item to total
   * @returns Sum of remainingQuantity across all active batches
   */
  getTotalStock(itemId: string): number {
    const batches = this.batches.get(itemId) ?? [];
    return batches.reduce((sum, b) => sum + b.remainingQuantity, 0);
  }

  /**
   * Returns batches expiring within N days.
   *
   * @param itemId - The item to check
   * @param withinDays - Look-ahead window in days
   * @param asOf - Reference date (defaults to now)
   * @returns Active batches with expiryDate within the window, sorted by expiryDate ASC
   */
  getBatchesExpiringWithin(
    itemId: string,
    withinDays: number,
    asOf: Date = new Date()
  ): PurchaseBatch[] {
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() + withinDays);

    return this.getActiveBatches(itemId).filter(
      (b) => b.expiryDate !== null && b.expiryDate <= cutoff && b.expiryDate >= asOf
    );
  }

  /**
   * Returns all batches that have passed their expiry date and still have remaining stock.
   * These should be processed by the ExpiryEngine's sweep.
   *
   * @param itemId - The item to check (if omitted, checks all items)
   * @param asOf - Reference date (defaults to now)
   * @returns Expired batches with remaining quantity > 0
   */
  getExpiredBatches(itemId?: string, asOf: Date = new Date()): PurchaseBatch[] {
    const itemIds = itemId ? [itemId] : Array.from(this.batches.keys());
    const expired: PurchaseBatch[] = [];

    for (const id of itemIds) {
      const batches = this.batches.get(id) ?? [];
      for (const batch of batches) {
        if (batch.remainingQuantity > 0 && batch.expiryDate && batch.expiryDate < asOf) {
          expired.push(batch);
        }
      }
    }

    return expired;
  }

  /**
   * Exhausts a batch (sets remainingQuantity = 0). Used by the expiry sweep.
   *
   * @param batchId - The batch to exhaust
   * @param itemId - The item the batch belongs to
   */
  exhaustBatch(batchId: string, itemId: string): void {
    const batches = this.batches.get(itemId) ?? [];
    const batch = batches.find((b) => b.id === batchId);
    if (batch) {
      batch.remainingQuantity = 0;
    }
  }

  /**
   * Reduces a batch's remaining quantity (e.g. when item is returned to shop).
   *
   * @param batchId - The batch to adjust
   * @param itemId - The item the batch belongs to
   * @param quantity - Amount to deduct
   * @returns The quantity actually deducted (clamped to remainingQuantity)
   */
  reduceBatch(batchId: string, itemId: string, quantity: number): number {
    const batches = this.batches.get(itemId) ?? [];
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return 0;
    const deducted = Math.min(batch.remainingQuantity, quantity);
    batch.remainingQuantity -= deducted;
    return deducted;
  }

  /**
   * Extends the expiry date of a batch (e.g. when item is frozen).
   *
   * @param batchId - The batch to update
   * @param itemId - The item the batch belongs to
   * @param newExpiryDate - The new expiry date
   */
  extendBatchExpiry(batchId: string, itemId: string, newExpiryDate: Date): void {
    const batches = this.batches.get(itemId) ?? [];
    const batch = batches.find((b) => b.id === batchId);
    if (batch) {
      batch.expiryDate = newExpiryDate;
      batch.wasFrozen = true;
    }
  }

  /**
   * Loads batches from persistent storage (repository layer).
   * @param batches - Array of PurchaseBatch records to load
   */
  load(batches: PurchaseBatch[]): void {
    for (const batch of batches) {
      const existing = this.batches.get(batch.itemId) ?? [];
      existing.push(batch);
      this.batches.set(batch.itemId, existing);
    }
    // Re-sort all after bulk load
    for (const [itemId, batchList] of this.batches.entries()) {
      this.batches.set(
        itemId,
        batchList.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime())
      );
    }
  }

  /**
   * Returns all batches (for persistence).
   * @returns Array of all PurchaseBatch records
   */
  dump(): PurchaseBatch[] {
    const all: PurchaseBatch[] = [];
    for (const batches of this.batches.values()) {
      all.push(...batches);
    }
    return all;
  }

  /**
   * Returns the all items that have at least one batch tracked.
   * @returns Array of itemIds
   */
  getTrackedItemIds(): string[] {
    return Array.from(this.batches.keys());
  }
}
