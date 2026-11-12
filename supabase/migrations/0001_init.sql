-- 도쿄 여행 앱 · 서버 버전 S-1 기본 표와 권한 (2026-11-12)
-- Supabase SQL Editor에 그대로 붙여 넣어 실행합니다.
-- 이 파일에는 키·예약번호·개인정보가 없습니다. (값은 모두 DB 안에만 저장)
--
-- 구조 요약
--   profiles      계정별 이름·역할 (가입하면 자동 생성)
--   trips         여행 (원본 일정 파일을 jsonb로 보관)
--   trip_members  여행 멤버와 권한 (owner / editor / viewer)
--   trip_invites  초대 코드
--   trip_kv       함께 쓰는 변경 (지금 웹앱의 공유 키: edit:, done:, exp, myplaces …) → 실시간 구독
--   trip_secrets  예약번호·바우처 등 민감 값 (멤버만, 사용 기록·어드민 집계에서 제외)
--   requests      앱 요청함
--   usage_events  기능 사용 기록 (버튼 이름만, 내용 없음)
--   ai_calls      AI·구글 호출 횟수·비용
--   storage 'docs' 비공개 버킷: <trip_id>/<파일> 경로, 멤버만

-- ───────── 공통 ─────────
create or replace function public.touch_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ───────── 계정 ─────────
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nick        text not null default '여행자',
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nick)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'nickname', '여행자'));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 역할은 본인이 바꿀 수 없음 (이름만 수정 가능)
create or replace function public.keep_role()
returns trigger language plpgsql as $$
begin
  -- SQL Editor(로그인 없음)에서는 바꿀 수 있음 → 첫 관리자 지정용
  if new.role is distinct from old.role and auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
  end if;
  return new;
end $$;
create trigger profiles_keep_role before update on public.profiles
  for each row execute function public.keep_role();

-- ───────── 여행 ─────────
create table public.trips (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique,                       -- 예: tokyo-2026-11
  title       text not null,
  start_date  date,
  end_date    date,
  timezone    text not null default 'Asia/Tokyo',
  plan        jsonb not null default '{}'::jsonb, -- 원본 일정 파일 (data/trip.json 과 같은 모양)
  plan_rev    int not null default 1,
  owner_id    uuid not null default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create trigger trips_touch before update on public.trips
  for each row execute function public.touch_updated();

create table public.trip_members (
  trip_id    uuid not null references public.trips(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  joined_at  timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index trip_members_user on public.trip_members(user_id);

create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid());
$$;

create or replace function public.can_edit(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members
                 where trip_id = t and user_id = auth.uid() and role in ('owner', 'editor'));
$$;

create or replace function public.is_owner(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members
                 where trip_id = t and user_id = auth.uid() and role = 'owner');
$$;

-- 여행을 만들면 만든 사람이 owner 멤버가 됨
create or replace function public.add_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end $$;
create trigger trips_add_owner after insert on public.trips
  for each row execute function public.add_owner();

-- ───────── 초대 ─────────
create table public.trip_invites (
  code        text primary key default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  role        text not null default 'editor' check (role in ('editor', 'viewer')),
  expires_at  timestamptz not null default now() + interval '7 days',
  created_by  uuid not null default auth.uid(),
  used_by     uuid,
  used_at     timestamptz
);

create or replace function public.join_trip(invite text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.trip_invites;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select * into inv from public.trip_invites
   where code = invite and used_at is null and expires_at > now()
   for update;
  if not found then raise exception '초대 코드가 없거나 만료됐어요'; end if;
  insert into public.trip_members (trip_id, user_id, role)
  values (inv.trip_id, auth.uid(), inv.role)
  on conflict (trip_id, user_id) do nothing;
  update public.trip_invites set used_by = auth.uid(), used_at = now() where code = invite;
  return inv.trip_id;
end $$;

-- ───────── 함께 쓰는 변경 (실시간) ─────────
-- key 예: 'edit:d3-lunch', 'done:d1-limo', 'exp', 'myplaces', 'budget'
create table public.trip_kv (
  trip_id     uuid not null references public.trips(id) on delete cascade,
  key         text not null,
  value       jsonb,                 -- null 이면 지운 것 (다른 폰에도 지움을 전달)
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (trip_id, key)
);
create trigger trip_kv_touch before insert or update on public.trip_kv
  for each row execute function public.touch_updated();

-- 민감 값: 예약번호(pnr), 숙소 예약(agoda), eSIM, 문서 목록(cdocs) 등
create table public.trip_secrets (
  trip_id     uuid not null references public.trips(id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (trip_id, key)
);
create trigger trip_secrets_touch before insert or update on public.trip_secrets
  for each row execute function public.touch_updated();

-- ───────── 운영 ─────────
create table public.requests (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  trip_id     uuid references public.trips(id) on delete set null,
  body        text not null,
  status      text not null default 'open' check (status in ('open', 'doing', 'done', 'rejected')),
  reply       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create trigger requests_touch before update on public.requests
  for each row execute function public.touch_updated();

create table public.usage_events (
  id          bigint generated always as identity primary key,
  user_id     uuid default auth.uid(),
  trip_id     uuid,
  name        text not null check (length(name) <= 60),   -- 예: 'quick.late', 'tab.today'
  app_version text,
  at          timestamptz not null default now()
);
create index usage_events_at on public.usage_events(at);
create index usage_events_name on public.usage_events(name, at);

create table public.ai_calls (
  id          bigint generated always as identity primary key,
  user_id     uuid,
  kind        text not null,            -- 'claude' | 'google.places' | 'fx' …
  model       text,
  tokens_in   int,
  tokens_out  int,
  cost_usd    numeric(10, 5),
  ok          boolean not null default true,
  at          timestamptz not null default now()
);
create index ai_calls_at on public.ai_calls(at);

-- ───────── 권한 (RLS) ─────────
alter table public.profiles      enable row level security;
alter table public.trips         enable row level security;
alter table public.trip_members  enable row level security;
alter table public.trip_invites  enable row level security;
alter table public.trip_kv       enable row level security;
alter table public.trip_secrets  enable row level security;
alter table public.requests      enable row level security;
alter table public.usage_events  enable row level security;
alter table public.ai_calls      enable row level security;

-- profiles: 본인과 같은 여행 멤버의 이름만 보임
create policy profiles_read on public.profiles for select using (
  id = auth.uid() or public.is_admin() or exists (
    select 1 from public.trip_members a join public.trip_members b on a.trip_id = b.trip_id
    where a.user_id = auth.uid() and b.user_id = profiles.id)
);
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- trips
create policy trips_read   on public.trips for select using (owner_id = auth.uid() or public.is_member(id));
create policy trips_insert on public.trips for insert with check (owner_id = auth.uid());
create policy trips_update on public.trips for update using (public.can_edit(id)) with check (public.can_edit(id));
create policy trips_delete on public.trips for delete using (public.is_owner(id));

-- trip_members: 멤버끼리 서로 보임, 추가·변경·삭제는 owner (본인 나가기는 허용)
create policy members_read   on public.trip_members for select using (public.is_member(trip_id));
create policy members_update on public.trip_members for update using (public.is_owner(trip_id)) with check (public.is_owner(trip_id));
create policy members_delete on public.trip_members for delete using (public.is_owner(trip_id) or user_id = auth.uid());

-- trip_invites: owner만 만들고 봄 (참여는 join_trip 함수로)
create policy invites_owner on public.trip_invites for all
  using (public.is_owner(trip_id)) with check (public.is_owner(trip_id));

-- trip_kv: 멤버 읽기, editor 이상 쓰기
create policy kv_read   on public.trip_kv for select using (public.is_member(trip_id));
create policy kv_insert on public.trip_kv for insert with check (public.can_edit(trip_id));
create policy kv_update on public.trip_kv for update using (public.can_edit(trip_id)) with check (public.can_edit(trip_id));
create policy kv_delete on public.trip_kv for delete using (public.can_edit(trip_id));

-- trip_secrets: 같은 규칙, 관리자 예외 없음
create policy secrets_read   on public.trip_secrets for select using (public.is_member(trip_id));
create policy secrets_insert on public.trip_secrets for insert with check (public.can_edit(trip_id));
create policy secrets_update on public.trip_secrets for update using (public.can_edit(trip_id)) with check (public.can_edit(trip_id));
create policy secrets_delete on public.trip_secrets for delete using (public.can_edit(trip_id));

-- requests: 본인 것만, 관리자는 전체 보고 상태 변경
create policy requests_read   on public.requests for select using (user_id = auth.uid() or public.is_admin());
create policy requests_insert on public.requests for insert with check (user_id = auth.uid());
create policy requests_admin  on public.requests for update using (public.is_admin()) with check (public.is_admin());

-- usage_events: 로그인한 사람은 본인 기록만 남김, 읽기는 관리자
create policy usage_insert on public.usage_events for insert with check (user_id = auth.uid());
create policy usage_admin  on public.usage_events for select using (public.is_admin());

-- ai_calls: 서버 함수(service role)만 기록, 읽기는 관리자
create policy ai_admin on public.ai_calls for select using (public.is_admin());

-- ───────── 실시간 ─────────
alter publication supabase_realtime add table public.trip_kv, public.trip_secrets, public.trips;

-- ───────── 파일 (바우처·영수증·문서 사진) ─────────
insert into storage.buckets (id, name, public) values ('docs', 'docs', false)
on conflict (id) do nothing;

create policy docs_read on storage.objects for select
  using (bucket_id = 'docs' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy docs_write on storage.objects for insert
  with check (bucket_id = 'docs' and public.can_edit(((storage.foldername(name))[1])::uuid));
create policy docs_delete on storage.objects for delete
  using (bucket_id = 'docs' and public.can_edit(((storage.foldername(name))[1])::uuid));
