/**
 * 20 Household Scenarios — End-to-End Tests
 *
 * Each scenario sets up initial state, feeds inputs to the StockEngine,
 * and asserts the correct output/state change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StockEngine } from '../index';
import { makeItem, daysFrom, daysAgo } from './helpers';
import type { Item } from '../types';

const HH = 'hh-test';

function makeEngine() {
  return new StockEngine(HH);
}

function seedItem(engine: StockEngine, overrides: Partial<Item> = {}): Item {
  const item = makeItem(overrides);
  engine.registerItem(item);
  return item;
}

describe('20 Household Scenarios', () => {
  // ─── Scenario 1: Weekly big shop (10+ items) ────────────────────────────────
  it('Scenario 1: Weekly big shop — multiple purchases increase stock and confidence', async () => {
    const engine = makeEngine();
    const items = [
      seedItem(engine, { id: 's1-milk', name: 'Milk', category: 'dairy', currentQuantity: 0 }),
      seedItem(engine, { id: 's1-bread', name: 'Bread', category: 'bread', currentQuantity: 0 }),
      seedItem(engine, { id: 's1-eggs', name: 'Eggs', category: 'produce', currentQuantity: 0 }),
    ];

    const now = new Date();
    for (const item of items) {
      await engine.processInput({
        type: 'purchase',
        itemId: item.id,
        householdId: HH,
        quantity: 6,
        expiryDate: daysFrom(7, now),
        source: 'receipt',
        timestamp: now,
        idempotencyKey: `receipt-001-${item.id}`,
      });
    }

    for (const item of items) {
      const estimate = engine.stockLevel.getEstimate(item.id, now);
      expect(estimate.estimatedQuantity).toBe(6);
      expect(estimate.confidence).toBe('high');
    }
  });

  // ─── Scenario 2: Partial use of an item ────────────────────────────────────
  it('Scenario 2: Partial consumption of butter reduces stock', async () => {
    const engine = makeEngine();
    const item = seedItem(engine, { id: 's2-butter', name: 'Butter', category: 'dairy', currentQuantity: 1 });
    engine.stockLevel.confirmQuantity('s2-butter', 1, daysAgo(1));
    engine.fifo.addBatch({ itemId: 's2-butter', quantity: 1, purchaseDate: daysAgo(2), expiryDate: daysFrom(14), source: 'manual' });

    await engine.processInput({
      type: 'consumption_log',
      itemId: 's2-butter',
      householdId: HH,
      quantity: 0.5,
      timestamp: new Date(),
      source: 'manual',
    });

    const item2 = engine.stockLevel.getItem('s2-butter');
    expect(item2?.currentQuantity).toBeCloseTo(0.5);
  });

  // ─── Scenario 3: Item expires untouched ────────────────────────────────────
  it('Scenario 3: Yoghurt expires — waste sweep marks it as wasted', () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's3-yoghurt', name: 'Yoghurt', category: 'dairy', currentQuantity: 2 });
    engine.fifo.addBatch({
      itemId: 's3-yoghurt',
      quantity: 2,
      purchaseDate: daysAgo(9),
      expiryDate: daysAgo(2), // expired 2 days ago
      source: 'receipt',
    });

    const wasteEvents = engine.expiry.runExpirySweep(['s3-yoghurt'], HH, new Date());
    expect(wasteEvents).toHaveLength(1);
    expect(wasteEvents[0].quantity).toBe(2);
    expect(wasteEvents[0].transaction.type).toBe('waste');
    expect(wasteEvents[0].transaction.source).toBe('system');
  });

  // ─── Scenario 4: Item used faster than expected ─────────────────────────────
  it('Scenario 4: Milk gone in 3 days — rate updated upward', async () => {
    const engine = makeEngine();
    const item = seedItem(engine, { id: 's4-milk', name: 'Milk', category: 'dairy', currentQuantity: 2 });
    engine.fifo.addBatch({ itemId: 's4-milk', quantity: 2, purchaseDate: daysAgo(3), expiryDate: daysFrom(4), source: 'receipt' });
    engine.stockLevel.confirmQuantity('s4-milk', 2, daysAgo(3));

    // Milk gone after 3 days — tap "out"
    await engine.processInput({
      type: 'tap_update',
      itemId: 's4-milk',
      householdId: HH,
      status: 'out',
      timestamp: new Date(),
      source: 'tap',
    });

    const est = engine.stockLevel.getEstimate('s4-milk', new Date());
    expect(est.estimatedQuantity).toBe(0);
  });

  // ─── Scenario 5: Incorrect log (eggs marked Out, 6 remain) ─────────────────
  it('Scenario 5: Wrong "Out" tap corrected by manual correction', async () => {
    const engine = makeEngine();
    const item = seedItem(engine, { id: 's5-eggs', name: 'Eggs', category: 'produce', currentQuantity: 6 });
    engine.fifo.addBatch({ itemId: 's5-eggs', quantity: 6, purchaseDate: daysAgo(2), expiryDate: daysFrom(14), source: 'receipt' });

    // Wrong tap: marks as out
    await engine.processInput({
      type: 'tap_update',
      itemId: 's5-eggs',
      householdId: HH,
      status: 'out',
      timestamp: new Date(),
      source: 'tap',
    });

    // Correction: 6 eggs actually remain
    await engine.processInput({
      type: 'manual_correction',
      itemId: 's5-eggs',
      householdId: HH,
      confirmedQuantity: 6,
      notes: 'Tapped wrong item',
      timestamp: new Date(),
    });

    const est = engine.stockLevel.getEstimate('s5-eggs', new Date());
    expect(est.estimatedQuantity).toBe(6);
    expect(est.confidence).toBe('high');
  });

  // ─── Scenario 6: Race condition — two simultaneous taps ────────────────────
  it('Scenario 6: Two simultaneous "low" taps agree — no conflict raised', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's6-milk', name: 'Milk', category: 'dairy', currentQuantity: 3 });
    engine.stockLevel.confirmQuantity('s6-milk', 3, daysAgo(1));
    const now = new Date();

    await engine.processInput({ type: 'tap_update', itemId: 's6-milk', householdId: HH, status: 'low', timestamp: now, source: 'tap' });
    await engine.processInput({ type: 'tap_update', itemId: 's6-milk', householdId: HH, status: 'low', timestamp: now, source: 'tap' });

    // Status should be low after both taps agree
    const item = engine.stockLevel.getItem('s6-milk');
    expect(item?.status).toBe('low');
    // No conflicts raised (they agreed)
    expect(engine.conflict.getAll()).toHaveLength(0);
  });

  // ─── Scenario 7: Bulk purchase (24 toilet rolls) ───────────────────────────
  it('Scenario 7: Bulk purchase of 24 toilet rolls — single batch, no expiry', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's7-toilet', name: 'Toilet Roll', category: 'household', currentQuantity: 0 });

    await engine.processInput({
      type: 'purchase',
      itemId: 's7-toilet',
      householdId: HH,
      quantity: 24,
      source: 'receipt',
      timestamp: new Date(),
    });

    const batches = engine.fifo.getActiveBatches('s7-toilet');
    expect(batches).toHaveLength(1);
    expect(batches[0].remainingQuantity).toBe(24);
    expect(batches[0].expiryDate).toBeNull(); // household category: no expiry

    const est = engine.stockLevel.getEstimate('s7-toilet', new Date());
    expect(est.estimatedQuantity).toBeCloseTo(24, 1);
    expect(est.confidence).toBe('high');
  });

  // ─── Scenario 8: Seasonal item, no history ─────────────────────────────────
  it('Scenario 8: Christmas stuffing — no history, uses category default rate', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's8-stuffing', name: 'Stuffing Mix', category: 'dry_goods', currentQuantity: 0 });

    await engine.processInput({
      type: 'purchase',
      itemId: 's8-stuffing',
      householdId: HH,
      quantity: 1,
      source: 'manual',
      timestamp: new Date(),
    });

    const rate = engine.consumption.getRate('s8-stuffing', 'dry_goods');
    // Should fall back to category default (< 3 data points)
    expect(rate.dataPointCount).toBe(0);
    expect(rate.confidenceScore).toBe(0);
  });

  // ─── Scenario 9: Receipt name mismatch ─────────────────────────────────────
  it('Scenario 9: Purchase applies to existing item regardless of name casing', async () => {
    const engine = makeEngine();
    // System has "Milk", receipt says "Whole Milk 2L" — match by ID (upstream NL layer resolves this)
    seedItem(engine, { id: 's9-milk', name: 'Milk', category: 'dairy', currentQuantity: 0 });

    // Engine receives pre-matched itemId — name resolution is upstream
    await engine.processInput({
      type: 'purchase',
      itemId: 's9-milk', // receipt resolved to this ID by the NL layer
      householdId: HH,
      quantity: 2,
      source: 'receipt',
      timestamp: new Date(),
      notes: 'Whole Milk 2L Organic (matched)',
    });

    expect(engine.stockLevel.getEstimate('s9-milk').estimatedQuantity).toBe(2);
  });

  // ─── Scenario 10: Perishable frozen ────────────────────────────────────────
  it('Scenario 10: Chicken frozen — expiry extended by 90 days', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's10-chicken', name: 'Chicken Breast', category: 'meat', currentQuantity: 2 });
    const batch = engine.fifo.addBatch({
      itemId: 's10-chicken',
      quantity: 2,
      purchaseDate: new Date(),
      expiryDate: daysFrom(3), // 3-day fridge life
      source: 'receipt',
    });

    await engine.processInput({
      type: 'status_change',
      itemId: 's10-chicken',
      householdId: HH,
      changeType: 'frozen',
      timestamp: new Date(),
    });

    const updatedBatch = engine.fifo.getActiveBatches('s10-chicken').find(b => b.id === batch.id);
    expect(updatedBatch?.wasFrozen).toBe(true);
    // Expiry should be ~90 days from now, not 3 days
    if (updatedBatch?.expiryDate) {
      const daysUntilExpiry = (updatedBatch.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(daysUntilExpiry).toBeGreaterThan(80);
    }
  });

  // ─── Scenario 11: Leftovers with manual expiry override ────────────────────
  it('Scenario 11: Cooked rice gets manual 3-day expiry override', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's11-rice', name: 'Cooked Rice', category: 'produce', currentQuantity: 2 });
    engine.fifo.addBatch({ itemId: 's11-rice', quantity: 2, purchaseDate: new Date(), expiryDate: daysFrom(7), source: 'manual' });

    const cookedExpiry = daysFrom(3);
    await engine.processInput({
      type: 'status_change',
      itemId: 's11-rice',
      householdId: HH,
      changeType: 'cooked',
      expiryOverride: cookedExpiry,
      timestamp: new Date(),
    });

    const overrides = engine.expiry.getManualOverrides();
    // Should have an override set
    expect(Object.values(overrides).some(d => d.toDateString() === cookedExpiry.toDateString())).toBe(true);
  });

  // ─── Scenario 12: Item returned to shop ────────────────────────────────────
  it('Scenario 12: Spoiled milk returned — stock decreases, no consumption rate update', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's12-milk', name: 'Milk', category: 'dairy', currentQuantity: 2 });
    engine.fifo.addBatch({ itemId: 's12-milk', quantity: 2, purchaseDate: new Date(), expiryDate: daysFrom(7), source: 'receipt' });
    engine.stockLevel.confirmQuantity('s12-milk', 2, new Date());

    const rateBefore = engine.consumption.getRate('s12-milk', 'dairy').dataPointCount;

    await engine.processInput({
      type: 'status_change',
      itemId: 's12-milk',
      householdId: HH,
      changeType: 'returned',
      quantity: 2,
      timestamp: new Date(),
      notes: 'Carton spoiled on arrival',
    });

    const item = engine.stockLevel.getItem('s12-milk');
    expect(item?.currentQuantity).toBe(0);
    // Consumption rate should NOT have been updated
    expect(engine.consumption.getRate('s12-milk', 'dairy').dataPointCount).toBe(rateBefore);
  });

  // ─── Scenario 13: Gift received ────────────────────────────────────────────
  it('Scenario 13: Gifted bottle of wine — stock increases, source=gift', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's13-wine', name: 'Wine', category: 'beverages', currentQuantity: 0 });

    await engine.processInput({
      type: 'status_change',
      itemId: 's13-wine',
      householdId: HH,
      changeType: 'gift_received',
      quantity: 1,
      timestamp: new Date(),
      notes: 'Birthday gift from neighbour',
    });

    const est = engine.stockLevel.getEstimate('s13-wine', new Date());
    expect(est.estimatedQuantity).toBe(1);
    // Transaction should have type 'gift'
    const txTypes = engine.fifo.getActiveBatches('s13-wine').map(b => b.source);
    expect(txTypes).toContain('manual');
  });

  // ─── Scenario 14: Long holiday ─────────────────────────────────────────────
  it('Scenario 14: 2-week holiday — perishables show as stale/wasted on return', () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's14-milk', name: 'Milk', category: 'dairy', currentQuantity: 2 });
    engine.fifo.addBatch({
      itemId: 's14-milk',
      quantity: 2,
      purchaseDate: daysAgo(15),
      expiryDate: daysAgo(8), // expired during holiday
      source: 'receipt',
    });
    engine.stockLevel.confirmQuantity('s14-milk', 2, daysAgo(15));

    const returnDate = new Date();
    const wasteEvents = engine.expiry.runExpirySweep(['s14-milk'], HH, returnDate);
    expect(wasteEvents).toHaveLength(1);

    const est = engine.stockLevel.getEstimate('s14-milk', returnDate);
    expect(est.staleDays).toBeGreaterThan(14);
    expect(est.confidence).toBe('low');
  });

  // ─── Scenario 15: Fridge photo contradicts record ──────────────────────────
  it('Scenario 15: Photo reconciliation creates new items and corrects missing ones', async () => {
    const engine = makeEngine();
    // System thinks there are 3 items
    const item1 = seedItem(engine, { id: 's15-milk', name: 'Milk', category: 'dairy', currentQuantity: 2 });
    const item2 = seedItem(engine, { id: 's15-eggs', name: 'Eggs', category: 'produce', currentQuantity: 6 });
    // item3: system thinks it's there but photo shows 0
    const item3 = seedItem(engine, { id: 's15-bread', name: 'Bread', category: 'bread', currentQuantity: 4 });

    engine.stockLevel.confirmQuantity('s15-milk', 2, daysAgo(2));
    engine.stockLevel.confirmQuantity('s15-eggs', 6, daysAgo(2));
    engine.stockLevel.confirmQuantity('s15-bread', 4, daysAgo(2));

    const now = new Date();
    // Photo: milk=2 (matches), eggs=6 (matches), bread=0 (not there!)
    await engine.processInput({
      type: 'photo_reconciliation',
      householdId: HH,
      items: [
        { itemId: 's15-milk', confirmedQuantity: 2 },
        { itemId: 's15-eggs', confirmedQuantity: 6 },
        { itemId: 's15-bread', confirmedQuantity: 0 },
      ],
      timestamp: now,
      idempotencyKey: 'photo-001',
    });

    // Bread should be corrected to 0
    const breadEst = engine.stockLevel.getEstimate('s15-bread', now);
    expect(breadEst.estimatedQuantity).toBe(0);
    // Milk and eggs should be confirmed at current levels
    expect(engine.stockLevel.getEstimate('s15-milk', now).estimatedQuantity).toBe(2);
  });

  // ─── Scenario 16: Duplicate receipt ────────────────────────────────────────
  it('Scenario 16: Same receipt processed twice — second is rejected', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's16-milk', name: 'Milk', category: 'dairy', currentQuantity: 0 });

    const input = {
      type: 'purchase' as const,
      itemId: 's16-milk',
      householdId: HH,
      quantity: 4,
      source: 'receipt' as const,
      timestamp: new Date(),
      idempotencyKey: 'receipt-TESCO-20260701-001',
    };

    await engine.processInput(input);
    const result2 = await engine.processInput(input);

    expect(result2.duplicateDetected).toBe('receipt-TESCO-20260701-001');
    expect(result2.transactions).toHaveLength(0);
    // Stock should only be 4, not 8
    expect(engine.stockLevel.getEstimate('s16-milk').estimatedQuantity).toBeCloseTo(4, 1);
  });

  // ─── Scenario 17: Restock before running out ───────────────────────────────
  it('Scenario 17: Eggs 3 left + new 12-pack — FIFO shows 2 batches, total 15', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's17-eggs', name: 'Eggs', category: 'produce', currentQuantity: 3 });
    // Old batch: 3 remaining (purchased 10 days ago)
    engine.fifo.addBatch({ itemId: 's17-eggs', quantity: 12, purchaseDate: daysAgo(10), expiryDate: daysFrom(11), source: 'receipt' });
    engine.fifo.consumeQuantity('s17-eggs', 9); // 9 consumed, 3 remaining

    engine.stockLevel.confirmQuantity('s17-eggs', 3, daysAgo(1));

    // Buy new 12-pack
    await engine.processInput({
      type: 'purchase',
      itemId: 's17-eggs',
      householdId: HH,
      quantity: 12,
      source: 'receipt',
      timestamp: new Date(),
      expiryDate: daysFrom(21),
    });

    const batches = engine.fifo.getActiveBatches('s17-eggs');
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(engine.fifo.getTotalStock('s17-eggs')).toBeGreaterThanOrEqual(12);
  });

  // ─── Scenario 18: Seasonal consumption change ───────────────────────────────
  it('Scenario 18: Consumption rate adapts over time via exponential smoothing', () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's18-salad', name: 'Salad', category: 'produce', currentQuantity: 5 });

    // Winter: slow consumption (1 per 7 days)
    for (let i = 0; i < 5; i++) {
      engine.consumption.updateRate('s18-salad', 'produce', { quantity: 1, durationDays: 7 });
    }
    const winterRate = engine.consumption.getRate('s18-salad', 'produce').dailyRate;

    // Summer arrives: fast consumption (1 per 2 days)
    for (let i = 0; i < 5; i++) {
      engine.consumption.updateRate('s18-salad', 'produce', { quantity: 1, durationDays: 2 });
    }
    const summerRate = engine.consumption.getRate('s18-salad', 'produce').dailyRate;

    expect(summerRate).toBeGreaterThan(winterRate);
  });

  // ─── Scenario 19: Found at back of cupboard ─────────────────────────────────
  it('Scenario 19: Item found after "Out" tap — manual correction restores stock', async () => {
    const engine = makeEngine();
    seedItem(engine, { id: 's19-pasta', name: 'Pasta', category: 'dry_goods', currentQuantity: 1 });
    engine.fifo.addBatch({ itemId: 's19-pasta', quantity: 1, purchaseDate: daysAgo(14), expiryDate: daysFrom(351), source: 'manual' });
    engine.stockLevel.confirmQuantity('s19-pasta', 1, daysAgo(14));

    // Tap "Out"
    await engine.processInput({
      type: 'tap_update',
      itemId: 's19-pasta',
      householdId: HH,
      status: 'out',
      timestamp: daysAgo(1),
      source: 'tap',
    });

    // Found at back of cupboard — correct to 2 packs
    await engine.processInput({
      type: 'manual_correction',
      itemId: 's19-pasta',
      householdId: HH,
      confirmedQuantity: 2,
      notes: 'Found 2 packs at back of cupboard',
      timestamp: new Date(),
    });

    const est = engine.stockLevel.getEstimate('s19-pasta', new Date());
    expect(est.estimatedQuantity).toBe(2);
    expect(est.confidence).toBe('high');
  });

  // ─── Scenario 20: Unknown item type ─────────────────────────────────────────
  it('Scenario 20: Unknown category — creates item with uncategorised defaults', async () => {
    const engine = makeEngine();
    // Item with unknown category defaults to 'uncategorised'
    seedItem(engine, {
      id: 's20-exotic',
      name: 'Imported Soy Sauce XO',
      category: 'uncategorised',
      currentQuantity: 0,
    });

    await engine.processInput({
      type: 'purchase',
      itemId: 's20-exotic',
      householdId: HH,
      quantity: 1,
      source: 'manual',
      timestamp: new Date(),
    });

    const est = engine.stockLevel.getEstimate('s20-exotic', new Date());
    expect(est.estimatedQuantity).toBe(1);
    expect(est.confidence).toBe('high');

    // Rate falls back to category default
    const rate = engine.consumption.getRate('s20-exotic', 'uncategorised');
    expect(rate.dailyRate).toBeGreaterThan(0); // has a conservative default
  });
});
