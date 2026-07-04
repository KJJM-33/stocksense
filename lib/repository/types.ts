/**
 * StockSense Repository — Database Row Types
 *
 * Snake_case mirrors the Supabase/Postgres column names.
 * These are NOT the engine types — use mappers.ts to convert.
 */

export interface ItemRow {
  id: string;
  household_id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  status: 'ok' | 'low' | 'out';
  expiry_date: string | null;
  inferred_expiry_days: number | null;
  location: 'fridge' | 'freezer' | 'cupboard';
  frozen: boolean;
  confidence_level: 'high' | 'medium' | 'low';
  last_confirmed_at: string | null;
  last_inferred_at: string | null;
  last_updated: string;
  created_at: string;
}

export interface TransactionRow {
  id: string;
  household_id: string;
  item_id: string;
  type: string;
  quantity: number | null;
  source: string;
  declared_status: 'ok' | 'low' | 'out' | null;
  note: string | null;
  batch_id: string | null;
  expiry_date: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface PurchaseBatchRow {
  id: string;
  household_id: string;
  item_id: string;
  quantity: number;
  remaining_quantity: number;
  purchase_date: string;
  expiry_date: string | null;
  source: string;
  was_frozen: boolean;
  created_at: string;
}

export interface ConsumptionRateRow {
  id: string;
  household_id: string;
  item_id: string;
  daily_rate: number;
  confidence_score: number;
  data_point_count: number;
  category_default: number;
  last_updated: string;
}
