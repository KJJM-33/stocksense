import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACT_PROMPT = `You are a household stock tracker. Extract all grocery and household items from this supermarket receipt.

Return ONLY a raw JSON array — no markdown, no explanation:
[{"name":"Milk","quantity":2,"unit":"pints","location":"fridge"}]

Rules:
- name: common grocery name (shorten: "Tesco Finest Semi-Skimmed Milk 4 Pints" → "Milk")
- quantity: number purchased (use pack size when obvious, otherwise 1)
- unit: natural unit — pints, litres, kg, g, bottles, cans, packs, loaves, rolls, bags
- location: fridge (dairy, meat, veg, fresh drinks), freezer (anything frozen), cupboard (everything else)
- Include: cleaning products, toilet roll, kitchen paper, household essentials
- Skip: non-food/non-household items (magazines, gift cards, clothing)

Receipt:`;

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text?.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `${EXTRACT_PROMPT}\n\n${text.slice(0, 6000)}`,
      }],
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '[]';
    const cleaned = raw.replace(/```(?:json)?/g, '').trim();
    const items = JSON.parse(cleaned);
    if (!Array.isArray(items)) throw new Error('Unexpected response format');

    return NextResponse.json({ items });
  } catch (err) {
    console.error('[POST /api/receipt]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Parse failed' },
      { status: 500 }
    );
  }
}
