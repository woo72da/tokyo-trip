# 함께 보는 여행 일지 · 사람별 하트 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (native, this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 여행 일지를 모두에게 같게(사람별 평가 줄), 하트를 사람별로(누른 사람 표시) 만든다.
**Architecture:** 하트를 개인 키 `save:<장소>:<uid>`로 바꾸고 `PERSONAL_RE`·SQL `personal_owner`에 더한다. 일지는 `visitsOf`로 모든 사람 평가를 모은다.
**Tech Stack:** vanilla JS (app.js), styles.css, Supabase SQL (사용자가 실행).
**Spec:** `docs/superpowers/specs/2026-11-19-shared-likes-journal-design.md`

## Global Constraints
- 배포: `tools/deploy.sh -y`, `APP_VERSION` 306과 sw.js `'trip-v306'`을 함께 올리고 DESIGN.md에 행을 추가한다.
- 확인: `node --check app.js`(테스트 도구 없음, 실제 확인은 폰).
- 문구는 해요체로 쓴다.
- 순서: v306 배포 → 두 폰 업데이트 → SQL 0005 실행. v306은 SQL 전에도 동작해야 한다. SQL 전에는 개인 하트 키가 can_edit으로 들어가므로, 보기만 하트는 거절되고 폰에 남는다.

## Review Focus
1. 로그인 안 한 폰의 예전 `save:<id>` 하트가 사라지지 않는지.
2. 옛 v305 폰이 공용 `save:<id>`를 다시 쓰면, v306이 그것을 쓴 사람 키로 옮기고 다시 올리지 않는지.
3. 남의 `save:<id>:<uid>`를 서버로 보내지 않는지(`canPush`).
4. 일지에서 한 장소가 두 번 나오지 않는지(처음 다녀간 날에 한 번).
5. 보기만이 하트를 누를 때 `planGate`에 막히지 않는지.

---

### Task 1: 사람별 하트
**Files:** Modify `app.js` (`isSaved` 근처, `toggleSave`, `placeCard`, 장소 상세 버튼, `PERSONAL_RE`, `legacyTarget`, `claimMine`, `PLAN_ACTS.placeSave`, `logWhat`)
**Produces:** `sKey(id, who=meId())`, `likersOf(id) -> uid[]`, `myLike(id) -> bool`, `isSaved(id)` = 누구라도
- [ ] `likersOf`는 `save:<id>:*`가 true인 uid를 멤버 순서로 모으고, 예전 `save:<id>`가 true면 나(`meId()`)로 센다.
- [ ] `toggleSave`는 내 키만 뒤집고, 예전 키는 null로 지운다.
- [ ] 하트 버튼은 `myLike` 기준이다. 누른 사람 이름은 카드 `small` 줄에 `♥ 이름 · 이름`으로 보여 준다.
- [ ] `PERSONAL_RE`에 `save:[^:]+`를 더한다. `legacyTarget`은 `save:<id>`이고 v===true일 때 주인 키를 정하고, false면 지운다.
- [ ] `claimMine`의 정규식에 save를 더한다. `PLAN_ACTS`에서 placeSave를 뺀다(보기만 허용). `logWhat`은 하트 / 하트 취소로 쓴다.
- [ ] `node --check app.js`

### Task 2: 함께 보는 여행 일지
**Files:** Modify `app.js` `exploreLog`, `styles.css`
- [ ] 다녀온 곳 = `visitsOf(p.id).length > 0`. 날짜는 가장 이른 `v.at`. 장소 아래에 사람별 줄(색 점, 이름, 평가, 메모)을 멤버 순서로 둔다.
- [ ] '가고 싶은 곳' = 누구라도 하트 && 아무도 안 다녀온 곳.
- [ ] `node --check app.js`

### Task 3: SQL 0005 + 배포
**Files:** Create `supabase/migrations/0005_personal_likes.sql`
- [ ] `personal_owner` 정규식에 `save:[^:]+`를 더한다. 옛 `save:<id>`가 true면 `save:<id>:<updated_by 멤버 → 여행 주인>`으로 옮기고 옛 줄은 null로 둔다. 다시 실행해도 안전해야 한다.
- [ ] 독립 검토 → v306 배포 → 두 주소 확인
