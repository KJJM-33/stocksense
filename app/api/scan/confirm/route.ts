/**
 * POST /api/scan/confirm
 *
 * Receives the user-reviewed list of scanned items and upserts them all into
 * Supabase as opening stock. Items are matched by (household, location) plus a
 * normalised name (see lib/engine/itemMatch.ts — ignores retailer names, pack sizes,
 * case, punctuation and plurals) — existing items have their quantity and status
 * updated, new items are created with confidence_level = 'high' (user confirmed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getCategoryDefaults } from '@/lib/engine/categories';
import { findMatchingItem } from '@/lib/engine/itemMatch';

const HOUSEHOLD_ID = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID!;

function serverClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase config');
  return createClient(url, key, { auth: { persistSession: false } });
}

interface ConfirmedItem {
  name: string;
  quantity: number;
  unit: string;
  location: string;
  status: 'ok' | 'low';
}

export async function POST(req: NextRequest) {
  try {
    const { items } = (await req.json()) as { items?: ConfirmedItem[] };
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }

    const supabase = serverClient();
    const now = new Date().toISOString();
    const results: { name: string; id: string; action: 'created' | 'updated' }[] = [];

    const { data: existingRows, error: fetchError } = await supabase
      .from('items')
      .select('id, name, location')
      .eq('household_id', HOUSEHOLD_ID);
    if (fetchError) throw new Error(fetchError.message);
    const known: { id: string; name: string; location: string | null }[] = existingRows ?? [];

    for (const item of items) {
      const name = item.name?.trim();
      const loc = item.location ?? 'fridge';
      if (!name) continue;

      const existing = findMatchingItem(name, loc, known);

      if (existing) {
        // Update quantity, status, confidence
        await supabase.from('items').update({
          quantity: item.quantity,
          status: item.status ?? 'ok',
          confidence_level: 'high',
          last_confirmed_at: now,
          last_inferred_at: now,
        }).eq('id', existing.id);

        results.push({ name, id: existing.id, action: 'updated' });
      } else {
        // Insert new
        const defaults = getCategoryDefaults('uncategorised');
        const { data: newRow, error } = await supabase.from('items').insert({
          household_id: HOUSEHOLD_ID,
          name,
          category: 'uncategorised',
          unit: item.unit ?? defaults.defaultUnit,
          quantity: item.quantity,
          status: item.status ?? 'ok',
          location: loc,
          frozen: loc === 'freezer',
          confidence_level: 'high',
          last_confirmed_at: now,
          last_inferred_at: now,
        }).select('id').single();

        if (!error && newRow) {
          known.push({ id: newRow.id, name, location: loc });
          results.push({ name, id: newRow.id, action: 'created' });
        }
      }
    }

    return NextResponse.json({ ok: true, saved: results.length, results });
  } catch (err) {
    console.error('[POST /api/scan/confirm]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Save failed' },
      { status: 500 }
    );
  }
}
