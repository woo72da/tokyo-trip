# 역할·개인 기록·변경 기록 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (native, this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 보기만/함께 편집(맡은 날)/마스터 역할, 사람별 리뷰·경비, 변경 기록을 서버 규칙까지 포함해 만든다.
**Architecture:** 폰 안의 경비 목록(`exp`)은 지금처럼 하나로 두고, 서버와 주고받을 때만 사람별 줄(`exp:<uid>`)로 나누고 합친다. 리뷰·아침 준비는 폰 안에서도 사람별 키. 서버 규칙(RLS)은 "개인 키는 본인만, 일정 키는 편집자 이상". 변경 기록은 DB 트리거.
**Tech Stack:** vanilla JS (app.js), Supabase Postgres RLS, SQL Editor로 사용자가 실행.
**Spec:** `docs/superpowers/specs/2026-11-19-roles-history-design.md`

## Global Constraints
- 배포: `tools/deploy.sh -y`, app.js `APP_VERSION`과 sw.js `'trip-vNN'` 함께 올림, DESIGN.md 행 추가.
- 확인: `node --check app.js`. 테스트 도구 없음 → 실제 확인은 사용자 폰.
- 경비 항목의 `by`는 절대 바꾸지 않는다. 정산(by별 합계)이 전후 같아야 한다.
- 문구 해요체, 오류 원문을 화면에 내보내지 않는다.
- 단계 순서: v303(앱 A) → 두 폰 업데이트 → SQL 0004 → v304(앱 B).

## Review Focus
1. 옛 v302 폰이 `exp`(옛 줄)를 다시 써도 v303이 id로 중복 없이 합치는지.
2. 내 폰이 남의 개인 키를 서버로 보내지 않는지(SQL 뒤 거절 → 동기화 멈춤 방지).
3. 남의 리뷰를 옮길 때 그 키를 '보낸 것'으로 표시해서 다시 올리지 않는지.
4. 오프라인에서 만든 경비가 `exp:<내 uid>`로 나중에 올라가는지.
5. 보기만이 화면에서 누를 수 있는 버튼이 서버에서 거절되지 않는지(v304).

---

### Task 1 (v303): 경비를 사람별 줄로 주고받기
**Files:** Modify `app.js` (cloudSync 보내기, cloudMerge, 경비 추가·삭제·수정, claimMine)
- 소유 줄 정하기 `expOwner(e) -> uid`: `e.own` → `e.by`가 멤버 uid면 그것 → 여행 주인 uid.
- 받기: `exp:<x>` 줄은 각 항목에 `own = x`를 붙여 로컬 `exp`에 id로 합침. 옛 `exp` 줄도 같은 합치기(own은 expOwner).
- 보내기: 로컬 `exp`가 바뀌었으면 `exp:<내 uid>` 한 줄만 보냄(expOwner가 나인 항목). `exp` 자체는 보내지 않음.
- 새 경비는 `own = 내 uid`. 남의 경비(own ≠ 나)는 수정·삭제 버튼을 숨김.
- [ ] 구현 → `node --check app.js`

### Task 2 (v303): 리뷰·아침 준비를 사람별 키로
- 로컬 키: `visit:<장소id>:<uid>`, `prep:<날짜>:<uid>`. `visitOf(id)` = 내 것, `visitsOf(id)` = 모든 사람 것(`[{uid, v}]`).
- 받기: 옛 `visit:<id>` / `prep:<날짜>`는 주인(visit: `updated_by` → `v.by` 멤버 → 여행 주인; prep: 여행 주인) 키로 옮겨 저장하고 '보낸 것'으로 표시(다시 올리지 않음). 받기 select에 `updated_by` 추가.
- 장소 상세에 다른 사람 리뷰도 보여 줌(닉네임 + 평가 + 메모). 집계 화면은 일단 내 것 기준.
- [ ] 구현 → `node --check`

### Task 3 (v303): 지운 표시 사람별 + 보내기 필터 + 새 영수증 이름
- 보내기: `tomb`을 `tomb:<내 uid>`로. 받기: `tomb`·`tomb:*` 모두 합침.
- 보내기 필터 `canPush(key)`: 개인 키(`exp:`·`visit:`·`gear:`·`prep:`·`tomb:` + 끝이 uid)는 내 uid일 때만.
- 새 영수증 사진 키: `rcpt-<경비id>#<내 uid>.<랜덤>`(서버 규칙이 이름의 uid로 판단).
- [ ] 구현 → `node --check` → v303 배포 → 두 폰 업데이트 확인(사용자)

### Task 4: SQL `supabase/migrations/0004_roles_history.sql`
- 함수 `is_personal_key(key)`, `is_own_key(key)`(정해진 앞부분 + 끝이 auth.uid()).
- `trip_kv` insert/update/delete 정책 교체: `(can_edit(trip_id) and not (is_personal_key(key) and not is_own_key(key))) or (is_member(trip_id) and is_own_key(key))`.
- storage `docs` 쓰기·지우기 정책에 "멤버 + 이름에 'rcpt-' + 내 uid" 허용 추가.
- `trip_members.days date[]`, `trip_invites.role` 기본 'viewer'.
- `trip_log` 표 + 트리거(`trip_kv`·`trip_secrets`; secrets는 값 없이; `route:`·`tomb` 제외), 읽기 = 멤버, 여행당 2000건 넘으면 오래된 것 정리.
- 옮기기(다시 실행해도 안전): 옛 `exp` → `exp:<own>` 줄과 id 합치기, 옛 `visit:<id>` → `visit:<id>:<주인>`, 옛 `prep:<날짜>` → 주인, 옛 `tomb` → `tomb:<여행 주인>`; 옛 줄은 값 null. 마지막에 by별 경비 합계 전후 표를 보여 줌.
- [ ] 작성 → 사용자에게 전달·실행 확인

### Task 5 (v304): 권한 가드 + 역할·날짜 관리 + 변경 기록 화면
- `canWrite(key)` 한 곳: 개인 키=내 것, 일정 키=owner/editor(+editor면 맡은 날: `edit:/done:/start:`는 일정id→날짜, `seal:`은 날짜, `myitems`는 항목 date, 날짜 없는 키는 owner·모든 날 편집자).
- `store.set`에서 막고 알림, 수정 버튼 그리기에서 숨김. 보내기 거절 시 한 줄씩 재시도, 거절 키는 서버 값으로 되돌림.
- 관리 화면(권한·맡은 날짜), 초대 카드 권한 문구, 날짜 머리에 맡은 사람, 변경 기록 화면(+마스터 되돌리기: 값 하나짜리 키만, 지금 시각으로).
- 도쿄 `trips.plan` 올리기는 마스터만.
- [ ] 구현 → `node --check` → v304 배포 → 폰 확인
