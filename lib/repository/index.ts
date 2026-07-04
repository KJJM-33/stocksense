/**
 * StockSense Repository — Supabase Adapter
 *
 * StockRepository is the bridge between the in-memory StockEngine and Supabase.
 * It has two primary jobs:
 *   load()  — hydrate a StockEngine from the database (items, batches, rates)
 *   save()  — persist an EngineOutput back to the database after processInput()
 *
 * Uses the service role key (server-side only, never exposed to the browser) so
 * it bypasses RLS. All writes are scoped to a specific householdId.
 *
 * The Postgres apply_transaction trigger automatically updates items.quantity
 * and items.status when a transaction is inserted — the repository only writes
 * the engine-specific metadata fields (confidence, confirmed_at, frozen) separately.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { StockEngine } from '../engine';
import type { EngineOutput, Item } from '../engine/types';
import {
  batchRowToBatch,
  engineSourceToDB,
  engineTypeToDB,
  itemRowToItem,
  rateRowToRate,
} from './mappers';
import type { ConsumptionRateRow, ItemRow, PurchaseBatchRow } from './types';

export class StockRepository {
  private client: SupabaseClient;

  constructor(url?: string, serviceRoleKey?: string) {
    const resolvedUrl = url ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const resolvedKey = serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

    if (!resolvedUrl || !resolvedKey) {
      throw new Error(
        'StockRepository requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
      );
    }

    this.client = createClient(resolvedUrl, resolvedKey, {
      auth: { persistSession: false },
    });
  }

  /**
   * Loads all household state from Supabase and returns a hydrated StockEngine.
   * Call this at the start of any server-side request that needs the engine.
   *
   * @param householdId - The household to load
   * @returns A fully hydrated StockEngine ready for processInput()
   */
  async load(householdId: string): Promise<StockEngine> {
    const engine = new StockEngine(householdId);

    const [itemsResult, batchesResult, ratesResult] = await Promise.all([
      this.client.from('items').select('*').eq('household_id', householdId),
      this.client.from('purchase_batches').select('*').eq('household_id', householdId),
      this.client.from('consumption_rates').select('*').eq('household_id', householdId),
    ]);

    if (itemsResult.error) throw new Error(`load items: ${itemsResult.error.message}`);
    if (batchesResult.error) throw new Error(`load batches: ${batchesResult.error.message}`);
    if (ratesResult.error) throw new Error(`load rates: ${ratesResult.error.message}`);

    // Register items first (batches and rates reference item IDs)
    for (const row of itemsResult.data as ItemRow[]) {
      engine.registerItem(itemRowToItem(row));
    }

    engine.fifo.load((batchesResult.data as PurchaseBatchRow[]).map(batchRowToBatch));
    engine.consumption.load((ratesResult.data as ConsumptionRateRow[]).map(rateRowToRate));

    return engine;
  }

  /**
   * Persists an EngineOutput to Supabase after processInput() completes.
   * All writes run in parallel; throws on any failure.
   *
   * @param householdId - The household this output belongs to
   * @param output - The EngineOutput returned by processInput()
   * @param engine - The StockEngine instance (used to read updated batch/rate state)
   */
  async save(
    householdId: string,
    output: EngineOutput,
    engine: StockEngine
  ): Promise<void> {
    if (output.duplicateDetected) return;

    const ops: Promise<void>[] = [];

    // 1. Insert new transactions (apply_transaction trigger handles quantity+status)
    const allTxs = [...output.transactions, ...output.wasteEvents];
    if (allTxs.length > 0) {
      const rows = allTxs.map((tx) => ({
        id: tx.id,
        household_id: householdId,
        item_id: tx.itemId,
        type: engineTypeToDB(tx.type),
        quantity: tx.quantity,
        source: engineSourceToDB(tx.source),
        note: tx.notes ?? null,
        batch_id: tx.batchId ?? null,
        expiry_date: tx.expiryDate ? tx.expiryDate.toISOString().split('T')[0] : null,
        idempotency_key: tx.idempotencyKey ?? null,
      }));

      ops.push(
        (async () => {
          const { error } = await this.client
            .from('transactions')
            .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
          if (error) throw new Error(`insert transactions: ${error.message}`);
        })()
      );
    }

    // 2. Upsert FIFO batches for affected items (purchases + status changes)
    const affectedItemIds = new Set(output.stateUpdates.map((u) => u.itemId));
    if (affectedItemIds.size > 0) {
      const affectedBatches = engine.fifo
        .dump()
        .filter((b) => affectedItemIds.has(b.itemId));

      if (affectedBatches.length > 0) {
        const batchRows = affectedBatches.map((b) => ({
          id: b.id,
          household_id: householdId,
          item_id: b.itemId,
          quantity: b.quantity,
          remaining_quantity: b.remainingQuantity,
          purchase_date: b.purchaseDate.toISOString(),
          expiry_date: b.expiryDate ? b.expiryDate.toISOString().split('T')[0] : null,
          source: engineSourceToDB(b.source),
          was_frozen: b.wasFrozen,
        }));

        ops.push(
          (async () => {
            const { error } = await this.client
              .from('purchase_batches')
              .upsert(batchRows, { onConflict: 'id' });
            if (error) throw new Error(`upsert batches: ${error.message}`);
          })()
        );
      }

      // 3. Upsert consumption rates for affected items
      const affectedRates = engine.consumption
        .dump()
        .filter((r) => affectedItemIds.has(r.itemId));

      if (affectedRates.length > 0) {
        const rateRows = affectedRates.map((r) => ({
          household_id: householdId,
          item_id: r.itemId,
          daily_rate: r.dailyRate,
          confidence_score: r.confidenceScore,
          data_point_count: r.dataPointCount,
          category_default: r.categoryDefault,
          last_updated: r.lastUpdated.toISOString(),
        }));

        ops.push(
          (async () => {
            const { error } = await this.client
              .from('consumption_rates')
              .upsert(rateRows, { onConflict: 'household_id,item_id' });
            if (error) throw new Error(`upsert rates: ${error.message}`);
          })()
        );
      }

      // 4. Update engine-specific item metadata
      // (apply_transaction trigger already handled quantity + status)
      for (const itemId of affectedItemIds) {
        const item = engine.stockLevel.getItem(itemId);
        if (!item) continue;

        ops.push(
          (async () => {
            const { error } = await this.client
              .from('items')
              .update({
                frozen: item.frozen,
                confidence_level: item.confidenceLevel,
                last_confirmed_at: item.lastConfirmedAt?.toISOString() ?? null,
                last_inferred_at: item.lastInferredAt?.toISOString() ?? null,
              })
              .eq('id', itemId);
            if (error) throw new Error(`update item metadata ${itemId}: ${error.message}`);
          })()
        );
      }
    }

    await Promise.all(ops);
  }

  /**
   * Creates or updates an item in Supabase.
   * Use this when seeding initial stock (photo scan, manual add, receipt).
   *
   * @param householdId - The household to add the item to
   * @param item - Item data (id is optional — omit to let Supabase generate one)
   * @returns The saved item with all fields populated
   */
  async upsertItem(
    householdId: string,
    item: Omit<Item, 'id' | 'createdAt'> & { id?: string }
  ): Promise<Item> {
    const row = {
      ...(item.id ? { id: item.id } : {}),
      household_id: householdId,
      name: item.name,
      category: item.category,
      quantity: item.currentQuantity,
      unit: item.unit,
      status: item.status,
      location: item.location,
      frozen: item.frozen,
      confidence_level: item.confidenceLevel,
      last_confirmed_at: item.lastConfirmedAt?.toISOString() ?? null,
      last_inferred_at: item.lastInferredAt?.toISOString() ?? null,
    };

    const { data, error } = await this.client
      .from('items')
      .upsert(row, { onConflict: 'id' })
      .select()
      .single();

    if (error) throw new Error(`upsert item: ${error.message}`);
    return itemRowToItem(data as ItemRow);
  }

  /**
   * Returns all items for a household, mapped to engine types.
   * Use this for listing/dashboard queries that don't need the full engine.
   *
   * @param householdId - The household to query
   * @returns Items sorted by name
   */
  async getItems(householdId: string): Promise<Item[]> {
    const { data, error } = await this.client
      .from('items')
      .select('*')
      .eq('household_id', householdId)
      .order('name');

    if (error) throw new Error(`get items: ${error.message}`);
    return (data as ItemRow[]).map(itemRowToItem);
  }

  /**
   * Returns all items with their current stock estimates from the engine.
   * Equivalent to load() + getStatus() but avoids re-hydrating the full engine
   * if you already have one.
   *
   * @param engine - A hydrated StockEngine
   * @returns StockEstimate array sorted by confidence ASC
   */
  getEstimates(engine: StockEngine) {
    return engine.getStatus() as ReturnType<typeof engine.getStatus>;
  }
}

// Convenience: a module-level singleton for use in Next.js server components/actions.
// The singleton is safe because env vars are constant for the process lifetime.
let _repo: StockRepository | null = null;

export function getRepository(): StockRepository {
  _repo ??= new StockRepository();
  return _repo;
}
