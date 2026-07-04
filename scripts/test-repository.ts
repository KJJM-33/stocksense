/**
 * Quick smoke test: load → processInput → save round trip against live Supabase.
 * Run with: npx tsx scripts/test-repository.ts
 */

import 'dotenv/config';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local
config({ path: resolve(process.cwd(), '.env.local') });

import { StockRepository } from '../lib/repository';
import type { PurchaseInput } from '../lib/engine/types';

const HOUSEHOLD_ID = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID!;

async function run() {
  console.log('── StockRepository smoke test ──────────────────────');
  console.log(`Household: ${HOUSEHOLD_ID}`);

  const repo = new StockRepository();

  // 1. Load
  console.log('\n1. Loading engine from Supabase...');
  const engine = await repo.load(HOUSEHOLD_ID);
  const items = engine.stockLevel.getAllItems();
  console.log(`   ✓ Loaded ${items.length} item(s)`);
  if (items.length > 0) {
    console.log(`   Items: ${items.map(i => i.name).join(', ')}`);
  }

  // 2. Upsert a test item
  console.log('\n2. Upserting test item (Milk)...');
  const milk = await repo.upsertItem(HOUSEHOLD_ID, {
    name: 'Milk',
    category: 'dairy',
    unit: 'pints',
    currentQuantity: 4,
    status: 'ok',
    location: 'fridge',
    frozen: false,
    confidenceLevel: 'high',
    lastConfirmedAt: new Date(),
    lastInferredAt: new Date(),
    householdId: HOUSEHOLD_ID,
  });
  console.log(`   ✓ Upserted: ${milk.name} (id: ${milk.id})`);

  // 3. Re-load engine with the new item
  console.log('\n3. Re-loading engine...');
  const engine2 = await repo.load(HOUSEHOLD_ID);
  engine2.registerItem(milk);

  // 4. Process a purchase input
  console.log('\n4. Processing purchase input (2 pints of milk)...');
  const purchaseInput: PurchaseInput = {
    type: 'purchase',
    itemId: milk.id,
    householdId: HOUSEHOLD_ID,
    quantity: 2,
    source: 'manual',
    timestamp: new Date(),
    idempotencyKey: `smoke-test-purchase-${Date.now()}`,
  };
  const output = await engine2.processInput(purchaseInput);
  console.log(`   ✓ Output: ${output.transactions.length} transaction(s), ${output.alerts.length} alert(s)`);

  // 5. Save output to Supabase
  console.log('\n5. Saving output to Supabase...');
  await repo.save(HOUSEHOLD_ID, output, engine2);
  console.log('   ✓ Saved');

  // 6. Verify by re-loading
  console.log('\n6. Verifying via fresh load...');
  const engine3 = await repo.load(HOUSEHOLD_ID);
  const milkEstimate = engine3.getStatus(milk.id);
  console.log(`   ✓ Milk estimate: ${JSON.stringify(milkEstimate, null, 2)}`);

  // 7. Check alerts
  const alerts = engine3.getAlerts();
  console.log(`\n7. Active alerts: ${alerts.length}`);
  for (const alert of alerts) {
    console.log(`   [${alert.severity}] ${alert.type}: ${alert.message}`);
  }

  console.log('\n── All checks passed ───────────────────────────────');
}

run().catch((err) => {
  console.error('\n✗ Test failed:', err.message);
  process.exit(1);
});
