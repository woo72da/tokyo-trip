-- 어드민 A (S-4): Supabase 화면에서 바로 보는 요약 (2026-11-12)
-- SQL Editor에 붙여 넣어 실행 → Table Editor 왼쪽 목록의 admin_… 이 요약 표예요.
-- security_invoker: 보는 사람 권한(RLS)으로 계산 → 앱에서는 관리자만 보임

-- 기능별 사용 순위 (최근 30일)
create or replace view public.admin_feature_usage with (security_invoker = true) as
select e.name                                   as 기능,
       count(*)                                 as 사용_횟수,
       count(distinct e.user_id)                as 사용한_사람,
       to_char(max(e.at) at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') as 마지막_사용
from public.usage_events e
where e.at > now() - interval '30 days'
group by e.name
order by count(*) desc;

-- 날짜별 (도쿄 날짜): 버튼 사용, Claude·구글 호출, 토큰
create or replace view public.admin_daily with (security_invoker = true) as
with days as (
  select (at at time zone 'Asia/Tokyo')::date as d from public.usage_events
  union select (at at time zone 'Asia/Tokyo')::date from public.ai_calls
)
select d as 날짜,
       (select count(*) from public.usage_events u where (u.at at time zone 'Asia/Tokyo')::date = d)                         as 버튼_사용,
       (select count(distinct u.user_id) from public.usage_events u where (u.at at time zone 'Asia/Tokyo')::date = d)        as 사용한_사람,
       (select count(*) from public.ai_calls a where a.kind = 'claude' and (a.at at time zone 'Asia/Tokyo')::date = d)        as claude_호출,
       (select count(*) from public.ai_calls a where a.kind like 'google%' and (a.at at time zone 'Asia/Tokyo')::date = d)    as 구글_호출,
       (select coalesce(sum(a.tokens_in), 0) from public.ai_calls a where (a.at at time zone 'Asia/Tokyo')::date = d)         as 입력_토큰,
       (select coalesce(sum(a.tokens_out), 0) from public.ai_calls a where (a.at at time zone 'Asia/Tokyo')::date = d)        as 출력_토큰,
       (select count(*) from public.ai_calls a where not a.ok and (a.at at time zone 'Asia/Tokyo')::date = d)                 as 실패
from days
order by d desc;

-- 사람별 (최근 30일)
create or replace view public.admin_people with (security_invoker = true) as
select p.nick                                                                                                  as 이름,
       p.role                                                                                                  as 역할,
       (select count(*) from public.usage_events u where u.user_id = p.id and u.at > now() - interval '30 days') as 버튼_사용,
       (select count(*) from public.ai_calls a where a.user_id = p.id and a.kind = 'claude' and a.at > now() - interval '30 days')       as claude_호출,
       (select count(*) from public.ai_calls a where a.user_id = p.id and a.kind like 'google%' and a.at > now() - interval '30 days')   as 구글_호출,
       (select to_char(max(u.at) at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') from public.usage_events u where u.user_id = p.id)          as 마지막_사용
from public.profiles p
order by 3 desc;

-- 한 번도 안 쓴 기능 찾기용: 최근 30일 사용 횟수가 적은 순
create or replace view public.admin_feature_rare with (security_invoker = true) as
select * from public.admin_feature_usage order by 사용_횟수 asc;

revoke all on public.admin_feature_usage, public.admin_daily, public.admin_people, public.admin_feature_rare from anon;
grant select on public.admin_feature_usage, public.admin_daily, public.admin_people, public.admin_feature_rare to authenticated;
