import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationEngine } from '../reconciliation';
import { StockLevelEngine } from '../stock-level';
import { ConsumptionRateEngine } from '../consumption';
import { makeItem, daysAgo } from './helpers';
import type { Category } from '../types';

describe('ReconciliationEngine', () => {
  let consumption: ConsumptionRateEngine;
  let stockEngine: StockLevelEngine;
  let reconciliation: ReconciliationEngine;

  beforeEach(() => {
    consumption = new ConsumptionRateEngine(0.3);
    stockEngine = new StockLevelEngine(consumption);
    reconciliation = new ReconciliationEngine(stockEngine, consumption);
  });

  describe('triggerReconciliation', () => {
    it('creates a reconciliation event with item snapshots', () => {
      const item = makeItem({ id: 'item-milk', currentQuantity: 6, category: 'dairy' });
      stockEngine.registerItem(item);
      stockEngine.confirmQuantity('item-milk', 6, daysAgo(3));

      const categories = new Map<string, Category>([['item-milk', 'dairy']]);
      const result = reconciliation.triggerReconciliation(
        'manual',
        'hh-1',
        [{ itemId: 'item-milk', confirmedQuantity: 4 }],
        categories,
        new Date()
      );

      expect(result.event.triggeredBy).toBe('manual');
      expect(result.event.itemSnapshots).toHaveLength(1);
      expect(result.event.itemSnapshots[0].confirmedQuantity).toBe(4);
      expect(result.event.itemSnapshots[0].variance).toBe(4 - result.event.itemSnapshots[0].inferredQuantity);
    });

    it('updates confirmed state in stock engine after reconciliation', () => {
      const item = makeItem({ id: 'item-eggs', currentQuantity: 12, category: 'produce' });
      stockEngine.registerItem(item);
      stockEngine.confirmQuantity('item-eggs', 12, daysAgo(5));

      const categories = new Map<string, Category>([['item-eggs', 'produce']]);
      reconciliation.triggerReconciliation(
        'photo',
        'hh-1',
        [{ itemId: 'item-eggs', confirmedQuantity: 7 }],
        categories,
        new Date()
      );

      const est = stockEngine.getEstimate('item-eggs', new Date());
      expect(est.estimatedQuantity).toBe(7);
      expect(est.confidence).toBe('high'); // just confirmed
    });

    it('identifies significant variances', () => {
      const item = makeItem({ id: 'item-bread', currentQuantity: 10, category: 'bread' });
      stockEngine.registerItem(item);
      stockEngine.confirmQuantity('item-bread', 10, daysAgo(2));

      const categories = new Map<string, Category>([['item-bread', 'bread']]);
      const result = reconciliation.triggerReconciliation(
        'manual',
        'hh-1',
        [{ itemId: 'item-bread', confirmedQuantity: 2 }], // 80% variance
        categories,
        new Date()
      );

      expect(result.significantVariances.length).toBeGreaterThan(0);
    });
  });

  describe('calculateVariance', () => {
    it('returns absolute and percentage variance', () => {
      const item = makeItem({ id: 'item-v', currentQuantity: 10 });
      stockEngine.registerItem(item);
      stockEngine.confirmQuantity('item-v', 10, daysAgo(1));

      const result = reconciliation.calculateVariance('item-v', 8, new Date());
      expect(result.absolute).toBeLessThan(0); // confirmed < inferred
      expect(result.percentage).toBeGreaterThan(0);
    });
  });

  describe('shouldTrigger', () => {
    it('always triggers for meat category', () => {
      const item = makeItem({ id: 'item-chicken', category: 'meat' });
      stockEngine.registerItem(item);
      expect(reconciliation.shouldTrigger('item-chicken', 'meat', 0, false)).toBe(true);
    });

    it('always triggers for fish category', () => {
      expect(reconciliation.shouldTrigger('item-fish', 'fish', 0, false)).toBe(true);
    });

    it('triggers when last reconciliation > 7 days and drift > 0.3', () => {
      // Register an item so the engine "knows" about it
      const item = makeItem({ id: 'item-drift' });
      stockEngine.registerItem(item);
      // Simulate old reconciliation by loading an old event
      reconciliation.load([{
        id: 'old-rec',
        householdId: 'hh-1',
        triggeredBy: 'manual',
        itemSnapshots: [{ itemId: 'item-drift', confirmedQuantity: 5, inferredQuantity: 5, variance: 0, variancePct: 0 }],
        varianceMap: { 'item-drift': 0 },
        timestamp: daysAgo(10),
      }]);
      expect(reconciliation.shouldTrigger('item-drift', 'dairy', 0.5, false)).toBe(true);
    });

    it('triggers when item expiring within 3 days', () => {
      expect(reconciliation.shouldTrigger('item-x', 'dairy', 0, true)).toBe(true);
    });

    it('does not trigger for fresh, low-drift, non-urgent item', () => {
      const item = makeItem({ id: 'item-fresh' });
      stockEngine.registerItem(item);
      // Simulate recent reconciliation
      reconciliation.load([{
        id: 'rec-fresh',
        householdId: 'hh-1',
        triggeredBy: 'manual',
        itemSnapshots: [{ itemId: 'item-fresh', confirmedQuantity: 5, inferredQuantity: 5, variance: 0, variancePct: 0 }],
        varianceMap: { 'item-fresh': 0 },
        timestamp: new Date(), // today
      }]);
      expect(reconciliation.shouldTrigger('item-fresh', 'dairy', 0.1, false)).toBe(false);
    });
  });
});
