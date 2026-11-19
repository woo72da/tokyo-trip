-- 0004 역할·개인 기록·변경 기록 (설계: docs/superpowers/specs/2026-11-19-roles-history-design.md)
-- Supabase SQL Editor에서 통째로 한 번 실행해요. 다시 실행해도 안전해요.
-- 먼저 모든 폰이 v303 이상이어야 해요(사람별 키를 읽는 버전).

-- ───────── 1. 개인 키: 그 사람만 써요 ─────────
-- exp:<uid> 경비 줄, tomb:<uid> 지운 표시, visit:<장소>:<uid> 리뷰, gear:<날짜>:<uid>, prep:<날짜>:<uid>
create or replace function public.personal_owner(k text)
returns uuid language sql immutable as $$
  select (regexp_match(k, '^(?:exp|tomb|visit:[^:]+|gear:[^:]+|prep:[^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'))[1]::uuid;
$$;

-- 개인 키는 본인(여행 멤버)만, 그 밖의 키(일정 등)는 여행 마스터·함께 편집만
create or replace function public.can_write_key(t uuid, k text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when public.personal_owner(k) is not null
              then public.personal_owner(k) = auth.uid() and public.is_member(t)
              else public.can_edit(t) end;
$$;

drop policy if exists kv_insert on public.trip_kv;
drop policy if exists kv_update on public.trip_kv;
drop policy if exists kv_delete on public.trip_kv;
create policy kv_insert on public.trip_kv for insert with check (public.can_write_key(trip_id, key));
create policy kv_update on public.trip_kv for update using (public.can_write_key(trip_id, key)) with check (public.can_write_key(trip_id, key));
create policy kv_delete on public.trip_kv for delete using (public.can_write_key(trip_id, key));

-- 영수증 사진: 보기만인 사람도 내 경비 영수증(이름에 'rcpt-'와 내 계정 id)은 올리고 지울 수 있어요
drop policy if exists docs_write_rcpt on storage.objects;
drop policy if exists docs_delete_rcpt on storage.objects;
create policy docs_write_rcpt on storage.objects for insert
  with check (bucket_id = 'docs' and public.is_member(((storage.foldername(name))[1])::uuid)
              and name like '%/rcpt-%' and position(auth.uid()::text in name) > 0);
create policy docs_delete_rcpt on storage.objects for delete
  using (bucket_id = 'docs' and public.is_member(((storage.foldername(name))[1])::uuid)
         and name like '%/rcpt-%' and position(auth.uid()::text in name) > 0);

-- ───────── 2. 맡은 날짜, 초대 기본 권한 ─────────
alter table public.trip_members add column if not exists days date[];   -- null = 모든 날
alter table public.trip_invites alter column role set default 'viewer'; -- 새 초대 링크는 '보기만'으로 들어와요 (이미 있는 링크는 그대로)

-- ───────── 3. 예전 기록 옮기기 (경비 by는 그대로, 들어갈 줄만 정해요) ─────────
-- 옮기기 전 사람별 경비 합계 (같은 id는 하나로)
drop table if exists pg_temp.exp_before;
create temp table exp_before as
  select trip_id, by, sum(amount) as total, count(*) as n from (
    select distinct on (k.trip_id, e->>'id') k.trip_id, e->>'by' as by, coalesce((e->>'amount')::numeric, 0) as amount
    from public.trip_kv k, jsonb_array_elements(case when jsonb_typeof(k.value->'v') = 'array' then k.value->'v' else '[]'::jsonb end) e
    where k.key = 'exp' or k.key like 'exp:%'
    order by k.trip_id, e->>'id', coalesce((e->>'at')::numeric, 0) desc
  ) s group by trip_id, by;

do $$
declare r record; b record; cur jsonb; merged jsonb; ms bigint := (extract(epoch from now()) * 1000)::bigint; target uuid;
begin
  -- 경비: 옛 'exp' 줄 → 사람별 'exp:<uid>' 줄 (낸 사람이 여행메이트면 그 사람 줄, 아니면 여행 주인 줄)
  for r in select k.trip_id, k.value, t.owner_id from public.trip_kv k join public.trips t on t.id = k.trip_id
           where k.key = 'exp' and jsonb_typeof(k.value->'v') = 'array' and jsonb_array_length(k.value->'v') > 0 loop
    -- by를 uuid로 바꾸지 않고 멤버 표에서 찾아요 ('안드레아' 같은 이름이 섞여 있어서)
    for b in select coalesce((select m.user_id from public.trip_members m where m.trip_id = r.trip_id and m.user_id::text = e->>'by'),
                             r.owner_id) as own, jsonb_agg(e) as items
             from jsonb_array_elements(r.value->'v') e group by 1 loop
      select value->'v' into cur from public.trip_kv where trip_id = r.trip_id and key = 'exp:' || b.own;
      select coalesce(jsonb_agg(x), '[]'::jsonb) into merged from (
        select distinct on (x->>'id') x from jsonb_array_elements(
          case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end || b.items) x
        order by x->>'id', coalesce((x->>'at')::numeric, 0) desc) s;
      insert into public.trip_kv (trip_id, key, value) values (r.trip_id, 'exp:' || b.own, jsonb_build_object('v', merged, 't', ms))
        on conflict (trip_id, key) do update set value = excluded.value;
    end loop;
    update public.trip_kv set value = jsonb_build_object('v', '[]'::jsonb, 't', ms) where trip_id = r.trip_id and key = 'exp';
  end loop;

  -- 리뷰: 'visit:<장소>' → 'visit:<장소>:<주인>' (마지막으로 쓴 사람 → 기록의 by → 여행 주인)
  for r in select k.trip_id, k.key, k.value, k.updated_by, t.owner_id from public.trip_kv k join public.trips t on t.id = k.trip_id
           where k.key ~ '^visit:[^:]+$' and k.value->'v' is not null and jsonb_typeof(k.value->'v') <> 'null' loop
    target := coalesce((select m.user_id from public.trip_members m where m.trip_id = r.trip_id and m.user_id = r.updated_by),
                       (select m.user_id from public.trip_members m where m.trip_id = r.trip_id and m.user_id::text = r.value->'v'->>'by'),
                       r.owner_id);
    insert into public.trip_kv (trip_id, key, value) values (r.trip_id, r.key || ':' || target, r.value)
      on conflict (trip_id, key) do update set value = excluded.value
      where coalesce((public.trip_kv.value->>'t')::numeric, 0) < coalesce((excluded.value->>'t')::numeric, 0);
    update public.trip_kv set value = jsonb_build_object('v', null, 't', ms) where trip_id = r.trip_id and key = r.key;
  end loop;

  -- 아침 준비 체크: 'prep:<날짜>' → 여행 주인 것
  for r in select k.trip_id, k.key, k.value, t.owner_id from public.trip_kv k join public.trips t on t.id = k.trip_id
           where k.key ~ '^prep:[^:]+$' and k.value->'v' is not null and jsonb_typeof(k.value->'v') <> 'null' loop
    insert into public.trip_kv (trip_id, key, value) values (r.trip_id, r.key || ':' || r.owner_id, r.value)
      on conflict (trip_id, key) do nothing;
    update public.trip_kv set value = jsonb_build_object('v', null, 't', ms) where trip_id = r.trip_id and key = r.key;
  end loop;

  -- 지운 표시: 옛 'tomb' → 여행 주인의 'tomb:<uid>'에 합쳐 둠 (옛 줄은 그대로)
  for r in select k.trip_id, k.value, t.owner_id from public.trip_kv k join public.trips t on t.id = k.trip_id
           where k.key = 'tomb' and jsonb_typeof(k.value->'v') = 'object' loop
    insert into public.trip_kv (trip_id, key, value) values (r.trip_id, 'tomb:' || r.owner_id, jsonb_build_object('v', r.value->'v', 't', ms))
      on conflict (trip_id, key) do update set value = jsonb_build_object('v', (public.trip_kv.value->'v') || (excluded.value->'v'), 't', ms);
  end loop;
end $$;

-- ───────── 4. 변경 기록 (누가·언제·무엇을) ─────────
create table if not exists public.trip_log (
  id       bigint generated always as identity primary key,
  trip_id  uuid not null references public.trips(id) on delete cascade,
  key      text not null,
  old      jsonb,            -- 예약번호(trip_secrets)는 값을 남기지 않아요
  new      jsonb,
  by       uuid,
  at       timestamptz not null default now()
);
create index if not exists trip_log_trip on public.trip_log (trip_id, id desc);
alter table public.trip_log enable row level security;
drop policy if exists log_read on public.trip_log;
create policy log_read on public.trip_log for select using (public.is_member(trip_id));

create or replace function public.trip_log_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare cut bigint;
begin
  if new.key like 'route:%' or new.key like 'tomb%' then return new; end if;
  if tg_op = 'UPDATE' and old.value->'v' is not distinct from new.value->'v' then return new; end if;
  insert into public.trip_log (trip_id, key, old, new, by)
  values (new.trip_id, new.key,
          case when tg_table_name = 'trip_secrets' or tg_op = 'INSERT' then null else old.value->'v' end,
          case when tg_table_name = 'trip_secrets' then null else new.value->'v' end,
          coalesce(auth.uid(), new.updated_by));
  -- 여행마다 최근 2000건만 남겨요
  select id into cut from public.trip_log where trip_id = new.trip_id order by id desc offset 2000 limit 1;
  if cut is not null then delete from public.trip_log where trip_id = new.trip_id and id <= cut; end if;
  return new;
end $$;

drop trigger if exists trip_kv_log on public.trip_kv;
drop trigger if exists trip_secrets_log on public.trip_secrets;
create trigger trip_kv_log after insert or update on public.trip_kv for each row execute function public.trip_log_write();
create trigger trip_secrets_log after insert or update on public.trip_secrets for each row execute function public.trip_log_write();

-- ───────── 5. 확인: 사람별 경비 합계가 옮기기 전과 같아야 해요 (모두 '같아요'면 성공) ─────────
select t.title as 여행, coalesce(b.by, a.by) as 낸사람, b.n as 전_건수, a.n as 후_건수, b.total as 전_합계, a.total as 후_합계,
       case when b.total is not distinct from a.total and b.n is not distinct from a.n then '같아요' else '다름 - 알려 주세요' end as 결과
from exp_before b
full join (
  select trip_id, by, sum(amount) as total, count(*) as n from (
    select distinct on (k.trip_id, e->>'id') k.trip_id, e->>'by' as by, coalesce((e->>'amount')::numeric, 0) as amount
    from public.trip_kv k, jsonb_array_elements(case when jsonb_typeof(k.value->'v') = 'array' then k.value->'v' else '[]'::jsonb end) e
    where k.key like 'exp:%'
    order by k.trip_id, e->>'id', coalesce((e->>'at')::numeric, 0) desc
  ) s group by trip_id, by
) a on a.trip_id = b.trip_id and a.by is not distinct from b.by
join public.trips t on t.id = coalesce(a.trip_id, b.trip_id)
order by 1, 2;
