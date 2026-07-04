import { describe, it, expect, beforeEach } from 'vitest';
import { ConsumptionRateEngine } from '../consumption';

describe('ConsumptionRateEngine', () => {
  let engine: ConsumptionRateEngine;

  beforeEach(() => {
    engine = new ConsumptionRateEngine(0.3);
  });

  describe('getRate — fallback to category default', () => {
    it('returns category default when no data points', () => {
      const rate = engine.getRate('item-1', 'dairy');
      // dairy default is 0.29
      expect(rate.dailyRate).toBeCloseTo(0.29);
      expect(rate.dataPointCount).toBe(0);
      expect(rate.confidenceScore).toBe(0);
    });

    it('returns category default when fewer than 3 data points', () => {
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      const rate = engine.getRate('item-1', 'dairy');
      // 2 data points — should still use category default
      expect(rate.dailyRate).toBeCloseTo(0.29, 1);
      expect(rate.dataPointCount).toBe(2);
    });
  });

  describe('updateRate — exponential smoothing', () => {
    it('updates rate with alpha=0.3 blending', () => {
      // First point: blends with category default (dairy = 0.29)
      // Observed: 1 unit / 1 day = 1.0/day
      // new_rate = 0.3 * 1.0 + 0.7 * 0.29 = 0.3 + 0.203 = 0.503
      const r1 = engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 1 });
      expect(r1.dailyRate).toBeCloseTo(0.503, 2);
      expect(r1.dataPointCount).toBe(1);
    });

    it('increases rate when consumption increases', () => {
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 7 });
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 7 });
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 7 });
      const base = engine.getRate('item-1', 'dairy').dailyRate;

      engine.updateRate('item-1', 'dairy', { quantity: 2, durationDays: 7 });
      const higher = engine.getRate('item-1', 'dairy').dailyRate;
      expect(higher).toBeGreaterThan(base);
    });

    it('confidence increases with each data point', () => {
      for (let i = 0; i < 10; i++) {
        engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      }
      const rate = engine.getRate('item-1', 'dairy');
      expect(rate.confidenceScore).toBe(1.0);
    });

    it('confidence is capped at 1.0 with more than 10 points', () => {
      for (let i = 0; i < 15; i++) {
        engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      }
      expect(engine.getRate('item-1', 'dairy').confidenceScore).toBe(1.0);
    });

    it('does not produce negative rates', () => {
      engine.updateRate('item-1', 'dairy', { quantity: 0, durationDays: 1 });
      expect(engine.getRate('item-1', 'dairy').dailyRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('projectConsumption', () => {
    it('projects zero for zero-length window', () => {
      const now = new Date();
      expect(engine.projectConsumption('item-1', 'dairy', now, now)).toBe(0);
    });

    it('blends item rate with category default when low confidence', () => {
      // No data points — all category default
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-08');
      const projected = engine.projectConsumption('item-1', 'dairy', from, to);
      // 7 days × 0.29 = ~2.03
      expect(projected).toBeCloseTo(2.03, 1);
    });

    it('uses item rate at high confidence', () => {
      for (let i = 0; i < 10; i++) {
        engine.updateRate('item-1', 'dairy', { quantity: 2, durationDays: 1 });
      }
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-02');
      const projected = engine.projectConsumption('item-1', 'dairy', from, to);
      // At high confidence, should be close to item rate (which converges on ~2/day)
      expect(projected).toBeGreaterThan(1.5);
    });
  });

  describe('penaliseConfidence', () => {
    it('reduces data point count by penalty fraction', () => {
      for (let i = 0; i < 10; i++) {
        engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      }
      expect(engine.getRate('item-1', 'dairy').confidenceScore).toBe(1.0);
      engine.penaliseConfidence('item-1', 'dairy', 0.2);
      expect(engine.getRate('item-1', 'dairy').confidenceScore).toBeLessThan(1.0);
    });
  });

  describe('load / dump', () => {
    it('round-trips rates', () => {
      engine.updateRate('item-1', 'dairy', { quantity: 1, durationDays: 3 });
      const dumped = engine.dump();
      const fresh = new ConsumptionRateEngine(0.3);
      fresh.load(dumped);
      expect(fresh.getRate('item-1', 'dairy').dailyRate).toBeCloseTo(
        engine.getRate('item-1', 'dairy').dailyRate,
        5
      );
    });
  });
});
