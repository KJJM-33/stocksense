import { describe, it, expect, beforeEach } from 'vitest';
import { StockLevelEngine } from '../stock-level';
import { ConsumptionRateEngine } from '../consumption';
import { makeItem, daysAgo, daysFrom } from './helpers';

describe('StockLevelEngine', () => {
  let engine: StockLevelEngine;
  let consumption: ConsumptionRateEngine;

  beforeEach(() => {
    consumption = new ConsumptionRateEngine(0.3);
    engine = new StockLevelEngine(consumption);
  });

  describe('getEstimate — unregistered item', () => {
    it('returns zero with low confidence for unknown item', () => {
      const est = engine.getEstimate('unknown');
      expect(est.estimatedQuantity).toBe(0);
      expect(est.confidence).toBe('low');
    });
  });

  describe('getEstimate — confidence decay', () => {
    it('returns high confidence when confirmed < 1 day ago', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 6 });
      engine.registerItem(item);
      engine.confirmQuantity('item-1', 6, new Date());
      const est = engine.getEstimate('item-1', new Date());
      expect(est.confidence).toBe('high');
    });

    it('returns medium confidence when confirmed 3 days ago', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 6 });
      engine.registerItem(item);
      engine.confirmQuantity('item-1', 6, daysAgo(3));
      const est = engine.getEstimate('item-1', new Date());
      expect(est.confidence).toBe('medium');
    });

    it('returns low confidence when confirmed 10 days ago', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 6 });
      engine.registerItem(item);
      engine.confirmQuantity('item-1', 6, daysAgo(10));
      const est = engine.getEstimate('item-1', new Date());
      expect(est.confidence).toBe('low');
    });

    it('returns stale basis when no confirmation for > 14 days', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 6 });
      engine.registerItem(item);
      engine.confirmQuantity('item-1', 6, daysAgo(20));
      const est = engine.getEstimate('item-1', new Date());
      expect(est.basis).toBe('stale');
    });
  });

  describe('applyTransaction', () => {
    it('increases quantity on purchase', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 2 });
      engine.registerItem(item);
      engine.applyTransaction({
        id: 'tx-1', itemId: 'item-1', householdId: 'hh-1',
        type: 'purchase', quantity: 6, timestamp: new Date(), source: 'receipt',
      });
      expect(engine.getItem('item-1')?.currentQuantity).toBe(8);
    });

    it('decreases quantity on consumption, clamped at 0', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 3 });
      engine.registerItem(item);
      engine.applyTransaction({
        id: 'tx-1', itemId: 'item-1', householdId: 'hh-1',
        type: 'consumption', quantity: 10, timestamp: new Date(), source: 'tap',
      });
      expect(engine.getItem('item-1')?.currentQuantity).toBe(0);
    });

    it('correction sets quantity exactly and confirms', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 100 });
      engine.registerItem(item);
      engine.confirmQuantity('item-1', 100, daysAgo(5));
      engine.applyTransaction({
        id: 'tx-1', itemId: 'item-1', householdId: 'hh-1',
        type: 'correction', quantity: 4, timestamp: new Date(), source: 'manual',
      });
      const est = engine.getEstimate('item-1', new Date());
      expect(est.estimatedQuantity).toBe(4);
      expect(est.confidence).toBe('high');
    });

    it('sets status to out when quantity reaches 0', () => {
      const item = makeItem({ id: 'item-1', currentQuantity: 1 });
      engine.registerItem(item);
      engine.applyTransaction({
        id: 'tx-1', itemId: 'item-1', householdId: 'hh-1',
        type: 'consumption', quantity: 1, timestamp: new Date(), source: 'tap',
      });
      expect(engine.getItem('item-1')?.status).toBe('out');
    });
  });

  describe('getAll — sorting', () => {
    it('returns estimates sorted with lowest confidence first', () => {
      const item1 = makeItem({ id: 'itm-conf-1', currentQuantity: 5 });
      const item2 = makeItem({ id: 'itm-conf-2', currentQuantity: 5 });
      engine.registerItem(item1);
      engine.registerItem(item2);

      engine.confirmQuantity('itm-conf-1', 5, new Date()); // high confidence
      engine.confirmQuantity('itm-conf-2', 5, daysAgo(10)); // low confidence

      const all = engine.getAll();
      const ids = all.map((e) => e.itemId);
      expect(ids.indexOf('itm-conf-2')).toBeLessThan(ids.indexOf('itm-conf-1'));
    });
  });

  describe('getItemsPredictedToRunOut', () => {
    it('identifies items with high daily rate and low stock', () => {
      // Seed a high consumption rate for item-fast
      for (let i = 0; i < 10; i++) {
        consumption.updateRate('item-fast', 'dairy', { quantity: 2, durationDays: 1 });
      }
      const item = makeItem({ id: 'item-fast', currentQuantity: 3, category: 'dairy' });
      engine.registerItem(item);
      engine.confirmQuantity('item-fast', 3, new Date());

      const runout = engine.getItemsPredictedToRunOut(3);
      expect(runout).toContain('item-fast');
    });
  });
});
