-- About Time — Supabase schema
--
-- Host project: Pulse (kjlmkjkzbbnzdpvjhkxz). This file is ADDITIVE: it creates
-- new, prefixed objects only and never alters Pulse's `sync_rows` table.
--
-- Apply: Supabase Dashboard → SQL Editor → paste this whole file → Run.
-- Idempotent: safe to re-run.
--
-- Before the app will work, one dashboard toggle is required:
--   Authentication → Sign In / Providers → "Allow anonymous sign-ins" = ON.
-- Every device gets an invisible anonymous account; the user only ever sees a
-- first name and a room code.

create extension if not exists pgcrypto;

-- ── Tables ────────────────────────────────────────────────────────────────

-- One outing = one event ("Sunday service", "Ruth & Tom's wedding").
-- The 6-character code is the only thing shared between phones.
create table if not exists public.at_outings (
  id          uuid        primary key default gen_random_uuid(),
  code        text        not null unique,
  title       text        not null default 'Outing',
  created_by  uuid        references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint at_outings_code_format check (code ~ '^[A-HJ-NP-Z2-9]{6}$')
);

-- One row per person per outing. This is the realtime table.
create table if not exists public.at_members (
  id                uuid        primary key default gen_random_uuid(),
  outing_id         uuid        not null references public.at_outings (id) on delete cascade,
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  name              text        not null,
  emoji             text        not null default '🙂',
  battery           smallint    not null default 100 check (battery between 0 and 100),
  ready             boolean     not null default false,
  ready_at          timestamptz,
  last_notified_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (outing_id, user_id)
);

create index if not exists at_members_outing on public.at_members (outing_id);

-- Web Push subscriptions, one per device/browser.
create table if not exists public.at_push_subscriptions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  outing_id   uuid        references public.at_outings (id) on delete cascade,
  endpoint    text        not null unique,
  p256dh      text        not null,
  auth        text        not null,
  created_at  timestamptz not null default now()
);

-- ── Membership helper ─────────────────────────────────────────────────────
-- SECURITY DEFINER so the members SELECT policy can ask "am I in this outing?"
-- without recursing into its own RLS policy.
create or replace function public.at_is_member(p_outing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.at_members m
    where m.outing_id = p_outing_id
      and m.user_id = auth.uid()
  );
$$;

-- ── Row-level security ────────────────────────────────────────────────────
alter table public.at_outings           enable row level security;
alter table public.at_members           enable row level security;
alter table public.at_push_subscriptions enable row level security;

-- Outings: you can read an outing only after you are a member of it.
drop policy if exists at_outings_select on public.at_outings;
create policy at_outings_select on public.at_outings
  for select using (public.at_is_member(id));

-- Members: everyone in the outing can see everyone else; you may only edit
-- or remove your own row. Inserts happen exclusively through the RPCs below.
drop policy if exists at_members_select on public.at_members;
create policy at_members_select on public.at_members
  for select using (public.at_is_member(outing_id));

drop policy if exists at_members_update on public.at_members;
create policy at_members_update on public.at_members
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.at_is_member(outing_id));

drop policy if exists at_members_delete on public.at_members;
create policy at_members_delete on public.at_members
  for delete using (user_id = auth.uid());

-- Push subscriptions: private to the device that created them.
drop policy if exists at_push_select on public.at_push_subscriptions;
create policy at_push_select on public.at_push_subscriptions
  for select using (user_id = auth.uid());

drop policy if exists at_push_insert on public.at_push_subscriptions;
create policy at_push_insert on public.at_push_subscriptions
  for insert with check (user_id = auth.uid());

drop policy if exists at_push_update on public.at_push_subscriptions;
create policy at_push_update on public.at_push_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists at_push_delete on public.at_push_subscriptions;
create policy at_push_delete on public.at_push_subscriptions
  for delete using (user_id = auth.uid());

-- ── Room codes ────────────────────────────────────────────────────────────
-- Unambiguous alphabet: no I, O, 0 or 1 to mistype at a noisy reception.
create or replace function public.at_generate_code()
returns text
language sql
volatile
set search_path = public
as $$
  select string_agg(
    substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (floor(random() * 32) + 1)::int, 1),
    ''
    order by g
  )
  from generate_series(1, 6) as g;
$$;

-- ── Create an outing ──────────────────────────────────────────────────────
create or replace function public.at_create_outing(
  p_title text,
  p_name  text,
  p_emoji text default '🙂'
)
returns table (outing_id uuid, outing_code text, outing_title text, member_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- The OUT parameters below share names with at_members columns. Without this,
-- `on conflict (outing_id, user_id)` raises "column reference is ambiguous".
declare
  v_code   text;
  v_outing uuid;
  v_member uuid;
  v_try    int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'A name is required' using errcode = '22023';
  end if;

  loop
    v_try := v_try + 1;
    v_code := public.at_generate_code();
    begin
      insert into public.at_outings as o (code, title, created_by)
      values (v_code, coalesce(nullif(btrim(p_title), ''), 'Outing'), auth.uid())
      returning o.id into v_outing;
      exit;
    exception when unique_violation then
      if v_try >= 8 then
        raise;
      end if;
    end;
  end loop;

  insert into public.at_members as m (outing_id, user_id, name, emoji)
  values (v_outing, auth.uid(), left(btrim(p_name), 24), coalesce(nullif(p_emoji, ''), '🙂'))
  returning m.id into v_member;

  return query
    select v_outing, v_code, o.title, v_member
    from public.at_outings o
    where o.id = v_outing;
end;
$$;

-- ── Join an outing by code ────────────────────────────────────────────────
-- Rejoining with the same device updates your name/emoji instead of creating
-- a duplicate row.
create or replace function public.at_join_outing(
  p_code  text,
  p_name  text,
  p_emoji text default '🙂'
)
returns table (outing_id uuid, outing_code text, outing_title text, member_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- See at_create_outing: OUT parameters shadow at_members column names.
declare
  v_code   text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_outing public.at_outings;
  v_member uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'A name is required' using errcode = '22023';
  end if;

  select * into v_outing from public.at_outings o where o.code = v_code;
  if not found then
    raise exception 'No outing with that code' using errcode = 'P0002';
  end if;

  insert into public.at_members as m (outing_id, user_id, name, emoji)
  values (v_outing.id, auth.uid(), left(btrim(p_name), 24), coalesce(nullif(p_emoji, ''), '🙂'))
  on conflict (outing_id, user_id) do update
    set name       = excluded.name,
        emoji      = excluded.emoji,
        updated_at = now()
  returning m.id into v_member;

  return query select v_outing.id, v_outing.code, v_outing.title, v_member;
end;
$$;

-- ── Leave an outing ───────────────────────────────────────────────────────
-- Removes your row; the outing itself is cleaned up when the last person leaves.
create or replace function public.at_leave_outing(p_outing_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.at_members
  where outing_id = p_outing_id and user_id = auth.uid();

  if not exists (select 1 from public.at_members where outing_id = p_outing_id) then
    delete from public.at_outings where id = p_outing_id;
  end if;
end;
$$;

-- ── Privileges ────────────────────────────────────────────────────────────
grant select, insert, update, delete on public.at_outings            to authenticated;
grant select, insert, update, delete on public.at_members            to authenticated;
grant select, insert, update, delete on public.at_push_subscriptions to authenticated;

grant execute on function public.at_is_member(uuid)               to authenticated;
grant execute on function public.at_create_outing(text, text, text) to authenticated;
grant execute on function public.at_join_outing(text, text, text)   to authenticated;
grant execute on function public.at_leave_outing(uuid)             to authenticated;

-- ── Realtime ──────────────────────────────────────────────────────────────
-- Realtime honours RLS, so subscribers only receive rows for outings they
-- belong to. FULL identity makes UPDATE/DELETE payloads complete.
alter table public.at_members replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'at_members'
  ) then
    alter publication supabase_realtime add table public.at_members;
  end if;
end $$;

-- ── Sanity check ──────────────────────────────────────────────────────────
do $$
declare
  v_rls boolean;
begin
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.at_members'::regclass;
  if v_rls then
    raise notice 'OK: at_members has row-level security enabled';
  end if;
end $$;
