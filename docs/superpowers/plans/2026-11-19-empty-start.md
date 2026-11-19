# 여행 없는 처음 상태 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (native, this session).

**Goal:** 여행이 없으면 도쿄 일정 대신 빈 처음 화면을 보여 준다.
**Architecture:** `state.noTrip` + `emptyPlan()`. `render()`가 탭별 `noTripView`로 갈라진다. 시작(`init`)과 여행 떼어 내기(`tripDrop`), 시작 연결(`cloudStartRun`)에서 처음 상태로 들어간다.
**Spec:** `docs/superpowers/specs/2026-11-19-empty-start-design.md`

## Global Constraints
- 배포: `tools/deploy.sh -y`, `APP_VERSION` 310과 `'trip-v310'`을 함께 올리고 DESIGN.md에 행을 추가한다. `node --check app.js`로 확인한다.

## Review Focus
1. 도쿄에 연결된 마스터 폰은 앱을 열 때 계속 도쿄 일정으로 열려야 한다(오프라인 포함).
2. 처음 상태에서 오늘 탭의 타이머(1분마다 render)나 날씨 로딩이 `days[...]` 때문에 죽지 않아야 한다.
3. 처음 상태에서 도쿄 여행 초대로 들어오면 도쿄 일정이 떠야 한다.
4. 처음 상태에서 마스터가 도쿄 plan을 빈 일정으로 서버에 덮어쓰지 않아야 한다(`tripPlanSync`, `cloudCreate`).
5. 로그인 전 폰에서도 [새 여행 만들기]가 막다른 길이 되지 않아야 한다.

### Task 1: 처음 상태 만들기
**Files:** `app.js` (`emptyPlan`, `emptyPlanShow`, `tripPlanShow`, `init`, `introLine`, `render`, `noTripView`, `tripDrop`, `cloudStartRun`, `tripPlanSync`, `cloudCard`, 클릭 처리), `styles.css`
- [ ] `emptyPlan()`과 `emptyPlanShow()`는 noTrip을 켜고, `tripPlanShow`는 noTrip을 끈다.
- [ ] `init` 분기는 설계 문서대로 한다. `tripDrop`에서 남은 여행이 없을 때와 `cloudStartRun`에서 `!trip && cloudTrip`일 때 `tripResetEmpty()`를 부른다.
- [ ] `tripPlanSync`에서 도쿄 파일은 `state.planOf || state.noTrip`일 때 읽는다. `cloudCard`의 hasLocal은 noTrip이 아닐 때만 켠다.
- [ ] `noTripView(tab)`과 `[data-empty-new]`를 만든다.
- [ ] `node --check` → 검토 → 배포
