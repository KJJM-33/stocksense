/**
 * Test helpers — factories for creating test data
 */
import type { Item, Transaction, PurchaseBatch } from '../types';

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: id('item'),
    householdId: 'hh-1',
    name: 'Test Item',
    category: 'dairy',
    unit: 'units',
    currentQuantity: 6,
    status: 'ok',
    confidenceLevel: 'high',
    lastConfirmedAt: null,
    lastInferredAt: null,
    location: 'fridge',
    frozen: false,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: id('tx'),
    itemId: 'item-1',
    householdId: 'hh-1',
    type: 'purchase',
    quantity: 1,
    timestamp: new Date(),
    source: 'manual',
    ...overrides,
  };
}

/** Returns a date N days from a reference (default: now) */
export function daysFrom(n: number, ref: Date = new Date()): Date {
  const d = new Date(ref);
  d.setDate(d.getDate() + n);
  return d;
}

/** Returns a date N days ago from a reference (default: now) */
export function daysAgo(n: number, ref: Date = new Date()): Date {
  return daysFrom(-n, ref);
}
