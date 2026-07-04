-- StockSense schema
-- Apply via Supabase SQL editor (or `supabase db push` if using the CLI).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.

create extension if not exists "pgcrypto";

-- ─── Tables ─────────────────────────────────────────────────────────────

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  category text not null default 'uncategorised',
  quantity numeric not null default 0,
  unit text not null default 'unit',
  status text not null default 'ok' check (status in ('ok', 'low', 'out')),
  expiry_date date,
  inferred_expiry_days int,
  location text not null default 'cupboard' check (location in ('fridge', 'freezer', 'cupboard')),
  last_updated timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists items_household_idx on items(household_id);
create unique index if not exists items_household_name_location_idx
  on items(household_id, lower(name), location);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  type text not null check (type in ('purchase', 'consumption', 'adjustment', 'waste')),
  quantity numeric,
  source text not null check (source in ('nfc', 'receipt', 'photo', 'whatsapp', 'sms', 'manual', 'system')),
  -- Set when the source declares status directly (e.g. the NFC tap's
  -- Low/Out/Used-some selector) rather than implying it from a quantity delta.
  declared_status text check (declared_status in ('ok', 'low', 'out')),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists transactions_household_idx on transactions(household_id);
create index if not exists transactions_item_idx on transactions(item_id);

create table if not exists shopping_list (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  quantity_needed numeric not null default 1,
  added_by uuid references members(id) on delete set null,
  sent_to_whatsapp boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists shopping_list_household_idx on shopping_list(household_id);

-- ─── Derived state: items are written only via transactions ───────────────
-- (except the initial stock scan, which seeds items directly as opening stock)

create or replace function apply_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_qty numeric;
  next_qty numeric;
  next_status text;
begin
  select quantity into current_qty from items where id = new.item_id for update;
  current_qty := coalesce(current_qty, 0);

  if new.type = 'purchase' then
    next_qty := current_qty + coalesce(new.quantity, 0);
  elsif new.type in ('consumption', 'waste') then
    next_qty := greatest(current_qty - coalesce(new.quantity, 0), 0);
  else -- adjustment: quantity is an explicit override when provided
    next_qty := coalesce(new.quantity, current_qty);
  end if;

  if new.declared_status is not null then
    next_status := new.declared_status;
  elsif next_qty <= 0 then
    next_status := 'out';
  elsif next_qty <= 1 then
    next_status := 'low';
  else
    next_status := 'ok';
  end if;

  update items
  set quantity = next_qty,
      status = next_status,
      last_updated = now()
  where id = new.item_id;

  return new;
end;
$$;

drop trigger if exists trg_apply_transaction on transactions;
create trigger trg_apply_transaction
  after insert on transactions
  for each row execute function apply_transaction();

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table households enable row level security;
alter table members enable row level security;
alter table items enable row level security;
alter table transactions enable row level security;
alter table shopping_list enable row level security;

-- Helper avoids RLS recursion when a policy on `members` needs to query `members`.
create or replace function is_household_member(target_household_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from members
    where household_id = target_household_id
      and user_id = auth.uid()
  );
$$;

create policy "members can view their household" on households
  for select using (is_household_member(id));

create policy "members can view household members" on members
  for select using (is_household_member(household_id));

create policy "users can add themselves as a member" on members
  for insert with check (user_id = auth.uid());

create policy "members can manage household items" on items
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy "members can manage household transactions" on transactions
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy "members can manage household shopping list" on shopping_list
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- ─── NFC tap: scoped, no-login write path ─────────────────────────────────
-- The /tap flow never authenticates. This function is the ONLY way an
-- unauthenticated request can write data: it validates the household exists,
-- validates the status/location enums, and only ever inserts one transaction
-- (creating the item first if it doesn't exist yet). It cannot read or write
-- anything else, unlike a blanket service-role client.

create or replace function record_tap(
  p_household_id uuid,
  p_item_name text,
  p_location text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid;
  v_type text;
  v_qty numeric;
  v_declared text;
begin
  if p_status not in ('low', 'out', 'used_some') then
    raise exception 'invalid status %', p_status;
  end if;

  if p_location is not null and p_location not in ('fridge', 'freezer', 'cupboard') then
    raise exception 'invalid location %', p_location;
  end if;

  if not exists (select 1 from households where id = p_household_id) then
    raise exception 'unknown household';
  end if;

  select id into v_item_id
  from items
  where household_id = p_household_id
    and lower(name) = lower(trim(p_item_name))
    and (p_location is null or location = p_location)
  limit 1;

  if v_item_id is null then
    insert into items (household_id, name, quantity, status, location, last_updated)
    values (p_household_id, trim(p_item_name), 0, 'ok', coalesce(p_location, 'cupboard'), now())
    returning id into v_item_id;
  end if;

  if p_status = 'used_some' then
    v_type := 'consumption';
    v_qty := 1;
    v_declared := null;
  elsif p_status = 'low' then
    v_type := 'adjustment';
    v_qty := null;
    v_declared := 'low';
  else -- out
    v_type := 'adjustment';
    v_qty := 0;
    v_declared := 'out';
  end if;

  insert into transactions (household_id, item_id, type, quantity, source, declared_status)
  values (p_household_id, v_item_id, v_type, v_qty, 'nfc', v_declared);
end;
$$;

grant execute on function record_tap(uuid, text, text, text) to anon, authenticated;

-- ─── One-time setup for personal (Phase 1) use ─────────────────────────────
-- Run once after applying the schema, then put the returned household id in
-- NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID (see .env.example). Phase 2 (beta, multiple
-- households) will need a per-tag token instead of a single default household.
--
-- insert into households (name) values ('My Household') returning id;
