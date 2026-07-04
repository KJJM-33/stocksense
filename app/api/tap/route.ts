/**
 * POST /api/tap
 *
 * The tap handler — receives item name + status from the /tap UI, runs it
 * through the intelligence engine, and persists the result to Supabase.
 *
 * This replaces the previous direct supabase.rpc('record_tap') call. The
 * extra server hop (~50-100ms) is worth it: the engine now updates consumption
 * rates, confidence levels, and FIFO batches on every tap, which all future
 * estimates depend on.
 *
 * Auth: none required. Uses the service role key server-side. The householdId
 * is the Phase 1 default; Phase 2 will derive it from the NFC tag token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRepository } from '@/lib/repository';
import { itemRowToItem } from '@/lib/repository/mappers';
import { getCategoryDefaults } from '@/lib/engine/categories';
import type { ItemRow } from '@/lib/repository/types';
import type { TapStatus, Location } from '@/lib/constants';

const HOUSEHOLD_ID = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID!;

function serverClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      itemName: string;
      status: TapStatus;
      location?: Location;
    };

    const { itemName, status, location } = body;

    // Basic validation before touching the DB
    if (!itemName?.trim()) {
      return NextResponse.json({ error: 'itemName is required' }, { status: 400 });
    }
    if (!['low', 'out', 'used_some'].includes(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }

    const supabase = serverClient();
    const loc = location ?? 'cupboard';

    // ── Step 1: find the item, or create it ───────────────────────────────────
    //
    // The DB has a unique index on (household_id, lower(name), location), so
    // "Milk" and "milk" are the same item. ilike() does case-insensitive matching.
    //
    const { data: existingRow, error: findError } = await supabase
      .from('items')
      .select('*')
      .eq('household_id', HOUSEHOLD_ID)
      .ilike('name', itemName.trim())
      .eq('location', loc)
      .maybeSingle();

    if (findError) {
      return NextResponse.json({ error: `DB lookup failed: ${findError.message}` }, { status: 500 });
    }

    let itemRow: ItemRow;
    let isNew = false;

    if (existingRow) {
      itemRow = existingRow as ItemRow;
    } else {
      // New item — seed with category defaults. Category stays 'uncategorised'
      // until a receipt scan or manual edit assigns the real one.
      const defaults = getCategoryDefaults('uncategorised');
      const { data: newRow, error: insertError } = await supabase
        .from('items')
        .insert({
          household_id: HOUSEHOLD_ID,
          name: itemName.trim(),
          category: 'uncategorised',
          unit: defaults.defaultUnit,
          quantity: 0,
          status: 'ok',
          location: loc,
          frozen: false,
          confidence_level: 'low',
        })
        .select()
        .single();

      if (insertError) {
        return NextResponse.json({ error: `Item creation failed: ${insertError.message}` }, { status: 500 });
      }

      itemRow = newRow as ItemRow;
      isNew = true;
    }

    // ── Step 2: load engine ────────────────────────────────────────────────────
    //
    // repo.load() fetches all items/batches/rates for the household and returns
    // a fully hydrated StockEngine. The item we just created will be in this load
    // because Step 1 completed before we got here.
    //
    const repo = getRepository();
    const engine = await repo.load(HOUSEHOLD_ID);

    // Safety net: if the item somehow isn't in the loaded state, register it.
    if (!engine.stockLevel.getItem(itemRow.id)) {
      engine.registerItem(itemRowToItem(itemRow));
    }

    // ── Step 3: run the tap through the engine ────────────────────────────────
    //
    // processInput returns an EngineOutput: updated stock estimate, any new
    // transactions, alerts (e.g. expiry warnings), and drift flags.
    //
    const output = await engine.processInput({
      type: 'tap_update',
      itemId: itemRow.id,
      householdId: HOUSEHOLD_ID,
      status,
      location: loc,
      timestamp: new Date(),
      source: 'tap',
    });

    // ── Step 4: persist engine output ─────────────────────────────────────────
    //
    // repo.save() writes:
    //   - the new transaction (quantity change or status adjustment)
    //   - updated FIFO batch state
    //   - updated consumption rate
    //   - updated item metadata (confidence_level, last_inferred_at, frozen)
    //
    // Note: the apply_transaction Postgres trigger fires on transaction insert and
    // automatically updates items.quantity and items.status — we don't do that manually.
    //
    await repo.save(HOUSEHOLD_ID, output, engine);

    // ── Step 5: return the result ──────────────────────────────────────────────
    const estimate = engine.getStatus(itemRow.id);
    const alerts = output.alerts.filter((a) => !a.dismissed);

    return NextResponse.json({
      ok: true,
      itemId: itemRow.id,
      itemName: itemRow.name,
      isNew,
      estimate,
      alerts,
    });

  } catch (err) {
    console.error('[POST /api/tap]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
