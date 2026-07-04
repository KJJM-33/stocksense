/**
 * StockSense Intelligence Engine — Reconciliation Engine
 *
 * Handles reconciliation events: the process of comparing confirmed physical stock
 * against the inferred ledger and resolving variances.
 *
 * Reconciliation is the bridge between the transaction ledger and physical reality.
 * It is triggered by:
 *   - Photo scan (fridge camera → Claude vision → item list with quantities)
 *   - Manual audit (user counts items)
 *   - WhatsApp Sunday check-in (soft reconciliation, partial)
 *   - Scheduled (weekly, or when drift score exceeds threshold)
 *
 * Variance analysis:
 *   Variance = Confirmed − Inferred
 *   If |variance %| > 10%: update consumption rate model
 *   If |variance %| > 30%: flag as significant, log for review
 */

import type {
  Category,
  ItemSnapshot,
  ReconciliationEvent,
  ReconciliationTrigger,
} from './types';
import type { StockLevelEngine } from './stock-level';
import type { ConsumptionRateEngine } from './consumption';
import { getCategoryDefaults } from './categories';
import { randomUUID } from 'crypto';

const RATE_UPDATE_THRESHOLD = 0.1; // 10% variance triggers rate update
const SIGNIFICANT_VARIANCE_THRESHOLD = 0.3; // 30% variance is flagged

export interface ReconciliationResult {
  event: ReconciliationEvent;
  /** Items where variance exceeded the significant threshold */
  significantVariances: ItemSnapshot[];
  /** Items where the consumption rate was updated */
  ratesUpdated: string[];
}

export class ReconciliationEngine {
  private events: ReconciliationEvent[] = [];
  /** Last reconciliation date per item */
  private lastReconciled: Map<string, Date> = new Map();

  constructor(
    private stockEngine: StockLevelEngine,
    private consumptionEngine: ConsumptionRateEngine
  ) {}

  /**
   * Processes a reconciliation event.
   * For each item in the snapshot:
   *   1. Compares confirmed quantity to inferred estimate
   *   2. Calculates variance
   *   3. Updates consumption rate if variance > RATE_UPDATE_THRESHOLD
   *   4. Sets confirmed state to the new physical count
   *
   * @param triggeredBy - What triggered this reconciliation
   * @param householdId - The household being reconciled
   * @param snapshots - Confirmed quantities for each item in the reconciliation
   * @param categories - Map of itemId → category (needed for rate update)
   * @param asOf - Reference date (defaults to now)
   * @returns ReconciliationResult with event record and variance summary
   */
  triggerReconciliation(
    triggeredBy: ReconciliationTrigger,
    householdId: string,
    snapshots: Array<{ itemId: string; confirmedQuantity: number }>,
    categories: Map<string, Category>,
    asOf: Date = new Date()
  ): ReconciliationResult {
    const itemSnapshots: ItemSnapshot[] = [];
    const varianceMap: Record<string, number> = {};
    const significantVariances: ItemSnapshot[] = [];
    const ratesUpdated: string[] = [];

    for (const { itemId, confirmedQuantity } of snapshots) {
      const estimate = this.stockEngine.getEstimate(itemId, asOf);
      const inferredQuantity = estimate.estimatedQuantity;
      const variance = confirmedQuantity - inferredQuantity;
      const variancePct =
        inferredQuantity > 0 ? Math.abs(variance) / inferredQuantity : null;

      const snapshot: ItemSnapshot = {
        itemId,
        confirmedQuantity,
        inferredQuantity,
        variance,
        variancePct,
      };
      itemSnapshots.push(snapshot);
      varianceMap[itemId] = variance;

      // Update consumption rate if variance is meaningful
      if (variancePct !== null && variancePct > RATE_UPDATE_THRESHOLD) {
        const category = categories.get(itemId) ?? 'uncategorised';
        const lastConfirmed = estimate.lastConfirmedAt;

        if (lastConfirmed) {
          const daysSinceConfirmed =
            (asOf.getTime() - lastConfirmed.getTime()) / (1000 * 60 * 60 * 24);

          if (daysSinceConfirmed > 0) {
            // Actual consumption = inferred opening − confirmed closing
            // (purchases are already reflected in the inferred quantity)
            const actualConsumption = Math.max(0, inferredQuantity - confirmedQuantity + variance);
            if (actualConsumption >= 0) {
              this.consumptionEngine.updateRate(itemId, category, {
                quantity: actualConsumption,
                durationDays: daysSinceConfirmed,
              });
              ratesUpdated.push(itemId);
            }
          }
        }
      }

      if (variancePct !== null && variancePct > SIGNIFICANT_VARIANCE_THRESHOLD) {
        significantVariances.push(snapshot);
      }

      // Update the confirmed state in stock engine
      this.stockEngine.confirmQuantity(itemId, confirmedQuantity, asOf);
      this.lastReconciled.set(itemId, asOf);
    }

    const event: ReconciliationEvent = {
      id: randomUUID(),
      householdId,
      triggeredBy,
      itemSnapshots,
      varianceMap,
      timestamp: asOf,
    };

    this.events.push(event);

    return {
      event,
      significantVariances,
      ratesUpdated,
    };
  }

  /**
   * Calculates variance between a confirmed quantity and the current inferred estimate.
   *
   * @param itemId - The item to check
   * @param confirmedQty - The physically confirmed quantity
   * @param asOf - Reference date (defaults to now)
   * @returns Variance details
   */
  calculateVariance(
    itemId: string,
    confirmedQty: number,
    asOf: Date = new Date()
  ): { absolute: number; percentage: number | null; isSignificant: boolean } {
    const estimate = this.stockEngine.getEstimate(itemId, asOf);
    const inferred = estimate.estimatedQuantity;
    const absolute = confirmedQty - inferred;
    const percentage = inferred > 0 ? Math.abs(absolute) / inferred : null;

    return {
      absolute,
      percentage,
      isSignificant: percentage !== null && percentage > SIGNIFICANT_VARIANCE_THRESHOLD,
    };
  }

  /**
   * Determines whether an item should be reconciled now.
   * Returns true when any of these conditions are met:
   *   - Last reconciliation > 7 days ago AND drift score > 0.3
   *   - Item is high-value category (meat, fish)
   *   - Item expiry within 3 days
   *
   * @param itemId - The item to evaluate
   * @param category - The item's category
   * @param driftScore - Current drift score (0–1) from DriftDetector
   * @param expiringWithin3Days - Whether any batch expires within 3 days
   * @param asOf - Reference date (defaults to now)
   * @returns true if reconciliation should be triggered
   */
  shouldTrigger(
    itemId: string,
    category: Category,
    driftScore: number,
    expiringWithin3Days: boolean,
    asOf: Date = new Date()
  ): boolean {
    // High-value perishables always trigger reconciliation check
    if (category === 'meat' || category === 'fish') return true;

    // Expiry urgency
    if (expiringWithin3Days) return true;

    const lastReconciled = this.lastReconciled.get(itemId);
    if (!lastReconciled) return true; // Never reconciled

    const daysSinceReconciled =
      (asOf.getTime() - lastReconciled.getTime()) / (1000 * 60 * 60 * 24);

    // Overdue + drifted
    if (daysSinceReconciled > 7 && driftScore > 0.3) return true;

    // Category-specific cadence
    const defaults = getCategoryDefaults(category);
    if (daysSinceReconciled > defaults.reconciliationCadenceDays * 2) return true;

    return false;
  }

  /**
   * Returns the most recent reconciliation event.
   * @returns Most recent ReconciliationEvent, or null if none
   */
  getLatestEvent(): ReconciliationEvent | null {
    if (this.events.length === 0) return null;
    return this.events[this.events.length - 1];
  }

  /**
   * Returns all reconciliation events (for audit log).
   * @returns Array of all ReconciliationEvent records
   */
  getAll(): ReconciliationEvent[] {
    return this.events;
  }

  /**
   * Returns when an item was last reconciled.
   * @param itemId - The item to query
   * @returns Date of last reconciliation, or null if never
   */
  getLastReconciled(itemId: string): Date | null {
    return this.lastReconciled.get(itemId) ?? null;
  }

  /**
   * Loads reconciliation events from persistent storage.
   * @param events - Array of ReconciliationEvent records to load
   */
  load(events: ReconciliationEvent[]): void {
    this.events.push(...events);
    // Rebuild lastReconciled from events
    for (const event of events) {
      for (const snapshot of event.itemSnapshots) {
        const existing = this.lastReconciled.get(snapshot.itemId);
        if (!existing || event.timestamp > existing) {
          this.lastReconciled.set(snapshot.itemId, event.timestamp);
        }
      }
    }
  }
}
