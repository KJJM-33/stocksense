import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver } from '../conflict';
import type { ConflictInput } from '../conflict';

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  const now = new Date('2026-07-01T12:00:00Z');
  const earlier = new Date('2026-07-01T11:00:00Z');

  function makeInput(source: ConflictInput['source'], ts: Date, payload = {}): ConflictInput {
    return { source, timestamp: ts, payload };
  }

  describe('Precedence rule 1: manual correction always wins', () => {
    it('manual beats tap regardless of timestamp', () => {
      const tapInput = makeInput('tap', now, { status: 'out' });
      const manualInput = makeInput('manual', earlier, { quantity: 6 });
      const conflict = resolver.resolve(tapInput, manualInput, 'item-1', 'status_disagreement');
      expect(conflict.resolution).toBe('input2'); // manual is input2 and wins
    });

    it('manual beats photo when manual is input1', () => {
      const manualInput = makeInput('manual', earlier, { quantity: 6 });
      const photoInput = makeInput('photo', now, { quantity: 0 });
      const conflict = resolver.resolve(manualInput, photoInput, 'item-1', 'quantity_disagreement');
      expect(conflict.resolution).toBe('input1'); // manual is input1 and wins
    });
  });

  describe('Precedence rule 2: photo beats tap', () => {
    it('photo beats tap regardless of order', () => {
      const tapInput = makeInput('tap', now, { status: 'low' });
      const photoInput = makeInput('photo', earlier, { quantity: 0 });
      const conflict = resolver.resolve(tapInput, photoInput, 'item-1', 'status_disagreement');
      expect(conflict.resolution).toBe('input2'); // photo is input2
    });
  });

  describe('Precedence rule 3: receipt beats whatsapp', () => {
    it('receipt beats whatsapp', () => {
      const waInput = makeInput('whatsapp', now, { quantity: 3 });
      const receiptInput = makeInput('receipt', earlier, { quantity: 12 });
      const conflict = resolver.resolve(waInput, receiptInput, 'item-1', 'quantity_disagreement');
      expect(conflict.resolution).toBe('input2'); // receipt wins
    });
  });

  describe('Precedence rule 4: more recent wins when same source', () => {
    it('more recent tap wins over older tap', () => {
      const oldTap = makeInput('tap', earlier, { status: 'low' });
      const newTap = makeInput('tap', now, { status: 'out' });
      const conflict = resolver.resolve(oldTap, newTap, 'item-1', 'status_disagreement');
      expect(conflict.resolution).toBe('input2'); // newer is input2
    });
  });

  describe('Precedence rule 5: all conflicts logged, nothing silently discarded', () => {
    it('logs both inputs in every conflict', () => {
      const input1 = makeInput('tap', earlier, { status: 'low' });
      const input2 = makeInput('tap', now, { status: 'out' });
      const conflict = resolver.resolve(input1, input2, 'item-1', 'status_disagreement');
      expect(conflict.input1).toEqual(input1.payload);
      expect(conflict.input2).toEqual(input2.payload);
    });
  });

  describe('doConflict', () => {
    it('detects status disagreement', () => {
      const a = makeInput('tap', now, { status: 'low' });
      const b = makeInput('tap', now, { status: 'out' });
      expect(resolver.doConflict(a, b)).toBe(true);
    });

    it('does not flag agreement as conflict', () => {
      const a = makeInput('tap', now, { status: 'low' });
      const b = makeInput('tap', now, { status: 'low' });
      expect(resolver.doConflict(a, b)).toBe(false);
    });
  });

  describe('getUnresolved', () => {
    it('returns only pending conflicts', () => {
      const a = makeInput('tap', now, { status: 'out' });
      const b = makeInput('tap', earlier, { status: 'low' });
      // Auto-resolved conflict
      resolver.resolve(a, b, 'item-1', 'status_disagreement');
      // Pending conflict
      resolver.createPending('item-2', 'name_match', { name: 'Milk 2L' }, { name: 'Milk' });

      expect(resolver.getUnresolved()).toHaveLength(1);
      expect(resolver.getUnresolved()[0].itemId).toBe('item-2');
    });
  });

  describe('manualResolve', () => {
    it('marks conflict as resolved by user', () => {
      const conflict = resolver.createPending('item-1', 'name_match', {}, {});
      const resolved = resolver.manualResolve(conflict.id, 'input1');
      expect(resolved?.resolution).toBe('input1');
      expect(resolved?.resolvedBy).toBe('user');
      expect(resolver.getUnresolved()).toHaveLength(0);
    });
  });
});
