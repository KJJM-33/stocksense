import { describe, it, expect, beforeEach } from 'vitest';
import { FIFOTracker } from '../fifo';
import { daysFrom, daysAgo } from './helpers';

describe('FIFOTracker', () => {
  let tracker: FIFOTracker;
  const itemId = 'item-eggs';

  beforeEach(() => {
    tracker = new FIFOTracker();
  });

  describe('addBatch', () => {
    it('creates a batch with full remaining quantity', () => {
      const batch = tracker.addBatch({
        itemId,
        quantity: 12,
        purchaseDate: new Date(),
        expiryDate: daysFrom(21),
        source: 'receipt',
      });
      expect(batch.remainingQuantity).toBe(12);
      expect(batch.quantity).toBe(12);
    });

    it('maintains purchase-date order when adding out-of-order', () => {
      const older = daysAgo(7);
      const newer = new Date();

      tracker.addBatch({ itemId, quantity: 6, purchaseDate: newer, expiryDate: null, source: 'manual' });
      tracker.addBatch({ itemId, quantity: 3, purchaseDate: older, expiryDate: null, source: 'manual' });

      const batches = tracker.getActiveBatches(itemId);
      expect(batches[0].purchaseDate).toEqual(older);
      expect(batches[1].purchaseDate).toEqual(newer);
    });
  });

  describe('consumeQuantity — FIFO ordering', () => {
    it('consumes from the oldest batch first', () => {
      const older = daysAgo(5);
      const newer = new Date();

      tracker.addBatch({ itemId, quantity: 3, purchaseDate: older, expiryDate: daysFrom(3), source: 'receipt' });
      tracker.addBatch({ itemId, quantity: 12, purchaseDate: newer, expiryDate: daysFrom(21), source: 'receipt' });

      const result = tracker.consumeQuantity(itemId, 3);
      expect(result.totalConsumed).toBe(3);
      expect(result.batchDraws).toHaveLength(1);

      // Older batch should be exhausted
      const batches = tracker.getActiveBatches(itemId);
      expect(batches).toHaveLength(1); // only the newer batch remains
      expect(batches[0].remainingQuantity).toBe(12);
    });

    it('spans across batches when oldest batch is insufficient', () => {
      tracker.addBatch({ itemId, quantity: 3, purchaseDate: daysAgo(10), expiryDate: daysFrom(5), source: 'receipt' });
      tracker.addBatch({ itemId, quantity: 12, purchaseDate: new Date(), expiryDate: daysFrom(21), source: 'receipt' });

      const result = tracker.consumeQuantity(itemId, 5);
      expect(result.totalConsumed).toBe(5);
      expect(result.batchDraws).toHaveLength(2);
      expect(result.batchDraws[0].quantityDrawn).toBe(3);
      expect(result.batchDraws[1].quantityDrawn).toBe(2);
    });

    it('handles stock-out gracefully', () => {
      tracker.addBatch({ itemId, quantity: 2, purchaseDate: new Date(), expiryDate: null, source: 'manual' });
      const result = tracker.consumeQuantity(itemId, 5);
      expect(result.totalConsumed).toBe(2);
      expect(result.stockedOut).toBe(true);
      expect(result.unfulfilledQuantity).toBe(3);
    });

    it('skips expired batches during consumption', () => {
      const pastExpiry = daysAgo(2);
      tracker.addBatch({ itemId, quantity: 5, purchaseDate: daysAgo(10), expiryDate: pastExpiry, source: 'receipt' });
      tracker.addBatch({ itemId, quantity: 10, purchaseDate: daysAgo(1), expiryDate: daysFrom(14), source: 'receipt' });

      const now = new Date();
      const result = tracker.consumeQuantity(itemId, 3, now);
      // Should skip the expired batch and consume from the fresh one
      expect(result.totalConsumed).toBe(3);
      expect(result.batchDraws[0].quantityDrawn).toBe(3);
    });
  });

  describe('getTotalStock', () => {
    it('sums remaining quantities across batches', () => {
      tracker.addBatch({ itemId, quantity: 3, purchaseDate: daysAgo(3), expiryDate: null, source: 'manual' });
      tracker.addBatch({ itemId, quantity: 12, purchaseDate: new Date(), expiryDate: null, source: 'manual' });
      tracker.consumeQuantity(itemId, 3);
      // After consuming 3 from oldest batch (3): oldest exhausted, newest at 12
      expect(tracker.getTotalStock(itemId)).toBe(12);
    });
  });

  describe('getExpiredBatches', () => {
    it('returns only batches past their expiry with remaining stock', () => {
      tracker.addBatch({ itemId, quantity: 2, purchaseDate: daysAgo(10), expiryDate: daysAgo(2), source: 'receipt' });
      tracker.addBatch({ itemId, quantity: 5, purchaseDate: daysAgo(1), expiryDate: daysFrom(7), source: 'receipt' });

      const expired = tracker.getExpiredBatches(itemId);
      expect(expired).toHaveLength(1);
      expect(expired[0].remainingQuantity).toBe(2);
    });

    it('does not return fully consumed batches', () => {
      const batch = tracker.addBatch({ itemId, quantity: 2, purchaseDate: daysAgo(10), expiryDate: daysAgo(2), source: 'receipt' });
      // Consume via exhaustBatch (expired batches are skipped by consumeQuantity, so exhaust directly)
      tracker.exhaustBatch(batch.id, itemId);
      expect(tracker.getExpiredBatches(itemId)).toHaveLength(0);
    });
  });

  describe('extendBatchExpiry', () => {
    it('updates the batch expiry date', () => {
      const batch = tracker.addBatch({
        itemId,
        quantity: 2,
        purchaseDate: new Date(),
        expiryDate: daysFrom(3),
        source: 'receipt',
      });
      const newExpiry = daysFrom(93); // +90 days frozen
      tracker.extendBatchExpiry(batch.id, itemId, newExpiry);

      const batches = tracker.getActiveBatches(itemId);
      expect(batches[0].expiryDate).toEqual(newExpiry);
      expect(batches[0].wasFrozen).toBe(true);
    });
  });

  describe('load / dump', () => {
    it('round-trips batches', () => {
      tracker.addBatch({ itemId, quantity: 6, purchaseDate: new Date(), expiryDate: null, source: 'manual' });
      const dumped = tracker.dump();

      const fresh = new FIFOTracker();
      fresh.load(dumped);
      expect(fresh.getTotalStock(itemId)).toBe(6);
    });
  });
});
