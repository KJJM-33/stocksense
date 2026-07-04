/**
 * StockSense Intelligence Engine — Drift Detector
 *
 * Detects when the inferred stock level has diverged from the last confirmed quantity
 * beyond a category-defined threshold. Drift happens because:
 *   - Consumption rate model is imperfect
 *   - Items were used without being logged
 *   - Multiple people shop/use items without coordination
 *
 * Drift score: 0 = no drift, 1 = maximum drift.
 * Drift threshold is category-specific (tight for perishables, relaxed for stable goods).
 */

import type { Category, ConfidenceLevel } from './types';
import type { StockLevelEngine } from './stock-level';
import { getCategoryDefaults } from './categories';

export type DriftAction = 'reconcile' | 'flag' | 'ignore';

export interface DriftAlert {
  itemId: string;
  driftScore: number;
  /** Absolute divergence: inferred − confirmed (negative = less stock than expected) */
  magnitude: number;
  /** Divergence as a percentage of last confirmed quantity */
  magnitudePct: number | null;
  /** Recommended action for the UI layer */
  recommendedAction: DriftAction;
  /** Why this drift action is recommended */
  reason: string;
}

export class DriftDetector {
  constructor(private stockEngine: StockLevelEngine) {}

  /**
   * Checks drift for a specific item.
   * Compares last confirmed quantity to current inferred quantity.
   * Returns a DriftAlert if divergence exceeds the category threshold.
   *
   * @param itemId - The item to check
   * @param category - The item's category (determines threshold)
   * @param asOf - Reference date (defaults to now)
   * @returns DriftAlert if drift detected, null if within acceptable range
   */
  check(itemId: string, category: Category, asOf: Date = new Date()): DriftAlert | null {
    const estimate = this.stockEngine.getEstimate(itemId, asOf);

    // Can't calculate drift without a confirmed baseline
    if (estimate.lastConfirmedAt === null || estimate.basis === 'default') {
      return null;
    }

    const defaults = getCategoryDefaults(category);
    const item = this.stockEngine.getItem(itemId);
    if (!item) return null;

    const confirmedQuantity = item.currentQuantity; // last known confirmed state
    const inferredQuantity = estimate.estimatedQuantity;
    const magnitude = inferredQuantity - confirmedQuantity;
    const magnitudePct = confirmedQuantity > 0 ? Math.abs(magnitude) / confirmedQuantity : null;

    const driftScore = this.getDriftScore(itemId, category, asOf);

    // Below threshold — no alert needed
    if (magnitudePct !== null && Math.abs(magnitudePct) < defaults.driftThreshold) {
      return null;
    }
    // If confirmed quantity is 0 and inferred > 0 — that's drift
    if (magnitudePct === null && Math.abs(magnitude) < defaults.lowStockThreshold) {
      return null;
    }

    const recommendedAction = this.recommendAction(driftScore, estimate.staleDays, category);
    const reason = this.buildReason(magnitude, magnitudePct, estimate.staleDays);

    return {
      itemId,
      driftScore,
      magnitude,
      magnitudePct,
      recommendedAction,
      reason,
    };
  }

  /**
   * Returns a numeric drift score for an item (0–1).
   * Composed from:
   *   - Quantity divergence vs threshold (60% weight)
   *   - Time since last confirmation vs category cadence (40% weight)
   *
   * @param itemId - The item to score
   * @param category - The item's category
   * @param asOf - Reference date (defaults to now)
   * @returns Drift score 0–1 (higher = more drifted)
   */
  getDriftScore(itemId: string, category: Category, asOf: Date = new Date()): number {
    const estimate = this.stockEngine.getEstimate(itemId, asOf);
    const defaults = getCategoryDefaults(category);
    const item = this.stockEngine.getItem(itemId);
    if (!item || !estimate.lastConfirmedAt) return 0;

    // Component 1: quantity divergence (relative to threshold)
    const confirmedQuantity = item.currentQuantity;
    const inferredQuantity = estimate.estimatedQuantity;
    const magnitudePct =
      confirmedQuantity > 0
        ? Math.abs(inferredQuantity - confirmedQuantity) / confirmedQuantity
        : 0;
    const quantityScore = Math.min(magnitudePct / defaults.driftThreshold, 1);

    // Component 2: time-based staleness
    const cadenceScore = Math.min(
      estimate.staleDays / defaults.reconciliationCadenceDays,
      1
    );

    return 0.6 * quantityScore + 0.4 * cadenceScore;
  }

  /**
   * Runs drift checks across all tracked items.
   *
   * @param items - Array of {itemId, category} to check
   * @param asOf - Reference date (defaults to now)
   * @returns Array of DriftAlerts for items above their drift threshold
   */
  checkAll(
    items: Array<{ itemId: string; category: Category }>,
    asOf: Date = new Date()
  ): DriftAlert[] {
    const alerts: DriftAlert[] = [];
    for (const { itemId, category } of items) {
      const alert = this.check(itemId, category, asOf);
      if (alert) alerts.push(alert);
    }
    // Sort by drift score DESC — most drifted items first
    return alerts.sort((a, b) => b.driftScore - a.driftScore);
  }

  private recommendAction(
    driftScore: number,
    staleDays: number,
    category: Category
  ): DriftAction {
    const defaults = getCategoryDefaults(category);

    // Stale beyond reconciliation cadence = must reconcile
    if (staleDays >= defaults.reconciliationCadenceDays * 2) return 'reconcile';
    // High drift score = flag for attention
    if (driftScore >= 0.7) return 'reconcile';
    if (driftScore >= 0.4) return 'flag';
    return 'ignore';
  }

  private buildReason(
    magnitude: number,
    magnitudePct: number | null,
    staleDays: number
  ): string {
    const pctStr = magnitudePct !== null ? `${(magnitudePct * 100).toFixed(0)}%` : 'unknown %';
    const direction = magnitude < 0 ? 'less stock than expected' : 'more stock than expected';
    return `${pctStr} divergence (${direction}); last confirmed ${staleDays.toFixed(1)} days ago`;
  }
}
