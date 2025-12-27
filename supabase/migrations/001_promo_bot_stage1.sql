-- Promo Bot Stage 1 (always-on, permission-based autoposter)
-- Safe to run multiple times.

-- 1) promo_zones: where the bot is explicitly allowed to post
create table if not exists public.promo_zones (
  id bigserial primary key,
  telegram_chat_id bigint unique not null,
  name text,
  zone_type text,
  auto_allowed boolean not null default false,
  is_enabled boolean not null default true,
  min_gap_minutes integer not null default 360,
  daily_cap integer not null default 3,
  fail_count integer not null default 0,
  last_error text,
  last_posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add/ensure Stage 1 columns (in case table existed already)
alter table public.promo_zones add column if not exists auto_allowed boolean not null default false;
alter table public.promo_zones add column if not exists is_enabled boolean not null default true;
alter table public.promo_zones add column if not exists min_gap_minutes integer not null default 360;
alter table public.promo_zones add column if not exists daily_cap integer not null default 3;
alter table public.promo_zones add column if not exists fail_count integer not null default 0;
alter table public.promo_zones add column if not exists last_error text;
alter table public.promo_zones add column if not exists last_posted_at timestamptz;
alter table public.promo_zones add column if not exists created_at timestamptz not null default now();
alter table public.promo_zones add column if not exists updated_at timestamptz not null default now();

create index if not exists promo_zones_enabled_idx on public.promo_zones (is_enabled, last_posted_at);
create index if not exists promo_zones_chat_id_idx on public.promo_zones (telegram_chat_id);

-- 2) promo_templates: message variants (optional; bot has env/hard fallbacks)
create table if not exists public.promo_templates (
  id text primary key,
  body text not null,
  weight integer not null default 1,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3) promo_posts: log every attempt
create table if not exists public.promo_posts (
  id bigserial primary key,
  promo_zone_id bigint references public.promo_zones(id) on delete set null,
  telegram_chat_id bigint not null,
  template_id text,
  deep_link text,
  status text not null check (status in ('success','failed')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists promo_posts_chat_day_idx on public.promo_posts (telegram_chat_id, created_at);
create index if not exists promo_posts_zone_idx on public.promo_posts (promo_zone_id, created_at);

-- Optional: keep updated_at fresh (only if you already use triggers elsewhere; otherwise ignore)
-- You can add your standard updated_at trigger here if desired.
