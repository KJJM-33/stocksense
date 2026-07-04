/**
 * StockSense Intelligence Engine — Category Defaults
 *
 * Category-level defaults for expiry, consumption rates, units, and drift thresholds.
 * Tuned using WRAP/Love Food Hate Waste UK research findings (2024-2025):
 * - Bread: 900,000 tonnes wasted/year (21.3% waste rate) → tight 3-day default
 * - Produce: 22.6% waste rate (potatoes) → 7-day default, highest drift sensitivity
 * - Dairy/milk: 490,000 tonnes wasted/year → 7-day default, daily consumption tracking
 * - Meat/Fish: high value, short shelf life → 2-3 days, highest reconciliation priority
 */

import type { Category } from './types';

export interface CategoryDefaults {
  /** Default shelf life in days after purchase. null = does not expire. */
  expiryDays: number | null;
  /** Default daily consumption rate in units/day (household of ~2 adults) */
  defaultDailyRate: number;
  /** Default unit of measure */
  defaultUnit: string;
  /**
   * How quickly confidence decays without new data.
   * Rate of decay per day: 0 = instant (always stale), 1 = never decays.
   * Confidence after N days = max(0, 1 - N * decayRate)
   * High perishability = higher decay (need fresh confirmation more often).
   */
  confidenceDecayRate: number;
  /**
   * Minimum threshold below which item is considered "low".
   * In the item's default unit.
   */
  lowStockThreshold: number;
  /**
   * Drift threshold: how far inferred vs confirmed can diverge (as fraction of last confirmed)
   * before raising a drift alert. Lower = more sensitive.
   * Produce/dairy: 0.2 (20% drift triggers alert)
   * Dry goods/household: 0.5 (50% drift before alert)
   */
  driftThreshold: number;
  /**
   * How many days of no confirmation before scheduling a reconciliation check.
   */
  reconciliationCadenceDays: number;
  /**
   * If frozen, how many extra days to add to the expiry.
   */
  freezerExtensionDays: number | null;
}

const CATEGORY_DEFAULTS: Record<Category, CategoryDefaults> = {
  dairy: {
    // Milk: 7-day default (UK standard 4-pint whole milk)
    // Cheese: longer but this is the conservative end for dairy
    expiryDays: 7,
    defaultDailyRate: 0.29, // ~2 pints/week household
    defaultUnit: 'units',
    confidenceDecayRate: 0.12, // confidence halves ~8 days without confirmation
    lowStockThreshold: 1,
    driftThreshold: 0.2,
    reconciliationCadenceDays: 3,
    freezerExtensionDays: 30,
  },

  produce: {
    // Conservative default for fresh produce (carrots, broccoli, salad etc)
    // WRAP data: 22.6% waste rate — needs tight tracking
    expiryDays: 7,
    defaultDailyRate: 0.14, // 1 unit/week
    defaultUnit: 'units',
    confidenceDecayRate: 0.14, // confidence halves ~7 days — produce drifts fast
    lowStockThreshold: 1,
    driftThreshold: 0.2,
    reconciliationCadenceDays: 3,
    freezerExtensionDays: 90,
  },

  meat: {
    // Raw meat: 2-3 days in fridge. WRAP: high value, short shelf life = worst waste outcome
    expiryDays: 3,
    defaultDailyRate: 0.25, // ~2 portions/week
    defaultUnit: 'portions',
    confidenceDecayRate: 0.25, // very fast decay — expires quickly
    lowStockThreshold: 1,
    driftThreshold: 0.15, // tight — meat is expensive
    reconciliationCadenceDays: 2,
    freezerExtensionDays: 90,
  },

  fish: {
    // Fish is even more perishable than meat
    expiryDays: 2,
    defaultDailyRate: 0.14, // ~1 portion/week
    defaultUnit: 'portions',
    confidenceDecayRate: 0.33, // very fast — expires in 2 days
    lowStockThreshold: 1,
    driftThreshold: 0.15,
    reconciliationCadenceDays: 1,
    freezerExtensionDays: 60,
  },

  bread: {
    // WRAP: 900,000 tonnes/year, 21.3% waste rate — second highest waste category
    // UK standard loaf goes stale in 3-5 days (2 for artisan)
    expiryDays: 4,
    defaultDailyRate: 0.29, // ~2 slices/day household
    defaultUnit: 'slices',
    confidenceDecayRate: 0.14,
    lowStockThreshold: 2,
    driftThreshold: 0.25,
    reconciliationCadenceDays: 3,
    freezerExtensionDays: 30,
  },

  frozen: {
    // Frozen items: long shelf life. Specific freezer extension applied per-item.
    expiryDays: 90,
    defaultDailyRate: 0.07, // ~0.5 portions/week
    defaultUnit: 'portions',
    confidenceDecayRate: 0.02, // very slow decay — frozen items are stable
    lowStockThreshold: 1,
    driftThreshold: 0.4,
    reconciliationCadenceDays: 30,
    freezerExtensionDays: null, // already in freezer
  },

  canned: {
    // Canned goods: very long shelf life (years)
    expiryDays: 730, // 2 years
    defaultDailyRate: 0.05,
    defaultUnit: 'cans',
    confidenceDecayRate: 0.01,
    lowStockThreshold: 1,
    driftThreshold: 0.5,
    reconciliationCadenceDays: 30,
    freezerExtensionDays: null,
  },

  dry_goods: {
    // Rice, pasta, flour, etc. — months of shelf life
    expiryDays: 365,
    defaultDailyRate: 0.07,
    defaultUnit: 'g',
    confidenceDecayRate: 0.005,
    lowStockThreshold: 100,
    driftThreshold: 0.5,
    reconciliationCadenceDays: 30,
    freezerExtensionDays: null,
  },

  beverages: {
    // Juice, soft drinks, squash — varies widely
    expiryDays: 14, // once opened
    defaultDailyRate: 0.14,
    defaultUnit: 'ml',
    confidenceDecayRate: 0.05,
    lowStockThreshold: 200,
    driftThreshold: 0.3,
    reconciliationCadenceDays: 7,
    freezerExtensionDays: null,
  },

  condiments: {
    // Ketchup, mayo, mustard — weeks to months once opened
    expiryDays: 60,
    defaultDailyRate: 0.02,
    defaultUnit: 'ml',
    confidenceDecayRate: 0.01,
    lowStockThreshold: 50,
    driftThreshold: 0.5,
    reconciliationCadenceDays: 14,
    freezerExtensionDays: null,
  },

  household: {
    // Toilet roll, washing up liquid, cleaning products — no expiry
    expiryDays: null,
    defaultDailyRate: 0.14, // ~1 toilet roll/week for household
    defaultUnit: 'units',
    confidenceDecayRate: 0.005, // very stable
    lowStockThreshold: 2,
    driftThreshold: 0.5,
    reconciliationCadenceDays: 30,
    freezerExtensionDays: null,
  },

  uncategorised: {
    // Conservative defaults — better to flag too early than let things expire silently
    expiryDays: 14,
    defaultDailyRate: 0.1,
    defaultUnit: 'units',
    confidenceDecayRate: 0.1,
    lowStockThreshold: 1,
    driftThreshold: 0.3,
    reconciliationCadenceDays: 7,
    freezerExtensionDays: 60,
  },
};

/**
 * Returns the category defaults for a given category.
 * @param category - The item's category
 * @returns CategoryDefaults for the given category
 */
export function getCategoryDefaults(category: Category): CategoryDefaults {
  return CATEGORY_DEFAULTS[category];
}

/**
 * Returns all categories with their defaults.
 * @returns Record of all category defaults
 */
export function getAllCategoryDefaults(): Record<Category, CategoryDefaults> {
  return CATEGORY_DEFAULTS;
}

/**
 * Calculates the expiry date for an item given its category and purchase date.
 * @param category - The item's category
 * @param purchaseDate - When the item was purchased
 * @returns Expiry Date, or null if the category does not expire
 */
export function calculateCategoryExpiry(category: Category, purchaseDate: Date): Date | null {
  const defaults = getCategoryDefaults(category);
  if (defaults.expiryDays === null) return null;
  const expiry = new Date(purchaseDate);
  expiry.setDate(expiry.getDate() + defaults.expiryDays);
  return expiry;
}

/**
 * Calculates the confidence level given how many days have passed since last confirmation.
 * @param category - The item's category (determines decay rate)
 * @param daysSinceConfirmation - Days elapsed since last physical confirmation
 * @returns ConfidenceLevel: 'high' | 'medium' | 'low'
 */
export function calculateConfidenceLevel(
  category: Category,
  daysSinceConfirmation: number
): 'high' | 'medium' | 'low' {
  const { confidenceDecayRate } = getCategoryDefaults(category);
  const confidence = Math.max(0, 1 - daysSinceConfirmation * confidenceDecayRate);
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.3) return 'medium';
  return 'low';
}
