/**
 * StockSense Intelligence Engine — Stock Level Engine
 *
 * Calculates current stock estimates by combining:
 * 1. Last confirmed quantity (physical count, photo, or manual correction)
 * 2. Projected consumption since that confirmation (from ConsumptionRateEngine)
 * 3. All transactions since last confirmation (purchases, adjustments, waste)
 *
 * Confidence degrades over time:
 * - HIGH:   confirmed < 1 day ago
 * - MEDIUM: confirmed 1–7 days ago
 * - LOW:    confirmed > 7 days ago
 * - STALE:  no confirmation ever, or > 14 days since last
 *
 * The core equation:
 *   Estimated = LastConfirmedQty + Σ(purchases since) − projectedConsumption
 */

import type { Category, ConfidenceLevel, EstimateBasis, Item, StockEstimate, Transaction } from './types';
import { ConsumptionRateEngine } from './consumption';
import { getCategoryDefaults } from './categories';

/** Confidence thresholds by time since last confirmation */
const CONFIDENCE_HIGH_DAYS = 1;
const CONFIDENCE_MEDIUM_DAYS = 7;
const CONFIDENCE_LOW_DAYS = 14;

/** Below this estimated quantity, item is 'low' */
const LOW_STOCK_MULTIPLIER = 1.5; // 1.5× category threshold triggers "low"

export class StockLevelEngine {
  private items: Map<string, Item> = new Map();
  /** Confirmed quantity at last physical check, per item */
  private confirmedState: Map<string, { quantity: number; confirmedAt: Date }> = new Map();
  /** Pending transactions since last confirmation, per item */
  private pendingTransactions: Map<string, Transaction[]> = new Map();

  constructor(private consumptionEngine: ConsumptionRateEngine) {}

  /**
   * Returns the engine's best estimate of the current stock level for an item.
   * Algorithm:
   *   1. Start from last confirmed quantity (or item's currentQuantity if never confirmed)
   *   2. Add purchases logged since last confirmation
   *   3. Subtract projected consumption since last confirmation (from rate model)
   *   4. Clamp to [0, ∞)
   *   5. Assign confidence based on staleness
   *
   * @param itemId - The item to estimate
   * @param asOf - Reference date for estimate (defaults to now)
   * @returns StockEstimate with estimated quantity, confidence, and basis
   */
  getEstimate(itemId: string, asOf: Date = new Date()): StockEstimate {
    const item = this.items.get(itemId);
    if (!item) {
      return {
        itemId,
        estimatedQuantity: 0,
        confidence: 'low',
        basis: 'default',
        staleDays: Infinity,
        lastConfirmedAt: null,
      };
    }

    const confirmed = this.confirmedState.get(itemId);
    const transactions = this.pendingTransactions.get(itemId) ?? [];

    // If never confirmed, use the item's current quantity as-is (could be seed data)
    if (!confirmed) {
      const staleDays = item.lastInferredAt
        ? (asOf.getTime() - item.lastInferredAt.getTime()) / (1000 * 60 * 60 * 24)
        : Infinity;

      return {
        itemId,
        estimatedQuantity: Math.max(0, item.currentQuantity),
        confidence: staleDays > CONFIDENCE_LOW_DAYS ? 'low' : 'medium',
        basis: staleDays > CONFIDENCE_LOW_DAYS ? 'stale' : 'inferred',
        staleDays,
        lastConfirmedAt: null,
      };
    }

    const daysSinceConfirmed =
      (asOf.getTime() - confirmed.confirmedAt.getTime()) / (1000 * 60 * 60 * 24);

    // Sum purchases and adjustments since last confirmation
    let purchaseDelta = 0;
    for (const tx of transactions) {
      if (tx.timestamp <= confirmed.confirmedAt) continue;
      if (tx.type === 'purchase' || tx.type === 'gift') {
        purchaseDelta += tx.quantity;
      } else if (tx.type === 'return') {
        purchaseDelta -= tx.quantity;
      }
      // consumption/waste are handled by the consumption projection below
    }

    // Project consumption since last confirmation
    const projectedConsumption = this.consumptionEngine.projectConsumption(
      itemId,
      item.category,
      confirmed.confirmedAt,
      asOf
    );

    const estimated = Math.max(
      0,
      confirmed.quantity + purchaseDelta - projectedConsumption
    );

    // Confidence degrades with staleness
    let confidence: ConfidenceLevel;
    let basis: EstimateBasis;

    if (daysSinceConfirmed < CONFIDENCE_HIGH_DAYS) {
      confidence = 'high';
      basis = 'confirmed';
    } else if (daysSinceConfirmed < CONFIDENCE_MEDIUM_DAYS) {
      confidence = 'medium';
      basis = 'inferred';
    } else if (daysSinceConfirmed < CONFIDENCE_LOW_DAYS) {
      confidence = 'low';
      basis = 'inferred';
    } else {
      confidence = 'low';
      basis = 'stale';
    }

    return {
      itemId,
      estimatedQuantity: estimated,
      confidence,
      basis,
      staleDays: daysSinceConfirmed,
      lastConfirmedAt: confirmed.confirmedAt,
    };
  }

  /**
   * Updates stock state from a new transaction.
   * Purchases and gifts increase stock; consumption, waste, and corrections adjust it.
   *
   * @param transaction - The transaction to apply
   */
  applyTransaction(transaction: Transaction): void {
    const item = this.items.get(transaction.itemId);
    if (!item) return;

    // Add to pending transactions for this item
    const pending = this.pendingTransactions.get(transaction.itemId) ?? [];
    pending.push(transaction);
    this.pendingTransactions.set(transaction.itemId, pending);

    // Update item's currentQuantity
    let newQuantity = item.currentQuantity;

    switch (transaction.type) {
      case 'purchase':
      case 'gift':
        newQuantity += transaction.quantity;
        break;
      case 'consumption':
      case 'waste':
        newQuantity = Math.max(0, newQuantity - transaction.quantity);
        break;
      case 'return':
        newQuantity = Math.max(0, newQuantity - transaction.quantity);
        break;
      case 'correction':
        // Correction sets the quantity explicitly
        newQuantity = transaction.quantity;
        // A correction is also a confirmation event
        this.confirmedState.set(transaction.itemId, {
          quantity: transaction.quantity,
          confirmedAt: transaction.timestamp,
        });
        // Clear pending transactions — we have a new baseline
        this.pendingTransactions.set(transaction.itemId, []);
        break;
    }

    item.currentQuantity = newQuantity;
    item.lastInferredAt = transaction.timestamp;

    // Update status based on quantity
    const defaults = getCategoryDefaults(item.category);
    const threshold = defaults.lowStockThreshold;
    if (newQuantity <= 0) {
      item.status = 'out';
    } else if (newQuantity <= threshold * LOW_STOCK_MULTIPLIER) {
      item.status = 'low';
    } else {
      item.status = 'ok';
    }
  }

  /**
   * Records a physical confirmation of stock quantity.
   * Resets the inference baseline to this confirmed value.
   *
   * @param itemId - The item confirmed
   * @param quantity - Confirmed physical quantity
   * @param confirmedAt - When the confirmation occurred (defaults to now)
   */
  confirmQuantity(itemId: string, quantity: number, confirmedAt: Date = new Date()): void {
    const item = this.items.get(itemId);
    if (!item) return;

    this.confirmedState.set(itemId, { quantity, confirmedAt });
    this.pendingTransactions.set(itemId, []);
    item.currentQuantity = quantity;
    item.lastConfirmedAt = confirmedAt;

    // Update confidence to high immediately after confirmation
    item.confidenceLevel = 'high';

    // Update status
    const defaults = getCategoryDefaults(item.category);
    const threshold = defaults.lowStockThreshold;
    if (quantity <= 0) {
      item.status = 'out';
    } else if (quantity <= threshold * LOW_STOCK_MULTIPLIER) {
      item.status = 'low';
    } else {
      item.status = 'ok';
    }
  }

  /**
   * Returns estimates for all tracked items, sorted by confidence ASC
   * (lowest confidence first — these need the most attention).
   *
   * @param asOf - Reference date (defaults to now)
   * @returns Array of StockEstimate sorted by confidence level and staleDays DESC
   */
  getAll(asOf: Date = new Date()): StockEstimate[] {
    const estimates = Array.from(this.items.keys()).map((id) => this.getEstimate(id, asOf));

    const confidenceOrder: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };
    return estimates.sort((a, b) => {
      const cDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (cDiff !== 0) return cDiff;
      return b.staleDays - a.staleDays;
    });
  }

  /**
   * Registers an item with the stock level engine.
   * @param item - The item to track
   */
  registerItem(item: Item): void {
    this.items.set(item.id, { ...item });
    // If item has a confirmed quantity (e.g. from initial scan), record it
    if (item.lastConfirmedAt) {
      this.confirmedState.set(item.id, {
        quantity: item.currentQuantity,
        confirmedAt: item.lastConfirmedAt,
      });
    }
  }

  /**
   * Updates item metadata (name, category, location) without affecting quantity.
   * @param itemId - Item to update
   * @param updates - Partial Item fields to update
   */
  updateItemMetadata(itemId: string, updates: Partial<Pick<Item, 'name' | 'category' | 'location' | 'frozen'>>): void {
    const item = this.items.get(itemId);
    if (!item) return;
    Object.assign(item, updates);
  }

  /**
   * Returns a tracked item by ID.
   * @param itemId - Item to retrieve
   * @returns Item or undefined
   */
  getItem(itemId: string): Item | undefined {
    return this.items.get(itemId);
  }

  /**
   * Returns all tracked items.
   * @returns Array of all tracked Item records
   */
  getAllItems(): Item[] {
    return Array.from(this.items.values());
  }

  /**
   * Returns items that will be predicted to run out within N days.
   * @param withinDays - Lookahead window
   * @param asOf - Reference date (defaults to now)
   * @returns Array of itemIds predicted to run out
   */
  getItemsPredictedToRunOut(withinDays: number, asOf: Date = new Date()): string[] {
    const future = new Date(asOf);
    future.setDate(future.getDate() + withinDays);

    return Array.from(this.items.keys()).filter((itemId) => {
      const item = this.items.get(itemId)!;
      const current = this.getEstimate(itemId, asOf);
      if (current.estimatedQuantity <= 0) return false;

      const projected = this.consumptionEngine.projectConsumption(
        itemId,
        item.category,
        asOf,
        future
      );
      return current.estimatedQuantity - projected <= 0;
    });
  }
}
