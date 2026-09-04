-- DollarDisha: US-equity research database
-- Run this once in Supabase > SQL Editor > New query.

create extension if not exists pgcrypto;

create table if not exists public.companies (
  symbol text primary key,
  company_name text not null,
  exchange text,
  sector text,
  industry text,
  cik text,
  website text,
  description text,
  market_cap numeric,
  is_active boolean not null default true,
  source_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.company_quotes (
  symbol text primary key references public.companies(symbol) on delete cascade,
  price numeric,
  change_percent numeric,
  previous_close numeric,
  day_high numeric,
  day_low numeric,
  volume bigint,
  market_cap numeric,
  as_of timestamptz not null default now()
);

create table if not exists public.company_financials (
  id bigint generated always as identity primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  statement_type text not null check (statement_type in ('income','balance','cashflow','ratios')),
  period_type text not null check (period_type in ('annual','quarterly','ttm')),
  fiscal_year integer,
  fiscal_period text,
  period_end date,
  values jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique(symbol, statement_type, period_type, fiscal_year, fiscal_period)
);

create index if not exists company_financials_lookup on public.company_financials(symbol, statement_type, period_type, period_end desc);

-- Flat, screen-ready values are kept separately from the raw statements. This
-- lets the screener reuse a refreshed metric snapshot without re-requesting a
-- provider for every visitor or server restart.
create table if not exists public.screener_metric_snapshots (
  symbol text not null,
  metric_group text not null check (metric_group in ('ratio','financial','price')),
  values jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz not null default now(),
  primary key (symbol, metric_group)
);

create index if not exists screener_metric_snapshots_freshness on public.screener_metric_snapshots(metric_group, source_updated_at desc);

create table if not exists public.company_events (
  id bigint generated always as identity primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  event_type text not null check (event_type in ('sec_filing','news','earnings','insider_trade','institutional_ownership')),
  title text not null,
  summary text,
  url text,
  published_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists company_events_lookup on public.company_events(symbol, event_type, published_at desc);

create table if not exists public.screen_definitions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  description text,
  query jsonb not null default '{}'::jsonb,
  columns jsonb not null default '[]'::jsonb,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  created_at timestamptz not null default now(),
  unique(owner_id, name)
);

create table if not exists public.watchlist_items (
  watchlist_id uuid not null references public.watchlists(id) on delete cascade,
  symbol text not null references public.companies(symbol) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (watchlist_id, symbol)
);

create table if not exists public.custom_indexes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  benchmark_symbol text,
  created_at timestamptz not null default now()
);

create table if not exists public.custom_index_items (
  custom_index_id uuid not null references public.custom_indexes(id) on delete cascade,
  symbol text not null references public.companies(symbol) on delete cascade,
  weight numeric not null default 0 check (weight >= 0 and weight <= 100),
  primary key (custom_index_id, symbol)
);

create table if not exists public.data_sync_runs (
  id bigint generated always as identity primary key,
  source text not null,
  job_name text not null,
  status text not null check (status in ('running','success','failed')),
  records_processed integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- One private, durable research workspace per signed-in user. The browser
-- keeps an offline copy and merges it into this row after authentication.
create table if not exists public.research_state (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  watchlist jsonb not null default '[]'::jsonb,
  custom_index jsonb not null default '{"name":"My Index","symbols":[]}'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  alerts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Research data is readable by visitors. Personal data remains private until
-- DollarDisha sign-in is added; ingestion will use a server-only service key.
alter table public.companies enable row level security;
alter table public.company_quotes enable row level security;
alter table public.company_financials enable row level security;
alter table public.screener_metric_snapshots enable row level security;
alter table public.company_events enable row level security;
alter table public.screen_definitions enable row level security;
alter table public.watchlists enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.custom_indexes enable row level security;
alter table public.custom_index_items enable row level security;
alter table public.data_sync_runs enable row level security;
alter table public.research_state enable row level security;

create policy "Public can read companies" on public.companies for select using (true);
create policy "Public can read quotes" on public.company_quotes for select using (true);
create policy "Public can read financials" on public.company_financials for select using (true);
create policy "Public can read screener metric snapshots" on public.screener_metric_snapshots for select using (true);
create policy "Public can read company events" on public.company_events for select using (true);

drop policy if exists "Users can read own research state" on public.research_state;
drop policy if exists "Users can create own research state" on public.research_state;
drop policy if exists "Users can update own research state" on public.research_state;
drop policy if exists "Users can delete own research state" on public.research_state;
create policy "Users can read own research state" on public.research_state for select to authenticated using (auth.uid() = owner_id);
create policy "Users can create own research state" on public.research_state for insert to authenticated with check (auth.uid() = owner_id);
create policy "Users can update own research state" on public.research_state for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Users can delete own research state" on public.research_state for delete to authenticated using (auth.uid() = owner_id);
