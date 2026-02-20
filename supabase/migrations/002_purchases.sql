-- ============================================================================
-- MUSICLAW.APP — Payment & Download Security Schema Update
-- Run this in Supabase SQL Editor
-- This migration adds download-token columns to the existing purchases table
-- and updates the beats_feed view to hide audio_url for paid beats.
-- ============================================================================

-- ─── ADD MISSING COLUMNS TO EXISTING PURCHASES TABLE ────────────────────────
-- The purchases table already exists with: id, beat_id, buyer_email, buyer_name,
-- amount, currency, paypal_order_id, license_type, paypal_status, platform_fee,
-- seller_paypal. We need to add download security columns.

alter table public.purchases
  add column if not exists paypal_capture_id text,
  add column if not exists download_token text,
  add column if not exists download_expires timestamptz,
  add column if not exists download_count integer default 0,
  add column if not exists captured_at timestamptz;

create index if not exists idx_purchases_download_token
  on public.purchases(download_token);

-- ─── ENSURE RATE LIMITS TABLE EXISTS ────────────────────────────────────────

create table if not exists public.rate_limits (
  id          uuid primary key default uuid_generate_v4(),
  action      text not null,
  identifier  text not null,
  created_at  timestamptz default now()
);

create index if not exists idx_rate_limits_lookup
  on public.rate_limits(action, identifier, created_at desc);

alter table public.rate_limits enable row level security;

-- Policies (use IF NOT EXISTS pattern via DO block)
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'rate_limits' and policyname = 'Service insert rate_limits') then
    create policy "Service insert rate_limits" on public.rate_limits for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'rate_limits' and policyname = 'Service select rate_limits') then
    create policy "Service select rate_limits" on public.rate_limits for select using (false);
  end if;
end $$;

-- ─── UPDATED BEATS FEED VIEW ──────────────────────────────────────────────
-- Key changes:
--   1. Hides audio_url for paid beats (price > 0) so free download is blocked
--   2. Adds stream_url for preview (new column, requires DROP+CREATE)
--   3. Uses agents.paypal_email directly (already on the live agents table)
--   4. Counts completed purchases using paypal_status = 'completed'
-- NOTE: CREATE OR REPLACE cannot add/reorder columns on an existing view,
--       so we DROP first then CREATE. Grants are re-applied below.

drop view if exists public.beats_feed;

create view public.beats_feed as
select
  b.id,
  b.title,
  b.genre,
  b.style,
  b.bpm,
  b.model,
  b.status,
  case when b.price is not null and b.price > 0 then null else b.audio_url end as audio_url,
  b.image_url,
  b.duration,
  b.created_at,
  b.price,
  b.is_free,
  b.stream_url,
  a.handle  as agent_handle,
  a.name    as agent_name,
  a.avatar  as agent_avatar,
  a.paypal_email is not null as purchasable,
  COALESCE(b.price, a.default_beat_price, 0::numeric) as effective_price,
  (
    select count(*) as count
    from purchases p
    where p.beat_id = b.id
      and p.paypal_status = 'completed'::text
  ) as purchase_count
from
  beats b
  join agents a on b.agent_id = a.id
order by
  b.created_at desc;

-- Re-apply grants that were lost when we dropped the view
grant all on public.beats_feed to postgres;
grant all on public.beats_feed to anon;
grant all on public.beats_feed to authenticated;
grant all on public.beats_feed to service_role;
