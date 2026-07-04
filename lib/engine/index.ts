/**
 * StockSense Intelligence Engine — Public API
 *
 * The StockEngine class is the single public entry point for all engine operations.
 * It composes all sub-modules and routes inputs to the correct handlers.
 *
 * Architecture:
 *   Input → processInput() → route to handler → run drift check → return EngineOutput
 *
 * All sub-modules are storage-agnostic. Supabase integration lives in the repository
 * layer above this — the engine deals only in plain TypeScript types.
 *
 * Core equation enforced by every handler:
 *   Opening Stock + Purchases − Consumption = Closing Stock
 */

import type {
  Alert,
  AlertType,
  Category,
  EngineInput,
  EngineOutput,
  Item,
  ItemStatus,
  ShoppingListItem,
  StockEstimate,
  Transaction,
} from './types';
import { ConsumptionRateEngine } from './consumption';
import { FIFOTracker } from './fifo';
import { StockLevelEngine } from './stock-level';
import { DriftDetector } from './drift';
import { ConflictResolver } from './conflict';
import { ExpiryEngine } from './expiry';
import { ReconciliationEngine } from './reconciliation';
import { getCategoryDefaults } from './categories';
import { randomUUID } from 'crypto';

const SHOPPING_LIST_LOOKAHEAD_DAYS = 3;
const EXPIRY_ALERT_DAYS = 3;

export class StockEngine {
  public readonly consumption: ConsumptionRateEngine;
  public readonly fifo: FIFOTracker;
  public readonly stockLevel: StockLevelEngine;
  public readonly drift: DriftDetector;
  public readonly conflict: ConflictResolver;
  public readonly expiry: ExpiryEngine;
  public readonly reconciliation: ReconciliationEngine;

  private householdId: string;
  private alerts: Map<string, Alert> = new Map();
  /** Idempotency keys already processed */
  private processedKeys: Set<string> = new Set();

  constructor(householdId: string, alpha = 0.3) {
    this.householdId = householdId;
    this.consumption = new ConsumptionRateEngine(alpha);
    this.fifo = new FIFOTracker();
    this.stockLevel = new StockLevelEngine(this.consumption);
    this.drift = new DriftDetector(this.stockLevel);
    this.conflict = new ConflictResolver();
    this.expiry = new ExpiryEngine(this.fifo);
    this.reconciliation = new ReconciliationEngine(this.stockLevel, this.consumption);
  }

  /**
   * Main entry point. Routes any EngineInput to the correct handler,
   * runs a drift check after every mutation, and returns a full EngineOutput.
   *
   * @param input - Any EngineInput (tap, purchase, consumption, photo, correction, etc.)
   * @returns EngineOutput with updated state, alerts, conflicts, and transactions
   */
  async processInput(input: EngineInput): Promise<EngineOutput> {
    // Check idempotency key for inputs that carry one
    if ('idempotencyKey' in input && input.idempotencyKey) {
      if (this.processedKeys.has(input.idempotencyKey)) {
        return this.emptyOutput(input.idempotencyKey);
      }
    }

    let output: EngineOutput;

    switch (input.type) {
      case 'tap_update':
        output = this.handleTapUpdate(input);
        break;
      case 'purchase':
        output = this.handlePurchase(input);
        break;
      case 'consumption_log':
        output = this.handleConsumptionLog(input);
        break;
      case 'photo_reconciliation':
        output = this.handlePhotoReconciliation(input);
        break;
      case 'manual_correction':
        output = this.handleManualCorrection(input);
        break;
      case 'status_change':
        output = this.handleStatusChange(input);
        break;
      case 'check_in':
        output = this.handleCheckIn(input);
        break;
      default:
        output = this.emptyOutput(null);
    }

    // Record idempotency key
    if ('idempotencyKey' in input && input.idempotencyKey) {
      this.processedKeys.add(input.idempotencyKey);
    }

    // Run drift check on all affected items and append any alerts
    const affectedItemIds = output.stateUpdates.map((u) => u.itemId);
    const driftAlerts = this.runPostProcessing(affectedItemIds, input.type === 'tap_update' ? (input as { timestamp: Date }).timestamp : new Date());
    output.alerts.push(...driftAlerts);

    return output;
  }

  /**
   * Returns the current stock estimate for a single item or all items.
   *
   * @param itemId - If provided, returns estimate for this item only
   * @param asOf - Reference date (defaults to now)
   * @returns Single StockEstimate or array of all estimates (sorted by confidence ASC)
   */
  getStatus(itemId?: string, asOf: Date = new Date()): StockEstimate | StockEstimate[] {
    if (itemId) return this.stockLevel.getEstimate(itemId, asOf);
    return this.stockLevel.getAll(asOf);
  }

  /**
   * Returns all active alerts: expiry warnings, drift flags, unresolved conflicts.
   * Dismissed alerts are excluded.
   *
   * @returns Array of Alert records, sorted by severity DESC
   */
  getAlerts(): Alert[] {
    const active = Array.from(this.alerts.values()).filter((a) => !a.dismissed);
    const severityOrder: Record<string, number> = { critical: 2, warning: 1, info: 0 };
    return active.sort((a, b) => (severityOrder[b.severity] ?? 0) - (severityOrder[a.severity] ?? 0));
  }

  /**
   * Returns the current shopping list: items below threshold or predicted to run out
   * within SHOPPING_LIST_LOOKAHEAD_DAYS days.
   *
   * @param asOf - Reference date (defaults to now)
   * @returns Array of ShoppingListItem records
   */
  getShoppingList(asOf: Date = new Date()): ShoppingListItem[] {
    const items = this.stockLevel.getAllItems();
    const shoppingList: ShoppingListItem[] = [];

    for (const item of items) {
      const estimate = this.stockLevel.getEstimate(item.id, asOf);
      const defaults = getCategoryDefaults(item.category);

      if (estimate.estimatedQuantity <= 0) {
        shoppingList.push({
          itemId: item.id,
          itemName: item.name,
          category: item.category,
          quantityNeeded: defaults.lowStockThreshold * 2,
          unit: item.unit,
          reason: 'below_threshold',
          predictedRunoutDate: null,
          addedAt: asOf,
        });
        continue;
      }

      // Check if predicted to run out within lookahead window
      const runoutIds = this.stockLevel.getItemsPredictedToRunOut(
        SHOPPING_LIST_LOOKAHEAD_DAYS,
        asOf
      );
      if (runoutIds.includes(item.id)) {
        const rate = this.consumption.getRate(item.id, item.category);
        const daysLeft = rate.dailyRate > 0
          ? estimate.estimatedQuantity / rate.dailyRate
          : SHOPPING_LIST_LOOKAHEAD_DAYS;

        const runoutDate = new Date(asOf);
        runoutDate.setDate(runoutDate.getDate() + Math.floor(daysLeft));

        shoppingList.push({
          itemId: item.id,
          itemName: item.name,
          category: item.category,
          quantityNeeded: defaults.lowStockThreshold * 2,
          unit: item.unit,
          reason: 'predicted_runout',
          predictedRunoutDate: runoutDate,
          addedAt: asOf,
        });
      }
    }

    return shoppingList;
  }

  /**
   * Registers an item with the engine so it can be tracked.
   * Call this when a new item is created (initial scan, receipt, or manual add).
   *
   * @param item - The item to register
   */
  registerItem(item: Item): void {
    this.stockLevel.registerItem(item);
  }

  /**
   * Dismisses an alert by ID.
   * @param alertId - The alert to dismiss
   */
  dismissAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert) {
      this.alerts.set(alertId, { ...alert, dismissed: true });
    }
  }

  // ─── Input Handlers ─────────────────────────────────────────────────────────

  private handleTapUpdate(input: Extract<EngineInput, { type: 'tap_update' }>): EngineOutput {
    const transactions: Transaction[] = [];

    // Check for conflicts with recent tap on same item
    const item = this.stockLevel.getItem(input.itemId);

    if (input.status === 'used_some') {
      // Update consumption rate
      this.consumption.updateRate(input.itemId, item?.category ?? 'uncategorised', {
        quantity: 1,
        durationDays: 1,
      });
      const tx: Transaction = {
        id: randomUUID(),
        itemId: input.itemId,
        householdId: input.householdId,
        type: 'consumption',
        quantity: 1,
        timestamp: input.timestamp,
        source: 'tap',
      };
      this.stockLevel.applyTransaction(tx);
      transactions.push(tx);
    } else if (input.status === 'out') {
      // Set quantity to 0 — explicit correction
      const tx: Transaction = {
        id: randomUUID(),
        itemId: input.itemId,
        householdId: input.householdId,
        type: 'correction',
        quantity: 0,
        timestamp: input.timestamp,
        source: 'tap',
      };
      this.stockLevel.applyTransaction(tx);
      transactions.push(tx);
    } else {
      // 'low' — update status without changing quantity
      // Quantity stays the same; just mark the item as 'low'
      if (item) {
        item.status = 'low';
        item.lastInferredAt = input.timestamp;
      }
      // Still log a transaction for the audit trail (type=correction, quantity=current)
      const currentQty = item?.currentQuantity ?? 0;
      const tx: Transaction = {
        id: randomUUID(),
        itemId: input.itemId,
        householdId: input.householdId,
        type: 'correction',
        quantity: currentQty,
        timestamp: input.timestamp,
        source: 'tap',
        notes: 'tap:low — status updated, quantity unchanged',
      };
      // Apply without re-triggering the full applyTransaction (which would recalculate status)
      // We set the status directly above; just push the audit tx
      transactions.push(tx);
    }

    const estimate = this.stockLevel.getEstimate(input.itemId, input.timestamp);

    return {
      stateUpdates: [estimate],
      transactions,
      alerts: [],
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handlePurchase(input: Extract<EngineInput, { type: 'purchase' }>): EngineOutput {
    const item = this.stockLevel.getItem(input.itemId);
    const category = item?.category ?? 'uncategorised';

    // Add FIFO batch
    const batch = this.fifo.addBatch({
      itemId: input.itemId,
      quantity: input.quantity,
      purchaseDate: input.timestamp,
      expiryDate: input.expiryDate ?? null,
      source: input.source,
    });

    const tx: Transaction = {
      id: randomUUID(),
      itemId: input.itemId,
      householdId: input.householdId,
      type: 'purchase',
      quantity: input.quantity,
      timestamp: input.timestamp,
      source: input.source,
      batchId: batch.id,
      expiryDate: input.expiryDate,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
    };

    this.stockLevel.applyTransaction(tx);

    // After purchase, item is confirmed at new level
    const newTotal = this.fifo.getTotalStock(input.itemId);
    this.stockLevel.confirmQuantity(input.itemId, newTotal, input.timestamp);

    const estimate = this.stockLevel.getEstimate(input.itemId, input.timestamp);
    const alerts: Alert[] = [];

    // Check if batch expires soon
    if (input.expiryDate) {
      const daysUntilExpiry =
        (input.expiryDate.getTime() - input.timestamp.getTime()) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry <= EXPIRY_ALERT_DAYS) {
        alerts.push(this.createAlert(input.itemId, 'expiring_soon', `Batch expires in ${Math.round(daysUntilExpiry)} days`, 'warning'));
      }
    }

    return {
      stateUpdates: [estimate],
      transactions: [tx],
      alerts,
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handleConsumptionLog(
    input: Extract<EngineInput, { type: 'consumption_log' }>
  ): EngineOutput {
    const item = this.stockLevel.getItem(input.itemId);
    const category = item?.category ?? 'uncategorised';

    // Consume from FIFO batches
    const result = this.fifo.consumeQuantity(input.itemId, input.quantity, input.timestamp);

    // Update consumption rate
    this.consumption.updateRate(input.itemId, category, {
      quantity: result.totalConsumed,
      durationDays: 1,
    });

    const tx: Transaction = {
      id: randomUUID(),
      itemId: input.itemId,
      householdId: input.householdId,
      type: 'consumption',
      quantity: result.totalConsumed,
      timestamp: input.timestamp,
      source: input.source,
      batchId: result.batchDraws[0]?.batchId,
      notes: input.notes,
    };

    this.stockLevel.applyTransaction(tx);
    const estimate = this.stockLevel.getEstimate(input.itemId, input.timestamp);

    const alerts: Alert[] = [];
    if (estimate.estimatedQuantity <= 0) {
      alerts.push(this.createAlert(input.itemId, 'out_of_stock', `${item?.name ?? input.itemId} is now out of stock`, 'warning'));
    }

    return {
      stateUpdates: [estimate],
      transactions: [tx],
      alerts,
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handlePhotoReconciliation(
    input: Extract<EngineInput, { type: 'photo_reconciliation' }>
  ): EngineOutput {
    const categories = new Map<string, Category>();
    for (const { itemId } of input.items) {
      const item = this.stockLevel.getItem(itemId);
      if (item) categories.set(itemId, item.category);
    }

    const result = this.reconciliation.triggerReconciliation(
      'photo',
      input.householdId,
      input.items.map(({ itemId, confirmedQuantity }) => ({ itemId, confirmedQuantity })),
      categories,
      input.timestamp
    );

    const stateUpdates = input.items.map(({ itemId }) =>
      this.stockLevel.getEstimate(itemId, input.timestamp)
    );

    const alerts: Alert[] = result.significantVariances.map((v) =>
      this.createAlert(
        v.itemId,
        'drift_detected',
        `Large variance detected: confirmed ${v.confirmedQuantity}, inferred was ${v.inferredQuantity.toFixed(1)}`,
        'warning'
      )
    );

    return {
      stateUpdates,
      transactions: [],
      alerts,
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handleManualCorrection(
    input: Extract<EngineInput, { type: 'manual_correction' }>
  ): EngineOutput {
    // Manual correction is ground truth — always wins
    const tx: Transaction = {
      id: randomUUID(),
      itemId: input.itemId,
      householdId: input.householdId,
      type: 'correction',
      quantity: input.confirmedQuantity,
      timestamp: input.timestamp,
      source: 'manual',
      notes: input.notes,
    };

    this.stockLevel.applyTransaction(tx);
    // applyTransaction handles confirmQuantity for corrections
    const estimate = this.stockLevel.getEstimate(input.itemId, input.timestamp);

    return {
      stateUpdates: [estimate],
      transactions: [tx],
      alerts: [],
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handleStatusChange(
    input: Extract<EngineInput, { type: 'status_change' }>
  ): EngineOutput {
    const item = this.stockLevel.getItem(input.itemId);
    const category = item?.category ?? 'uncategorised';
    const alerts: Alert[] = [];
    const transactions: Transaction[] = [];

    switch (input.changeType) {
      case 'frozen': {
        // Extend expiry for all active batches
        const batches = this.fifo.getActiveBatches(input.itemId);
        for (const batch of batches) {
          const newExpiry = this.expiry.applyFreezeExtension(
            batch.id,
            input.itemId,
            category,
            input.timestamp
          );
          if (newExpiry) {
            alerts.push(
              this.createAlert(
                input.itemId,
                'expiring_soon',
                `Frozen: expiry extended to ${newExpiry.toISOString().split('T')[0]}`,
                'info'
              )
            );
          }
        }
        this.stockLevel.updateItemMetadata(input.itemId, { frozen: true, location: 'freezer' });
        break;
      }

      case 'thawed': {
        this.stockLevel.updateItemMetadata(input.itemId, { frozen: false, location: 'fridge' });
        if (input.expiryOverride) {
          const batches = this.fifo.getActiveBatches(input.itemId);
          for (const batch of batches) {
            this.expiry.setManualOverride(batch.id, input.expiryOverride);
          }
        }
        break;
      }

      case 'returned': {
        const returnQty = input.quantity ?? 1;
        const tx: Transaction = {
          id: randomUUID(),
          itemId: input.itemId,
          householdId: input.householdId,
          type: 'return',
          quantity: returnQty,
          timestamp: input.timestamp,
          source: 'manual',
          notes: input.notes,
        };
        this.stockLevel.applyTransaction(tx);
        transactions.push(tx);
        break;
      }

      case 'gift_received': {
        const giftQty = input.quantity ?? 1;
        const batch = this.fifo.addBatch({
          itemId: input.itemId,
          quantity: giftQty,
          purchaseDate: input.timestamp,
          expiryDate: input.expiryOverride ?? null,
          source: 'manual',
        });
        const tx: Transaction = {
          id: randomUUID(),
          itemId: input.itemId,
          householdId: input.householdId,
          type: 'gift',
          quantity: giftQty,
          timestamp: input.timestamp,
          source: 'manual',
          batchId: batch.id,
          notes: input.notes,
        };
        this.stockLevel.applyTransaction(tx);
        transactions.push(tx);
        break;
      }

      case 'cooked': {
        // Cooked item gets a manual expiry override (e.g. cooked rice: 3 days)
        if (input.expiryOverride) {
          const batches = this.fifo.getActiveBatches(input.itemId);
          for (const batch of batches) {
            this.expiry.setManualOverride(batch.id, input.expiryOverride);
          }
        }
        break;
      }
    }

    const estimate = this.stockLevel.getEstimate(input.itemId, input.timestamp);

    return {
      stateUpdates: [estimate],
      transactions,
      alerts,
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  private handleCheckIn(input: Extract<EngineInput, { type: 'check_in' }>): EngineOutput {
    const stateUpdates: StockEstimate[] = [];
    const alerts: Alert[] = [];

    for (const { itemId, status, quantityEstimate } of input.items) {
      const item = this.stockLevel.getItem(itemId);
      if (!item) continue;

      if (quantityEstimate !== undefined) {
        // Soft confirmation — not as authoritative as photo, but better than nothing
        // Use a lower-confidence confirmation (doesn't fully reset the baseline)
        const tx: Transaction = {
          id: randomUUID(),
          itemId,
          householdId: input.householdId,
          type: 'correction',
          quantity: quantityEstimate,
          timestamp: input.timestamp,
          source: input.source === 'whatsapp' ? 'whatsapp' : 'manual',
        };
        this.stockLevel.applyTransaction(tx);
      }

      stateUpdates.push(this.stockLevel.getEstimate(itemId, input.timestamp));
    }

    return {
      stateUpdates,
      transactions: [],
      alerts,
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: null,
    };
  }

  // ─── Post-processing ─────────────────────────────────────────────────────────

  private runPostProcessing(itemIds: string[], asOf: Date): Alert[] {
    const alerts: Alert[] = [];

    for (const itemId of itemIds) {
      const item = this.stockLevel.getItem(itemId);
      if (!item) continue;

      // Drift check
      const driftAlert = this.drift.check(itemId, item.category, asOf);
      if (driftAlert && driftAlert.recommendedAction !== 'ignore') {
        alerts.push(
          this.createAlert(
            itemId,
            'drift_detected',
            `Drift detected: ${driftAlert.reason}`,
            driftAlert.recommendedAction === 'reconcile' ? 'warning' : 'info'
          )
        );
      }

      // Expiry check
      const expiringBatches = this.expiry.getExpiringItems([itemId], EXPIRY_ALERT_DAYS, asOf);
      for (const expiring of expiringBatches) {
        alerts.push(
          this.createAlert(
            itemId,
            'expiring_soon',
            `${item.name} expires in ${expiring.daysUntilExpiry.toFixed(0)} days (${expiring.remainingQuantity} ${item.unit} remaining)`,
            expiring.daysUntilExpiry <= 1 ? 'critical' : 'warning'
          )
        );
      }
    }

    return alerts;
  }

  private createAlert(
    itemId: string | undefined,
    type: AlertType,
    message: string,
    severity: Alert['severity']
  ): Alert {
    const alert: Alert = {
      id: randomUUID(),
      itemId,
      type,
      message,
      severity,
      raisedAt: new Date(),
      expiresAt: null,
      dismissed: false,
    };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  private emptyOutput(duplicateKey: string | null): EngineOutput {
    return {
      stateUpdates: [],
      transactions: [],
      alerts: [],
      conflicts: [],
      shoppingListUpdates: [],
      wasteEvents: [],
      duplicateDetected: duplicateKey,
    };
  }
}

// Re-export all sub-modules and types for consumers that need them
export { ConsumptionRateEngine } from './consumption';
export { FIFOTracker } from './fifo';
export { StockLevelEngine } from './stock-level';
export { DriftDetector } from './drift';
export { ConflictResolver } from './conflict';
export { ExpiryEngine } from './expiry';
export { ReconciliationEngine } from './reconciliation';
export { getCategoryDefaults, getAllCategoryDefaults, calculateCategoryExpiry, calculateConfidenceLevel } from './categories';
export type * from './types';
