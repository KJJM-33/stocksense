-- migration_001.sql — Engine state columns + FIFO/rate tables
-- Run in Supabase SQL Editor after schema.sql has been applied.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.

-- ─── Extend items with engine state fields ────────────────────────────────────
alter table items
  add column if not exists frozen boolean not null default false,
  add column if not exists confidence_level text not null default 'low',
  add column if not exists last_confirmed_at timestamptz,
  add column if not exists last_inferred_at timestamptz;

-- Add check constraint separately (IF NOT EXISTS not supported for constraints in older PG)
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'items_confidence_level_check' and conrelid = 'items'::regclass
  ) then
    alter table items add constraint items_confidence_level_check
      check (confidence_level in ('high', 'medium', 'low'));
  end if;
end $$;

-- ─── Extend transactions with engine fields ───────────────────────────────────
alter table transactions
  add column if not exists batch_id uuid,
  add column if not exists expiry_date date,
  add column if not exists idempotency_key text;

-- Idempotency index — partial so nulls don't conflict
create unique index if not exists transactions_idempotency_key_idx
  on transactions(idempotency_key) where idempotency_key is not null;

-- Extend the type constraint to include engine-level types.
-- Drop and recreate — PostgreSQL has no ALTER CONSTRAINT for check constraints.
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add constraint transactions_type_check
  check (type in (
    'purchase', 'consumption', 'adjustment', 'waste',
    'correction', 'gift', 'return'
  ));

-- ─── FIFO purchase batches ────────────────────────────────────────────────────
-- Tracks each discrete purchase event so consumption can draw from
-- the oldest stock first (FIFO). Mirrors the in-memory PurchaseBatch type.

create table if not exists purchase_batches (
  id               uuid      primary key default gen_random_uuid(),
  household_id     uuid      not null references households(id) on delete cascade,
  item_id          uuid      not null references items(id) on delete cascade,
  quantity         numeric   not null,
  remaining_quantity numeric  not null,
  purchase_date    timestamptz not null default now(),
  expiry_date      date,
  source           text      not null default 'manual',
  was_frozen       boolean   not null default false,
  created_at       timestamptz not null default now()
);

create index if not exists purchase_batches_household_idx on purchase_batches(household_id);
create index if not exists purchase_batches_item_idx      on purchase_batches(item_id);

alter table purchase_batches enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'purchase_batches' and policyname = 'members can manage purchase batches'
  ) then
    create policy "members can manage purchase batches" on purchase_batches
      for all using (is_household_member(household_id))
      with check (is_household_member(household_id));
  end if;
end $$;

-- ─── Consumption rates ────────────────────────────────────────────────────────
-- Persists the rolling consumption rate per item so the engine can resume
-- from its last calibrated state across requests.

create table if not exists consumption_rates (
  id               uuid      primary key default gen_random_uuid(),
  household_id     uuid      not null references households(id) on delete cascade,
  item_id          uuid      not null references items(id) on delete cascade,
  daily_rate       numeric   not null default 0,
  confidence_score numeric   not null default 0,
  data_point_count int       not null default 0,
  category_default numeric   not null default 0,
  last_updated     timestamptz not null default now(),
  unique(household_id, item_id)
);

create index if not exists consumption_rates_household_idx on consumption_rates(household_id);

alter table consumption_rates enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'consumption_rates' and policyname = 'members can manage consumption rates'
  ) then
    create policy "members can manage consumption rates" on consumption_rates
      for all using (is_household_member(household_id))
      with check (is_household_member(household_id));
  end if;
end $$;
