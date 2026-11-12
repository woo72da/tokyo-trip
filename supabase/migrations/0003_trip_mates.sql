-- 여행메이트 (2026-11-12): 여행마다 공통 초대 링크 하나, 여러 명이 써요 · 로그인 전 초대 미리보기
-- Supabase → SQL Editor → New query → 전부 붙여 넣고 Run. 'Success. No rows returned' 이면 끝이에요.
-- 여러 번 실행해도 괜찮아요.

-- 1) 초대 링크: 한 번 쓰면 끝 → 여러 명이 쓰고, 여행 마스터가 끌 수 있게
alter table public.trip_invites add column if not exists uses int not null default 0;
alter table public.trip_invites add column if not exists revoked_at timestamptz;

-- 2) 참여: 꺼지지 않고 기간 안이면 누구나 · 이미 동반자면 그 여행만 돌려줘요
create or replace function public.join_trip(invite text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.trip_invites; added int;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select * into inv from public.trip_invites
   where code = invite and revoked_at is null and expires_at > now()
   for update;
  if not found then raise exception '초대 링크가 끝났어요'; end if;
  insert into public.trip_members (trip_id, user_id, role)
  values (inv.trip_id, auth.uid(), inv.role)
  on conflict (trip_id, user_id) do nothing;
  get diagnostics added = row_count;
  if added > 0 then
    update public.trip_invites set uses = uses + 1, used_by = auth.uid(), used_at = now() where code = invite;
  end if;
  return inv.trip_id;
end $$;

-- 3) 로그인 전 초대 카드: 여행 이름·날짜·초대한 사람·인원만 (일정·예약 내용은 없음)
create or replace function public.invite_preview(invite text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'title',   t.title,
    'start',   t.start_date,
    'end',     t.end_date,
    'owner',   coalesce(p.nick, '여행자'),
    'members', (select count(*) from public.trip_members m where m.trip_id = t.id),
    'live',    (i.revoked_at is null and i.expires_at > now()),
    'until',   i.expires_at,
    'mine',    exists (select 1 from public.trip_members m where m.trip_id = t.id and m.user_id = auth.uid()))
  from public.trip_invites i
  join public.trips t on t.id = i.trip_id
  left join public.profiles p on p.id = t.owner_id
  where i.code = invite
$$;
revoke all on function public.invite_preview(text) from public;
grant execute on function public.invite_preview(text) to anon, authenticated;

-- 4) 닉네임은 계정에 하나 (profiles.nick). 본인만 바꾸는 규칙은 이미 있어요 (profiles_update).
--    길이(1~12자)는 앱에서 맞춰요. 가입 때 카카오 이름이 길어도 가입이 막히지 않게 DB 제한은 두지 않아요.
