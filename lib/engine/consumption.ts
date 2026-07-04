/**
 * StockSense Intelligence Engine — Consumption Rate Engine
 *
 * Models how quickly household items are consumed using exponential smoothing.
 * Formula: new_rate = α × new_data_point + (1 − α) × old_rate
 * α = 0.3: weights recent data at 30%, history at 70% — stable but responsive.
 *
 * Confidence score = min(dataPointCount / 10, 1.0)
 * Falls back to category default when dataPointCount < 3.
 */

import type { Category, ConsumptionRate } from './types';
import { getCategoryDefaults } from './categories';

/** Smoothing factor — higher = more weight on recent data */
const DEFAULT_ALPHA = 0.3;

/** Minimum data points before we trust the item-level rate over category default */
const MIN_TRUSTED_POINTS = 3;

/** Data points needed for full confidence (score = 1.0) */
const FULL_CONFIDENCE_POINTS = 10;

/**
 * A single consumption observation: quantity consumed over a time span.
 */
export interface ConsumptionDataPoint {
  quantity: number;
  /** Duration in days over which the quantity was consumed */
  durationDays: number;
}

/**
 * In-memory store of consumption rates.
 * In production, this is persisted via the repository layer above the engine.
 */
export class ConsumptionRateEngine {
  private rates: Map<string, ConsumptionRate> = new Map();
  private alpha: number;

  /**
   * @param alpha - Exponential smoothing factor (default 0.3). Range 0–1.
   *   Higher = more responsive to recent data, less stable.
   */
  constructor(alpha: number = DEFAULT_ALPHA) {
    this.alpha = alpha;
  }

  /**
   * Adds a consumption observation and recalculates the rolling rate.
   * Uses exponential smoothing: new_rate = α × new_point + (1 − α) × old_rate
   *
   * @param itemId - The item to update
   * @param category - Item's category (used to seed the first data point)
   * @param dataPoint - The consumption observation to incorporate
   * @returns Updated ConsumptionRate
   */
  updateRate(itemId: string, category: Category, dataPoint: ConsumptionDataPoint): ConsumptionRate {
    const existing = this.rates.get(itemId);
    const categoryDefault = getCategoryDefaults(category).defaultDailyRate;

    // Derived daily rate from this observation
    const observedDailyRate =
      dataPoint.durationDays > 0 ? dataPoint.quantity / dataPoint.durationDays : 0;

    let newDailyRate: number;
    let newDataPointCount: number;

    if (!existing) {
      // First observation: blend with category default (we don't fully trust 1 point)
      newDailyRate = this.alpha * observedDailyRate + (1 - this.alpha) * categoryDefault;
      newDataPointCount = 1;
    } else {
      // Subsequent observations: exponential smoothing against historical rate
      newDailyRate = this.alpha * observedDailyRate + (1 - this.alpha) * existing.dailyRate;
      newDataPointCount = existing.dataPointCount + 1;
    }

    // Clamp to non-negative
    newDailyRate = Math.max(0, newDailyRate);

    const rate: ConsumptionRate = {
      itemId,
      dailyRate: newDailyRate,
      confidenceScore: Math.min(newDataPointCount / FULL_CONFIDENCE_POINTS, 1.0),
      dataPointCount: newDataPointCount,
      lastUpdated: new Date(),
      categoryDefault,
    };

    this.rates.set(itemId, rate);
    return rate;
  }

  /**
   * Returns the current consumption rate for an item.
   * Falls back to category default if fewer than MIN_TRUSTED_POINTS data points.
   *
   * @param itemId - The item to look up
   * @param category - Category (for fallback default)
   * @returns ConsumptionRate — always returns something (category default at minimum)
   */
  getRate(itemId: string, category: Category): ConsumptionRate {
    const existing = this.rates.get(itemId);
    const categoryDefault = getCategoryDefaults(category).defaultDailyRate;

    if (!existing || existing.dataPointCount < MIN_TRUSTED_POINTS) {
      // Not enough history — return category default with low confidence
      return {
        itemId,
        dailyRate: categoryDefault,
        confidenceScore: existing ? existing.confidenceScore : 0,
        dataPointCount: existing?.dataPointCount ?? 0,
        lastUpdated: existing?.lastUpdated ?? new Date(),
        categoryDefault,
      };
    }

    return existing;
  }

  /**
   * Projects total consumption between two dates using the current rate.
   * If the rate confidence is low, blends with category default.
   *
   * @param itemId - The item to project for
   * @param category - Item's category
   * @param fromDate - Start of projection window
   * @param toDate - End of projection window
   * @returns Projected quantity consumed (non-negative)
   */
  projectConsumption(
    itemId: string,
    category: Category,
    fromDate: Date,
    toDate: Date
  ): number {
    if (toDate <= fromDate) return 0;

    const daysDelta = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    const rate = this.getRate(itemId, category);

    // Blend item rate with category default based on confidence
    const { confidenceScore, dailyRate, categoryDefault } = rate;
    const blendedRate =
      confidenceScore * dailyRate + (1 - confidenceScore) * categoryDefault;

    return Math.max(0, blendedRate * daysDelta);
  }

  /**
   * Seeds an item's rate from a bulk import or initial stock scan.
   * Used when we have a known rate but no individual observations.
   *
   * @param itemId - Item to seed
   * @param category - Item's category
   * @param knownRate - Known daily rate
   * @param confidence - Confidence score (0–1) for this seed data
   */
  seedRate(itemId: string, category: Category, knownRate: number, confidence: number): void {
    const dataPointCount = Math.round(confidence * FULL_CONFIDENCE_POINTS);
    this.rates.set(itemId, {
      itemId,
      dailyRate: knownRate,
      confidenceScore: confidence,
      dataPointCount,
      lastUpdated: new Date(),
      categoryDefault: getCategoryDefaults(category).defaultDailyRate,
    });
  }

  /**
   * Reduces confidence for an item (used when a manual correction reveals data quality issues).
   *
   * @param itemId - Item to penalise
   * @param category - Item's category
   * @param penaltyFraction - How much to reduce confidence (0–1). Default 0.1.
   */
  penaliseConfidence(itemId: string, category: Category, penaltyFraction = 0.1): void {
    const existing = this.rates.get(itemId);
    if (!existing) return;
    const reduced = Math.max(0, existing.dataPointCount * (1 - penaltyFraction));
    this.rates.set(itemId, {
      ...existing,
      dataPointCount: Math.round(reduced),
      confidenceScore: Math.min(Math.round(reduced) / FULL_CONFIDENCE_POINTS, 1.0),
    });
  }

  /**
   * Loads rates from persistent storage (repository layer).
   * @param rates - Array of ConsumptionRate records to load
   */
  load(rates: ConsumptionRate[]): void {
    for (const rate of rates) {
      this.rates.set(rate.itemId, rate);
    }
  }

  /**
   * Returns all current rates (for persistence).
   * @returns Array of all ConsumptionRate records
   */
  dump(): ConsumptionRate[] {
    return Array.from(this.rates.values());
  }

  /**
   * Returns the alpha (smoothing factor) in use.
   * @returns The alpha value
   */
  getAlpha(): number {
    return this.alpha;
  }
}
