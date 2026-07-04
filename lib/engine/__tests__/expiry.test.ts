import { describe, it, expect, beforeEach } from 'vitest';
import { ExpiryEngine } from '../expiry';
import { FIFOTracker } from '../fifo';
import { daysFrom, daysAgo } from './helpers';

describe('ExpiryEngine', () => {
  let fifo: FIFOTracker;
  let expiry: ExpiryEngine;
  const itemId = 'item-yoghurt';
  const householdId = 'hh-1';

  beforeEach(() => {
    fifo = new FIFOTracker();
    expiry = new ExpiryEngine(fifo);
  });

  describe('getExpiry — priority chain', () => {
    it('returns manual override first', () => {
      const batch = fifo.addBatch({
        itemId,
        quantity: 2,
        purchaseDate: new Date(),
        expiryDate: daysFrom(7),
        source: 'receipt',
      });
      const override = daysFrom(3);
      expiry.setManualOverride(batch.id, override);
      expect(expiry.getExpiry(itemId, 'dairy', new Date(), batch.id)).toEqual(override);
    });

    it('returns batch expiry when no manual override', () => {
      const batchExpiry = daysFrom(7);
      const batch = fifo.addBatch({
        itemId,
        quantity: 2,
        purchaseDate: new Date(),
        expiryDate: batchExpiry,
        source: 'receipt',
      });
      expect(expiry.getExpiry(itemId, 'dairy', new Date(), batch.id)).toEqual(batchExpiry);
    });

    it('falls back to category default when no batch expiry', () => {
      const purchaseDate = new Date('2026-07-01');
      const result = expiry.getExpiry(itemId, 'dairy', purchaseDate);
      // dairy default = 7 days
      const expected = new Date('2026-07-08');
      expect(result?.toDateString()).toBe(expected.toDateString());
    });

    it('returns null for non-expiring category (household)', () => {
      expect(expiry.getExpiry('item-toilet-roll', 'household', new Date())).toBeNull();
    });
  });

  describe('applyFreezeExtension', () => {
    it('extends expiry by category freezer days', () => {
      const batch = fifo.addBatch({
        itemId: 'item-chicken',
        quantity: 2,
        purchaseDate: new Date(),
        expiryDate: daysFrom(3),
        source: 'receipt',
      });
      const frozenAt = new Date();
      const newExpiry = expiry.applyFreezeExtension(batch.id, 'item-chicken', 'meat', frozenAt);
      // meat freezer extension = 90 days
      const expected = daysFrom(90, frozenAt);
      expect(newExpiry?.toDateString()).toBe(expected.toDateString());
      expect(fifo.getActiveBatches('item-chicken')[0].wasFrozen).toBe(true);
    });

    it('returns null for non-freezable category', () => {
      const batch = fifo.addBatch({
        itemId: 'item-canned',
        quantity: 3,
        purchaseDate: new Date(),
        expiryDate: daysFrom(730),
        source: 'manual',
      });
      const result = expiry.applyFreezeExtension(batch.id, 'item-canned', 'canned', new Date());
      expect(result).toBeNull();
    });
  });

  describe('runExpirySweep', () => {
    it('generates waste events for expired batches', () => {
      fifo.addBatch({
        itemId,
        quantity: 2,
        purchaseDate: daysAgo(10),
        expiryDate: daysAgo(2),
        source: 'receipt',
      });

      const wasteEvents = expiry.runExpirySweep([itemId], householdId, new Date());
      expect(wasteEvents).toHaveLength(1);
      expect(wasteEvents[0].quantity).toBe(2);
      expect(wasteEvents[0].transaction.type).toBe('waste');
      expect(wasteEvents[0].transaction.source).toBe('system');
    });

    it('exhausts the batch after sweep', () => {
      fifo.addBatch({
        itemId,
        quantity: 3,
        purchaseDate: daysAgo(8),
        expiryDate: daysAgo(1),
        source: 'receipt',
      });
      expiry.runExpirySweep([itemId], householdId, new Date());
      expect(fifo.getTotalStock(itemId)).toBe(0);
    });

    it('does not waste non-expired batches', () => {
      fifo.addBatch({
        itemId,
        quantity: 2,
        purchaseDate: new Date(),
        expiryDate: daysFrom(7),
        source: 'receipt',
      });
      const events = expiry.runExpirySweep([itemId], householdId, new Date());
      expect(events).toHaveLength(0);
    });
  });

  describe('getExpiringItems', () => {
    it('returns items expiring within window, sorted soonest first', () => {
      fifo.addBatch({ itemId: 'item-a', quantity: 1, purchaseDate: daysAgo(5), expiryDate: daysFrom(1), source: 'receipt' });
      fifo.addBatch({ itemId: 'item-b', quantity: 1, purchaseDate: daysAgo(2), expiryDate: daysFrom(3), source: 'receipt' });

      const expiring = expiry.getExpiringItems(['item-a', 'item-b'], 7, new Date());
      expect(expiring.length).toBeGreaterThanOrEqual(2);
      expect(expiring[0].itemId).toBe('item-a'); // expires sooner
    });

    it('excludes items beyond the window', () => {
      fifo.addBatch({ itemId: 'item-far', quantity: 1, purchaseDate: new Date(), expiryDate: daysFrom(30), source: 'receipt' });
      const expiring = expiry.getExpiringItems(['item-far'], 7, new Date());
      expect(expiring).toHaveLength(0);
    });
  });
});
