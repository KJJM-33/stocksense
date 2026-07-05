/**
 * POST /api/scan
 *
 * Receives a base64 image (data URL), sends it to Claude vision, and returns
 * a structured list of identified grocery items. The client shows these for
 * review/editing before confirming via /api/scan/confirm.
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCAN_PROMPT = `You are a household stock tracker. Look at this image and identify all food and household items visible.

Return ONLY a raw JSON array — no markdown, no explanation, just the array:
[{"name":"Milk","quantity":2,"unit":"pints","location":"fridge","status":"ok","confidence":"high"}]

Rules:
- name: common grocery name (e.g. "Semi-skimmed Milk" → "Milk", "Cathedral City Cheddar" → "Cheese")
- quantity: rough visible count (1 bottle = 1, 6-pack eggs = 6, half-empty carton = 1)
- unit: bottles, cartons, cans, bags, boxes, pints, litres, loaves, packs — pick the most natural one
- location: "fridge", "freezer", or "cupboard" — infer from context clues in the image
- status: "ok" unless item is clearly almost empty/last one (then "low")
- confidence: "high" if clearly identifiable, "medium" if partially visible, "low" if uncertain
- Only include items you can identify with reasonable confidence
- Ignore packaging you cannot read or items too small to identify`;

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function extractBase64(dataUrl: string): { data: string; mediaType: ImageMediaType } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mimeType = match[1];
  const validTypes: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validTypes.includes(mimeType as ImageMediaType)) {
    throw new Error(`Unsupported image type: ${mimeType}. Use JPEG, PNG, GIF, or WebP.`);
  }
  return { data: match[2], mediaType: mimeType as ImageMediaType };
}

export async function POST(req: NextRequest) {
  try {
    const { image } = (await req.json()) as { image?: string };
    if (!image) return NextResponse.json({ error: 'image is required' }, { status: 400 });

    const { data, mediaType } = extractBase64(image);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          },
          { type: 'text', text: SCAN_PROMPT },
        ],
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '[]';

    // Strip any accidental markdown fences
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    const items = JSON.parse(cleaned);

    if (!Array.isArray(items)) throw new Error('Claude returned non-array response');

    return NextResponse.json({ items });
  } catch (err) {
    console.error('[POST /api/scan]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Scan failed' },
      { status: 500 }
    );
  }
}
