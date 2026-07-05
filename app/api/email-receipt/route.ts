/**
 * POST /api/email-receipt
 *
 * Postmark inbound webhook. When a receipt email is forwarded to your
 * StockSense inbox, Postmark POSTs the parsed email here. Claude reads the
 * email body, extracts grocery items, and upserts them into stock.
 *
 * Setup (when ready):
 *   1. Create a free Postmark account at postmarkapp.com
 *   2. Set up an Inbound Stream → copy the email address
 *   3. Set the webhook URL to: https://stocksense-rose.vercel.app/api/email-receipt
 *   4. Forward any supermarket receipt email to your Postmark inbox address
 *
 * Supported receipts: Tesco, M&S, Waitrose, Sainsbury's, ASDA, Ocado.
 * Claude parses the plain-text body — HTML-only emails are also handled
 * via Postmark's StrippedTextReply field.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const HOUSEHOLD_ID = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID!;

function serverClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase config');
  return createClient(url, key, { auth: { persistSession: false } });
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface PostmarkInbound {
  From?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
}

interface ExtractedItem {
  name: string;
  quantity: number;
  unit: string;
  location: string;
}

const EXTRACT_PROMPT = `You are a household stock tracker. Extract all grocery and household items from this supermarket receipt email.

Return ONLY a raw JSON array — no markdown, no explanation:
[{"name":"Milk","quantity":2,"unit":"pints","location":"fridge"}]

Rules:
- name: common grocery name (shorten brand-heavy names: "Tesco Finest Semi-Skimmed Milk" → "Milk")
- quantity: number purchased (e.g. "2x" or pack size from context)
- unit: natural unit (pints, litres, kg, g, bottles, cans, packs, loaves, rolls, sheets)
- location: best guess — fridge (dairy, meat, veg, drinks), freezer (frozen items), cupboard (everything else)
- Skip: non-food items that aren't household essentials (greeting cards, magazines, etc.)
- Include: cleaning products, toilet roll, kitchen paper, etc.

Receipt text:`;

async function extractItems(text: string): Promise<ExtractedItem[]> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `${EXTRACT_PROMPT}\n\n${text.slice(0, 4000)}`,
    }],
  });

  const raw = response.content.find(b => b.type === 'text')?.text ?? '[]';
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : [];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PostmarkInbound;

    // Prefer plain text; fall back to stripped HTML reply
    const emailText = body.TextBody ?? body.StrippedTextReply ?? '';
    if (!emailText.trim()) {
      return NextResponse.json({ ok: true, message: 'No text body — skipped' });
    }

    const supabase = serverClient();

    // Log the receipt
    const { data: receiptRow } = await supabase.from('email_receipts').insert({
      household_id: HOUSEHOLD_ID,
      from_email: body.From ?? null,
      subject: body.Subject ?? null,
      raw_body: emailText.slice(0, 10000),
      status: 'processing',
    }).select('id').single();

    const receiptId = receiptRow?.id;

    // Extract items via Claude
    const items = await extractItems(emailText);

    if (items.length === 0) {
      if (receiptId) {
        await supabase.from('email_receipts')
          .update({ status: 'no_items', parsed_items: [] })
          .eq('id', receiptId);
      }
      return NextResponse.json({ ok: true, message: 'No grocery items found in receipt' });
    }

    // Upsert items to stock
    const now = new Date().toISOString();
    const upserted: string[] = [];

    for (const item of items) {
      const name = item.name?.trim();
      if (!name) continue;
      const loc = item.location ?? 'cupboard';

      const { data: existing } = await supabase
        .from('items')
        .select('id, quantity')
        .eq('household_id', HOUSEHOLD_ID)
        .ilike('name', name)
        .eq('location', loc)
        .maybeSingle();

      if (existing) {
        await supabase.from('items').update({
          quantity: existing.quantity + (item.quantity ?? 1),
          status: 'ok',
          confidence_level: 'high',
          last_confirmed_at: now,
        }).eq('id', existing.id);
      } else {
        await supabase.from('items').insert({
          household_id: HOUSEHOLD_ID,
          name,
          category: 'uncategorised',
          unit: item.unit ?? 'items',
          quantity: item.quantity ?? 1,
          status: 'ok',
          location: loc,
          frozen: loc === 'freezer',
          confidence_level: 'high',
          last_confirmed_at: now,
          last_inferred_at: now,
        });
      }
      upserted.push(name);
    }

    // Mark receipt as processed
    if (receiptId) {
      await supabase.from('email_receipts').update({
        status: 'processed',
        parsed_items: items,
      }).eq('id', receiptId);
    }

    console.log(`[email-receipt] Processed ${upserted.length} items from ${body.From}`);
    return NextResponse.json({ ok: true, itemsProcessed: upserted.length, items: upserted });
  } catch (err) {
    console.error('[POST /api/email-receipt]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Processing failed' },
      { status: 500 }
    );
  }
}
