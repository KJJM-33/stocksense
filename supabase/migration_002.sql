-- Migration 002: use_by_date on items, products reference table, email receipts log
-- Run in Supabase SQL editor

ALTER TABLE items ADD COLUMN IF NOT EXISTS use_by_date DATE;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  typical_shelf_life_days INTEGER,
  calories_per_100g INTEGER,
  image_url TEXT,
  source TEXT DEFAULT 'openfoodfacts',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone can read products" ON products FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS email_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ DEFAULT now(),
  from_email TEXT,
  subject TEXT,
  raw_body TEXT,
  parsed_items JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE email_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members can view receipts" ON email_receipts FOR SELECT USING (is_household_member(household_id));
