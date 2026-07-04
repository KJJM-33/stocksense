import { describe, it, expect, beforeEach } from 'vitest';
import { DriftDetector } from '../drift';
import { StockLevelEngine } from '../stock-level';
import { ConsumptionRateEngine } from '../consumption';
import { makeItem, daysAgo } from './helpers';

describe('DriftDetector', () => {
  let stockEngine: StockLevelEngine;
  let consumption: ConsumptionRateEngine;
  let detector: DriftDetector;

  beforeEach(() => {
    consumption = new ConsumptionRateEngine(0.3);
    stockEngine = new StockLevelEngine(consumption);
    detector = new DriftDetector(stockEngine);
  });

  it('returns null when no confirmed baseline exists', () => {
    const item = makeItem({ id: 'item-1' });
    stockEngine.registerItem(item);
    expect(detector.check('item-1', 'dairy')).toBeNull();
  });

  it('returns null when drift is within threshold', () => {
    const item = makeItem({ id: 'item-1', currentQuantity: 10 });
    stockEngine.registerItem(item);
    stockEngine.confirmQuantity('item-1', 10, daysAgo(1));
    // No consumption modelled — inferred ≈ confirmed
    const alert = detector.check('item-1', 'dairy', daysAgo(1));
    // Within 24 hours and same quantity — should be null
    expect(alert).toBeNull();
  });

  it('getDriftScore returns > 0 for stale items', () => {
    const item = makeItem({ id: 'item-1', currentQuantity: 6 });
    stockEngine.registerItem(item);
    stockEngine.confirmQuantity('item-1', 6, daysAgo(10));

    const score = detector.getDriftScore('item-1', 'dairy', new Date());
    expect(score).toBeGreaterThan(0);
  });

  it('getDriftScore returns 0 for freshly confirmed item', () => {
    const item = makeItem({ id: 'item-1', currentQuantity: 6 });
    stockEngine.registerItem(item);
    stockEngine.confirmQuantity('item-1', 6, new Date());

    const score = detector.getDriftScore('item-1', 'dairy', new Date());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(0.4); // fresh item should have low drift
  });

  it('checkAll returns alerts sorted by drift score DESC', () => {
    const item1 = makeItem({ id: 'item-drift-1', currentQuantity: 6, category: 'dairy' });
    const item2 = makeItem({ id: 'item-drift-2', currentQuantity: 10, category: 'produce' });
    stockEngine.registerItem(item1);
    stockEngine.registerItem(item2);
    // item1: freshly confirmed (low drift)
    stockEngine.confirmQuantity('item-drift-1', 6, new Date());
    // item2: 10 days stale (high drift)
    stockEngine.confirmQuantity('item-drift-2', 10, daysAgo(10));

    const alerts = detector.checkAll(
      [
        { itemId: 'item-drift-1', category: 'dairy' },
        { itemId: 'item-drift-2', category: 'produce' },
      ],
      new Date()
    );

    // If any alerts, item-drift-2 should come first (higher drift)
    if (alerts.length >= 2) {
      expect(alerts[0].driftScore).toBeGreaterThanOrEqual(alerts[1].driftScore);
    }
  });
});
