-- 0006 초대 미리보기에서 '내보낸 계정'을 바로 알려 줘요 (v315)
-- Supabase SQL Editor에서 통째로 한 번 실행해요. 다시 실행해도 안전해요. 0005 다음에 실행해요.
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
    'mine',    exists (select 1 from public.trip_members m where m.trip_id = t.id and m.user_id = auth.uid()),
    -- 내보낸 뒤에 만든 링크가 아니면 이 계정은 이 링크로 못 들어와요 (join_trip과 같은 규칙)
    'kicked',  exists (select 1 from public.trip_kicked k where k.trip_id = t.id and k.user_id = auth.uid() and k.at >= i.created_at))
  from public.trip_invites i
  join public.trips t on t.id = i.trip_id
  left join public.profiles p on p.id = t.owner_id
  where i.code = invite
$$;
revoke all on function public.invite_preview(text) from public;
grant execute on function public.invite_preview(text) to anon, authenticated;
