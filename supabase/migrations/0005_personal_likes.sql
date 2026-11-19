-- 0005 사람별 하트 (설계: docs/superpowers/specs/2026-11-19-shared-likes-journal-design.md)
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

-- 3. 확인: 여행별 사람별 하트 수 (예전 하트가 0이면 옮기기 끝)
select t.title as 여행, coalesce(p.nick, '예전 하트') as 사람, count(*) as 하트
from public.trip_kv k join public.trips t on t.id = k.trip_id
left join public.profiles p on p.id = public.personal_owner(k.key)
where k.key like 'save:%' and k.value->'v' = 'true'::jsonb
group by 1, 2 order by 1, 2;
