-- 0005 사람별 하트 + 내보낸 사람 다시 못 들어오기 (설계: docs/superpowers/specs/2026-11-19-shared-likes-journal-design.md)
-- Supabase SQL Editor에서 통째로 한 번 실행해요. 다시 실행해도 안전해요.
-- 먼저 모든 폰이 v306 이상이어야 해요(사람별 하트를 읽는 버전).

-- 1. 하트(save:<장소>:<uid>)도 개인 키: 그 사람만 써요 → 보기만도 하트를 누를 수 있어요
create or replace function public.personal_owner(k text)
returns uuid language sql immutable as $$
  select (regexp_match(k, '^(?:exp|tomb|visit:[^:]+|save:[^:]+|gear:[^:]+|prep:[^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'))[1]::uuid;
$$;

-- 2. 예전 공용 하트 'save:<장소>' (켜진 것만) → 'save:<장소>:<마지막으로 쓴 멤버, 없으면 여행 주인>'
do $$
declare r record; target uuid;
begin
  for r in select k.trip_id, k.key, k.value, k.updated_by, t.owner_id from public.trip_kv k join public.trips t on t.id = k.trip_id
           where k.key ~ '^save:[^:]+$' and k.value->'v' is not null and jsonb_typeof(k.value->'v') <> 'null' loop
    if r.value->'v' = 'true'::jsonb then
      target := coalesce((select m.user_id from public.trip_members m where m.trip_id = r.trip_id and m.user_id = r.updated_by), r.owner_id);
      insert into public.trip_kv (trip_id, key, value) values (r.trip_id, r.key || ':' || target, r.value)
        on conflict (trip_id, key) do nothing;
    end if;
    update public.trip_kv set value = jsonb_build_object('v', null, 't', (extract(epoch from now()) * 1000)::bigint)
      where trip_id = r.trip_id and key = r.key;
  end loop;
end $$;

-- 3. 내보낸 사람은 예전 초대 링크로 다시 못 들어와요 (내보낸 뒤 새로 만든 링크로만)
alter table public.trip_invites add column if not exists created_at timestamptz not null default now();
create table if not exists public.trip_kicked (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null,
  at      timestamptz not null default now(),
  primary key (trip_id, user_id)
);
alter table public.trip_kicked enable row level security;
drop policy if exists kicked_read on public.trip_kicked;
create policy kicked_read on public.trip_kicked for select using (public.is_owner(trip_id));

-- 다른 사람이 멤버 줄을 지우면(=내보내기) 기록해요. 스스로 나가기, 여행 삭제는 기록하지 않아요
create or replace function public.trip_member_gone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> old.user_id
     and exists (select 1 from public.trips t where t.id = old.trip_id) then
    insert into public.trip_kicked (trip_id, user_id) values (old.trip_id, old.user_id)
      on conflict (trip_id, user_id) do update set at = now();
  end if;
  return old;
end $$;
drop trigger if exists trip_members_gone on public.trip_members;
create trigger trip_members_gone after delete on public.trip_members for each row execute function public.trip_member_gone();

create or replace function public.join_trip(invite text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.trip_invites; added int;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select * into inv from public.trip_invites
   where code = invite and revoked_at is null and expires_at > now()
   for update;
  if not found then raise exception '초대 링크가 끝났어요'; end if;
  if exists (select 1 from public.trip_kicked k where k.trip_id = inv.trip_id and k.user_id = auth.uid() and k.at >= inv.created_at) then
    raise exception 'kicked';
  end if;
  insert into public.trip_members (trip_id, user_id, role)
  values (inv.trip_id, auth.uid(), inv.role)
  on conflict (trip_id, user_id) do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    update public.trip_invites set uses = uses + 1, used_by = auth.uid(), used_at = now() where code = invite;
    delete from public.trip_kicked where trip_id = inv.trip_id and user_id = auth.uid();
  end if;
  return inv.trip_id;
end $$;

-- 4. 확인: 여행별 사람별 하트 수 (예전 하트가 0이면 옮기기 끝)
select t.title as 여행, coalesce(p.nick, '예전 하트') as 사람, count(*) as 하트
from public.trip_kv k join public.trips t on t.id = k.trip_id
left join public.profiles p on p.id = public.personal_owner(k.key)
where k.key like 'save:%' and k.value->'v' = 'true'::jsonb
group by 1, 2 order by 1, 2;
