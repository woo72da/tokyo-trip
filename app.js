'use strict';

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TABS = ['today', 'days', 'explore', 'wallet', 'talk', 'check'];

const state = {
  trip: null, wx: null, fx: null, tab: 'today', dayIndex: 0, talkDir: 'ko-ja',
  pendingDoc: null, viewer: null, docSlots: new Set(), syncFile: null,
  ex: { cat: 'eat', area: '전체', open: false, plan: false, saved: false, again: false, near: false, q: '' }, geo: null,
};

// ---------- storage (localStorage can throw in private mode) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  // Shared records also get a "last changed" time so two phones can merge (newest wins).
  set(key, value, at = Date.now()) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      if (isShared(key)) {
        localStorage.setItem('meta', JSON.stringify({ ...this.get('meta', {}), [key]: at }));
        state.syncFile = null;
        cloudSoon();
      }
    } catch { /* ignore */ }
  },
};
// What the sync carries: bookings (numbers, links, vouchers, checks, expenses, budget) and the plan itself —
// time changes, skips and swaps (edit:), arrivals and done marks, added stops and places, visits, saved places,
// day stamps, records and diaries, nicknames and the morning prep check.
const isShared = (key) => /^(ck|done|visit|save|edit|seal|start|gear|diary|nick|prep|route):/.test(key) || ['custom', 'cdocs', 'myitems', 'myplaces', 'cashYen', 'pnr', 'agoda', 'esim1', 'esim2', 'exp', 'budget'].includes(key);
// Deleted list entries and photos are remembered so a sync doesn't bring them back.
// Ids stay unique across both phones even when two records are made in the same millisecond.
const uid = (prefix) => `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const forget = (id) => { store.set('tomb', { ...store.get('tomb', {}), [id]: Date.now() }); cloudSoon(); };
// Items marked `done` in trip.json (already booked) start checked.
// A checklist item linked to document photos counts as done once every photo is in.
const docsReady = (c) => !!c?.docs?.length && c.docs.every((slot) => state.docSlots.has(slot));
const isChecked = (id) => {
  const c = state.trip?.checklist.find((x) => x.id === id);
  return docsReady(c) || store.get('ck:' + id, !!c?.done);
};
const setChecked = (id, on) => store.set('ck:' + id, on);
const isDone = (id) => store.get('done:' + id, false);
const setDone = (id, on) => store.set('done:' + id, on);

// Booking numbers typed on this phone only (the repo is public, so they never go in trip.json).
const SECRETS = [
  { key: 'pnr', label: '항공 예약번호 (PNR)', placeholder: '예: AB12CD' },
  { key: 'agoda', label: '아고다 예약번호', placeholder: '숫자 9~10자리' },
  { key: 'esim1', label: 'eSIM 설치 링크 · 안드레아', placeholder: '카카오톡 링크 붙여넣기', link: true },
  { key: 'esim2', label: 'eSIM 설치 링크 · 다희', placeholder: '카카오톡 링크 붙여넣기', link: true },
];

const isTyped = (key) => SECRETS.some((s) => s.key === key);

// Photos of vouchers and QR codes live in IndexedDB on this phone (too big for localStorage).
const docs = {
  db: null,
  open() {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('trip-docs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('docs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const req = fn(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  get: (id) => docs.run('readonly', (s) => s.get(id)),
  put: (id, blob) => docs.run('readwrite', (s) => s.put(blob, id)).then((r) => { cloudSoon(); return r; }),
  del: (id) => { forget('doc:' + id); return docs.run('readwrite', (s) => s.delete(id)); },
  // 다른 여행으로 접어 둔 사진(stash|…)은 빼고
  keys: () => docs.run('readonly', (s) => s.getAllKeys()).then((ks) => ks.filter((k) => !String(k).startsWith('stash|'))),
  // Photo keys for one slot, oldest first.
  async of(slot) {
    const keys = await docs.keys();
    return keys.filter((k) => k === slot || k.startsWith(slot + '#')).sort((a, b) => (a === slot ? -1 : b === slot ? 1 : a.localeCompare(b)));
  },
};

// Downscale phone photos to ~1800px JPEG; keep the original if the browser can't decode it.
async function shrink(file) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob((b) => r(b || file), 'image/jpeg', 0.85));
  } catch { return file; }
}

// ---------- time ----------
// "Now" in Tokyo regardless of the phone's time zone. `?now=2026-11-05T15:30` overrides it for testing.
function tokyoNow() {
  const override = new URLSearchParams(location.search).get('now');
  if (override) {
    const [date, hm = '09:00'] = override.split('T');
    return { date, min: toMin(hm), dow: dowOf(date) };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, min: Number(parts.hour) * 60 + Number(parts.minute), dow: dowOf(date) };
}
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const dowOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const shortDate = (date) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
const dayLabel = (date) => `${shortDate(date)} (${WEEKDAYS[dowOf(date)]})`;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

// Every stop as planned on this phone: added stops included, with any change, move to another day,
// skip or delete laid over the trip file. The trip file itself never changes, so each edit can be undone.
function planItems() {
  const base = [...state.trip.days.flatMap((d) => d.items.map((it) => ({ ...it, date: d.date }))), ...store.get('myitems', [])];
  let list = base.map((it) => {
    const edit = store.get('edit:' + it.id, null);
    if (!edit) return it;
    const swapped = edit.swap && placeById(edit.swap);
    return swapped ? { ...it, ...swappedStop(it, swapped), ...edit } : { ...it, ...edit };
  });
  // A train added without line details takes them from its name.
  list = list.map((it) => {
    if (it.line || glyph(it.icon)[1] !== 'move') return it;
    const f = lineFromTitle(it.title);
    return f ? { ...it, line: [f.leg], place: it.place || { nameJa: `${f.ja}駅`, query: `${f.ja}駅` } } : it;
  });
  // A move renamed to '이동 → 시부야 스카이' goes there: directions follow the name, not the old place.
  // Renamed off its train ('도보 → 숙소'), the old line and its '약 35분' go too; '숙소'/'호텔' is the hotel.
  return autoLegs(list.map((it) => {
    const edit = store.get('edit:' + it.id, null);
    if (!edit?.title || glyph(it.icon)[1] !== 'move') return it;
    const name = stripEmoji(edit.title);
    let out = it;
    if (it.line && !it.line.some((l) => name.includes(l.name))) {
      out = { ...out, line: undefined, note: 'note' in edit ? edit.note : /^약 \d+분$/.test(it.note || '') ? '' : it.note };
    }
    const to = /→\s*(.+)$/.exec(name)?.[1].trim();
    if (!to) return out;
    const st = state.trip.stay;
    if (/숙소|호텔/.test(to) || to.startsWith(st.name)) return { ...out, place: { nameJa: st.nameJa, query: st.address || st.query }, placeId: undefined };
    const dest = list.find((x) => x !== it && x.date === it.date && x.place && stripEmoji(x.title).startsWith(to));
    return dest ? { ...out, place: dest.place, placeId: dest.placeId } : out;
  }));
}

// ---------- 일정 엔진 S1: 이동 구간(Leg)은 앞뒤 장소에서 계산되는 값 (travel-app-native/docs/09-schedule-engine.md) ----------
// A planned move row (🚇 히비야선 …, 약 35분) belongs to the two stops around it in the original plan. When either
// of those stops changes — another place, skipped, deleted, or the order around it shifts — the row's line, note
// and length no longer fit, so it is rebuilt from the stops actually around it now. For now the length is the
// straight-line estimate (S2 swaps in Google routes); booked or hand-edited moves are never touched.
const placeKey = (it, p) => (p ? 'p:' + p.id : it.place?.query ? 'q:' + it.place.query : 't:' + stripEmoji(it.title || ''));
// Only rows that are a ride or a walk are legs; check-in counters, baggage and stations are places you stop at.
const LEG_KINDS = ['bus', 'walk', 'train', 'metro', 'local', 'tram'];
const isLegRow = (it) => isMove(it) && LEG_KINDS.includes(glyph(it.icon)[0]);
const isStopRow = (it) => !isLegRow(it); // a flight row counts too: it is where you land
let rawLegsMemo = null;
// For each planned move: the stop before and after it in the plan as written (id and place).
function rawLegs() {
  if (rawLegsMemo?.trip === state.trip) return rawLegsMemo.map;
  const map = {};
  for (const d of state.trip.days) {
    const items = [...d.items].sort((a, b) => toMin(a.start) - toMin(b.start));
    items.forEach((m, i) => {
      if (!isLegRow(m)) return;
      const prev = items.slice(0, i).reverse().find(isStopRow);
      const next = items.slice(i + 1).find(isStopRow);
      const keyOf = (x) => x && placeKey(x, allPlaces().find((p) => p.itemId === x.id));
      map[m.id] = { prev: prev?.id || null, next: next?.id || null, prevKey: keyOf(prev), nextKey: keyOf(next), prevPt: rawPoint(prev), nextPt: rawPoint(next) };
    });
  }
  rawLegsMemo = { trip: state.trip, map };
  return map;
}
// The same point as the plan was written (no edits), to tell whether a stop really moved.
const rawPoint = (it) => {
  if (!it) return { lat: state.trip.stay.lat, lng: state.trip.stay.lng };
  const p = allPlaces().find((x) => x.itemId === it.id);
  if (p?.lat) return { lat: p.lat, lng: p.lng };
  return /호텔|숙소/.test(it.title) ? { lat: state.trip.stay.lat, lng: state.trip.stay.lng } : null;
};
// Two ends are the same place when within 500 m (1 km for a train ride) (breakfast at the hotel = the hotel); without coordinates, the same stop.
const samePlace = (pt, rawPt, key, rawKey, km = 0.5) => (pt?.lat && rawPt?.lat ? kmBetween(pt, rawPt) <= km : key === rawKey);
// Where a stop is, for distance: its place, the hotel for hotel rows, else unknown.
const legPoint = (it) => {
  if (!it) return { name: '호텔', lat: state.trip.stay.lat, lng: state.trip.stay.lng, query: state.trip.stay.address || state.trip.stay.query, hotel: true };
  const p = placeOfItem(it.id);
  if (p?.lat) return { name: p.name, lat: p.lat, lng: p.lng, query: p.verified?.name || p.name };
  if (/호텔|숙소/.test(it.title)) return { name: '호텔', lat: state.trip.stay.lat, lng: state.trip.stay.lng, query: state.trip.stay.address || state.trip.stay.query, hotel: true };
  return { name: shortName(it), query: it.place?.query || it.place?.nameJa || shortName(it) };
};
// Estimated leg between two points: walk if close (corners add a third, 75 m a minute), else transit (~3 min/km + 10).
function estimateLeg(a, b) {
  if (!a?.lat || !b?.lat) return { mode: 'unknown', min: null, km: null };
  const km = kmBetween(a, b);
  if (km < 0.15) return { mode: 'walk', min: 1, km };
  return km <= 1.2 ? { mode: 'walk', min: Math.max(1, Math.ceil((km * 1000 * 1.3) / 75)), km } : { mode: 'transit', min: Math.ceil(km * 3 + 10), km };
}
const LEG_ICON = { walk: '🚶', transit: '🚇', unknown: '🚶' };

// The day's way home ends at the hotel as a real stop ('호텔 복귀 · 휴식'), so it can be checked off, synced and
// counted like any other. Returns an undo, or null when nothing changed.
function putHotelStop(date, at) {
  const list = store.get('myitems', []);
  const old = list.find((x) => x.date === date && x.autoHotel);
  const stay = state.trip.stay;
  if (old) {
    if (old.start === at) return null;
    const prev = old.start;
    store.set('myitems', list.map((x) => (x === old ? { ...x, start: at } : x)));
    return () => store.set('myitems', store.get('myitems', []).map((x) => (x.id === old.id ? { ...x, start: prev } : x)));
  }
  const id = uid('my-it');
  store.set('myitems', [...list, { id, date, start: at, title: '호텔 복귀 · 휴식', icon: '🏨', autoHotel: true, place: { nameJa: stay.nameJa, query: stay.address || stay.query } }]);
  return () => { forget('myitems:' + id); store.set('myitems', store.get('myitems', []).filter((x) => x.id !== id)); };
}
// Where a leg that is the last thing of its day gets to the hotel: its arrival time, else null.
function hotelArrival(leg) {
  if (!leg || !isLegRow(leg)) return null;
  const items = dayItems(dayOf(leg.date)).filter((x) => !x.skip);
  const i = items.findIndex((x) => x.id === leg.id);
  if (i < 0 || items.slice(i + 1).some((x) => !isLegRow(x) && !x.autoHotel)) return null;
  const to = leg.leg?.to || (/→\s*(.+)$/.exec(stripEmoji(leg.title))?.[1] || '');
  if (!/호텔|숙소/.test(to)) return null;
  return clock(Math.min(1439, leg.startMin + (leg.leg?.min || leg.endMin - leg.startMin || 0)));
}

// '이동 다시 계산': the rides and walks between the stop before and the stop after this one become one leg from
// where we really are to where we go next, leaving right when the stop before ends. Skipped stops don't count.
function relegMove(id, { silent = false } = {}) {
  const it = findItem(id);
  if (!it) return null;
  const items = dayItems(dayOf(it.date)).filter((x) => !x.skip);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  let a = i; while (a > 0 && isLegRow(items[a - 1])) a -= 1;
  let b = i; while (b < items.length - 1 && isLegRow(items[b + 1])) b += 1;
  const chain = items.slice(a, b + 1).filter((x) => isLegRow(x) && !isFixed(x));
  const prev = items[a - 1];
  const undo = {};
  chain.forEach((m, k) => {
    undo[m.id] = store.get('edit:' + m.id, null);
    const old = { ...(undo[m.id] || {}) };
    if (k === 0 && prev) { old.start = clock(prev.endMin); old.auto = true; }
    store.set('edit:' + m.id, { ...old, releg: true });
  });
  // Ending at the hotel: the hotel goes in as a stop at the arrival time.
  const legNow = chain[0] && dayItems(dayOf(it.date)).find((x) => x.id === chain[0].id);
  const at = hotelArrival(legNow);
  const undoHotel = at ? putHotelStop(it.date, at) : null;
  if (undoHotel) undo.__hotel = undoHotel;
  if (!silent) {
    closeSheet();
    render();
    const leg = planItems().find((x) => x.id === chain[0]?.id);
    toast(`${leg ? `${leg.start} ${stripEmoji(leg.title)} · ${leg.note}` : '이동'}${chain.length > 1 ? ` · 겹친 이동 ${chain.length - 1}개 정리` : ''}${undoHotel ? ` · 호텔 복귀 ${at}` : ''}`, () => { for (const [k, v] of Object.entries(undo)) { if (k === '__hotel') v(); else store.set('edit:' + k, v); } render(); }, '되돌리기');
  }
  return undo;
}

// ---------- 일정 엔진 S2: 구글 경로(Routes API)로 이동 시간·노선 ----------
// Same Google key as places (설정 › AI 도우미 › 구글 장소 키), with Routes API turned on for it. One transit request
// per leg covers walking too (a short hop comes back as a walk). Results are kept per from/to/weekday/half-hour and
// shared with the other phone, so a leg is looked up once. A past date asks for the same weekday next week (timetables repeat).
const R_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const R_MASK = 'routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.transitDetails';
const routeOff = () => store.get('routeOff', '');
const routeKey = (a, b, date, min) => `route:${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}|${dowOf(date)}|${Math.floor(min / 30)}`;
function departIso(date, min) {
  let t = new Date(`${date}T${clock(min)}:00+09:00`).getTime();
  while (t < Date.now() + 5 * 60000) t += 7 * 86400000;
  return new Date(t).toISOString();
}
const secs = (d) => parseInt(String(d || '0'), 10) || 0;
const tokyoClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : '');
// Google's answer boiled down to what the leg shows: walks merged, each ride with line, stops, times and direction.
function routeOf(r) {
  if (!r) return null;
  const steps = [];
  for (const st of r.legs?.[0]?.steps || []) {
    const t = st.transitDetails;
    if (!t) {
      const last = steps[steps.length - 1];
      const min = secs(st.staticDuration) / 60;
      if (last?.mode === 'walk') { last.min += min; last.m += st.distanceMeters || 0; } else steps.push({ mode: 'walk', min, m: st.distanceMeters || 0 });
      continue;
    }
    const ln = t.transitLine || {};
    steps.push({
      mode: 'ride', min: secs(st.staticDuration) / 60,
      line: { name: ln.nameShort && ln.name ? ln.name : ln.name || ln.nameShort || '', short: ln.nameShort || '', color: ln.color || '', text: ln.textColor || '', type: ln.vehicle?.type || '' },
      from: t.stopDetails?.departureStop?.name || '', to: t.stopDetails?.arrivalStop?.name || '',
      dep: tokyoClock(t.stopDetails?.departureTime), arr: tokyoClock(t.stopDetails?.arrivalTime),
      head: t.headsign || '', stops: t.stopCount || 0, every: Math.round(secs(t.headway) / 60) || 0,
    });
  }
  steps.forEach((x) => { x.min = Math.max(1, Math.round(x.min)); });
  return { at: Date.now(), min: Math.max(1, Math.round(secs(r.duration) / 60)), m: r.distanceMeters || 0, steps };
}
const routeBusy = new Map();
// When Google answers (or fails), an open detail sheet for a leg is drawn again so it shows the result.
const refreshLegSheet = () => { const id = state.sheetItem; if (id && !$('#sheet').hidden && $('#sheet-body [data-route-retry], #sheet-body .lg-guide, #sheet-body [data-releg]')) openItem(id); };
async function fetchRoute(a, b, date, min, key) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15000);
  try {
    const res = await gCall(R_URL, {
      signal: stop.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': R_MASK },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
        destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
        travelMode: 'TRANSIT', departureTime: departIso(date, min), languageCode: 'ja', regionCode: 'JP',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = data.error?.message || '';
      store.set('routeErr', { at: Date.now(), status: res.status, msg: why.slice(0, 200) });
      if (res.status === 403 || (res.status === 400 && /API key/i.test(why))) store.set('routeOff', /not been used|disabled|SERVICE_DISABLED|blocked|not authorized/i.test(why) ? 'api' : 'key');
      render(); refreshLegSheet();
      return;
    }
    const route = routeOf(data.routes?.[0]);
    if (!route) store.set('routeErr', { at: Date.now(), status: 200, msg: '구글이 이 구간의 경로를 찾지 못했어요' });
    else store.set('routeErr', null);
    store.set(key, route || { at: Date.now(), none: true });
    routeBusy.delete(key);
    render(); refreshLegSheet();
  } catch (e) {
    store.set('routeErr', { at: Date.now(), status: 0, msg: e.name === 'AbortError' ? '15초 동안 응답이 없어요' : `연결 실패 · ${String(e.message || e).slice(0, 120)}` });
    render(); refreshLegSheet();
  } finally { clearTimeout(timer); }
}
// The cached Google route for a leg, or null (and a lookup is started when possible).
function googleLeg(a, b, date, min) {
  if (!gKey() || routeOff() || !a?.lat || !b?.lat) return null;
  const key = routeKey(a, b, date, min);
  const hit = store.get(key, null);
  if (hit && !(hit.none && Date.now() - hit.at > 30 * 60000)) return hit.none ? null : hit;
  const since = routeBusy.get(key);
  if (navigator.onLine && (!since || Date.now() - since > 5 * 60000)) { routeBusy.set(key, Date.now()); setTimeout(() => fetchRoute(a, b, date, min, key), 0); }
  return null;
}
const routeWhy = () => {
  if (!gKey()) return '설정 › AI 도우미에 구글 장소 키가 없어요';
  const e = store.get('routeErr', null);
  if (routeOff()) return `구글 키로 경로를 쓸 수 없어요${e ? ` (${e.status} · ${e.msg})` : ''} · Routes API를 켜고 키 제한에 추가해 주세요`;
  if (e && e.status === 200) return '구글 API는 일본 대중교통 경로를 주지 않아요';
  if (e) return `구글 경로 오류 (${e.status || '연결'} · ${e.msg})`;
  if (!navigator.onLine) return '인터넷이 연결되어 있지 않아요';
  return '구글 경로를 받는 중이에요 · 몇 초 뒤 이 화면이 저절로 바뀌어요';
};
// Retry: forget this leg's cached answer and the off switch, then look it up again.
function routeRetry(id) {
  store.set('routeOff', ''); store.set('routeErr', null);
  for (const k of Object.keys(localStorage)) if (k.startsWith('route:')) { try { const v = JSON.parse(localStorage.getItem(k)); if (v?.none) localStorage.removeItem(k); } catch { /* skip */ } }
  routeBusy.clear();
  render();
  if ($('#sheet') && !$('#sheet').hidden) openItem(id);
  toast('구글 경로를 다시 받아요');
}
// ---------- 앱 노선표 경로: 도보 → 가까운 역 → (갈아타기 1번까지) → 내릴 역 → 도보 ----------
// Rides about 2 min a station, 4 min to wait, 5 min to change lines; stations within 1.5 km on foot. An estimate,
// marked as such — but it names the line, stations and direction the way the planned moves do.
const walkMin = (km) => Math.max(1, Math.ceil((km * 1300) / 75));
const tableMemo = new Map();
function rideOf(L, ia, ib) {
  const n = L.st.length;
  const fwd = L.loop ? (ib - ia + n) % n <= n / 2 : ib > ia;
  const stops = L.loop ? Math.min((ib - ia + n) % n, (ia - ib + n) % n) : Math.abs(ib - ia);
  return { mode: 'ride', min: Math.max(2, stops * 2), line: { name: L.name, short: L.code, color: L.color, text: lnInk(L.color) }, from: L.st[ia].ja, to: L.st[ib].ja, dep: '', arr: '', head: dirOf(L, ia, fwd), stops, every: 0 };
}
// Each line's stations by Japanese name, built once: the one-change search runs across 19 lines.
const JA_IDX = new Map();
const jaIndex = (L) => { if (!JA_IDX.has(L)) JA_IDX.set(L, new Map(L.st.map((x, i) => [x.ja, i]))); return JA_IDX.get(L); };
function tableRoute(a, b) {
  if (!a?.lat || !b?.lat) return null;
  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  if (tableMemo.has(key)) return tableMemo.get(key);
  const near = (p) => LINES.flatMap((L) => L.st.map((st, i) => ({ L, i, km: kmBetween(p, st) }))).filter((x) => x.km <= 1.5);
  const from = near(a);
  const to = near(b);
  let best = null;
  const consider = (steps) => { const min = steps.reduce((t, x) => t + x.min, 0) + steps.filter((x) => x.mode === 'ride').length * 4 + (steps.filter((x) => x.mode === 'ride').length > 1 ? 5 : 0); if (!best || min < best.min) best = { min, steps }; };
  for (const o of from) for (const d of to) {
    if (o.L === d.L && o.i !== d.i) consider([{ mode: 'walk', min: walkMin(o.km), m: o.km * 1300 }, rideOf(o.L, o.i, d.i), { mode: 'walk', min: walkMin(d.km), m: d.km * 1300 }]);
    if (o.L === d.L) continue;
    // One change where the two lines share a station (same Japanese name).
    o.L.st.forEach((x, xi) => {
      const yi = jaIndex(d.L).get(x.ja) ?? -1;
      if (yi < 0 || xi === o.i || yi === d.i) return;
      consider([{ mode: 'walk', min: walkMin(o.km), m: o.km * 1300 }, rideOf(o.L, o.i, xi), rideOf(d.L, yi, d.i), { mode: 'walk', min: walkMin(d.km), m: d.km * 1300 }]);
    });
  }
  const direct = kmBetween(a, b);
  // Walking is fine when it's quick or no faster than the train.
  if (direct <= 2 && (!best || walkMin(direct) <= Math.max(15, best.min))) best = { min: walkMin(direct), steps: [{ mode: 'walk', min: walkMin(direct), m: direct * 1300 }] };
  // No line of ours near both ends and too far to walk: not ours to plan (the plain estimate stays).
  if (!best) { tableMemo.set(key, null); return null; }
  const out = { min: best.min, m: Math.round(direct * 1000), steps: best.steps, table: true };
  tableMemo.set(key, out);
  return out;
}
// Tokyo names Google gives in Japanese → the trip's own line table (Korean names, station numbers) when it knows them.
const LINE_ST = () => LINES.flatMap((l) => l.st.map((st) => ({ l, st })));
const stationOf = (ja, line) => {
  const n = String(ja || '').replace(/駅$/, '');
  const all = LINE_ST().filter((x) => x.st.ja === n);
  return all.find((x) => x.l === line) || all[0] || null;
};
const LINE_JA = { JY: ['山手線'], H: ['日比谷線'], G: ['銀座線'], TY: ['東横線'], U: ['ゆりかもめ'], Y: ['有楽町線'], M: ["丸ノ内線"], Z: ["半蔵門線"], C: ["千代田線"], T: ["東西線"], N: ["南北線"], F: ["副都心線"], A: ["浅草線"], I: ["三田線"], S: ["新宿線"], E: ["大江戸線"], JC: ["中央線快速", "中央線"], JB: ["中央・総武", "総武線"], JK: ["京浜東北"] };
const lineOf = (g) => LINES.find((l) => (g.short && g.short === l.code)
  || (g.name && (LINE_JA[l.code] || []).some((k) => g.name.includes(k)))
  || (g.name && [l.name, ...l.alias].some((a) => g.name.includes(a)))) || null;
const koHead = (head) => LINE_ST().reduce((t, x) => (x.st.ja.length > 1 ? t.split(x.st.ja).join(x.st.name) : t), String(head || '')).replace(/方面/g, ' 방면').replace(/行き?$/, ' 행');
function autoLegs(list) {
  const raw = rawLegs();
  const byDate = {};
  for (const it of list) (byDate[it.date] ||= []).push(it);
  const out = new Map();
  for (const day of Object.values(byDate)) {
    const items = day.filter((x) => !x.del).sort((a, b) => toMin(a.start) - toMin(b.start));
    items.forEach((m, i) => {
      const r = raw[m.id];
      const edit = store.get('edit:' + m.id, null);
      // '이동 다시 계산' (or the AI's releg) asks for it even on a move written by hand or added later.
      const re = !!edit?.releg;
      if (!isLegRow(m) || isFixed(m) || m.skip || m.booking || glyph(m.icon)[0] === 'plane') return;
      if (!re && (!r || edit?.title || edit?.manualLeg)) return; // the traveler wrote this move by hand
      const prev = items.slice(0, i).reverse().find((x) => isStopRow(x) && !x.skip);
      const next = items.slice(i + 1).find((x) => isStopRow(x) && !x.skip);
      const key = (x) => x && placeKey(x, placeOfItem(x.id));
      const a = legPoint(prev);
      const b = legPoint(next);
      // A train ride still works when the new stop is near the old one (same station area, about 1 km); a walk less so.
      const near = m.line ? 1 : 0.5;
      if (!re && samePlace(a, r.prevPt, key(prev), r.prevKey, near) && samePlace(b, r.nextPt, key(next), r.nextKey, near)) return;
      // Nowhere to go (hotel → hotel once the hotel became a stop): the row is spent, so it goes.
      if (a?.lat && b?.lat && kmBetween(a, b) < 0.2) { out.set(m, { ...m, del: true, legMerged: true }); return; }
      const start = toMin(m.start);
      const g = googleLeg(a, b, m.date, start) || tableRoute(a, b);
      const rides = g?.steps.filter((x) => x.mode === 'ride') || [];
      const leg = g ? { mode: rides.length ? 'transit' : 'walk', min: g.min, km: g.m / 1000 } : estimateLeg(a, b);
      const lineKo = rides.length ? (lineOf(rides[0].line)?.name || rides[0].line.name || rides[0].line.short) : '';
      const label = leg.mode === 'walk' ? '도보' : lineKo || (leg.mode === 'transit' ? '대중교통' : '이동');
      // Rides on lines the trip's table knows become the same line legs as planned moves (station boxes, line card).
      const lineLegs = rides.map((x) => {
        const L = lineOf(x.line);
        const s0 = L && stationOf(x.from, L);
        const s1 = L && stationOf(x.to, L);
        if (!s0 || !s1 || s0.l !== L || s1.l !== L) return null;
        const ia = L.st.indexOf(s0.st); const ib = L.st.indexOf(s1.st);
        const fwd = L.loop ? (ib - ia + L.st.length) % L.st.length <= L.st.length / 2 : ib > ia;
        return { code: L.code, name: L.name, color: L.color, from: { no: s0.st.no, name: s0.st.name }, to: { no: s1.st.no, name: s1.st.name }, dir: x.head ? koHead(x.head) : dirOf(L, ia, fwd) };
      });
      const known = rides.length && lineLegs.every(Boolean) ? lineLegs : null;
      const room = next ? toMin(next.start) - start : null;
      out.set(m, {
        ...m,
        title: known ? `${known[0].name} ${known[0].from.name} → ${known[known.length - 1].to.name}` : `${label} → ${b.name}`,
        icon: known ? (glyph(m.icon)[0] === 'train' || glyph(m.icon)[0] === 'local' ? m.icon : '🚇') : LEG_ICON[leg.mode], line: known || undefined, docs: undefined, info: undefined,
        note: leg.min ? `약 ${leg.min}분` : '시간 확인 필요',
        place: { nameJa: b.query, query: b.query }, placeId: undefined,
        ...(m.end && leg.min ? { end: clock(Math.min(1439, start + leg.min)) } : {}),
        leg: { auto: true, mode: leg.mode, min: leg.min, km: leg.km, from: a.name, to: b.name, source: g ? (g.table ? 'table' : 'google') : 'estimate', at: g?.at, steps: g?.steps, short: leg.min && room != null && leg.min > room ? leg.min - room : 0 },
      });
    });
  }
  // Skipping the stop between two rides leaves both pointing at the same next stop: keep the first, drop the rest.
  const done = list.map((it) => out.get(it) || it);
  const byDay = {};
  for (const it of done) if (!it.del) (byDay[it.date] ||= []).push(it);
  const drop = new Set();
  for (const day of Object.values(byDay)) {
    const items = day.sort((a, b) => toMin(a.start) - toMin(b.start));
    let last = null;
    for (const it of items) {
      if (it.skip) continue;
      if (!isLegRow(it)) { last = null; continue; }
      if (last?.leg && it.leg && last.leg.to === it.leg.to) drop.add(it);
      else last = it;
    }
  }
  return out.size ? done.map((it) => (drop.has(it) ? { ...it, del: true, legMerged: true } : it)) : list;
}
// Lines the trip rides, station by station (official numbers and colours), so a move added later by hand
// or by AI — '히비야선 에비스 → 우에노' — gets the same station boxes and line card as the planned ones.
const LINES = [
  { code: 'H', name: '히비야선', alias: ['히비야'], color: '#B5B5AC', up: '기타센주 방면', down: '나카메구로 방면',
    st: '나카메구로 中目黒|에비스 恵比寿|히로오 広尾|롯폰기 六本木|가미야초 神谷町|도라노몬힐스 虎ノ門ヒルズ|가스미가세키 霞ケ関|히비야 日比谷|긴자 銀座|히가시긴자 東銀座|쓰키지 築地|핫초보리 八丁堀|가야바초 茅場町|닌교초 人形町|고덴마초 小伝馬町|아키하바라 秋葉原|나카오카치마치 仲御徒町|우에노 上野|이리야 入谷|미노와 三ノ輪|미나미센주 南千住|기타센주 北千住' },
  { code: 'G', name: '긴자선', alias: ['긴자선'], color: '#F39700', up: '아사쿠사 방면', down: '시부야 방면',
    st: '시부야 渋谷|오모테산도 表参道|가이엔마에 外苑前|아오야마잇초메 青山一丁目|아카사카미쓰케 赤坂見附|다메이케산노 溜池山王|도라노몬 虎ノ門|신바시 新橋|긴자 銀座|교바시 京橋|니혼바시 日本橋|미쓰코시마에 三越前|간다 神田|스에히로초 末広町|우에노히로코지 上野広小路|우에노 上野|이나리초 稲荷町|다와라마치 田原町|아사쿠사 浅草' },
  { code: 'JY', name: 'JR 야마노테선', alias: ['야마노테'], color: '#80C241', up: '우에노·이케부쿠로 방면 (내선순환)', down: '시나가와·시부야 방면 (외선순환)', loop: true,
    st: '도쿄 東京|간다 神田|아키하바라 秋葉原|오카치마치 御徒町|우에노 上野|우구이스다니 鶯谷|닛포리 日暮里|니시닛포리 西日暮里|다바타 田端|고마고메 駒込|스가모 巣鴨|오쓰카 大塚|이케부쿠로 池袋|메지로 目白|다카다노바바 高田馬場|신오쿠보 新大久保|신주쿠 新宿|요요기 代々木|하라주쿠 原宿|시부야 渋谷|에비스 恵比寿|메구로 目黒|고탄다 五反田|오사키 大崎|시나가와 品川|다카나와게이트웨이 高輪ゲートウェイ|다마치 田町|하마마쓰초 浜松町|신바시 新橋|유라쿠초 有楽町' },
  { code: 'TY', name: '도큐 도요코선', alias: ['도요코'], color: '#DA0442', up: '요코하마 방면', down: '시부야 방면',
    st: '시부야 渋谷|다이칸야마 代官山|나카메구로 中目黒|유텐지 祐天寺|가쿠게이다이가쿠 学芸大学|도리쓰다이가쿠 都立大学|지유가오카 自由が丘' },
  { code: 'U', name: '유리카모메', alias: ['유리카모메'], color: '#1E50A2', up: '도요스 방면', down: '신바시 방면',
    st: '신바시 新橋|시오도메 汐留|다케시바 竹芝|히노데 日の出|시바우라후토 芝浦ふ頭|오다이바카이힌코엔 お台場海浜公園|다이바 台場|도쿄국제크루즈터미널 東京国際クルーズターミナル|텔레콤센터 テレコムセンター|아오미 青海|도쿄빅사이트 東京ビッグサイト|아리아케 有明|아리아케테니스노모리 有明テニスの森|시조마에 市場前|신도요스 新豊洲|도요스 豊洲' },
  { code: 'Y', name: '유라쿠초선', alias: ['유라쿠초선'], color: '#C1A470', up: '신키바 방면', down: '와코시 방면',
    st: '와코시 和光市|지하철나리마스 地下鉄成増|지하철아카쓰카 地下鉄赤塚|헤이와다이 平和台|히카와다이 氷川台|고타케무카이하라 小竹向原|센카와 千川|가나메초 要町|이케부쿠로 池袋|히가시이케부쿠로 東池袋|고코쿠지 護国寺|에도가와바시 江戸川橋|이이다바시 飯田橋|이치가야 市ケ谷|고지마치 麹町|나가타초 永田町|사쿠라다몬 桜田門|유라쿠초 有楽町|긴자잇초메 銀座一丁目|신토미초 新富町|쓰키시마 月島|도요스 豊洲|다쓰미 辰巳|신키바 新木場' },
  // v283: 도쿄메트로·도에이 나머지 노선과 JR 주오·소부·게이힌도호쿠 (역 순서·좌표·한국어 이름: Mini Tokyo 3D 공개 데이터, 역 번호 순)
  { code: 'M', name: '마루노우치선', alias: ["마루노우치"], color: '#F62E36', up: '이케부쿠로 방면', down: '오기쿠보 방면',
    st: '오기쿠보 荻窪|미나미아사가야 南阿佐ケ谷|신코엔지 新高円寺|히가시코엔지 東高円寺|신나카노 新中野|나카노사카우에 中野坂上|니시신주쿠 西新宿|신주쿠 新宿|신주쿠산초메 新宿三丁目|신주쿠교엔마에 新宿御苑前|요쓰야산초메 四谷三丁目|요쓰야 四ツ谷|아카사카미쓰케 赤坂見附|곳카이기지도마에 国会議事堂前|가스미가세키 霞ケ関|긴자 銀座|도쿄 東京|오테마치 大手町|아와지초 淡路町|오차노미즈 御茶ノ水|혼고산초메 本郷三丁目|고라쿠엔 後楽園|묘가다니 茗荷谷|신오쓰카 新大塚|이케부쿠로 池袋' },
  { code: 'Z', name: '한조몬선', alias: ["한조몬"], color: '#8F76D6', up: '오시아게 방면', down: '시부야 방면',
    st: '시부야 渋谷|오모테산도 表参道|아오야마잇초메 青山一丁目|나가타초 永田町|한조몬 半蔵門|구단시타 九段下|진보초 神保町|오테마치 大手町|미쓰코시마에 三越前|스이텐구마에 水天宮前|기요스미시라카와 清澄白河|스미요시 住吉|긴시초 錦糸町|오시아게 押上' },
  { code: 'C', name: '치요다선', alias: ["치요다"], color: '#00BB85', up: '기타아야세 방면', down: '요요기우에하라 방면',
    st: '요요기우에하라 代々木上原|요요기코엔 代々木公園|메이지진구마에 明治神宮前|오모테산도 表参道|노기자카 乃木坂|아카사카 赤坂|곳카이기지도마에 国会議事堂前|가스미가세키 霞ケ関|히비야 日比谷|니주바시마에 二重橋前|오테마치 大手町|신오차노미즈 新御茶ノ水|유시마 湯島|네즈 根津|센다기 千駄木|니시닛포리 西日暮里|마치야 町屋|기타센주 北千住|아야세 綾瀬|기타아야세 北綾瀬' },
  { code: 'T', name: '도자이선', alias: ["도자이"], color: '#009BBF', up: '니시후나바시 방면', down: '나카노 방면',
    st: '나카노 中野|오치아이 落合|다카다노바바 高田馬場|와세다 早稲田|가구라자카 神楽坂|이다바시 飯田橋|구단시타 九段下|다케바시 竹橋|오테마치 大手町|니혼바시 日本橋|가야바초 茅場町|몬젠나카초 門前仲町|기바 木場|도요초 東陽町|미나미스나마치 南砂町|니시카사이 西葛西|가사이 葛西|우라야스 浦安|미나미교토쿠 南行徳|교토쿠 行徳|묘덴 妙典|바라키나카야마 原木中山|니시후나바시 西船橋' },
  { code: 'N', name: '난보쿠선', alias: ["난보쿠"], color: '#00AC9B', up: '아카바네이와부치 방면', down: '메구로 방면',
    st: '메구로 目黒|시로카네다이 白金台|시로카네타카나와 白金高輪|아자부주반 麻布十番|롯폰기잇초메 六本木一丁目|다메이케산노 溜池山王|나가타초 永田町|요쓰야 四ツ谷|이치가야 市ケ谷|이다바시 飯田橋|고라쿠엔 後楽園|도다이마에 東大前|혼고마고메 本駒込|고마고메 駒込|니시가하라 西ケ原|오지 王子|오지카미야 王子神谷|시모 志茂|아카바네이와부치 赤羽岩淵' },
  { code: 'F', name: '후쿠토신선', alias: ["후쿠토신"], color: '#9C5E31', up: '시부야 방면', down: '와코시 방면',
    st: '와코시 和光市|지카테쓰나리마스 地下鉄成増|지카테쓰아카쓰카 地下鉄赤塚|헤이와다이 平和台|히카와다이 氷川台|고타케무카이하라 小竹向原|센카와 千川|가나메초 要町|이케부쿠로 池袋|조시가야 雑司が谷|니시와세다 西早稲田|히가시신주쿠 東新宿|신주쿠산초메 新宿三丁目|기타산도 北参道|메이지진구마에 明治神宮前|시부야 渋谷' },
  { code: 'A', name: '도에이 아사쿠사선', alias: ["아사쿠사선"], color: '#E85298', up: '오시아게 방면', down: '니시마고메 방면',
    st: '니시마고메 西馬込|마고메 馬込|나카노부 中延|도고시 戸越|고탄다 五反田|다카나와다이 高輪台|센가쿠지 泉岳寺|미타 三田|다이몬 大門|신바시 新橋|히가시긴자 東銀座|다카라초 宝町|니혼바시 日本橋|닌교초 人形町|히가시니혼바시 東日本橋|아사쿠사바시 浅草橋|구라마에 蔵前|아사쿠사 浅草|혼조아즈마바시 本所吾妻橋|오시아게 押上' },
  { code: 'I', name: '도에이 미타선', alias: ["미타선"], color: '#0079C2', up: '니시타카시마다이라 방면', down: '메구로 방면',
    st: '메구로 目黒|시로카네다이 白金台|시로카네타카나와 白金高輪|미타 三田|시바코엔 芝公園|오나리몬 御成門|우치사이와이초 内幸町|히비야 日比谷|오테마치 大手町|진보초 神保町|스이도바시 水道橋|가스가 春日|하쿠산 白山|센고쿠 千石|스가모 巣鴨|니시스가모 西巣鴨|신이타바시 新板橋|이타바시쿠야쿠쇼마에 板橋区役所前|이타바시혼초 板橋本町|모토하스누마 本蓮沼|시무라사카우에 志村坂上|시무라3초메 志村三丁目|하스네 蓮根|니시다이 西台|다카시마다이라 高島平|신타카시마다이라 新高島平|니시타카시마다이라 西高島平' },
  { code: 'S', name: '도에이 신주쿠선', alias: ["신주쿠선"], color: '#6CBB5A', up: '모토야와타 방면', down: '신주쿠 방면',
    st: '신주쿠 新宿|신주쿠3초메 新宿三丁目|아케보노바시 曙橋|이치가야 市ケ谷|구단시타 九段下|진보초 神保町|오가와마치 小川町|이와모토초 岩本町|바쿠로요코야마 馬喰横山|하마초 浜町|모리시타 森下|기쿠카와 菊川|스미요시 住吉|니시오지마 西大島|오지마 大島|히가시오지마 東大島|후나보리 船堀|이치노에 一之江|미즈에 瑞江|시노자키 篠崎|모토야와타 本八幡' },
  { code: 'E', name: '도에이 오에도선', alias: ["오에도"], color: '#B6007A', up: '히카리가오카 방면', down: '신주쿠니시구치 방면',
    st: '신주쿠니시구치 新宿西口|히가시신주쿠 東新宿|와카마쓰카와다 若松河田|우시고메야나기초 牛込柳町|우시고메카구라자카 牛込神楽坂|이다바시 飯田橋|가스가 春日|혼고3초메 本郷三丁目|우에노오카치마치 上野御徒町|신오카치마치 新御徒町|구라마에 蔵前|료고쿠 両国|모리시타 森下|기요스미시라카와 清澄白河|몬젠나카초 門前仲町|쓰키시마 月島|가치도키 勝どき|쓰키지시장 築地市場|시오도메 汐留|다이몬 大門|아카바네바시 赤羽橋|아자부주반 麻布十番|롯폰기 六本木|아오야마1초메 青山一丁目|고쿠리쓰쿄지조 国立競技場|요요기 代々木|신주쿠 新宿|도초마에 都庁前|니시신주쿠5초메 西新宿五丁目|나카노사카우에 中野坂上|히가시나카노 東中野|나카이 中井|오치아이미나미나가사키 落合南長崎|신에고타 新江古田|네리마 練馬|도시마엔 豊島園|네리마카스가초 練馬春日町|히카리가오카 光が丘' },
  { code: 'JC', name: 'JR 주오선 쾌속', alias: ["주오선 쾌속", "주오선"], color: '#F15A22', up: '다카오 방면', down: '도쿄 방면',
    st: '도쿄 東京|간다 神田|오차노미즈 御茶ノ水|요쓰야 四ツ谷|신주쿠 新宿|나카노 中野|고엔지 高円寺|아사가야 阿佐ケ谷|오기쿠보 荻窪|니시오기쿠보 西荻窪|기치조지 吉祥寺|미타카 三鷹|무사시사카이 武蔵境|히가시코가네이 東小金井|무사시코가네이 武蔵小金井|고쿠분지 国分寺|니시코쿠분지 西国分寺|구니타치 国立|다치카와 立川|히노 日野|도요다 豊田|하치오지 八王子|니시하치오지 西八王子|다카오 高尾' },
  { code: 'JB', name: 'JR 주오·소부선', alias: ["소부선", "주오·소부"], color: '#FFD400', up: '지바 방면', down: '미타카 방면',
    st: '미타카 三鷹|기치조지 吉祥寺|니시오기쿠보 西荻窪|오기쿠보 荻窪|아사가야 阿佐ケ谷|고엔지 高円寺|나카노 中野|히가시나카노 東中野|오쿠보 大久保|신주쿠 新宿|요요기 代々木|센다가야 千駄ケ谷|시나노마치 信濃町|요쓰야 四ツ谷|이치가야 市ケ谷|이다바시 飯田橋|스이도바시 水道橋|오차노미즈 御茶ノ水|아키하바라 秋葉原|아사쿠사바시 浅草橋|료고쿠 両国|긴시초 錦糸町|가메이도 亀戸|히라이 平井|신코이와 新小岩|고이와 小岩|이치카와 市川|모토야와타 本八幡|시모사나카야마 下総中山|니시후나바시 西船橋|후나바시 船橋|히가시후나바시 東船橋|쓰다누마 津田沼|마쿠하리혼고 幕張本郷|마쿠하리 幕張|신케미가와 新検見川|이나게 稲毛|니시치바 西千葉|지바 千葉' },
  { code: 'JK', name: 'JR 게이힌도호쿠선', alias: ["게이힌도호쿠"], color: '#00B2E5', up: '오미야 방면', down: '오후나 방면',
    st: '오후나 大船|혼고다이 本郷台|고난다이 港南台|요코다이 洋光台|신스기타 新杉田|이소고 磯子|네기시 根岸|야마테 山手|이시카와초 石川町|간나이 関内|사쿠라기초 桜木町|요코하마 横浜|히가시카나가와 東神奈川|신코야스 新子安|쓰루미 鶴見|가와사키 川崎|가마타 蒲田|오모리 大森|오이마치 大井町|시나가와 品川|다카나와게이트웨이 高輪ゲートウェイ|다마치 田町|하마마쓰초 浜松町|신바시 新橋|유라쿠초 有楽町|도쿄 東京|간다 神田|아키하바라 秋葉原|오카치마치 御徒町|우에노 上野|우구이스다니 鶯谷|닛포리 日暮里|니시닛포리 西日暮里|다바타 田端|가미나카자토 上中里|오지 王子|히가시주조 東十条|아카바네 赤羽|가와구치 川口|니시카와구치 西川口|와라비 蕨|미나미우라와 南浦和|우라와 浦和|기타우라와 北浦和|요노 与野|사이타마신도심 さいたま新都心|오미야 大宮' },
].map((l) => ({ ...l, st: l.st.split('|').map((x, i) => { const [ko, ja] = x.split(' '); return { no: `${l.code}${String(i + 1).padStart(2, '0')}`, name: ko, ja }; }) }));
// Station positions (OpenStreetMap, 2026-11-08) for the lines above, same order: lets the app plan
// walk → nearest station → ride → station → walk when Google won't (its API returns no transit routes in Japan).
const LINE_PTS = {"H": "35.64414,139.69883|35.64697,139.70865|35.65206,139.7222|35.66284,139.73133|35.66296,139.74505|35.66747,139.74776|35.6725,139.75162|35.67374,139.75837|35.67284,139.7631|35.66968,139.76695|35.66808,139.77259|35.675,139.77707|35.68023,139.77942|35.68618,139.78242|35.69075,139.77845|35.69846,139.7755|35.70649,139.7762|35.71171,139.77615|35.72071,139.78458|35.72955,139.7913|35.73235,139.7988|35.74966,139.80451", "G": "35.659,139.70244|35.66523,139.71239|35.67046,139.71788|35.67278,139.72402|35.67632,139.73753|35.67299,139.74142|35.67019,139.75006|35.66719,139.75886|35.67284,139.7631|35.6767,139.77004|35.68208,139.7734|35.68495,139.77307|35.69371,139.77089|35.70294,139.77168|35.70783,139.77299|35.71171,139.77615|35.71139,139.78269|35.70984,139.79075|35.71084,139.79782", "JY": "35.68125,139.76671|35.69179,139.77091|35.69837,139.77303|35.70695,139.77463|35.71341,139.77654|35.7217,139.77792|35.72815,139.77066|35.7322,139.76667|35.73737,139.76171|35.73658,139.74724|35.73341,139.73943|35.73169,139.72859|35.73018,139.71115|35.72119,139.70646|35.71268,139.70364|35.7013,139.70024|35.69026,139.70051|35.68395,139.70208|35.67021,139.70243|35.65808,139.70176|35.64644,139.71021|35.63407,139.71573|35.62626,139.72363|35.61939,139.72849|35.62867,139.73917|35.6354,139.74066|35.64574,139.74769|35.65511,139.75706|35.66617,139.75822|35.67496,139.76304", "TY": "35.65845,139.70284|35.64816,139.70329|35.64414,139.69883|35.63757,139.69101|35.62895,139.68535|35.61754,139.67618|35.60754,139.66883", "U": "35.66542,139.75989|35.66290,139.76002|35.65398,139.76194|35.64914,139.75914|35.64173,139.75780|35.62987,139.77884|35.62585,139.77144|35.62142,139.77313|35.61760,139.77941|35.62475,139.78121|35.63026,139.79134|35.63453,139.79321|35.64009,139.78874|35.64580,139.78575|35.64878,139.79016|35.65379,139.79536", "Y": "35.78835,139.61287|35.77670,139.63133|35.76997,139.64417|35.75769,139.65425|35.74986,139.66508|35.74298,139.68070|35.73829,139.68950|35.73328,139.69872|35.72971,139.70973|35.72570,139.71959|35.71910,139.72751|35.70957,139.73360|35.70156,139.74362|35.69236,139.73678|35.68403,139.73767|35.67799,139.74161|35.67746,139.75169|35.67602,139.76215|35.67438,139.76706|35.67065,139.77343|35.66457,139.78477|35.65508,139.79625|35.64552,139.81074|35.64597,139.82665", "M": "35.70417,139.61976|35.69946,139.63557|35.69786,139.64851|35.69797,139.65830|35.69747,139.66951|35.69709,139.68221|35.69452,139.69256|35.69245,139.70055|35.69118,139.70421|35.68852,139.71091|35.68797,139.72057|35.68455,139.72997|35.67685,139.73735|35.67454,139.74557|35.67424,139.75268|35.67289,139.76318|35.68194,139.76480|35.68688,139.76620|35.69487,139.76746|35.70057,139.76403|35.70673,139.76015|35.70734,139.75125|35.71720,139.73690|35.72579,139.72993|35.73034,139.71115", "Z": "35.65945,139.70103|35.66504,139.71247|35.67279,139.72414|35.67841,139.73887|35.68538,139.74169|35.69550,139.75112|35.69602,139.75756|35.68675,139.76490|35.68493,139.77308|35.68300,139.78517|35.68212,139.79984|35.68870,139.81567|35.69744,139.81496|35.70847,139.81374", "C": "35.66906,139.67968|35.66910,139.68979|35.66912,139.70394|35.66565,139.71135|35.66659,139.72623|35.67210,139.73641|35.67357,139.74319|35.67256,139.75177|35.67395,139.75877|35.68050,139.76178|35.68525,139.76328|35.69693,139.76545|35.70681,139.76998|35.71733,139.76575|35.72575,139.76330|35.73235,139.76689|35.74207,139.78005|35.74920,139.80440|35.76212,139.82481|35.77689,139.83210", "T": "35.70573,139.66594|35.71064,139.68597|35.71328,139.70505|35.70580,139.72119|35.70387,139.73452|35.70140,139.74652|35.69609,139.75126|35.69044,139.75767|35.68470,139.76603|35.68238,139.77410|35.68035,139.77927|35.67189,139.79610|35.66936,139.80712|35.66959,139.81768|35.66842,139.83169|35.66456,139.85960|35.66362,139.87253|35.66590,139.89324|35.67273,139.90228|35.68262,139.91419|35.69101,139.92429|35.70330,139.94191|35.70713,139.95925", "N": "35.63297,139.71546|35.63785,139.72601|35.64328,139.73434|35.65481,139.73704|35.66508,139.73890|35.67309,139.74129|35.67834,139.73929|35.68608,139.72968|35.69289,139.73632|35.70153,139.74372|35.70839,139.75179|35.71801,139.75788|35.72436,139.75381|35.73591,139.74691|35.74594,139.74226|35.75447,139.73736|35.76529,139.73564|35.77802,139.73250|35.78336,139.72211", "F": "35.78835,139.61286|35.77674,139.63117|35.76998,139.64400|35.75756,139.65430|35.74962,139.66547|35.74339,139.67952|35.73817,139.68940|35.73322,139.69848|35.73114,139.70894|35.72020,139.71472|35.70781,139.70912|35.69983,139.70785|35.69061,139.70473|35.67850,139.70547|35.66821,139.70524|35.65909,139.70257", "A": "35.58705,139.70609|35.59677,139.71188|35.60527,139.71365|35.61442,139.71632|35.62688,139.72396|35.63175,139.73038|35.63871,139.73999|35.64675,139.74688|35.65687,139.75468|35.66539,139.75934|35.66992,139.76735|35.67561,139.77197|35.68180,139.77581|35.68635,139.78228|35.69212,139.78489|35.69749,139.78634|35.70313,139.79086|35.70892,139.79654|35.70857,139.80440|35.71082,139.81299", "I": "35.63297,139.71546|35.63785,139.72601|35.64328,139.73434|35.64865,139.74900|35.65419,139.74985|35.66077,139.75137|35.66934,139.75533|35.67659,139.76027|35.68409,139.76280|35.69533,139.75821|35.70346,139.75515|35.70953,139.75329|35.72168,139.75213|35.72777,139.74498|35.73379,139.73815|35.74357,139.72870|35.74877,139.71981|35.75137,139.71012|35.76131,139.70554|35.76857,139.70241|35.77608,139.69510|35.77747,139.68575|35.78426,139.67895|35.78707,139.67287|35.78891,139.66136|35.79029,139.65405|35.79196,139.64542", "S": "35.68843,139.69842|35.69102,139.70679|35.69240,139.72232|35.69153,139.73759|35.69555,139.75174|35.69597,139.75798|35.69501,139.76645|35.69561,139.77511|35.69193,139.78301|35.68860,139.78772|35.68798,139.79662|35.68840,139.80606|35.68904,139.81572|35.68939,139.82623|35.68975,139.83471|35.68996,139.84725|35.68376,139.86396|35.68599,139.88259|35.69351,139.89770|35.70602,139.90380|35.72282,139.92661", "E": "35.69337,139.69912|35.69796,139.70743|35.69919,139.71804|35.69950,139.72504|35.70091,139.73589|35.70295,139.74526|35.70849,139.75249|35.70751,139.76052|35.70795,139.77335|35.70701,139.78217|35.70559,139.79224|35.69681,139.79747|35.68793,139.79825|35.68236,139.79876|35.67277,139.79512|35.66376,139.78391|35.65893,139.77714|35.66492,139.76693|35.66319,139.76022|35.65667,139.75570|35.65499,139.74399|35.65645,139.73633|35.66411,139.73135|35.67307,139.72393|35.67990,139.71467|35.68350,139.70160|35.68846,139.69902|35.69049,139.69271|35.68989,139.68455|35.69789,139.68290|35.70716,139.68311|35.71393,139.68630|35.72344,139.68339|35.73258,139.67050|35.73741,139.65476|35.74171,139.64912|35.75141,139.64030|35.75853,139.62890", "JC": "35.68130,139.76704|35.69157,139.77065|35.69935,139.76510|35.68490,139.73038|35.69018,139.70038|35.70573,139.66594|35.70518,139.64955|35.70462,139.63566|35.70434,139.62011|35.70351,139.59928|35.70295,139.57984|35.70268,139.56067|35.70184,139.54345|35.70156,139.52373|35.70101,139.50595|35.69990,139.48096|35.69962,139.46596|35.69906,139.44651|35.69795,139.41374|35.67851,139.39346|35.65934,139.38124|35.65545,139.33903|35.65601,139.31181|35.64240,139.28264", "JB": "35.70268,139.56067|35.70295,139.57984|35.70351,139.59928|35.70434,139.62011|35.70462,139.63566|35.70518,139.64955|35.70573,139.66594|35.70601,139.68483|35.70046,139.69733|35.69018,139.70038|35.68352,139.70205|35.68119,139.71153|35.67991,139.72094|35.68490,139.73038|35.69102,139.73510|35.70157,139.74482|35.70207,139.75341|35.69935,139.76510|35.69824,139.77288|35.69740,139.78399|35.69574,139.79315|35.69657,139.81398|35.69713,139.82648|35.70629,139.84231|35.71685,139.85787|35.73324,139.88175|35.72879,139.90786|35.72074,139.92731|35.71407,139.94286|35.70713,139.95925|35.70158,139.98480|35.69963,140.00397|35.69130,140.02008|35.67297,140.04174|35.65936,140.05758|35.65185,140.07331|35.63714,140.09257|35.62270,140.10313|35.61353,140.11257", "JK": "35.35383,139.53124|35.36771,139.54985|35.37521,139.57624|35.37855,139.59679|35.38716,139.61929|35.40049,139.61818|35.41577,139.63595|35.42689,139.64640|35.43854,139.64317|35.44410,139.63595|35.45076,139.63095|35.46576,139.62234|35.47770,139.63317|35.48687,139.65401|35.50826,139.67595|35.53131,139.69678|35.56214,139.71566|35.58880,139.72788|35.60658,139.73483|35.62880,139.73871|35.63540,139.74066|35.64574,139.74760|35.65546,139.75705|35.66630,139.75788|35.67491,139.76288|35.68130,139.76704|35.69157,139.77065|35.69824,139.77288|35.70713,139.77454|35.71351,139.77676|35.72129,139.77787|35.72712,139.77093|35.73184,139.76676|35.73740,139.76149|35.74684,139.74593|35.75212,139.73815|35.76378,139.72677|35.77767,139.72093|35.80156,139.71732|35.81544,139.70399|35.82803,139.69050|35.84766,139.66899|35.85849,139.65732|35.87210,139.64594|35.88432,139.63899|35.89377,139.63344|35.90627,139.62427"};
for (const l of LINES) (LINE_PTS[l.code] || '').split('|').forEach((p, i) => { const [lat, lng] = p.split(',').map(Number); if (l.st[i]) Object.assign(l.st[i], { lat, lng }); });
// Which way a ride goes, as signs say it. On the Yamanote loop that depends on where you board: the next two
// big stations ahead (from Ebisu toward Okachimachi the inner loop reads 시나가와·도쿄 방면).
const LOOP_MAJOR = ['도쿄', '우에노', '이케부쿠로', '신주쿠', '시부야', '시나가와'];
function dirOf(L, ia, fwd) {
  if (!L.loop) return fwd ? L.up : L.down;
  const n = L.st.length;
  const ahead = [];
  for (let k = 1; k < n && ahead.length < 2; k += 1) {
    const st = L.st[(ia + (fwd ? k : -k) + n) % n];
    if (LOOP_MAJOR.includes(st.name)) ahead.push(st.name);
  }
  return `${ahead.join('·')} 방면 (${fwd ? '내선순환' : '외선순환'})`;
}
function lineFromTitle(title) {
  const t = stripEmoji(title || '').replace(/\s+/g, ' ');
  const m = /^(.*?)\s*(?:→|->)\s*(.+)$/.exec(t);
  if (!m) return null;
  const l = LINES.find((x) => [x.name, ...x.alias].some((a) => m[1].includes(a)));
  if (!l) return null;
  // The longest station name in each half wins ('우에노히로코지' over '우에노'); the line's own name doesn't count.
  const pick = (text) => l.st.filter((s) => text.replace(l.name, ' ').replace(/히비야선|긴자선/g, ' ').includes(s.name)).sort((a, b) => b.name.length - a.name.length)[0];
  const a = pick(m[1].replace(/역/g, ''));
  const b = pick(m[2].replace(/역/g, ''));
  if (!a || !b || a === b) return null;
  const ia = l.st.indexOf(a), ib = l.st.indexOf(b);
  const fwd = l.loop ? (ib - ia + l.st.length) % l.st.length <= l.st.length / 2 : ib > ia;
  return { leg: { code: l.code, name: l.name, color: l.color, from: { no: a.no, name: a.name }, to: { no: b.no, name: b.name }, dir: dirOf(l, ia, fwd) }, ja: b.ja };
}
const effectiveItems = (day, withDeleted = false) => planItems().filter((it) => it.date === day.date && (withDeleted || !it.del));
const rawItem = (id) => state.trip.days.flatMap((d) => d.items.map((it) => ({ ...it, date: d.date }))).find((x) => x.id === id)
  || store.get('myitems', []).find((x) => x.id === id);
const dayOf = (date) => state.trip.days.find((d) => d.date === date);
// Booked and boarding times can't move; a stop the user locked can't either.
const isFixed = (it) => ('lock' in it ? !!it.lock : !!it.hard);
const isMove = (it) => glyph(it.icon)[1] === 'move';
// A stop moved to another place keeps its time; everything about the old place goes with it.
const swappedStop = (it, p) => {
  const ja = p.verified?.name || p.name;
  return {
    title: p.name, icon: CAT_ICON[p.cat], placeId: p.id, info: undefined, docs: undefined, rainPlan: undefined, link: undefined,
    place: { nameJa: ja, query: ja }, note: `원래 일정: ${stripEmoji(it.title)}`,
  };
};
const allItems = () => planItems().filter((it) => !it.del);
function findItem(id) {
  const it = allItems().find((x) => x.id === id);
  const added = it?.placeId && placeById(it.placeId);
  return added && !it.info ? { ...it, info: placeInfo(added) } : it;
}

// Items sorted by start, with startMin/endMin filled in (missing end = next start or +30 min).
function dayItems(day) {
  const items = effectiveItems(day).sort((a, b) => toMin(a.start) - toMin(b.start));
  return items.map((it, i) => {
    const startMin = toMin(it.start);
    const nextStart = items.slice(i + 1).map((n) => toMin(n.start)).find((m) => m > startMin);
    const endMin = it.end ? toMin(it.end) : Math.min(nextStart ?? startMin + 30, startMin + 120);
    const added = it.placeId && placeById(it.placeId);
    return { ...it, info: it.info || (added ? placeInfo(added) : undefined), date: day.date, startMin, endMin };
  });
}

// Built-in checklist plus items the user added on this phone.
function checklist() {
  const custom = store.get('custom', []).map((c) => ({ ...c, group: '내가 추가', custom: true }));
  return [...state.trip.checklist, ...custom];
}

function bookingNeeded(it) {
  if (!it.booking?.required) return false;
  const ck = state.trip.checklist.find((c) => c.linkItem === it.id);
  return !(ck && isChecked(ck.id));
}

// ---------- running late ----------
// A stop counts as begun once it is marked started, or once a shorter stop inside it (lunch inside Ginza) is.
const isStarted = (it, items) => store.get('start:' + it.id, false)
  || items.some((y) => y.startMin > it.startMin && y.startMin < it.endMin && (isDone(y.id) || store.get('start:' + y.id, false)));

// Today's stops whose time has come but that aren't finished, in order: the first is the one we're on,
// the rest are waiting behind it. Stops before the last one done or started drop out (the trip moved on),
// unless they're long stops still running around it; such a long stop also waits quietly while one inside it runs.
function dueQueue(items, now) {
  const mark = items.reduce((m, it, i) => (isDone(it.id) || isStarted(it, items) ? i : m), -1);
  const anchor = items[mark];
  const open = items.filter((it, i) => !it.skip && !isDone(it.id) && it.startMin <= now.min
    && (i >= mark || (it.endMin > anchor.startMin && now.min < it.endMin)));
  return open.filter((x) => !(now.min < x.endMin && open.some((y) => y !== x && y.startMin > x.startMin && y.startMin < x.endMin)));
}
// How one of today's stops is running behind: `over` past its end, `late` to start, `wait` stuck behind another.
function delayOf(it, now) {
  if (!now || now.date !== it.date || it.skip || isDone(it.id)) return null;
  const items = dayItems(dayOf(it.date)).filter((x) => !x.skip);
  const queue = dueQueue(items, now);
  const i = queue.findIndex((x) => x.id === it.id);
  if (i < 0) return null;
  // The stop as the day computes it (a stop opened from elsewhere may lack the minute fields).
  const q = queue[i];
  if (i === 0 && isStarted(q, items)) return now.min > q.endMin ? { kind: 'over', min: now.min - q.endMin } : null;
  const min = now.min - q.startMin;
  if (!Number.isFinite(min)) return null;
  // Inside the entry window (Shibuya Sky: in by 13:59) it isn't late yet.
  if (i === 0 && q.enterBy && now.min <= toMin(q.enterBy)) return null;
  return i === 0 && min < 10 ? null : { kind: i ? 'wait' : 'late', min };
}
const delayText = (d) => (d.kind === 'over' ? `${formatLeft(d.min)} 초과` : d.kind === 'late' ? `${formatLeft(d.min)} 늦음` : `밀림 · ${formatLeft(d.min)}`);

// Minutes to get from one stop to the next: none around a move row or within one place, the walk when
// it's close (same estimate as the timeline), otherwise about 3 min/km + 10 by train; 10 when unknown.
let travelMode = null;
const taxiMin = (km) => Math.max(5, Math.ceil(km * 3) + 4);
// Tokyo fare, roughly: 500 yen for the first 1.096 km, then 100 yen per 255 m.
const taxiFare = (km) => Math.round((500 + Math.max(0, km - 1.096) * 392) / 10) * 10;
function travelMin(a, b) {
  if (!a || !b || isMove(a) || isMove(b)) return 0;
  const pa = placeOfItem(a.id);
  const pb = placeOfItem(b.id);
  if (pa && pa === pb) return 0;
  if (!pa?.lat || !pb?.lat) return 10;
  // Trying the taxi way: door to door at about 20 km/h plus getting one (no walk to a station, no platform).
  if (travelMode === 'taxi') { const k = kmBetween(pa, pb); if (k >= 0.4) return taxiMin(k); }
  // 일정 엔진 S3: a Google route already looked up for this pair wins, with the leg buffer (+15%, at least 3 min).
  const g = gKey() && store.get(routeKey(pa, pb, a.date || b.date, a.endMin ?? toMin(a.end || a.start)), null);
  if (g && !g.none) return g.min + Math.max(3, Math.ceil(g.min * 0.15));
  const km = kmBetween(pa, pb);
  const t = km > 1.2 && tableRoute(pa, pb);
  if (t && t.steps.some((x) => x.mode === 'ride')) return t.min + Math.max(3, Math.ceil(t.min * 0.15));
  if (km < 0.15) return 0; // same building or next door
  return km <= 1.2 ? Math.max(1, Math.ceil((km * 1000 * 1.3) / 75)) : Math.ceil(km * 3 + 10);
}
// The knock-on changes when one stop takes [s, e] (idx -1: a new stop put in at s). Later stops keep their
// lengths and the gaps between them; free time soaks up the push, a fixed stop is a wall nothing moves past,
// and `cut` shortens stops by the given minutes. Pulling earlier only moves stops that follow straight on.
function ripple(list, idx, s, e, cut = {}) {
  const t = list[idx];
  let push = t ? e - t.endMin : e - s;
  let prevEnd = t ? t.endMin : s;
  const changes = [];
  const walls = [];
  let prev = t;
  for (const it of t ? list.slice(idx + 1) : list.filter((x) => x.startMin >= s)) {
    const gap = it.startMin - prevEnd;
    prevEnd = Math.max(prevEnd, it.endMin);
    // Free time soaks up the push, but the time it takes to get there stays.
    const slack = Math.max(0, gap - Math.min(gap, travelMin(prev, it)));
    prev = it;
    if (gap > 0) push = push > 0 ? Math.max(0, push - slack) : 0;
    if (isDone(it.id)) continue;
    if (isFixed(it)) {
      if (push > 0) walls.push({ it, over: push });
      push = 0;
      continue;
    }
    const c = cut[it.id] || 0;
    if (!push && !c) continue;
    const start = Math.min(1439, it.startMin + push);
    changes.push({ it, start, end: Math.min(1439, start + it.endMin - it.startMin - c), cut: c });
    push -= c;
  }
  return { changes, walls, push: t ? e - t.endMin : e - s };
}
// Minutes to take off the pushed stops ahead of the first wall so it fits: optional stops first, must-sees last,
// never moves, and no stop below half its length or 20 minutes.
function fitCuts(list, idx, s, e) {
  const plan = ripple(list, idx, s, e);
  const wall = plan.walls[0];
  if (!wall) return null;
  const before = plan.changes.filter((c) => c.it.startMin < wall.it.startMin && !isMove(c.it));
  const tier = (it) => (it.priority === 'optional' ? 0 : it.priority === 'must' ? 2 : 1);
  const cut = {};
  let need = wall.over;
  for (const c of [...before].sort((a, b) => tier(a.it) - tier(b.it))) {
    const len = c.it.endMin - c.it.startMin;
    const floor = store.get('stay:' + c.it.id, null) ? stayRange(c.it).min : Math.max(20, Math.ceil(len / 2));
    const take = Math.min(need, Math.max(0, len - floor));
    if (take) { cut[c.it.id] = take; need -= take; }
    if (!need) break;
  }
  return Object.keys(cut).length ? cut : null;
}

const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// The hero says how late it is in its own words, so it leaves out the delay chip.
function chipsFor(it, now, withDelay = true) {
  const chips = [];
  const late = withDelay && delayOf(it, now);
  if (late) chips.push([isFixed(it) ? 'late' : 'warn', delayText(late)]);
  if (it.priority === 'must') chips.push(['must', '필수']);
  if (it.priority === 'optional') chips.push(['', '선택']);
  if (it.booking?.required) chips.push(bookingNeeded(it) ? ['warn', '예약 필요'] : ['ok', '예약 완료']);
  if (it.closedDays?.includes(dowOf(it.date))) chips.push(['warn', '이 날 휴무']);
  if (it.hours) {
    chips.push(['', it.hours]);
    const close = it.hours.split('~')[1];
    if (now && now.date === it.date && close) {
      const left = toMin(close) - now.min;
      if (left > 0 && left <= 60) chips.push(['warn', `곧 마감 ${left}분`]);
      if (left <= 0) chips.push(['warn', '영업 종료']);
    }
  }
  if (it.enterBy) chips.push(['', `${it.enterBy}까지 입장`, 'clock']);
  if (it.verify) chips.push(['warn', '확인 필요']);
  const w = wxFor(it);
  // Rain only matters per item when there is an indoor alternative; the day card covers umbrellas.
  if (it.rainPlan) chips.push(w && w.pop >= 50 ? ['warn', `비 ${w.pop}% · 대안 보기`, 'umbrella'] : ['', '비 올 때 대안', 'umbrella']);
  return chips;
}
// Must/optional sits beside the time as a small tag, so the chip row only carries what changes.
const tagFor = (it) => (it.priority === 'must' ? '<span class="tag must">필수</span>' : it.priority === 'optional' ? '<span class="tag">선택</span>' : '');
const noTag = ([cls, t]) => cls !== 'must' && t !== '선택';
// In the detail popup chips sit in the same line as the time; the rain tag jumps to the plan further down.
const chipTag = ([cls, t, ic]) => (ic === 'umbrella'
  ? `<button class="tag ${cls}" data-jump="item-rain">${icon(ic)}${esc(t)}</button>`
  : `<span class="tag ${cls}">${ic ? icon(ic) : ''}${esc(t)}</span>`);
const chipsHtml = (chips) => chips.length
  ? `<div class="chips">${chips.map(([cls, t, ic]) => `<span class="chip ${cls}">${ic ? icon(ic) : ''}${esc(t)}</span>`).join('')}</div>`
  : '';

// ---------- weather (Open-Meteo, no key; last forecast kept on this phone for offline) ----------
const WX_URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.69&longitude=139.75'
  + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,precipitation,uv_index,cloud_cover,wind_speed_10m'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,precipitation_sum,sunshine_duration'
  + '&timezone=Asia%2FTokyo&forecast_days=16&past_days=2';
// Bumped when the fields asked for change, so an older saved forecast is fetched again.
const WX_V = 2;
const WX_TTL = 30 * 60 * 1000;
// WMO weather codes: each entry covers codes from its number up to the next entry.
const WMO = [[0, 'wx-sun', '맑음'], [1, 'wx-partly', '대체로 맑음'], [2, 'wx-partly', '구름 많음'], [3, 'wx-cloud', '흐림'], [45, 'wx-fog', '안개'],
  [51, 'wx-rain', '이슬비'], [61, 'wx-rain', '비'], [66, 'wx-rain', '어는 비'], [71, 'wx-snow', '눈'], [80, 'wx-rain', '소나기'], [85, 'wx-snow', '눈 소나기'], [95, 'wx-storm', '뇌우']];
const wmo = (code) => {
  const hit = WMO.filter(([c]) => code >= c).pop() || WMO[0];
  return { icon: hit[1], label: hit[2] };
};

async function loadWeather(force = false) {
  if (!force && state.wx?.v === WX_V && Date.now() - state.wx.at < WX_TTL) return;
  try {
    const res = await fetch(WX_URL);
    if (!res.ok) throw new Error(String(res.status));
    const { hourly, daily } = await res.json();
    state.wx = { v: WX_V, at: Date.now(), hourly, daily };
    store.set('wx', state.wx);
    logWeather(state.wx);
    if (force) toast('날씨를 업데이트했어요');
    if ($('#sheet').hidden) render();
  } catch {
    if (force) toast(state.wx ? '인터넷이 안 돼서 저장된 예보를 보여줘요' : '날씨를 불러오지 못했어요');
  }
}

// Each day the forecast covers is kept on this phone by date, so a past day (yesterday's weather,
// a finished day's summary) stays readable after it drops out of the forecast, and offline.
function logWeather({ hourly: h, daily: d }) {
  const log = { ...(state.wxlog || {}) };
  d.time.forEach((date, i) => {
    const hrs = {};
    h.time.forEach((t, j) => {
      if (t.startsWith(date)) hrs[Number(t.slice(11, 13))] = [h.weather_code[j], h.temperature_2m[j], h.apparent_temperature[j], h.precipitation_probability?.[j], h.precipitation?.[j], h.uv_index?.[j], h.cloud_cover?.[j], h.wind_speed_10m?.[j]];
    });
    log[date] = { d: [d.weather_code[i], d.temperature_2m_max[i], d.temperature_2m_min[i], d.precipitation_probability_max[i], d.uv_index_max?.[i], d.precipitation_sum?.[i], d.sunshine_duration?.[i]], h: hrs };
  });
  state.wxlog = log;
  store.set('wxlog', log);
}

// Dry hours get their sky from the cloud cover: under 25% clear, under 50% mostly clear, under 80% cloudy, else overcast.
const skyCode = (code, cloud) => (code > 3 || cloud == null ? code : cloud < 25 ? 0 : cloud < 50 ? 1 : cloud < 80 ? 2 : 3);
function wxDay(date) {
  const e = state.wxlog?.[date];
  if (!e) return null;
  const [raw, max, min, pop, uv, rain, sun] = e.d;
  // A dry day takes the daylight hours' average cloud.
  const lit = Object.entries(e.h).filter(([h, r]) => h >= 8 && h <= 17 && r[6] != null).map(([, r]) => r[6]);
  const code = skyCode(raw, lit.length ? lit.reduce((a, b) => a + b, 0) / lit.length : null);
  return { ...wmo(code), code, max: Math.round(max), min: Math.round(min), pop: pop ?? 0, uv: uv ?? 0, rain: rain ?? 0, sun: sun ?? 0 };
}

function wxHour(date, min) {
  const hour = Math.floor(min / 60);
  const r = state.wxlog?.[date]?.h[hour];
  if (!r || r[1] == null) return null;
  const [raw, temp, feels, pop, rain, uv, cloud, wind] = r;
  const code = skyCode(raw, cloud);
  return { ...wmo(code), code, hour, temp: Math.round(temp), feels: Math.round(feels), pop: pop ?? 0, rain: rain ?? 0, uv: uv ?? 0, cloud: cloud ?? 0, wind: wind ?? 0 };
}
const wxHours = (date, fromH, toH) =>
  Array.from({ length: toH - fromH + 1 }, (_, k) => wxHour(date, (fromH + k) * 60)).filter(Boolean);

// Tokyo forecast for an item, skipped for places in Korea.
const wxFor = (it) => (it.place?.lang === 'ko' || !it.place ? null : wxHour(it.date, toMin(it.start)));

// What to do about the weather while out (08–22h), as chips.
function wxTips(date) {
  const hrs = wxHours(date, 8, 22);
  if (!hrs.length) return [];
  const tips = [];
  const top = hrs.reduce((a, b) => (b.pop > a.pop ? b : a));
  const sp = rainSpan(date);
  // Drizzle under 0.5mm an hour only needs a folding umbrella.
  if (sp?.light) { if (sp.max >= 30) tips.push(['', `접이식 우산 · ${sp.when} 약한 비 ${sp.max}%`, 'umbrella']); }
  else if (sp && (sp.n >= 3 || sp.max >= 50)) tips.push(['warn', `우산 필수 · ${sp.when} 비 최대 ${sp.max}%`, 'umbrella']);
  else if (sp) tips.push(['', `접이식 우산 · ${sp.when} 비 ${sp.max}%`, 'umbrella']);
  else if (top.pop >= 30) tips.push(['', `접이식 우산 · ${top.hour}시쯤 비 ${top.pop}%`, 'umbrella']);
  const lo = Math.min(...hrs.map((h) => h.feels));
  const hi = Math.max(...hrs.map((h) => h.temp));
  if (lo <= 10) tips.push(['', `체감 ${lo}°까지 · 따뜻한 겉옷`, 'coat']);
  else if (lo <= 15) tips.push(['', `아침저녁 체감 ${lo}° · 가벼운 겉옷`, 'coat']);
  if (hi - lo >= 8) tips.push(['', `일교차 ${hi - lo}° · 겹쳐 입기`, 'temp']);
  if (hi >= 24) tips.push(['', `낮 ${hi}° · 가벼운 옷`, 'tshirt']);
  return tips;
}

// ---------- the day's weather in words, and what to bring ----------
const isWet = (h) => h.code >= 51 || h.rain >= 0.3;
// For today and later, an hour with a 50%+ chance counts as rain too, the same hours the strip marks blue.
// A past day goes by what the model says fell.
const rainyAt = (date) => (date >= tokyoNow().date ? (h) => isWet(h) || h.pop >= 50 : isWet);
// The rain while out (08–22h) in one phrase, shared by the weather card and the morning prep card.
function rainSpan(date) {
  const wet = wxHours(date, 8, 22).filter(rainyAt(date));
  if (!wet.length) return null;
  const from = wet[0].hour;
  const to = wet[wet.length - 1].hour;
  const when = from <= 9 && to >= 20 ? '하루 종일' : to >= 21 ? `${from}시부터` : from === to ? `${from}시쯤` : `${from}~${to + 1}시`;
  return { wet, from, to, when, n: wet.length, max: Math.max(...wet.map((h) => h.pop)), light: wet.every((h) => h.rain < 0.5) };
}
// Sky over the given hours, judged on daylight hours only.
const skyOf = (hrs) => {
  const lit = hrs.filter((h) => h.hour >= 8 && h.hour <= 17);
  const list = lit.length ? lit : hrs;
  if (!list.length) return '';
  const clear = list.filter((h) => h.code <= 1).length / list.length;
  const grey = list.filter((h) => h.code === 3 || h.code >= 45).length / list.length;
  return clear >= 0.6 ? '맑음' : grey >= 0.5 ? '흐림' : '구름 많음';
};
const uvWord = (uv) => (uv >= 8 ? '매우 강함' : uv >= 6 ? '강함' : uv >= 3 ? '보통' : '약함');
// When it rained, when it cleared, and how warm and bright the day was. Rain before dawn counts as "cleared".
function wxStory(date) {
  const day = wxDay(date);
  const all = wxHours(date, 0, 22);
  const hrs = all.filter((h) => h.hour >= 5);
  if (!day || hrs.length < 6) return null;
  const rainy = rainyAt(date);
  const runs = [];
  for (const h of hrs) {
    if (!rainy(h)) continue;
    const r = runs[runs.length - 1];
    if (r && r[1] === h.hour - 1) r[1] = h.hour; else runs.push([h.hour, h.hour]);
  }
  const wetN = runs.reduce((a, [f, t]) => a + t - f + 1, 0);
  // Strength is judged while out (from 8h), so heavy rain before dawn doesn't make the day's rain read heavy.
  const light = hrs.filter((h) => h.hour >= 8 && rainy(h)).every((h) => h.rain < 0.5);
  const rainWord = light ? '약한 비' : '비';
  // Sunny most of the day by the hours of sunshine, even if a few hours read as cloud.
  const sky = (list) => (day.sun >= 6 * 3600 && list.length >= 8 ? '맑음' : skyOf(list));
  let head;
  if (!runs.length) {
    const s0 = sky(hrs);
    const dawn = all.some((h) => h.hour < 5 && isWet(h));
    head = dawn ? `새벽 비 그친 뒤 ${s0}` : { 맑음: '하루 종일 맑음', '구름 많음': '구름 많고 비 없음', 흐림: '대체로 흐림, 비 없음' }[s0];
  } else if (wetN >= 12) head = `하루 종일 ${rainWord}`;
  else {
    const f = runs[0][0];
    const t = runs[runs.length - 1][1];
    const after = hrs.filter((h) => h.hour > t);
    const before = hrs.filter((h) => h.hour < f);
    if (f <= 9 && after.length >= 4) head = `아침 ${rainWord}(${f}~${t + 1}시) 그친 뒤 ${skyOf(after)}`;
    else if (t >= 21 || after.length < 2) head = `${skyOf(before) || '흐림'}, ${f}시부터 ${rainWord}`;
    else head = `${skyOf(before) || '흐림'}, ${f}~${t + 1}시 ${rainWord}`;
  }
  const uv = Math.max(day.uv, ...hrs.map((h) => h.uv));
  const wind = Math.max(...hrs.map((h) => h.wind));
  const sunH = Math.round(day.sun / 3600);
  const facts = [`${day.min}~${day.max}°`, `자외선 ${uvWord(uv)} (${uv.toFixed(0)})`, sunH ? `해 ${sunH}시간` : '', day.rain >= 1 ? `비 ${day.rain.toFixed(0)}mm` : '', wind >= 25 ? '바람 강함' : ''];
  const icon = runs.length ? 'wx-rain' : { 맑음: 'wx-sun', '구름 많음': 'wx-partly', 흐림: 'wx-cloud' }[sky(hrs)];
  return { head, line: facts.filter(Boolean).join(' · '), icon, sky: runs.length ? rainWord : sky(hrs) };
}

// How the day's clothes felt, per person — the one thing the forecast can't know (umbrella and sunglasses follow the forecast).
const GEAR = [
  ['coat', 'coat', '겉옷', [['hot', '더웠어요'], ['ok', '딱 맞았어요'], ['cold', '추웠어요']]],
];
// 옷차림 기록은 사람(계정 id)마다. 예전 '안드레아' 기록은 여행 마스터 것으로 읽어요.
const gearLog = (date, id) => store.get(`gear:${date}:${id}`, null) || (id === mateKey('나') ? store.get(`gear:${date}:안드레아`, null) || store.get(`gear:${date}:나`, null) : null);
const lastGear = (date, name) => state.trip.days.map((d) => d.date).filter((d) => d < date).reverse().map((d) => gearLog(d, name)).find(Boolean) || null;
const gearText = (g) => (g ? GEAR.map(([k, , label, opts]) => g[k] && `${label} ${opts.find(([v]) => v === g[k])[1]}`).filter(Boolean).concat(g.memo ? [g.memo] : []) : []);
// The latest record before `date` nudges the next day's advice for that person.
function gearBias(date, name) {
  const g = lastGear(date, name) || {};
  const notes = [];
  if (g.coat === 'cold') notes.push(['coat', '지난번에 추웠다고 남겨서, 겉옷을 한 단계 두껍게 골랐어요.']);
  if (g.coat === 'hot') notes.push(['coat', '지난번에 더웠다고 남겨서, 겉옷을 한 단계 얇게 골랐어요.']);
  return {
    u: 0,
    s: 0,
    c: g.coat === 'cold' ? 3 : g.coat === 'hot' ? -3 : 0,
    notes, memo: g.memo || '',
  };
}

// Stops spent outside, where rain and sun matter most.
const OUT_ICONS = ['park', 'torii', 'bridge', 'sunset', 'flower', 'walk', 'lantern', 'tower'];
const isOutdoor = (it) => !it.skip && (OUT_ICONS.includes(glyph(it.icon)[0]) || /공원|해변|시장|산책|신궁|스트리트|교차로|외관|나카미세|상점가|센소지/.test(it.title));

// What to bring today, and what can stay at the hotel, for one person; each with the reason, tied to a stop when it can be.
const NO_BIAS = { u: 0, s: 0, c: 0, notes: [], memo: '' };
function gearFor(date, items, name, bias) {
  const hrs = wxHours(date, 8, 22);
  if (hrs.length < 6) return null;
  const b = bias || gearBias(date, name);
  const outs = items.filter(isOutdoor);
  const outAt = (h) => outs.find((it) => it.startMin < (h.hour + 1) * 60 && it.endMin > h.hour * 60);
  const why = (h, what) => { const it = outAt(h); return it ? `${it.start} ${stripEmoji(it.title).split(' · ')[0]} · ${what}` : `${h.hour}시쯤 ${what}`; };
  const need = [];
  const skip = [];
  const top = hrs.reduce((a, c) => (c.pop > a.pop ? c : a));
  const sp = rainSpan(date);
  const wet = sp?.wet || [];
  const light = !sp || sp.light;
  // The outdoor stop the rain reaches first, with the chance at that hour (not the day's peak).
  const hit = wet.find(outAt);
  const atStop = hit ? ` · ${stripEmoji(outAt(hit).title).split(' · ')[0]} ${outAt(hit).start}쯤 ${hit.pop}%` : '';
  // Drizzle (under 0.5mm an hour) needs a folding umbrella at most, never boots.
  if (sp && !light && sp.n >= 3) need.push({ key: 'umbrella', icon: 'umbrella', label: '튼튼한 우산', why: `${sp.when} 비 최대 ${sp.max}%${atStop}` });
  else if ((sp && (!light || sp.max >= 30 + b.u)) || top.pop >= 30 + b.u) need.push({ key: 'umbrella', icon: 'umbrella', label: '접이식 우산', why: sp ? `${sp.when} ${light ? '약한 비' : '비'} ${sp.max}%${atStop}` : `${top.hour}시쯤 비 ${top.pop}%` });
  else skip.push(['우산', `비 최대 ${top.pop}%`]);
  const uv = Math.max(...hrs.map((h) => h.uv));
  const bright = hrs.filter((h) => h.code <= 1 && h.hour >= 9 && h.hour <= 16);
  if (uv >= 4 + b.s || bright.length >= 4 + (b.s > 0 ? 2 : b.s < 0 ? -1 : 0)) need.push({ key: 'sun', icon: 'wx-sun', label: '선글라스·모자', why: `${bright[0] ? why(bright.find(outAt) || bright[0], '맑음') + ' · ' : ''}자외선 ${uvWord(uv)} (${uv.toFixed(0)})` });
  else skip.push(['선글라스', `자외선 ${uvWord(uv)} (${uv.toFixed(0)})`]);
  const lo = Math.min(...hrs.map((h) => h.feels));
  const hi = Math.max(...hrs.map((h) => h.temp));
  const felt = lo - b.c;
  const cold = hrs.find((h) => h.feels === lo);
  if (felt <= 10) need.push({ key: 'coat', icon: 'coat', label: '따뜻한 겉옷', why: `${cold.hour}시쯤 체감 ${lo}°까지` });
  else if (felt <= 15) need.push({ key: 'coat', icon: 'coat', label: '가벼운 겉옷', why: `${cold.hour}시쯤 체감 ${lo}°까지` });
  else skip.push(['겉옷', `체감 ${lo}° 이상`]);
  if (hi - lo >= 8) need.push({ key: 'layer', icon: 'temp', label: '겹쳐 입기', why: `일교차 ${hi - lo}° · 낮 ${hi}°` });
  const rain = hrs.reduce((a, h) => a + h.rain, 0);
  if (rain >= 5 || (wet.length >= 4 && !light)) need.push({ key: 'shoes', icon: 'walk', label: '젖어도 되는 신발', why: `비 ${rain >= 1 ? `${rain.toFixed(0)}mm` : `${wet.length}시간`} · 걷는 일정` });
  if (bias) return { need, skip };
  // Say what last time's record changed only where it actually changed today's list.
  const base = gearFor(date, items, name, NO_BIAS);
  const pick = (r, k) => r.need.find((n) => n.key === k)?.label || '';
  const notes = b.notes.filter(([k]) => pick({ need }, k) !== pick(base, k)).map(([, t]) => t);
  return { need, skip, bias: { ...b, notes } };
}

const mm = (v) => `${v < 1 ? v.toFixed(1) : Math.round(v)}mm`;

function wxAge() {
  const m = Math.round((Date.now() - state.wx.at) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  return m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}

// The weather card folds to one line (the schedule matters more day to day); the choice is kept on this phone only.
const wxCardOpen = () => { try { return localStorage.getItem('wxCard') === '1'; } catch { return false; } };
// A finished day's weather starts folded whatever the usual choice; opening it is remembered for that day only.
const lsList = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const lsToggle = (k, v) => { const o = lsList(k); try { localStorage.setItem(k, JSON.stringify(o.includes(v) ? o.filter((x) => x !== v) : [...o, v])); } catch { /* private mode */ } };
const wxIsOpen = (date) => (isDayDone(date) ? lsList('wxOpenDone').includes(date) : wxCardOpen());
// Weather card for one day: now (if `now` is that day) or the day overall, advice, hourly strip.
function wxCard(date, now) {
  const day = wxDay(date);
  if (!day) {
    return state.wx ? '' : `<button class="wx wx-empty" data-wx-refresh>${wxIcon('wx-partly')}날씨를 불러오는 중이에요 · 탭해서 다시 시도</button>`;
  }
  const cur = now ? wxHour(date, now.min) : null;
  const strip = wxHours(date, Math.min(cur?.hour ?? 8, 8), Math.max(cur?.hour ?? 22, 22));
  const tips = date < tokyoNow().date ? [] : wxTips(date);
  if (!wxIsOpen(date)) {
    // One line: icon, temperature, sky and rain chance, and the one thing to act on — rain coming up beats a clothing tip.
    const from = cur ? cur.hour : 8;
    const ahead = strip.filter((h) => h.hour >= from);
    const wet = ahead.find((h) => h.pop >= 30);
    const peak = wet ? Math.max(...ahead.filter((h) => h.hour >= wet.hour && h.hour < wet.hour + 4).map((h) => h.pop)) : 0;
    const pill = wet ? `<span class="wx-mini-pill rain">${cur && wet.hour === cur.hour ? '지금' : `${wet.hour}시부터`} 비 ${peak}% · 우산</span>`
      : tips.length ? `<span class="wx-mini-pill">${esc(String(tips[0][1]).split(' · ').pop())}</span>` : '';
    return `
    <button class="wx wx-mini" data-wx-fold="${esc(date)}" aria-expanded="false" aria-label="날씨 자세히 보기">
      <span class="wx-mini-ic">${wxIcon((cur || day).icon)}</span><b>${cur ? cur.temp : day.max}°</b>
      <span class="wx-mini-t">${esc((cur || day).label)} · 비 ${cur ? cur.pop : day.pop}%</span>${pill}<i class="chev"></i>
    </button>`;
  }
  return `
    <div class="wx">
      <div class="wx-head" data-wx-fold="${esc(date)}" role="button" tabindex="0" aria-expanded="true" aria-label="날씨 접기">
        <div class="wx-big">${wxIcon((cur || day).icon)}</div>
        <div class="grow">
          <div class="wx-temp">${cur ? cur.temp : day.max}°<span>${esc((cur || day).label)}${cur ? '' : ' · 낮 최고'}</span></div>
          <div class="wx-sub">최고 ${day.max}° · 최저 ${day.min}° · 비 ${day.pop}%${day.rain >= 1 ? ` · ${day.rain.toFixed(0)}mm` : ''}${cur ? ` · 체감 ${cur.feels}°` : ''}</div>
        </div>
        <button class="wx-refresh" data-wx-refresh aria-label="날씨 새로고침" ${state.wxBusy ? 'aria-busy="true"' : ''}>${icon('refresh', state.wxBusy ? 'spin' : '')}${state.wxBusy ? '받는 중' : wxAge()}</button>
      </div>
      ${chipsHtml(tips)}
      ${strip.length ? `<div class="wx-fold wx-label">${icon('clock')}<span class="grow">시간대별 날씨</span></div>` : ''}
      ${strip.length ? `<div class="wx-strip">${strip.map((h) => `
        <div class="${[h.pop >= 30 ? 'wet' : '', cur && h.hour === cur.hour ? 'now' : '', cur && h.hour < cur.hour ? 'past' : ''].join(' ')}"><small>${cur && h.hour === cur.hour ? '지금' : h.hour + '시'}</small><span>${wxIcon(h.icon)}</span><b>${h.temp}°</b><i>${h.pop >= 10 ? h.pop + '%' : ''}</i>${h.rain >= 0.1 ? `<em>${mm(h.rain)}</em>` : ''}</div>`).join('')}
      </div>` : ''}
    </div>`;
}

// Five-day outlook with packing advice, shown before departure.
function wxTrip() {
  const rows = state.trip.days.map((d) => ({ date: d.date, w: wxDay(d.date) }));
  const known = rows.filter((r) => r.w);
  if (!known.length) {
    if (daysBetween(tokyoNow().date, state.trip.trip.start) > 15) {
      return `<div class="card small muted">출발 16일 전부터 여행 기간 예보가 나와요. 그 전엔 예약 탭의 평년 날씨를 참고하세요.</div>`;
    }
    return `<div class="wx"><div class="wx-foot"><span>여행 기간 예보를 받지 못했어요. 인터넷 연결을 확인하고 다시 받아 보세요.</span><button data-wx-refresh>${icon('refresh')}다시 받기</button></div></div>`;
  }
  const rainy = known.filter((r) => r.w.pop >= 50).length;
  const lo = Math.min(...known.map((r) => r.w.min));
  const hi = Math.max(...known.map((r) => r.w.max));
  const tips = [
    rainy ? ['warn', `비 예보 ${rainy}일 · 우산 챙기기`, 'umbrella'] : ['ok', '큰 비 예보 없음', 'wx-sun'],
    ['', `${lo}° ~ ${hi}° · ${lo <= 10 ? '따뜻한 겉옷' : '가벼운 겉옷'}`, 'coat'],
  ];
  return `
    <div class="wx">
      <div class="wx-days">${rows.map((r) => `
        <div class="${r.w && r.w.pop >= 30 ? 'wet' : ''}">
          <small>${esc(shortDate(r.date))} ${WEEKDAYS[dowOf(r.date)]}</small>
          ${r.w ? `<span>${wxIcon(r.w.icon)}</span><b>${r.w.max}°<em>${r.w.min}°</em></b><i>비 ${r.w.pop}%</i>` : '<span>·</span><i>예보 전</i>'}
        </div>`).join('')}
      </div>
      ${chipsHtml(tips)}
      <div class="wx-foot"><span>예보는 바뀔 수 있어요 · 앱을 열 때마다 새로 받아요</span><button data-wx-refresh>${icon('refresh', state.wxBusy ? 'spin' : '')}${state.wxBusy ? '받는 중' : wxAge()}</button></div>
    </div>`;
}

// ---------- expenses (yen, shown with won) ----------
// 하루 완주 표시(일정 탭 날짜 칸 · 리포트 하루 카드): 금색 별. 세부 일정 완료의 초록 체크와 구분해요.
const STAR5 = '<svg class="star5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3.1-5.4 3.1 1.2-6L3.3 8.8l6.1-.7z"/></svg>';
const EXP_CATS = ['식당', '카페', '편의점', '교통', '쇼핑', '관광', '기타'];
// 분류마다 아이콘 하나: 고르는 칸 왼쪽과 지출 목록 줄에 같은 그림 (DESIGN.md › 경비).
const EXP_ICON = { 식당: 'meal', 카페: 'coffee', 편의점: 'local', 교통: 'train', 쇼핑: 'shop', 관광: 'torii', 기타: 'money' };
const expIcon = (cat) => icon(EXP_ICON[cat] || 'money');
const catPick = (on, attrs = 'name="cat"', selCls = '') => `<span class="cat-pick"><span class="cat-ic">${expIcon(on)}</span><select class="input ${selCls}" ${attrs} aria-label="분류">${EXP_CATS.map((c) => `<option ${c === on ? 'selected' : ''}>${c}</option>`).join('')}</select></span>`;
const SCENE_CAT = { 식당: '식당', 카페: '카페', 교통: '교통', 공항: '교통', 쇼핑: '쇼핑', 관광: '관광', 호텔: '기타' };
const expenses = () => store.get('exp', []);
const yen = (n) => `${Math.round(n).toLocaleString('ko-KR')}엔`;
const won = (n) => `${(Math.round((n * (state.fx?.rate || 8.5)) / 10) * 10).toLocaleString('ko-KR')}원`;
// 여행메이트: 기록의 '누가'는 로그인한 계정 id예요 (로그인 전엔 'me', 로그인하면 계정으로 옮겨요).
// 예전 기록의 '안드레아'·'나'는 여행 마스터로 봐요. 닉네임은 계정에 하나라, 바꾸면 지난 기록도 새 이름으로 보여요.
const LEGACY_ME = ['나', '안드레아'];
// 인원: 서버 여행이면 여행메이트 수, 아니면 일정 파일의 인원
const travelers = () => (CLOUD.trip && CLOUD.members.length ? CLOUD.members.length : state.trip.trip.travelers || 1);
const meId = () => AUTH.user?.id || 'me';
const myNick = () => (AUTH.user ? AUTH.nick || AUTH.user.user_metadata?.name || '여행자' : store.get('myNick', '') || '나');
const callMe = () => `${myNick()}님`;
function mateKey(by) {
  if (!by) return '';
  if (by === 'me') return meId();
  if (LEGACY_ME.includes(by)) return CLOUD.trip?.owner_id || meId();
  if (by === '와이프') return '다희';
  return by;
}
// 이 여행의 사람들 (들어온 순서, 색 점 포함). 서버에 연결되기 전엔 나 혼자.
const MATE_COLORS = ['#2f6fdf', '#e0672b', '#1f9d6b', '#b8489a', '#c9a227', '#6a5acd', '#d2445a', '#2a9bb0'];
const mates = () => (CLOUD.trip && CLOUD.members.length ? CLOUD.members : [{ id: meId(), nick: myNick(), role: 'owner', color: MATE_COLORS[0] }]);
function nameOf(by) {
  const k = mateKey(by);
  if (!k) return '';
  if (k === meId()) return myNick();
  const m = CLOUD.members.find((x) => x.id === k);
  if (m) return m.nick;
  const gone = store.get('mateNames', {})[k];
  if (gone) return `${gone}(나감)`;
  return /^[0-9a-f]{8}-/.test(k) ? '나간 사람' : k;
}

// Live JPY→KRW rate (open.er-api.com, no key), kept for offline; 6-hour refresh, 30 minutes when forced.
// `upd` is when the provider last moved the rate (once a day), `at` when this phone fetched it.
async function loadFx(force = false) {
  if (state.fx && Date.now() - state.fx.at < (force ? 30 * 60 * 1000 : 6 * 3600 * 1000)) return false;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/JPY', { cache: 'no-store' });
    const data = await res.json();
    if (data.result !== 'success') throw new Error(data.result);
    state.fx = { rate: data.rates.KRW, at: Date.now(), upd: data.time_last_update_unix * 1000 };
    store.set('fx', state.fx);
    if (!$('#sheet').hidden && $('.fx')) updateFx();
    else if (state.tab === 'wallet' && $('#sheet').hidden) render();
    return true;
  } catch { return false; /* keep the saved rate */ }
}

// Estimated costs from trip.json, with won at today's rate and the total added up here so they never drift apart.
const span = ([lo, hi], f) => (lo === hi ? f(lo) : `${f(lo).replace(/[^0-9.,]+$/, '')}~${f(hi)}`);
const wan = (n) => `${(Math.round(n / 1000) / 10).toLocaleString('ko-KR')}만원`;
const manwon = (n) => wan(n * fxRate());
const costRows = (g) => g.costs.map((c) => ({ ...c, r: [].concat(c.yen, c.yen).slice(0, 2) }));
const costLocal = (g) => costRows(g).reduce(([a, b], c) => [a + c.r[0], b + c.r[1]], [0, 0]);
function costPane(g) {
  const rows = costRows(g);
  const local = costLocal(g);
  const paid = g.paid.reduce((a, c) => a + c.won, 0);
  const all = local.map((v) => paid + v * fxRate());
  const card = local.map((v) => Math.max(0, v - g.cash.yen));
  const row = (label, r) => `
    <div class="cost-row"><span>${esc(label)}</span><b>${span(r, yen)}</b><small>${span(r, manwon)}</small></div>`;
  return `
    <div class="cost">
      <div class="cost-total">
        <span>총 여행 경비 · 2인, 쇼핑 제외</span>
        <b>${span(all, wan)}</b>
        <div class="cost-bar" aria-hidden="true"><i style="width:${Math.round((paid / all[1]) * 100)}%"></i></div>
      </div>
      <details class="cost-sec paid">
        <summary><i class="dot"></i><span>출발 전 결제 완료</span><b>${wan(paid)}</b><i class="chev"></i></summary>
        ${g.paid.map((c) => `<div class="cost-row tight"><span>${esc(c.label)}</span><b>${c.won.toLocaleString('ko-KR')}원</b></div>`).join('')}
      </details>
      <details class="cost-sec" open>
        <summary><i class="dot"></i><span>현지에서 쓸 비용</span><b>${span(local, yen)}</b><i class="chev"></i></summary>
        ${rows.map((c) => row(c.label, c.r)).join('')}
        <div class="small muted cost-note">${esc(g.costNote)}</div>
      </details>
      <div class="cost-pay">
        <div class="cash"><span>${esc(g.cash.label)}</span><b>${yen(g.cash.yen)}</b><small>${manwon(g.cash.yen)}</small></div>
        <div><span>카드·Suica</span><b>${span(card, yen)}</b><small>${span(card, manwon)}</small></div>
      </div>
      <div class="small muted cost-note">100엔 = ${(fxRate() * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}원 기준 · 예산 ${yen(store.get('budget', state.trip.budget?.yen || 0))}</div>
    </div>`;
}

// ---------- exchange calculator ----------
// Japanese price tags often leave out the 10% consumption tax (税抜), so there is a switch to add it.
const FX_QUICK = { yen: [100, 500, 1000, 3000, 5000, 10000], won: [10000, 30000, 50000, 100000] };
const fxRate = () => state.fx?.rate || 8.5;
const fxWhen = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const FX_SIGN = { yen: '¥', won: '₩' };
const money = (dir, n) => `${FX_SIGN[dir]}${Math.round(n).toLocaleString('ko-KR')}`;

// Amount fields take digits only and group thousands as they are typed; the caret stays after the same digit.
const commas = (v) => String(v).replace(/\D/g, '').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+$)/g, ',');
function formatAmount(field) {
  const digits = field.value.slice(0, field.selectionStart).replace(/\D/g, '').length;
  field.value = commas(field.value);
  let at = 0;
  for (let seen = 0; seen < digits && at < field.value.length; at += 1) if (/\d/.test(field.value[at])) seen += 1;
  field.setSelectionRange(at, at);
}

function fxCalc() {
  const f = state.fxCalc;
  const n = Number(String(f.value).replace(/[^0-9.]/g, '')) || 0;
  const base = f.dir === 'yen' && f.tax ? n * 1.1 : n;
  const out = f.dir === 'yen' ? base * fxRate() : n / fxRate();
  return { n, base, out };
}
function updateFx() {
  const f = state.fxCalc;
  const { n, base, out } = fxCalc();
  const to = f.dir === 'yen' ? 'won' : 'yen';
  $('#fx-out').textContent = money(to, n ? out : 0);
  $('#fx-sub').textContent = f.dir === 'yen' && f.tax && n ? `세금 포함 ${money('yen', base)}` : '';
  $('#fx-rate').textContent = state.fx
    ? `¥100 = ₩${(fxRate() * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} · ${fxWhen(state.fx.upd || state.fx.at)} 고시`
    : '환율을 아직 못 받았어요 · ¥100 = ₩850으로 계산';
  $('.fx-clear').hidden = !f.value;
}
function openFx() {
  state.fxCalc ||= { dir: 'yen', value: '', tax: false };
  const f = state.fxCalc;
  const from = FX_SIGN[f.dir];
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><span class="ii lg yen">¥</span><h3>환율 계산기</h3></div>
    <div class="fx">
      <div class="talk-dir"><b>${f.dir === 'yen' ? '일본 엔 (¥)' : '한국 원 (₩)'}</b>
        <button class="icon-btn" data-fx-swap aria-label="방향 바꾸기">${icon('swap')}</button>
        <b>${f.dir === 'yen' ? '한국 원 (₩)' : '일본 엔 (¥)'}</b></div>
      <div class="fx-field">
        <input id="fx-in" class="fx-in amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(commas(f.value))}">
        <span class="fx-unit">${from}</span>
        <button class="talk-clear fx-clear" data-fx-clear>지우기</button>
      </div>
      <div class="fx-res"><b id="fx-out">0</b><small id="fx-sub"></small></div>
      <div class="fx-quick">${FX_QUICK[f.dir].map((v) => `<button data-fx-set="${v}">+${money(f.dir, v)}</button>`).join('')}</div>
      ${f.dir === 'yen' ? `<label class="fx-tax"><input type="checkbox" id="fx-tax" ${f.tax ? 'checked' : ''}> 세금 별도 가격 (税抜) · +10%</label>` : ''}
    </div>
    <div class="small muted fx-meta"><span id="fx-rate"></span>
      <button class="link" data-fx-refresh>새로 받기</button></div>
    <div class="small muted fx-note">기준 환율이에요. 카드·환전소 실제 금액은 1~2% 더 나올 수 있어요.</div>
    <div class="btns"><button class="btn primary wide" data-fx-log>${icon('plus')}이 금액 지출로 기록</button></div>`;
  $('#sheet').hidden = false;
  updateFx();
  $('#fx-in').focus();
  $('#fx-in').select();
  loadFx(true);
}

// amount is always yen so totals add up; a won entry keeps what was typed in orig.
const expAmount = (value, cur) => (cur === 'KRW' ? { amount: Math.round(value / fxRate()), orig: { cur, value } } : { amount: value, orig: null });
function addExpense({ value, cur, pay, memo, cat, item, date, time = '' }) {
  const list = expenses();
  localStorage.setItem('lastPay', pay);
  const id = uid('e-');
  list.push({ id, ...expAmount(value, cur), pay, memo, cat, item: item || null, date: date || tokyoNow().date, time: time || '', by: meId(), at: Date.now() });
  store.set('exp', list);
  return id;
}
// Receipt photos sit with the voucher photos under the expense's own slot, so they sync and stay off GitHub.
const rcptSlot = (id) => 'rcpt-' + id;
const hasRcpt = (id) => state.docSlots.has(rcptSlot(id));
const payOf = () => { try { return localStorage.getItem('lastPay') || 'card'; } catch { return 'card'; } };
const expPick = (cur = 'JPY', pay = payOf()) => `
  <select class="input" name="cur" aria-label="통화"><option value="JPY" ${cur === 'JPY' ? 'selected' : ''}>엔</option><option value="KRW" ${cur === 'KRW' ? 'selected' : ''}>원</option></select>
  <select class="input" name="pay" aria-label="결제 수단"><option value="card" ${pay === 'card' ? 'selected' : ''}>카드</option><option value="cash" ${pay === 'cash' ? 'selected' : ''}>현금</option></select>`;
// An expense goes on a trip day or before leaving (booked at home); before the trip it shows as "출발 전".
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const expDateLabel = (date) => (date < state.trip.trip.start ? '출발 전' : shortDate(date));
function expDatePick(date, cls = '') {
  const { days, trip } = state.trip;
  const today = tokyoNow().date;
  const pre = date && date < trip.start ? date : today < trip.start ? today : addDays(trip.start, -1);
  const on = date || (today < trip.start ? pre : days.some((d) => d.date === today) ? today : days[days.length - 1].date);
  return `<select class="input ${cls}" name="date" aria-label="날짜">
    <option value="${pre}" ${on === pre ? 'selected' : ''}>출발 전</option>
    ${days.map((d, i) => `<option value="${d.date}" ${on === d.date ? 'selected' : ''}>${i + 1}일차 ${shortDate(d.date)}</option>`).join('')}
  </select>`;
}
const expValue = (form) => Number(String(new FormData(form).get('amount') || '').replace(/[^0-9]/g, ''));
const cashTotal = () => store.get('cashYen', state.trip.guides.find((g) => g.costs)?.cash?.yen || 0);
const cashSpent = () => expenses().filter((e) => e.pay === 'cash' && e.orig?.cur !== 'KRW').reduce((a, e) => a + e.amount, 0);
// A time field that may be left empty: phones draw an empty time box as a blank, so it says what goes there.
const timePick = (name, value, label) => `<label class="tpick ${value ? '' : 'no-time'}"><input class="input" type="time" name="${name}" value="${esc(value)}" aria-label="${esc(label)}"><span class="tph">${icon('clock')}${esc(label)} (선택)</span></label>`;
function openExpEdit(id) {
  const e = expenses().find((x) => x.id === id);
  if (!e) return;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>지출 수정</h3></div>
    <form class="exp-edit exp-form" data-id="${esc(id)}">
      <input class="input exp-wide" name="memo" placeholder="제목 (예: 이치란 라멘)" value="${esc(expTitle(e) === e.cat && !e.memo ? '' : expTitle(e))}" autocomplete="off" aria-label="제목">
      ${expDatePick(e.date)}
      ${timePick('time', expTime(e), '결제 시간')}
      <input class="input amount" name="amount" inputmode="numeric" value="${commas(e.orig?.value || e.amount)}" autocomplete="off" required aria-label="금액">
      ${catPick(e.cat)}
      ${expPick(e.orig?.cur || 'JPY', e.pay || 'card')}
      ${hasRcpt(id) ? `<button class="btn" type="button" data-doc-add="${rcptSlot(id)}">${icon('camera')}영수증 더 넣기</button>
      <button class="btn" type="button" data-doc-view="${rcptSlot(id)}">${icon('image')}영수증 보기</button>` : `<button class="btn exp-wide" type="button" data-doc-add="${rcptSlot(id)}">${icon('camera')}영수증 사진 넣기</button>`}
      <div class="btns exp-wide exp-act">
        <button class="btn danger" type="button" data-exp-del="${esc(id)}">${icon('trash')}삭제</button>
        <button class="btn primary" type="submit">${icon('check')}저장</button>
      </div>
    </form>`;
  $('#sheet').hidden = false;
}
// Paid-at time has its own field; older card entries kept it at the end of the memo ('GINZASIX · 12:06').
const expTime = (e) => e.time || /\s·\s(\d{1,2}:\d{2})$/.exec(e.memo || '')?.[1] || '';
const expTitle = (e) => (e.time ? e.memo : String(e.memo || '').replace(/\s·\s\d{1,2}:\d{2}$/, '')) || e.cat;
function expRow(e, inDay = false) {
  return `
    <div class="exp-row">
      <span class="exp-cat" role="img" aria-label="${esc(e.cat)}" title="${esc(e.cat)}">${expIcon(e.cat)}</span>
      <button type="button" class="exp-open" data-exp-edit="${esc(e.id)}">
        <span class="grow"><b>${esc(expTitle(e))}</b><small>${esc([inDay ? expTime(e) : `${expDateLabel(e.date)}${expTime(e) ? ' ' + expTime(e) : ''}`, nameOf(e.by), e.pay ? { cash: '현금', card: '카드' }[e.pay] : ''].filter(Boolean).join(' · '))}</small></span>
        <span class="exp-amt">${e.orig?.cur === 'KRW' ? `<b>${e.orig.value.toLocaleString('ko-KR')}원</b><small>${yen(e.amount)}</small>` : `<b>${yen(e.amount)}</b><small>${won(e.amount)}</small>`}</span>
      </button>
      ${hasRcpt(e.id) ? `<button type="button" class="exp-rcpt" data-doc-view="${rcptSlot(e.id)}" aria-label="영수증 보기">${icon('image')}</button>` : ''}
    </div>`;
}
const expForm = (item = null, memo = '', cat = '식당') => `
  <form class="exp-form" data-exp-item="${esc(item || '')}">
    <input class="input amount" name="amount" inputmode="numeric" placeholder="금액" autocomplete="off" required>
    ${expPick()}
    ${catPick(cat)}
    ${item ? '' : expDatePick()}
    <input class="input" name="memo" placeholder="메모" value="${esc(memo)}" autocomplete="off">
    ${item ? '' : `<button class="btn" type="button" data-exp-rcpt>${icon('camera')}영수증 등록</button>`}
    <button class="btn primary" type="submit">${icon('plus')}기록</button>
  </form>`;

// ---------- card SMS → expenses (read on the phone only; card number and name are never kept) ----------
// Shop names in card messages are short Latin words; these pick a category, else the stop on the schedule at that time does.
const SMS_CAT = [
  [/FAMILY ?MART|LAWSON|SEVEN|7-?ELEVEN|MINISTOP|NEWDAYS|ファミリーマート|ローソン|セブン|세븐일레븐|GS25|\bCU\b|이마트24|편의점/i, '편의점'],
  [/\bJR\b|METRO|SUICA|PASMO|KEISEI|SKYLINER|TAXI|RAILWAY|YURIKAMOME|メトロ|鉄道|タクシー/i, '교통'],
  [/STARBUCKS|COFFEE|CAFE|CAFFE|DOUTOR|TULLY|BLUE ?BOTTLE|MAMEYA|喫茶|珈琲|カフェ/i, '카페'],
  [/RAMEN|SUSHI|UDON|SOBA|TONKATSU|MAISEN|YAKINIKU|IZAKAYA|RESTAURANT|DINING|KITCHEN|GRILL|BURGER|MCDONALD|ICHIRAN|食堂|ラーメン|寿司/i, '식당'],
  [/TEAMLAB|SHIBUYA ?SKY|MUSEUM|TICKET|SKYTREE/i, '관광'],
  [/DON ?QUIJOTE|DONKI|UNIQLO|BEAMS|GINZA.*SIX|PARCO|LOFT|MUJI|BIC ?CAMERA|YODOBASHI|MITSUKOSHI|ISETAN|MATSUYA|DAIMARU|TAKASHIMAYA|STORE|SHOP|MALL|ドン・キホーテ/i, '쇼핑'],
];
// One approval per "MM/DD HH:MM shop" line; the amount is the last one written before it.
// Works for 삼성 해외승인 (JPY 2,860 / 11/04 12:06 GINZASIX) and the usual 국내 form (12,300원 … 11/04 14:23 가맹점).
function parseSms(text) {
  const t = String(text || '').replace(/\r/g, '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const year = state.trip.trip.start.slice(0, 4);
  const re = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})[ \t]+([^\n]+)/g;
  const rows = [];
  let m;
  let last = 0;
  while ((m = re.exec(t))) {
    const seg = t.slice(last, m.index);
    last = re.lastIndex;
    const a = [...seg.matchAll(/(JPY|KRW|USD|EUR|円|엔)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(원|円|엔)/g)].pop();
    if (!a) continue;
    const unit = a[1] || a[4];
    const cur = /KRW|원/.test(unit) ? 'KRW' : /JPY|円|엔/.test(unit) ? 'JPY' : unit;
    const value = Number((a[2] || a[3]).replace(/,/g, ''));
    const date = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const time = `${m[3].padStart(2, '0')}:${m[4]}`;
    const shop = m[5].replace(/\s*(누적|잔액|일시불|할부|체크).*$/, '').trim() || '카드 결제';
    rows.push(payRow({ date, time, shop, cur, value, cancel: /취소/.test(seg) }));
  }
  return rows;
}
// One payment as a row to check: category from the shop name or the stop at that time, the stop link, and a duplicate check.
function payRow({ date, time, shop, cur, value, cancel = false }) {
  {
    const min = time ? toMin(time) : -1;
    const day = state.trip.days.find((d) => d.date === date);
    const byName = (SMS_CAT.find(([r]) => r.test(shop)) || [])[1];
    // Tie it to the stop at that time only where money is spent (meal, café, shop, sight) and the shop fits that stop.
    const near = day && min >= 0 && dayItems(day).find((it) => !it.skip && !isMove(it) && it.startMin - 10 <= min && min <= (it.endMin || it.startMin + 60) + 15);
    const nearCat = near && SCENE_CAT[sceneOf(near)];
    const item = near && ['식당', '카페', '쇼핑', '관광'].includes(nearCat) && (!byName || byName === nearCat) ? near : null;
    const cat = byName || (item && nearCat) || '기타';
    const dup = expenses().some((e) => e.date === date && (cur === 'KRW' ? e.orig?.value === value : !e.orig && Math.round(e.amount) === value));
    return { date, time, shop, cur, value, cat, item: item?.id || null, itemTitle: item ? stripEmoji(item.title).split(' · ')[0] : '', dup, cancel, ok: (cur === 'JPY' || cur === 'KRW') && value > 0 };
  }
}
function openSmsSheet() {
  $('#sheet-body').innerHTML = `
    <div class="sheet-head has-back"><div class="eyebrow dark">경비</div><h3 class="sms-h">카드 문자로 지출 등록</h3></div>
    <p class="small muted sms-help">카드 승인 문자를 길게 눌러 복사하거나, 카드 앱 화면을 캡처한 사진에서 글자를 길게 눌러 복사해 붙여 넣으세요. 여러 건을 한 번에 넣어도 돼요. 카드 번호와 이름은 저장하지 않아요.</p>
    <textarea class="input sms-box" id="sms-text" placeholder="[Web발신]&#10;삼성1234해외승인 김*철&#10;JPY 2,860&#10;11/04 12:06 GINZASIX"></textarea>
    <div class="btns"><button class="btn" data-sms-paste>${icon('copy')}붙여넣기</button><button class="btn primary" data-sms-read>읽기</button>
      ${aiKey() ? `<button class="btn ai wide" data-sms-photo>${aiLabel('카드 앱 캡처 사진으로 읽기')}</button>` : ''}</div>
    <div id="sms-out"></div>`;
  $('#sheet').hidden = false;
}
function showSms(rows = parseSms($('#sms-text').value)) {
  state.sms = rows;
  if (!rows.length) { $('#sms-out').innerHTML = '<div class="small muted sms-none">찾은 결제가 없어요. 금액과 "11/04 12:06 가게" 같은 날짜·시간 줄이 함께 들어 있는지 확인해 주세요.</div>'; return; }
  const on = (r) => r.ok && !r.dup && !r.cancel;
  $('#sms-out').innerHTML = `
    <div class="sms-list">${rows.map((r, i) => `
      <div class="sms-row ${on(r) ? '' : 'off'}">
        <label class="sms-pick"><input type="checkbox" data-sms-i="${i}" ${on(r) ? 'checked' : ''} ${r.ok ? '' : 'disabled'}>
          <span class="grow"><b>${esc(r.shop)}</b><small>${esc(expDateLabel(r.date))} ${esc(r.time)}${r.itemTitle ? ` · ${esc(r.itemTitle)} 일정` : ''}</small>
            ${r.dup ? '<em>같은 날 같은 금액이 이미 있어요</em>' : r.cancel ? '<em>취소 문자예요</em>' : r.ok ? '' : `<em>${esc(r.cur)}는 엔·원으로 바꿔 직접 입력해 주세요</em>`}</span>
          <span class="sms-amt">${r.cur === 'KRW' ? `${r.value.toLocaleString('ko-KR')}원` : r.cur === 'JPY' ? yen(r.value) : `${esc(r.cur)} ${r.value}`}</span></label>
        ${catPick(r.cat, `data-sms-cat="${i}"`, 'sms-cat')}
      </div>`).join('')}</div>
    <button class="btn primary wide sms-add" data-sms-add>${icon('plus')}고른 결제 등록</button>`;
}
function addSms() {
  let n = 0;
  (state.sms || []).forEach((r, i) => {
    if (!r.ok || !$(`[data-sms-i="${i}"]`)?.checked) return;
    addExpense({ value: r.value, cur: r.cur, pay: 'card', memo: r.shop, time: r.time || '', cat: $(`[data-sms-cat="${i}"]`)?.value || r.cat, item: r.item, date: r.date || '' });
    n++;
  });
  if (!n) return toast('등록할 결제를 골라 주세요');
  state.sms = null;
  state.expView = 'spent';
  closeSheet();
  render();
  toast(`카드 결제 ${n}건을 등록했어요`);
}

// Spending grouped by day, newest day first: each day folds to one line with its count and total.
// Today (or the latest day) starts open; what you open or close stays that way until the app reloads.
function expDays(list) {
  const { days, start } = { days: state.trip.days, start: state.trip.trip.start };
  const today = tokyoNow().date;
  const groups = [];
  for (const e of list) {
    const key = e.date < start ? 'pre' : e.date;
    const g = groups.find((x) => x.key === key) || (groups.push({ key, rows: [] }), groups[groups.length - 1]);
    g.rows.push(e);
  }
  const first = (groups.find((g) => g.key === today) || groups[0]).key;
  state.expOpen ||= {};
  return `<div class="exp-days">${groups.map((g) => {
    const i = days.findIndex((d) => d.date === g.key);
    const sum = g.rows.reduce((a, e) => a + e.amount, 0);
    const open = g.key in state.expOpen ? state.expOpen[g.key] : g.key === first;
    const cats = Object.entries(g.rows.reduce((m, e) => ({ ...m, [e.cat]: (m[e.cat] || 0) + e.amount }), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c).join('·');
    return `
      <details class="exp-day" data-exp-day="${esc(g.key)}" ${open ? 'open' : ''}>
        <summary>
          <span class="ed-d">${g.key === 'pre' ? '<b>출발 전</b>' : `<b>${i + 1}일차</b><small>${esc(dayLabel(g.key))}${g.key === today ? ' · 오늘' : ''}</small>`}</span>
          <span class="grow ed-m">${g.rows.length}건 · ${esc(cats)}</span>
          <span class="ed-sum"><b>${yen(sum)}</b><small>${won(sum)}</small></span>
          <i class="chev"></i>
        </summary>
        <div class="exp-list">${g.rows.map((e) => expRow(e, true)).join('')}</div>
      </details>`;
  }).join('')}</div>`;
}

function expenseSection() {
  const list = expenses().sort((a, b) => (a.date !== b.date ? b.date.localeCompare(a.date) : expTime(a) !== expTime(b) ? expTime(b).localeCompare(expTime(a)) : b.id.localeCompare(a.id)));
  const total = list.reduce((a, e) => a + e.amount, 0);
  const shop = list.filter((e) => e.cat === '쇼핑').reduce((a, e) => a + e.amount, 0);
  const budget = store.get('budget', state.trip.budget?.yen || 0);
  const used = total - shop;
  const pct = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const rate = state.fx ? `100엔 = ${Math.round(state.fx.rate * 100).toLocaleString('ko-KR')}원` : '엔 ↔ 원';
  const guide = state.trip.guides.find((g) => g.costs);
  // Costs matter most before leaving, the spending log once the trip starts.
  const view = state.expView || (tokyoNow().date < state.trip.trip.start ? 'cost' : 'spent');
  return `
    <div class="section-title" id="exp"><span>경비</span><button class="fx-pill" data-fx aria-label="환율 계산기 열기"><i>¥</i><span class="fx-pill-t">${esc(rate)}</span><i class="chev"></i></button></div>
    <div class="card exp">
      <div class="exp-tabs" role="tablist">
        <button class="seg ${view === 'spent' ? 'on' : ''}" data-exp-view="spent" role="tab" aria-selected="${view === 'spent'}">내 지출</button>
        <button class="seg ${view === 'cost' ? 'on' : ''}" data-exp-view="cost" role="tab" aria-selected="${view === 'cost'}">여행 비용</button>
      </div>
      ${view === 'cost' ? costPane(guide) : `
      <div class="exp-total"><b>${yen(total)}</b><span>${won(total)}${shop ? ` · 쇼핑 ${yen(shop)}` : ''}</span></div>
      ${budget ? `
        <div class="meter"><i style="width:${pct}%"></i></div>
        <div class="small muted exp-budget">예산 ${yen(budget)} (약 ${manwon(budget)}) 중 ${pct}% 사용 (쇼핑 제외) · 남은 돈 ${yen(Math.max(0, budget - used))}
          <button class="link" data-budget>예산 바꾸기</button></div>` : ''}
      <div class="small muted exp-budget">현지 예상 ${span(costLocal(guide), yen)} 중 ${yen(used)} 사용</div>
      <div class="cash-left"><span>엔화 현금 남음</span><b>${yen(Math.max(0, cashTotal() - cashSpent()))}</b><small>환전 ${yen(cashTotal())} 중 ${yen(cashSpent())} 사용</small><button class="link" data-cash>환전액 바꾸기</button></div>
      ${expForm()}
      <div class="btns exp-quick">
        <button class="btn" data-sms-open>${icon('copy')}카드 문자로</button>
        <button class="btn ai" data-rcpt-ai>${aiLabel('영수증 사진으로')}</button>
      </div>
      ${list.length ? expDays(list) : '<div class="small muted exp-empty">아직 기록이 없어요. 일정을 눌러서도 기록할 수 있어요.</div>'}`}
    </div>`;
}

// ---------- to-dos with a due date ----------
function dueLabel(c, today) {
  if (!c.due) return '';
  const n = daysBetween(today, c.due);
  return n < 0 ? '지남' : n === 0 ? '오늘' : n === 1 ? '내일' : shortDate(c.due);
}
// Open items due by tomorrow, soonest first. Before the trip overdue ones and open bookings count too;
// during the trip only today and tomorrow, so prep leftovers don't push the schedule down.
function todoNow(today) {
  const before = today < state.trip.trip.start;
  return checklist()
    .filter((c) => {
      if (isChecked(c.id)) return false;
      if (!c.due) return before && c.group === '예약';
      const n = daysBetween(today, c.due);
      return n <= 1 && (before || n >= 0);
    })
    .sort((a, b) => (a.due || '0').localeCompare(b.due || '0'));
}
function todoCard(today, title, limit) {
  const list = todoNow(today);
  if (!list.length) return '';
  const more = list.length - limit;
  return `
    <div class="section-title"><span>${title}</span><em>${list.length}</em></div>
    <div class="card list todo">${list.slice(0, limit).map((c) => checkRow(c, today)).join('')}
      ${more > 0 ? `<button class="todo-more" data-go="check">나머지 ${more}개는 체크리스트에서</button>` : ''}</div>`;
}

// ---------- couple sync (one file with records and photos, sent by AirDrop or KakaoTalk) ----------
const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const b64ToBlob = async (b64, type) => (await fetch(`data:${type};base64,${b64}`)).blob();

const MERGED_LISTS = ['custom', 'cdocs', 'exp', 'myitems', 'myplaces'];

async function buildSyncFile() {
  const meta = store.get('meta', {});
  const kv = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Values saved before change times existed still have to reach the other phone.
    if (isShared(k)) kv[k] = { v: store.get(k), t: meta[k] || 1 };
  }
  const photos = [];
  for (const k of await docs.keys()) {
    const blob = await docs.get(k);
    photos.push({ k, type: blob.type || 'image/jpeg', data: await blobToB64(blob) });
  }
  const body = JSON.stringify({ app: 'tokyo-trip', v: 1, from: myNick(), at: Date.now(), kv, tomb: store.get('tomb', {}), photos });
  const d = new Date();
  const name = `여행백업-${(state.trip.trip.title || '여행').replace(/[\\/:*?"<>|\s]+/g, '')}-${d.getMonth() + 1}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
  state.syncFile = new File([body], name, { type: 'application/json' });
  state.syncPhotos = photos.length;
}

// The file is made ahead of time so one tap can open the share sheet (iPhone needs it straight from the tap).
async function prepareSync() {
  if (state.syncBuilding) return;
  state.syncBuilding = true;
  state.syncFailed = false;
  try { await buildSyncFile(); } catch { state.syncFailed = true; }
  state.syncBuilding = false;
  render();
}

// Share must run straight from a tap on iPhone, so the file is built first and shared on a second tap.
async function shareSyncFile() {
  const file = state.syncFile;
  if (!file) return;
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: '여행 백업' });
    else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    store.set('syncSent', Date.now());
  } catch (e) { if (e.name !== 'AbortError') toast('파일을 보내지 못했어요. 다시 눌러 주세요.'); }
  render();
}

// Merge the other phone's file: newer value wins per record, lists and photos are combined, deletions are kept.
async function importSync(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('백업 파일을 읽지 못했어요.'); }
  if (data?.app !== 'tokyo-trip') return toast('이 앱의 백업 파일이 아니에요.');
  const tomb = { ...store.get('tomb', {}) };
  for (const [id, t] of Object.entries(data.tomb || {})) tomb[id] = Math.max(tomb[id] || 0, t);
  localStorage.setItem('tomb', JSON.stringify(tomb));
  const meta = store.get('meta', {});
  let records = 0;
  for (const [k, { v, t }] of Object.entries(data.kv || {})) {
    if (!isShared(k)) continue;
    if (MERGED_LISTS.includes(k)) {
      const mine = store.get(k, []);
      const ids = new Set(mine.map((x) => x.id));
      const extra = (v || []).filter((x) => !ids.has(x.id));
      const theirs = new Map((v || []).map((x) => [x.id, x]));
      const updated = mine.map((x) => ((theirs.get(x.id)?.at || 0) > (x.at || 0) ? theirs.get(x.id) : x));
      const edits = updated.filter((x, i) => x !== mine[i]).length;
      records += edits;
      const merged = [...updated, ...extra].filter((x) => !tomb[`${k}:${x.id}`]);
      if (extra.length || edits || merged.length !== mine.length) { store.set(k, merged, Math.max(t, meta[k] || 0)); records += extra.length; }
    } else if (t > (meta[k] || 0) || (isTyped(k) && v && !store.get(k, ''))) { store.set(k, v, Math.max(t, 1)); records += 1; }
  }
  for (const k of MERGED_LISTS) {
    const list = store.get(k, []);
    const kept = list.filter((x) => !tomb[`${k}:${x.id}`]);
    if (kept.length !== list.length) store.set(k, kept);
  }
  const have = new Set(await docs.keys());
  let photos = 0;
  for (const k of have) if (tomb['doc:' + k]) await docs.run('readwrite', (st) => st.delete(k));
  for (const ph of data.photos || []) {
    if (have.has(ph.k) || tomb['doc:' + ph.k]) continue;
    await docs.put(ph.k, await b64ToBlob(ph.data, ph.type));
    photos += 1;
  }
  // Single-photo slots keep only the newest picture.
  for (const slot of allDocs().filter((x) => (x.max || 1) === 1)) {
    const keys = await docs.of(slot.id);
    for (const k of keys.slice(0, -1)) await docs.del(k);
  }
  await refreshDocSlots();
  render();
  toast(records || photos ? `백업에서 기록 ${records}건 · 사진 ${photos}장을 되살렸어요` : '지금 기록과 같아서 바꿀 게 없어요');
}

// 설정 › 앱 정보 › 백업: 서버가 평소엔 다 맞춰 주니, 만일을 위한 비상용 파일만 (예전 파일 동기화와 같은 형식)
function backupPanel() {
  const f = state.syncFile;
  const sent = store.get('syncSent', 0);
  const when = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `
    <div class="card set-card backup-card">
      <div class="set-row"><span class="grow"><b>백업</b><small>이 여행의 일정 변경·경비·예약번호·사진을 파일 하나로 저장해 둬요. 평소엔 필요 없고, 기록이 사라졌을 때 되살리는 비상용이에요</small></span></div>
      <div class="btns">
        ${state.syncBuilding ? '<button class="btn" disabled>만드는 중…</button>'
          : f ? `<button class="btn primary" data-sync-share>${icon('ext')}백업 파일 저장</button>`
          : `<button class="btn" data-sync-build>${icon('lock')}백업 파일 만들기</button>`}
        <button class="btn" data-sync-pick>${icon('clip')}백업에서 되살리기</button>
      </div>
      ${f ? `<div class="small muted sync-size">사진 ${state.syncPhotos}장 포함 · ${f.size < 1048576 ? Math.max(1, Math.round(f.size / 1024)) + 'KB' : (f.size / 1048576).toFixed(1) + 'MB'} · 공유 창에서 '파일에 저장'을 골라 주세요</div>` : ''}
      ${state.syncFailed ? '<div class="small muted set-note">백업 파일을 만들지 못했어요. 다시 눌러 주세요.</div>' : ''}
      <div class="small muted set-note">예약번호와 사진이 들어 있으니 대화방이 아닌 파일 앱·iCloud에 보관해 주세요. 되살리면 지금 기록과 합쳐지고(나중에 바꾼 쪽이 남아요) 여행메이트에게도 바로 맞춰져요.${sent ? `<br>마지막 백업 ${when(sent)}` : ''}</div>
    </div>`;
}

// ---------- phrases for a schedule item ----------
// Which phrase group fits an item: by its icon, with title words for airport and hotel stops.
const SCENES = {
  meal: '식당', breakfast: '식당', sushi: '식당', ramen: '식당', lantern: '식당', coffee: '카페',
  shop: '쇼핑', fashion: '쇼핑', watch: '쇼핑', bed: '호텔', luggage: '호텔',
  plane: '공항', baggage: '공항', id: '공항',
  walk: '교통', train: '교통', local: '교통', metro: '교통', tram: '교통', station: '교통', bus: '교통',
};
function sceneOf(it) {
  if (!it?.place || it.place.lang === 'ko') return null;
  if (/공항|나리타|수하물|출발 →/.test(it.title)) return '공항';
  if (/coffee|커피|카페|스타벅스/i.test(it.title)) return '카페';
  if (/체크인|체크아웃|짐/.test(it.title)) return '호텔';
  return SCENES[glyph(it.icon)[0]] || '관광';
}
const phrasesFor = (scene) => state.trip.phrases.map((p, i) => ({ ...p, i })).filter((p) => p.group === scene);

// A stop's phrases in the order the visit goes: walking in, ordering, paying.
const phraseStep = {};
const CAM_LABEL = { 식당: '메뉴판 번역', 카페: '메뉴판 번역', 쇼핑: '라벨 번역', 교통: '표지판 번역', 공항: '표지판 번역', 호텔: '안내문 번역', 관광: '안내문 번역' };
const transTools = (label) => `
  <button class="tool" data-trans-app="camera">${icon('camera')}${label}</button>
  <button class="tool" data-trans-app="live">${icon('mic')}대화 번역</button>`;
// Folded at first so the place's own buttons come first; opening it stays open while this popup is up.
const talkOpen = new Set();
function talkCard(scene, id) {
  const open = talkOpen.has(id);
  const steps = state.trip.phraseSteps?.[scene];
  const on = phraseStep[scene] || 0;
  const all = phrasesFor(scene);
  const everyPhrase = state.trip.phrases.map((p, i) => ({ ...p, i }));
  const rows = steps ? steps[on][1].map((ja) => everyPhrase.find((p) => p.ja === ja)) : all;
  return `
    <div class="talk-card ${open ? 'open' : ''}" data-scene="${esc(scene)}" data-id="${esc(id)}">
      <button type="button" class="talk-card-head" data-talk-fold="${esc(id)}" aria-expanded="${open}">${icon('talk')}<b>여기서 쓸 일본어</b><span>${open ? '탭하면 크게' : `${rows.length}문장`}</span><i class="chev"></i></button>
      ${open ? `<div class="talk-body">
      ${steps ? `<div class="talk-steps">${steps.map(([label], i) => `<button class="${i === on ? 'on' : ''}" data-phrase-step="${i}">${esc(label)}</button>`).join('')}</div>` : ''}
      ${rows.map(phraseRow).join('')}
      <div class="talk-more">여기 없는 말은?</div>
      <div class="sheet-tools">
        ${transTools(CAM_LABEL[scene])}
        <button class="tool" data-talk-sheet="${esc(id)}">${icon('pen')}입력</button>
      </div>
      </div>` : ''}
    </div>`;
}

function phraseRow(p) {
  return `
    <div class="phrase">
      <button class="phrase-main" data-phrase="${p.i}">
        <span class="phrase-ko">${esc(p.ko)}</span>
        <span class="phrase-ja ja">${esc(p.ja)}</span>
        <span class="phrase-read">${esc(p.read)}</span>
      </button>
      <button class="icon-btn" data-speak="${p.i}" aria-label="발음 듣기">${icon('sound')}</button>
    </div>`;
}

// ---------- external apps ----------
// Try the native app's URL scheme; if the page is still visible afterwards, offer the web version.
function openApp(appUrl, webUrl, name) {
  let left = false;
  const onHide = () => { left = true; };
  document.addEventListener('visibilitychange', onHide, { once: true });
  window.addEventListener('pagehide', onHide, { once: true });
  location.href = appUrl;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left && !document.hidden) toast(`${name} 앱이 열리지 않았나요?`, webUrl, '웹으로 열기');
  }, 1600);
}

function placeQuery(key) {
  if (key === '__stay') return state.trip.stay.address || state.trip.stay.query;
  const place = findItem(key)?.place;
  return place ? place.query || place.nameJa : null;
}

// Google Maps transit directions from the current location.
function navigate(key) {
  const q = placeQuery(key);
  if (!q) return;
  const e = encodeURIComponent(q);
  if (findItem(key)?.place?.lang === 'ko') {
    return openApp(`nmap://search?query=${e}&appname=io.github.woo72da.tokyotrip`, `https://map.naver.com/p/search/${e}`, '네이버지도');
  }
  const mode = /^도보/.test(stripEmoji(findItem(key)?.title || '')) ? 'walking' : 'transit';
  openApp(
    `comgooglemaps://?daddr=${e}&directionsmode=${mode}`,
    `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=${mode}`,
    '구글맵',
  );
}
const navBtn = (key, label = '길찾기', cls = 'primary') =>
  `<button class="btn ${cls}" data-nav="${esc(key)}">${icon('nav')}${esc(label)}</button>`;

const LANG = { 'ko-ja': ['ko', 'ja'], 'ja-ko': ['ja', 'ko'] };
// Google publishes no link into the live mode itself, so this opens the app with the languages set.
function openLive() {
  const [sl, tl] = LANG[state.talkDir];
  const web = `https://translate.google.com/?sl=${sl}&tl=${tl}&op=translate`;
  if (/Android/i.test(navigator.userAgent)) {
    location.href = `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.google.android.apps.translate;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  } else openApp(`googletranslate://?sl=${sl}&tl=${tl}`, web, 'Google 번역');
}
function translate(engine, text) {
  const [sl, tl] = LANG[state.talkDir];
  const t = encodeURIComponent(text);
  if (engine === 'google') {
    openApp(
      `googletranslate://?sl=${sl}&tl=${tl}&text=${t}`,
      `https://translate.google.com/?sl=${sl}&tl=${tl}&text=${t}&op=translate`,
      'Google 번역',
    );
  } else {
    // Papago has no app link that takes text (papago:// is rejected on iPhone), so open the website.
    window.open(`https://papago.naver.com/?sk=${sl}&tk=${tl}&st=${t}`, '_blank', 'noopener');
  }
}

// Japanese audio: recorded clips (tools/make_audio.py) play through <audio>, which the iPhone
// silent switch doesn't mute; the browser speech engine is the backup for text without a clip.
// Clips are loaded into memory ahead of time so play() runs inside the tap, as iPhone requires.
const clips = new Map();
const player = new Audio();
async function loadClips() {
  try {
    const index = await (await fetch('audio/index.json')).json();
    for (const [text, file] of Object.entries(index)) {
      if (clips.has(text)) continue;
      const res = await fetch(file);
      if (res.ok) clips.set(text, URL.createObjectURL(await res.blob()));
    }
  } catch { /* offline before the first load: speech engine backup */ }
}

const jaVoice = () => {
  const ja = (window.speechSynthesis?.getVoices() || []).filter((v) => /^ja/i.test(v.lang));
  // Prefer the standard voices (iPhone: Kyoko/O-ren/Otoya, Android/Chrome: Google 日本語) over novelty ones.
  return ja.find((v) => /Kyoko|O-ren|Otoya|Hattori|Google|日本語/i.test(v.name)) || ja.find((v) => v.default) || ja[0];
};
window.speechSynthesis?.getVoices();

// Lines of text play one after another, so a place name and a stock sentence share their clips.
function speak(text) {
  const parts = text.split('\n');
  if (!parts.every((p) => clips.has(p))) return speakEngine(parts.join('、'));
  window.speechSynthesis?.cancel();
  let i = 0;
  const next = () => {
    player.src = clips.get(parts[i++]);
    player.onended = i < parts.length ? next : null;
    player.play().catch(() => speakEngine(parts.join('、')));
  };
  next();
}
// A tenth of a second of silence (WAV), played through <audio> inside the tap: on iPhone this moves the page's
// audio to the 'playback' session, so the speech engine isn't muted by the silent switch either.
const SILENCE = (() => {
  const n = 800; const b = new Uint8Array(44 + n); const v = new DataView(b.buffer);
  const w = (o, t) => [...t].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();
// Run inside the tap, right before the speech engine talks (Japanese phrases and the Korean morning briefing).
function unmuteSpeech() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iPhone */ }
  player.onended = null;
  player.src = SILENCE;
  player.play().catch(() => {});
}
function speakEngine(text) {
  const synth = window.speechSynthesis;
  if (!synth) return speakFallback(text, '이 기기 브라우저는 음성을 지원하지 않아요.');
  unmuteSpeech();
  // The engine gives no error when the phone is on silent, so say once what to try if nothing is heard.
  clearTimeout(state.speakHint);
  if (!state.speakHinted) state.speakHint = setTimeout(() => { if (!synth.speaking) return; state.speakHinted = true; toast('소리가 안 나면 폰 옆 무음 스위치를 끄고 다시 눌러 보세요', `https://translate.google.com/?sl=ja&tl=ko&text=${encodeURIComponent(text)}&op=translate`, 'Google 번역에서 듣기'); }, 1200);
  const voice = jaVoice();
  if (!voice && synth.getVoices().length) return speakFallback(text, '이 폰에 일본어 음성이 없어요.');
  if (synth.speaking || synth.pending) synth.cancel();
  synth.resume();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (voice) u.voice = voice;
  u.rate = 0.9;
  u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') speakFallback(text, '음성이 재생되지 않았어요.'); };
  synth.speak(u);
}
// ---------- morning briefing read aloud (the phone's own Korean voice) ----------
// The best Korean voice on the phone: a downloaded enhanced/premium one first (iPhone 유나 향상됨), then 유나, then any.
const koVoice = () => {
  const ko = (window.speechSynthesis?.getVoices() || []).filter((v) => /^ko/i.test(v.lang));
  return ko.find((v) => /향상|Enhanced|Premium|고품질/i.test(v.name)) || ko.find((v) => /Yuna|유나/i.test(v.name)) || ko.find((v) => v.default) || ko[0];
};
// Times and units the way a person says them: 17:30 → 오후 5시 반, 8~19시 → 오전 8시부터 저녁 7시까지, 12° → 12도.
const sayHour = (h) => (h < 12 ? `${h < 6 ? '새벽' : '오전'} ${h || 12}시` : `${h < 18 ? '오후' : '저녁'} ${h === 12 ? 12 : h - 12}시`);
const spoken = (t) => t
  .replace(/(\d{1,2}):(\d{2})/g, (m, h, mi) => `${sayHour(Number(h))}${mi === '00' ? '' : mi === '30' ? ' 반' : ` ${Number(mi)}분`}`)
  .replace(/(\d{1,2})~(\d{1,2})시/g, (m, a, b) => `${sayHour(Number(a))}부터 ${sayHour(Number(b))}까지`)
  .replace(/(?<![오전후녁벽] |\d)(\d{1,2})시(부터|쯤)/g, (m, h, w) => `${sayHour(Number(h))}${w}`)
  .replace(/(-?\d+)~(-?\d+)°/g, '$1도에서 $2도').replace(/°/g, '도').replace(/%/g, '퍼센트').replace(/(\d)mm/g, '$1밀리미터')
  .replace(/[·→]/g, ', ').replace(/\s+/g, ' ');
function briefStop() { window.speechSynthesis?.cancel(); state.briefing = false; document.querySelectorAll('[data-brief]').forEach((b) => b.classList.remove('on')); }
function briefPlay(text) {
  const synth = window.speechSynthesis;
  if (!synth) return toast('이 기기 브라우저는 음성을 지원하지 않아요');
  if (state.briefing) return briefStop();
  synth.cancel(); synth.resume();
  unmuteSpeech();
  const voice = koVoice();
  // One sentence per utterance: iPhone can cut off a long one.
  const parts = spoken(text).split(/(?<=[.?!])\s+/).filter(Boolean);
  state.briefing = true;
  document.querySelectorAll('[data-brief]').forEach((b) => b.classList.add('on'));
  parts.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'ko-KR';
    if (voice) u.voice = voice;
    u.rate = 1;
    if (i === parts.length - 1) u.onend = () => { state.briefing = false; document.querySelectorAll('[data-brief]').forEach((b) => b.classList.remove('on')); };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') { briefStop(); toast('음성이 재생되지 않았어요. 무음 모드를 꺼 주세요'); } };
    synth.speak(u);
  });
  toast('소리가 안 나면 폰 옆 무음 스위치를 끄고 다시 눌러 보세요');
}

// No usable voice: Google 번역 reads Japanese aloud with its speaker button.
function speakFallback(text, why) {
  const t = encodeURIComponent(text);
  toast(`${why} Google 번역에서 스피커를 눌러 들을 수 있어요.`, `https://translate.google.com/?sl=ja&tl=ko&text=${t}&op=translate`, 'Google 번역');
}

let toastTimer;
// `href` is a link to open, or a function for an action button such as "되돌리기".
function toast(msg, href, label) {
  const el = $('#toast');
  const act = typeof href === 'function';
  el.innerHTML = `<span>${esc(msg)}</span>${act ? `<button type="button">${esc(label)}</button>` : href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : ''}`;
  if (act) el.querySelector('button').onclick = () => { el.hidden = true; href(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, href ? 6000 : 2200);
}

// ---------- icons ----------
// Phosphor Icons duotone (MIT, phosphoricons.com); torii, tower and lantern drawn to match.
// The 20% layer (class "d") takes the category tint.
const ICONS = {
  'trash': '<path d="M200,56V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V56Z" class="d"/><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/>',
  // Wavy-edged gear (outline, like the one the traveler picked): one scalloped ring and a ring in the middle.
  'gear': '<path fill-rule="evenodd" d="M230.5,128.0L230.1,132.2L229.0,136.2L227.3,139.8L225.2,143.1L222.7,146.0L220.2,148.5L217.6,150.8L215.0,152.8L212.6,154.6L210.5,156.1L208.8,157.5L207.5,158.6L206.7,159.5L206.2,160.0L206.1,160.3L206.0,160.7L205.9,161.4L205.9,162.6L206.0,164.3L206.3,166.5L206.6,169.0L207.1,172.0L207.5,175.2L207.7,178.7L207.7,182.3L207.4,186.0L206.6,189.9L205.2,193.6L203.2,197.2L200.5,200.5L197.2,203.2L193.6,205.2L189.9,206.6L186.0,207.4L182.3,207.7L178.7,207.7L175.2,207.5L172.0,207.1L169.0,206.6L166.5,206.3L164.3,206.0L162.6,205.9L161.4,205.9L160.7,206.0L160.3,206.1L160.0,206.2L159.5,206.7L158.6,207.5L157.5,208.8L156.1,210.5L154.6,212.6L152.8,215.0L150.8,217.6L148.5,220.2L146.0,222.7L143.1,225.2L139.8,227.3L136.2,229.0L132.2,230.1L128.0,230.5L123.8,230.1L119.8,229.0L116.2,227.3L112.9,225.2L110.0,222.7L107.5,220.2L105.2,217.6L103.2,215.0L101.4,212.6L99.9,210.5L98.5,208.8L97.4,207.5L96.5,206.7L96.0,206.2L95.7,206.1L95.3,206.0L94.6,205.9L93.4,205.9L91.7,206.0L89.5,206.3L87.0,206.6L84.0,207.1L80.8,207.5L77.3,207.7L73.7,207.7L70.0,207.4L66.1,206.6L62.4,205.2L58.8,203.2L55.5,200.5L52.8,197.2L50.8,193.6L49.4,189.9L48.6,186.0L48.3,182.3L48.3,178.7L48.5,175.2L48.9,172.0L49.4,169.0L49.7,166.5L50.0,164.3L50.1,162.6L50.1,161.4L50.0,160.7L49.9,160.3L49.8,160.0L49.3,159.5L48.5,158.6L47.2,157.5L45.5,156.1L43.4,154.6L41.0,152.8L38.4,150.8L35.8,148.5L33.3,146.0L30.8,143.1L28.7,139.8L27.0,136.2L25.9,132.2L25.5,128.0L25.9,123.8L27.0,119.8L28.7,116.2L30.8,112.9L33.3,110.0L35.8,107.5L38.4,105.2L41.0,103.2L43.4,101.4L45.5,99.9L47.2,98.5L48.5,97.4L49.3,96.5L49.8,96.0L49.9,95.7L50.0,95.3L50.1,94.6L50.1,93.4L50.0,91.7L49.7,89.5L49.4,87.0L48.9,84.0L48.5,80.8L48.3,77.3L48.3,73.7L48.6,70.0L49.4,66.1L50.8,62.4L52.8,58.8L55.5,55.5L58.8,52.8L62.4,50.8L66.1,49.4L70.0,48.6L73.7,48.3L77.3,48.3L80.8,48.5L84.0,48.9L87.0,49.4L89.5,49.7L91.7,50.0L93.4,50.1L94.6,50.1L95.3,50.0L95.7,49.9L96.0,49.8L96.5,49.3L97.4,48.5L98.5,47.2L99.9,45.5L101.4,43.4L103.2,41.0L105.2,38.4L107.5,35.8L110.0,33.3L112.9,30.8L116.2,28.7L119.8,27.0L123.8,25.9L128.0,25.5L132.2,25.9L136.2,27.0L139.8,28.7L143.1,30.8L146.0,33.3L148.5,35.8L150.8,38.4L152.8,41.0L154.6,43.4L156.1,45.5L157.5,47.2L158.6,48.5L159.5,49.3L160.0,49.8L160.3,49.9L160.7,50.0L161.4,50.1L162.6,50.1L164.3,50.0L166.5,49.7L169.0,49.4L172.0,48.9L175.2,48.5L178.7,48.3L182.3,48.3L186.0,48.6L189.9,49.4L193.6,50.8L197.2,52.8L200.5,55.5L203.2,58.8L205.2,62.4L206.6,66.1L207.4,70.0L207.7,73.7L207.7,77.3L207.5,80.8L207.1,84.0L206.6,87.0L206.3,89.5L206.0,91.7L205.9,93.4L205.9,94.6L206.0,95.3L206.1,95.7L206.2,96.0L206.7,96.5L207.5,97.4L208.8,98.5L210.5,99.9L212.6,101.4L215.0,103.2L217.6,105.2L220.2,107.5L222.7,110.0L225.2,112.9L227.3,116.2L229.0,119.8L230.1,123.8ZM211.5,128.0L211.4,128.7L211.2,129.5L210.7,130.5L209.9,131.7L208.7,133.1L207.2,134.6L205.5,136.2L203.5,137.7L201.3,139.3L199.1,141.0L196.8,142.8L194.4,144.8L192.2,147.1L190.2,149.9L188.5,153.1L187.4,156.5L186.9,159.9L186.9,163.1L187.1,166.2L187.4,169.0L187.9,171.8L188.2,174.5L188.5,177.0L188.7,179.4L188.7,181.5L188.6,183.3L188.3,184.7L187.9,185.8L187.5,186.5L187.0,187.0L186.5,187.5L185.8,187.9L184.7,188.3L183.3,188.6L181.5,188.7L179.4,188.7L177.0,188.5L174.5,188.2L171.8,187.9L169.0,187.4L166.2,187.1L163.1,186.9L159.9,186.9L156.5,187.4L153.1,188.5L149.9,190.2L147.1,192.2L144.8,194.4L142.8,196.8L141.0,199.1L139.3,201.3L137.7,203.5L136.2,205.5L134.6,207.2L133.1,208.7L131.7,209.9L130.5,210.7L129.5,211.2L128.7,211.4L128.0,211.5L127.3,211.4L126.5,211.2L125.5,210.7L124.3,209.9L122.9,208.7L121.4,207.2L119.8,205.5L118.3,203.5L116.7,201.3L115.0,199.1L113.2,196.8L111.2,194.4L108.9,192.2L106.1,190.2L102.9,188.5L99.5,187.4L96.1,186.9L92.9,186.9L89.8,187.1L87.0,187.4L84.2,187.9L81.5,188.2L79.0,188.5L76.6,188.7L74.5,188.7L72.7,188.6L71.3,188.3L70.2,187.9L69.5,187.5L69.0,187.0L68.5,186.5L68.1,185.8L67.7,184.7L67.4,183.3L67.3,181.5L67.3,179.4L67.5,177.0L67.8,174.5L68.1,171.8L68.6,169.0L68.9,166.2L69.1,163.1L69.1,159.9L68.6,156.5L67.5,153.1L65.8,149.9L63.8,147.1L61.6,144.8L59.2,142.8L56.9,141.0L54.7,139.3L52.5,137.7L50.5,136.2L48.8,134.6L47.3,133.1L46.1,131.7L45.3,130.5L44.8,129.5L44.6,128.7L44.5,128.0L44.6,127.3L44.8,126.5L45.3,125.5L46.1,124.3L47.3,122.9L48.8,121.4L50.5,119.8L52.5,118.3L54.7,116.7L56.9,115.0L59.2,113.2L61.6,111.2L63.8,108.9L65.8,106.1L67.5,102.9L68.6,99.5L69.1,96.1L69.1,92.9L68.9,89.8L68.6,87.0L68.1,84.2L67.8,81.5L67.5,79.0L67.3,76.6L67.3,74.5L67.4,72.7L67.7,71.3L68.1,70.2L68.5,69.5L69.0,69.0L69.5,68.5L70.2,68.1L71.3,67.7L72.7,67.4L74.5,67.3L76.6,67.3L79.0,67.5L81.5,67.8L84.2,68.1L87.0,68.6L89.8,68.9L92.9,69.1L96.1,69.1L99.5,68.6L102.9,67.5L106.1,65.8L108.9,63.8L111.2,61.6L113.2,59.2L115.0,56.9L116.7,54.7L118.3,52.5L119.8,50.5L121.4,48.8L122.9,47.3L124.3,46.1L125.5,45.3L126.5,44.8L127.3,44.6L128.0,44.5L128.7,44.6L129.5,44.8L130.5,45.3L131.7,46.1L133.1,47.3L134.6,48.8L136.2,50.5L137.7,52.5L139.3,54.7L141.0,56.9L142.8,59.2L144.8,61.6L147.1,63.8L149.9,65.8L153.1,67.5L156.5,68.6L159.9,69.1L163.1,69.1L166.2,68.9L169.0,68.6L171.8,68.1L174.5,67.8L177.0,67.5L179.4,67.3L181.5,67.3L183.3,67.4L184.7,67.7L185.8,68.1L186.5,68.5L187.0,69.0L187.5,69.5L187.9,70.2L188.3,71.3L188.6,72.7L188.7,74.5L188.7,76.6L188.5,79.0L188.2,81.5L187.9,84.2L187.4,87.0L187.1,89.8L186.9,92.9L186.9,96.1L187.4,99.5L188.5,102.9L190.2,106.1L192.2,108.9L194.4,111.2L196.8,113.2L199.1,115.0L201.3,116.7L203.5,118.3L205.5,119.8L207.2,121.4L208.7,122.9L209.9,124.3L210.7,125.5L211.2,126.5L211.4,127.3ZM95,128a33,33 0 1,0 66,0a33,33 0 1,0 -66,0ZM114,128a14,14 0 1,0 28,0a14,14 0 1,0 -28,0Z"/>',
  'aimark': '<g class="mk-body"><path fill-rule="evenodd" d="M50.61 102.63Q52.73 105.62 55 105.62Q57.33 105.62 59.50 102.45Q60.55 100.91 62.68 96.74Q66.47 89.32 68.79 87.10Q71.05 84.94 78.20 81.34Q82.51 79.17 84.10 78.09Q87.37 75.88 87.37 73.5Q87.37 71.11 84.10 68.90Q82.51 67.82 78.20 65.65Q77.63 65.37 77.10 65.09C92.75 51.93 112.94 44 135 44C184.70 44 225 84.29 225 134C225 151.25 218.25 166 206.75 181L230.25 210.75C234.5 216.25 231.25 220 224.5 218.25L185.75 208.5C171.25 218.25 153.75 224 135 224C85.29 224 45 183.70 45 134C45 122.96 46.98 112.39 50.61 102.63ZM68.5 147.5L68.5 139.25Q68.5 138.18 68.55 137.11Q68.60 136.04 68.70 134.98Q68.81 133.92 68.97 132.86Q69.12 131.81 69.33 130.76Q69.54 129.71 69.80 128.68Q70.06 127.64 70.37 126.62Q70.68 125.60 71.04 124.59Q71.40 123.58 71.81 122.60Q72.21 121.61 72.67 120.65Q73.13 119.68 73.63 118.74Q74.13 117.80 74.68 116.88Q75.23 115.97 75.83 115.08Q76.42 114.19 77.06 113.33Q77.69 112.47 78.37 111.65Q79.05 110.82 79.76 110.03Q80.48 109.24 81.24 108.49Q81.99 107.73 82.78 107.01Q83.57 106.30 84.40 105.62Q85.22 104.94 86.08 104.31Q86.94 103.67 87.83 103.08Q88.72 102.48 89.63 101.93Q90.55 101.38 91.49 100.88Q92.43 100.38 93.40 99.92Q94.36 99.46 95.35 99.06Q96.33 98.65 97.34 98.29Q98.35 97.93 99.37 97.62Q100.39 97.31 101.43 97.05Q102.46 96.79 103.51 96.58Q104.56 96.37 105.61 96.22Q106.67 96.06 107.73 95.95Q108.79 95.85 109.86 95.80Q110.93 95.75 112 95.75L158 95.75Q159.06 95.75 160.13 95.80Q161.20 95.85 162.26 95.95Q163.32 96.06 164.38 96.22Q165.43 96.37 166.48 96.58Q167.53 96.79 168.56 97.05Q169.60 97.31 170.62 97.62Q171.64 97.93 172.65 98.29Q173.66 98.65 174.64 99.06Q175.63 99.46 176.59 99.92Q177.56 100.38 178.50 100.88Q179.44 101.38 180.36 101.93Q181.27 102.48 182.16 103.08Q183.05 103.67 183.91 104.31Q184.77 104.94 185.59 105.62Q186.42 106.30 187.21 107.01Q188.00 107.73 188.75 108.49Q189.51 109.24 190.23 110.03Q190.94 110.82 191.62 111.65Q192.30 112.47 192.93 113.33Q193.57 114.19 194.16 115.08Q194.76 115.97 195.31 116.88Q195.86 117.80 196.36 118.74Q196.86 119.68 197.32 120.65Q197.78 121.61 198.18 122.60Q198.59 123.58 198.95 124.59Q199.31 125.60 199.62 126.62Q199.93 127.64 200.19 128.68Q200.45 129.71 200.66 130.76Q200.87 131.81 201.02 132.86Q201.18 133.92 201.29 134.98Q201.39 136.04 201.44 137.11Q201.5 138.18 201.5 139.25L201.5 147.5Q201.5 148.56 201.44 149.63Q201.39 150.70 201.29 151.76Q201.18 152.82 201.02 153.88Q200.87 154.93 200.66 155.98Q200.45 157.03 200.19 158.06Q199.93 159.10 199.62 160.12Q199.31 161.14 198.95 162.15Q198.59 163.16 198.18 164.14Q197.78 165.13 197.32 166.09Q196.86 167.06 196.36 168.00Q195.86 168.94 195.31 169.86Q194.76 170.77 194.16 171.66Q193.57 172.55 192.93 173.41Q192.30 174.27 191.62 175.09Q190.94 175.92 190.23 176.71Q189.51 177.50 188.75 178.25Q188.00 179.01 187.21 179.73Q186.42 180.44 185.59 181.12Q184.77 181.80 183.91 182.43Q183.05 183.07 182.16 183.66Q181.27 184.26 180.36 184.81Q179.44 185.36 178.50 185.86Q177.56 186.36 176.59 186.82Q175.63 187.28 174.64 187.68Q173.66 188.09 172.65 188.45Q171.64 188.81 170.62 189.12Q169.60 189.43 168.56 189.69Q167.53 189.95 166.48 190.16Q165.43 190.37 164.38 190.52Q163.32 190.68 162.26 190.79Q161.20 190.89 160.13 190.94Q159.06 191 158 191L112 191Q110.93 191 109.86 190.94Q108.79 190.89 107.73 190.79Q106.67 190.68 105.61 190.52Q104.56 190.37 103.51 190.16Q102.46 189.95 101.43 189.69Q100.39 189.43 99.37 189.12Q98.35 188.81 97.34 188.45Q96.33 188.09 95.35 187.68Q94.36 187.28 93.40 186.82Q92.43 186.36 91.49 185.86Q90.55 185.36 89.63 184.81Q88.72 184.26 87.83 183.66Q86.94 183.07 86.08 182.43Q85.22 181.80 84.40 181.12Q83.57 180.44 82.78 179.73Q81.99 179.01 81.24 178.25Q80.48 177.50 79.76 176.71Q79.05 175.92 78.37 175.09Q77.69 174.27 77.06 173.41Q76.42 172.55 75.83 171.66Q75.23 170.77 74.68 169.86Q74.13 168.94 73.63 168.00Q73.13 167.06 72.67 166.09Q72.21 165.13 71.81 164.14Q71.40 163.16 71.04 162.15Q70.68 161.14 70.37 160.12Q70.06 159.10 69.80 158.06Q69.54 157.03 69.33 155.98Q69.12 154.93 68.97 153.88Q68.81 152.82 68.70 151.76Q68.60 150.70 68.55 149.63Q68.5 148.56 68.5 147.5Z"/><path fill-rule="evenodd" d="M104 129.75L104 140Q104 140.12 104.00 140.25Q104.01 140.38 104.02 140.51Q104.03 140.64 104.05 140.77Q104.07 140.89 104.10 141.02Q104.12 141.15 104.15 141.27Q104.18 141.40 104.22 141.52Q104.26 141.64 104.30 141.76Q104.35 141.88 104.39 142.00Q104.44 142.12 104.50 142.24Q104.55 142.36 104.61 142.47Q104.68 142.58 104.74 142.69Q104.81 142.80 104.88 142.91Q104.95 143.02 105.03 143.12Q105.10 143.23 105.19 143.33Q105.27 143.43 105.36 143.52Q105.44 143.62 105.53 143.71Q105.62 143.80 105.72 143.88Q105.81 143.97 105.91 144.05Q106.01 144.14 106.12 144.21Q106.22 144.29 106.33 144.36Q106.44 144.43 106.55 144.50Q106.66 144.56 106.77 144.63Q106.88 144.69 107.00 144.74Q107.12 144.80 107.24 144.85Q107.35 144.89 107.48 144.94Q107.60 144.98 107.72 145.02Q107.84 145.06 107.97 145.09Q108.09 145.12 108.22 145.14Q108.35 145.17 108.47 145.19Q108.60 145.21 108.73 145.22Q108.86 145.23 108.99 145.24Q109.12 145.25 109.25 145.25Q109.37 145.25 109.50 145.24Q109.63 145.23 109.76 145.22Q109.89 145.21 110.02 145.19Q110.14 145.17 110.27 145.14Q110.40 145.12 110.52 145.09Q110.65 145.06 110.77 145.02Q110.89 144.98 111.01 144.94Q111.14 144.89 111.25 144.85Q111.37 144.80 111.49 144.74Q111.61 144.69 111.72 144.63Q111.83 144.56 111.94 144.50Q112.05 144.43 112.16 144.36Q112.27 144.29 112.37 144.21Q112.48 144.14 112.58 144.05Q112.68 143.97 112.77 143.88Q112.87 143.80 112.96 143.71Q113.05 143.62 113.13 143.52Q113.22 143.43 113.30 143.33Q113.39 143.23 113.46 143.12Q113.54 143.02 113.61 142.91Q113.68 142.80 113.75 142.69Q113.81 142.58 113.88 142.47Q113.94 142.36 113.99 142.24Q114.05 142.12 114.10 142.00Q114.14 141.88 114.19 141.76Q114.23 141.64 114.27 141.52Q114.31 141.40 114.34 141.27Q114.37 141.15 114.39 141.02Q114.42 140.89 114.44 140.77Q114.46 140.64 114.47 140.51Q114.48 140.38 114.49 140.25Q114.5 140.12 114.5 140L114.5 129.75Q114.5 129.62 114.49 129.49Q114.48 129.36 114.47 129.23Q114.46 129.10 114.44 128.97Q114.42 128.85 114.39 128.72Q114.37 128.59 114.34 128.47Q114.31 128.34 114.27 128.22Q114.23 128.10 114.19 127.98Q114.14 127.85 114.10 127.74Q114.05 127.62 113.99 127.50Q113.94 127.38 113.88 127.27Q113.81 127.16 113.75 127.05Q113.68 126.94 113.61 126.83Q113.54 126.72 113.46 126.62Q113.39 126.51 113.30 126.41Q113.22 126.31 113.13 126.22Q113.05 126.12 112.96 126.03Q112.87 125.94 112.77 125.86Q112.68 125.77 112.58 125.69Q112.48 125.60 112.37 125.53Q112.27 125.45 112.16 125.38Q112.05 125.31 111.94 125.24Q111.83 125.18 111.72 125.11Q111.61 125.05 111.49 125.00Q111.37 124.94 111.25 124.89Q111.14 124.85 111.01 124.80Q110.89 124.76 110.77 124.72Q110.65 124.68 110.52 124.65Q110.40 124.62 110.27 124.60Q110.14 124.57 110.02 124.55Q109.89 124.53 109.76 124.52Q109.63 124.51 109.50 124.50Q109.37 124.5 109.25 124.5Q109.12 124.5 108.99 124.50Q108.86 124.51 108.73 124.52Q108.60 124.53 108.47 124.55Q108.35 124.57 108.22 124.60Q108.09 124.62 107.97 124.65Q107.84 124.68 107.72 124.72Q107.60 124.76 107.48 124.80Q107.35 124.85 107.24 124.89Q107.12 124.94 107.00 125.00Q106.88 125.05 106.77 125.11Q106.66 125.18 106.55 125.24Q106.44 125.31 106.33 125.38Q106.22 125.45 106.12 125.53Q106.01 125.60 105.91 125.69Q105.81 125.77 105.72 125.86Q105.62 125.94 105.53 126.03Q105.44 126.12 105.36 126.22Q105.27 126.31 105.19 126.41Q105.10 126.51 105.03 126.62Q104.95 126.72 104.88 126.83Q104.81 126.94 104.74 127.05Q104.68 127.16 104.61 127.27Q104.55 127.38 104.50 127.50Q104.44 127.62 104.39 127.74Q104.35 127.85 104.30 127.98Q104.26 128.10 104.22 128.22Q104.18 128.34 104.15 128.47Q104.12 128.59 104.10 128.72Q104.07 128.85 104.05 128.97Q104.03 129.10 104.02 129.23Q104.01 129.36 104.00 129.49Q104 129.62 104 129.75ZM155.5 129.75L155.5 140Q155.5 140.12 155.50 140.25Q155.51 140.38 155.52 140.51Q155.53 140.64 155.55 140.77Q155.57 140.89 155.60 141.02Q155.62 141.15 155.65 141.27Q155.68 141.40 155.72 141.52Q155.76 141.64 155.80 141.76Q155.85 141.88 155.89 142.00Q155.94 142.12 156.00 142.24Q156.05 142.36 156.11 142.47Q156.18 142.58 156.24 142.69Q156.31 142.80 156.38 142.91Q156.45 143.02 156.53 143.12Q156.60 143.23 156.69 143.33Q156.77 143.43 156.85 143.52Q156.94 143.62 157.03 143.71Q157.12 143.80 157.22 143.88Q157.31 143.97 157.41 144.05Q157.51 144.14 157.62 144.21Q157.72 144.29 157.83 144.36Q157.94 144.43 158.05 144.50Q158.16 144.56 158.27 144.63Q158.38 144.69 158.50 144.74Q158.62 144.80 158.74 144.85Q158.85 144.89 158.98 144.94Q159.10 144.98 159.22 145.02Q159.34 145.06 159.47 145.09Q159.59 145.12 159.72 145.14Q159.85 145.17 159.97 145.19Q160.10 145.21 160.23 145.22Q160.36 145.23 160.49 145.24Q160.62 145.25 160.75 145.25Q160.87 145.25 161.00 145.24Q161.13 145.23 161.26 145.22Q161.39 145.21 161.52 145.19Q161.64 145.17 161.77 145.14Q161.90 145.12 162.02 145.09Q162.15 145.06 162.27 145.02Q162.39 144.98 162.51 144.94Q162.64 144.89 162.75 144.85Q162.87 144.80 162.99 144.74Q163.11 144.69 163.22 144.63Q163.33 144.56 163.44 144.50Q163.55 144.43 163.66 144.36Q163.77 144.29 163.87 144.21Q163.98 144.14 164.08 144.05Q164.18 143.97 164.27 143.88Q164.37 143.80 164.46 143.71Q164.55 143.62 164.63 143.52Q164.72 143.43 164.80 143.33Q164.89 143.23 164.96 143.12Q165.04 143.02 165.11 142.91Q165.18 142.80 165.25 142.69Q165.31 142.58 165.38 142.47Q165.44 142.36 165.49 142.24Q165.55 142.12 165.60 142.00Q165.64 141.88 165.69 141.76Q165.73 141.64 165.77 141.52Q165.81 141.40 165.84 141.27Q165.87 141.15 165.89 141.02Q165.92 140.89 165.94 140.77Q165.96 140.64 165.97 140.51Q165.98 140.38 165.99 140.25Q166 140.12 166 140L166 129.75Q166 129.62 165.99 129.49Q165.98 129.36 165.97 129.23Q165.96 129.10 165.94 128.97Q165.92 128.85 165.89 128.72Q165.87 128.59 165.84 128.47Q165.81 128.34 165.77 128.22Q165.73 128.10 165.69 127.98Q165.64 127.85 165.60 127.74Q165.55 127.62 165.49 127.50Q165.44 127.38 165.38 127.27Q165.31 127.16 165.25 127.05Q165.18 126.94 165.11 126.83Q165.04 126.72 164.96 126.62Q164.89 126.51 164.80 126.41Q164.72 126.31 164.63 126.22Q164.55 126.12 164.46 126.03Q164.37 125.94 164.27 125.86Q164.18 125.77 164.08 125.69Q163.98 125.60 163.87 125.53Q163.77 125.45 163.66 125.38Q163.55 125.31 163.44 125.24Q163.33 125.18 163.22 125.11Q163.11 125.05 162.99 125.00Q162.87 124.94 162.75 124.89Q162.64 124.85 162.51 124.80Q162.39 124.76 162.27 124.72Q162.15 124.68 162.02 124.65Q161.90 124.62 161.77 124.60Q161.64 124.57 161.52 124.55Q161.39 124.53 161.26 124.52Q161.13 124.51 161.00 124.50Q160.87 124.5 160.75 124.5Q160.62 124.5 160.49 124.50Q160.36 124.51 160.23 124.52Q160.10 124.53 159.97 124.55Q159.85 124.57 159.72 124.60Q159.59 124.62 159.47 124.65Q159.34 124.68 159.22 124.72Q159.10 124.76 158.98 124.80Q158.85 124.85 158.74 124.89Q158.62 124.94 158.50 125.00Q158.38 125.05 158.27 125.11Q158.16 125.18 158.05 125.24Q157.94 125.31 157.83 125.38Q157.72 125.45 157.62 125.53Q157.51 125.60 157.41 125.69Q157.31 125.77 157.22 125.86Q157.12 125.94 157.03 126.03Q156.94 126.12 156.85 126.22Q156.77 126.31 156.69 126.41Q156.60 126.51 156.53 126.62Q156.45 126.72 156.38 126.83Q156.31 126.94 156.24 127.05Q156.18 127.16 156.11 127.27Q156.05 127.38 156.00 127.50Q155.94 127.62 155.89 127.74Q155.85 127.85 155.80 127.98Q155.76 128.10 155.72 128.22Q155.68 128.34 155.65 128.47Q155.62 128.59 155.60 128.72Q155.57 128.85 155.55 128.97Q155.53 129.10 155.52 129.23Q155.51 129.36 155.50 129.49Q155.5 129.62 155.5 129.75ZM135 161.62Q131.44 161.62 127.56 157.52Q127.39 157.35 127.19 157.20Q126.99 157.06 126.76 156.96Q126.54 156.86 126.30 156.81Q126.06 156.75 125.81 156.75Q125.56 156.74 125.32 156.78Q125.08 156.82 124.85 156.91Q124.62 157.00 124.41 157.13Q124.20 157.26 124.02 157.43Q123.94 157.52 123.85 157.61Q123.77 157.70 123.70 157.80Q123.63 157.90 123.57 158.01Q123.51 158.12 123.46 158.23Q123.41 158.34 123.37 158.46Q123.33 158.57 123.31 158.69Q123.28 158.81 123.26 158.93Q123.25 159.06 123.25 159.18Q123.24 159.30 123.25 159.42Q123.26 159.55 123.28 159.67Q123.30 159.79 123.33 159.91Q123.37 160.03 123.41 160.14Q123.45 160.26 123.51 160.37Q123.56 160.47 123.63 160.58Q123.70 160.68 123.77 160.78Q123.85 160.88 123.93 160.97Q129.30 166.62 135 166.62Q140.69 166.62 146.06 160.97Q146.14 160.88 146.22 160.78Q146.29 160.68 146.36 160.58Q146.43 160.47 146.48 160.37Q146.54 160.26 146.58 160.14Q146.62 160.03 146.66 159.91Q146.69 159.79 146.71 159.67Q146.73 159.55 146.74 159.42Q146.75 159.30 146.74 159.18Q146.74 159.06 146.73 158.93Q146.71 158.81 146.68 158.69Q146.66 158.57 146.62 158.46Q146.58 158.34 146.53 158.23Q146.48 158.12 146.42 158.01Q146.36 157.90 146.29 157.80Q146.22 157.70 146.14 157.61Q146.05 157.52 145.97 157.43Q145.88 157.35 145.78 157.27Q145.68 157.20 145.58 157.13Q145.47 157.06 145.37 157.01Q145.26 156.95 145.14 156.91Q145.03 156.87 144.91 156.83Q144.79 156.80 144.67 156.78Q144.55 156.76 144.42 156.75Q144.30 156.74 144.18 156.75Q144.06 156.75 143.93 156.76Q143.81 156.78 143.69 156.81Q143.57 156.83 143.46 156.87Q143.34 156.91 143.23 156.96Q143.12 157.01 143.01 157.07Q142.90 157.13 142.80 157.20Q142.70 157.27 142.61 157.35Q142.52 157.44 142.43 157.52Q138.55 161.62 135 161.62Z"/></g><g class="mk-star"><path fill-rule="evenodd" d="M55 45.12Q54.14 45.12 50.65 51.96Q48.71 55.76 47.60 57.59Q45.67 60.81 43.79 62.60Q41.12 65.15 33.48 69.00Q26.37 72.58 26.37 73.5Q26.37 74.41 33.48 77.99Q41.12 81.84 43.79 84.39Q45.67 86.18 47.60 89.40Q48.71 91.23 50.65 95.03Q54.14 101.87 55 101.87Q55.85 101.87 59.34 95.03Q61.28 91.23 62.39 89.40Q64.32 86.18 66.20 84.39Q68.87 81.84 76.51 77.99Q83.62 74.41 83.62 73.5Q83.62 72.58 76.51 69.00Q68.87 65.15 66.20 62.60Q64.32 60.81 62.39 57.59Q61.28 55.76 59.34 51.96Q55.85 45.12 55 45.12ZM69.5 73.5C61 70.5 58 67.5 55 59C52 67.5 49 70.5 40.5 73.5C49 76.5 52 79.5 55 88C58 79.5 61 76.5 69.5 73.5Z"/></g>',
  'spark': '<path class="d" d="M108 40c6 50 24 68 74 74-50 6-68 24-74 74-6-50-24-68-74-74 50-6 68-24 74-74Z"/><path d="M108 40c6 50 24 68 74 74-50 6-68 24-74 74-6-50-24-68-74-74 50-6 68-24 74-74Zm0 30.5c-6.3 26.6-19 39.2-45.6 45.5C89 122.3 101.7 135 108 161.6c6.3-26.6 19-39.3 45.6-45.6C127 109.7 114.3 97 108 70.5ZM196 24c3 22 11 30 33 33-22 3-30 11-33 33-3-22-11-30-33-33 22-3 30-11 33-33Z"/>',
  'heart': '<path d="M178,32c-20.65,0-38.73,8.88-50,23.89C116.73,40.88,98.65,32,78,32A62.07,62.07,0,0,0,16,94c0,70,103.79,126.66,108.21,129a8,8,0,0,0,7.58,0C136.21,220.66,240,164,240,94A62.07,62.07,0,0,0,178,32ZM128,206.8C109.74,196.16,32,147.69,32,94A46.06,46.06,0,0,1,78,48c19.45,0,35.78,10.36,42.6,27a8,8,0,0,0,14.8,0c6.82-16.67,23.15-27,42.6-27a46.06,46.06,0,0,1,46,46C224,147.61,146.24,196.15,128,206.8Z"/>',
  'image': '<path d="M224,56V178.06l-39.72-39.72a8,8,0,0,0-11.31,0L147.31,164,97.66,114.34a8,8,0,0,0-11.32,0L32,168.69V56a8,8,0,0,1,8-8H216A8,8,0,0,1,224,56Z" class="d"/><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"/>',
  'route': '<g fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"><circle cx="60" cy="196" r="28"/><circle cx="196" cy="60" r="28"/><path d="M88 196H164a36 36 0 0 0 0-72H92a32 32 0 0 1 0-64H168"/></g>',
  'camera': '<path d="M208,64H176L160,40H96L80,64H48A16,16,0,0,0,32,80V192a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V80A16,16,0,0,0,208,64Z" class="d"/><path d="M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8H80a8,8,0,0,0,6.66-3.56L100.28,48h55.43l13.63,20.44A8,8,0,0,0,176,72h32a8,8,0,0,1,8,8ZM128,88a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,88Zm0,72a28,28,0,1,1,28-28A28,28,0,0,1,128,160Z"/>',
  'mic': '<path d="M168,64v64a40,40,0,0,1-80,0V64a40,40,0,0,1,80,0Z" class="d"/><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V232a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z"/>',
  'talk': '<path d="M148,32h60a24,24,0,0,1,24,24v36a24,24,0,0,1-24,24H184l-28,22V116h-8a24,24,0,0,1-24-24V56A24,24,0,0,1,148,32Z" class="d"/><path d="M148,32h60a24,24,0,0,1,24,24v36a24,24,0,0,1-24,24H184l-28,22V116h-8a24,24,0,0,1-24-24V56A24,24,0,0,1,148,32Z" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"/><circle cx="76" cy="132" r="32" fill="none" stroke="currentColor" stroke-width="16"/><path d="M16,224c6-30,31-48,60-48s54,18,60,48" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>',
  'pen': '<path d="M221.66,90.34,192,120,136,64l29.66-29.66a8,8,0,0,1,11.31,0L221.66,79A8,8,0,0,1,221.66,90.34Z" class="d"/><path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z"/>',
  'skip': '<path d="M184,128,64,208V48Z" class="d"/><path d="M200,32a8,8,0,0,0-8,8v73.05L72.88,33.67A16,16,0,0,0,48,47V209a16,16,0,0,0,24.88,13.33L192,142.95V216a8,8,0,0,0,16,0V40A8,8,0,0,0,200,32ZM64,209V47l121.5,81Z"/>',
  'bus': '<path d="M48,184H88v24a8,8,0,0,1-8,8H56a8,8,0,0,1-8-8Zm120,24a8,8,0,0,0,8,8h24a8,8,0,0,0,8-8V184H168ZM48,72v40H208V72Z" class="d"/><path d="M184,32H72A32,32,0,0,0,40,64V208a16,16,0,0,0,16,16H80a16,16,0,0,0,16-16V192h64v16a16,16,0,0,0,16,16h24a16,16,0,0,0,16-16V64A32,32,0,0,0,184,32ZM56,176V120H200v56Zm0-96H200v24H56ZM72,48H184a16,16,0,0,1,16,16H56A16,16,0,0,1,72,48Zm8,160H56V192H80Zm96,0V192h24v16Zm-72-60a12,12,0,1,1-12-12A12,12,0,0,1,104,148Zm72,0a12,12,0,1,1-12-12A12,12,0,0,1,176,148Zm72-68v24a8,8,0,0,1-16,0V80a8,8,0,0,1,16,0ZM24,80v24a8,8,0,0,1-16,0V80a8,8,0,0,1,16,0Z"/>',
  'luggage': '<path d="M200,64V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H192A8,8,0,0,1,200,64Z" class="d"/><path d="M104,88v96a8,8,0,0,1-16,0V88a8,8,0,0,1,16,0Zm24-8a8,8,0,0,0-8,8v96a8,8,0,0,0,16,0V88A8,8,0,0,0,128,80Zm32,0a8,8,0,0,0-8,8v96a8,8,0,0,0,16,0V88A8,8,0,0,0,160,80Zm48-16V208a16,16,0,0,1-16,16H176v16a8,8,0,0,1-16,0V224H96v16a8,8,0,0,1-16,0V224H64a16,16,0,0,1-16-16V64A16,16,0,0,1,64,48H88V24A24,24,0,0,1,112,0h32a24,24,0,0,1,24,24V48h24A16,16,0,0,1,208,64ZM104,48h48V24a8,8,0,0,0-8-8H112a8,8,0,0,0-8,8Zm88,160V64H64V208H192Z"/>',
  'baggage': '<path d="M224,152v48a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V152Z" class="d"/><path d="M216,56H176V48a24,24,0,0,0-24-24H104A24,24,0,0,0,80,48v8H40A16,16,0,0,0,24,72V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V72A16,16,0,0,0,216,56ZM96,48a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96ZM216,72v72H40V72Zm0,128H40V160H216v40Z"/>',
  'plane': '<path d="M209,81l-33,31,32,88-24,24-48-72-24,24v24L88,224,72,184,32,168l24-24H80l24-24L32,72,56,48l88,32,31-33A24,24,0,0,1,209,81Z" class="d"/><path d="M185.33,114.21l29.14-27.43.17-.16a32,32,0,0,0-45.26-45.26l-.16.17L141.79,70.67l-83-30.2a8,8,0,0,0-8.39,1.86l-24,24a8,8,0,0,0,1.22,12.31l63.89,42.59L76.69,136H56a8,8,0,0,0-5.65,2.34l-24,24A8,8,0,0,0,29,175.42l36.82,14.73,14.7,36.75.06.16a8,8,0,0,0,13.18,2.47l23.87-23.88A8,8,0,0,0,120,200V179.31l14.76-14.76,42.59,63.89a8,8,0,0,0,12.31,1.22l24-24a8,8,0,0,0,1.86-8.39Zm-.07,97.23-42.59-63.89A8,8,0,0,0,136.8,144a7.09,7.09,0,0,0-.79,0,8,8,0,0,0-5.66,2.34l-24,24A8,8,0,0,0,104,176v20.69L90.93,209.76,79.43,181A8,8,0,0,0,75,176.57l-28.74-11.5L59.32,152H80a8,8,0,0,0,5.66-2.34l24-24a8,8,0,0,0-1.22-12.32L44.56,70.74l13.5-13.49,83.22,30.26a8,8,0,0,0,8.56-2l30.94-32.88A16,16,0,0,1,203.4,75.22l-32.87,30.94a8,8,0,0,0-2,8.56l30.26,83.22Z"/>',
  'walk': '<path d="M176,48a24,24,0,1,1-24-24A24,24,0,0,1,176,48Z" class="d"/><path d="M152,80a32,32,0,1,0-32-32A32,32,0,0,0,152,80Zm0-48a16,16,0,1,1-16,16A16,16,0,0,1,152,32Zm64,112a8,8,0,0,1-8,8c-35.31,0-52.95-17.81-67.12-32.12-2.74-2.77-5.36-5.4-8-7.84l-13.43,30.88,37.2,26.57A8,8,0,0,1,160,176v56a8,8,0,0,1-16,0V180.12l-31.07-22.2L79.34,235.19A8,8,0,0,1,72,240a7.84,7.84,0,0,1-3.19-.67,8,8,0,0,1-4.15-10.52l54.08-124.37c-9.31-1.65-20.92,1.2-34.7,8.58a163.88,163.88,0,0,0-30.57,21.77,8,8,0,0,1-10.95-11.66c2.5-2.35,61.69-57.22,98.72-25.08,3.83,3.32,7.48,7,11,10.58C166.19,122.7,179.36,136,208,136A8,8,0,0,1,216,144Z"/>',
  'train': '<path d="M208,72v56H48V72Z" class="d"/><path d="M184,24H72A32,32,0,0,0,40,56V184a32,32,0,0,0,32,32h8L65.6,235.2a8,8,0,1,0,12.8,9.6L100,216h56l21.6,28.8a8,8,0,1,0,12.8-9.6L176,216h8a32,32,0,0,0,32-32V56A32,32,0,0,0,184,24ZM56,120V80h64v40Zm80-40h64v40H136ZM72,40H184a16,16,0,0,1,16,16v8H56V56A16,16,0,0,1,72,40ZM184,200H72a16,16,0,0,1-16-16V136H200v48A16,16,0,0,1,184,200ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm88,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
  'local': '<path d="M216,120l-22.39,82.1a8,8,0,0,1-7.72,5.9H70.11a8,8,0,0,1-7.72-5.9L40,120l88,16Z" class="d"/><path d="M223.72,117.9,201.33,35.79A16,16,0,0,0,185.89,24H70.11A16,16,0,0,0,54.67,35.79L32.28,117.9a8.08,8.08,0,0,0,0,4.2l22.39,82.11A16,16,0,0,0,70.11,216H80L65.6,235.2a8,8,0,1,0,12.8,9.6L100,216h56l21.6,28.8a8,8,0,1,0,12.8-9.6L176,216h9.89a16,16,0,0,0,15.44-11.79l22.39-82.11A8.08,8.08,0,0,0,223.72,117.9ZM70.11,40H185.89L206,113.69l-78,14.18L50,113.69Zm-19,90.14L120,142.68V200H70.11ZM185.89,200H136V142.68l68.94-12.54ZM88,88a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H96A8,8,0,0,1,88,88Z"/>',
  'station': '<path d="M208,56v72H48V56A24,24,0,0,1,72,32H184A24,24,0,0,1,208,56Z" class="d"/><path d="M184,24H72A32,32,0,0,0,40,56V184a32,32,0,0,0,32,32h8L65.6,235.2a8,8,0,1,0,12.8,9.6L100,216h56l21.6,28.8a8,8,0,1,0,12.8-9.6L176,216h8a32,32,0,0,0,32-32V56A32,32,0,0,0,184,24ZM72,40H184a16,16,0,0,1,16,16v64H56V56A16,16,0,0,1,72,40ZM184,200H72a16,16,0,0,1-16-16V136H200v48A16,16,0,0,1,184,200ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm88,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
  'metro': '<path d="M152,32H104A64,64,0,0,0,40,96V208H216V96A64,64,0,0,0,152,32Zm24,136a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16V96A16,16,0,0,1,96,80h64a16,16,0,0,1,16,16Z" class="d"/><path d="M224,96V208a8,8,0,0,1-16,0V96a56.06,56.06,0,0,0-56-56H104A56.06,56.06,0,0,0,48,96V208a8,8,0,0,1-16,0V96a72.08,72.08,0,0,1,72-72h48A72.08,72.08,0,0,1,224,96Zm-40,0v72a24,24,0,0,1-19.29,23.53l2.45,4.89a8,8,0,0,1-14.32,7.16L147.06,192H108.94l-5.78,11.58a8,8,0,0,1-14.32-7.16l2.45-4.89A24,24,0,0,1,72,168V96A24,24,0,0,1,96,72h64A24,24,0,0,1,184,96ZM88,96v48h80V96a8,8,0,0,0-8-8H96A8,8,0,0,0,88,96Zm32,64v16h16V160ZM96,176h8V160H88v8A8,8,0,0,0,96,176Zm72-8v-8H152v16h8A8,8,0,0,0,168,168Z"/>',
  'tram': '<path d="M208,80v48H48V80A24,24,0,0,1,72,56H184A24,24,0,0,1,208,80Z" class="d"/><path d="M184,48H136V24h32a8,8,0,0,0,0-16H88a8,8,0,0,0,0,16h32V48H72A32,32,0,0,0,40,80V184a32,32,0,0,0,32,32h8L65.6,235.2a8,8,0,1,0,12.8,9.6L100,216h56l21.6,28.8a8,8,0,1,0,12.8-9.6L176,216h8a32,32,0,0,0,32-32V80A32,32,0,0,0,184,48ZM72,64H184a16,16,0,0,1,16,16v40H56V80A16,16,0,0,1,72,64ZM184,200H72a16,16,0,0,1-16-16V136H200v48A16,16,0,0,1,184,200ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm88,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
  'meal': '<path d="M208,40V168H152S152,64,208,40Z" class="d"/><path d="M72,88V40a8,8,0,0,1,16,0V88a8,8,0,0,1-16,0ZM216,40V224a8,8,0,0,1-16,0V176H152a8,8,0,0,1-8-8,268.75,268.75,0,0,1,7.22-56.88c9.78-40.49,28.32-67.63,53.63-78.47A8,8,0,0,1,216,40ZM200,53.9c-32.17,24.57-38.47,84.42-39.7,106.1H200ZM119.89,38.69a8,8,0,1,0-15.78,2.63L112,88.63a32,32,0,0,1-64,0l7.88-47.31a8,8,0,1,0-15.78-2.63l-8,48A8.17,8.17,0,0,0,32,88a48.07,48.07,0,0,0,40,47.32V224a8,8,0,0,0,16,0V135.32A48.07,48.07,0,0,0,128,88a8.17,8.17,0,0,0-.11-1.31Z"/>',
  'breakfast': '<path d="M208,152a80,80,0,0,1-160,0C48,88,96,24,128,24S208,88,208,152Z" class="d"/><path d="M186.66,59.56C168.47,32.29,146.54,16,128,16S87.53,32.29,69.34,59.56C50.7,87.54,40,121.23,40,152a88,88,0,0,0,176,0C216,121.23,205.3,87.54,186.66,59.56ZM128,224a72.08,72.08,0,0,1-72-72c0-27.69,9.72-58.15,26.66-83.56C97.19,46.64,115.41,32,128,32c9.5,0,22.2,8.33,34.1,21.78L122,98.67a8,8,0,0,0,4,13.09l24.6,6.15-6.5,32.52a8,8,0,0,0,6.27,9.41A7.77,7.77,0,0,0,152,160a8,8,0,0,0,7.83-6.43l8-40a8,8,0,0,0-5.9-9.33l-19.16-4.79L172.1,66.6c.42.61.83,1.22,1.24,1.84C190.28,93.85,200,124.31,200,152A72.08,72.08,0,0,1,128,224Z"/>',
  'sushi': '<path d="M185.81,167.62c-18,13.9-44.17,23.41-81.68,24.31L80.09,248l-16-56.07L8,175.87l56.07-24c.9-37.49,10.41-63.61,24.31-81.65A44,44,0,0,0,136.2,119.8a44,44,0,0,0,49.61,47.82Z" class="d"/><path d="M168,76a12,12,0,1,1-12-12A12,12,0,0,1,168,76Zm48.72,67.64c-19.37,34.9-55.44,53.76-107.24,56.1l-22,51.41A8,8,0,0,1,80.1,256l-.51,0a8,8,0,0,1-7.19-5.78L57.6,198.39,5.8,183.56a8,8,0,0,1-1-15.05l51.41-22c2.35-51.78,21.21-87.84,56.09-107.22,24.75-13.74,52.74-15.84,71.88-15.18,18.64.64,36,4.27,38.86,6a8,8,0,0,1,2.83,2.83c1.69,2.85,5.33,20.21,6,38.85C232.55,90.89,230.46,118.89,216.72,143.64Zm-55.18,29a52.11,52.11,0,0,1-33.4-44.78A52.09,52.09,0,0,1,83.37,94.47q-10.45,23.79-11.3,57.59a8,8,0,0,1-4.85,7.17L31.83,174.37l34.45,9.86a8,8,0,0,1,5.49,5.5l9.84,34.44,15.16-35.4a8,8,0,0,1,7.17-4.84Q137.71,183.12,161.54,172.64ZM212.42,43.57c-14.15-3-64.1-11-100.3,14.75a81.21,81.21,0,0,0-16,15.07,36,36,0,0,0,39.35,38.44,8,8,0,0,1,8.73,8.73,36,36,0,0,0,38.47,39.34,80.81,80.81,0,0,0,15-16C223.42,107.73,215.42,57.74,212.42,43.57Z"/>',
  'ramen': '<path d="M224,120a96,96,0,0,1-56,87.3V216a8,8,0,0,1-8,8H96a8,8,0,0,1-8-8v-8.7A96,96,0,0,1,32,120Z" class="d"/><path d="M81.77,55c5.35-6.66,6.67-11.16,6.12-13.14-.42-1.49-2.41-2.26-2.43-2.26A8,8,0,0,1,88,24a8.11,8.11,0,0,1,2.38.36c1,.31,9.91,3.33,12.79,12.76,2.46,8.07-.55,17.45-8.94,27.89-5.35,6.66-6.67,11.16-6.12,13.14.42,1.49,2.37,2.24,2.39,2.25A8,8,0,0,1,88,96a8.11,8.11,0,0,1-2.38-.36c-1-.31-9.91-3.33-12.79-12.76C70.37,74.81,73.38,65.43,81.77,55Zm31.06,27.89c2.88,9.43,11.79,12.45,12.79,12.76A8.11,8.11,0,0,0,128,96a8,8,0,0,0,2.5-15.6s-2-.76-2.39-2.25c-.55-2,.77-6.48,6.12-13.14,8.39-10.44,11.4-19.82,8.94-27.89-2.88-9.43-11.78-12.45-12.79-12.76A8.11,8.11,0,0,0,128,24a8,8,0,0,0-2.54,15.59s2,.77,2.43,2.26c.55,2-.77,6.48-6.12,13.14C113.38,65.43,110.37,74.81,112.83,82.88Zm40,0c2.88,9.43,11.79,12.45,12.79,12.76A8.11,8.11,0,0,0,168,96a8,8,0,0,0,2.5-15.6s-2-.76-2.39-2.25c-.55-2,.77-6.48,6.12-13.14,8.39-10.44,11.4-19.82,8.94-27.89-2.88-9.43-11.78-12.45-12.79-12.76A8.11,8.11,0,0,0,168,24a8,8,0,0,0-2.54,15.59s2,.77,2.43,2.26c.55,2-.77,6.48-6.12,13.14C153.38,65.43,150.37,74.81,152.83,82.88ZM232,120a104.35,104.35,0,0,1-56,92.28V216a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-3.72A104.35,104.35,0,0,1,24,120a8,8,0,0,1,8-8H224A8,8,0,0,1,232,120Zm-16.37,8H40.37a88.29,88.29,0,0,0,51,72A8,8,0,0,1,96,207.29V216h64v-8.71a8,8,0,0,1,4.66-7.27A88.29,88.29,0,0,0,215.63,128Z"/>',
  'coffee': '<path d="M208,88v48a88,88,0,0,1-51.3,80H83.3A88,88,0,0,1,32,136V88Z" class="d"/><path d="M80,56V24a8,8,0,0,1,16,0V56a8,8,0,0,1-16,0Zm40,8a8,8,0,0,0,8-8V24a8,8,0,0,0-16,0V56A8,8,0,0,0,120,64Zm32,0a8,8,0,0,0,8-8V24a8,8,0,0,0-16,0V56A8,8,0,0,0,152,64Zm96,56v8a40,40,0,0,1-37.51,39.91,96.59,96.59,0,0,1-27,40.09H208a8,8,0,0,1,0,16H32a8,8,0,0,1,0-16H56.54A96.3,96.3,0,0,1,24,136V88a8,8,0,0,1,8-8H208A40,40,0,0,1,248,120ZM200,96H40v40a80.27,80.27,0,0,0,45.12,72h69.76A80.27,80.27,0,0,0,200,136Zm32,24a24,24,0,0,0-16-22.62V136a95.78,95.78,0,0,1-1.2,15A24,24,0,0,0,232,128Z"/>',
  'shop': '<path d="M224,56V200a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8H216A8,8,0,0,1,224,56Z" class="d"/><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H40V56H216V200ZM176,88a48,48,0,0,1-96,0,8,8,0,0,1,16,0,32,32,0,0,0,64,0,8,8,0,0,1,16,0Z"/>',
  'fashion': '<path d="M232,192H24a8,8,0,0,1-4.8-14.4L128,96l108.79,81.6A8,8,0,0,1,232,192Z" class="d"/><path d="M241.57,171.2,141.33,96l23.46-17.6A8,8,0,0,0,168,72a40,40,0,1,0-80,0,8,8,0,0,0,16,0,24,24,0,0,1,47.69-3.78L123.34,89.49l-.28.22L14.43,171.2A16,16,0,0,0,24,200H232a16,16,0,0,0,9.6-28.8ZM232,184H24l104-78,104,78Z"/>',
  'watch': '<path d="M200,128a72,72,0,1,1-72-72A72,72,0,0,1,200,128Z" class="d"/><path d="M208,128a79.94,79.94,0,0,0-32.7-64.47l-6.24-34.38A16,16,0,0,0,153.32,16H102.68A16,16,0,0,0,86.94,29.15L80.7,63.53a79.9,79.9,0,0,0,0,128.94l6.24,34.38A16,16,0,0,0,102.68,240h50.64a16,16,0,0,0,15.74-13.15l6.24-34.38A79.94,79.94,0,0,0,208,128ZM102.68,32h50.64l3.91,21.55a79.75,79.75,0,0,0-58.46,0ZM64,128a64,64,0,1,1,64,64A64.07,64.07,0,0,1,64,128Zm89.32,96H102.68l-3.91-21.55a79.75,79.75,0,0,0,58.46,0ZM120,128V88a8,8,0,0,1,16,0v32h32a8,8,0,0,1,0,16H128A8,8,0,0,1,120,128Z"/>',
  'bed': '<path d="M248,112v56H112V80H216A32,32,0,0,1,248,112Z" class="d"/><path d="M216,72H32V48a8,8,0,0,0-16,0V208a8,8,0,0,0,16,0V176H240v32a8,8,0,0,0,16,0V112A40,40,0,0,0,216,72ZM32,88h72v72H32Zm88,72V88h96a24,24,0,0,1,24,24v48Z"/>',
  'game': '<path d="M216.86,207.57a28,28,0,0,1-24.66-7.77L150.09,152H172a51.94,51.94,0,0,0,51.2-61h0l16.36,84.17A28,28,0,0,1,216.86,207.57Z" class="d"/><path d="M176,112H152a8,8,0,0,1,0-16h24a8,8,0,0,1,0,16ZM104,96H96V88a8,8,0,0,0-16,0v8H72a8,8,0,0,0,0,16h8v8a8,8,0,0,0,16,0v-8h8a8,8,0,0,0,0-16ZM241.48,200.65a36,36,0,0,1-54.94,4.81c-.12-.12-.24-.24-.35-.37L146.48,160h-37L69.81,205.09l-.35.37A36.08,36.08,0,0,1,44,216,36,36,0,0,1,8.56,173.75a.68.68,0,0,1,0-.14L24.93,89.52A59.88,59.88,0,0,1,83.89,40H172a60.08,60.08,0,0,1,59,49.25c0,.06,0,.12,0,.18l16.37,84.17a.68.68,0,0,1,0,.14A35.74,35.74,0,0,1,241.48,200.65ZM172,144a44,44,0,0,0,0-88H83.89A43.9,43.9,0,0,0,40.68,92.37l0,.13L24.3,176.59A20,20,0,0,0,58,194.3l41.92-47.59a8,8,0,0,1,6-2.71Zm59.7,32.59-8.74-45A60,60,0,0,1,172,160h-4.2L198,194.31a20.09,20.09,0,0,0,17.46,5.39,20,20,0,0,0,16.23-23.11Z"/>',
  'park': '<path d="M232,127.82c.09,33.94-28.41,63.3-62.34,64.16a63.72,63.72,0,0,1-41.66-14,63.71,63.71,0,0,1-41.65,14c-33.93-.86-62.44-30.22-62.35-64.16a64,64,0,0,1,40.13-59.2,68,68,0,0,1,127.74,0A64,64,0,0,1,232,127.82Z" class="d"/><path d="M198.1,62.59a76,76,0,0,0-140.2,0A71.71,71.71,0,0,0,16,127.8C15.9,166,48,199,86.14,200A72.22,72.22,0,0,0,120,192.47V232a8,8,0,0,0,16,0V192.47A72.17,72.17,0,0,0,168,200l1.82,0C208,199,240.11,166,240,127.8A71.71,71.71,0,0,0,198.1,62.59ZM169.45,184a56.08,56.08,0,0,1-33.45-10v-41l43.58-21.78a8,8,0,1,0-7.16-14.32L136,115.06V88a8,8,0,0,0-16,0v51.06L83.58,120.84a8,8,0,1,0-7.16,14.32L120,156.94v17a56,56,0,0,1-33.45,10C56.9,183.23,31.92,157.52,32,127.84A55.79,55.79,0,0,1,67.11,76a8,8,0,0,0,4.53-4.67,60,60,0,0,1,112.72,0A8,8,0,0,0,188.89,76,55.79,55.79,0,0,1,224,127.84C224.08,157.52,199.1,183.23,169.45,184Z"/>',
  'museum': '<path d="M232,96H24L128,32Z" class="d"/><path d="M24,104H48v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16H208V104h24a8,8,0,0,0,4.19-14.81l-104-64a8,8,0,0,0-8.38,0l-104,64A8,8,0,0,0,24,104Zm40,0H96v64H64Zm80,0v64H112V104Zm48,64H160V104h32ZM128,41.39,203.74,88H52.26ZM248,208a8,8,0,0,1-8,8H16a8,8,0,0,1,0-16H240A8,8,0,0,1,248,208Z"/>',
  'flower': '<path d="M206.35,136.29c-8.87-5.13-24.46-7.38-39.4-8.29,14.94-.91,30.53-3.16,39.4-8.29a32,32,0,1,0-32-55.42c-8.87,5.12-18.61,17.48-26.87,30C154.17,80.87,160,66.25,160,56a32,32,0,0,0-64,0c0,10.25,5.83,24.87,12.52,38.26-8.26-12.49-18-24.85-26.87-30a32,32,0,1,0-32,55.42c8.87,5.13,24.46,7.38,39.4,8.29-14.94.91-30.53,3.16-39.4,8.29a32,32,0,1,0,32,55.42c8.87-5.12,18.61-17.48,26.87-30C101.83,175.13,96,189.75,96,200a32,32,0,0,0,64,0c0-10.25-5.83-24.87-12.52-38.26,8.26,12.49,18,24.85,26.87,30a32,32,0,1,0,32-55.42ZM155.71,144A32,32,0,1,1,160,128,31.74,31.74,0,0,1,155.71,144Z" class="d"/><path d="M210.35,129.36c-.81-.47-1.7-.92-2.62-1.36.92-.44,1.81-.89,2.62-1.36a40,40,0,1,0-40-69.28c-.81.47-1.65,1-2.48,1.59.08-1,.13-2,.13-3a40,40,0,0,0-80,0c0,.94,0,1.94.13,3-.83-.57-1.67-1.12-2.48-1.59a40,40,0,1,0-40,69.28c.81.47,1.7.92,2.62,1.36-.92.44-1.81.89-2.62,1.36a40,40,0,1,0,40,69.28c.81-.47,1.65-1,2.48-1.59-.08,1-.13,2-.13,2.95a40,40,0,0,0,80,0c0-.94-.05-1.94-.13-2.95.83.57,1.67,1.12,2.48,1.59A39.79,39.79,0,0,0,190.29,204a40.43,40.43,0,0,0,10.42-1.38,40,40,0,0,0,9.64-73.28ZM104,128a24,24,0,1,1,24,24A24,24,0,0,1,104,128Zm74.35-56.79a24,24,0,1,1,24,41.57c-6.27,3.63-18.61,6.13-35.16,7.19A40,40,0,0,0,154.53,98.1C163.73,84.28,172.08,74.84,178.35,71.21ZM128,32a24,24,0,0,1,24,24c0,7.24-4,19.19-11.36,34.06a39.81,39.81,0,0,0-25.28,0C108,75.19,104,63.24,104,56A24,24,0,0,1,128,32ZM44.86,80a24,24,0,0,1,32.79-8.79c6.27,3.63,14.62,13.07,23.82,26.89A40,40,0,0,0,88.81,120c-16.55-1.06-28.89-3.56-35.16-7.18A24,24,0,0,1,44.86,80ZM77.65,184.79a24,24,0,1,1-24-41.57c6.27-3.63,18.61-6.13,35.16-7.19a40,40,0,0,0,12.66,21.87C92.27,171.72,83.92,181.16,77.65,184.79ZM128,224a24,24,0,0,1-24-24c0-7.24,4-19.19,11.36-34.06a39.81,39.81,0,0,0,25.28,0C148,180.81,152,192.76,152,200A24,24,0,0,1,128,224Zm83.14-48a24,24,0,0,1-32.79,8.79c-6.27-3.63-14.62-13.07-23.82-26.89A40,40,0,0,0,167.19,136c16.55,1.06,28.89,3.56,35.16,7.18A24,24,0,0,1,211.14,176Z"/>',
  'art': '<path d="M224,127.17a96.48,96.48,0,0,1-2.39,22.18A24,24,0,0,1,198.21,168H152a24,24,0,0,0-24,24,24,24,0,0,1-32,22.61C58.73,201.44,32,169.81,32,128a96,96,0,0,1,95-96C179.84,31.47,223.55,74.35,224,127.17Z" class="d"/><path d="M200.77,53.89A103.27,103.27,0,0,0,128,24h-1.07A104,104,0,0,0,24,128c0,43,26.58,79.06,69.36,94.17A32,32,0,0,0,136,192a16,16,0,0,1,16-16h46.21a31.81,31.81,0,0,0,31.2-24.88,104.43,104.43,0,0,0,2.59-24A103.28,103.28,0,0,0,200.77,53.89Zm13,93.71A15.89,15.89,0,0,1,198.21,160H152a32,32,0,0,0-32,32,16,16,0,0,1-21.31,15.07C62.49,194.3,40,164,40,128a88,88,0,0,1,87.09-88h.9a88.35,88.35,0,0,1,88,87.25A88.86,88.86,0,0,1,213.81,147.6ZM140,76a12,12,0,1,1-12-12A12,12,0,0,1,140,76ZM96,100A12,12,0,1,1,84,88,12,12,0,0,1,96,100Zm0,56a12,12,0,1,1-12-12A12,12,0,0,1,96,156Zm88-56a12,12,0,1,1-12-12A12,12,0,0,1,184,100Z"/>',
  'bridge': '<path d="M232,168H24V115.35A64,64,0,0,0,64,56a64,64,0,0,0,128,0,64,64,0,0,0,40,59.35Z" class="d"/><path d="M232,160H200V101.34a71.89,71.89,0,0,0,29,21.42,8,8,0,0,0,6-14.83A55.78,55.78,0,0,1,200,56a8,8,0,0,0-16,0A56,56,0,0,1,72,56a8,8,0,0,0-16,0,55.78,55.78,0,0,1-35,51.93,8,8,0,0,0,6,14.83,71.89,71.89,0,0,0,29-21.42V160H24a8,8,0,0,0,0,16H56v24a8,8,0,0,0,16,0V176H184v24a8,8,0,0,0,16,0V176h32a8,8,0,0,0,0-16Zm-88-33.8V160H112V126.2a72,72,0,0,0,32,0Zm-72-25a72.47,72.47,0,0,0,24,19.27V160H72ZM160,160V120.48a72.47,72.47,0,0,0,24-19.27V160Z"/>',
  'sunset': '<path d="M192,144a64.33,64.33,0,0,1-2,16H66a64,64,0,1,1,126-16Z" class="d"/><path d="M240,152H199.55a73.54,73.54,0,0,0,.45-8,72,72,0,0,0-144,0,73.54,73.54,0,0,0,.45,8H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM72,144a56,56,0,1,1,111.41,8H72.59A56.13,56.13,0,0,1,72,144Zm144,56a8,8,0,0,1-8,8H48a8,8,0,0,1,0-16H208A8,8,0,0,1,216,200ZM72.84,43.58a8,8,0,0,1,14.32-7.16l8,16a8,8,0,0,1-14.32,7.16Zm-56,48.84a8,8,0,0,1,10.74-3.57l16,8a8,8,0,0,1-7.16,14.31l-16-8A8,8,0,0,1,16.84,92.42Zm192,15.16a8,8,0,0,1,3.58-10.73l16-8a8,8,0,1,1,7.16,14.31l-16,8a8,8,0,0,1-10.74-3.58Zm-48-55.16,8-16a8,8,0,0,1,14.32,7.16l-8,16a8,8,0,1,1-14.32-7.16Z"/>',
  'id': '<path d="M216,48H40a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H216a8,8,0,0,0,8-8V56A8,8,0,0,0,216,48ZM96,144a24,24,0,1,1,24-24A24,24,0,0,1,96,144Z" class="d"/><path d="M200,112a8,8,0,0,1-8,8H152a8,8,0,0,1,0-16h40A8,8,0,0,1,200,112Zm-8,24H152a8,8,0,0,0,0,16h40a8,8,0,0,0,0-16Zm40-80V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,200V56H40V200H216Zm-80.26-34a8,8,0,1,1-15.5,4c-2.63-10.26-13.06-18-24.25-18s-21.61,7.74-24.25,18a8,8,0,1,1-15.5-4,39.84,39.84,0,0,1,17.19-23.34,32,32,0,1,1,45.12,0A39.76,39.76,0,0,1,135.75,166ZM96,136a16,16,0,1,0-16-16A16,16,0,0,0,96,136Z"/>',
  'video': '<path d="M200,72V184a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V72a8,8,0,0,1,8-8H192A8,8,0,0,1,200,72Z" class="d"/><path d="M251.77,73a8,8,0,0,0-8.21.39L208,97.05V72a16,16,0,0,0-16-16H32A16,16,0,0,0,16,72V184a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V159l35.56,23.71A8,8,0,0,0,248,184a8,8,0,0,0,8-8V80A8,8,0,0,0,251.77,73ZM192,184H32V72H192V184Zm48-22.95-32-21.33V116.28L240,95Z"/>',
  'clip': '<path d="M180.75,104.75,204,128l-82.06,81.94a48,48,0,0,1-67.88-67.88L153.37,41.37a32,32,0,0,1,45.26,45.26Z" class="d"/><path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z"/>',
  'money': '<path d="M160,128a32,32,0,1,1-32-32A32,32,0,0,1,160,128Zm40-64a48.85,48.85,0,0,0,40,40V64Zm0,128h40V152A48.85,48.85,0,0,0,200,192ZM16,152v40H56A48.85,48.85,0,0,0,16,152Zm0-48A48.85,48.85,0,0,0,56,64H16Z" class="d"/><path d="M128,88a40,40,0,1,0,40,40A40,40,0,0,0,128,88Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,152ZM240,56H16a8,8,0,0,0-8,8V192a8,8,0,0,0,8,8H240a8,8,0,0,0,8-8V64A8,8,0,0,0,240,56ZM24,72H45.37A40.81,40.81,0,0,1,24,93.37Zm0,112V162.63A40.81,40.81,0,0,1,45.37,184Zm208,0H210.63A40.81,40.81,0,0,1,232,162.63Zm0-38.35A56.78,56.78,0,0,0,193.65,184H62.35A56.78,56.78,0,0,0,24,145.65v-35.3A56.78,56.78,0,0,0,62.35,72h131.3A56.78,56.78,0,0,0,232,110.35Zm0-52.28A40.81,40.81,0,0,1,210.63,72H232Z"/>',
  'wx-sun': '<path d="M184,128a56,56,0,1,1-56-56A56,56,0,0,1,184,128Z" class="d"/><path d="M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z"/>',
  'wx-partly': '<path d="M139.84,84.41v0a68.22,68.22,0,0,0-41.65,46v-.11a44.08,44.08,0,0,0-38.54,5h0a48,48,0,1,1,80.19-50.94Z" class="d"/><path d="M164,72a76.2,76.2,0,0,0-20.26,2.73,55.63,55.63,0,0,0-9.41-11.54l9.51-13.57a8,8,0,1,0-13.11-9.18L121.22,54A55.9,55.9,0,0,0,96,48c-.58,0-1.16,0-1.74,0L91.37,31.71a8,8,0,1,0-15.75,2.77L78.5,50.82A56.1,56.1,0,0,0,55.23,65.67L41.61,56.14a8,8,0,1,0-9.17,13.11L46,78.77A55.55,55.55,0,0,0,40,104c0,.57,0,1.15,0,1.72L23.71,108.6a8,8,0,0,0,1.38,15.88,8.24,8.24,0,0,0,1.39-.12l16.32-2.88a55.74,55.74,0,0,0,5.86,12.42A52,52,0,0,0,84,224h80a76,76,0,0,0,0-152ZM56,104a40,40,0,0,1,72.54-23.24,76.26,76.26,0,0,0-35.62,40,52.14,52.14,0,0,0-31,4.17A40,40,0,0,1,56,104ZM164,208H84a36,36,0,1,1,4.78-71.69c-.37,2.37-.63,4.79-.77,7.23a8,8,0,0,0,16,.92,58.91,58.91,0,0,1,1.88-11.81c0-.16.09-.32.12-.48A60.06,60.06,0,1,1,164,208Z"/>',
  'wx-cloud': '<path d="M240,128a80,80,0,0,1-80,80H72A56,56,0,1,1,85.92,97.74l0,.1A80,80,0,0,1,240,128Z" class="d"/><path d="M160,40A88.09,88.09,0,0,0,81.29,88.67,64,64,0,1,0,72,216h88a88,88,0,0,0,0-176Zm0,160H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.29.11A88,88,0,0,0,72,128a8,8,0,0,0,16,0,72,72,0,1,1,72,72Z"/>',
  'wx-fog': '<path d="M224,100a68,68,0,0,1-68,68H76A44,44,0,1,1,90.2,82.34v.11A68.06,68.06,0,0,1,224,100Z" class="d"/><path d="M120,208H72a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm64-16H160a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Zm-24,32H104a8,8,0,0,0,0,16h56a8,8,0,0,0,0-16Zm72-124a76.08,76.08,0,0,1-76,76H76A52,52,0,0,1,76,72a53.26,53.26,0,0,1,8.92.76A76.08,76.08,0,0,1,232,100Zm-16,0A60.06,60.06,0,0,0,96,96.46a8,8,0,0,1-16-.92q.21-3.66.77-7.23A38.11,38.11,0,0,0,76,88a36,36,0,0,0,0,72h80A60.07,60.07,0,0,0,216,100Z"/>',
  'wx-rain': '<path d="M224,92a68,68,0,0,1-68,68H76A44,44,0,1,1,90.2,74.34v.11A68.06,68.06,0,0,1,224,92Z" class="d"/><path d="M158.66,196.44l-32,48a8,8,0,1,1-13.32-8.88l32-48a8,8,0,0,1,13.32,8.88ZM232,92a76.08,76.08,0,0,1-76,76H132.28l-29.62,44.44a8,8,0,1,1-13.32-8.88L113.05,168H76A52,52,0,0,1,76,64a53.26,53.26,0,0,1,8.92.76A76.08,76.08,0,0,1,232,92Zm-16,0A60.06,60.06,0,0,0,96,88.46a8,8,0,0,1-16-.92q.21-3.66.77-7.23A38.11,38.11,0,0,0,76,80a36,36,0,0,0,0,72h80A60.07,60.07,0,0,0,216,92Z"/>',
  'wx-snow': '<path d="M224,92a68,68,0,0,1-68,68H76A44,44,0,1,1,90.2,74.34v.11A68.06,68.06,0,0,1,224,92Z" class="d"/><path d="M88,196a12,12,0,1,1-12-12A12,12,0,0,1,88,196Zm28,4a12,12,0,1,0,12,12A12,12,0,0,0,116,200Zm48-16a12,12,0,1,0,12,12A12,12,0,0,0,164,184ZM68,224a12,12,0,1,0,12,12A12,12,0,0,0,68,224Zm88,0a12,12,0,1,0,12,12A12,12,0,0,0,156,224ZM232,92a76.08,76.08,0,0,1-76,76H76A52,52,0,0,1,76,64a53.26,53.26,0,0,1,8.92.76A76.08,76.08,0,0,1,232,92Zm-16,0A60.06,60.06,0,0,0,96,88.46a8,8,0,0,1-16-.92q.21-3.66.77-7.23A38.11,38.11,0,0,0,76,80a36,36,0,0,0,0,72h80A60.07,60.07,0,0,0,216,92Z"/>',
  'wx-storm': '<path d="M224,92a68,68,0,0,1-68,68H76A44,44,0,1,1,90.2,74.34v.11A68.06,68.06,0,0,1,224,92Z" class="d"/><path d="M156,16A76.2,76.2,0,0,0,84.92,64.76,53.26,53.26,0,0,0,76,64a52,52,0,0,0,0,104h37.87L97.14,195.88A8,8,0,0,0,104,208h25.87l-16.73,27.88a8,8,0,0,0,13.72,8.24l24-40A8,8,0,0,0,144,192H118.13l14.4-24H156a76,76,0,0,0,0-152Zm0,136H76a36,36,0,0,1,0-72,38.11,38.11,0,0,1,4.78.31q-.56,3.57-.77,7.23a8,8,0,0,0,16,.92A60.06,60.06,0,1,1,156,152Z"/>',
  'umbrella': '<path d="M128,32S88,64,88,136H32a8,8,0,0,1-8-8.71A104.21,104.21,0,0,1,128,32Zm104,95.29A104.21,104.21,0,0,0,128,32s40,32,40,104h56A8,8,0,0,0,232,127.29Z" class="d"/><path d="M240,126.63A112.44,112.44,0,0,0,51.75,53.75a111.56,111.56,0,0,0-35.7,72.88A16,16,0,0,0,32,144h88v56a32,32,0,0,0,64,0,8,8,0,0,0-16,0,16,16,0,0,1-32,0V144h88a16,16,0,0,0,16-17.37ZM32,128l0,0a96.15,96.15,0,0,1,76.2-85.89C96.48,58,81.85,86.11,80.17,128Zm64.15,0c1.39-30.77,10.53-52.81,18.3-66.24A106.44,106.44,0,0,1,128,43.16a106.31,106.31,0,0,1,13.52,18.6C154.8,84.7,159,109.28,159.82,128Zm79.65,0c-1.68-41.89-16.31-70-28-85.94A96.07,96.07,0,0,1,224,128Z"/>',
  'temp': '<path d="M152,138V48a32,32,0,0,0-64,0v90a56,56,0,1,0,64,0Zm-32,70a24,24,0,1,1,24-24A24,24,0,0,1,120,208Z" class="d"/><path d="M212,56a28,28,0,1,0,28,28A28,28,0,0,0,212,56Zm0,40a12,12,0,1,1,12-12A12,12,0,0,1,212,96Zm-84,57V88a8,8,0,0,0-16,0v65a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,120,200Zm40-66V48a40,40,0,0,0-80,0v86a64,64,0,1,0,80,0Zm-40,98a48,48,0,0,1-27.42-87.4A8,8,0,0,0,96,138V48a24,24,0,0,1,48,0v90a8,8,0,0,0,3.42,6.56A48,48,0,0,1,120,232Z"/>',
  'coat': '<path d="M231.72,131.51,210.28,210.1a8,8,0,0,1-7.71,5.9H176a8,8,0,0,1-8-8V184H88v24a8,8,0,0,1-8,8H53.43a8,8,0,0,1-7.71-5.9L24.28,131.51A8,8,0,0,1,25.34,125L72,55l56,33,56-33,46.66,70A8,8,0,0,1,231.72,131.51Z" class="d"/><path d="M237.31,120.53,183,39.12A16,16,0,0,0,169.73,32H86.27A16,16,0,0,0,73,39.12L18.69,120.53a16,16,0,0,0-2.13,13.09L38,212.21A16,16,0,0,0,53.43,224H80a16,16,0,0,0,16-16V192h64v16a16,16,0,0,0,16,16h26.57A16,16,0,0,0,218,212.21l21.44-78.59A16,16,0,0,0,237.31,120.53ZM80,176V69l24,14.15V136a8,8,0,0,0,16,0V92.57l3.94,2.32a8,8,0,0,0,8.12,0L136,92.57V128a8,8,0,0,0,16,0V83.14L176,69V176ZM169.73,48l2.92,4.39L128,78.71,83.35,52.39,86.27,48ZM80,208H53.43L32,129.41l32-48V176a16,16,0,0,0,16,16Zm122.57,0H176V192a16,16,0,0,0,16-16V81.41l32,48Z"/>',
  'tshirt': '<path d="M247.11,78.77l-19.27,36.81a8.44,8.44,0,0,1-7.5,4.42H192V40l51.78,28.25A7.81,7.81,0,0,1,247.11,78.77Zm-238.22,0,19.27,36.81a8.44,8.44,0,0,0,7.5,4.42H64V40L12.22,68.25A7.81,7.81,0,0,0,8.89,78.77Z" class="d"/><path d="M247.59,61.22,195.83,33A8,8,0,0,0,192,32H160a8,8,0,0,0-8,8,24,24,0,0,1-48,0,8,8,0,0,0-8-8H64a8,8,0,0,0-3.84,1L8.41,61.22A15.76,15.76,0,0,0,1.82,82.48l19.27,36.81A16.37,16.37,0,0,0,35.67,128H56v80a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V128h20.34a16.37,16.37,0,0,0,14.58-8.71l19.27-36.81A15.76,15.76,0,0,0,247.59,61.22ZM35.67,112a.62.62,0,0,1-.41-.13L16.09,75.26,56,53.48V112ZM184,208H72V48h16.8a40,40,0,0,0,78.38,0H184Zm36.75-96.14a.55.55,0,0,1-.41.14H200V53.48l39.92,21.78Z"/>',
  'nav': '<path d="M234.35,129,152,152,129,234.35a8,8,0,0,1-15.21.27l-65.28-176A8,8,0,0,1,58.63,48.46l176,65.28A8,8,0,0,1,234.35,129Z" class="d"/><path d="M237.33,106.21,61.41,41l-.16-.05A16,16,0,0,0,40.9,61.25a1,1,0,0,0,.05.16l65.26,175.92A15.77,15.77,0,0,0,121.28,248h.3a15.77,15.77,0,0,0,15-11.29l.06-.2,21.84-78,78-21.84.2-.06a16,16,0,0,0,.62-30.38ZM149.84,144.3a8,8,0,0,0-5.54,5.54L121.3,232l-.06-.17L56,56l175.82,65.22.16.06Z"/>',
  'ja': '<path d="M224,184H144l40-80ZM96,127.56h0A95.78,95.78,0,0,0,128,56H64A95.78,95.78,0,0,0,96,127.56Z" class="d"/><path d="M247.15,212.42l-56-112a8,8,0,0,0-14.31,0l-21.71,43.43A88,88,0,0,1,108,126.93,103.65,103.65,0,0,0,135.69,64H160a8,8,0,0,0,0-16H104V32a8,8,0,0,0-16,0V48H32a8,8,0,0,0,0,16h87.63A87.7,87.7,0,0,1,96,116.35a87.74,87.74,0,0,1-19-31,8,8,0,1,0-15.08,5.34A103.63,103.63,0,0,0,84,127a87.55,87.55,0,0,1-52,17,8,8,0,0,0,0,16,103.46,103.46,0,0,0,64-22.08,104.18,104.18,0,0,0,51.44,21.31l-26.6,53.19a8,8,0,0,0,14.31,7.16L148.94,192h70.11l13.79,27.58A8,8,0,0,0,240,224a8,8,0,0,0,7.15-11.58ZM156.94,176,184,121.89,211.05,176Z"/>',
  'phone': '<path d="M223.94,174.08A48.33,48.33,0,0,1,176,216,136,136,0,0,1,40,80,48.33,48.33,0,0,1,81.92,32.06a8,8,0,0,1,8.3,4.8l21.13,47.2a8,8,0,0,1-.66,7.53L89.32,117a7.93,7.93,0,0,0-.54,7.81c8.27,16.93,25.77,34.22,42.75,42.41a7.92,7.92,0,0,0,7.83-.59l25-21.3a8,8,0,0,1,7.59-.69l47.16,21.13A8,8,0,0,1,223.94,174.08Z" class="d"/><path d="M222.37,158.46l-47.11-21.11-.13-.06a16,16,0,0,0-15.17,1.4,8.12,8.12,0,0,0-.75.56L134.87,160c-15.42-7.49-31.34-23.29-38.83-38.51l20.78-24.71c.2-.25.39-.5.57-.77a16,16,0,0,0,1.32-15.06l0-.12L97.54,33.64a16,16,0,0,0-16.62-9.52A56.26,56.26,0,0,0,32,80c0,79.4,64.6,144,144,144a56.26,56.26,0,0,0,55.88-48.92A16,16,0,0,0,222.37,158.46ZM176,208A128.14,128.14,0,0,1,48,80,40.2,40.2,0,0,1,82.87,40a.61.61,0,0,0,0,.12l21,47L83.2,111.86a6.13,6.13,0,0,0-.57.77,16,16,0,0,0-1,15.7c9.06,18.53,27.73,37.06,46.46,46.11a16,16,0,0,0,15.75-1.14,8.44,8.44,0,0,0,.74-.56L168.89,152l47,21.05h0s.08,0,.11,0A40.21,40.21,0,0,1,176,208Z"/>',
  'ext': '<path d="M184,80V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8H176A8,8,0,0,1,184,80Z" class="d"/><path d="M224,104a8,8,0,0,1-16,0V59.32l-66.33,66.34a8,8,0,0,1-11.32-11.32L196.68,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z"/>',
  'copy': '<path d="M216,40V168H168V88H88V40Z" class="d"/><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/>',
  'sound': '<path d="M80,88v80H32a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8Z" class="d"/><path d="M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z"/>',
  'home': '<path d="M216,120v96H152V152H104v64H40V120a8,8,0,0,1,2.34-5.66l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,216,120Z" class="d"/><path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z"/>',
  'plus': '<path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/>',
  'swap': '<path d="M213.66,181.66l-32,32a8,8,0,0,1-11.32-11.32L188.69,184H48a8,8,0,0,1,0-16H188.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,213.66,181.66Zm-139.32-64a8,8,0,0,0,11.32-11.32L67.31,88H208a8,8,0,0,0,0-16H67.31L85.66,53.66A8,8,0,0,0,74.34,42.34l-32,32a8,8,0,0,0,0,11.32Z"/>',
  'refresh': '<path d="M216,128a88,88,0,1,1-88-88A88,88,0,0,1,216,128Z" class="d"/><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/>',
  'check': '<path d="M205.66,85.66l-96,96a8,8,0,0,1-11.32,0l-40-40a8,8,0,0,1,11.32-11.32L104,164.69l90.34-90.35a8,8,0,0,1,11.32,11.32Z"/>',
  'x': '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>',
  'pin': '<path d="M128,24a80,80,0,0,0-80,80c0,72,80,128,80,128s80-56,80-128A80,80,0,0,0,128,24Zm0,112a32,32,0,1,1,32-32A32,32,0,0,1,128,136Z" class="d"/><path d="M128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Zm0-112a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Z"/>',
  'ticket': '<path d="M200,128a32,32,0,0,0,32,32v32a8,8,0,0,1-8,8H96V56H224a8,8,0,0,1,8,8V96A32,32,0,0,0,200,128Z" class="d"/><path d="M232,104a8,8,0,0,0,8-8V64a16,16,0,0,0-16-16H32A16,16,0,0,0,16,64V96a8,8,0,0,0,8,8,24,24,0,0,1,0,48,8,8,0,0,0-8,8v32a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V160a8,8,0,0,0-8-8,24,24,0,0,1,0-48ZM32,167.2a40,40,0,0,0,0-78.4V64H88V192H32Zm192,0V192H104V64H224V88.8a40,40,0,0,0,0,78.4Z"/>',
  'calendar': '<path d="M216,48V88H40V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z" class="d"/><path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-68-76a12,12,0,1,1-12-12A12,12,0,0,1,140,132Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,132ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,140,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
  'checklist': '<path d="M216,48V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z" class="d"/><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM224,48V208a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM208,208V48H48V208H208Z"/>',
  'warn': '<path d="M215.46,216H40.54C27.92,216,20,202.79,26.13,192.09L113.59,40.22c6.3-11,22.52-11,28.82,0l87.46,151.87C236,202.79,228.08,216,215.46,216Z" class="d"/><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/>',
  'lock': '<path d="M216,96V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8H208A8,8,0,0,1,216,96Z" class="d"/><path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"/>',
  'thumb': '<path d="M80,104V208H32a8,8,0,0,1-8-8V112a8,8,0,0,1,8-8Z" class="d"/><path d="M234,80.12A24,24,0,0,0,216,72H160V56a40,40,0,0,0-40-40,8,8,0,0,0-7.16,4.42L75.06,96H32a16,16,0,0,0-16,16v88a16,16,0,0,0,16,16H204a24,24,0,0,0,23.82-21l12-96A24,24,0,0,0,234,80.12ZM32,112H72v88H32ZM223.94,97l-12,96a8,8,0,0,1-7.94,7H88V105.89l36.71-73.43A24,24,0,0,1,144,56V80a8,8,0,0,0,8,8h64a8,8,0,0,1,7.94,9Z"/>',
  'thumb-down': '<g transform="matrix(1 0 0 -1 0 256)"><path d="M80,104V208H32a8,8,0,0,1-8-8V112a8,8,0,0,1,8-8Z" class="d"/><path d="M234,80.12A24,24,0,0,0,216,72H160V56a40,40,0,0,0-40-40,8,8,0,0,0-7.16,4.42L75.06,96H32a16,16,0,0,0-16,16v88a16,16,0,0,0,16,16H204a24,24,0,0,0,23.82-21l12-96A24,24,0,0,0,234,80.12ZM32,112H72v88H32ZM223.94,97l-12,96a8,8,0,0,1-7.94,7H88V105.89l36.71-73.43A24,24,0,0,1,144,56V80a8,8,0,0,0,8,8h64a8,8,0,0,1,7.94,9Z"/></g>',
  'clock': '<path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z" class="d"/><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"/>',
  'torii': '<path class="d" d="M40 60Q128 80 216 60L208 88H48Z"/><g fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M32 56Q128 80 224 56M48 88H208M64 124H192M80 88V216M176 88V216"/></g>',
  'tower': '<path class="d" d="M116 88H140L164 224H92Z"/><g fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M128 16V52M108 52H148V84H108ZM116 84L92 224M140 84L164 224M106 144H150M72 224H184"/></g>',
  'lantern': '<ellipse class="d" cx="128" cy="128" rx="60" ry="68"/><g fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M128 24V44M104 44H152M104 212H152M128 212V232"/><ellipse cx="128" cy="128" rx="60" ry="68"/><path d="M72 104Q128 120 184 104M72 152Q128 168 184 152"/></g>',
};
// trip.json marks items with an emoji; the app draws the matching icon in a category colour instead.
const GLYPHS = {
  '🚌': 'bus move', '🧳': 'luggage move', '✈': 'plane move', '🚶': 'walk move', '🚄': 'train move', '🚇': 'metro move',
  '🚃': 'local move', '🚝': 'tram move', '🚉': 'station move', '🛄': 'baggage move', '🛂': 'id move',
  '🍽': 'meal eat', '🍳': 'breakfast eat', '🍣': 'sushi eat', '🍜': 'ramen eat', '☕': 'coffee eat',
  '🛍': 'shop shop', '👔': 'fashion shop', '⌚': 'watch shop', '💴': 'money shop', '🎥': 'video shop',
  '🏨': 'bed rest', '📎': 'clip rest', '🛋': 'coffee rest', '🎫': 'ticket move',
  '🎮': 'game see', '🌳': 'park see', '🏛': 'museum see', '⛩': 'torii see', '🗼': 'tower see', '🌺': 'flower see',
  '🎨': 'art see', '🌉': 'bridge see', '🏮': 'lantern see', '🌇': 'sunset see', '🌤': 'wx-partly see',
};
const glyph = (emoji) => (GLYPHS[String(emoji || '').replace(/\uFE0F/g, '')] || 'pin see').split(' ');
const itemIcon = (emoji, cls = '') => { const [name, kind] = glyph(emoji); return `<span class="ii ${kind} ${cls}">${icon(name)}</span>`; };
// Reservation tab headings share their icon with the shortcut that jumps to them.
const secIcon = (name) => (name === 'spark' ? aiBadge('set') : `<span class="ii sm sec">${icon(name)}</span>`);
// Anything Claude does gets the same mark: the sparkle, the AI color and an "AI" pill (see DESIGN.md › AI).
// The same badge as AI 도우미 in 예약 탭 (sparkle in a soft purple square) marks every AI button.
// The AI badge alone (titles of AI sheets) and the small one inside result tags.
const aiBadge = (cls = '') => `<span class="ai-mark ${cls}">${icon('aimark')}</span>`;
// AI 마크: 평소엔 별만. 버튼을 누를 때·AI 창이 열릴 때 한 번 '별 → 캐릭터 → 별' (DESIGN.md › AI).
const AI_BTN = '.btn.ai, .finder-go.ai, .day-sum-row.ai';
const aiPlay = (m) => { if (!m) return; m.classList.remove('play'); void m.offsetWidth; m.classList.add('play'); };
document.addEventListener('pointerdown', (e) => { const b = e.target.closest?.(AI_BTN); if (b) aiPlay(b.querySelector('.ai-mark')); }, { passive: true });
let aiTitle = '';
new MutationObserver(() => {
  const h = $('#sheet-body .ai-h');
  const t = h && !$('#sheet').hidden ? h.textContent : '';
  if (t && t !== aiTitle) aiPlay(h.querySelector('.ai-mark'));
  aiTitle = t;
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
// AI 도우미 캐릭터 (DESIGN.md › AI): 말풍선 몸 + 반짝이, 표정만 바뀌어요. main 인사 · thinking 일하는 중 · done 다 됐어요 · sorry 잘 안 됐어요.
const AI_FACE = {
  main: '<g fill="#6A4FC4"><rect x="416" y="498" width="42" height="83" rx="21"/><rect x="622" y="498" width="42" height="83" rx="21"/><path d="M503 637Q540 676 577 637" fill="none" stroke="#6A4FC4" stroke-width="20" stroke-linecap="round"/></g>',
  thinking: '<g fill="#6A4FC4"><rect x="426" y="487" width="42" height="76" rx="21"/><rect x="632" y="487" width="42" height="76" rx="21"/><path d="M522 650Q544 642 563 650" fill="none" stroke="#6A4FC4" stroke-width="18" stroke-linecap="round"/></g>',
  done: '<g fill="#6A4FC4"><path d="M408 543Q437 510 466 543M614 543Q643 510 672 543" fill="none" stroke="#6A4FC4" stroke-width="20" stroke-linecap="round"/><path d="M495 630Q540 651 585 630Q579 688 540 688Q501 688 495 630Z"/></g>',
  sorry: '<g fill="#6A4FC4"><path d="M410 492l44-14M626 478l44 14" fill="none" stroke="#6A4FC4" stroke-width="14" stroke-linecap="round"/><rect x="419" y="525" width="36" height="61" rx="18"/><rect x="625" y="525" width="36" height="61" rx="18"/><path d="M515 659Q540 639 565 659" fill="none" stroke="#6A4FC4" stroke-width="17" stroke-linecap="round"/></g>',
};
const aiChar = (mood = 'main', cls = '') => `<svg class="ai-char ${cls}" viewBox="0 0 1024 1024" aria-hidden="true"><path fill="#6A4FC4" d="M900 536C900 337.18 738.82 176 540 176S180 337.18 180 536s161.18 360 360 360c75 0 145-23 203-62l155 39c27 7 40-8 23-30l-94-119c46-60 73-119 73-188Z"/><rect x="274" y="383" width="532" height="381" rx="174" fill="#EFEAFB"/>${AI_FACE[mood] || AI_FACE.main}<g transform="translate(24 20)"><path d="M196 153C211 153 224 204 246 225s72 34 72 49-50 28-72 49-35 72-50 72-28-51-50-72-72-34-72-49 50-28 72-49 35-72 50-72Z" fill="#6A4FC4" stroke="white" stroke-width="15" stroke-linejoin="round"/><path d="M196 216c12 34 24 46 58 58-34 12-46 24-58 58-12-34-24-46-58-58 34-12 46-24 58-58Z" fill="white"/></g></svg>`;
// AI가 실패했을 때: 미안해하는 캐릭터 + 호박색 안내 (이유와 할 일).
// AI 결과가 막 나왔을 때: '완료' 캐릭터 + 다 됐어요 + 무엇을 확인할지.
const aiDone = (what) => `<div class="ai-done">${aiChar('done')}<span><b>다 됐어요, 확인해 주세요</b><small>${what}</small></span></div>`;
const aiFail = (msg) => `<div class="ai-note ai-fail">${aiChar('sorry')}<span>${esc(msg)}</span></div>`;
const aiTag = (text) => `<span class="ai-tag">${aiBadge('xs')}${text}</span>`;
// Every AI button gets the same sparkle badge; a photo feature says so in its words, not by swapping the badge.
const aiLabel = (text) => `${aiBadge()}<span>${text}</span>`;
const stripEmoji = (s) => String(s || '').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
const wxIcon = (name) => icon(name, 'wxi ' + name);
// 쌍따봉: two thumbs-up side by side, for 강력 추천.
ICONS.thumbs2 = `<g transform="translate(-6 38) scale(.71)" opacity=".55">${ICONS.thumb}</g><g transform="translate(74 38) scale(.71)">${ICONS.thumb}</g>`;
// The AI mark is cropped to its own shape so it fills the button slot instead of floating in padding.
const ICON_VB = { aimark: '24 42 212 194' };
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="${ICON_VB[name] || '0 0 256 256'}" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- views ----------
// The flight that matters today, with the plane parked at the end of the line it's on.
function flightRoute(now) {
  const [out, back] = state.trip.flights;
  if (!out || !back) return ''; // 항공편을 아직 안 넣은 여행
  const f = now.date < back.date ? out : back;
  const start = toMin(f.depart);
  const end = toMin(f.arrive);
  const before = now.date < f.date || (now.date === f.date && now.min < start);
  const after = now.date > f.date || (now.date === f.date && now.min >= end);
  const at = before ? 0 : after ? 100 : ((now.min - start) / (end - start)) * 100;
  return `<div class="route ${after ? 'arrived' : ''}" style="--at:${at}%"><b>${esc(f.from)}</b><i></i><b>${esc(f.to)}</b></div>`;
}

// New version notice at the top of today; it pulses for its first three seconds, and closing it lasts until the app is reopened.
function updateBand() {
  if (!(state.latest > APP_VERSION) || state.bandOff) return '';
  state.bandAt ||= Date.now();
  const fresh = Date.now() - state.bandAt < 3000;
  return `
    <div class="update-band ${fresh ? 'fresh' : ''}">
      <span class="grow">새 버전 v${state.latest}이 있어요</span>
      <button class="band-go" data-update>지금 업데이트</button>
      <button class="band-x" data-band-off aria-label="닫기">${icon('x')}</button>
    </div>`;
}

// Days already behind us count as done even without a stamp; the current day joins once it's stamped.
const isDayDone = (date, today = tokyoNow().date) => date < today || store.get('seal:' + date, false);

// End of the day: a goshuin-style stamp to press, one per day, with the day's tally and tomorrow's first stop.
// The card's sky follows the weather outside right now, the way the iPhone Weather app does:
// stars and moon when clear, drifting clouds, falling rain or snow, mist, a lightning flash in a storm.
function daySky(date) {
  const now = tokyoNow();
  const w = now.date === date ? wxHour(date, now.min) : null;
  const day = dayOf(date);
  const night = !day?.sunset || now.min >= toMin(day.sunset) - 20 || now.min < 6 * 60;
  const kind = !w ? 'clear' : { 'wx-sun': 'clear', 'wx-partly': 'partly', 'wx-cloud': 'cloud', 'wx-fog': 'fog', 'wx-rain': 'rain', 'wx-snow': 'snow', 'wx-storm': 'storm' }[w.icon] || 'clear';
  // Fixed pseudo-random spread so the layout doesn't jump on every render.
  const r = (i, k) => ((i * 9301 + k * 49297) % 233280) / 233280;
  const fall = (cls, n) => Array.from({ length: n }, (_, i) => `<i class="${cls}" style="left:${(r(i, 1) * 100).toFixed(1)}%;animation-delay:-${(r(i, 2) * (cls === 'drop' ? 2 : 7)).toFixed(2)}s;animation-duration:${(cls === 'drop' ? 0.55 + r(i, 3) * 0.35 : 4 + r(i, 3) * 3).toFixed(2)}s;opacity:${(0.35 + r(i, 4) * 0.5).toFixed(2)}"></i>`).join('');
  const clouds = (n) => Array.from({ length: n }, (_, i) => `<i class="cloud c${i + 1}"></i>`).join('');
  const stars = (n) => '<i class="star"></i>'.repeat(n);
  const layer = {
    clear: night ? `<i class="moon"></i>${stars(5)}` : '<i class="sun"></i>',
    partly: night ? `<i class="moon"></i>${stars(3)}${clouds(2)}` : `<i class="sun"></i>${clouds(2)}`,
    cloud: clouds(3),
    fog: '<i class="mist m1"></i><i class="mist m2"></i><i class="mist m3"></i>',
    rain: clouds(2) + fall('drop', 26),
    storm: clouds(3) + fall('drop', 34) + '<i class="flash"></i>',
    snow: clouds(1) + fall('flake', 22),
  }[kind];
  return { kind, night, layer, label: w ? `지금 ${w.temp}° · ${w.label}` : '' };
}

function dayEndCard(dayIdx, items) {
  const { days } = state.trip;
  const { date } = days[dayIdx];
  const last = dayIdx === days.length - 1;
  const sealed = store.get('seal:' + date, false);
  const hit = state.sealHit === date;
  state.sealHit = null;
  const visited = items.filter((it) => it.place && isDone(it.id)).length;
  const spent = expenses().filter((e) => e.date === date).reduce((sum, e) => sum + e.amount, 0);
  const tally = [visited ? `오늘 ${visited}곳` : '', spent ? `${yen(spent)} 사용` : ''].filter(Boolean).join(' · ');
  const tomorrow = last ? null : dayItems(days[dayIdx + 1])[0];
  const sky = daySky(date);
  return `
    <div class="day-end sky-${sky.kind} ${sky.night ? 'is-night' : 'is-day'}" data-sky>
      <div class="de-sky" aria-hidden="true">${sky.layer}</div>
      ${sky.label ? `<div class="de-now">${esc(sky.label)}</div>` : ''}
      <div class="day-end-ja ja">お疲れさまでした</div>
      <div class="day-end-ko">오츠카레사마데시타 · ${last ? '여행 내내 수고했어요' : '오늘도 수고했어요'}</div>
      <button class="seal-slot" data-seal="${esc(date)}" aria-label="오늘 도장 찍기" ${sealed ? 'disabled' : ''}>
        ${sealed ? `<span class="seal ${hit ? 'hit' : ''}"><b>${last ? '여행' : `${dayIdx + 1}일차`}</b><b>완료</b></span>` : '눌러서 찍기'}
      </button>
      <div class="seal-days">${days.map((d, i) => `<span class="${isDayDone(d.date, date) ? 'on' : ''}">${i + 1}</span>`).join('')}</div>
      ${tally ? `<div class="day-end-sum">${esc(tally)}</div>` : ''}
      <button class="day-end-log" data-day-sum="${dayIdx}">${icon('pen')}날씨·옷차림 기록 남기기</button>
      ${last ? `<button class="day-end-log rp-open" data-report-preview>${icon('checklist')}여행 리포트 미리 보기</button>` : ''}
      <div class="day-end-next">${tomorrow ? `내일 첫 일정 ${esc(tomorrow.start)} ${esc(stripEmoji(tomorrow.title))}` : '여행 일정을 모두 마쳤어요'}</div>
    </div>`;
}

// ---------- trip report: after the trip, the 오늘 tab sums up everything both phones recorded ----------
// Nothing new is asked for: done marks, visits and ratings, expenses, stamps and the weather log are the material.
// Settlement splits what was shared; shopping is each person's own and stays out of it.
const OWN_CATS = ['쇼핑'];
// Bookings paid before leaving (항공·숙소…) live in the trip's cost guide in won, not in the spending log.
// The whole trip's cost is those plus what was spent there; a pre-trip expense that repeats one of them counts once.
const prepaidList = () => state.trip.guides.find((g) => g.costs)?.paid || [];
const isPrepaidDup = (e) => e.date < state.trip.trip.start && prepaidList().some((c) => c.won > 0 && (
  (e.orig?.cur === 'KRW' && Math.abs(e.orig.value - c.won) <= 100)
  || String(e.memo || '').split(/[\s·(]/).filter((w) => w.length >= 3).some((w) => c.label.includes(w))));
function tripCost() {
  const paid = prepaidList().filter((c) => c.won > 0);
  const prepaid = paid.reduce((a, c) => a + c.won, 0);
  const local = expenses().filter((e) => !isPrepaidDup(e)).reduce((a, e) => a + e.amount, 0);
  return { paid, prepaid, local, totalWon: prepaid + local * fxRate() };
}
function tripReport(preview = false) {
  const { trip, days } = state.trip;
  const today = tokyoNow().date;
  // Spending totals leave out a pre-trip entry that repeats a booking (it's in the total trip cost already);
  // settlement still sees every entry.
  const exp = expenses().filter((e) => !isPrepaidDup(e));
  const total = exp.reduce((a, e) => a + e.amount, 0);
  const shopping = exp.filter((e) => OWN_CATS.includes(e.cat)).reduce((a, e) => a + e.amount, 0);
  const budget = store.get('budget', state.trip.budget?.yen || 0);
  const perDay = days.map((d, i) => {
    const items = dayItems(d).filter((it) => !it.skip && !isMove(it));
    const done = items.filter((it) => isDone(it.id));
    const places = [...new Map(done.map((it) => [placeOfItem(it.id), it]).filter(([p]) => p)).keys()];
    const spent = exp.filter((e) => e.date === d.date).reduce((a, e) => a + e.amount, 0);
    const best = places.find((p) => visitOf(p.id)?.again === 'best');
    return { d, i, items, done, places, spent, wx: wxDay(d.date), sealed: store.get('seal:' + d.date, false), best };
  });
  const visited = new Set(perDay.flatMap((x) => x.places.map((p) => p.id)));
  const planned = perDay.reduce((a, x) => a + x.items.length, 0);
  const doneN = perDay.reduce((a, x) => a + x.done.length, 0);
  const rainy = perDay.filter((x) => (x.wx?.rain || 0) >= 1).length;
  const stamps = perDay.filter((x) => x.sealed).length;
  const cost = tripCost();
  setHeader(preview ? '미리 보기' : `${dayLabel(trip.start)} – ${dayLabel(trip.end)}`, '여행 리포트', `${trip.title} · ${travelers()}명`);
  return `
    ${preview ? `<button class="btn wide rp-back" data-report-close>${icon('x')}오늘 화면으로 돌아가기</button>` : ''}
    ${AUTH.user ? '' : `<button class="rp-sync" data-settings="sync">${icon('refresh')}<span class="grow"><b>로그인하면 여행메이트 기록까지 함께 보여요</b><small>설정 › 계정에서 카카오로 로그인</small></span><i class="chev"></i></button>`}
    <div class="rp-hero">
      <div class="rp-hero-top"><b>${esc(trip.title)}</b><span>도장 ${stamps}/${days.length}</span></div>
      <div class="rp-line">${days.length}일 동안 ${visited.size}곳 · 총 여행 경비 약 ${wan(cost.totalWon)}</div>
      <div class="rp-tiles">
        <div><b>${visited.size}</b><span>방문한 곳</span></div>
        <div><b>${doneN}<small>/${planned}</small></b><span>마친 일정</span></div>
        <div><b>${Math.round(cost.totalWon / 10000).toLocaleString('ko-KR')}<small>만원</small></b><span>총 여행 경비</span></div>
        <div><b>${rainy}</b><span>비 온 날</span></div>
      </div>
    </div>
    ${reportDays(perDay, today)}
    ${reportSpend(exp, total, shopping, budget, days)}
    ${reportSettle(expenses())}
    ${reportPlaces(visited)}
    ${reportPlan(days)}
    ${reportWeather(perDay)}
    ${reportStory()}
    ${reportShare(exp)}`;
}
// What was planned against what happened: done, skipped, re-timed, added on the way.
function reportPlan(days) {
  const rows = days.map((d, i) => {
    const items = dayItems(d).filter((it) => !isMove(it));
    const raw = new Map(d.items.map((x) => [x.id, x]));
    const skipped = items.filter((it) => it.skip);
    const live = items.filter((it) => !it.skip);
    const moved = live.filter((it) => raw.has(it.id) && raw.get(it.id).start !== it.start);
    const added = live.filter((it) => !raw.has(it.id));
    const late = Math.max(0, ...moved.map((it) => toMin(it.start) - toMin(raw.get(it.id).start)));
    return { d, i, planned: items.filter((it) => raw.has(it.id)).length, done: live.filter((it) => isDone(it.id)).length, skipped, moved, added, late };
  });
  const sum = (k) => rows.reduce((a, r) => a + (Array.isArray(r[k]) ? r[k].length : r[k]), 0);
  if (!sum('planned')) return '';
  const worst = [...rows].sort((a, b) => b.moved.length - a.moved.length || b.late - a.late)[0];
  const skippedAll = rows.flatMap((r) => r.skipped.map((it) => ({ it, r })));
  return `
    <div class="section-title"><span>계획 vs 실제</span></div>
    <div class="card rp-card">
      <div class="rp-plan-n">
        <div><b>${sum('planned')}</b><span>계획</span></div>
        <div class="ok"><b>${sum('done')}</b><span>마침</span></div>
        <div class="skip"><b>${sum('skipped')}</b><span>건너뜀</span></div>
        <div class="moved"><b>${sum('moved')}</b><span>시간 바뀜</span></div>
        <div><b>${sum('added')}</b><span>추가</span></div>
      </div>
      ${worst && worst.moved.length ? `<div class="rp-note">${icon('clock')}<span><b>${worst.i + 1}일차가 가장 많이 바뀌었어요</b><small>일정 ${worst.moved.length}개의 시간이 바뀌었고, 가장 크게는 ${formatLeft(worst.late)} 밀렸어요</small></span></div>` : ''}
      <div class="rp-sub">하루별</div>
      ${rows.map((r) => `<div class="rp-plan-row"><span class="rp-bar-l">${r.i + 1}일차</span><span class="rp-dots">${'<i class="ok"></i>'.repeat(r.done)}${'<i class="skip"></i>'.repeat(r.skipped.length)}${'<i></i>'.repeat(Math.max(0, r.planned + r.added.length - r.done - r.skipped.length))}</span><span class="rp-bar-v">${r.done}/${r.planned + r.added.length}</span></div>`).join('')}
      <div class="rp-legend"><span><i class="ok"></i>마침</span><span><i class="skip"></i>건너뜀</span><span><i></i>남음</span></div>
      ${skippedAll.length ? `<div class="rp-sub">건너뛴 일정 ${skippedAll.length} · 다음엔 빼거나 넉넉히</div>${skippedAll.map(({ it, r }) => `<div class="rp-skip"><span>${r.i + 1}일차 ${esc(rawItem(it.id)?.start || it.start)}</span><b>${esc(stripEmoji(it.title))}</b></div>`).join('')}` : ''}
    </div>`;
}
// The five days' weather and how the clothes felt, folded into one tip for the next trip.
function reportWeather(perDay) {
  const wx = perDay.filter((x) => x.wx);
  if (!wx.length) return '';
  const lo = Math.min(...wx.map((x) => x.wx.min));
  const hi = Math.max(...wx.map((x) => x.wx.max));
  const rain = wx.filter((x) => x.wx.rain >= 1);
  const feel = { hot: 0, ok: 0, cold: 0 };
  for (const x of perDay) for (const p of mates()) { const c = gearLog(x.d.date, p.id)?.coat; if (c in feel) feel[c] += 1; }
  const said = feel.hot + feel.ok + feel.cold;
  const month = Number(state.trip.trip.start.slice(5, 7));
  const tip = !said ? `기온 ${lo}~${hi}° · 아침저녁엔 가벼운 겉옷이 있으면 좋아요`
    : feel.cold > feel.hot ? `추웠다는 기록이 ${feel.cold}번 · 다음엔 한 단계 두꺼운 겉옷을`
      : feel.hot > feel.cold ? `더웠다는 기록이 ${feel.hot}번 · 다음엔 얇은 겉옷과 겹쳐 입기로`
        : `딱 맞았다는 기록이 많아요 · 이번 옷차림 그대로 괜찮아요`;
  return `
    <div class="section-title"><span>날씨 · 옷차림</span></div>
    <div class="card rp-card">
      <div class="rp-wx">${wx.map((x) => `<div class="${x.wx.rain >= 1 || x.wx.pop >= 30 ? 'wet' : ''}"><small>${x.i + 1}일차</small>${wxIcon(x.wx.icon)}<b>${x.wx.max}°</b><span>${x.wx.min}°</span>${x.wx.rain >= 1 ? `<em>${Math.round(x.wx.rain)}mm</em>` : '<em></em>'}</div>`).join('')}</div>
      <div class="small muted">최저 ${lo}° · 최고 ${hi}° · 비 온 날 ${rain.length}일${said ? ` · 옷차림 기록 ${said}번 (더움 ${feel.hot} · 딱 맞음 ${feel.ok} · 추움 ${feel.cold})` : ''}</div>
      <div class="rp-note">${icon('coat')}<span><b>다음 ${month}월 여행 팁</b><small>${esc(tip)}</small></span></div>
    </div>`;
}
// One summary card to send to family and friends (no names, booking numbers or photos), and the spending as text.
function reportShare(exp) {
  return `
    <div class="section-title"><span>공유 · 내보내기</span></div>
    <div class="card rp-card">
      <button class="btn primary wide" data-report-image>${icon('image')}요약 카드 이미지로 공유</button>
      ${exp.length ? `<button class="btn wide" data-report-text>${icon('copy')}지출 목록 텍스트 복사</button>` : ''}
      <div class="small muted">요약 카드에는 여행 날짜·방문한 곳·지출 총액·추천 장소만 들어가요. 이름·예약번호·사진은 넣지 않아요.</div>
    </div>`;
}
function reportFacts() {
  const { trip, days } = state.trip;
  const exp = expenses();
  const total = exp.reduce((a, e) => a + e.amount, 0);
  const visited = new Set();
  let done = 0;
  for (const d of days) for (const it of dayItems(d)) {
    if (it.skip || isMove(it) || !isDone(it.id)) continue;
    done += 1;
    const p = placeOfItem(it.id); if (p) visited.add(p.id);
  }
  const best = allPlaces().filter((p) => visitOf(p.id)?.again === 'best').map((p) => p.name).slice(0, 3);
  return { trip, days, total, cost: tripCost(), visited: visited.size, done, best, stamps: days.filter((d) => store.get('seal:' + d.date, false)).length };
}
async function reportImage() {
  const f = reportFacts();
  try { await document.fonts.load('800 40px Pretendard'); } catch { /* system font */ }
  const W = 1080, H = 1350;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px Pretendard, "Apple SD Gothic Neo", system-ui, sans-serif`;
  g.fillStyle = '#141a28'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#c84b3c'; g.beginPath(); g.arc(W - 120, 150, 230, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(200,75,60,.18)'; g.beginPath(); g.arc(W - 120, 150, 300, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#F37021'; g.font = font(700, 34); g.fillText(`${dayLabel(f.trip.start)} – ${dayLabel(f.trip.end)}`, 80, 140);
  g.fillStyle = '#f4f1ea'; g.font = font(800, 92); g.fillText(f.trip.title, 80, 250);
  g.font = font(500, 38); g.fillStyle = 'rgba(244,241,234,.7)'; g.fillText(`${f.days.length}일 동안 ${f.visited}곳을 다녀왔어요`, 80, 320);
  const tiles = [[`${f.visited}`, '방문한 곳'], [`${f.done}`, '마친 일정'], [`${Math.round(f.cost.totalWon / 10000).toLocaleString('ko-KR')}만원`, '총 여행 경비'], [`${f.stamps}/${f.days.length}`, '받은 도장']];
  tiles.forEach(([v, l], i) => {
    const x = 80 + (i % 2) * 470, y = 420 + Math.floor(i / 2) * 230;
    g.fillStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.roundRect(x, y, 450, 200, 28); g.fill();
    g.fillStyle = '#f4f1ea'; g.font = font(800, v.length > 8 ? 58 : 76); g.fillText(v, x + 36, y + 110);
    g.fillStyle = 'rgba(244,241,234,.62)'; g.font = font(600, 32); g.fillText(l, x + 36, y + 165);
  });
  if (f.best.length) {
    g.fillStyle = '#F37021'; g.font = font(700, 32); g.fillText('강력 추천', 80, 1010);
    g.fillStyle = '#f4f1ea'; g.font = font(700, 42);
    f.best.forEach((n, i) => g.fillText(`· ${n}`, 80, 1075 + i * 62));
  }
  g.fillStyle = 'rgba(244,241,234,.45)'; g.font = font(600, 28); g.fillText('내가 만든 여행 앱으로 기록했어요', 80, H - 70);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], `${f.trip.title}-여행리포트.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: `${f.trip.title} 여행 리포트` });
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function reportText() {
  const exp = [...expenses()].sort((a, b) => a.date.localeCompare(b.date) || expTime(a).localeCompare(expTime(b)));
  const total = exp.reduce((a, e) => a + e.amount, 0);
  const lines = [`${state.trip.trip.title} 지출 (${exp.length}건)`, ''];
  let day = '';
  for (const e of exp) {
    if (e.date !== day) { day = e.date; lines.push(`[${expDateLabel(e.date)}]`); }
    lines.push(`${expTime(e) ? expTime(e) + ' ' : ''}${expTitle(e)} · ${e.cat} · ${{ card: '카드', cash: '현금' }[e.pay] || ''} · ${nameOf(e.by) || ''} · ${Math.round(e.amount).toLocaleString('ko-KR')}엔`);
  }
  lines.push('', `합계 ${Math.round(total).toLocaleString('ko-KR')}엔 (약 ${won(total)})`);
  try { await navigator.clipboard.writeText(lines.join('\n')); toast(`지출 ${exp.length}건을 복사했어요`); } catch { toast('복사하지 못했어요'); }
}
function reportDays(perDay, today) {
  return `
    <div class="section-title"><span>하루씩 돌아보기</span></div>
    <div class="rp-days">${perDay.map((x) => `
      <button class="rp-day idx" data-tomorrow="${x.i}" data-sum-open="${esc(x.d.date)}">
        <span class="rp-day-h"><span class="rp-day-no">${x.i + 1}<small>일차</small></span><small>${esc(dayLabel(x.d.date))}${x.d.date === today ? ' · 오늘' : ''}</small>${x.sealed ? `<i class="rp-done">${STAR5}완주</i>` : ''}</span>
        <span class="rp-day-t">${esc(stripEmoji(x.d.title))}</span>
        <span class="rp-day-rows">
          ${x.wx ? `<span class="rp-day-w">${wxIcon(x.wx.icon)}<span>${x.wx.min}~${x.wx.max}°${x.wx.rain >= 1 ? ` · 비 ${Math.round(x.wx.rain)}mm` : ''}</span></span>` : ''}
          ${x.best ? `<span class="rp-day-best">${icon('thumbs2')}<span>${esc(x.best.name)}</span></span>` : ''}
        </span>
        <span class="rp-day-n"><span><b>${x.places.length}</b>곳</span><span><b>${yen(x.spent)}</b></span></span>
      </button>`).join('')}</div>`;
}
function reportSpend(exp, total, shopping, budget, days) {
  if (!exp.length) return '';
  const used = total - shopping;
  const pct = budget ? Math.round((used / budget) * 100) : 0;
  const cats = Object.entries(exp.reduce((m, e) => ({ ...m, [e.cat]: (m[e.cat] || 0) + e.amount }), {})).sort((a, b) => b[1] - a[1]);
  const top = cats[0]?.[1] || 1;
  const byDay = days.map((d) => [d, exp.filter((e) => e.date === d.date).reduce((a, e) => a + e.amount, 0)]);
  const pre = exp.filter((e) => e.date < state.trip.trip.start).reduce((a, e) => a + e.amount, 0);
  const dayTop = Math.max(1, pre, ...byDay.map(([, v]) => v));
  // Same rule as the 경비 card: yen cash is cash paid in yen; won paid in cash and entries with no method are shown apart.
  const sumOf = (f) => exp.filter(f).reduce((a, e) => a + e.amount, 0);
  const card = sumOf((e) => e.pay === 'card');
  const cashYen = sumOf((e) => e.pay === 'cash' && e.orig?.cur !== 'KRW');
  const cashWon = exp.filter((e) => e.pay === 'cash' && e.orig?.cur === 'KRW');
  const other = sumOf((e) => e.pay !== 'card' && e.pay !== 'cash');
  const biggest = [...exp].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const bar = (label, v, max, sub = '') => `<div class="rp-bar"><span class="rp-bar-l">${esc(label)}</span><span class="rp-bar-t"><i style="width:${Math.max(2, Math.round((v / max) * 100))}%"></i></span><span class="rp-bar-v">${yen(v)}${sub}</span></div>`;
  return `
    <div class="section-title"><span>지출</span></div>
    ${reportCost()}
    <div class="card rp-card">
      <div class="rp-sub" style="margin-top:0">현지 지출 (내 지출 기록)</div>
      <div class="rp-total"><b>${yen(total)}</b><span>${won(total)} · 1인 약 ${esc(manwon(total / travelers()))}</span></div>
      ${budget ? `<div class="meter rp-meter"><i style="width:${Math.min(100, pct)}%"></i></div><div class="small muted">예산 ${yen(budget)} 중 ${pct}% 사용 (쇼핑 제외)${pct > 100 ? ` · ${yen(used - budget)} 넘음` : ` · ${yen(budget - used)} 남음`}</div>` : ''}
      <div class="rp-sub">분류별</div>
      ${cats.map(([c, v]) => bar(c, v, top)).join('')}
      <div class="rp-sub">날짜별</div>
      ${pre ? bar('출발 전', pre, dayTop) : ''}${byDay.map(([d, v], i) => bar(`${i + 1}일차`, v, dayTop)).join('')}
      <div class="rp-split"><span>카드 <b>${yen(card)}</b></span><span>엔화 현금 <b>${yen(cashYen)}</b></span>${cashWon.length ? `<span>원화 현금 <b>${cashWon.reduce((a, e) => a + e.orig.value, 0).toLocaleString('ko-KR')}원</b></span>` : ''}${other ? `<span>결제수단 없음 <b>${yen(other)}</b></span>` : ''}</div>
      ${other ? `<details class="rp-nopay"><summary>결제수단 없는 지출 ${exp.filter((e) => e.pay !== 'card' && e.pay !== 'cash').length}건 보기 · 눌러서 카드/현금 정하기</summary>
        <div class="small muted">결제수단 칸은 11/2 밤에 생겨서, 그 전에 등록한 지출은 비어 있어요.</div>
        ${exp.filter((e) => e.pay !== 'card' && e.pay !== 'cash').sort((a, b) => a.date.localeCompare(b.date)).map((e) => `<button class="rp-big" data-exp-edit="${esc(e.id)}"><i>?</i><span class="grow"><b>${esc(expTitle(e))}</b><small>${esc(expDateLabel(e.date))}${expTime(e) ? ' ' + esc(expTime(e)) : ''} · ${esc(e.cat)}${e.orig?.cur === 'KRW' ? ` · ${e.orig.value.toLocaleString('ko-KR')}원` : ''}</small></span><b>${yen(e.amount)}</b></button>`).join('')}
      </details>` : ''}
      <div class="small muted">환전한 엔화 ${yen(cashTotal())} 중 ${yen(cashSpent())} 사용 · 남은 엔화 ${yen(Math.max(0, cashTotal() - cashSpent()))}${cashSpent() > cashTotal() ? ' · 환전액보다 많이 썼어요. 경비 칸에서 환전액을 확인해 주세요' : ''}</div>
      <div class="rp-sub">가장 큰 지출</div>
      ${biggest.map((e, i) => `<button class="rp-big" data-exp-edit="${esc(e.id)}"><i>${i + 1}</i><span class="grow"><b>${esc(expTitle(e))}</b><small>${esc(expDateLabel(e.date))} · ${esc(e.cat)}</small></span><b>${yen(e.amount)}</b></button>`).join('')}
    </div>`;
}
function reportCost() {
  const c = tripCost();
  if (!c.prepaid && !c.local) return '';
  const pct = (v) => Math.round((v / c.totalWon) * 100);
  const localWon = c.local * fxRate();
  return `
    <div class="card rp-card rp-cost">
      <div class="rp-sub" style="margin-top:0">총 여행 경비 · 2인</div>
      <div class="rp-total"><b>${(Math.round(c.totalWon / 1000) * 1000).toLocaleString('ko-KR')}원</b><span>약 ${wan(c.totalWon)} · 1인 약 ${wan(c.totalWon / travelers())}</span></div>
      <div class="rp-stack" aria-hidden="true"><i style="width:${pct(c.prepaid)}%"></i><i style="width:${pct(localWon)}%"></i></div>
      <div class="rp-stack-l"><span><i></i>출발 전 결제 <b>${wan(c.prepaid)}</b></span><span><i></i>현지 지출 <b>${wan(localWon)}</b> (${yen(c.local)})</span></div>
      <details class="rp-paid"><summary>출발 전 결제 ${c.paid.length}건 보기</summary>
        ${c.paid.map((x) => `<div class="rp-paid-row"><span>${esc(x.label)}</span><b>${x.won.toLocaleString('ko-KR')}원</b></div>`).join('')}
        <div class="small muted">예약 탭 › 경비 › 여행 비용의 출발 전 결제 목록이에요. 내 지출에 같은 결제를 따로 등록했다면 한 번만 셌어요.</div>
      </details>
    </div>`;
}
// 정산: 함께 쓴 돈을 여행메이트 수로 똑같이 나누고, 보내는 횟수가 가장 적게 '누가 누구에게 얼마'. 쇼핑은 각자.
function settleMoves(bal) {
  const give = bal.filter((b) => b.v < -0.5).map((b) => ({ ...b, v: -b.v })).sort((a, b) => b.v - a.v);
  const get = bal.filter((b) => b.v > 0.5).map((b) => ({ ...b })).sort((a, b) => b.v - a.v);
  const out = [];
  while (give.length && get.length) {
    const a = give[0], b = get[0], n = Math.min(a.v, b.v);
    out.push({ from: a.id, to: b.id, n: Math.round(n) });
    a.v -= n; b.v -= n;
    if (a.v < 0.5) give.shift();
    if (b.v < 0.5) get.shift();
  }
  return out.filter((m) => m.n >= 100);
}
function reportSettle(exp) {
  if (!exp.length) return '';
  const key = (e) => mateKey(e.by);
  const ids = [...new Set([...mates().map((m) => m.id), ...exp.map(key).filter(Boolean)])];
  if (ids.length < 2) return '';
  const shared = exp.filter((e) => !OWN_CATS.includes(e.cat));
  const unknown = shared.filter((e) => !key(e));
  const paid = (id) => shared.filter((e) => key(e) === id).reduce((s, e) => s + e.amount, 0);
  const own = (id) => exp.filter((e) => OWN_CATS.includes(e.cat) && key(e) === id).reduce((s, e) => s + e.amount, 0);
  const total = ids.reduce((s, id) => s + paid(id), 0);
  const each = total / ids.length;
  const moves = settleMoves(ids.map((id) => ({ id, v: paid(id) - each })));
  const plain = moves.map((m) => `${nameOf(m.from)} → ${nameOf(m.to)} ${m.n.toLocaleString('ko-KR')}엔 (약 ${won(m.n)})`);
  return `
    <div class="section-title"><span>정산</span><em class="muted">함께 쓴 돈을 ${ids.length}명이 똑같이, 쇼핑은 각자</em></div>
    <div class="card rp-card rp-settle">
      ${moves.length ? moves.map((m) => `<div class="rp-owe">${esc(nameOf(m.from))} → ${esc(nameOf(m.to))} <b>${yen(m.n)}</b> (약 ${esc(won(m.n))})</div>`).join('') : '<div class="rp-owe">거의 같아요. 따로 보낼 돈이 없어요</div>'}
      <div class="rp-people">${ids.map((id) => `<div><span>${esc(nameOf(id))}</span><b>${yen(paid(id))}</b><small>함께 쓴 돈에서 낸 금액</small>${own(id) ? `<small>쇼핑 ${yen(own(id))} (각자)</small>` : ''}</div>`).join('')}</div>
      <div class="small muted">함께 쓴 돈 ${yen(total)} ÷ ${ids.length}명 = 1인 ${yen(each)}${unknown.length ? ` · 누가 냈는지 모르는 지출 ${unknown.length}건(${yen(unknown.reduce((s, e) => s + e.amount, 0))})은 빼고 계산했어요` : ''}</div>
      ${moves.length ? `<button class="btn wide" data-copy-text="${esc(plain.join('\n'))}">${icon('copy')}정산 금액 복사</button>` : ''}
    </div>`;
}
// Rated places grouped by how much we'd go back: a tally strip on top, then one group per rating with its own
// mark and colour, each place with its memo; places saved but never reached close the card as next-trip ideas.
const RATE_KIND = [['best', '강력 추천', 'thumbs2', '다시 가고 싶은 곳'], ['yes', '추천', 'thumb', '가 볼 만한 곳'], ['no', '비추천', 'thumb-down', '다음엔 빼도 될 곳']];
function reportPlaces(visited) {
  const all = allPlaces();
  const groups = RATE_KIND.map(([k, l, ic, hint]) => ({ k, l, ic, hint, list: all.filter((p) => visitOf(p.id)?.again === k) }));
  const rated = groups.filter((g) => g.list.length);
  // One rating at a time: tap a count above to list its places below (starts on the first with places).
  const pick = rated.find((g) => g.k === state.rpRate) || rated[0];
  const next = all.filter((p) => isSaved(p.id) && !visited.has(p.id) && !visitOf(p.id));
  if (!rated.length && !next.length && !visited.size) return '';
  const row = (p, k) => { const v = visitOf(p.id); return `<button class="rp-place ${k || ''}" data-place="${esc(p.id)}"><span class="grow"><b>${esc(p.name)}</b>${v?.memo ? `<small class="memo">“${esc(v.memo)}”</small>` : p.area ? `<small>${esc(p.area)}</small>` : ''}</span><i class="chev"></i></button>`; };
  return `
    <div class="section-title"><span>좋았던 곳 · 다음에 갈 곳</span></div>
    ${rated.length ? `<div class="rp-rate-tally" role="tablist">${groups.map((g) => `<button type="button" role="tab" class="rk-${g.k} ${g.list.length ? '' : 'none'} ${g.k === pick.k ? 'on' : ''}" data-rp-rate="${g.k}" aria-label="${g.l} ${g.list.length}곳" aria-selected="${g.k === pick.k}" ${g.list.length ? '' : 'disabled'}>${icon(g.ic)}<b>${g.list.length}</b></button>`).join('')}</div>` : ''}
    ${rated.length ? `
      <div class="card rp-card rp-rate rk-${pick.k}" role="tabpanel">
        <div class="rp-rate-h"><span class="rp-rate-ic">${icon(pick.ic)}</span><span class="grow"><b>${pick.l}</b><small>${pick.hint}</small></span><em>${pick.list.length}곳</em></div>
        ${pick.list.map((p) => row(p, pick.k)).join('')}
      </div>`
      : `<div class="card rp-card"><div class="small muted">평가를 남긴 곳이 없어요. 방문한 ${visited.size}곳은 탐색 › 기록에서 볼 수 있어요.</div></div>`}
    ${next.length ? `
      <div class="card rp-card rp-rate rk-next">
        <div class="rp-rate-h"><span class="rp-rate-ic">${icon('pin')}</span><span class="grow"><b>저장했지만 못 간 곳</b><small>다음 여행 후보</small></span><em>${next.length}곳</em></div>
        ${next.slice(0, 12).map((p) => row(p)).join('')}
      </div>` : ''}`;
}

function renderToday() {
  const now = tokyoNow();
  const { trip, days, flights } = state.trip;
  const dayIdx = days.findIndex((d) => d.date === now.date);

  if (now.date < trip.start) {
    const left = daysBetween(now.date, trip.start);
    const list = checklist();
    const todo = list.filter((c) => !isChecked(c.id));
    const f = flights[0];
    setHeader('', trip.title, `${dayLabel(trip.start)} 출발 · ${travelers()}명`);
    return `
      ${updateBand()}
      <div class="hero countdown">
        <div class="hero-sun"></div>
        <div class="eyebrow">출발까지</div>
        <div class="big">D-${left}</div>
        ${flightRoute(now)}
        ${f ? `<div class="hero-meta">${esc(f.airline)} ${esc(f.no)} · ${esc(dayLabel(f.date))} ${esc(f.depart)} · 인천 T${esc(f.fromTerminal)}</div>` : ''}
        ${state.trip.transfers.map((t) => `<div class="hero-meta">${itemIcon(t.icon, 'inline')}${esc(t.label)} ${esc(t.from)} ${esc(t.depart)} → ${esc(t.to)}</div>`).join('')}
        <div class="meter"><i style="width:${list.length ? Math.round(((list.length - todo.length) / list.length) * 100) : 0}%"></i></div>
        <div class="hero-meta">준비 ${list.length - todo.length} / ${list.length}</div>
      </div>
      ${todoCard(now.date, '지금 할 일', 5)}
      <div class="quick four">
        <button data-go="check"><b>${todo.length}</b><span>남은 준비</span></button>
        <button data-go="wallet"><b>${icon('ext')}</b><span>예약 확인</span></button>
        <button data-go="talk"><b>あ</b><span>번역</span></button>
        <button data-fx><b>¥</b><span>환율</span></button>
      </div>
      <div class="section-title"><span>여행 기간 날씨 · 도쿄</span></div>
      ${wxTrip()}
      <div class="section-title"><span>첫날 · ${esc(dayLabel(days[0].date))}</span></div>
      ${timeline(dayItems(days[0]).slice(0, 4), null)}
    `;
  }
  if (dayIdx === -1) return tripReport();
  // On the last day the report can be opened early (after the day's stops are done, or any time from the card).
  if (state.reportPreview && dayIdx === days.length - 1) return tripReport(true);

  const day = days[dayIdx];
  const items = dayItems(day).filter((it) => !it.skip);
  const queue = dueQueue(items, now);
  const current = queue[0];
  const started = current && isStarted(current, items);
  // A stop already marked done (early, or ahead of time) is over: it leaves the next card and the list.
  const upcoming = items.filter((it) => it.startMin > now.min && !isDone(it.id));
  const next = upcoming[0];
  setHeader(`${dayIdx + 1}일차 · ${dayLabel(day.date)}`, stripEmoji(day.title), `${day.sunset ? `일몰 ${day.sunset} · ` : ''}${items.length}개 일정`);

  const back = flights[1];
  const flightDay = !!back && (now.date === flights[0].date || now.date === back.date);
  const f = flightDay && now.date === back.date ? back : flights[0];
  // Stops piling up, or one waiting to be confirmed, move up with the alerts.
  const top = queue.length > 1 ? backlogCard(queue, items, now) : current && !started ? heroCard(current, 'now', now, false) : '';
  const sq = squeezeOf(day.date, now);
  let html = updateBand() + (upcoming.length ? '' : wrapDayCard(queue)) + top + (sq ? squeezeBar(sq) : '') + prepCard(day, items, now);
  if (flightDay) html += `
    <div class="hero route-hero">
      ${flightRoute(now)}
      <div class="hero-meta">${esc(f.no)} · ${esc(f.depart)} 출발 · ${esc(f.arrive)} 도착</div>
    </div>`;
  html += wxCard(day.date, now);
  if (now.min >= 18 * 60 && days[dayIdx + 1]) html += tomorrowCard(days[dayIdx + 1], dayIdx + 1);
  html += todoCard(now.date, '오늘 할 일', 3);
  if (queue.length === 1 && started) html += heroCard(current, 'now', now, true);
  if (next) html += heroCard(next, 'next', now);
  if (!current && !next) html += dayEndCard(dayIdx, items);
  html += `
    <div class="quick four">
      <button data-nav="__stay"><b>${icon('home')}</b><span>호텔로</span></button>
      <button data-go="talk"><b>あ</b><span>번역</span></button>
      <button data-go-exp><b>${icon('money')}</b><span>지출</span></button>
      <button data-fx><b>¥</b><span>환율</span></button>
    </div>`;

  const later = upcoming.slice(1);
  if (later.length) html += `<div class="section-title"><span>이후 일정</span><em>${later.length}</em></div>${timeline(later, now)}`;
  return html;
}

// Calendar alarms: one file for everything, or a Google Calendar link per stop where a phone drops the file's alarms.
const alarmItems = () => state.trip.days.flatMap((d) => dayItems(d).filter((it) => 'alarm' in it));
function gcalUrl(it) {
  const [y, m, d] = it.date.split('-').map(Number);
  const utc = (min) => new Date(Date.UTC(y, m - 1, d, 0, min - 540)).toISOString().replace(/[-:]|\.\d+/g, '');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: it.alarmTitle || it.title, dates: `${utc(it.startMin)}/${utc(it.endMin)}` });
  if (it.note) q.set('details', it.note);
  if (it.place) q.set('location', it.place.query);
  return `https://calendar.google.com/calendar/render?${q}`;
}
// 설정 › 일정 알림: what is still ahead, at its current time; a stop moved since the calendar file was made
// is marked, with a one-tap Google Calendar add at the new time.
function alarmPanel() {
  const now = tokyoNow();
  const ahead = alarmItems().filter((it) => !it.skip && !isDone(it.id) && (it.date > now.date || (it.date === now.date && it.startMin > now.min)));
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const android = /Android/i.test(navigator.userAgent);
  const url = new URL('calendar.ics', location.href).href;
  const fileHref = ios && navigator.standalone ? url.replace(/^https:/, 'x-safari-https:') : url;
  const moved = (it) => rawItem(it.id)?.start && rawItem(it.id).start !== it.start;
  if (!ahead.length) return '<div class="card set-card"><div class="set-row"><span class="grow"><b>남은 알림이 없어요</b><small>알림을 거는 일정이 모두 지났어요</small></span></div></div>';
  return `
    <div class="card set-card alarm-panel">
      <div class="set-row"><span class="grow"><b>남은 알림 ${ahead.length}개</b><small>놓치면 안 되는 일정이에요. 캘린더에 넣어 두면 앱을 닫아도 알려 줘요</small></span></div>
      ${ahead.map((it) => `
        <a class="alarm-row" href="${esc(gcalUrl(it))}" target="_blank" rel="noopener">
          <span class="al-t">${esc(it.start)}<small>${esc(shortDate(it.date))}</small></span>
          <span class="grow"><b>${esc(stripEmoji(it.alarmTitle || it.title))}</b><small>${it.alarm ? `${it.alarm}분 전 알림` : '시작할 때 알림'}${moved(it) ? ` · <em>원래 ${esc(rawItem(it.id).start)} → 바뀜, 다시 추가하세요</em>` : ''}</small></span>
          ${icon('plus')}
        </a>`).join('')}
      <div class="small muted set-note">한 줄을 누르면 지금 시간으로 Google 캘린더에 하나씩 넣어요.</div>
      <a class="btn wide alarm-file" href="${esc(fileHref)}" target="_blank" rel="noopener" ${android ? 'download="tokyo-trip.ics"' : ''}>${icon('calendar')}${ios ? 'Safari에서 열어 한 번에 추가' : '캘린더에 한 번에 추가'}</a>
      <div class="small muted set-note">한 번에 추가는 처음 계획한 시간으로 들어가요.${ahead.some(moved) ? ' 시간이 바뀐 일정은 위에서 따로 추가해 주세요.' : ''}${ios ? ' 빈 화면이 뜨면 주소를 복사해 Safari에 붙여넣으세요.' : ''}</div>
      ${ios ? `<div class="btns alarm-more-btns"><button class="btn" data-copy-text="${esc(url)}">${icon('copy')}주소 복사</button><a class="btn" href="${esc(url.replace(/^https:/, 'webcal:'))}">${icon('refresh')}캘린더 구독</a></div>` : ''}
    </div>`;
}

function openAlarms() {
  const list = alarmItems();
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const url = new URL('calendar.ics', location.href).href;
  // The home-screen app shows a blank page for a calendar file, so iPhone hands it to Safari.
  const fileHref = ios && navigator.standalone ? url.replace(/^https:/, 'x-safari-https:') : url;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>일정 알림 받기</h3></div>
    <div class="small muted alarm-note">놓치면 안 되는 일정 ${list.length}개를 폰 캘린더에 넣어요. 앱을 닫아도 캘린더가 알려 줘요.</div>
    <a class="btn primary wide alarm-file" href="${esc(fileHref)}" target="_blank" rel="noopener" ${android ? 'download="tokyo-trip.ics"' : ''}>${icon('ext')}${ios ? 'Safari에서 열어 한 번에 추가' : '캘린더에 한 번에 추가'}</a>
    ${ios ? `
    <div class="btns">
      <button class="btn" data-copy-text="${esc(url)}">${icon('copy')}주소 복사</button>
      <a class="btn" href="${esc(url.replace(/^https:/, 'webcal:'))}">${icon('refresh')}캘린더 구독</a>
    </div>` : ''}
    <ol class="small muted alarm-note">
      ${android
    ? `<li>내려받은 파일을 눌러 Samsung 캘린더나 Google 캘린더로 가져오세요.</li>`
    : `<li>Safari의 일정 추가 화면에서 전체 추가를 누르세요. 빈 화면이면 주소를 복사해 Safari 주소창에 붙여넣으세요.</li>`}
      <li>11/2 일정을 열어 알림이 설정됐는지 확인하세요.</li>
      <li>알림이 없으면 아래에서 일정별로 추가하세요.</li>
    </ol>
    <details class="more alarm-more"><summary>Google 캘린더에 하나씩 추가</summary>
      ${list.map((it) => `<a class="alarm-row" href="${esc(gcalUrl(it))}" target="_blank" rel="noopener"><span class="grow"><b>${esc(it.alarmTitle || it.title)}</b><small>${esc(dayLabel(it.date))} ${esc(it.start)}</small></span>${icon('ext')}</a>`).join('')}
      <div class="small muted alarm-note">Google 캘린더 기본 알림 시간이 적용돼요.</div>
    </details>`;
  $('#sheet').hidden = false;
}

// Countdown to when we must walk out the door for the next fixed-time stop.
// The finish word fits the stop: you visit a restaurant, arrive at an airport, and simply finish an errand.
function doneLabel(it) {
  if (it.swap) return '방문 완료';
  if (/라운지/.test(it.title)) return '방문 완료';
  if (/환전|수령|체크인|체크아웃|짐|대기 등록|조식|휴식|위탁/.test(it.title)) return '완료';
  if (it.icon === '✈️') return /도착$/.test(it.title) ? '도착 완료' : '탑승 완료';
  if (/→|복귀/.test(it.title) || ['🚌', '🚄', '🚇', '🚝', '🚃'].includes(it.icon)) return '도착 완료';
  return '방문 완료';
}

// Every stop that's due but unfinished, in order. Only the first can be closed, so they're dealt with one by one.
function backlogCard(queue, items, now) {
  const [head] = queue;
  const started = isStarted(head, items);
  const behind = started ? now.min - head.endMin : now.min - head.startMin;
  const when = (it, i) => (i ? `${it.start} 예정` : started ? `진행 중 · ${behind > 0 ? `${formatLeft(behind)} 초과` : `${it.endMin - now.min}분 남음`}` : `${it.start} 시작 예정 · ${formatLeft(behind)} 지남`);
  return `
    <div class="backlog">
      <div class="backlog-head">
        <b>밀린 일정 ${queue.length}개</b>
        <span>${behind > 0 ? `${formatLeft(behind)} 늦어지고 있어요 · ` : ''}앞에서부터 처리해 주세요</span>
      </div>
      ${queue.map((it, i) => `
        <div class="bl-row ${i ? '' : 'first'}" data-item="${esc(it.id)}" role="button" tabindex="0">
          <span class="bl-no">${i + 1}</span>${itemIcon(it.icon)}
          <span class="grow"><b>${esc(it.title)}</b><small>${esc(when(it, i))}${isFixed(it) ? ' · 시간 고정' : ''}</small></span>
        </div>
        ${i ? '' : `<div class="bl-act">
          ${started ? '' : `<button class="btn primary bl-arrive" data-arrive="${esc(it.id)}">${icon(isTransit(it) ? 'nav' : 'pin')}${arriveLabel(it)}</button>`}
          <button class="btn ${started ? 'primary' : ''}" data-done="${esc(it.id)}">${icon('check')}${doneLabel(it)}</button>
          <button class="btn" data-item-skip="${esc(it.id)}">${icon('skip')}건너뛰기</button>
        </div>`}`).join('')}
      ${catchBtn(head, items, now)}
      ${aiKey() ? `<button class="btn ai wide ai-late" data-ai-plan="late">${aiLabel('조정 방법 물어보기')}</button>` : ''}
    </div>`;
}
// Every stop's time has come and some are still open: close the day in one go, so the stamp card can show.
function wrapDayCard(queue) {
  if (!queue.length) return '';
  const ids = queue.map((it) => it.id).join(',');
  return `
    <div class="wrap-day">
      <div class="grow"><b>오늘 일정을 마무리할까요?</b><span>남은 ${queue.length}개를 한 번에 정리하면 오늘 도장을 찍을 수 있어요.</span></div>
      <div class="wrap-act">
        <button class="btn primary" data-wrap-day="done" data-ids="${esc(ids)}">${icon('check')}모두 완료</button>
        <button class="btn" data-wrap-day="skip" data-ids="${esc(ids)}">${icon('skip')}건너뛰고 마무리</button>
      </div>
    </div>`;
}

// Running late, one tap opens the change with the knock-on moves worked out: start the stop now,
// or give the stop under way 15 more minutes. Fixed stops can't start later.
function catchBtn(it, items, now) {
  // Once every stop's time has passed there's nothing left to push; the day gets wrapped up instead.
  if (!items.some((x) => x.startMin > now.min)) return '';
  if (isStarted(it, items)) return now.min > it.endMin - 5 ? `<button class="catch-btn" data-catch="${esc(it.id)}">${icon('clock')}15분 더 · 뒤 일정 밀기</button>` : '';
  // Not begun yet: '도착했어요' does the re-timing in one tap.
  return '';
}

// '도착했어요' (a move: '출발했어요'). Tapped 10+ minutes late on a stop that can move, the stop is re-timed
// to start now with the same length and the stops after it follow; a toast offers 되돌리기.
const arriveLabel = (it) => (isTransit(it) ? '출발했어요' : '도착했어요');
function canArrive(it, now) {
  if (!now || now.date !== it.date || it.skip || isDone(it.id)) return false;
  const items = dayItems(dayOf(it.date)).filter((x) => !x.skip);
  const q = items.find((x) => x.id === it.id);
  // Up to 30 minutes early counts too (got to the restaurant and joined the queue before its time).
  return !!q && q.startMin - 30 <= now.min && !isStarted(q, items) && !(q.startMin > now.min && isMove(q));
}
function arrive(id) {
  const now = tokyoNow();
  const items = dayItems(dayOf(findItem(id).date)).filter((x) => !x.skip);
  const idx = items.findIndex((x) => x.id === id);
  const it = items[idx];
  const late = now.min - it.startMin;
  store.set('start:' + id, true);
  // Early: the stop starts now with the same length; later stops keep their times (the gap is spare time).
  if (late < 0 && !isFixed(it)) {
    const old = store.get('edit:' + id, null);
    store.set('edit:' + id, { ...(old || {}), start: clock(now.min), end: clock(Math.min(1439, now.min + it.endMin - it.startMin)), auto: true });
    render();
    if (squeezeOf(it.date, now)) openSqueeze(it.date);
    else if ($('#sheet') && !$('#sheet').hidden) openItem(id);
    return toast(`${clock(now.min)} ${arriveLabel(it)} · ${formatLeft(-late)} 일찍 시작`, () => { store.set('edit:' + id, old); store.set('start:' + id, false); render(); }, '되돌리기');
  }
  if (late < 10 || isFixed(it)) {
    render();
    if ($('#sheet') && !$('#sheet').hidden) openItem(id);
    return toast(`${arriveLabel(it)} · ${clock(now.min)}`);
  }
  const s = now.min;
  const e = Math.min(1439, s + it.endMin - it.startMin);
  const plan = ripple(items, idx, s, e);
  const undo = {};
  const keep = (k) => { if (!(k in undo)) undo[k] = store.get('edit:' + k, null); };
  keep(id);
  store.set('edit:' + id, { ...(store.get('edit:' + id, null) || {}), start: clock(s), end: clock(e), auto: true });
  for (const c of plan.changes) {
    keep(c.it.id);
    const old = store.get('edit:' + c.it.id, null) || {};
    store.set('edit:' + c.it.id, { ...old, start: clock(c.start), ...(c.it.end || old.end ? { end: clock(c.end) } : {}), auto: true });
  }
  render();
  const sq = squeezeOf(it.date, now);
  if (sq) openSqueeze(it.date);
  else if ($('#sheet') && !$('#sheet').hidden) openItem(id);
  const wall = sq && plan.walls[0];
  const msg = `${clock(s)} ${arriveLabel(it)} · ${plan.changes.length ? `뒤 일정 ${plan.changes.length}개 ${formatLeft(late)} 밀림` : '뒤 일정은 그대로'}${wall ? ` · ${shortName(wall.it)} 맞추는 방법을 골라 주세요` : ''}`;
  toast(msg, () => {
    for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v);
    store.set('start:' + id, false);
    render();
    if ($('#sheet') && !$('#sheet').hidden) openItem(id);
  }, '되돌리기');
}

// ---------- a fixed stop squeezed: three ways to make it fit ----------
// Stops still to do before a fixed stop (Shibuya Sky 13:40) that now run into it. Each way is worked out as
// concrete times before anything changes: shorten (meals keep 40 min, others half or 20), move what doesn't
// fit to after the fixed stop, or skip the least important. The stop under way keeps its start.
const isMeal = (it) => ['meal', 'sushi', 'ramen', 'breakfast'].includes(glyph(it.icon)[0]) || /점심|저녁|식사/.test(it.title);
const isShop = (it) => glyph(it.icon)[1] === 'shop' && glyph(it.icon)[0] !== 'money';
// 머무는 시간 범위 (일정 엔진 4.4): shortest it can be · the planned length · longest it should run. Set per stop in
// the form ('stay:<id>'), else by kind: meals keep 35 min, cafés 20, shops 15, sights half (20 at least).
function stayRange(it) {
  const len = Math.max(0, it.endMin - it.startMin);
  const set = store.get('stay:' + it.id, null);
  const def = isMeal(it) ? { min: Math.min(len, 35), max: len + 30 }
    : glyph(it.icon)[0] === 'coffee' ? { min: Math.min(len, 20), max: len + 30 }
      : isShop(it) ? { min: Math.min(len, 15), max: len + 60 }
        : { min: Math.min(len, Math.max(20, Math.ceil(len / 2))), max: len + 60 };
  return { min: set?.min ?? def.min, max: set?.max ?? def.max, len, set: !!set };
}
const stayText = (r) => `보통 ${formatLeft(r.len)} · 최소 ${formatLeft(r.min)} ~ 최대 ${formatLeft(r.max)}`;
const shortName = (it) => stripEmoji(it.title).split(' · ')[0];
// A booked slot often lets you in a little late (Shibuya Sky: 13:40 slot, in by 13:59).
const lastIn = (W) => (W.enterBy ? toMin(W.enterBy) : W.startMin);
function squeezeOf(date, now) {
  if (!now || now.date !== date) return null;
  const items = dayItems(dayOf(date)).filter((x) => !x.skip);
  for (let w = 0; w < items.length; w += 1) {
    const W = items[w];
    // A booked slot still counts until its entry window closes (13:40 slot, in by 13:59) and we haven't arrived.
    if (!isFixed(W) || isDone(W.id) || isBegun(W) || lastIn(W) <= now.min) continue;
    // Stops planned before it, by the original plan: one already pushed past it (the walk there) still counts.
    const planned = (x) => toMin(rawItem(x.id)?.start || x.start);
    const from = items.filter((x) => isDone(x.id) && x.startMin <= now.min).pop() || null;
    // Still to do: anything planned after the last stop done (even if its time has passed), the one
    // under way first.
    const pend = items.filter((x) => x !== W && planned(x) < planned(W) && store.get('edit:' + x.id, null)?.past !== W.id && !isFixed(x) && !isDone(x.id)
      && (x.endMin > now.min || isBegun(x) || (from && planned(x) > planned(from))))
      .sort((a, b) => isBegun(b) - isBegun(a) || planned(a) - planned(b));
    if (!pend.some((x) => !isMove(x))) continue;
    const end = packEnd(pend, {}, [], W, now.min, from);
    if (end > lastIn(W) || pend.some((x) => x.startMin >= W.startMin)) return { items, w, W, pend, from, buf: travelMin(pend[pend.length - 1], W), over: Math.max(0, end - lastIn(W)), now };
  }
  return null;
}
// Lay the stops back to back with the time to get between them, none before `nowMin`; returns the end,
// and the times in `out`. With `to`, the end includes getting to that stop. A stop under way keeps its
// start and, if it has run over, ends now at the earliest.
const isBegun = (x) => store.get('start:' + x.id, false);
// `from` is where we are now (the last stop done), so the first stop starts after getting there; no stop
// starts before its original planned time, but an earlier push no longer holds it back.
function packEnd(seq, cut, out, to, nowMin = 0, from = null) {
  let cur = null;
  let prev = from;
  for (const x of seq) {
    const len = x.endMin - x.startMin - (cut[x.id] || 0);
    const begun = isBegun(x);
    const plan = Math.min(x.startMin, toMin(rawItem(x.id)?.start || x.start));
    const st = begun ? x.startMin : Math.max((cur ?? nowMin) + travelMin(prev, x), plan, nowMin);
    const en = begun ? Math.max(st + len, nowMin) : st + len;
    out.push({ it: x, start: st, end: en, begun });
    cur = en;
    prev = x;
  }
  return (cur ?? 0) + (to && prev ? travelMin(prev, to) : 0);
}
function squeezeWays(q) {
  const { items, w, W, pend } = q;
  const room = lastIn(W);
  const nowMin = q.now.min;
  const fits = (seq, cut = {}) => packEnd(seq, cut, [], W, nowMin, q.from) <= room;
  // Only a stop marked started (도착했어요) is under way; one whose time has merely passed can still give way.
  const started = (x) => isBegun(x);
  // What gives way first (meals keep 35 min): optional stops, then shopping (short or skipped is fine), then sights,
  // then must-sees; meals last, and a meal is never skipped.
  // A walk can become a taxi (10 min) before a meal gets shorter.
  const isWalk = (x) => isMove(x) && glyph(x.icon)[0] === 'walk';
  const tier = (x) => (isMeal(x) ? 5 : x.priority === 'optional' && !isWalk(x) ? 0 : isShop(x) ? 1 : isWalk(x) ? 2 : x.priority === 'must' ? 4 : 3);
  const minLen = (x, len) => (isWalk(x) ? Math.min(len, 10) : store.get('stay:' + x.id, null) ? Math.min(len, stayRange(x).min) : isMeal(x) ? Math.min(len, 35) : isShop(x) ? Math.min(len, 15) : Math.max(20, Math.ceil(len / 2)));
  // The least shortening that makes `seq` fit, or null, in 5-minute steps; the stop under way keeps 15 more minutes.
  const cutFor = (seq) => {
    let need = packEnd(seq, {}, [], W, nowMin, q.from) - room;
    if (need <= 0) return {};
    const cut = {};
    for (const x of seq.filter((y) => !isMove(y) || isWalk(y)).sort((a, b) => tier(a) - tier(b))) {
      const len = x.endMin - x.startMin;
      const cap = Math.max(0, Math.min(len - minLen(x, len), started(x) ? x.startMin + len - (q.now.min + 15) : len));
      const take = Math.min(cap, Math.ceil(need / 5) * 5);
      if (take > 0) { cut[x.id] = take; need -= take; }
      if (need <= 0) break;
    }
    return need <= 0 && fits(seq, cut) ? cut : null;
  };
  const lay = (seq, cut) => { const out = []; packEnd(seq, cut, out, null, nowMin, q.from); return out; };
  const line = (o, cut) => (o.begun ? `${shortName(o.it)} ${clock(o.end)}에 나가기` : `${shortName(o.it)} ${clock(o.start)}–${clock(o.end)}${cut[o.it.id] ? (isWalk(o.it) || (travelMode === 'taxi' && isLegRow(o.it)) ? ` · ${isWalk(o.it) ? '걷지 말고 ' : ''}택시로 (${o.end - o.start}분)` : ` · ${cut[o.it.id]}분 줄임`) : ''}`);
  // Every stop up to the fixed one, so the whole run to it can be checked at a glance.
  const runLines = (out, cut) => [...out.filter((o) => cut[o.it.id] || o.start !== o.it.startMin || o.end !== o.it.endMin).map((o) => line(o, cut)),
    `${shortName(W)} ${clock(Math.max(W.startMin, packEnd(out.map((o) => o.it), cut, [], W, nowMin, q.from)))} 도착 (${W.enterBy || W.start}까지)`];
  const ways = [];
  // 1. Shorten.
  const c1 = cutFor(pend);
  if (c1) {
    const out = lay(pend, c1);
    ways.push({ title: Object.keys(c1).length ? '조금씩 줄여서 맞추기' : '순서대로 다시 맞추기', out, skip: [], after: [], lines: runLines(out, c1) });
  }
  // 2. Skip shopping or sights (never a meal), with a little shortening if needed.
  const cand = pend.filter((x) => !isMove(x) && !started(x) && !isMeal(x) && (x.priority !== 'must' || isShop(x)))
    .sort((a, b) => tier(a) - tier(b) || (a.endMin - a.startMin) - (b.endMin - b.startMin));
  if (!c1) {
    let skip = [];
    let c3 = null;
    const one = cand.find((x) => cutFor(pend.filter((y) => y !== x)));
    if (one) { skip = [one]; c3 = cutFor(pend.filter((y) => y !== one)); }
    else for (const x of cand) { skip.push(x); c3 = cutFor(pend.filter((y) => !skip.includes(y))); if (c3) break; }
    if (skip.length && c3) {
      const out = lay(pend.filter((y) => !skip.includes(y)), c3);
      ways.push({ title: `${skip.map(shortName).join('·')} 건너뛰기`, out, skip, after: [], lines: [`${skip.map(shortName).join(', ')} 건너뜀`, ...runLines(out, c3)] });
    }
  }
  // 3. Move what doesn't fit to after the fixed stop: first the shopping/sights (keeping the meal on time),
  //    then, as the other choice, the meal.
  const moveWay = (pickMeal) => {
    const stay = [...pend];
    const moved = [];
    let c2 = c1;
    while (!c2) {
      const idx = stay.map((x, i) => i).filter((i) => !isMove(stay[i]) && !started(stay[i]) && isMeal(stay[i]) === pickMeal);
      if (!idx.length) return null;
      const k = idx.sort((a, b) => tier(stay[a]) - tier(stay[b]) || b - a)[0];
      moved.push(stay.splice(k, 1)[0]);
      c2 = cutFor(stay);
    }
    if (!moved.length) return null;
    moved.sort((a, b) => pend.indexOf(a) - pend.indexOf(b));
    const out = lay(stay, c2);
    let cur = W.endMin;
    let prev = W;
    // `past` marks a stop moved behind the fixed one on purpose, so it isn't read as out of order.
    const after = moved.map((x) => { const st = cur + travelMin(prev, x); const o = { it: x, start: st, end: st + x.endMin - x.startMin, past: W.id }; cur = o.end; prev = x; return o; });
    // Stops after the fixed one move along; free time soaks up the push, other fixed stops stop it.
    const rest = ripple(items, w, W.startMin, cur + travelMin(prev, items.slice(w + 1).find((x) => !pend.includes(x)))).changes.filter((c) => !moved.includes(c.it) && !pend.includes(c.it));
    const most = rest.length ? Math.max(...rest.map((c) => c.start - c.it.startMin)) : 0;
    const last = rest[rest.length - 1];
    return { title: `${moved.map(shortName).join('·')}${eulReul(shortName(moved[moved.length - 1]))} ${shortName(W)} 뒤로`, out, skip: [], after: [...after, ...rest],
      lines: [...runLines(out, c2), ...after.map((o) => `${shortName(o.it)} ${clock(o.start)}–${clock(o.end)} · ${shortName(W)} ${W.end || clock(W.endMin)} 끝나고 ${travelMin(W, o.it) ? `${travelMin(W, o.it)}분 이동` : '바로'}`),
        most ? `그 뒤 일정 ${rest.length}개 최대 ${formatLeft(most)} 밀림 · 하루 끝 ${clock(last.end)}` : '그 뒤 일정은 그대로'] };
  };
  for (const wy of [moveWay(false), moveWay(true)]) if (wy) ways.push(wy);
  // 4. 택시로 가기: the hops (and rides) to the fixed stop by taxi, so nothing gets shorter.
  // A planned ride has no distance on it: take it from the stops on either side.
  const run = [q.from, ...pend, W].filter(Boolean);
  const legKm = (x) => {
    if (x.leg?.km != null) return x.leg.km;
    const i = run.indexOf(x);
    const a = legPoint(run.slice(0, i).reverse().find((y) => !isLegRow(y)));
    const b = legPoint(run.slice(i + 1).find((y) => !isLegRow(y)));
    return a?.lat && b?.lat ? kmBetween(a, b) : null;
  };
  travelMode = 'taxi';
  try {
    const tcut = {};
    for (const x of pend) if (isLegRow(x) && !started(x) && legKm(x) != null) { const t = taxiMin(legKm(x)); if (t < x.endMin - x.startMin) tcut[x.id] = x.endMin - x.startMin - t; }
    // Only worth showing when the plain run doesn't already fit as it is, and the taxi run does.
    if (!(c1 && !Object.keys(c1).length) && fits(pend, tcut)) {
      const cut = { ...tcut };
      const out = lay(pend, cut);
      // Fare: each hop between stops (and each ride swapped for a taxi), from where the stops are.
      let km = 0; let prev = q.from;
      for (const x of [...pend, W]) { const a = prev && placeOfItem(prev.id); const b = placeOfItem(x.id); if (a?.lat && b?.lat && kmBetween(a, b) >= 0.4) km += kmBetween(a, b); prev = x; }
      km += Object.keys(tcut).reduce((t, id) => t + (legKm(pend.find((x) => x.id === id)) || 0), 0);
      ways.push({ title: `택시로 가기 · 줄이지 않고 (약 ${taxiFare(km).toLocaleString('ko-KR')}엔)`, out, skip: [], after: [], taxi: true, lines: [...runLines(out, cut), `이동은 모두 택시 · 약 ${km.toFixed(1)}km`] });
    }
  } finally { travelMode = null; }
  // 5. 가까운 곳으로 바꾸기: a stop swapped for one of the same kind near the fixed stop, so getting there is quicker.
  const near = placeOfItem(W.id) || legPoint(W);
  if (near?.lat && !(c1 && !Object.keys(c1).length)) {
    for (const x of pend.filter((y) => !isMove(y) && !started(y) && !isFixed(y) && placeCat(y))) {
      const here = placeOfItem(x.id);
      const cands = allPlaces().filter((p) => p.lat && p.id !== here?.id && p.cat === placeCat(x) && visitOf(p.id)?.again !== 'no' && openNow(p, { date: x.date, min: x.startMin }) !== false && kmBetween(p, near) <= 1.5)
        .sort((a, b) => kmBetween(a, near) - kmBetween(b, near)).slice(0, 4);
      let pick = null;
      for (const p of cands) {
        swapPreview[x.id] = p;
        const cc = cutFor(pend);
        if (cc && !Object.keys(cc).length) { pick = p; break; }
      }
      if (pick) {
        // Times and the arrival worked out with the new place still in, so they match what applying gives.
        const out = lay(pend, {});
        const lines = [`${shortName(x)} → ${pick.name} · ${shortName(W)}까지 ${distLabel(kmBetween(pick, near))}`, ...runLines(out, {})];
        delete swapPreview[x.id];
        ways.push({ title: `${shortName(x)} 대신 ${pick.name} (가까운 곳)`, out, skip: [], after: [], swap: { id: x.id, place: pick.id }, lines });
        break;
      }
      delete swapPreview[x.id];
    }
    for (const k of Object.keys(swapPreview)) delete swapPreview[k];
  }
  return ways;
}
function openSqueeze(date) {
  const q = squeezeOf(date, tokyoNow());
  if (!q) { closeSheet(); return toast('지금은 고정 일정과 겹치는 게 없어요'); }
  state.squeeze = { date, W: q.W, ways: squeezeWays(q) };
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>${esc(shortName(q.W))} ${esc(q.W.enterBy || q.W.start)}${q.W.enterBy ? '까지 입장' : '에 맞추기'}</h3></div>
    <div class="sq-why">${icon('warn')}<span>${q.over ? `이대로면 <b>${formatLeft(q.over)}</b> 모자라요.` : `${esc(q.pend.filter((x) => x.startMin >= q.W.startMin).map(shortName).join(', '))}${hasBatchim(shortName(q.pend.filter((x) => x.startMin >= q.W.startMin).pop())) ? '이' : '가'} ${esc(shortName(q.W))} 뒤로 밀려 있어요.`} ${esc(shortName(q.W))}${eunNeun(shortName(q.W))} 시간이 정해져 있어서 움직이지 않아요${q.W.enterBy ? ` (${esc(q.W.enterBy)}까지 입장하면 돼요)` : ''}${q.buf ? ` (가는 시간 ${q.buf}분 포함)` : ''}.</span></div>
    <div class="sq-now small muted">지금 일정: ${q.pend.map((x) => `${esc(shortName(x))} ${clock(x.startMin)}–${clock(x.endMin)}`).join(' → ')}</div>
    ${state.squeeze.ways.map((wy, i) => `
      <div class="sq-way">
        <b>${esc(wy.title)}</b>
        <ul>${wy.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <button class="btn ${i ? '' : 'primary'} wide" data-squeeze="${i}">${icon('check')}이대로 적용</button>
      </div>`).join('') || '<div class="ai-note">줄이거나 옮길 수 있는 일정이 없어요. 시간·내용 수정으로 직접 바꿔 주세요.</div>'}
    ${aiKey() ? `<button class="btn ai wide" data-ai-plan="late">${aiLabel('다른 방법 AI에게 물어보기')}</button>` : ''}`;
  $('#sheet').hidden = false;
}
function applySqueeze(i) {
  const wy = state.squeeze.ways[i];
  const undo = {};
  const put = (id, patch) => {
    if (!(id in undo)) undo[id] = store.get('edit:' + id, null);
    store.set('edit:' + id, { ...(store.get('edit:' + id, null) || {}), ...patch });
  };
  for (const o of [...wy.out, ...wy.after]) {
    const st = o.start; const en = o.end;
    const taxi = (wy.taxi ? isLegRow(o.it) : isMove(o.it) && glyph(o.it.icon)[0] === 'walk') && en - st < o.it.endMin - o.it.startMin;
    if (st !== o.it.startMin || en !== o.it.endMin || o.past) put(o.it.id, { start: clock(st), end: clock(Math.min(1439, en)), auto: true, ...(o.past ? { past: o.past, skip: false } : {}), ...(taxi ? { note: `택시로 ${en - st}분 (시간 맞추기)` } : {}) });
  }
  for (const x of wy.skip) put(x.id, { skip: true });
  if (wy.swap) put(wy.swap.id, { swap: wy.swap.place });
  // Arriving inside the entry window: the fixed stop starts when we get there, so the list stays in order.
  const W = state.squeeze.W;
  const lastOut = wy.out[wy.out.length - 1];
  travelMode = wy.taxi ? 'taxi' : null;
  const arrive = lastOut ? lastOut.end + travelMin(lastOut.it, W) : W.startMin;
  travelMode = null;
  if (W.enterBy && arrive > W.startMin && arrive <= toMin(W.enterBy)) put(W.id, { start: clock(arrive), auto: true });
  closeSheet();
  render();
  toast(`${wy.title} · 적용했어요`, () => { for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v); render(); }, '되돌리기');
}
// ---------- 일정 엔진 S3: 빠른 버튼 · 변경 미리보기 · 여유 (travel-app-native/docs/09-schedule-engine.md 3·4.3~4.5장) ----------
// Every on-the-spot change goes through one preview: what moves, what a fixed stop loses, then 적용 → 되돌리기.
// '점심 · 마이센 …' reads as 마이센: the meal word alone says too little in a list of changes.
const qkName = (it) => stripEmoji(it.title).replace(/^(점심|저녁|아침|조식|간식) · /, '').split(' · ')[0];
const GUARD = 20; // 고정 일정 앞 완충 (분)
// How much room is left before the next fixed stop today, laying what's still to do back to back from now.
function slackTo(date, now) {
  if (!now || now.date !== date) return null;
  const items = dayItems(dayOf(date)).filter((x) => !x.skip);
  const W = items.find((x) => isFixed(x) && !isDone(x.id) && !isBegun(x) && lastIn(x) > now.min && glyph(x.icon)[0] !== 'plane');
  if (!W) return null;
  const from = items.filter((x) => isDone(x.id) && x.startMin <= now.min).pop() || null;
  const pend = items.filter((x) => x !== W && !isFixed(x) && !isDone(x.id) && x.startMin < W.startMin && (x.endMin > now.min || isBegun(x)));
  const end = pend.length ? packEnd(pend, {}, [], W, now.min, from) : now.min + travelMin(from, W);
  return { W, slack: lastIn(W) - end };
}
function slackLine(it, now) {
  const sl = slackTo(it.date, now);
  if (!sl || sl.slack < 0 || sl.W.id === it.id) return '';
  const lvl = sl.slack >= GUARD ? 'ok' : sl.slack >= 10 ? 'tight' : 'low';
  return `<div class="slack ${lvl}">${icon(lvl === 'ok' ? 'clock' : 'warn')}<span class="grow">${esc(shortName(sl.W))} ${esc(sl.W.enterBy ? sl.W.enterBy + ' 입장' : sl.W.start)}까지 여유 <b>${formatLeft(sl.slack)}</b></span>${lvl === 'ok' ? '' : '<em>빠듯해요</em>'}</div>`;
}
const placeCat = (it) => placeOfItem(it.id)?.cat || (isMeal(it) ? 'eat' : glyph(it.icon)[0] === 'coffee' ? 'drink' : null);
function quickBar(it, kind) {
  if (isMove(it) || isDone(it.id) || it.skip) return '';
  const fixed = isFixed(it);
  const food = ['eat', 'drink'].includes(placeCat(it));
  const b = (k, ic, t) => `<button type="button" data-qk="${k}|${esc(it.id)}">${icon(ic)}${t}</button>`;
  const btns = [
    fixed ? '' : b('late', 'clock', '늦어요'),
    kind === 'now' && !fixed ? b('stay', 'plus', '더 있을래요') : '',
    food ? b('wait', 'clock', '웨이팅') : '',
    fixed ? '' : b('alt', 'swap', pinnedAlts(it.id).length ? `다른 곳 <em class="qk-n">${pinnedAlts(it.id).length}</em>` : '다른 곳'),
    fixed ? '' : `<button type="button" data-item-skip="${esc(it.id)}">${icon('skip')}건너뛰기</button>`,
    tokyoNow().date === it.date ? b('home', 'home', '오늘은 여기까지') : '',
  ].filter(Boolean);
  return btns.length ? `<div class="qk-bar">${btns.join('')}</div>` : '';
}
// late: this stop starts (and ends) `min` later · stay: it ends `min` later. The rest follows by ripple().
function qkPlan(kind, id, min) {
  const it = findItem(id);
  const items = dayItems(dayOf(it.date)).filter((x) => !x.skip);
  const idx = items.findIndex((x) => x.id === id);
  const t = items[idx];
  const s = kind === 'stay' ? t.startMin : Math.min(1439, t.startMin + min);
  const e = Math.min(1439, t.endMin + min);
  return { t, s, e, plan: ripple(items, idx, s, e) };
}
const QK = {
  late: { title: '늦어요', opts: [10, 20, 30], chip: (m) => `${m}분 늦게` },
  stay: { title: '더 있을래요', opts: [15, 30, 45], chip: (m) => `${m}분 더` },
  wait: { title: '웨이팅', opts: [15, 30, 60], chip: (m) => `대기 ${m}분` },
};
function qkPreview(kind, id, min) {
  const { t, s, e, plan } = qkPlan(kind === 'stay' ? 'stay' : 'late', id, min);
  const row = (name, a, b) => `<li><span class="grow">${esc(name)}</span><s>${a}</s><i>→</i><b>${b}</b></li>`;
  const wall0 = plan.walls[0];
  // A booked slot often lets you in a while after it starts (13:40 slot, in by 13:59): only what's past that counts.
  const over = wall0 ? wall0.over - (lastIn(wall0.it) - wall0.it.startMin) : 0;
  const wall = wall0 && over > 0 ? { ...wall0, over } : null;
  const inWindow = wall0 && over <= 0;
  return `
    <ul class="qk-list">
      ${row(qkName(t), `${clock(t.startMin)}–${clock(t.endMin)}`, `${clock(s)}–${clock(e)}`)}
      ${plan.changes.map((c) => row(qkName(c.it), clock(c.it.startMin), clock(c.start))).join('')}
    </ul>
    ${kind === 'stay' && e - s > stayRange(t).max ? `<div class="small muted qk-calm">${esc(qkName(t))}${eunNeun(qkName(t))} 보통 최대 ${formatLeft(stayRange(t).max)}이에요 · 그래도 더 있어도 돼요</div>` : ''}
    ${plan.changes.length ? '' : '<div class="small muted qk-calm">뒤 일정은 그대로예요 · 빈 시간이 흡수해요</div>'}
    ${inWindow ? `<div class="small muted qk-calm">${esc(qkName(wall0.it))} 입장 마감(${esc(wall0.it.enterBy)}) 안이라 괜찮아요</div>` : ''}
    ${wall ? `<div class="qk-wall">${icon('warn')}<span><b>${esc(shortName(wall.it))}</b>(고정)까지 ${formatLeft(wall.over)} 모자라요 · 적용하면 맞추는 방법을 바로 보여 드려요</span></div>` : ''}`;
}
function openQuick(kind, id, min) {
  const it = findItem(id);
  if (!it) return;
  if (kind === 'alt') return openAlts(id);
  if (kind === 'home') return endDay(it.date);
  const q = QK[kind];
  min = min || q.opts[1];
  state.qk = { kind, id, min };
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>${esc(qkName(it))} · ${q.title}</h3></div>
    <div class="qk-chips">${q.opts.map((m) => `<button type="button" class="${m === min ? 'on' : ''}" data-qk-min="${m}">${q.chip(m)}</button>`).join('')}</div>
    ${kind === 'wait' ? '<div class="qk-sub">기다리면</div>' : ''}
    ${qkPreview(kind, id, min)}
    <div class="btns"><button class="btn" data-close>취소</button><button class="btn primary" data-qk-apply>${icon('check')}${kind === 'wait' ? '기다릴게요' : '적용'}</button></div>
    ${kind === 'wait' ? `<div class="qk-sub">다른 곳으로 가면</div>${altList(it)}` : ''}`;
  $('#sheet').hidden = false;
}
function applyQuick() {
  const { kind, id, min } = state.qk;
  const { t, s, e, plan } = qkPlan(kind === 'stay' ? 'stay' : 'late', id, min);
  const undo = {};
  const put = (k, patch) => { if (!(k in undo)) undo[k] = store.get('edit:' + k, null); store.set('edit:' + k, { ...(store.get('edit:' + k, null) || {}), ...patch }); };
  put(id, { start: clock(s), end: clock(e), auto: true });
  for (const c of plan.changes) put(c.it.id, { start: clock(c.start), ...(c.it.end || store.get('edit:' + c.it.id, null)?.end ? { end: clock(c.end) } : {}), auto: true });
  closeSheet();
  render();
  toast(`${QK[kind].chip(min)} · ${plan.changes.length ? `뒤 일정 ${plan.changes.length}개 조정` : '뒤 일정은 그대로'}`, () => { for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v); render(); }, '되돌리기');
  if (squeezeOf(t.date, tokyoNow())) openSqueeze(t.date);
}
// Places of the same kind near this stop: walk time, open now, rating; picking one swaps the stop (S1/S2 redo the legs).
// Alternatives picked ahead for a stop ('alts:<id>', two at most): shown first wherever alternatives are.
const pinnedAlts = (id) => store.get('alts:' + id, []).map(String);
function pinAlt(id, pid) {
  const list = pinnedAlts(id);
  const on = list.includes(pid);
  if (!on && list.length >= 2) return toast('대안은 두 곳까지 붙여 둘 수 있어요');
  store.set('alts:' + id, on ? list.filter((x) => x !== pid) : [...list, pid]);
  toast(on ? '대안에서 뺐어요' : '대안으로 붙여 두었어요 · 웨이팅·다른 곳에서 먼저 보여요');
  if (state.sheetItem === id && !$('#sheet').hidden && $('#sheet-body .alt-card')) openItem(id); else if (!$('#sheet').hidden && $('#sheet-body .qk-alts')) openAlts(id);
}
function altPlaces(it) {
  const pins = pinnedAlts(it.id);
  const list = altPlacesNear(it) || [];
  const here = placeOfItem(it.id);
  const pt = here?.lat ? here : legPoint(it);
  const now = tokyoNow();
  const extra = pins.filter((pid) => !list.some((x) => String(x.p.id) === pid)).map((pid) => placeById(pid)).filter((p) => p?.lat && pt?.lat)
    .map((p) => ({ p, km: kmBetween(pt, p), open: openNow(p, now.date === it.date ? now : { date: it.date, min: it.startMin }) }));
  const all = [...list, ...extra].map((x) => ({ ...x, pin: pins.includes(String(x.p.id)) }));
  return all.sort((a, b) => b.pin - a.pin).slice(0, Math.max(5, pins.length));
}
function altPlacesNear(it) {
  const here = placeOfItem(it.id);
  const pt = here?.lat ? here : legPoint(it);
  if (!pt?.lat) return null;
  const cat = placeCat(it);
  if (!cat || it.hard) return [];
  const now = tokyoNow();
  // Not a place already on that day's plan (or planned for another day).
  const taken = new Set(dayItems(dayOf(it.date)).map((x) => placeOfItem(x.id)?.id));
  allPlaces().filter((p) => p.itemId).forEach((p) => taken.add(p.id));
  return allPlaces()
    .filter((p) => p.lat && p.id !== here?.id && !taken.has(p.id) && p.cat === cat && visitOf(p.id)?.again !== 'no')
    .map((p) => ({ p, km: kmBetween(pt, p), open: openNow(p, now.date === it.date ? now : { date: it.date, min: it.startMin }) }))
    .filter((x) => x.km <= 2 && x.open !== false)
    .sort((a, b) => (b.open === true) - (a.open === true) || a.km - b.km)
    .slice(0, 5);
}
function altList(it) {
  const list = (placeOfItem(it.id)?.lat || legPoint(it)?.lat) ? altPlaces(it) : null;
  if (!list) return '<div class="small muted">이 일정은 위치 정보가 없어 근처 대안을 찾지 못했어요. 탐색 탭에서 골라 주세요.</div>';
  if (!list.length) return '<div class="small muted">2km 안에 같은 종류의 저장된 장소가 없어요. 탐색 탭의 ＋로 찾아 주세요.</div>';
  return `<div class="qk-alts">${list.map(({ p, km, open, pin }) => `
    <button type="button" class="qk-alt" data-qk-swap="${esc(it.id)}|${esc(p.id)}">
      <span class="grow"><b>${pin ? '<em class="alt-pin-tag">미리 정한 곳</em>' : ''}${esc(p.name)}</b><small>${[`${km <= 1.2 ? '도보' : '이동'} 약 ${km <= 1.2 ? Math.max(1, Math.ceil((km * 1300) / 75)) : Math.ceil(km * 3 + 10)}분`, distLabel(km), open === true ? '영업 중' : '', p.area].filter(Boolean).map(esc).join(' · ')}</small></span>
      <em>여기로</em>
    </button>`).join('')}</div>`;
}
function openAlts(id) {
  const it = findItem(id);
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>${esc(qkName(it))} 대신</h3></div>
    <div class="small muted">같은 종류 · 2km 안 · 가까운 순 (영업 중 먼저). 고르면 이 시간에 그곳으로 바꾸고, 앞뒤 이동을 다시 계산해요.</div>
    ${altList(it)}`;
  $('#sheet').hidden = false;
}
function quickSwap(id, placeId) {
  const old = store.get('edit:' + id, null);
  store.set('edit:' + id, { ...(old || {}), swap: placeId });
  closeSheet();
  render();
  const day = findItem(id)?.date;
  const redone = planItems().some((x) => x.leg && !x.del && x.date === day);
  toast(`${placeById(placeId)?.name || '다른 곳'}(으)로 바꿨어요${redone ? ' · 이동을 다시 계산했어요' : ''}`, () => { store.set('edit:' + id, old); render(); }, '되돌리기');
}

// Shown above the fixed stop in the day's list and on the today tab.
const squeezeBar = (q) => `<button class="sq-bar" data-squeeze-open="${esc(q.W.date)}">${icon('warn')}<span class="grow"><b>${esc(shortName(q.W))} ${esc(q.W.enterBy ? q.W.enterBy + ' 입장' : q.W.start)}${q.over ? `까지 ${formatLeft(q.over)} 모자라요` : ' 앞 일정 순서가 꼬였어요'}</b><small>맞추는 방법 보기</small></span><i class="chev"></i></button>`;

function heroCard(it, kind, now, started = true) {
  const progress = kind === 'now'
    ? Math.max(0, Math.min(100, ((now.min - it.startMin) / (it.endMin - it.startMin)) * 100))
    : 0;
  // Past its start time, a stop asks whether it really began; past its end, whether it's over.
  const waiting = kind === 'now' && !started;
  const over = kind === 'now' && started ? now.min - it.endMin : 0;
  const passed = now.min - it.startMin;
  const label = waiting
    ? (passed ? `시작 시간 ${formatLeft(passed)} 지남` : '시작 시간이에요')
    : over > 0 ? `예정보다 ${formatLeft(over)} 지남`
      : kind === 'now' ? `지금 · ${it.endMin - now.min}분 남음` : `다음 · ${formatLeft(it.startMin - now.min)} 후`;
  const items = kind === 'now' ? dayItems(dayOf(it.date)).filter((x) => !x.skip) : [];
  return `
    <div class="hero ${kind} ${waiting || over > 0 ? 'wait' : ''}" data-item="${esc(it.id)}" role="button" tabindex="0">
      <div class="hero-sun"></div>
      <div class="hero-bar">
        <div class="eyebrow">${waiting || over > 0 ? `<span class="late-badge">${icon('warn')}${esc(label)}</span>` : `<i class="pulse"></i>${esc(label)}`}${tagFor(it)}</div>
        <div class="hero-time">${esc(it.start)}${it.end ? '–' + esc(it.end) : ''}</div>
      </div>
      <div class="hero-head">
        ${itemIcon(it.icon, 'lg')}
        <div class="hero-body">
          <div class="hero-title">${esc(it.title)}</div>
          ${it.place && it.place.lang !== 'ko' ? `<div class="hero-ja ja">${esc(it.place.nameJa)}</div>` : ''}
          ${it.note || wxFor(it) ? `<div class="hero-note">${heroWx(it)}${esc(it.note || '')}</div>` : ''}
        </div>
        <i class="chev" aria-label="자세히"></i>
      </div>
      ${chipsHtml(chipsFor(it, now, kind !== 'now').filter(noTag))}
      ${kind === 'next' && canArrive(it, now) ? `<div class="start-ask"><span class="grow">벌써 도착했나요?</span><button class="start-yes" data-arrive="${esc(it.id)}">${icon('check')}${arriveLabel(it)}</button></div>` : ''}
      ${waiting ? `<div class="start-ask"><span class="grow">${isTransit(it) ? '출발했나요?' : '도착했나요?'}</span><button class="start-yes" data-arrive="${esc(it.id)}">${icon('check')}${arriveLabel(it)}</button><button data-item-edit="${esc(it.id)}">${icon('clock')}시간 변경</button></div>` : ''}
      ${over > 0 ? `<div class="start-ask"><span class="grow">끝났나요?</span><button class="start-yes" data-done="${esc(it.id)}">${icon('check')}${doneLabel(it)}</button><button data-item-edit="${esc(it.id)}">${icon('clock')}시간 변경</button></div>` : ''}
      ${kind === 'now' && started && over <= 0 && !isDone(it.id) ? `<div class="start-ask in"><span class="grow">${icon('check')}${isBegun(it) ? `${arriveLabel(it)}${isTransit(it) ? '' : ' · 나갈 때 눌러요'}` : '진행 중 · 끝나면 눌러요'}</span><button class="start-yes done-yes" data-done="${esc(it.id)}">${icon('check')}${doneLabel(it)}</button></div>` : ''}
      ${kind === 'now' || kind === 'next' ? quickBar(it, kind) : ''}
      ${kind === 'now' || kind === 'next' ? slackLine(it, now) : ''}
      ${kind === 'now' && !waiting && over <= 0 ? `<div class="meter"><i style="width:${progress}%"></i></div>` : ''}
      ${it.docs ? `<div class="doc-row">${docBtns(it, 'doc-chip')}</div>` : ''}
      ${it.place ? `<div class="btns">
        ${it.place.lang === 'ko' ? navBtn(it.id, '네이버지도로 보기', 'primary wide') : `${navBtn(it.id, '구글맵 길찾기')}<button class="btn ghost" data-ja="${esc(it.id)}">${icon('ja')}일본어</button>`}
      </div>` : ''}
    </div>`;
}
function heroWx(it) {
  const w = wxFor(it);
  return w ? `<span class="hero-wx">${wxIcon(w.icon)}${w.temp}°${w.pop >= 10 ? ` · 비 ${w.pop}%` : ''}</span>` : '';
}
const formatLeft = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? (m % 60) + '분' : ''}`.trim() : `${m}분`);

// Straight-line distance to the next stop; real travel time comes from the directions button.
// Getting somewhere (train, subway, bus, walk, flight), as opposed to a place you spend time at.
const TRANSIT = ['bus', 'plane', 'walk', 'train', 'metro', 'local', 'tram', 'station'];
const isTransit = (it) => isMove(it) && TRANSIT.includes(glyph(it.icon)[0]);
const flightOf = (it) => glyph(it.icon)[0] === 'plane' && state.trip.flights.find((f) => f.date === it.date && it.title.includes(f.no));

function gapLabel(it, next) {
  if (!next || isTransit(it) || isTransit(next)) return '';
  const a = next && !it.skip && !next.skip && placeOfItem(it.id);
  const b = a && placeOfItem(next.id);
  if (!b || a === b || !a.lat || !b.lat) return '';
  // Straight-line distance, so the walk adds a third for corners; about 75m a minute.
  const km = kmBetween(a, b);
  const walk = km <= 1.2;
  const mins = Math.max(1, Math.ceil((km * 1000 * 1.3) / 75));
  const spare = it.end ? next.startMin - it.endMin : null;
  const tight = walk && spare != null && mins > spare;
  const spareText = spare == null ? '' : spare <= 0 ? '여유 없음' : `여유 ${formatLeft(spare)}`;
  const text = [walk ? `걸어서 약 ${mins}분` : '지하철·택시로 이동', distLabel(km), spareText].filter(Boolean).join(' · ');
  const href = `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=${walk ? 'walking' : 'transit'}`;
  return `
    <div class="tl-walk ${tight ? 'tight' : ''}">
      <span class="wk-ico">${icon(tight ? 'warn' : walk ? 'walk' : 'metro')}</span>
      <span class="grow">${esc(text)}</span>
      <a class="wk-nav" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${walk ? '도보' : '대중교통'} 길찾기">${icon('nav')}</a>
    </div>`;
}

// In edit mode a tap opens the change form, and a "put a stop here" row sits under each stop.
function timeline(items, now, edit = false) {
  if (!items.length) return '';
  // A skipped stop shows at its planned time, so it sits where that time falls (stable for the rest).
  if (!edit) {
    const at = (it) => (it.skip ? toMin(rawItem(it.id)?.start || it.start) : it.startMin);
    items = items.map((it, i) => [it, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([it]) => it);
  }
  const live = items.filter((x) => !x.skip);
  const endId = live[live.length - 1]?.id;
  return `<div class="tl ${edit ? 'editing' : ''}">${items.map((it, i) => {
    const isToday = now && now.date === it.date;
    // A stop still unfinished stays in full view, marked as running behind, however late it gets.
    const late = !it.skip && delayOf(it, now);
    const cls = [
      isDone(it.id) ? 'done' : '',
      isToday && it.endMin <= now.min && !late ? 'past' : '',
      isToday && !isDone(it.id) && it.startMin <= now.min && now.min < it.endMin ? 'current' : '',
      late ? 'behind' : '',
      late && isFixed(it) ? 'late' : '',
      it.skip ? 'skipped' : '',
      it.priority || '',
    ].join(' ');
    const warn = chipsFor(it, now).filter(([c]) => c === 'warn' || c === 'late');
    const sq = !edit && i && isToday && isFixed(it) && squeezeOf(it.date, now);
    const bar = sq && sq.W.id === it.id ? `<div class="tl-sq">${squeezeBar(sq)}</div>` : '';
    const tail = edit ? `<button class="tl-add" data-item-new="${esc(it.date)}" data-after="${esc(it.id)}">${icon('plus')}여기에 일정 넣기</button>` : gapLabel(it, items[i + 1]);
    if (it.skip && !edit) {
      const planned = rawItem(it.id)?.start || it.start;
      return `${bar}
      <div class="tl-item skipped slim ${it.priority || ''}">
        <div class="tl-time">${esc(planned)}</div>
        <div class="tl-skip" data-item="${esc(it.id)}" role="button" tabindex="0">${icon(glyph(it.icon)[0])}<span class="grow">${esc(stripEmoji(it.title))}</span><small>건너뜀</small></div>
      </div>`;
    }
    if (isTransit(it)) return bar + transitRow(it, cls, late, now, edit, tail) + (!edit && it.id === endId ? hotelEnd(items) : '');
    return `${bar}
      <div class="tl-item ${cls}">
        <div class="tl-time">${esc(it.start)}${it.auto ? '<i class="tl-moved">조정</i>' : ''}${tlWx(it)}</div>
        <div class="tl-card" ${edit ? 'data-item-edit' : 'data-item'}="${esc(it.id)}" role="button" tabindex="0">
          ${itemIcon(it.icon)}
          <div class="tl-main">
            <div class="tl-title">${esc(it.title)}</div>
            ${infoBadge(it)}
            ${it.note ? `<div class="tl-sub">${esc(it.note)}</div>` : ''}
            ${chipsHtml(warn)}
            ${it.docs ? `<div class="doc-row">${docBtns(it, 'doc-chip')}</div>` : ''}
          </div>
          ${edit ? `<span class="tl-nav">${icon('pen')}</span>` : it.place ? `<button class="tl-nav" data-nav="${esc(it.id)}" aria-label="구글맵 길찾기">${icon('nav')}</button>` : ''}
        </div>
        ${tail}
      </div>`;
  }).join('')}</div>`;
}
// A day that ends on the way back (the last thing left is a ride or walk to the hotel) shows where it ends:
// 호텔 도착 at the time that leg gets there. Drawn only, nothing stored; a planned '호텔 복귀' stop needs none.
function hotelEnd(items) {
  const live = items.filter((x) => !x.skip);
  const last = live[live.length - 1];
  if (!last || !isLegRow(last) || isFixed(last) || live.some((x) => x.autoHotel)) return '';
  const to = last.leg?.to || (/→\s*(.+)$/.exec(stripEmoji(last.title))?.[1] || '');
  if (!last.leg?.to?.includes('호텔') && !/호텔|숙소/.test(to)) return '';
  const arrive = Math.min(1439, last.startMin + (last.leg?.min || last.endMin - last.startMin || 0));
  return `
    <div class="tl-item tl-end">
      <div class="tl-time">${clock(arrive)}<i class="tl-moved">자동</i></div>
      <div class="tl-card" data-hotel-add="${esc(last.date)}|${clock(arrive)}" role="button" tabindex="0">
        ${itemIcon('🏨')}
        <div class="tl-main">
          <div class="tl-title">호텔 도착 · 휴식</div>
          <div class="tl-sub">${esc(state.trip.stay.name)} · 앞 이동이 끝나는 시각 · 누르면 일정에 넣어요</div>
        </div>
        <span class="tl-nav">${icon('plus')}</span>
      </div>
    </div>`;
}

// A trip between places: a slim row on a dashed stretch of the line, or a boarding pass for a flight.
function transitRow(it, cls, late, now, edit, tail) {
  const attr = `${edit ? 'data-item-edit' : 'data-item'}="${esc(it.id)}" role="button" tabindex="0"`;
  const current = cls.includes('current') && !late && !cls.includes('behind');
  const f = flightOf(it);
  if (f) {
    return `
      <div class="tl-item move flight ${cls}">
        <div class="tl-time">${esc(it.start)}${isFixed(it) ? `<i class="tl-lock">${icon('lock')}</i>` : ''}</div>
        <div class="tl-flight" ${attr}>
          <div class="fl-main">
            <small>${esc(f.no)} · ${esc(f.airline)}${current ? ' · 비행 중' : ''}</small>
            <b>${esc(f.from)} ${icon('plane')} ${esc(f.to)}</b>
            <span>${esc(f.depart)} → ${esc(f.arrive)} · T${esc(f.fromTerminal)} → T${esc(f.toTerminal)}</span>
            ${late ? `<em class="mv-late">${esc(delayText(late))}</em>` : ''}
          </div>
          <div class="fl-stub">${edit ? icon('pen') : `${icon('ticket')}<span>${esc(f.duration)}</span>`}</div>
        </div>
        ${tail}
      </div>`;
  }
  const dur = it.end ? it.endMin - it.startMin : 0;
  const first = (it.note || '').split(' · ')[0];
  // A note that is only "약 15분" already says the time, so it replaces the computed length.
  const about = /^약 \d+분$/.test(first);
  const sub = [about ? first : dur > 0 ? formatLeft(dur) : '', about ? '' : first].filter(Boolean).join(' · ');
  return `
    <div class="tl-item move ${cls}">
      <div class="tl-time">${esc(it.start)}${isFixed(it) ? `<i class="tl-lock">${icon('lock')}</i>` : ''}${it.auto ? '<i class="tl-moved">조정</i>' : ''}</div>
      <div class="tl-move" ${attr}>
        <span class="mv-ico">${icon(glyph(it.icon)[0])}</span>
        <div class="tl-main">
          <div class="mv-title">${current ? '<i class="mv-now">이동 중</i>' : ''}${esc(it.title)}</div>
          ${it.line ? `<div class="mv-line">${lnRoute(it.line)}</div>` : ''}
          ${sub || late ? `<div class="mv-sub">${late ? `<em class="mv-late">${esc(delayText(late))}</em>` : ''}${esc(sub)}${it.leg ? `${it.leg.km != null ? ` · ${distLabel(it.leg.km)}` : ''}${it.leg.source === 'table' ? '<i class="leg-src" title="앱의 역 위치와 노선표로 계산했어요 · 시간은 추정">노선표 · 추정</i>' : it.leg.source === 'google' ? `<i class="leg-src g" title="구글 경로로 계산했어요">구글 · ${esc(new Date(it.leg.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }))} 기준</i>` : '<i class="leg-src" title="직선거리로 계산한 값이에요">추정</i>'}` : ''}</div>` : ''}
          ${it.leg?.steps ? legGuide(it.leg.steps, !!it.line) : ''}
          ${it.leg?.short ? `<div class="leg-short">${icon('warn')}다음 일정까지 ${formatLeft(it.leg.short)} 모자라요</div>` : ''}
          ${it.leg ? `<div class="leg-why">구간: ${esc(it.leg.from)} → ${esc(it.leg.to)}</div>` : ''}
          ${it.leg ? `<div class="leg-why">${store.get('edit:' + it.id, null)?.releg ? '지금 앞뒤 일정 기준으로 다시 계산했어요' : '앞뒤 장소가 바뀌어 이동을 다시 계산했어요'}${it.leg.source === 'estimate' ? ` · 직선거리 추정 · ${esc(routeWhy())}` : ''}</div>` : ''}
          ${it.docs ? `<div class="doc-row">${docBtns(it, 'doc-chip')}</div>` : ''}
        </div>
        ${edit ? `<span class="mv-nav">${icon('pen')}</span>` : it.place ? `<button class="mv-nav" data-nav="${esc(it.id)}" aria-label="구글맵 길찾기">${icon('nav')}</button>` : ''}
      </div>
      ${tail}
    </div>`;
}

// 지하철 안내 (일정 엔진 4.6-1): walk › line › walk strip, then per ride: line chip + name + direction,
// station numbers (or names) and stop count, times and how often it runs. Platform and car come with S2's city pack later.
function legGuide(steps, compact = false) {
  const strip = steps.map((x) => (x.mode === 'walk' ? `<span class="lg-w">${icon('walk')}${x.min}</span>` : `<span class="lg-l" style="--ln:${esc(x.line.color || '#6b7080')};--ln-ink:${esc(x.line.text || '#fff')}">${esc(lineOf(x.line)?.code || x.line.short || x.line.name)}</span>`)).join('<i class="lg-gt">›</i>');
  const rides = steps.filter((x) => x.mode === 'ride').map((x) => {
    const L = lineOf(x.line);
    const a = stationOf(x.from, L);
    const b = stationOf(x.to, L);
    const st = (s0, raw) => (s0 ? `${lnBadge(s0.l, s0.st.no)}<b>${esc(s0.st.name)}</b>` : `<b>${esc(raw)}</b>`);
    return `
      <div class="lg-ride">
        <div class="lg-top">${L ? lnPill(L) : `<span class="ln-pill" style="--ln:${esc(x.line.color || '#6b7080')};--ln-ink:${esc(x.line.text || '#fff')}">${esc(x.line.name || x.line.short)}</span>`}${x.head ? `<span class="lg-head">${esc(koHead(x.head))}</span>` : ''}</div>
        <div class="lg-st">${st(a, x.from)}<i class="ln-to">→</i>${st(b, x.to)}${x.stops ? `<span class="lg-n">${x.stops}정거장</span>` : ''}</div>
        <div class="lg-time">${x.dep && x.arr ? `<b>${esc(x.dep)} → ${esc(x.arr)}</b>` : ''}<span>${x.min}분${x.every ? ` · 약 ${x.every}분마다` : ''}</span></div>
      </div>`;
  }).join('');
  if (compact) {
    const times = steps.filter((x) => x.mode === 'ride').map((x) => `<div class="lg-time">${x.dep && x.arr ? `<b>${esc(x.dep)} → ${esc(x.arr)}</b>` : ''}<span>${x.stops ? `${x.stops}정거장 · ` : ''}${x.min}분${x.every ? ` · 약 ${x.every}분마다` : ''}</span></div>`).join('');
    return `<div class="lg-guide"><div class="lg-strip">${strip}</div>${times}</div>`;
  }
  return `<div class="lg-guide"><div class="lg-strip">${strip}</div>${rides}</div>`;
}

// 단계별 동선 (상세 화면): 출발 → 도보 n분 → 타는 역 → 노선·방면 → 내리는 역 → (갈아타기) → 도보 n분 → 도착,
// with the clock running from the leg's start (Google's own times when it gave them).
function legSteps(it) {
  const steps = it.leg?.steps;
  if (!steps?.length) return '';
  let t = Number.isFinite(it.startMin) ? it.startMin : toMin(it.start);
  const stn = (ja, L) => { const x = stationOf(ja, L); return x ? `${lnBadge(x.l, x.st.no)}<b>${esc(x.st.name)}</b>` : `<b>${esc(ja)}</b>`; };
  const rows = [`<li class="ls-pt"><i></i><span class="ls-t">${clock(t)}</span><span class="grow"><b>${esc(it.leg.from)}</b><small>출발</small></span></li>`];
  steps.forEach((x, k) => {
    if (x.mode === 'walk') {
      const next = steps[k + 1];
      const to = next?.mode === 'ride' ? `${(stationOf(next.from, lineOf(next.line))?.st.name) || next.from}역까지` : k === steps.length - 1 ? `${it.leg.to}까지` : '';
      rows.push(`<li class="ls-walk"><i>${icon('walk')}</i><span class="ls-t"></span><span class="grow">도보 ${x.min}분${to ? ` · ${esc(to)}` : ''}${x.m ? ` · ${distLabel(x.m / 1000)}` : ''}</span></li>`);
      t += x.min;
      return;
    }
    const L = lineOf(x.line);
    if (steps[k - 1]?.mode === 'ride') rows.push(`<li class="ls-walk"><i>${icon('walk')}</i><span class="ls-t"></span><span class="grow">갈아타기 · 약 5분</span></li>`);
    // Into the station and onto the platform: the wait shows as its own line so the times add up.
    const wait = x.dep ? Math.max(0, toMin(x.dep) - t) : it.leg.source === 'table' ? 4 : 0;
    if (wait > 0) rows.push(`<li class="ls-walk ls-wait"><i>${icon('clock')}</i><span class="ls-t">${clock(t)}</span><span class="grow">역 도착 · 승강장 대기 약 ${wait}분</span></li>`);
    const dep = x.dep || clock(t + wait);
    const arr = x.arr || clock(toMin(dep) + x.min);
    rows.push(`<li class="ls-st"><i></i><span class="ls-t">${esc(dep)}</span><span class="grow">${stn(x.from, L)}<small>타는 역</small></span></li>`);
    rows.push(`<li class="ls-ride" style="--ln:${esc(L?.color || x.line.color || '#6b7080')}"><i></i><span class="ls-t"></span><span class="grow">${L ? lnPill(L) : `<span class="ln-pill" style="--ln:${esc(x.line.color || '#6b7080')};--ln-ink:${esc(x.line.text || '#fff')}">${esc(x.line.name)}</span>`}<small>${esc(x.head ? koHead(x.head) : '')}${x.stops ? ` · ${x.stops}정거장` : ''} · ${x.min}분${x.every ? ` · 약 ${x.every}분마다` : ''}</small></span></li>`);
    rows.push(`<li class="ls-st"><i></i><span class="ls-t">${esc(arr)}</span><span class="grow">${stn(x.to, L)}<small>내리는 역</small></span></li>`);
    t = toMin(arr);
  });
  rows.push(`<li class="ls-pt end"><i></i><span class="ls-t">${clock(Math.min(1439, t))}</span><span class="grow"><b>${esc(it.leg.to)}</b><small>도착${it.leg.source === 'table' ? ' · 시각은 추정' : ''}</small></span></li>`);
  return `<div class="card ls-card"><div class="ls-h">${icon('route')}단계별 동선</div><ol class="ls">${rows.join('')}</ol></div>`;
}

// ---------- rail lines: the station-number square and line colour as signed in Tokyo ----------
// A light line colour (Hibiya silver) takes dark text on its pill.
const lnInk = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 160 ? '#17191e' : '#fff'; };
const lnBadge = (l, no) => `<span class="ln" style="--ln:${esc(l.color)}"><i>${esc(l.code)}</i><b>${esc(no.slice(l.code.length))}</b></span>`;
const lnPill = (l) => `<span class="ln-pill" style="--ln:${esc(l.color)};--ln-ink:${lnInk(l.color)}">${esc(l.name)}</span>`;
// "[H17] → [H11] 쓰키지 하차" for the timeline row; legs joined by a transfer mark.
const lnRoute = (legs) => `<span class="ln-route">${legs.map((l, i) => `${i ? '<i class="ln-x">갈아타기</i>' : ''}${lnBadge(l, l.from.no)}<i class="ln-to">→</i>${lnBadge(l, l.to.no)}`).join('')}<span>${esc(legs[legs.length - 1].to.name)} 하차</span></span>`;
// The card in a stop's sheet: line, direction, stations, transfers, and where to ride.
function lineCard(it) {
  const legs = it.line;
  return `
    <div class="card line-card">
      ${legs.map((l, i) => `
        ${i ? `<div class="ln-change">${icon('walk')}${esc(l.from.name)}에서 갈아타기</div>` : ''}
        <div class="ln-leg">
          <div class="ln-head">${lnPill(l)}<span class="ln-dir">${esc(l.dir)}</span></div>
          <div class="ln-stops">
            <div>${lnBadge(l, l.from.no)}<span><small>타는 역</small><b>${esc(l.from.name)}</b></span></div>
            <span class="ln-arrow" style="--ln:${esc(l.color)}"></span>
            <div>${lnBadge(l, l.to.no)}<span><small>내리는 역</small><b>${esc(l.to.name)}</b></span></div>
          </div>
        </div>`).join('')}
    </div>`;
}

function tlWx(it) {
  const w = wxFor(it);
  return w ? `<span class="tl-wx">${wxIcon(w.icon)}${w.temp}°</span>${w.pop >= 30 ? `<span class="tl-pop">${w.pop}%</span>` : ''}` : '';
}

function renderDays() {
  const now = tokyoNow();
  const { days, stay } = state.trip;
  const day = days[state.dayIndex];
  const items = dayItems(day);
  const edit = state.editDay === day.date;
  setHeader(`${state.dayIndex + 1}일차 / ${days.length}일`, stripEmoji(day.title), [dayLabel(day.date), day.sunset && `일몰 ${day.sunset}`, stay.name].filter(Boolean).join(' · '));
  return `
    <div class="daypick" role="group" aria-label="날짜 선택">
      ${days.map((d, i) => `
        <button class="dp ${d.date === now.date ? 'today' : ''} ${isDayDone(d.date, now.date) ? 'done' : ''}" data-day="${i}" aria-pressed="${i === state.dayIndex}" ${isDayDone(d.date, now.date) ? 'aria-label="완료한 날"' : ''}>
          ${isDayDone(d.date, now.date) ? `<em class="dp-ok" aria-hidden="true">${STAR5}</em>` : ''}<small>${i + 1}일차</small><b>${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}</b><span>${WEEKDAYS[dowOf(d.date)]}</span>
          ${wxDay(d.date) ? `<span class="dp-wx">${wxIcon(wxDay(d.date).icon)}${wxDay(d.date).max}°</span>` : ''}
        </button>`).join('')}
    </div>
    ${edit ? '' : daySummary(day, items, now)}
    ${wxCard(day.date, now.date === day.date ? now : null)}
    <div class="btns day-actions three">
      <button class="btn" data-day-route>${icon('nav')}동선 지도</button>
      <button class="btn" data-day-share>${icon('ext')}공유</button>
      <button class="btn ${edit ? 'primary' : ''}" data-day-edit>${icon(edit ? 'check' : 'pen')}${edit ? '편집 완료' : '편집'}</button>
    </div>
    ${!edit && aiKey() ? `<button class="btn ai wide ai-plan-btn" data-ai-plan>${aiLabel('말로 일정을 변경해 보세요')}</button>` : ''}
    ${edit ? '<div class="small muted edit-hint">일정을 누르면 고치고, ＋를 누르면 그 자리에 넣어요.</div>' : ''}
    ${edit ? '' : dayRoom(day, items, now)}
    ${timeline(items, now, edit)}
    ${edit || daySummary(day, items, now) ? '' : expenses().some((e) => e.date === day.date) ? `<div class="day-sum">${dayExpense(day.date, true)}</div>` : ''}
    <button class="btn wide day-add" data-item-new="${esc(day.date)}" data-after="${esc(items[items.length - 1]?.id || '')}">${icon('plus')}일정 추가</button>
    ${edit ? dayEditTools(day) : ''}
  `;
}

// 하루 여유 블록 (4.4): free time between stops (after getting there) for a day still to come; with no
// half-hour anywhere, offer to put one in the afternoon.
function dayRoom(day, items, now) {
  if (day.date < now.date || isDayDone(day.date, now.date)) return '';
  const stops = items.filter((x) => !x.skip && isStopRow(x) && x.endMin > x.startMin);
  if (stops.length < 3) return '';
  const all = items.filter((x) => !x.skip);
  let free = 0; let best = null;
  for (let i = 0; i < all.length - 1; i += 1) {
    const a = all[i]; const b = all[i + 1];
    const g = b.startMin - a.endMin - (isLegRow(a) || isLegRow(b) ? 0 : travelMin(a, b));
    if (g > 0) { free += g; if (!best || g > best.g) best = { g, a }; }
  }
  if (best?.g >= 30) return `<div class="day-room ok">${icon('clock')}<span class="grow">빈 시간 ${formatLeft(free)} · 가장 긴 여유 ${formatLeft(best.g)} (${clock(best.a.endMin)}~)</span></div>`;
  const pm = stops.filter((x) => !isFixed(x) && x.endMin >= 780 && x.endMin <= 1020);
  const at = (pm[0] || stops[Math.floor(stops.length / 2)]).id;
  return `<div class="day-room low">${icon('warn')}<span class="grow"><b>30분 넘는 여유가 없어요</b><small>빈 시간 ${formatLeft(free)}뿐이에요 · 늦어지면 뒤 일정이 모두 밀려요</small></span><button class="btn" data-item-new="${esc(day.date)}" data-after="${esc(at)}" data-rest="1">${icon('plus')}여유 30분 넣기</button></div>`;
}

// Once a day is over, its record sits under the last stop: the stamp, what we did, what we spent, what we'd go back for.
const EXP_COLOR = { 식당: 'meal', 카페: 'cafe', 편의점: 'konbini', 교통: 'move', 쇼핑: 'shop', 관광: 'see', 기타: 'etc' };
// Paid in won: show the won actually paid, with the yen it counts as; in yen: yen, with roughly how much in won.
const expMain = (e) => (e.orig?.cur === 'KRW' ? `${e.orig.value.toLocaleString('ko-KR')}원` : yen(e.amount));
const expAlt = (e) => (e.orig?.cur === 'KRW' ? `≈ ${yen(e.amount)}` : `약 ${won(e.amount)}`);
function dayExpense(date, open) {
  const list = expenses().filter((e) => e.date === date);
  if (!list.length) return open ? '' : `<button class="day-sum-row" data-go-exp>${secIcon('money')}<span class="grow"><b>기록한 지출 없음</b><small>예약 탭 경비에서 기록하거나 카드 문자로 등록해요</small></span></button>`;
  const total = list.reduce((a, e) => a + e.amount, 0);
  const card = list.filter((e) => e.pay !== 'cash').reduce((a, e) => a + e.amount, 0);
  const cash = total - card;
  const cats = Object.entries(list.reduce((m, e) => ({ ...m, [e.cat]: (m[e.cat] || 0) + e.amount }), {})).sort((a, b) => b[1] - a[1]);
  // Time of each payment: the card message's time, else the stop it was logged at.
  const rows = list.map((e) => {
    const t = expTime(e);
    const it = e.item && findItem(e.item);
    const name = expTitle(e) === e.cat && !e.memo ? '' : expTitle(e);
    return { e, time: t ? t.padStart(5, '0') : it?.start || '', name: name || (it ? stripEmoji(it.title).split(' · ')[0] : e.cat), stop: it && t ? stripEmoji(it.title).split(' · ')[0] : '' };
  }).sort((a, b) => (a.time || '99') .localeCompare(b.time || '99') || a.e.at - b.e.at);
  return `
    <div class="dx">
      <div class="dx-head">${secIcon('money')}
        <div class="grow"><small>${open ? '오늘 지출' : '그날 지출'} · ${list.length}건</small><b>${yen(total)}</b>
          <span>약 ${manwon(total)}${card && cash ? ` · 카드 ${yen(card)} · 현금 ${yen(cash)}` : cash ? ' · 모두 현금' : ' · 모두 카드'}</span></div>
      </div>
      <div class="dx-bar" aria-hidden="true">${cats.map(([c, n]) => `<i class="x-${EXP_COLOR[c] || 'etc'}" style="flex:${n}"></i>`).join('')}</div>
      <div class="dx-cats">${cats.map(([c, n]) => `<span><i class="x-${EXP_COLOR[c] || 'etc'}"></i>${esc(c)} <b>${yen(n)}</b> <em>${Math.round((n / total) * 100)}%</em></span>`).join('')}</div>
      <div class="dx-list">${rows.map(({ e, time, name, stop }) => `
        <button class="dx-row" data-exp-edit="${esc(e.id)}">
          <span class="dx-t">${esc(time || '–')}</span>
          <span class="grow"><b>${esc(name)}</b><small><i class="x-${EXP_COLOR[e.cat] || 'etc'}"></i>${esc(e.cat)} · ${e.pay === 'cash' ? '현금' : '카드'}${stop ? ` · ${esc(stop)}` : ''}</small></span>
          <span class="dx-amt"><b>${expMain(e)}</b><small>${expAlt(e)}</small></span>
        </button>`).join('')}
      </div>
      <button class="dx-more" data-go-exp>경비 전체 보기 · 예약 탭</button>
    </div>`;
}

// 하루 요약은 날씨 위에서 접고 펼쳐요. 기본은 접힘, 이 폰에서 연 날만 기억해요.
const daySumOpen = (date) => { try { return JSON.parse(localStorage.getItem('daySumOpen') || '[]').includes(date); } catch { return false; } };
function daySummary(day, items, now) {
  const live = items.filter((it) => !it.skip);
  const sealed = store.get('seal:' + day.date, false);
  const over = day.date < now.date || (day.date === now.date && (sealed || (!dueQueue(live, now).length && !live.some((it) => it.startMin > now.min))));
  if (!over) return '';
  const dayIdx = state.trip.days.findIndex((d) => d.date === day.date);
  const done = live.filter((it) => isDone(it.id));
  const visited = done.filter((it) => placeOfItem(it.id)).length;
  const skipped = items.filter((it) => it.skip).length;
  const notes = live.map((it) => [it, placeOfItem(it.id)]).filter(([, p]) => p).map(([it, p]) => ({ it, p, v: visitOf(p.id) }))
    .filter(({ v }) => v && (v.again || v.memo));
  const open = daySumOpen(day.date);
  return `
    <div class="day-sum ${open ? 'open' : 'folded'}">
      <div class="day-sum-head" data-sum-fold="${esc(day.date)}" role="button" tabindex="0" aria-expanded="${open}">
        ${sealed ? `<span class="pstamp" aria-label="${dayIdx + 1}일차 완주"><i class="ps-star">${STAR5}</i><small>TOKYO</small><b>${dayIdx + 1}일차</b><small>${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))} 완주</small></span>` : `<button class="pslot" data-seal="${esc(day.date)}"><i class="ps-star">${STAR5}</i><span>도장<br>찍기</span></button>`}
        <div class="grow">
          <b>${dayIdx + 1}일차 요약</b>
          <span>${[`일정 ${done.length}/${live.length} 완료`, visited ? `방문 ${visited}곳` : '', skipped ? `건너뜀 ${skipped}` : ''].filter(Boolean).join(' · ')}</span>
        </div>
        <i class="chev ${open ? 'up' : ''}" aria-hidden="true"></i>
      </div>
      ${open ? `
      ${daySumWeather(day.date)}
      ${diaryCard(day.date)}
      ${dayExpense(day.date, false)}
      ${notes.map(({ it, p, v }) => `
        <button class="day-sum-row" data-item="${esc(it.id)}">
          ${itemIcon(it.icon)}<span class="grow"><b>${esc(p.name)}${v.again ? `<em class="${v.again}">${againIcon(v.again)}${AGAIN[v.again]}</em>` : ''}</b>${v.memo ? `<small>${esc(v.memo)}</small>` : ''}</span>
        </button>`).join('')}` : ''}
    </div>`;
}

// 다른 여행메이트의 옷차림 한 줄씩 (많으면 4명까지)
function othersGear(pick) {
  const rows = mates().filter((m) => m.id !== meId()).map((m) => [m.nick, gearText(pick(m)).join(' · ')]).filter(([, t]) => t);
  return rows.slice(0, 4);
}
// The day's weather in words, then how this phone's person got on with umbrella, sunglasses and coat.
function daySumWeather(date) {
  const st = wxStory(date);
  const me = myNick();
  const g = gearLog(date, meId()) || {};
  const theirs = othersGear((m) => gearLog(date, m.id));
  // The last day has no next morning to advise, so only the memo stays.
  const last = date === state.trip.days[state.trip.days.length - 1].date;
  return `
    ${st ? `<div class="day-sum-row static">${wxIcon(st.icon)}<span class="grow"><b>${esc(st.head)}</b><small>${esc(st.line)}</small></span></div>` : ''}
    <div class="gear-fb">
      ${last ? `<div class="gear-q">${esc(me)} · 오늘 한 줄 메모</div>` : `<div class="gear-q">${esc(me)} · 오늘 옷차림 어땠나요?</div>
      ${GEAR.map(([k, ic, label, opts]) => `
        <div class="gear-row"><span class="gear-l">${icon(ic)}${label}</span>
          <div class="gear-opts">${opts.map(([v, t]) => `<button type="button" class="${g[k] === v ? 'on' : ''}" data-gear="${esc(date)}|${k}|${v}">${t}</button>`).join('')}</div></div>`).join('')}`}
      <input class="input gear-memo" data-gear-memo="${esc(date)}" value="${esc(g.memo || '')}" maxlength="120" placeholder="한 줄 메모 · 예: 맑아서 눈이 무척 부셨음" autocomplete="off">
      ${theirs.map(([n, t]) => `<div class="small muted gear-other">${esc(n)}: ${esc(t)}</div>`).join('')}
      ${last ? '' : '<div class="small muted gear-note">추웠다·더웠다고 남기면 다음 날 겉옷 추천이 한 단계 바뀌어요.</div>'}
    </div>`;
}

// "우산·선글라스는 두고 가도 돼요 · 비 최대 20%, 자외선 약함 (1)": the topic particle follows the last word.
const eunNeun = (w) => { const c = w.charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c < 11172 && c % 28 ? '은' : '는'; };
const skipLine = (skip) => { const names = skip.map(([n]) => n); return `${names.join('·')}${eunNeun(names[names.length - 1])} 두고 가도 돼요 · ${skip.map(([, w]) => w).join(', ')}`; };

// Evening look at tomorrow's weather and what to bring, opening that day in the 일정 tab.
function tomorrowCard(tday, idx) {
  const w = wxDay(tday.date);
  if (!w) return '';
  const st = wxStory(tday.date);
  const g = gearFor(tday.date, dayItems(tday).filter((it) => !it.skip), meId());
  const bring = g?.need.map((n) => n.label) || [];
  const out = wxHours(tday.date, 8, 22).reduce((a, h) => a + h.rain, 0);
  const rain = w.rain < 1 ? (w.pop >= 30 ? `비 ${w.pop}%` : '') : out < w.rain / 3 ? `비 ${w.rain.toFixed(0)}mm (대부분 새벽·밤, 낮 ${mm(out)})` : `비 ${w.rain.toFixed(0)}mm`;
  const facts = [`${w.min}~${w.max}°`, rain].filter(Boolean);
  return `
    <button class="tmr" data-tomorrow="${idx}">
      ${wxIcon(st?.icon || w.icon)}<span class="grow"><small>내일 · ${esc(dayLabel(tday.date))}</small><b>${esc(st?.head || w.label)}</b>
        <span>${esc(facts.join(' · '))}${bring.length ? ` · 챙길 것 ${esc(bring.join(', '))}` : ''}</span></span>
    </button>`;
}

const hasBatchim = (w) => { const c = w.charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c < 11172 && c % 28 > 0; };
const eulReul = (w) => (hasBatchim(w) ? '을' : '를');
// A small stable pick per date, so the greeting changes day to day but not on every redraw.
const pickFor = (key, list) => list[[...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7) % list.length];

// The assistant-style hello at the top of the morning card: name, the day's shape, the one fixed time, the weather in a word.
function greeting(day, items, g, now) {
  const call = callMe();
  const days = state.trip.days;
  const idx = days.indexOf(day);
  const last = idx === days.length - 1;
  const hello = idx === 0 ? `${call}, 드디어 도쿄 가는 날이에요`
    : last ? `${call}, 벌써 마지막 날이에요`
    : now.min < 360 ? `${call}, 일찍 일어나셨네요`
    : pickFor(day.date + me, [`${call}, 좋은 아침이에요`, `${call}, 잘 주무셨어요?`, `${call}, 도쿄 ${idx + 1}일째 아침이에요`]);
  const spots = stripEmoji(day.title).split(' · ').filter((t) => !/도착|귀국|문화의 날/.test(t));
  const say = [];
  if (last) say.push(`${spots.join('·')} 들렀다가 귀국하는 날이에요. 마지막까지 알차게 챙겨 드릴게요.`);
  else if (idx === 0) say.push(`${spots.join('·')}에서 첫날을 보내요. 오늘 일정은 제가 하나씩 알려 드릴게요.`);
  else if (spots.length >= 2) say.push(`오늘은 ${spots[0]}에서 시작해 ${spots[spots.length - 1]}까지 가는 날이에요.`);
  else if (spots.length) say.push(`오늘은 ${spots[0]}에서 보내는 날이에요.`);
  const fixed = items.find((it) => isFixed(it) && !isMove(it) && it.startMin > now.min);
  if (fixed) { const t = stripEmoji(fixed.title).split(' · ')[0]; say.push(`${fixed.start} ${t}${eunNeun(t)} 시간이 정해져 있으니 제가 잊지 않게 챙길게요.`); }
  const um = g.need.find((n) => n.key === 'umbrella');
  const sp = rainSpan(day.date);
  const coat = g.need.find((n) => n.key === 'coat');
  if (um && sp) say.push(`${sp.when} 비 소식이 있어서 ${um.label}${eulReul(um.label)} ${um.label === '튼튼한 우산' ? '꼭 챙겨 주세요' : '챙겨 두면 든든해요'}.`);
  else if (um) say.push(`비가 올 수도 있으니 ${um.label}${eulReul(um.label)} 챙겨 두면 든든해요.`);
  else if (coat?.label === '따뜻한 겉옷') say.push('쌀쌀한 날이라 따뜻하게 입고 나가세요.');
  else say.push(pickFor(day.date, ['비 소식 없이 걷기 좋은 날씨예요.', '우산 걱정 없는 하루예요. 가볍게 나가셔도 돼요.']));
  return { hello, say: say.join(' ') };
}

// Before the first stop: yesterday against today, and what to bring, tuned by what this person said about yesterday.
function prepCard(day, items, now) {
  const first = items.find((it) => !it.skip);
  const st = store.get('prep:' + day.date, {});
  if (st.done || now.min < 240 || (first && now.min >= first.startMin)) return '';
  const g = gearFor(day.date, items, meId());
  const today = wxDay(day.date);
  if (!g || !today) return '';
  const hi = greeting(day, items, g, now);
  const yd = wxDay(addDays(day.date, -1));
  const bring = g.need.map((n) => n.label);
  state.brief = [`${hi.hello}.`, hi.say, bring.length ? `오늘 챙길 것은 ${bring.join(', ')}이에요.` : '', g.skip.length ? `${skipLine(g.skip).split(' · ')[0]}.` : '', '좋은 하루 보내세요.'].filter(Boolean).join(' ');
  const story = wxStory(day.date);
  const diff = yd ? today.max - yd.max : 0;
  const cmp = !yd ? '' : Math.abs(diff) <= 1 ? '어제와 기온이 비슷하고' : `어제보다 ${Math.abs(diff)}° ${diff > 0 ? '따뜻하고' : '쌀쌀하고'}`;
  const ck = st.ck || {};
  const theirs = othersGear((m) => lastGear(day.date, m.id));
  return `
    <div class="prep">
      <div class="prep-head">${wxIcon(today.icon)}<div class="grow"><span>오늘 아침 준비 · ${esc(dayLabel(day.date))}</span><b>${esc(hi.hello)}</b></div>
        <button type="button" class="prep-nick" data-nick aria-label="닉네임 바꾸기">${icon('pen')}</button></div>
      <p class="prep-hi">${esc(hi.say)}</p>
      <button type="button" class="prep-listen ${state.briefing ? 'on' : ''}" data-brief>${icon('sound')}<span class="play">브리핑 듣기</span><span class="stop">멈추기</span></button>
      <div class="prep-cmp"><b>${esc([cmp, story?.head].filter(Boolean).join(' '))}</b>
        ${yd ? `<small>어제 ${yd.min}~${yd.max}° ${esc(wxStory(addDays(day.date, -1))?.sky || yd.label)} → 오늘 ${today.min}~${today.max}° ${esc(story?.sky || today.label)}</small>` : ''}</div>
      <div class="prep-list">${g.need.map((n) => `
        <button type="button" class="prep-item ${ck[n.key] ? 'on' : ''}" data-prep="${esc(day.date)}|${n.key}">
          <i class="check-box"></i>${icon(n.icon)}<span class="grow"><b>${esc(n.label)}</b><small>${esc(n.why)}</small></span>
        </button>`).join('') || '<div class="small muted">오늘은 따로 챙길 게 없어요.</div>'}</div>
      ${g.skip.length ? `<div class="prep-skip">${esc(skipLine(g.skip))}</div>` : ''}
      ${g.bias.notes.length || g.bias.memo ? `<div class="prep-note">${icon('heart')}<span>${esc(g.bias.notes.join(' '))}${g.bias.memo ? ` <q>${esc(g.bias.memo)}</q>` : ''}</span></div>` : ''}
      ${theirs.map(([n, t]) => `<div class="prep-skip">${esc(n)}의 지난 기록 · ${esc(t)}</div>`).join('')}
      <button class="btn primary wide prep-done" data-prep-done="${esc(day.date)}">${icon('check')}준비 완료</button>
    </div>`;
}

// Edit mode extras: deleted stops to bring back, and a way back to the planned times.
function dayEditTools(day) {
  const gone = effectiveItems(day, true).filter((it) => it.del);
  const moved = effectiveItems(day).filter((it) => it.auto || (rawItem(it.id) && it.start !== rawItem(it.id).start));
  return `
    ${gone.length ? `<div class="section-title"><span>삭제한 일정</span><em>${gone.length}</em></div>
      <div class="card list">${gone.map((it) => `
        <div class="gone-row"><span class="grow"><b>${esc(it.title)}</b><small>${esc(it.start)}</small></span>
          <button class="btn" data-item-restore="${esc(it.id)}">${icon('refresh')}되살리기</button></div>`).join('')}</div>` : ''}
    ${moved.length ? `<button class="btn wide day-reset" data-day-reset="${esc(day.date)}">${icon('refresh')}이날 시간을 원래 계획으로 (${moved.length}개)</button>` : ''}`;
}

function dayRoute() {
  const stops = dayItems(state.trip.days[state.dayIndex])
    .filter((it) => !it.skip && it.place && it.place.lang !== 'ko')
    .map((it) => it.place.query || it.place.nameJa)
    .filter((q, i, all) => q !== all[i - 1]);
  if (stops.length < 2) return toast('지도로 묶을 장소가 부족해요.');
  const between = stops.slice(1, -1);
  const keep = between.filter((_, i) => between.length <= 9 || Math.floor((i * 9) / between.length) !== Math.floor(((i - 1) * 9) / between.length));
  const q = new URLSearchParams({ api: '1', origin: stops[0], destination: stops[stops.length - 1], travelmode: 'walking' });
  const via = keep.slice(0, 9).map(encodeURIComponent).join('%7C');
  window.open(`https://www.google.com/maps/dir/?${q}${via ? `&waypoints=${via}` : ''}`, '_blank', 'noopener');
}

async function shareDay() {
  const day = state.trip.days[state.dayIndex];
  const text = [`도쿄 ${dayLabel(day.date)} ${stripEmoji(day.title)}`,
    ...dayItems(day).filter((it) => !it.skip).map((it) => `${it.start} ${stripEmoji(it.title)}`)].join('\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('일정을 복사했어요'); }
  } catch (e) { if (e.name !== 'AbortError') toast('공유하지 못했어요'); }
}

function boardingPass(f) {
  const pnr = store.get('pnr', '');
  return `
    <div class="pass">
      <div class="pass-top">
        <span class="pass-air">${esc(f.airline)} · ${esc(f.no)}</span>
        <span class="pass-tag">${esc(f.label)}</span>
      </div>
      <div class="pass-route">
        <div><b>${esc(f.from)}</b><span>${esc(f.fromName)} T${esc(f.fromTerminal)}</span></div>
        <div class="pass-mid"><i></i><span>${esc(f.duration)}</span></div>
        <div class="r"><b>${esc(f.to)}</b><span>${esc(f.toName)} T${esc(f.toTerminal)}</span></div>
      </div>
      <div class="pass-cut"></div>
      <div class="pass-grid">
        <div><small>날짜</small><b>${esc(dayLabel(f.date))}</b></div>
        <div><small>출발</small><b>${esc(f.depart)}</b></div>
        <div><small>도착</small><b>${esc(f.arrive)}</b></div>
        <div><small>좌석</small><b>${esc(f.cabin)}</b></div>
        <div><small>수하물</small><b>${esc(f.baggage)}</b></div>
        <div><small>예약번호</small><b class="mono">${esc(pnr || '—')}</b></div>
      </div>
    </div>`;
}

function transferPass(t) {
  return `
    <div class="pass">
      <div class="pass-top">
        <span class="pass-air">${itemIcon(t.icon, 'inline')}${esc(t.label)}</span>
        <span class="pass-tag ok">${esc(t.status)}</span>
      </div>
      <div class="pass-route bus">
        <div><b>${esc(t.from)}</b><span>${esc(t.depart)} 출발</span></div>
        <div class="pass-mid"><i></i></div>
        <div class="r"><b>${esc(t.to)}</b><span>${esc(t.arriveEst)} 도착 예상</span></div>
      </div>
      <div class="pass-cut"></div>
      <div class="pass-grid">
        <div><small>날짜</small><b>${esc(dayLabel(t.date))}</b></div>
        <div><small>인원</small><b>${esc(t.pax)}</b></div>
        <div><small>요금</small><b>${esc(t.fare)}</b></div>
      </div>
      <div class="small muted pass-note">${esc(t.note)}</div>
      <div class="btns">
        ${navBtn('d1-limo', '정류장 지도')}
        <button class="btn" data-doc-view="doc-limo">${icon('ticket')}예매내역</button>
      </div>
    </div>`;
}

const walletTabs = (on) => {
  const list = checklist();
  return `
    <div class="exp-tabs wallet-tabs">
      <button class="seg ${on === 'wallet' ? 'on' : ''}" data-go="wallet">${icon('ticket')}예약·여행정보</button>
      <button class="seg ${on === 'check' ? 'on' : ''}" data-go="check">${icon('checklist')}체크리스트 ${list.filter((c) => isChecked(c.id)).length}/${list.length}</button>
    </div>`;
};

function renderWallet() {
  const { flights, stay, guides, trip, links } = state.trip;
  const agoda = store.get('agoda', '');
  setHeader('', '예약·여행정보', `${dayLabel(trip.start)} ~ ${dayLabel(trip.end)} · ${travelers()}명`);
  return `
    ${walletTabs('wallet')}
    <nav class="wallet-nav" aria-label="바로가기">${[['exp', '경비', 'money'], ['w-air', '항공', 'plane'], ['w-road', '공항 가는 길', 'bus'], ['w-stay', '숙소', 'bed'], ['w-secret', '예약번호', 'id'], ['w-docs', '바우처', 'ticket'], ['w-sos', '긴급', 'phone'], ['w-guide', '안내', 'checklist']].map(([k, l, ic]) => `<button data-jump="${k}">${icon(ic)}${l}</button>`).join('')}</nav>
    ${expenseSection()}
    <div class="section-title" id="w-air"><span>항공</span></div>
    ${flights.map(boardingPass).join('')}
    <div class="btns solo">
      <a class="btn" href="${esc(links.jejuair.url)}" target="_blank" rel="noopener">${icon('ext')}${esc(links.jejuair.label)}</a>
      <button class="btn" data-doc-view="doc-eticket">${icon('plane')}e-티켓 사진</button>
    </div>

    <div class="section-title" id="w-road"><span>공항 가는 길</span></div>
    ${state.trip.transfers.map(transferPass).join('')}

    <div class="section-title" id="w-stay"><span>숙소 · ${esc(stay.bookedVia)}</span></div>
    <div class="stay">
      <div class="stay-head">
        <div class="grow">
          <div class="stay-name">${esc(stay.name)}</div>
          <div class="ja muted">${esc(stay.nameJa)}</div>
        </div>
        <div class="stay-nights"><b>${esc(stay.nights)}</b><span>박</span></div>
      </div>
      <div class="pass-grid">
        <div><small>체크인</small><b>${esc(dayLabel(trip.start))} ${esc(stay.checkIn)}</b></div>
        <div><small>체크아웃</small><b>${esc(dayLabel(trip.end))} ${esc(stay.checkOut)}</b></div>
        <div><small>아고다</small><b class="mono">${esc(agoda || '—')}</b></div>
        <div><small>조식</small><b>${esc(stay.breakfast.split(' ')[0])}</b></div>
      </div>
      <div class="addr">
        <div class="ja">${esc(stay.address)}</div>
        <div class="muted small">${esc(stay.addressKo)}</div>
      </div>
      <div class="small muted">조식 ${esc(stay.breakfast.split(' · ').slice(1).join(' · '))}</div>
      <div class="btns">
        ${navBtn('__stay', '호텔 길찾기')}
        <button class="btn" data-ja="__stay">${icon('ja')}택시 기사용</button>
        <a class="btn" href="tel:${esc(stay.phone)}">${icon('phone')}호텔 전화</a>
        <a class="btn" href="${esc(links.agoda.url)}" target="_blank" rel="noopener">${icon('ext')}아고다 예약</a>
        <button class="btn wide" data-doc-view="doc-agoda">${icon('bed')}바우처 사진</button>
      </div>
      <details class="more"><summary>가까운 역</summary>
        <ul class="plain">${stay.stations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      </details>
    </div>

    <div class="section-title" id="w-secret"><span>예약번호 · 링크</span><em class="muted">폰에만 저장, 동기화로 공유</em></div>
    <div class="card">
      ${SECRETS.map((s) => `
        <label class="field">
          <span>${esc(s.label)}</span>
          <div class="field-row">
            <input class="input mono" data-secret="${s.key}" ${s.link ? 'type="url"' : ''} autocomplete="off" autocapitalize="${s.link ? 'none' : 'characters'}" spellcheck="false"
              value="${esc(store.get(s.key, ''))}" placeholder="${esc(s.placeholder)}">
            ${s.link ? `<button class="icon-btn" data-open-secret="${s.key}" aria-label="링크 열기">${icon('ext')}</button>` : ''}
            <button class="icon-btn" data-copy="${s.key}" aria-label="복사">${icon('copy')}</button>
          </div>
        </label>`).join('')}
    </div>

    <div class="section-title" id="w-docs"><span>바우처·자료</span><button class="title-add" data-doc-new>${icon('plus')}추가</button></div>
    <div class="docs">
      ${allDocs().map((s) => `
        <div class="doc" data-doc="${esc(s.id)}">
          <button class="doc-thumb" data-doc-view="${esc(s.id)}">${itemIcon(s.icon, 'lg')}<i class="doc-count" hidden></i></button>
          <div class="doc-label">${esc(s.label)}</div>
          <div class="doc-actions">
            <button data-doc-add="${esc(s.id)}">추가</button>
            <span class="doc-max">${s.custom ? '' : `최대 ${s.max || 1}장`}</span>
          </div>
        </div>`).join('')}
    </div>

    <div class="section-title" id="w-sos"><span>긴급 연락처</span></div>
    <div class="card">
      ${(state.trip.emergency || []).map((e) => `
        <a class="sos-row" href="tel:${esc(e.tel.replace(/-/g, ''))}">
          <span class="grow"><b>${esc(e.label)}</b>${e.note ? `<small>${esc(e.note)}</small>` : ''}</span>
          <span class="sos-tel">${icon('phone')}${esc(e.tel)}</span>
        </a>`).join('')}
      <button class="btn wide sos-hotel" data-ja="__stay">${icon('ja')}호텔 주소 크게 보기</button>
    </div>

    ${guides.filter((g) => !g.costs).map((g, i) => `
      <div class="section-title" ${i ? '' : 'id="w-guide"'}><span>${esc(g.title)}</span></div>
      <div class="card"><ul class="plain">${g.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('')}
  `;
}

function talkBox() {
  const [from, to] = state.talkDir === 'ko-ja' ? ['한국어', '日本語'] : ['日本語', '한국어'];
  return `
    <div class="talk">
      <div class="talk-dir">
        <b>${from}</b>
        <button class="icon-btn" data-swap aria-label="방향 바꾸기">${icon('swap')}</button>
        <b>${to}</b>
      </div>
      <div class="talk-field">
        <textarea id="talk-text" class="talk-input" rows="3" placeholder="${state.talkDir === 'ko-ja' ? '번역할 말을 입력하세요' : '日本語を入力'}">${esc(store.get('talkText', ''))}</textarea>
        <button class="talk-clear" data-talk-clear ${store.get('talkText', '') ? '' : 'hidden'}>지우기</button>
      </div>
      <div class="btns">
        <button class="btn" data-translate="google"><i class="app-tile google">G</i>Google 번역</button>
        <button class="btn" data-translate="papago"><i class="app-tile papago">P</i>파파고</button>
      </div>
      <div class="small muted talk-hint">Google은 앱에 문장이 바로 들어가고, 파파고는 웹으로 열려요.</div>
    </div>`;
}

// The translator on top of a stop, so closing it lands back on that stop.
function openTalkSheet(id) {
  state.talkBack = id;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head has-back"><button class="sheet-back" data-item="${esc(id)}">‹ 일정으로 돌아가기</button><h3>번역</h3></div>
    ${talkBox()}`;
  $('#sheet').hidden = false;
}

const SCENE_ICONS = { 기본: 'talk', 식당: 'meal', 카페: 'coffee', 쇼핑: 'shop', 교통: 'train', 호텔: 'bed', 공항: 'plane', 관광: 'torii', 긴급: 'warn' };
function renderTalk() {
  const { phrases } = state.trip;
  setHeader('', '번역 · 회화', 'Google 번역 앱 · 파파고 웹');
  const groups = [...new Set(phrases.map((p) => p.group))];
  return `
    ${aiKey() ? `<button class="btn ai primary wide menu-go" data-menu-ai>${aiLabel('메뉴판·안내문 사진 번역')}</button>` : ''}
    <div class="sheet-tools two talk-top">${transTools('카메라 번역')}</div>
    ${talkBox()}

    ${nowPhrases()}
    <div class="section-title"><span>상황별 일본어</span><em class="muted">탭하면 크게 · 스피커로 발음</em></div>
    <div class="scene-pick">${groups.map((g) => `<a href="#ph-${esc(g)}">${icon(SCENE_ICONS[g])}${esc(g)}</a>`).join('')}</div>
    ${groups.map((g) => `
      <div class="phrase-group" id="ph-${esc(g)}">${secIcon(SCENE_ICONS[g])}${esc(g)}</div>
      <div class="card list">${phrasesFor(g).map(phraseRow).join('')}</div>`).join('')}
  `;
}


// During the trip, the talk tab opens with phrases for what is happening now (or next).
function nowPhrases() {
  const now = tokyoNow();
  const day = state.trip.days.find((d) => d.date === now.date);
  if (!day) return '';
  const items = dayItems(day).filter((it) => sceneOf(it));
  const it = items.find((x) => x.startMin <= now.min && now.min < x.endMin) || items.find((x) => x.startMin > now.min);
  if (!it) return '';
  const scene = sceneOf(it);
  return `
    <div class="section-title">${itemIcon(it.icon, 'sm')}<span>${esc(it.start)} ${esc(it.title)}</span><em>${esc(scene)}</em></div>
    <div class="card list">${phrasesFor(scene).map(phraseRow).join('')}</div>`;
}

function checkRow(c, today = tokyoNow().date) {
  const on = isChecked(c.id);
  const due = !on && c.due && daysBetween(today, c.due) <= 2 ? dueLabel(c, today) : '';
  return `
    <div class="ck ${on ? 'on' : ''}">
      <button class="ck-hit" data-check="${esc(c.id)}" aria-pressed="${on}">
        <span class="ck-box"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>
        <span class="ck-text">${esc(c.text)}${due ? ` <em class="due ${due === '지남' || due === '오늘' ? 'hot' : ''}">${due}</em>` : ''}${docsReady(c) ? ' <em class="due ok">사진 등록됨</em>' : ''}</span>
      </button>
      ${c.docs ? `<div class="ck-docs">${c.docs.map((slotId) => `<button class="doc-mini ${state.docSlots.has(slotId) ? 'has' : ''}" data-doc-view="${esc(slotId)}" aria-label="${esc(docLabel(slotId))} 사진">${icon('id')}</button>`).join('')}</div>` : ''}
      ${c.custom ? `<button class="ck-del" data-del="${esc(c.id)}" aria-label="삭제">${icon('x')}</button>` : ''}
    </div>`;
}

function renderCheck() {
  const list = checklist();
  const done = list.filter((c) => isChecked(c.id)).length;
  setHeader('', '체크리스트', `${done} / ${list.length} 완료`);
  const groups = [...new Set(list.map((c) => c.group))];
  return `
    ${walletTabs('check')}
    <div class="meter big"><i style="width:${Math.round((done / list.length) * 100)}%"></i></div>
    ${groups.map((g) => {
      const items = list.filter((c) => c.group === g);
      return `
        <div class="section-title"><span>${esc(g)}</span><em>${items.filter((c) => isChecked(c.id)).length}/${items.length}</em></div>
        <div class="card list">${items.map(checkRow).join('')}</div>`;
    }).join('')}
    <div class="section-title"><span>항목 추가</span></div>
    <form class="add" id="add-form">
      <input class="input" id="add-text" placeholder="예: 우산, 상비약, 선물 목록" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" type="submit">${icon('plus')}추가</button>
    </form>
  `;
}

// ---------- explore ----------
const EX_CATS = [['eat', '먹고', 'meal'], ['drink', '마시고', 'coffee'], ['see', '보고', 'torii'], ['shop', '사고', 'shop'], ['log', '적고', 'pen']];
const EX_AREAS = ['전체', '우에노·아키하바라', '아사쿠사·스카이트리', '긴자·쓰키지', '시부야·하라주쿠', '오다이바·도요스', '나카메구로·에비스', '이케부쿠로', '기타', '도쿄역·신주쿠', '내 장소'];
const CAT_ICON = { eat: '🍽', drink: '☕', see: '🏛', shop: '🛍' };
const EX_KIND = { eat: 'food', drink: 'cafe', see: 'sight', shop: 'shop' };
const isSaved = (id) => !!store.get('save:' + id, false);
const visitOf = (id) => store.get('visit:' + id, null);
// Trip places plus the ones added on the phones.
// Google facts fetched again on this phone for the trip file's places ('gfix': rating, hours, address, map link, when).
let GFIX = null;
const gFix = () => (GFIX ||= store.get('gfix', {}));
const allPlaces = () => [
  ...(state.trip.places || []).map((p) => (gFix()[p.id] ? { ...p, ...gFix()[p.id] } : p)),
  ...fixMyPlaces().map((p) => ({ ...p, area: '내 장소', mine: true, desc: p.memo })),
];
const placeById = (id) => allPlaces().find((p) => p.id === id);
// While working out ways to fit a fixed stop, a stop can be tried at another place without saving it.
const swapPreview = {};
function placeOfItem(itemId) {
  if (swapPreview[itemId]) return swapPreview[itemId];
  const edit = store.get('edit:' + itemId, null);
  if (edit?.swap) return placeById(edit.swap);
  if (edit && 'placeId' in edit) return placeById(edit.placeId);
  const added = store.get('myitems', []).find((x) => x.id === itemId);
  return added ? placeById(added.placeId) : allPlaces().find((p) => p.itemId === itemId);
}
const plannedInfo = (id) => state.trip.days.flatMap((d) => d.items).find((x) => x.id === id)?.info;
const scheduledItem = (p) => { const it = p.itemId && findItem(p.itemId); return it && !it.swap ? it : null; };
const placeInfo = (p) => {
  const base = (p.itemId && plannedInfo(p.itemId))
    || { kind: EX_KIND[p.cat], r: p.r, n: p.n, recent: p.recent, hours: placeHours(p), best: p.best, tips: p.tips || (p.memo ? [p.memo] : []), mine: p.mine };
  // Fetched again from Google: the fresh rating and hours win, and the date says when.
  return p.gAt ? { ...base, ...(p.r ? { r: p.r, n: p.n, recent: null } : {}), ...(p.o ? { hours: placeHours(p) } : {}), asOf: p.gAt } : base;
};
const placeHours = (p) => (p.o ? (p.o === '00:00-24:00' ? '24시간' : p.o.replace(/-/g, '~').replace(/,/g, ', ').replace(/2([4-9]):/g, (m, h) => `0${h - 4}:`)) : '');

// Open now, by the saved weekly hours; null when the hours are unknown. Hours past midnight run on as 25:00, 28:00.
function openNow(p, now) {
  if (!p.o) return null;
  if (p.off?.includes(dowOf(now.date))) return false;
  return p.o.split(',').some((range) => {
    const [a, b] = range.split('-').map(toMin);
    return (now.min >= a && now.min < b) || now.min + 1440 < b;
  });
}
function kmBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const distLabel = (km) => (km < 1 ? `${Math.round(km * 100) * 10}m` : `${km.toFixed(1)}km`);

// Google Maps photo by link, with the category icon underneath when it can't load (offline, expired link).
const PHOTO_FALLBACK = "if(this.dataset.alt){this.src=this.dataset.alt;this.dataset.alt=''}else{photoGone(this.dataset.pid);this.remove()}";
const photoSrc = (p, size) => (p.photo ? `${p.photo}=${size}-k-no` : p.photoUrl || '');
const placeThumb = (p, size) => { if (!p.photo && !p.photoUrl) refreshPhoto(p); return `
  <span class="thumb">${itemIcon(CAT_ICON[p.cat], 'lg')}${p.photo || p.photoUrl ? `<img src="${esc(photoSrc(p, size))}" data-pid="${esc(p.id || '')}" data-alt="${esc(p.photo && p.photoUrl ? p.photoUrl : '')}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${PHOTO_FALLBACK}">` : ''}</span>`; };

// Would we go back: strongly, yes, or no. Older "한 번이면 충분" marks read as 비추천.
const AGAIN = { best: '강력 추천', yes: '추천', no: '비추천' };
const againIcon = (k) => (k === 'best' ? `<span class="thumbs two">${icon('thumb')}${icon('thumb')}</span>` : k === 'yes' ? `<span class="thumbs">${icon('thumb')}</span>` : k === 'no' ? `<span class="thumbs">${icon('thumb-down')}</span>` : '');
const recommended = (v) => v?.again === 'best' || v?.again === 'yes';
// The place's photos side by side: swipe left/right (snaps one at a time), dots and '2/5' show where you are.
const placeHero = (p, fresh = false) => {
  if (p && !fresh) refreshPhoto(p);
  const list = photoList(p);
  if (!list.length) return '';
  const slide = (ph, i) => `<div class="ph-slide"><img src="${esc(photoSrc(ph, 'w800-h400'))}" data-pid="${esc(p.id || '')}" data-alt="${esc(ph.photo && ph.photoUrl ? ph.photoUrl : '')}" alt="" ${i ? 'loading="lazy"' : ''} referrerpolicy="no-referrer" onerror="if(this.dataset.alt){this.src=this.dataset.alt;this.dataset.alt=''}else{heroGone(this)}"></div>`;
  return `<div class="place-hero ${list.length > 1 ? 'multi' : ''}" data-pid="${esc(p.id || '')}">
    <div class="ph-track">${list.map(slide).join('')}</div>
    ${list.length > 1 ? `<div class="ph-dots">${list.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div><span class="ph-count">1/${list.length}</span>` : ''}
  </div>`;
};
// A photo that won't load leaves the set; the last one gone hides the strip and asks Google again.
function heroGone(img) {
  const hero = img.closest('.place-hero');
  img.closest('.ph-slide').remove();
  const left = hero.querySelectorAll('.ph-slide').length;
  if (!left) { photoGone(img.dataset.pid); hero.remove(); return; }
  hero.querySelector('.ph-dots i:last-child')?.remove();
  heroSync(hero.querySelector('.ph-track'));
}
function heroSync(track) {
  const hero = track.closest('.place-hero');
  const n = track.children.length;
  const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  hero.querySelectorAll('.ph-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
  const c = hero.querySelector('.ph-count');
  if (c) c.textContent = `${Math.min(n, i + 1)}/${n}`;
  if (n < 2) hero.classList.remove('multi');
}
document.addEventListener('scroll', (e) => { if (e.target.classList?.contains('ph-track')) heroSync(e.target); }, true);

function placeCard(p, now) {
  const info = placeInfo(p);
  const open = openNow(p, now);
  const item = scheduledItem(p);
  const v = visitOf(p.id);
  const line = [info?.r ? `★${info.r.toFixed(1)}` : '', p.loc && p.loc !== '미기재' ? p.loc : p.area.split('·')[0], p.desc || item?.title?.split(' · ').pop()].filter(Boolean).join(' · ');
  const sub = [
    open === null ? '' : open ? '등록 시간상 영업 중' : '등록 시간상 종료',
    item ? `${dayLabel(item.date)} ${item.start}` : '일정 없음',
    p.lat ? (state.geo ? distLabel(kmBetween(state.geo, p)) : `호텔 ${distLabel(kmBetween(state.trip.stay, p))}`) : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="place ${v ? 'visited' : ''}" data-place="${esc(p.id)}" role="button" tabindex="0">
      ${placeThumb(p, 'w160-h160')}
      <div class="place-main">
        <b>${esc(p.name)}${v ? `<i class="${recommended(v) ? 'rec' : ''}">${recommended(v) ? againIcon(v.again) + AGAIN[v.again] : '방문'}</i>` : ''}</b>
        <span>${esc(line)}</span>
        <small>${esc(sub)}</small>
      </div>
      <button class="place-save ${isSaved(p.id) ? 'on' : ''}" data-place-save="${esc(p.id)}" aria-label="저장">${isSaved(p.id) ? '♥' : '♡'}</button>
    </div>`;
}

const exploreRows = (list, now) => (list.length
  ? list.map((p) => placeCard(p, now)).join('')
  : '<div class="card small muted">조건에 맞는 곳이 없어요. 필터를 줄여 보세요.</div>');
function exploreList(now) {
  const f = state.ex;
  let list = allPlaces().filter((p) => p.cat === f.cat);
  const q = f.q.trim().toLowerCase();
  if (q) list = list.filter((p) => [p.name, p.desc, p.items, p.loc, p.area, ...(placeInfo(p)?.best || [])].join(' ').toLowerCase().includes(q));
  if (f.area !== '전체') list = list.filter((p) => p.area === f.area);
  if (f.open) list = list.filter((p) => openNow(p, now));
  if (f.plan) list = list.filter((p) => p.itemId);
  if (f.again) list = list.filter((p) => recommended(visitOf(p.id)));
  if (f.saved) list = list.filter((p) => isSaved(p.id));
  const dist = (p) => (p.lat ? kmBetween(state.geo, p) : Infinity);
  if (f.near && state.geo) return [...list].sort((a, b) => dist(a) - dist(b));
  return list;
}

// The trip journal: visits by day with notes, a photo and that day's spending.
function exploreLog(now) {
  const places = allPlaces();
  const seen = places.filter((p) => visitOf(p.id)).sort((a, b) => visitOf(b.id).at - visitOf(a.id).at);
  const saved = places.filter((p) => isSaved(p.id) && !visitOf(p.id));
  const dayOf = (at) => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
  const dates = [...new Set(seen.map((p) => dayOf(visitOf(p.id).at)))];
  const spent = (date) => expenses().filter((e) => e.date === date).reduce((a, e) => a + e.amount, 0);
  return `
    <div class="section-title"><span>여행 일지</span><em>${seen.length}</em></div>
    ${dates.length ? dates.map((date) => `
      <div class="log-day"><b>${esc(dayLabel(date))}</b>${spent(date) ? `<span>지출 ${yen(spent(date))}</span>` : ''}</div>
      ${seen.filter((p) => dayOf(visitOf(p.id).at) === date).map((p) => {
    const v = visitOf(p.id);
    const slot = 'place-' + p.id;
    return `
      <div class="place visited" data-place="${esc(p.id)}" role="button" tabindex="0">
        ${state.docSlots.has(slot) ? `<button class="log-thumb" data-doc-view="${esc(slot)}" data-thumb="${esc(slot)}" aria-label="사진 보기"></button>` : ''}
        <div class="place-main">
          <b>${esc(p.name)}</b>
          <span>${esc([nameOf(v.by), AGAIN[v.again]].filter(Boolean).join(' · '))}</span>
          ${v.memo ? `<small>${esc(v.memo)}</small>` : ''}
        </div>
      </div>`;
  }).join('')}`).join('') : '<div class="card small muted">다녀온 곳에서 방문 표시를 누르면 여기에 모여요.</div>'}
    <div class="section-title"><span>가고 싶은 곳</span><em>${saved.length}</em></div>
    ${saved.length ? saved.map((p) => placeCard(p, now)).join('') : '<div class="card small muted">하트를 누른 곳이 여기에 모여요.</div>'}
    <details class="sheet-more">
      <summary>상호 조사 대기 ${state.trip.unresolved.length}건<i class="chev"></i></summary>
      <div class="card small">${state.trip.unresolved.map((u) => `<div class="src-row"><b>${esc(u.src)}</b><span>${esc(u.text)}</span></div>`).join('')}</div>
    </details>`;
}

const thumbs = [];
async function hydrateLog() {
  thumbs.splice(0).forEach((u) => URL.revokeObjectURL(u));
  for (const el of document.querySelectorAll('[data-thumb]')) {
    try {
      const [key] = await docs.of(el.dataset.thumb);
      const url = URL.createObjectURL(await docs.get(key));
      thumbs.push(url);
      el.style.backgroundImage = `url("${url}")`;
    } catch { /* leave the blank tile */ }
  }
}

function renderExplore() {
  const now = tokyoNow();
  const f = state.ex;
  const seen = allPlaces().filter((p) => visitOf(p.id)).length;
  setHeader('', '탐색', `${allPlaces().length}곳 · 방문 ${seen}곳`);
  const toggles = [['open', '지금 영업', 'clock'], ['plan', '일정 장소', 'calendar'], ['saved', '저장함', 'heart'], ['again', '추천한 곳', 'thumb'], ['near', '내 주변', 'nav']];
  const list = f.cat === 'log' ? [] : exploreList(now);
  return `
    <div class="ex-cats">${EX_CATS.map(([k, label, ico]) => `<button class="seg ${f.cat === k ? 'on' : ''}" data-ex-cat="${k}">${icon(ico)}${label}</button>`).join('')}</div>
    ${f.cat === 'log' ? exploreLog(now) : `
      <div class="ex-field">
        <input class="input ex-search" id="ex-q" type="search" placeholder="이름·메뉴·품목 검색" value="${esc(f.q)}" autocomplete="off" enterkeyhint="search">
        <button class="talk-clear" data-ex-clear ${f.q ? '' : 'hidden'}>지우기</button>
      </div>
      <div class="ex-line"><b>지역</b><div class="ex-row">${EX_AREAS.map((a) => `<button class="${f.area === a ? 'on' : ''}" data-ex-area="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>
      <div class="ex-line"><b>조건</b><div class="ex-row ex-opts">${toggles.map(([k, label, ico]) => `<button class="${f[k] ? 'on' : ''}" data-ex-toggle="${k}" aria-pressed="${!!f[k]}">${icon(ico)}${label}</button>`).join('')}</div></div>
      <div id="ex-list">${exploreRows(list, now)}</div>
      <div class="small muted ex-asof">구글지도 ${esc(state.trip.trip.infoAsOf || '')} 기준 저장 정보${Object.keys(gFix()).length ? ` · ${Object.keys(gFix()).length}곳은 다시 채움` : ''} · 임시휴무는 반영되지 않아요</div>
      ${gKey() ? `<button class="btn wide ex-refresh" id="ex-refresh" data-place-refresh-all>${icon('refresh')}모든 장소 구글 정보 다시 채우기</button>` : ''}`}`;
}

function findNear() {
  if (!navigator.geolocation) return toast('이 폰에서는 위치를 쓸 수 없어요.');
  toast('현재 위치를 찾는 중이에요…');
  navigator.geolocation.getCurrentPosition(
    (pos) => { state.geo = { lat: pos.coords.latitude, lng: pos.coords.longitude }; state.ex.near = true; render(); },
    () => { state.ex.near = false; render(); toast('위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.'); },
    { timeout: 8000, maximumAge: 60000 },
  );
}

// Review notes from travel posts: what the post said, kept apart from anything checked.
const PLACE_STATUS = {
  branch_unconfirmed: '지점 미확인',
  comment_identified: '댓글로 식별된 상호',
  identity_unconfirmed: '상호 확인 필요',
};
function placeSource(p) {
  if (!Array.isArray(p.src)) return '';
  const srcs = p.src.map((k) => state.trip.sources[k]);
  const check = p.verified
    ? `구글지도에서 위치 확인 (${p.verified.at.slice(5).replace('-', '/')}) · 영업 여부는 다시 확인`
    : p.lat ? '' : `${PLACE_STATUS[p.status] || '현재 영업 미확인'} · 위치 미확인`;
  return `
    <div class="card src-card">
      ${check ? `<div class="src-check ${p.verified ? 'ok' : ''}">${esc(check)}</div>` : ''}
      ${p.verified && PLACE_STATUS[p.status] ? `<div class="small muted">${esc(PLACE_STATUS[p.status])}</div>` : ''}
      ${p.items ? `<div class="src-row"><b>품목</b><span>${esc(p.items)}</span></div>` : ''}
      ${p.review ? `<div class="src-row"><b>후기</b><span>${esc(p.review)}</span></div>` : ''}
      ${p.sub || p.tags ? `<div class="src-row"><b>분류</b><span>${esc([p.sub, ...(p.tags || [])].filter(Boolean).join(' · '))}</span></div>` : ''}
      ${p.caution ? `<div class="src-row"><b>주의</b><span>${esc(p.caution)}</span></div>` : ''}
      <div class="src-row"><b>원문</b><span>${srcs.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.note ? `<small>${esc(s.note)}</small>` : ''}`).join('')}</span></div>
    </div>`;
}

// Nearby places of the same kind that are open at the stop's time, for restaurants and cafes only.
function altCard(it) {
  const alts = altPlaces(it).slice(0, 3);
  if (!alts.length) return '';
  return `
    <div class="alt-card">
      <div class="finish-label">대안 · 가까운 순 ${isDone(it.id) ? '' : '<small>붙여 두면 웨이팅·다른 곳에서 먼저 보여요 (2곳까지)</small>'}</div>
      ${alts.map(({ p, km, open, pin }) => `
        <div class="alt-line ${pin ? 'pinned' : ''}">
        <button class="alt-row" data-place="${esc(p.id)}" data-from-item="${esc(it.id)}">
          ${placeThumb(p, 'w120-h120')}
          <span><b>${pin ? '<em class="alt-pin-tag">미리 정한 곳</em>' : ''}${esc(p.name)}</b><small>${esc([p.r ? `★${p.r.toFixed(1)}` : '', distLabel(km), open === null ? '영업시간 미확인' : ''].filter(Boolean).join(' · '))}</small></span>
          <i class="chev"></i>
        </button>
        ${isDone(it.id) ? '' : `<button type="button" class="alt-pin ${pin ? 'on' : ''}" data-alt-pin="${esc(it.id)}|${esc(p.id)}" aria-pressed="${!!pin}">${icon(pin ? 'check' : 'plus')}${pin ? '대안' : '붙이기'}</button>`}
        </div>`).join('')}
    </div>`;
}
function swapStop(id, placeId) {
  store.set('edit:' + id, { ...store.get('edit:' + id, null), swap: placeId });
  render();
  openItem(id);
  toast('장소를 바꿨어요. 캘린더 알림은 그대로예요');
}
function unswapStop(id) {
  const { swap, ...rest } = store.get('edit:' + id, null) || {};
  store.set('edit:' + id, Object.keys(rest).length ? rest : null);
  render();
  openItem(id);
}

function openPlace(id) {
  const p = placeById(id);
  if (!p) return;
  const v = visitOf(id);
  const item = scheduledItem(p);
  const q = encodeURIComponent(item?.place?.query || [p.name, p.addr].filter(Boolean).join(' '));
  const mapUrl = p.url || `https://www.google.com/maps/search/?api=1&query=${q}`;
  const hasPhoto = state.docSlots.has('place-' + id);
  $('#sheet-body').innerHTML = `
    ${state.swapFor ? `<button class="sheet-back" data-item="${esc(state.swapFor)}">‹ 일정으로 돌아가기</button>` : ''}
    ${placeHero(p)}
    <div class="eyebrow dark">${esc(p.loc || p.area)}</div>
    <div class="sheet-head"><h3>${esc(p.name)}</h3></div>
    ${p.desc ? `<div class="muted">${esc(p.desc)}</div>` : ''}
    ${p.addr ? `<div class="small muted">${esc(p.addr)}</div>` : ''}
    ${placeSource(p)}
    ${p.r || !p.src ? infoCard({ info: placeInfo(p) }) : ''}
    ${state.swapFor ? `<div class="btns">
      <div class="wide">${mapBtn(mapUrl, p.src && !p.lat ? '구글지도에서 찾기' : '구글지도에서 보기')}</div>
      ${p.src && !p.lat ? '' : `<a class="btn wide" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat ? `${p.lat},${p.lng}` : q}&travelmode=transit" target="_blank" rel="noopener">${icon('nav')}길찾기</a>`}
      <button class="btn primary wide" data-item-swap="${esc(id)}">${icon('swap')}이 일정을 여기로 변경</button>
    </div>` : `
    <div class="btns">
      <div class="wide">${mapBtn(mapUrl, p.src && !p.lat ? '구글지도에서 찾기' : '구글지도에서 보기')}</div>
      ${p.src && !p.lat ? '' : `<a class="btn primary wide" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat ? `${p.lat},${p.lng}` : q}&travelmode=transit" target="_blank" rel="noopener">${icon('nav')}길찾기</a>`}
      <button class="btn" data-place-save="${esc(id)}">${isSaved(id) ? '♥ 저장됨' : '♡ 저장'}</button>
      <button class="btn" data-place-visit="${esc(id)}">${v ? `${icon('check')}방문함` : '방문 표시'}</button>
      ${item ? `<button class="btn wide" data-item="${esc(item.id)}">${esc(dayLabel(item.date))} ${esc(item.start)} 일정 보기</button>`
    : `<button class="btn wide" data-place-plan="${esc(id)}">${icon('plus')}일정에 넣기</button>`}
      ${gKey() ? `<button class="btn wide" data-place-refresh="${esc(id)}">${icon('refresh')}구글 정보로 다시 채우기${p.gAt ? ` <small>· ${esc(shortDate(p.gAt))}</small>` : ''}</button>` : ''}
      ${p.mine ? `<button class="btn danger wide" data-place-del="${esc(id)}">${icon('trash')}내 장소 삭제</button>` : ''}
    </div>`}
    ${state.swapFor ? '' : `<div class="section-title"><span>내 기록</span></div>
    ${v ? `<div class="rate-row">${rateBtns(id, v.again, 'place')}</div>` : ''}
    <textarea class="input place-memo" data-place-memo="${esc(id)}" rows="3" maxlength="300" placeholder="맛, 분위기, 다시 가고 싶은지 남겨 보세요">${esc(v?.memo || '')}</textarea>
    <div class="btns">
      <button class="btn" data-doc-add="place-${esc(id)}">${icon('camera')}사진 추가</button>
      <button class="btn" data-doc-view="place-${esc(id)}" ${hasPhoto ? '' : 'disabled'}>${icon('image')}사진 보기</button>
    </div>`}`;
  $('#sheet').hidden = false;
}

// Google Maps' Share > Copy gives the name, address and link as text. The app can't read the link
// itself (no server, and Google blocks cross-site reads), so everything comes from the pasted text.
function parseShare(text) {
  const url = text.match(/https?:\/\/\S+/)?.[0] || '';
  const lines = text.replace(url, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let [name = '', addr = ''] = lines;
  if (!addr && name.includes(', ')) [name, addr] = [name.slice(0, name.indexOf(', ')), name.slice(name.indexOf(', ') + 2)];
  if (!name) {
    const fromUrl = url.match(/\/maps\/place\/([^/@?]+)/)?.[1]?.replace(/^data=.*/, '');
    if (fromUrl) name = decodeURIComponent(fromUrl).replace(/\+/g, ' ');
  }
  return { url, name, addr };
}
const CAT_WORDS = [
  ['drink', /커피|카페|coffee|cafe|café|カフェ|珈琲|コーヒー|喫茶|bar\b|바\b/i],
  ['eat', /라멘|라면|스시|초밥|우동|소바|돈카츠|식당|이자카야|ラーメン|寿司|鮨|うどん|そば|とんかつ|食堂|居酒屋|焼|定食|restaurant/i],
  ['see', /신사|사원|절|미술관|박물관|공원|타워|전망대|神社|寺|美術館|博物館|公園|タワー|展望/],
  ['shop', /백화점|마트|쇼핑|스토어|百貨店|ドン|マート|ストア|store|shop/i],
];

// ---------- AI helper (the traveler's own Claude API key, kept on this phone only) ----------
// The key lives in localStorage under 'aiKey', which is not a synced key, so it never goes into the sync file or GitHub.
const AI_MODELS = {
  opus: { id: 'claude-opus-5-5', label: 'Opus 5.5 · 정확해요 (기본)', search: 'web_search_20260209', fetch: 'web_fetch_20260209', fallback: true },
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · 빠르고 저렴해요', search: 'web_search_20250305', fetch: 'web_fetch_20250910', fallback: false },
};
// 서버 버전 S-3: 로그인하고 서버에 키가 있으면 서버 키로(폰엔 키 없음), 아니면 이 폰에 넣은 키로
const API_BASE = 'https://tokyo-trip-snowy.vercel.app/api';
const srvKeys = () => store.get('srvKeys', {});
const aiOwn = () => store.get('aiKey', '');
const aiSrv = () => !!(AUTH.user && srvKeys().claude);
const aiKey = () => (aiSrv() ? 'server' : aiOwn());
async function srvCheck() {
  if (!navigator.onLine) return;
  try {
    const r = await fetch(`${API_BASE}/status`, { cache: 'no-store' });
    if (!r.ok) return;
    const k = await r.json();
    const was = JSON.stringify(srvKeys());
    store.set('srvKeys', { claude: !!k.claude, google: !!k.google });
    if (JSON.stringify(srvKeys()) !== was) render();
  } catch { /* 서버에 못 닿으면 이전 값 그대로 */ }
}
async function srvToken() { return (await sb()?.auth.getSession())?.data?.session?.access_token || ''; }
const aiModel = () => AI_MODELS[store.get('aiModel', 'opus')] || AI_MODELS.opus;
let aiSdk = null;
// The official SDK, loaded only when the helper is first used (needs internet anyway).
async function aiClient() {
  if (!aiSdk) aiSdk = await import('https://esm.sh/@anthropic-ai/sdk@1.1.0');
  const Anthropic = aiSdk.default;
  if (aiSrv()) return { Anthropic, client: new Anthropic({ apiKey: await srvToken(), baseURL: `${API_BASE}/claude`, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 280000 }) };
  return { Anthropic, client: new Anthropic({ apiKey: aiOwn(), dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 120000 }) };
}
// What went wrong, in words a traveler can act on.
function aiError(e, Anthropic) {
  if (!navigator.onLine) return '인터넷이 연결되어 있지 않아요.';
  // 서버 키를 쓸 때는 서버가 보낸 한국어 이유(로그인·하루 한도)를 그대로
  if (aiSrv() && Anthropic && e instanceof Anthropic.APIError && [401, 429, 503].includes(e.status) && /[가-힣]/.test(e.error?.error?.message || '')) return e.error.error.message;
  if (Anthropic && e instanceof Anthropic.AuthenticationError) return 'API 키가 맞지 않아요. 설정 › AI 도우미에서 키를 다시 확인해 주세요.';
  if (Anthropic && e instanceof Anthropic.PermissionDeniedError) return '이 키로는 쓸 수 없는 기능이에요. 콘솔에서 키 권한을 확인해 주세요.';
  if (Anthropic && e instanceof Anthropic.RateLimitError) return '요청이 많아요. 잠시 뒤 다시 시도해 주세요.';
  if (Anthropic && e instanceof Anthropic.APIConnectionTimeoutError) return '응답이 너무 늦어요. 인터넷 상태를 확인하고 다시 시도해 주세요.';
  if (Anthropic && e instanceof Anthropic.APIConnectionError) return 'Claude에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  if (Anthropic && e instanceof Anthropic.APIError) {
    const why = e.error?.error?.message || e.message || '';
    // The usual reasons a new key gets a 400, in plain words.
    if (/credit balance/i.test(why)) return 'API 크레딧이 없어요. console.anthropic.com → Billing(결제)에서 크레딧을 충전하면 바로 쓸 수 있어요.';
    if (/model/i.test(why) && /not (found|available|supported)|does not exist|access/i.test(why)) return `이 키로는 ${aiModel().id} 모델을 쓸 수 없어요. 모델을 Haiku로 바꾸거나 콘솔에서 권한을 확인해 주세요. (${String(why).slice(0, 80)})`;
    return `Claude 오류 (${e.status || '?'})${why ? ` · ${String(why).slice(0, 160)}` : ''}`;
  }
  return e?.message || '알 수 없는 오류가 났어요.';
}
// One request with the web tools; continues a paused server-tool turn, and stops on a refusal.
// If the API rejects the request shape (400), it tries again with a plainer one: first without the
// server-side fallback, then with web fetch only. The API's own reason is kept for the message.
async function aiRun({ system, tools, text }) {
  const { Anthropic, client } = await aiClient();
  const m = aiModel();
  const plans = [
    { tools, fallback: m.fallback },
    { tools, fallback: false },
    { tools: tools.filter((t) => t.name !== 'web_search'), fallback: false },
  ];
  let last = null;
  for (const plan of plans) {
    const messages = [{ role: 'user', content: text }];
    try {
      for (let i = 0; i < 4; i++) {
        const body = { model: m.id, max_tokens: 8000, system, tools: plan.tools, tool_choice: { type: 'auto' }, output_config: { effort: 'low' }, messages };
        const res = plan.fallback
          ? await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(body);
        if (res.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 처리하지 않았어요. 내용을 바꿔 다시 시도해 주세요.');
        if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
        return res;
      }
      throw new Error('찾는 데 너무 오래 걸렸어요. 다시 시도해 주세요.');
    } catch (e) {
      last = e;
      if (!(e instanceof Anthropic.BadRequestError)) break;
      console.warn('AI 400, trying a plainer request:', e.message);
    }
  }
  throw new Error(aiError(last, Anthropic));
}

const PLACE_AREAS = EX_AREAS.filter((a) => a !== '전체' && a !== '내 장소');
const SAVE_PLACE = {
  name: 'save_place',
  description: 'Save the one place the traveler pasted. Call exactly once, after identifying the place.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'name', 'nameJa', 'cat', 'area', 'addr', 'lat', 'lng', 'hours', 'off', 'rating', 'reviews', 'desc', 'best', 'tips', 'stay', 'note'],
    properties: {
      found: { type: 'boolean', description: 'false if the place could not be identified' },
      name: { type: 'string', description: 'Korean name a Korean traveler would use' },
      nameJa: { type: 'string', description: 'Name as shown on the map in Japan (Japanese or original)' },
      cat: { type: 'string', enum: ['eat', 'drink', 'see', 'shop'] },
      area: { type: 'string', enum: PLACE_AREAS },
      addr: { type: 'string', description: 'Address, or empty' },
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      hours: { type: 'string', description: 'Opening hours as HH:MM-HH:MM, comma-separated for breaks, 25:00 style past midnight; empty if unknown' },
      off: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6] }, description: 'Regular closing weekdays, 0 = Sunday' },
      rating: { type: ['number', 'null'], description: 'Google rating only if a source shows it' },
      reviews: { type: 'string', description: 'Review count like "3,830", or empty' },
      desc: { type: 'string', description: 'One line in Korean: what it is and why go' },
      best: { type: 'array', items: { type: 'string' }, description: 'Up to 3 dishes or highlights, Korean' },
      tips: { type: 'array', items: { type: 'string' }, description: '2-3 practical visitor tips in your own words, Korean' },
      stay: { type: 'integer', description: 'Typical visit length in minutes' },
      note: { type: 'string', description: 'Korean: what could not be confirmed, or empty' },
    },
  },
};
const PLACE_SYSTEM = `You help a Korean couple on a Tokyo trip (2026-11-02 to 11-06, hotel near Ueno) add a place to their travel app.
The user pastes a Google Maps share link and/or the text Google Maps copies with it.
Identify that exact place: fetch the pasted URL first; short maps.app.goo.gl links usually can't be opened, so then search the web with the place name or address given (add 東京 or the area to the query). Prefer the official site, Tabelog or Google Maps listings as sources.
Then call save_place once. Write Korean for name, desc, best, tips and note; nameJa as it appears on the map.
Only fill rating, reviews and hours when a source shows them; leave unknown fields empty or null and say what in note. Never copy review sentences; write tips in your own words.
If you can't tell which place it is, call save_place with found false and explain in note.`;


// Saved places from v154-v155 marked Google with src: 'google'; that name means travel-blog sources elsewhere, so rename it.
function fixMyPlaces() {
  const list = store.get('myplaces', []);
  if (!list.some((x) => typeof x.src === 'string')) return list;
  const fixed = list.map(({ src, ...x }) => (typeof src === 'string' ? { ...x, from: src } : { ...x, ...(src ? { src } : {}) }));
  store.set('myplaces', fixed);
  return fixed;
}

// ---------- Google Places API (New): the same place data Google Maps shows, with the traveler's own key ----------
// The key lives in localStorage under 'gKey' (not synced, never in the repo). Restrict it to this site and Places API (New).
const gOwn = () => store.get('gKey', '');
const gSrv = () => !!(AUTH.user && srvKeys().google);
const gKey = () => (gSrv() ? 'server' : gOwn());
// 구글 호출 한 곳: 서버 키면 서버 함수로, 아니면 구글로 바로
async function gCall(url, { method = 'GET', headers = {}, body, signal } = {}) {
  if (!gSrv()) return fetch(url, { method, headers: { ...headers, 'X-Goog-Api-Key': gOwn() }, body, signal });
  const u = new URL(url);
  const path = u.pathname.replace(/^\/(v1\/)?/, '');
  u.searchParams.delete('key');
  const qs = u.searchParams.toString();
  return fetch(`${API_BASE}/google?path=${encodeURIComponent(path)}${qs ? '&' + qs : ''}`, { method, headers: { ...headers, Authorization: `Bearer ${await srvToken()}` }, body, signal });
}
const G_BASE = 'https://places.googleapis.com/v1';
const TOKYO = { latitude: 35.6895, longitude: 139.7530 };
async function gFetch(path, { body, mask, query = '' } = {}) {
  if (!navigator.onLine) throw new Error('인터넷이 연결되어 있지 않아요.');
  const headers = { ...(mask ? { 'X-Goog-FieldMask': mask } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  let res;
  try { res = await gCall(`${G_BASE}/${path}${query}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('구글에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.'); }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const why = data.error?.message || '';
  if (gSrv() && [401, 429, 503].includes(res.status) && /[가-힣]/.test(why)) throw new Error(why);
  if (gSrv() && res.status === 403) throw new Error(`서버 구글 키에 권한이 없어요. 구글 콘솔에서 키를 만든 프로젝트에 Places API (New)·Routes API가 '사용'인지, 키의 API 제한에 두 개가 들어 있는지 확인해 주세요 (${why.slice(0, 80)})`);
  if (res.status === 403 && /referer|referrer/i.test(why)) throw new Error('구글 키의 웹사이트 제한에 https://woo72da.github.io/* 를 넣었는지 확인해 주세요.');
  if (res.status === 403 && /not been used|disabled|SERVICE_DISABLED/i.test(why)) throw new Error('구글 콘솔에서 "Places API (New)"를 사용으로 켜 주세요.');
  if (res.status === 403 && /billing/i.test(why)) throw new Error('구글 콘솔에서 프로젝트에 결제 계정을 연결해 주세요.');
  if (res.status === 400 && /API key/i.test(why)) throw new Error('구글 키가 맞지 않아요. 설정 › AI 도우미에서 확인해 주세요.');
  if (res.status === 429) throw new Error('오늘 구글 사용량 한도에 닿았어요. 내일 다시 쓰거나 할당량을 늘려 주세요.');
  throw new Error(`구글 오류 (${res.status})${why ? ` · ${why.slice(0, 120)}` : ''}`);
}
// The place at a map position (a long link's "!3d…!4d…" or "@lat,lng"), nearest first.
async function gNear(lat, lng) {
  const data = await gFetch('places:searchNearby', { mask: 'places.id,places.displayName', body: { maxResultCount: 1, rankPreference: 'DISTANCE', languageCode: 'ko', locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 40 } } } });
  return data.places?.[0]?.id || null;
}
// Suggestions while typing; tied to one session so picking one counts as a single paid lookup.
async function gSuggest(input, session) {
  const data = await gFetch('places:autocomplete', { body: { input, sessionToken: session, languageCode: 'ko', regionCode: 'JP', locationBias: { circle: { center: TOKYO, radius: 40000 } } } });
  return (data.suggestions || []).map((x) => x.placePrediction).filter(Boolean).slice(0, 5)
    .map((pp) => ({ id: pp.placeId, main: pp.structuredFormat?.mainText?.text || pp.text?.text || '', sub: pp.structuredFormat?.secondaryText?.text || '' }));
}
// Google's weekly hours → the app's "HH:MM-HH:MM" (25:00 past midnight) for the usual day, and the closed weekdays.
function gHours(periods) {
  if (!periods?.length) return { o: '', off: [] };
  if (periods.length === 1 && !periods[0].close) return { o: '00:00-24:00', off: [] };
  const byDay = {};
  for (const pd of periods) {
    if (!pd.open || !pd.close) continue;
    const from = pd.open.hour * 60 + (pd.open.minute || 0);
    let to = pd.close.hour * 60 + (pd.close.minute || 0);
    if (pd.close.day !== pd.open.day || to <= from) to += 1440;
    (byDay[pd.open.day] = byDay[pd.open.day] || []).push(`${clock(from)}-${String(Math.floor(to / 60)).padStart(2, '0')}:${String(to % 60).padStart(2, '0')}`);
  }
  const days = Object.keys(byDay).map(Number);
  const tally = {};
  days.forEach((d) => { const k = byDay[d].join(','); tally[k] = (tally[k] || 0) + 1; });
  const o = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return { o, off: [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.includes(d)) };
}
const G_CAT = (types = []) => (types.some((t) => /cafe|coffee|tea_house|bakery|dessert|bar$|pub/.test(t)) ? 'drink'
  : types.some((t) => /restaurant|food|meal|ramen|sushi|izakaya/.test(t)) ? 'eat'
    : types.some((t) => /store|shop|mall|market|department/.test(t)) ? 'shop' : 'see');
const G_STAY = { eat: 60, drink: 40, shop: 45, see: 60 };
// First photo of a place as an address the app can size ("…=w160-h160-k-no"), plus Google's own full address as a backup.
// Up to five photos (the first is the cover); each is a short Google link plus the full one as a fallback.
async function gPhoto(photos, max = 5) {
  if (!photos?.[0]?.name) return { photo: '', photoUrl: '', photos: [], photoErr: '구글에 등록된 사진이 없어요' };
  const one = async (ph) => {
    const r = await gFetch(`${ph.name}/media`, { query: `?maxWidthPx=1200&skipHttpRedirect=true&key=${encodeURIComponent(gKey())}` });
    const full = r?.photoUri || '';
    return full ? { photo: /googleusercontent\.com/.test(full) ? full.replace(/=[^=/]*$/, '') : '', photoUrl: full } : null;
  };
  try {
    const list = (await Promise.all(photos.slice(0, max).map((ph) => one(ph).catch(() => null)))).filter(Boolean);
    if (!list.length) return { photo: '', photoUrl: '', photos: [], photoErr: '사진 주소를 받지 못했어요' };
    return { ...list[0], photos: list, photoErr: '' };
  } catch (e) { return { photo: '', photoUrl: '', photos: [], photoErr: `사진을 못 가져왔어요 · ${e.message}` }; }
}
// A place saved without a photo (or before photos worked) gets one the next time it's opened, if a Google key is set.
const photoTried = new Set();
// Where a fetched photo is kept: on the traveler's own place, or (for the trip file's places) in this phone's 'gfix'.
function keepPhoto(p, photo, photoUrl, photos = []) {
  if (p.mine) store.set('myplaces', store.get('myplaces', []).map((x) => (x.id === p.id || (p.gid && x.gid === p.gid) ? { ...x, photo, photoUrl, photos } : x)));
  else { store.set('gfix', { ...gFix(), [p.id]: { ...(gFix()[p.id] || {}), photo, photoUrl, photos } }); GFIX = null; }
}
// A place's photos in order: the fetched set, else the one cover photo.
const photoList = (p) => (p?.photos?.length ? p.photos : p?.photo || p?.photoUrl ? [{ photo: p.photo, photoUrl: p.photoUrl }] : []);
// A saved photo link that no longer loads (Google links can expire): fetch a fresh one once, then redraw.
function photoGone(id) {
  const p = id && placeById(id);
  if (!p || !gKey() || photoTried.has('gone:' + id)) return;
  photoTried.add('gone:' + id);
  refreshPhoto({ ...p, photo: '', photoUrl: '' }, true);
}
async function refreshPhoto(p, force = false) {
  // A place with fewer than three photos fetches up to five (the trip file only kept one cover each).
  if (!p || (!force && photoList(p).length >= 3) || !gKey()) return;
  // Places with no photo are looked up again at most once a week, so opening the app doesn't keep calling Google.
  const key = p.gid || p.id;
  const tried = store.get('photoTried', {});
  if (!force && (photoTried.has(key) || Date.now() - (tried[key] || 0) < 7 * 864e5)) return;
  photoTried.add(key);
  store.set('photoTried', { ...tried, [key]: Date.now() });
  try {
    let gid = p.gid;
    if (!gid && !p.mine) gid = (await gSuggest(p.nameJa || p.name, crypto.randomUUID()))[0]?.id;
    if (!gid) return;
    const d = await gFetch(`places/${encodeURIComponent(gid)}`, { mask: 'photos,location' });
    if (p.lat && d.location && kmBetween(p, { lat: d.location.latitude, lng: d.location.longitude }) > 1) return;
    const { photo, photoUrl, photos } = await gPhoto(d.photos);
    if (!photo && !photoUrl) return;
    if (!force && photos.length <= photoList(p).length) return;
    keepPhoto(p, photo, photoUrl, photos);
    if (!p.mine && !gFix()[p.id]?.gid) { store.set('gfix', { ...gFix(), [p.id]: { ...gFix()[p.id], gid } }); GFIX = null; }
    const hero = $('#sheet-body .place-hero');
    if (!$('#sheet').hidden && (!hero || hero.dataset.pid === String(p.id))) {
      const html = placeHero({ ...p, photo, photoUrl, photos }, true);
      if (hero) hero.outerHTML = html; else $('#sheet-body').insertAdjacentHTML('afterbegin', html);
    }
    if ($('#sheet').hidden) render();
  } catch { /* no photo this time */ }
}

// Full place from a Google place ID: details in Korean, the Japanese name, and a photo address.
async function gPlace(id, session) {
  const mask = 'id,displayName,formattedAddress,location,rating,userRatingCount,regularOpeningHours,primaryType,primaryTypeDisplayName,types,photos,googleMapsUri,editorialSummary';
  const d = await gFetch(`places/${encodeURIComponent(id)}`, { mask, query: `?languageCode=ko&regionCode=JP${session ? `&sessionToken=${session}` : ''}` });
  const ja = await gFetch(`places/${encodeURIComponent(id)}`, { mask: 'displayName', query: '?languageCode=ja' }).catch(() => null);
  const { photo, photoUrl, photos, photoErr } = await gPhoto(d.photos);
  const { o, off } = gHours(d.regularOpeningHours?.periods);
  const cat = G_CAT([d.primaryType, ...(d.types || [])].filter(Boolean));
  return {
    gid: d.id, name: d.displayName?.text || '', nameJa: ja?.displayName?.text || '', cat,
    addr: d.formattedAddress || '', ...(d.location ? { lat: d.location.latitude, lng: d.location.longitude } : {}),
    o, off, r: d.rating || null, n: d.userRatingCount ? d.userRatingCount.toLocaleString('ko-KR') : '',
    memo: d.editorialSummary?.text || '', best: [], tips: [], stay: G_STAY[cat], note: '', ai: true, from: 'google',
    photo, photoUrl, photos, ...(photoErr ? { note: photoErr } : {}), url: d.googleMapsUri || '', kind: d.primaryTypeDisplayName?.text || '', week: d.regularOpeningHours?.weekdayDescriptions || [],
  };
}
// Claude adds what Google doesn't give: a natural Korean name, one line on why go, picks, tips and visit length.
const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'desc', 'best', 'tips', 'stay', 'cat'],
  properties: {
    name: { type: 'string' }, desc: { type: 'string' },
    best: { type: 'array', items: { type: 'string' } }, tips: { type: 'array', items: { type: 'string' } },
    stay: { type: 'integer' }, cat: { type: 'string', enum: ['eat', 'drink', 'see', 'shop'] },
  },
};
const ENRICH_SYSTEM = `You write short Korean place notes for a Korean couple's Tokyo trip app (2026-11-02 to 11-06).
You get Google Maps facts about one place. Return: name (the Korean name a Korean traveler would use; keep brand names recognizable), desc (one line: what it is and why go), best (up to 3 dishes or highlights worth trying, from what you know about this place), tips (2-3 practical visitor tips in your own words: queues, cash, ordering, best time), stay (typical visit length in minutes), cat.
Don't invent facts you aren't fairly sure of; leave best or tips short rather than guessing. Never copy review sentences.`;
async function aiEnrich(g) {
  const { Anthropic, client } = await aiClient();
  const m = aiModel();
  const facts = { name: g.name, nameJa: g.nameJa, type: g.kind, address: g.addr, rating: g.r, reviews: g.n, hours: g.week, summary: g.memo };
  const body = { model: m.id, max_tokens: 4000, system: [{ type: 'text', text: ENRICH_SYSTEM, cache_control: { type: 'ephemeral' } }], output_config: { effort: 'low', format: { type: 'json_schema', schema: ENRICH_SCHEMA } }, messages: [{ role: 'user', content: JSON.stringify(facts) }] };
  try {
    const res = m.fallback
      ? await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(body);
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) { throw new Error(aiError(e, Anthropic)); }
}
// Google facts first, then Claude's notes when an AI key is set (a failed note step keeps the Google facts).
async function placeFromGoogle(id, session) { return enrichPlace(await gPlace(id, session)); }
async function enrichPlace(g) {
  if (!aiKey()) return g;
  try {
    const e = await aiEnrich(g);
    if (e) {
      return { ...g, name: String(e.name || g.name).slice(0, 60), memo: String(e.desc || g.memo), cat: ['eat', 'drink', 'see', 'shop'].includes(e.cat) ? e.cat : g.cat,
        best: (Array.isArray(e.best) ? e.best : []).map(String).slice(0, 3), tips: (Array.isArray(e.tips) ? e.tips : []).map(String).slice(0, 3),
        stay: Math.min(240, Math.max(15, Math.round((Number(e.stay) || g.stay) / 15) * 15)) };
    }
  } catch (e) { return { ...g, note: `AI 설명은 못 붙였어요 · ${e.message}` }; }
  return g;
}

// Pasted share text → a place record in the app's own format.
async function aiPlace(text) {
  const m = aiModel();
  const res = await aiRun({
    system: [{ type: 'text', text: PLACE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [{ type: m.search, name: 'web_search', max_uses: 3, user_location: { type: 'approximate', city: 'Tokyo', country: 'JP', timezone: 'Asia/Tokyo' } }, { type: m.fetch, name: 'web_fetch', max_uses: 2 }, SAVE_PLACE],
    text: `오늘은 ${tokyoNow().date}이에요. 이 장소를 앱에 넣어 주세요.\n\n${text}`,
  });
  const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'save_place');
  const v = call?.input;
  if (!v || !v.found || !v.name) throw new Error(v?.note || '장소를 찾지 못했어요. 링크와 함께 가게 이름도 붙여 넣어 보세요.');
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const lat = num(v.lat);
  const lng = num(v.lng);
  return {
    name: String(v.name).slice(0, 60), nameJa: String(v.nameJa || '').slice(0, 80),
    cat: ['eat', 'drink', 'see', 'shop'].includes(v.cat) ? v.cat : 'see',
    addr: String(v.addr || ''), ...(lat !== null && lng !== null && Math.abs(lat - 35.7) < 1.5 && Math.abs(lng - 139.7) < 1.5 ? { lat, lng } : {}),
    o: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(v.hours || '') ? v.hours : '',
    off: (Array.isArray(v.off) ? v.off : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    r: num(v.rating), n: String(v.reviews || ''),
    memo: String(v.desc || ''), best: (Array.isArray(v.best) ? v.best : []).map(String).slice(0, 3), tips: (Array.isArray(v.tips) ? v.tips : []).map(String).slice(0, 3),
    stay: Math.min(240, Math.max(15, Math.round((Number(v.stay) || 60) / 15) * 15)),
    note: String(v.note || ''), ai: true,
  };
}
// A found place, as a small card to check before saving.
const aiPlaceCard = (pl) => `
  <div class="ai-card">
    <div class="ai-tag ${pl.from === 'google' && !aiKey() ? 'g' : ''}">${pl.from === 'google' && !aiKey() ? icon('check') : aiBadge('xs')}${pl.from === 'google' ? `구글 장소 정보${aiKey() ? ' + AI 설명' : ''}` : 'AI가 찾은 정보 · 확인 필요'}</div>
    ${pl.photo || pl.photoUrl ? `<img class="ai-photo" src="${esc(photoSrc(pl, 'w600-h300'))}" data-alt="${esc(pl.photo && pl.photoUrl ? pl.photoUrl : '')}" alt="" referrerpolicy="no-referrer" onerror="${PHOTO_FALLBACK}">` : ''}
    <b>${esc(pl.name)}${pl.nameJa ? ` <small>${esc(pl.nameJa)}</small>` : ''}</b>
    <div class="ai-facts">${[pl.r ? `★${pl.r.toFixed(1)}${pl.n ? ` (${esc(pl.n)})` : ''}` : '', pl.o ? `영업 ${esc(pl.o)}` : '', pl.off.length ? `휴무 ${pl.off.map((d) => WEEKDAYS[d]).join('·')}` : '', `머무는 시간 약 ${formatLeft(pl.stay)}`, pl.lat ? '위치 확인' : '위치 미확인'].filter(Boolean).join(' · ')}</div>
    ${pl.memo ? `<div class="ai-desc">${esc(pl.memo)}</div>` : ''}
    ${pl.best.length ? `<div class="ai-row"><span>추천</span>${esc(pl.best.join(', '))}</div>` : ''}
    ${pl.tips.length ? `<ul class="info-tips">${pl.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${pl.note ? `<div class="ai-note">${esc(pl.note)}</div>` : ''}
  </div>`;
// Save as one of "내 장소"; returns the stored place.
function saveAiPlace(pl, url) {
  const { stay, note, kind, week, ...rest } = pl;
  const place = { id: uid('my'), ...rest, ...(/^https?:/.test(url || '') && !rest.url ? { url } : {}) };
  if (!place.photo) delete place.photo;
  if (!place.photoUrl) delete place.photoUrl;
  if (!place.url) delete place.url;
  if (!place.o) delete place.o;
  if (!place.off?.length) delete place.off;
  if (!place.r) { delete place.r; delete place.n; }
  store.set('myplaces', [...store.get('myplaces', []), place]);
  return place;
}

// ---------- one place finder for 일정 추가 and 탐색 ＋ ----------
// Type a name or paste a Google Maps link. Places already in the app come first (no lookup, nothing duplicated),
// then Google's suggestions. A link is looked up on its own once pasted.
const finderHtml = (w) => `
  <div class="finder" data-finder="${w}">
    <div class="finder-in">${icon('pin')}<textarea class="input" id="${w}-q" rows="1" autocomplete="off" placeholder="장소 이름 또는 지도 링크"></textarea>
      <button type="button" class="finder-go ai" data-find="${w}" aria-label="찾기">${aiBadge()}찾기</button></div>
    <input class="input finder-name" id="${w}-nm" hidden maxlength="60" autocomplete="off" placeholder="가게 이름 2~3글자 (짧은 링크는 이름이 필요해요)">
    <div class="sugg" id="${w}-sugg"></div>
    <div id="${w}-out"></div>
    ${gKey() ? '' : `<div class="small muted finder-hint">${aiKey() ? '구글 장소 키를 넣으면 이름만으로 사진·영업시간까지 채워요.' : '설정 › AI 도우미에서 키를 넣으면 이름이나 링크로 정보를 채워요.'}</div>`}
  </div>`;
const fq = (w) => $(`#${w}-q`)?.value.trim() || '';
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, '');
// Places in the app whose name matches what was typed (탐색 places and 내 장소).
const localMatches = (q) => {
  const n = norm(q);
  if (n.length < 2) return [];
  return allPlaces().filter((x) => [x.name, x.nameJa, x.sub].some((t) => norm(t).includes(n))).slice(0, 3);
};
// The app's place that is the same as a Google result: same Google ID, or within 50m with a similar name.
const sameAs = (g) => allPlaces().find((x) => (x.gid && x.gid === g.gid)
  || (x.lat && g.lat && kmBetween(x, g) < 0.05 && (norm(x.name).includes(norm(g.name).slice(0, 2)) || norm(g.nameJa).includes(norm(x.nameJa || x.name).slice(0, 2)))));
const placeLine = (x) => [x.area === '내 장소' ? '내 장소' : x.area, x.r ? `★${Number(x.r).toFixed(1)}` : '', scheduledItem(x) ? '일정에 있음' : ''].filter(Boolean).join(' · ');

let findTimer = null;
function finderTyped(w) {
  clearTimeout(findTimer);
  const raw = fq(w);
  const box = $(`#${w}-sugg`);
  const nameBox = $(`#${w}-nm`);
  if (/https?:\/\//.test(raw)) {
    // A pasted link is looked up right away; only a short link without a name needs the name box.
    box.innerHTML = '';
    if (nameBox) nameBox.hidden = !needsName(raw);
    if (!needsName(raw)) findTimer = setTimeout(() => runFind(w), 300);
    else $(`#${w}-out`).innerHTML = `<div class="ai-note">짧은 구글지도 링크(maps.app.goo.gl)는 구글 밖에서 열리지 않아 링크만으로는 장소를 알 수 없어요. 아래에 가게 이름을 2~3글자 입력해 주세요.</div>`;
    return;
  }
  if (nameBox) nameBox.hidden = true;
  suggestFor(w, raw);
}
// A short maps.app.goo.gl link can't be opened from outside Google, so a bare one needs the place name.
const bareLink = (text) => { const { url, name } = parseShare(text); return !!url && !name; };
const needsName = (raw) => bareLink(raw) && !/!3d-?[\d.]+!4d|@-?[\d.]+,-?[\d.]+/.test(raw);
function suggestFor(w, q) {
  clearTimeout(findTimer);
  const box = $(`#${w}-sugg`);
  if (!box) return;
  const local = localMatches(q);
  const draw = (google, err) => {
    box.innerHTML = [
      local.length ? `<div class="sugg-h">앱에 있는 장소</div>${local.map((x) => `<button type="button" data-pick-local="${esc(x.id)}" data-where="${w}">${placeThumb(x, 'w80-h80')}<span><b>${esc(x.name)}</b><small>${esc(placeLine(x))}</small></span></button>`).join('')}` : '',
      google?.length ? `<div class="sugg-h">구글에서 찾은 장소</div>${google.map((x) => `<button type="button" data-g-pick="${esc(x.id)}" data-where="${w}"><span><b>${esc(x.main)}</b><small>${esc(x.sub)}</small></span></button>`).join('')}` : '',
      err ? `<div class="ai-note">${esc(err)}</div>` : '',
      !local.length && google && !google.length && q.length >= 2 ? '<div class="small muted">찾은 장소가 없어요. 이름을 바꿔 보세요.</div>' : '',
    ].join('');
  };
  draw(null);
  if (!gKey() || norm(q).length < 2) return;
  findTimer = setTimeout(async () => {
    state.gSession = state.gSession || crypto.randomUUID();
    try { draw(await gSuggest(q, state.gSession)); } catch (e) { draw([], e.message); }
  }, 350);
}
// "찾기" or a pasted link: position in a long link first, then the name; without a Google key, Claude or the share text.
async function runFind(w) {
  const raw = fq(w);
  const out = $(`#${w}-out`);
  const given = $(`#${w}-nm`)?.value.trim() || '';
  if (!raw && !given) return toast('장소 이름이나 구글지도 링크를 넣어 주세요');
  if (needsName(raw) && !given) { $(`#${w}-nm`).hidden = false; $(`#${w}-nm`).focus(); return; }
  const { url, name: shareName, addr } = parseShare(raw);
  const name = given || shareName || (/https?:\/\//.test(raw) ? '' : raw);
  if (gKey()) {
    const pos = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) || url.match(/@(-?[\d.]+),(-?[\d.]+)/);
    out.innerHTML = aiLoading('구글에서 찾고 있어요', ['장소를 찾는 중'], true);
    try {
      let id = pos ? await gNear(Number(pos[1]), Number(pos[2])) : null;
      if (!id && name) { state.gSession = state.gSession || crypto.randomUUID(); id = (await gSuggest(name, state.gSession))[0]?.id; }
      if (!id) throw new Error('구글에서 찾은 장소가 없어요. 이름을 바꿔 보세요.');
      return gPick(id, w);
    } catch (e) { out.innerHTML = `<div class="ai-note">${esc(e.message)}</div>`; return; }
  }
  const local = name && localMatches(name)[0];
  if (local) return pickLocal(local.id, w, '앱에 이미 있는 장소라 그 정보를 썼어요');
  if (aiKey()) {
    out.innerHTML = aiLoading('AI가 장소를 찾고 있어요', ['링크를 열어 보는 중', '웹에서 장소를 찾는 중', '영업시간·팁을 정리하는 중', '거의 다 됐어요']);
    try { return useFound(w, await aiPlace(given && !raw.includes(given) ? `${given}\n${raw}` : raw), url); } catch (e) { out.innerHTML = aiFail(e.message); return; }
  }
  if (!name) return toast('공유 내용에서 이름을 찾지 못했어요');
  const hit = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) || url.match(/@(-?[\d.]+),(-?[\d.]+)/);
  useFound(w, { name, nameJa: '', cat: CAT_WORDS.find(([, re]) => re.test(name))?.[0] || 'see', addr, o: '', off: [], r: null, n: '', memo: '', best: [], tips: [], stay: 60, note: '', ...(hit ? { lat: Number(hit[1]), lng: Number(hit[2]) } : {}) }, url);
}
// A Google pick: details first; if the app already has that place, use it instead of making a second copy.
async function gPick(id, w) {
  const out = $(`#${w}-out`);
  $(`#${w}-sugg`).innerHTML = '';
  out.innerHTML = aiKey() ? aiLoading('구글 정보와 AI 설명을 가져오고 있어요', ['구글에서 장소 정보를 가져오는 중', '사진을 받는 중', 'AI가 설명과 팁을 쓰는 중', '거의 다 됐어요']) : aiLoading('구글 정보를 가져오고 있어요', ['장소 정보를 가져오는 중', '사진을 받는 중'], true);
  try {
    const g = await gPlace(id, state.gSession);
    state.gSession = null;
    const dup = sameAs(g);
    if (dup) return pickLocal(dup.id, w, '앱에 이미 있는 장소라 그 정보를 썼어요');
    useFound(w, await enrichPlace(g), g.url);
  } catch (e) { out.innerHTML = aiFail(e.message); }
}
// A place the app already has: fill the stop from it, or (탐색) point to it.
function pickLocal(id, w, why = '') {
  const x = placeById(id);
  if (!x) return;
  $(`#${w}-sugg`).innerHTML = '';
  const out = $(`#${w}-out`);
  const card = `
    <div class="ai-card">
      <div class="ai-tag app">${icon('check')}앱에 있는 장소${why ? ` · ${esc(why)}` : ''}</div>
      <div class="found-row">${placeThumb(x, 'w120-h120')}<span><b>${esc(x.name)}</b><small>${esc(placeLine(x))}</small>${x.desc ? `<small>${esc(x.desc)}</small>` : ''}</span></div>
    </div>`;
  if (w === 'pn') {
    const item = scheduledItem(x);
    out.innerHTML = `${card}<div class="btns"><button class="btn" data-place="${esc(id)}">장소 보기</button>${item ? `<button class="btn primary" data-item="${esc(item.id)}">${esc(item.start)} 일정 보기</button>` : `<button class="btn primary" data-place-plan="${esc(id)}">${icon('plus')}일정에 넣기</button>`}</div>`;
    $('#pn-save').hidden = true;
    return;
  }
  fillStop(x, G_STAY[x.cat] || 60);
  out.innerHTML = card;
}
// Fill the stop form from a place (title, kind, place, length, memo); the form then re-checks hours and overlaps.
function fillStop(place, stay) {
  const kind = CAT_ICON[place.cat] || '📍';
  state.form.kind = kind;
  document.querySelectorAll('[data-f-kind]').forEach((b) => b.classList.toggle('on', glyph(b.dataset.fKind)[0] === glyph(kind)[0]));
  $('#f-title').value = place.name;
  if ($('#f-place')) $('#f-place').value = place.name;
  if ((place.memo || place.desc) && !$('#f-note').value) $('#f-note').value = place.memo || place.desc;
  state.form.dur = stay;
  $('#f-end').value = clock(Math.min(1439, state.form.s + stay));
  updateForm();
}
// A new place found: a stop saves it to 내 장소 and fills in; 탐색 shows it with the save buttons.
function useFound(w, pl, url) {
  const out = $(`#${w}-out`);
  if (w === 'pn') {
    state.aiFound = { pl, url };
    out.innerHTML = aiPlaceCard(pl);
    $('#pn-name').value = pl.name; $('#pn-cat').value = pl.cat; $('#pn-memo').value = pl.memo || '';
    $('#pn-save').hidden = false;
    return;
  }
  const place = saveAiPlace(pl.ai ? pl : { ...pl, ai: undefined }, url);
  fillStop(place, pl.stay);
  out.innerHTML = pl.ai ? aiPlaceCard(pl) : `<div class="small muted">${esc(place.name)}을(를) 내 장소에 넣었어요.</div>`;
}

// The result is kept in state, so a redraw (weather, exchange rate) while waiting doesn't wipe it.
async function aiTest() {
  if (state.aiTest?.busy) return;
  state.aiTest = { busy: true };
  render();
  let msg;
  try {
    const { Anthropic, client } = await aiClient();
    try { await client.messages.create({ model: aiModel().id, max_tokens: 1024, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'OK라고만 답해 주세요.' }] }); msg = '연결됐어요'; }
    catch (e) { msg = aiError(e, Anthropic); }
  } catch { msg = 'Claude 도구를 불러오지 못했어요. 인터넷을 확인해 주세요.'; }
  state.aiTest = { msg, ok: msg === '연결됐어요' };
  render();
  toast(msg);
}

async function gTest() {
  if (state.gTest?.busy) return;
  state.gTest = { busy: true }; render();
  let msg;
  try { const list = await gSuggest('浅草寺', crypto.randomUUID()); msg = list.length ? '구글 장소 검색이 연결됐어요' : '연결은 됐지만 결과가 없어요'; }
  catch (e) { msg = e.message; }
  // Routes API on the same key: try one short ride (Ueno → Asakusa) and remember whether it works.
  store.set('routeOff', '');
  const pt = (lat, lng) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  try {
    const res = await gCall(R_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': 'routes.duration' }, body: JSON.stringify({ origin: pt(35.7141, 139.7774), destination: pt(35.7106, 139.7966), travelMode: 'TRANSIT', departureTime: departIso(tokyoNow().date, 600) }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { store.set('routeErr', null); msg += ' · 이동 경로도 연결됐어요'; }
    else {
      const why = data.error?.message || '';
      store.set('routeErr', { at: Date.now(), status: res.status, msg: why.slice(0, 200) });
      store.set('routeOff', 'api');
      msg += ` · 이동 경로 오류 ${res.status}: ${/not been used|disabled|SERVICE_DISABLED/i.test(why) ? 'Routes API가 꺼져 있어요' : /blocked|not authorized/i.test(why) ? '키의 API 제한에 Routes API가 없어요' : /referer|referrer/i.test(why) ? '키의 웹사이트 제한을 확인해 주세요' : /billing/i.test(why) ? '결제 계정 연결이 필요해요' : why.slice(0, 80)}`;
    }
  } catch (e) { msg += ` · 이동 경로 연결 실패 (${String(e.message || e).slice(0, 60)})`; }
  state.gTest = { msg, ok: /연결됐어요/.test(msg) }; render(); toast(msg);
}

// The trip file's places: only Google's facts are fetched again (rating, reviews, hours, address, map link) and kept
// on this phone; the trip's own notes, picks and photos stay. The place found must be near where it was.
async function refreshTripPlace(id) {
  const p = placeById(id);
  if (!p) throw new Error('장소를 찾지 못했어요');
  let gid = p.gid;
  if (!gid) gid = (await gSuggest(p.nameJa || p.name, crypto.randomUUID()))[0]?.id;
  if (!gid && p.lat) gid = await gNear(p.lat, p.lng);
  if (!gid) throw new Error('구글에서 찾지 못했어요');
  const g = await gPlace(gid);
  if (p.lat && g.lat && kmBetween(p, g) > 1) throw new Error(`구글에서 찾은 곳이 1km 넘게 떨어져 있어요 (${g.name})`);
  const fix = { gid, gAt: tokyoNow().date, ...(g.r ? { r: g.r, n: g.n } : {}), ...(g.o ? { o: g.o, off: g.off } : {}), ...(g.addr ? { addr: g.addr } : {}),
    ...(g.lat ? { lat: g.lat, lng: g.lng } : {}), ...(g.url ? { url: g.url } : {}), ...(g.photo || g.photoUrl ? { photo: g.photo, photoUrl: g.photoUrl, photos: g.photos || [] } : {}) };
  store.set('gfix', { ...gFix(), [id]: { ...(gFix()[id] || {}), ...fix } });
  GFIX = null;
}
async function refreshAnyPlace(id) {
  if (placeById(id)?.mine) return refreshFromGoogle(id);
  toast('구글에서 다시 찾는 중…');
  try { await refreshTripPlace(id); render(); openPlace(id); toast(`구글 정보로 다시 채웠어요 · 평점·영업시간·주소${placeById(id)?.photo || placeById(id)?.photoUrl ? '·사진' : ''}`); } catch (e) { toast(e.message); }
}
// Every place in 탐색 in one go, one at a time; failures are listed at the end, nothing else changes.
async function refreshAllPlaces() {
  const list = allPlaces();
  if (!(await askConfirm(`장소 ${list.length}곳을 구글 정보로 다시 채울까요?`, { body: `평점·리뷰 수·영업시간·주소를 새로 받아요. 메모와 사진은 그대로예요. 구글 요청이 약 ${list.length * 2}번 들어가요(무료 사용량 안).`, ok: '다시 채우기' }))) return;
  const bar = $('#ex-refresh');
  let ok = 0; const fail = [];
  for (const [i, p] of list.entries()) {
    if (bar) bar.textContent = `구글 정보 다시 채우는 중 · ${i + 1}/${list.length}`;
    try {
      if (p.mine) {
        const old = store.get('myplaces', []).find((x) => x.id === p.id);
        let gid = old.gid || (old.lat ? await gNear(old.lat, old.lng) : null) || (await gSuggest(old.name, crypto.randomUUID()))[0]?.id;
        if (!gid) throw new Error('못 찾음');
        const g = await gPlace(gid);
        const { stay, note, kind, week, memo, best, tips, name, cat, ...facts } = g;
        store.set('myplaces', store.get('myplaces', []).map((x) => (x.id === p.id ? { ...x, ...facts, id: x.id } : x)));
      } else await refreshTripPlace(p.id);
      ok += 1;
    } catch (e) { fail.push(p.name); }
  }
  render();
  toast(`${ok}곳 다시 채웠어요${fail.length ? ` · ${fail.length}곳 못 찾음 (${fail.slice(0, 3).join(', ')}${fail.length > 3 ? ' 등' : ''})` : ''}`);
}
async function refreshFromGoogle(id) {
  const old = store.get('myplaces', []).find((x) => x.id === id);
  if (!old) return;
  toast('구글에서 다시 찾는 중…');
  try {
    let gid = old.gid;
    if (!gid && old.lat) gid = await gNear(old.lat, old.lng);
    if (!gid) gid = (await gSuggest(old.name, crypto.randomUUID()))[0]?.id;
    if (!gid) return toast('구글에서 찾지 못했어요');
    const g = await gPlace(gid);
    // Don't turn this place into a copy of another one the app already has.
    const other = sameAs(g);
    if (other && other.id !== id) return toast(`'${other.name}'과(와) 같은 장소예요. 그 장소를 써 주세요`);
    const { stay, note, kind, week, ...rest } = await enrichPlace(g);
    // What the traveler wrote stays; Google fills the facts.
    store.set('myplaces', store.get('myplaces', []).map((x) => (x.id === id ? { ...x, ...rest, id, name: x.name || rest.name, memo: x.memo || rest.memo } : x)));
    render(); openPlace(id); toast('구글 정보로 다시 채웠어요');
  } catch (e) { toast(e.message); }
}


// ---------- AI with photos and plans (all results go through a check screen before anything is saved) ----------
// One structured answer from Claude: the given content (text and/or photos) in, JSON matching the schema out.
async function aiAsk({ system, content, schema, effort = 'low' }) {
  const { Anthropic, client } = await aiClient();
  const m = aiModel();
  const body = { model: m.id, max_tokens: 8000, system, output_config: { effort, format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content }] };
  try {
    const res = m.fallback
      ? await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(body);
    if (res.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 처리하지 않았어요.');
    if (res.stop_reason === 'max_tokens') throw new Error('답이 너무 길어 끊겼어요. 다시 시도해 주세요.');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('답을 받지 못했어요.');
    return JSON.parse(text);
  } catch (e) { throw new Error(e instanceof SyntaxError ? '답을 읽지 못했어요. 다시 시도해 주세요.' : aiError(e, Anthropic)); }
}
// A photo from the camera or library, made small enough for Claude (long side 1568px).
function pickImage() {
  return new Promise((done) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
    inp.onchange = () => { done(inp.files[0] || null); inp.remove(); };
    document.body.appendChild(inp);
    inp.click();
  });
}
async function imgBlock(file) {
  let blob = file;
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1568 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.85));
  } catch { /* send the original */ }
  const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  return { type: 'image', source: { type: 'base64', media_type: blob.type === 'image/png' ? 'image/png' : 'image/jpeg', data } };
}
// While Claude works: a pulsing sparkle, a moving bar, seconds counted and the step it is on (DESIGN.md › AI).
// `plain` is the same thing in grey for waits that aren't AI (uploads, Google only).
const aiLoading = (msg, steps = [], plain = false) => `
  <div class="ai-wait ai-load ${plain ? 'plain' : ''}" role="status" aria-live="polite" data-start="${Date.now()}" data-steps="${esc(JSON.stringify(steps))}">
    ${plain ? `<span class="ai-orb">${icon('refresh')}</span>` : aiChar('thinking', 'ai-think')}
    <div class="ai-load-main">
      <div class="ai-load-top"><b>${esc(msg)}</b><span class="ai-sec">0초</span></div>
      <div class="ai-bar"><i></i></div>
      ${steps.length ? `<small class="ai-step">${esc(steps[0])}</small>` : ''}
    </div>
  </div>`;
setInterval(() => {
  document.querySelectorAll('.ai-load').forEach((el) => {
    const t = Math.floor((Date.now() - Number(el.dataset.start)) / 1000);
    el.querySelector('.ai-sec').textContent = `${t}초`;
    const steps = JSON.parse(el.dataset.steps || '[]');
    const st = el.querySelector('.ai-step');
    if (st && steps.length) st.textContent = steps[Math.min(steps.length - 1, Math.floor(t / 4))];
  });
}, 1000);
const sheetWait = (title, msg, file, steps = []) => {
  $('#sheet-body').innerHTML = `<div class="sheet-head"><h3 class="ai-h">${aiBadge()}${esc(title)}</h3></div>
    ${file ? `<div class="ai-shot-wrap scanning"><img class="ai-shot" src="${URL.createObjectURL(file)}" alt=""></div>` : ''}
    ${aiLoading(msg, steps)}<div id="ai-res"></div>`;
  $('#sheet').hidden = false;
};
const doneWait = () => { $('.ai-wait')?.remove(); $('.ai-shot-wrap')?.classList.remove('scanning'); };
const sheetFail = (msg) => { const box = $('#ai-res') || $('#sheet-body'); doneWait(); box.insertAdjacentHTML('beforeend', aiFail(msg)); };

// ① Receipt photo → one expense, with the photo kept as its receipt.
const RCPT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['found', 'shop', 'date', 'time', 'total', 'currency', 'pay', 'cat', 'taxfree', 'items', 'note'],
  properties: {
    found: { type: 'boolean' }, shop: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD or empty' }, time: { type: 'string', description: 'HH:MM or empty' },
    total: { type: 'number' }, currency: { type: 'string', enum: ['JPY', 'KRW'] }, pay: { type: 'string', enum: ['card', 'cash', 'unknown'] },
    cat: { type: 'string', enum: EXP_CATS }, taxfree: { type: 'boolean' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: ['number', 'null'] } } } },
    note: { type: 'string' },
  },
};
const RCPT_SYSTEM = `You read a receipt photo for a Korean couple's Tokyo trip (2026-11-02 to 11-06) and return the expense.
total is the amount actually paid (合計 / お支払い / 総額, tax included); currency JPY unless it is a Korean won receipt.
pay: card for クレジット / カード / IC / 電子マネー payments, cash for 現金 / お預り, else unknown.
shop: the store name a Korean traveler would recognise (brand in Korean if common, else as printed). items: up to 8 lines, names in Korean. taxfree: true if it is a tax-free (免税) receipt.
date and time as printed. cat is one of the given categories. If it is not a receipt, set found false and say why in Korean in note.`;
async function rcptFromPhoto() {
  const file = await pickImage();
  if (!file) return;
  sheetWait('영수증으로 지출 등록', 'AI가 영수증을 읽고 있어요', file, ['영수증 글자를 읽는 중', '합계·날짜·시간을 찾는 중', '품목을 한국어로 정리하는 중', '거의 다 됐어요']);
  try {
    const r = await aiAsk({ system: RCPT_SYSTEM, schema: RCPT_SCHEMA, content: [await imgBlock(file), { type: 'text', text: '이 영수증을 지출로 정리해 주세요.' }] });
    if (!r.found) return sheetFail(r.note || '영수증으로 읽지 못했어요.');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : tokyoNow().date;
    const row = payRow({ date: day, time: /^\d{1,2}:\d{2}$/.test(r.time) ? r.time.padStart(5, '0') : '', shop: r.shop || '영수증', cur: r.currency, value: Math.round(r.total) });
    state.rcptAi = { file, row, pay: r.pay === 'unknown' ? payOf() : r.pay, items: r.items || [], taxfree: !!r.taxfree };
    doneWait();
    const items = (r.items || []).filter((x) => x.name);
    const lbl = (t, html, cls = '') => `<label class="rf ${cls}"><span>${t}</span>${html}</label>`;
    $('#ai-res').innerHTML = `
      <form class="rcpt-ai" data-rcpt-save>
        ${aiDone('AI가 읽은 내용이에요 · 맞는지 확인 후 등록')}
        <div class="rcpt-sum">
          <input class="rcpt-shop" name="shop" value="${esc(row.shop)}" maxlength="60" aria-label="장소명" placeholder="장소명">
          <div class="rcpt-amt"><input class="amount" name="amount" inputmode="numeric" value="${row.value.toLocaleString('ko-KR')}" aria-label="금액"><select name="cur" aria-label="통화"><option value="JPY" ${row.cur === 'JPY' ? 'selected' : ''}>엔</option><option value="KRW" ${row.cur === 'KRW' ? 'selected' : ''}>원</option></select></div>
          <div class="rcpt-tags">${[row.itemTitle ? `<span class="tag">${icon('pin')}${esc(row.itemTitle)} 일정</span>` : '', r.taxfree ? '<span class="tag ok">면세 영수증</span>' : ''].join('')}</div>
        </div>
        ${row.dup ? '<div class="ai-note">같은 날 같은 금액의 지출이 이미 있어요. 중복이 아닌지 확인해 주세요.</div>' : ''}
        <div class="rcpt-fields">
          ${lbl('날짜', expDatePick(row.date))}
          ${lbl('시간', timePick('time', row.time || '', '시간'))}
          ${lbl('결제', `<select class="input" name="pay"><option value="card" ${state.rcptAi.pay === 'card' ? 'selected' : ''}>카드</option><option value="cash" ${state.rcptAi.pay === 'cash' ? 'selected' : ''}>현금</option></select>`)}
          ${lbl('분류', catPick(r.cat || row.cat))}
        </div>
        ${items.length ? `<details class="rcpt-more"><summary>영수증 품목 ${items.length}개</summary><ul class="rcpt-items">${items.map((x) => `<li><span>${esc(x.name)}</span>${x.price ? `<b>${Math.round(x.price).toLocaleString('ko-KR')}</b>` : ''}</li>`).join('')}</ul></details>` : ''}
        <button class="btn primary wide" type="submit">${icon('check')}지출 등록</button>
        <div class="small muted rcpt-foot">${icon('image')}영수증 사진도 이 지출에 함께 저장돼요</div>
      </form>`;
  } catch (e) { sheetFail(e.message); }
}
async function saveRcptAi(form) {
  const a = state.rcptAi;
  if (!a) return;
  const f = new FormData(form);
  const value = Number(String(f.get('amount')).replace(/[^\d.]/g, ''));
  if (!value) return toast('금액을 확인해 주세요');
  // The title is the place only; the receipt's item lines stay on the photo.
  const shop = String(f.get('shop') || '').trim();
  const id = addExpense({ value, cur: f.get('cur'), pay: f.get('pay'), cat: f.get('cat'), date: f.get('date'), item: a.row.item, time: String(f.get('time') || ''), memo: shop });
  try { await addDoc(rcptSlot(id), a.file); await refreshDocSlots(); } catch { toast('지출은 등록했지만 사진은 저장하지 못했어요'); }
  state.rcptAi = null;
  state.expView = 'spent';
  closeSheet(); render();
  toast(`${shop || '영수증'} 지출을 등록했어요`);
}

// ⑤ Card app screenshot → several payments into the same check list as card messages.
const CAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['payments', 'note'],
  properties: {
    payments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'time', 'shop', 'amount', 'currency', 'cancel'],
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM or empty' }, shop: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', enum: ['JPY', 'KRW'] }, cancel: { type: 'boolean' } } } },
    note: { type: 'string' },
  },
};
async function smsFromPhoto() {
  const file = await pickImage();
  if (!file) return;
  $('#sms-out').innerHTML = aiLoading('AI가 캡처를 읽고 있어요', ['캡처 속 결제를 찾는 중', '날짜·금액을 맞추는 중', '이미 있는 지출과 비교하는 중']);
  try {
    const r = await aiAsk({
      system: `You read a screenshot of a Korean card app or card text messages for a Tokyo trip in ${state.trip.trip.start.slice(0, 4)}. List every payment you can see: date (YYYY-MM-DD; the year is ${state.trip.trip.start.slice(0, 4)} if not shown), time, shop as shown, amount, currency (JPY for 해외/엔 amounts, else KRW), cancel true for 취소. Prefer the foreign-currency amount when both are shown. Skip balances and totals. note: Korean, what you could not read.`,
      schema: CAP_SCHEMA, content: [await imgBlock(file), { type: 'text', text: '보이는 결제를 모두 정리해 주세요.' }],
    });
    const rows = (r.payments || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.amount > 0)
      .map((x) => payRow({ date: x.date, time: /^\d{1,2}:\d{2}$/.test(x.time) ? x.time.padStart(5, '0') : '', shop: x.shop || '카드 결제', cur: x.currency, value: Math.round(x.amount), cancel: !!x.cancel }));
    if (!rows.length) { $('#sms-out').innerHTML = aiFail(r.note || '결제를 찾지 못했어요.'); return; }
    showSms(rows);
  } catch (e) { $('#sms-out').innerHTML = aiFail(e.message); }
}

// ② Menu, sign or ticket machine photo → Korean, with prices in won and one phrase to say.
const MENU_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind', 'title', 'summary', 'items', 'ask'],
  properties: {
    kind: { type: 'string', enum: ['menu', 'sign', 'ticket', 'other'] }, title: { type: 'string' }, summary: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ja', 'ko', 'price', 'note'], properties: { ja: { type: 'string' }, ko: { type: 'string' }, price: { type: ['number', 'null'] }, note: { type: 'string' } } } },
    ask: { type: 'object', additionalProperties: false, required: ['ja', 'read', 'ko'], properties: { ja: { type: 'string' }, read: { type: 'string' }, ko: { type: 'string' } } },
  },
};
async function menuFromPhoto() {
  const file = await pickImage();
  if (!file) return;
  sheetWait('사진 번역', 'AI가 사진을 읽고 있어요', file, ['사진 속 글자를 읽는 중', '한국어로 옮기는 중', '가격을 원으로 바꾸는 중', '거의 다 됐어요']);
  try {
    const r = await aiAsk({
      system: `You help a Korean traveler in Japan understand a photo of a menu, sign, notice or ticket machine. Reply in Korean.
title: what this is. summary: 1-2 lines of what matters (how to order, rules, warnings). items: each menu item or important line (up to 20): ja as printed, ko natural Korean, price in yen if shown (number), note for spicy / popular / set contents / allergens / limits.
ask: one useful Japanese sentence the traveler may want to say here (ja), its Korean-letter pronunciation (read), and meaning (ko).`,
      schema: MENU_SCHEMA, content: [await imgBlock(file), { type: 'text', text: '이 사진을 한국어로 정리해 주세요.' }],
    });
    doneWait();
    const rate = fxRate();
    $('#ai-res').innerHTML = `
      <div class="menu-ai">
        ${aiDone('AI가 옮긴 내용이에요 · 가게에서 다시 확인')}
        <b class="menu-t">${esc(r.title)}</b>
        ${r.summary ? `<div class="menu-s">${esc(r.summary)}</div>` : ''}
        ${(r.items || []).length ? `<div class="menu-list">${r.items.map((x) => `
          <div class="menu-row"><span class="grow"><b>${esc(x.ko)}</b><small class="ja">${esc(x.ja)}</small>${x.note ? `<small>${esc(x.note)}</small>` : ''}</span>
            ${x.price ? `<span class="menu-p"><b>${Math.round(x.price).toLocaleString('ko-KR')}엔</b><small>약 ${(Math.round((x.price * rate) / 100) * 100).toLocaleString('ko-KR')}원</small></span>` : ''}</div>`).join('')}</div>` : ''}
        ${r.ask?.ja ? `<div class="menu-ask"><small>여기서 쓸 말</small><b class="ja">${esc(r.ask.ja)}</b><span>${esc(r.ask.read)} · ${esc(r.ask.ko)}</span>
          <button class="btn primary" data-speak-text="${esc(r.ask.ja)}">${icon('sound')}발음 듣기</button></div>` : ''}
      </div>`;
  } catch (e) { sheetFail(e.message); }
}

// ③ Change the day's plan in words; ④ the same engine asked for ways to catch up when running late.
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'options'],
  properties: {
    reply: { type: 'string', description: 'Korean, one or two lines to the traveler' },
    options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'summary', 'ops'], properties: {
      title: { type: 'string' }, summary: { type: 'string' },
      ops: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', 'id', 'start', 'end', 'title', 'kind', 'place'], properties: {
        op: { type: 'string', enum: ['move', 'skip', 'unskip', 'add', 'rename', 'releg'] },
        id: { type: 'string', description: 'stop id for move/skip/unskip/rename, empty for add' },
        start: { type: 'string', description: 'HH:MM for move/add, else empty' }, end: { type: 'string', description: 'HH:MM or empty' },
        title: { type: 'string', description: 'for add/rename, else empty' }, kind: { type: 'string', enum: ['eat', 'drink', 'see', 'shop', 'move', 'rest', ''] },
        place: { type: 'string', description: 'for add: a place name from the known places list if it fits, else empty' },
      } } },
    } } },
  },
};
const PLAN_SYSTEM = `You adjust one day of a Korean couple's Tokyo trip plan. You get the day's stops (id, times, title, fixed, done, skipped), the time now if it is that day, and what the traveler asks.
Return 1 option for a clear request, or 2-3 options when asked for suggestions. Each option is a list of ops on stop ids from the list:
move (new start, and end if the length changes), skip, unskip, rename, add (new stop with start, end, title, kind, and place if one of the known places fits), releg (id of a travel stop: the app recomputes that ride or walk from the stop before to the stop after it, with real route, line and minutes, leaving when the stop before ends).\nUse releg — never move or rename — when the traveler asks to update or fix travel/이동 info, or when stops around a travel stop were skipped or changed; the app works out travel times and routes, so never guess them yourself.
Rules: never move or skip a fixed stop unless the traveler names it; keep stops in a sensible order without overlaps; travel stops (kind move) usually shift with what they connect; title an added train ride "<노선명> <타는 역> → <내리는 역>" in Korean (e.g. "히비야선 에비스 → 우에노", "JR 야마노테선 시부야 → 우에노", "긴자선 시부야 → 아사쿠사") and a walk "도보 → <곳>"; don't touch stops that are done; prefer shortening or skipping optional stops over moving fixed ones.
Write title, summary and reply in natural Korean. If the request can't be done, return no options and explain in reply.`;
const PLAN_KIND = { eat: '🍽', drink: '☕', see: '🏛', shop: '🛍', move: '🚇', rest: '🏨', '': '📍' };
function openAiPlan(preset = '') {
  const day = state.trip.days[state.dayIndex] || state.trip.days.find((d) => d.date === tokyoNow().date);
  state.aiPlanDate = day.date;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3 class="ai-h">${aiBadge()}말로 일정 바꾸기</h3></div>
    <div class="small muted">${esc(dayLabel(day.date))} 일정 · 바꾸고 싶은 걸 그대로 적거나 🎤로 말해 주세요. 바뀌는 내용을 먼저 보여 드려요.</div>
    <textarea class="input ai-ask" id="ai-plan-q" rows="3" placeholder="예: 마이센 줄 길어서 근처 라멘집으로 바꾸고, 뒤 일정 30분 미뤄줘">${esc(preset)}</textarea>
    <div class="chips ai-eg">${['비 와서 밖 일정 빼고 실내로', '30분 늦게 시작할래', '점심 1시간 늦춰줘', '저녁 전에 1시간 쉬고 싶어'].map((t) => `<button type="button" class="chip" data-ai-eg="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <button class="btn ai primary wide" data-ai-plan-go>${aiLabel('바뀔 내용 보기')}</button>
    <div id="ai-res"></div>`;
  $('#sheet').hidden = false;
  if (preset) aiPlanGo();
}
async function aiPlanGo() {
  const q = $('#ai-plan-q').value.trim();
  if (!q) return toast('바꾸고 싶은 내용을 적어 주세요');
  const date = state.aiPlanDate;
  const day = dayOf(date);
  const now = tokyoNow();
  const items = dayItems(day);
  const stops = items.map((it) => ({ id: it.id, start: it.start, end: it.end || '', title: stripEmoji(it.title), kind: isMove(it) ? 'move' : '', fixed: isFixed(it), done: isDone(it.id), skipped: !!it.skip, place: placeOfItem(it.id)?.name || '' }));
  const known = allPlaces().filter((x) => x.lat).map((x) => `${x.name}|${x.area}|${x.cat}`).join('\n');
  $('#ai-res').innerHTML = aiLoading('AI가 일정을 맞춰 보고 있어요', ['오늘 일정을 살펴보는 중', '고정 일정을 확인하는 중', '바꿀 방법을 만드는 중', '거의 다 됐어요']);
  const goBtn = $('[data-ai-plan-go]');
  if (goBtn) { goBtn.disabled = true; goBtn.classList.add('busy'); }
  try {
    const r = await aiAsk({
      system: [{ type: 'text', text: PLAN_SYSTEM }, { type: 'text', text: `Known places (name|area|category):\n${known}`, cache_control: { type: 'ephemeral' } }],
      schema: PLAN_SCHEMA, effort: 'medium',
      content: [{ type: 'text', text: JSON.stringify({ date, now: now.date === date ? clock(now.min) : null, stops, ask: q }) }],
    });
    state.aiPlan = { date, options: (r.options || []).map((o) => ({ ...o, ops: cleanOps(o.ops, items) })).filter((o) => o.ops.length) };
    $('[data-ai-plan-go]')?.removeAttribute('disabled'); $('[data-ai-plan-go]')?.classList.remove('busy');
    $('#ai-res').innerHTML = `
      ${r.reply ? `<div class="ai-reply">${esc(r.reply)}</div>` : ''}
      ${state.aiPlan.options.length ? aiDone('AI가 만든 안이에요 · 적용 전에 확인하세요') : ''}
      ${state.aiPlan.options.map((o, i) => `
        <div class="ai-opt">
          <b>${esc(o.title)}</b>${o.summary ? `<small>${esc(o.summary)}</small>` : ''}
          <ul class="ai-diff">${o.ops.map((op) => `<li class="${op.warn ? 'warn' : ''}">${esc(op.text)}</li>`).join('')}</ul>
          <button class="btn primary wide" data-ai-plan-apply="${i}">${icon('check')}이대로 적용</button>
        </div>`).join('') || (r.reply ? '' : '<div class="ai-note">바꿀 내용을 찾지 못했어요. 조금 더 구체적으로 적어 주세요.</div>')}`;
  } catch (e) { $('#ai-res').innerHTML = aiFail(e.message); $('[data-ai-plan-go]')?.removeAttribute('disabled'); $('[data-ai-plan-go]')?.classList.remove('busy'); }
}
// Keep only ops on real stops with valid times, and describe each in words for the preview.
function cleanOps(ops = [], items) {
  const hm = (t) => /^\d{1,2}:\d{2}$/.test(t || '') && toMin(t) < 1440;
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  return ops.map((op) => {
    const it = byId[op.id];
    const name = it ? stripEmoji(it.title).split(' · ')[0] : '';
    if (op.op === 'add') {
      if (!hm(op.start) || !op.title) return null;
      const end = hm(op.end) && toMin(op.end) > toMin(op.start) ? op.end : clock(Math.min(1439, toMin(op.start) + 60));
      return { ...op, end, text: `추가 · ${op.start}~${end} ${op.title}` };
    }
    if (!it || isDone(it.id)) return null;
    const warn = isFixed(it) && op.op !== 'rename';
    if (op.op === 'move') {
      if (!hm(op.start)) return null;
      const len = (it.endMin || it.startMin) - it.startMin;
      const end = hm(op.end) && toMin(op.end) > toMin(op.start) ? op.end : it.end ? clock(Math.min(1439, toMin(op.start) + len)) : '';
      const d = toMin(op.start) - it.startMin;
      return { ...op, end, warn, text: `${it.start} ${name} → ${op.start}${end ? `~${end}` : ''}${d ? ` (${d > 0 ? `${formatLeft(d)} 늦게` : `${formatLeft(-d)} 일찍`})` : ''}${warn ? ' · 고정 일정' : ''}` };
    }
    if (op.op === 'skip') return { ...op, warn, text: `건너뛰기 · ${it.start} ${name}${warn ? ' · 고정 일정' : ''}` };
    if (op.op === 'unskip') return { ...op, text: `다시 넣기 · ${it.start} ${name}` };
    if (op.op === 'rename' && op.title) return { ...op, text: `이름 바꾸기 · ${name} → ${op.title}` };
    if (op.op === 'releg') return isLegRow(it) && !isFixed(it) ? { ...op, text: `이동 다시 계산 · ${it.start} ${name} → 지금 앞뒤 일정 기준(구글 경로)` } : null;
    return null;
  }).filter(Boolean);
}
// Apply an option through the same records the edit form writes, with one undo for all of it.
function aiPlanApply(i) {
  const o = state.aiPlan?.options[i];
  if (!o) return;
  const date = state.aiPlan.date;
  const undo = {};
  const keep = (id) => { if (!(id in undo)) undo[id] = store.get('edit:' + id, null); };
  for (const op of o.ops) {
    if (op.op === 'add') {
      const id = uid('my-it');
      const p = op.place && allPlaces().find((x) => x.name === op.place);
      undo[id] = 'new';
      store.set('myitems', [...store.get('myitems', []), { id, date, start: op.start, end: op.end, title: op.title, icon: p ? CAT_ICON[p.cat] : PLAN_KIND[op.kind] || '📍', ...(p ? { placeId: p.id, place: { nameJa: p.name, query: p.name } } : {}) }]);
      continue;
    }
    keep(op.id);
    const old = store.get('edit:' + op.id, null) || {};
    if (op.op === 'move') store.set('edit:' + op.id, { ...old, start: op.start, ...(op.end ? { end: op.end } : {}), auto: true });
    if (op.op === 'skip') store.set('edit:' + op.id, { ...old, skip: true });
    if (op.op === 'unskip') store.set('edit:' + op.id, { ...old, skip: false });
    if (op.op === 'rename') store.set('edit:' + op.id, { ...old, title: op.title });
    if (op.op === 'releg') {
      delete undo[op.id];
      for (const [k, v] of Object.entries(relegMove(op.id, { silent: true }) || {})) if (!(k in undo)) undo[k] = v;
      if (undo.__hotel) { state.aiHotelUndo = undo.__hotel; delete undo.__hotel; }
    }
  }
  state.aiPlan = null;
  const hotelUndo = state.aiHotelUndo; state.aiHotelUndo = null;
  closeSheet(); render();
  toast(`${o.title} · 적용했어요`, () => {
    for (const [k, v] of Object.entries(undo)) {
      if (v === 'new') { forget('myitems:' + k); store.set('myitems', store.get('myitems', []).filter((x) => x.id !== k)); }
      else store.set('edit:' + k, v);
    }
    if (hotelUndo) hotelUndo();
    render();
  }, '되돌리기');
}

// ⑥ The day in a few warm lines: where we went, what we thought, what we spent, the weather.
const DIARY_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'text'], properties: { title: { type: 'string' }, text: { type: 'string' } } };
async function aiDiary(date, btn) {
  const day = dayOf(date);
  const items = dayItems(day);
  const visits = items.map((it) => [it, placeOfItem(it.id)]).filter(([, pl]) => pl).map(([it, pl]) => { const v = visitOf(pl.id); return { name: pl.name, time: it.start, done: isDone(it.id), skipped: !!it.skip, rating: v?.again ? AGAIN[v.again] : '', memo: v?.memo || '' }; });
  const spent = expenses().filter((e) => e.date === date);
  const facts = {
    date: dayLabel(date), title: stripEmoji(day.title), weather: wxStory(date)?.head || '',
    stops: items.filter((it) => !isMove(it)).map((it) => ({ time: it.start, title: stripEmoji(it.title), done: isDone(it.id), skipped: !!it.skip })),
    visits, spent: { total: Math.round(spent.reduce((a, e) => a + e.amount, 0)), by: Object.entries(spent.reduce((m, e) => ({ ...m, [e.cat]: (m[e.cat] || 0) + e.amount }), {})).map(([c, n]) => `${c} ${Math.round(n)}엔`) },
    gear: gearText(gearLog(date, meId())),
  };
  const wait = document.createElement('div');
  wait.innerHTML = aiLoading('AI가 오늘 기록을 정리하고 있어요', ['방문한 곳과 평가를 모으는 중', '지출과 날씨를 정리하는 중', '일기를 쓰는 중']);
  btn.replaceWith(wait);
  try {
    const r = await aiAsk({
      system: 'Write a short, warm Korean travel diary entry (5-8 sentences, plain prose, no emoji, no lists) for a couple\'s day in Tokyo from the given facts. Mention the places they actually went, their ratings and memos, the weather in a phrase, and spending in one light sentence. Don\'t invent events. title: a short Korean title for the day.',
      schema: DIARY_SCHEMA, content: [{ type: 'text', text: JSON.stringify(facts) }],
    });
    store.set('diary:' + date, { title: r.title, text: r.text, at: Date.now() });
    render();
  } catch (e) { toast(e.message); render(); }
}
// ⑦ The whole trip as a short story, plus tips for next time, from the same records the report uses.
// Kept under diary:trip, so it syncs to the other phone like the daily entries.
const TRIP_STORY_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'text', 'tips'], properties: {
  title: { type: 'string' }, text: { type: 'string', description: 'Korean prose, 3-4 short paragraphs separated by a blank line' },
  tips: { type: 'array', items: { type: 'string' }, description: '3-5 short Korean tips for the next trip, each from what actually happened' } } };
async function aiTripStory(btn) {
  const { trip, days } = state.trip;
  const exp = expenses();
  const facts = {
    trip: trip.title, dates: `${dayLabel(trip.start)} ~ ${dayLabel(trip.end)}`, travelers: travelers(),
    days: days.map((d, i) => {
      const items = dayItems(d).filter((it) => !isMove(it));
      const visits = items.filter((it) => isDone(it.id)).map((it) => [it, placeOfItem(it.id)]).filter(([, p]) => p)
        .map(([, p]) => { const v = visitOf(p.id); return { name: p.name, rating: v?.again ? AGAIN[v.again] : '', memo: v?.memo || '' }; });
      const diary = store.get('diary:' + d.date, null);
      return { day: i + 1, date: dayLabel(d.date), title: stripEmoji(d.title), weather: wxStory(d.date)?.head || '',
        visits, skipped: items.filter((it) => it.skip).map((it) => stripEmoji(it.title)), spent: Math.round(exp.filter((e) => e.date === d.date).reduce((a, e) => a + e.amount, 0)),
        clothes: mates().map((p) => gearLog(d.date, p.id)?.coat).filter(Boolean), memos: mates().map((p) => gearLog(d.date, p.id)?.memo).filter(Boolean), diary: diary ? diary.text : '' };
    }),
    spent: { total: Math.round(exp.reduce((a, e) => a + e.amount, 0)), by: Object.entries(exp.reduce((m, e) => ({ ...m, [e.cat]: (m[e.cat] || 0) + e.amount }), {})).map(([c, n]) => `${c} ${Math.round(n)}엔`) },
    budget: store.get('budget', state.trip.budget?.yen || 0),
  };
  const wait = document.createElement('div');
  wait.innerHTML = aiLoading('AI가 여행기를 쓰고 있어요', ['5일 동안의 기록을 모으는 중', '좋았던 곳과 바뀐 일정을 살피는 중', '여행기를 쓰는 중', '다음 여행 팁을 고르는 중']);
  btn.replaceWith(wait);
  try {
    const r = await aiAsk({
      system: 'Write a short, warm Korean travel story for a couple\'s whole trip from the given facts: 3-4 short paragraphs (about 12-16 sentences in all), plain prose, no emoji, no lists, no headings. Follow the days in order, name the places they actually went and how they rated them, mention the weather and changed plans lightly, and spending in one sentence. Use the daily diary entries and memos where they exist. Don\'t invent events or numbers. title: a short Korean title for the trip. tips: 3-5 short, concrete tips for their next trip drawn only from what happened (skipped stops, weather and clothes, spending against budget, places worth returning to).',
      schema: TRIP_STORY_SCHEMA, effort: 'medium', content: [{ type: 'text', text: JSON.stringify(facts) }],
    });
    store.set('diary:trip', { title: r.title, text: r.text, tips: r.tips || [], at: Date.now() });
    render();
  } catch (e) { toast(e.message); render(); }
}
function reportStory() {
  const d = store.get('diary:trip', null);
  const body = d
    ? `${aiTag('AI가 쓴 여행기')}<b class="rp-story-t">${esc(d.title)}</b>
      ${String(d.text).split(/\n\s*\n/).map((x) => `<p class="rp-story-p">${esc(x.trim())}</p>`).join('')}
      ${d.tips?.length ? `<div class="rp-sub">다음 여행 팁</div><ul class="rp-tips">${d.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="btns"><button class="btn" data-diary-share="trip">${icon('ext')}공유·복사</button><button class="btn ai" data-ai-trip-story>${aiLabel('다시 쓰기')}</button></div>`
    : aiKey()
      ? `<button class="btn ai primary wide" data-ai-trip-story>${aiLabel('여행기 쓰기')}</button><div class="small muted">5일 동안의 방문·평가·메모·지출·날씨와 하루 기록으로 짧은 여행기와 다음 여행 팁을 써요. 쓰고 나면 다른 폰에도 동기화돼요.</div>`
      : `<div class="small muted">AI 키를 넣으면 5일 동안의 기록으로 여행기와 다음 여행 팁을 써 드려요.</div><button class="btn wide" data-settings>${icon('gear')}설정 › AI 도우미</button>`;
  return `
    <div class="section-title"><span>여행기</span></div>
    <div class="card rp-card rp-story">${body}</div>`;
}
const diaryCard = (date) => {
  const d = store.get('diary:' + date, null);
  if (!d) return aiKey() ? `<button class="day-sum-row ai" data-ai-diary="${esc(date)}">${aiBadge()}<span class="grow"><b>오늘 기록 정리하기</b><small>방문·평가·지출·날씨로 짧은 여행 일기를 만들어요 (AI)</small></span></button>` : '';
  return `<div class="diary">${aiTag('AI가 쓴 하루 기록')}<b>${esc(d.title)}</b><p>${esc(d.text)}</p>
    <div class="btns"><button class="btn" data-diary-share="${esc(date)}">${icon('ext')}공유·복사</button><button class="btn ai" data-ai-diary="${esc(date)}">${aiLabel('다시 쓰기')}</button></div></div>`;
};


// ---------- 개선 요청: requests go to a private GitHub repo, where Claude in the cloud fixes and deploys ----------
// The token lives in localStorage under 'deskKey' (not synced). It only needs Contents and Issues on woo72da/tokyo-trip-desk.
const DESK = 'woo72da/tokyo-trip-desk';
const deskKey = () => store.get('deskKey', '');
// The last few errors on this phone, sent along so the fix can start from them.
const errLog = [];
window.addEventListener('error', (e) => { errLog.push(`${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`); errLog.splice(0, errLog.length - 8); });
window.addEventListener('unhandledrejection', (e) => { errLog.push(`promise: ${e.reason?.message || e.reason}`); errLog.splice(0, errLog.length - 8); });
async function ghApi(path, { method = 'GET', body } = {}) {
  if (!navigator.onLine) throw new Error('인터넷이 연결되어 있지 않아요.');
  let res;
  try {
    res = await fetch(`https://api.github.com/${path}`, { method, headers: { Authorization: `Bearer ${deskKey()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('GitHub에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.'); }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 401) throw new Error('요청함 토큰이 맞지 않거나 만료됐어요. 설정 › AI 도우미 › 개선 요청함에서 확인해 주세요.');
  if (res.status === 403 || res.status === 404) throw new Error('토큰에 tokyo-trip-desk 저장소의 Contents·Issues 쓰기 권한이 있는지 확인해 주세요.');
  if (res.status === 422 && /too large|size/i.test(data.message || '')) throw new Error('파일이 너무 커요. 영상은 20초 이내로 찍어 주세요.');
  throw new Error(`GitHub 오류 (${res.status}) ${data.message || ''}`.trim());
}
const fileB64 = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
// Where the traveler was when they asked, so the fix starts in the right place.
function reqContext() {
  const now = tokyoNow();
  const day = state.trip.days[state.dayIndex];
  const sheet = !$('#sheet').hidden ? ($('#sheet-body h3')?.textContent || $('#sheet-body .eyebrow')?.textContent || '열린 화면') : '';
  return { version: APP_VERSION, tab: { today: '오늘', days: '일정', explore: '탐색', wallet: '예약', talk: '번역', check: '체크' }[state.tab] || state.tab, day: day ? `${state.dayIndex + 1}일차 ${day.date}` : '', sheet, tokyo: `${now.date} ${clock(now.min)}`, who: myNick(), device: navigator.userAgent.replace(/\s*\(KHTML[^)]*\)/, '').slice(0, 120), errors: errLog.slice(-5) };
}
const REQ_STATUS = (labels) => { const n = labels.map((l) => l.name); return n.includes('working') ? ['work', '처리 중'] : n.includes('needs-confirm') ? ['ask', '확인 필요'] : n.includes('done') ? ['done', '반영됨'] : ['new', '접수됨']; };
function openReq(view = 'new') {
  if (view === 'new') state.reqCtx = reqContext();
  state.reqFiles = view === 'new' ? [] : state.reqFiles || [];
  const ctx = state.reqCtx || reqContext();
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>개선 요청</h3></div>
    <div class="exp-tabs req-tabs"><button class="seg ${view === 'new' ? 'on' : ''}" data-req-view="new">새 요청</button><button class="seg ${view === 'list' ? 'on' : ''}" data-req-view="list">내 요청</button></div>
    ${view === 'new' ? `
      <textarea class="input ai-ask" id="req-text" rows="4" placeholder="무엇이 이상한지, 어떻게 바뀌면 좋을지 적거나 🎤로 말해 주세요"></textarea>
      <div class="req-files" id="req-files"></div>
      <div class="btns"><button class="btn" data-req-attach>${icon('camera')}캡처·영상 첨부</button><button class="btn ai primary" data-req-send>${aiLabel('보내기')}</button></div>
      <div class="small muted req-ctx">함께 보내는 정보: v${ctx.version} · ${esc(ctx.tab)} 탭${ctx.day ? ` · ${esc(ctx.day)}` : ''}${ctx.sheet ? ` · ${esc(ctx.sheet)}` : ''} · ${esc(ctx.tokyo)}${ctx.errors.length ? ` · 최근 오류 ${ctx.errors.length}건` : ''}</div>
      <div class="small muted">화면 캡처는 아이폰 측면 버튼 + 볼륨 위 버튼, 영상은 제어 센터의 화면 기록으로 찍은 뒤 첨부하세요. 보통 5~15분 안에 반영되고, 결과는 '내 요청'에서 볼 수 있어요.</div>
      <div id="req-out"></div>` : '<div id="req-list"><div class="ai-wait">불러오는 중…</div></div>'}`;
  $('#sheet').hidden = false;
  if (view === 'list') loadReqs();
}
function drawReqFiles() {
  $('#req-files').innerHTML = state.reqFiles.map((f, i) => `<span class="req-file">${f.type.startsWith('video') ? `${icon('video')}<i>영상 ${Math.round(f.size / 1e6)}MB</i>` : `<img src="${URL.createObjectURL(f)}" alt="">`}<button type="button" data-req-unattach="${i}" aria-label="빼기">${icon('x')}</button></span>`).join('');
}
function attachReq() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*,video/*'; inp.multiple = true; inp.hidden = true;
  inp.onchange = () => {
    for (const f of inp.files) {
      if (f.type.startsWith('video') && f.size > 25e6) { toast('영상이 너무 커요. 20초 이내로 다시 찍어 주세요'); continue; }
      if (state.reqFiles.length < 6) state.reqFiles.push(f);
    }
    inp.remove(); drawReqFiles();
  };
  document.body.appendChild(inp); inp.click();
}
async function sendReq(btn) {
  const text = $('#req-text').value.trim();
  if (!text && !state.reqFiles.length) return toast('내용을 적거나 캡처를 첨부해 주세요');
  const rid = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '') + Math.random().toString(36).slice(2, 5);
  const out = $('#req-out');
  btn.disabled = true;
  try {
    const paths = [];
    for (const [i, f] of state.reqFiles.entries()) {
      out.innerHTML = aiLoading(`첨부 올리는 중 ${i + 1}/${state.reqFiles.length}`, [], true);
      const blob = f.type.startsWith('image') ? await shrink(f) : f;
      const ext = f.type.startsWith('image') ? 'jpg' : (f.name.split('.').pop() || 'mp4').toLowerCase();
      const path = `requests/${rid}/${i + 1}.${ext}`;
      await ghApi(`repos/${DESK}/contents/${path}`, { method: 'PUT', body: { message: `요청 ${rid} 첨부 ${i + 1}`, content: await fileB64(blob) } });
      paths.push(path);
    }
    out.innerHTML = aiLoading('요청 보내는 중', [], true);
    const ctx = state.reqCtx || reqContext();
    const title = (text.split('\n')[0] || '캡처로 보낸 요청').slice(0, 60);
    const body = `${text || '(내용 없이 캡처만 보냄)'}\n\n---\n**첨부 폴더:** \`requests/${rid}/\`${paths.length ? `\n${paths.map((x) => `- \`${x}\``).join('\n')}` : ' (없음)'}\n\n**보낸 곳:**\n\`\`\`json\n${JSON.stringify(ctx, null, 1)}\n\`\`\``;
    const issue = await ghApi(`repos/${DESK}/issues`, { method: 'POST', body: { title, body, labels: ['ai-fix'] } });
    store.set('reqLast', issue.number);
    state.reqFiles = [];
    toast('요청을 보냈어요. 처리 상태는 내 요청에서 볼 수 있어요');
    openReq('list');
  } catch (e) { out.innerHTML = aiFail(e.message); btn.disabled = false; }
}
async function loadReqs() {
  const box = $('#req-list');
  try {
    const list = await ghApi(`repos/${DESK}/issues?state=all&labels=ai-fix&per_page=15&sort=created`);
    box.innerHTML = list.length ? list.map((x) => { const [k, t] = REQ_STATUS(x.labels); return `
      <button class="req-row" data-req-open-one="${x.number}"><span class="req-st ${k}">${t}</span><span class="grow"><b>${esc(x.title)}</b><small>#${x.number} · ${esc(new Date(x.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${x.comments ? ` · 답글 ${x.comments}` : ''}</small></span></button>`; }).join('')
      : '<div class="small muted">아직 보낸 요청이 없어요.</div>';
    box.insertAdjacentHTML('beforeend', '<button class="link req-refresh" data-req-view="list">새로 고침</button>');
  } catch (e) { box.innerHTML = aiFail(e.message); }
}
async function openReqOne(n) {
  $('#sheet-body').innerHTML = `<div class="sheet-head has-back"><button class="sheet-back" data-req-view="list">‹ 내 요청</button></div><div id="req-one"><div class="ai-wait">불러오는 중…</div></div>`;
  try {
    const [x, cs] = await Promise.all([ghApi(`repos/${DESK}/issues/${n}`), ghApi(`repos/${DESK}/issues/${n}/comments?per_page=30`)]);
    const [k, t] = REQ_STATUS(x.labels);
    const mine = (x.body || '').split('\n---\n')[0];
    $('#req-one').innerHTML = `
      <div class="sheet-head"><h3>${esc(x.title)}</h3></div>
      <span class="req-st ${k}">${t}</span>
      <div class="req-msg me"><small>보낸 내용</small><p>${esc(mine)}</p></div>
      ${cs.map((c) => `<div class="req-msg ${c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login || '') ? 'bot' : 'me'}"><small>${c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login || '') ? 'Claude' : '나'} · ${esc(new Date(c.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }))}</small><p>${esc(c.body)}</p></div>`).join('')}
      ${k === 'work' ? '<div class="ai-wait">Claude가 처리하는 중이에요. 잠시 뒤 새로 고쳐 보세요.</div>' : ''}
      <textarea class="input ai-ask" id="req-reply" rows="2" placeholder="${k === 'ask' ? '질문에 답하면 이어서 처리해요' : '추가로 고칠 점이나 의견을 적어 주세요'}"></textarea>
      <div class="btns"><button class="btn" data-req-open-one="${n}">${icon('refresh')}새로 고침</button><button class="btn primary" data-req-reply="${n}">${icon('check')}답하기</button></div>
      ${k === 'done' ? `<button class="btn wide" data-req-undo="${n}">이 변경 되돌려 달라고 요청</button>` : ''}`;
  } catch (e) { $('#req-one').innerHTML = aiFail(e.message); }
}
async function replyReq(n, text) {
  if (!text) return toast('내용을 적어 주세요');
  try { await ghApi(`repos/${DESK}/issues/${n}/comments`, { method: 'POST', body: { body: text } }); toast('답을 보냈어요. 이어서 처리해요'); openReqOne(n); }
  catch (e) { toast(e.message); }
}
// The request button now sits beside the version line at the bottom of 오늘; drop the old floating one.
function syncReqFab() { $('#req-fab')?.remove(); }

// 설정 › AI 도우미: Claude key and model, and the Google Places key.
function aiSettings() {
  const key = aiKey();
  const own = aiOwn();
  const pick = store.get('aiModel', 'opus');
  return `
    <div class="card ai-set">
      <div class="ai-hello">${aiChar(key ? 'main' : 'thinking')}<span><b>${key ? '여행 준비부터 오늘 기록까지 함께해요' : 'Claude 키를 넣으면 도와드릴게요'}</b><small>말로 일정 바꾸기 · 사진 읽기 · 장소 찾기 · 기록 쓰기</small></span></div>
      <div class="small muted">구글지도 링크를 붙여 넣으면 장소 정보를 찾아 일정에 바로 넣어요. 본인 Claude API 키가 필요하고, 키는 이 폰에만 저장돼요 (동기화·GitHub에 안 올라가요).</div>
      ${aiSrv() ? `
        <div class="ai-on">${icon('check')}<span class="grow"><b>서버 키로 쓰는 중</b><small>로그인해 두면 이 폰엔 키가 없어도 돼요${own ? ' · 이 폰에 넣은 키는 쓰지 않아요' : ''}</small></span>
          <button class="btn" data-ai-test ${state.aiTest?.busy ? 'disabled' : ''}>${state.aiTest?.busy ? '확인 중…' : '연결 확인'}</button>${own ? '<button class="btn danger key-del" data-ai-forget aria-label="이 폰의 API 키 삭제">삭제</button>' : ''}</div>
        ${state.aiTest?.msg ? `<div class="ai-msg ${state.aiTest.ok ? 'ok' : ''}">${esc(state.aiTest.msg)}</div>` : ''}` : key ? `
        <div class="ai-on">${icon('check')}<span class="grow"><b>키 저장됨</b><small>키 끝자리 ••••${esc(key.slice(-4))}</small></span>
          <button class="btn" data-ai-test ${state.aiTest?.busy ? 'disabled' : ''}>${state.aiTest?.busy ? '확인 중…' : '연결 확인'}</button><button class="btn danger key-del" data-ai-forget aria-label="API 키 삭제">삭제</button></div>
        ${state.aiTest?.msg ? `<div class="ai-msg ${state.aiTest.ok ? 'ok' : ''}">${esc(state.aiTest.msg)}</div>` : ''}` : `
        <input class="input" id="ai-key" type="password" autocomplete="off" placeholder="sk-ant-로 시작하는 API 키">`}
      <label class="field"><span>모델</span><select class="input" id="ai-model">${Object.entries(AI_MODELS).map(([k, m]) => `<option value="${k}" ${k === pick ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      ${key ? '' : '<div class="btns"><button class="btn primary wide" data-ai-save>저장</button></div>'}${!aiSrv() && !key ? '<div class="small muted set-note">카카오로 로그인하면 키 없이 서버 키로 쓸 수 있어요.</div>' : ''}
      <div class="small muted ai-cost">${aiSrv() ? '한 사람이 하루 100번까지 쓸 수 있어요.' : '요청 한 번에 보통 수십 원 정도 들어요. Claude 콘솔에서 월 사용 한도를 걸어 두면 안심이에요.'}</div>
    </div>
    <div class="card ai-set g-set">
      <div class="ai-sub first">${icon('pin')}구글 장소 키 <small>Places API</small></div>
      <div class="small muted">${gSrv() ? '이름만 입력해도 구글 지도와 같은 위치·영업시간·평점·사진과 이동 경로를 서버 키로 가져와요.' : `넣으면 이름만 입력해도 구글 지도와 같은 위치·영업시간·평점·사진을 가져와요. 웹사이트 제한(woo72da.github.io)과 API 제한(Places API (New))을 걸어 두세요. 일정의 이동 시간·노선을 구글 경로로 계산하려면 같은 키에 <b>Routes API</b>도 켜고 API 제한에 추가해 주세요.`}</div>${gKey() && routeOff() ? '<div class="ai-note">이동 경로(Routes API)가 꺼져 있어 이동 시간은 직선거리로 추정해요. 구글 콘솔에서 Routes API를 켠 뒤 \'연결 확인\'을 눌러 주세요.</div>' : ''}
      ${gSrv() ? `
        <div class="ai-on">${icon('check')}<span class="grow"><b>서버 키로 쓰는 중</b><small>장소 정보·사진·이동 경로를 서버 키로 받아요</small></span>
          <button class="btn" data-g-test ${state.gTest?.busy ? 'disabled' : ''}>${state.gTest?.busy ? '확인 중…' : '연결 확인'}</button>${gOwn() ? '<button class="btn danger key-del" data-g-forget aria-label="이 폰의 구글 키 삭제">삭제</button>' : ''}</div>
        ${state.gTest?.msg ? `<div class="ai-msg ${state.gTest.ok ? 'ok' : ''}">${esc(state.gTest.msg)}</div>` : ''}` : gKey() ? `
        <div class="ai-on">${icon('check')}<span class="grow"><b>구글 키 저장됨</b><small>키 끝자리 ••••${esc(gKey().slice(-4))}</small></span>
          <button class="btn" data-g-test ${state.gTest?.busy ? 'disabled' : ''}>${state.gTest?.busy ? '확인 중…' : '연결 확인'}</button><button class="btn danger key-del" data-g-forget aria-label="구글 키 삭제">삭제</button></div>
        ${state.gTest?.msg ? `<div class="ai-msg ${state.gTest.ok ? 'ok' : ''}">${esc(state.gTest.msg)}</div>` : ''}` : `
        <input class="input" id="g-key" type="password" autocomplete="off" placeholder="AIza로 시작하는 구글 API 키">
        <div class="btns"><button class="btn wide" data-g-save>구글 키 저장</button></div>`}
    </div>`;
}

// 설정 › AI 도우미 › 개선 요청함 (AI 도우미의 하위 기능): the GitHub token for the 💬 request box.
function deskSettings() {
  return `
    <div class="card ai-set desk-set">
      <div class="ai-sub first">${aiBadge('xs')}개선 요청함 <small>클라우드 Claude</small></div>
            <div class="small muted">넣으면 오늘 탭 맨 아래 앱 버전 옆에 '앱 개선 요청' 버튼이 생겨요. 캡처·영상과 함께 요청하면 클라우드의 Claude가 검토해서 고치고 배포해요. tokyo-trip-desk 저장소에만 Contents·Issues 쓰기 권한을 준 토큰을 넣어 주세요.</div>
      ${deskKey() ? `
        <div class="ai-on">${icon('check')}<span class="grow"><b>요청함 토큰 저장됨</b><small>토큰 끝자리 ••••${esc(deskKey().slice(-4))}</small></span>
          <button class="btn" data-desk-test>연결 확인</button><button class="btn danger key-del" data-desk-forget aria-label="요청함 토큰 삭제">삭제</button></div>` : `
        <input class="input" id="desk-key" type="password" autocomplete="off" placeholder="github_pat_로 시작하는 토큰">
        <div class="btns"><button class="btn wide" data-desk-save>요청함 토큰 저장</button></div>`}
    </div>`;
}

// One place for the settings: the account (with whose phone this is), AI keys, sync and reminders, the request box, the app itself.
function settingsBody() {
  // Section titles like the rest of the app: a short bar + the title; AI 도우미 keeps its star, after the words.
  const sec = (ic, title, html, cls = '') => `<section class="set-sec ${cls}"><div class="section-title set-h"><span>${title}</span>${ic === 'spark' ? aiBadge('set') : ''}</div>${html}</section>`;
  return `
    <div class="sheet-head"><h3>설정</h3></div>
    <div class="settings">
      ${sec('id', '계정', accountCard())}
      ${sec('spark', 'AI 도우미', aiSettings() + deskSettings(), 'set-ai')}
      ${sec('refresh', '여행', cloudCard())}
      ${sec('clock', '일정 알림', geoCard() + alarmPanel())}
      ${sec('checklist', '앱 정보', `
        <div class="card set-card">
          <div class="set-row"><span class="grow"><b>앱 버전 v${APP_VERSION}</b><small>${state.latest > APP_VERSION ? `새 버전 v${state.latest}이 있어요` : state.latest === APP_VERSION ? '최신 버전이에요' : '확인 중이에요'}</small></span>
            <button class="btn ${state.latest > APP_VERSION ? 'primary' : ''}" data-update>${state.latest > APP_VERSION ? '지금 업데이트' : '다시 받기'}</button></div>
          <div class="small muted set-note">예약번호·사진은 내 계정의 여행에만 저장되고 GitHub에 올라가지 않아요. 예산과 환전 현금은 경비 칸에서 바꿔요.</div>
        </div>
        ${backupPanel()}`)}
    </div>`;
}
function openSettings(at = '') {
  $('#sheet-body').innerHTML = settingsBody();
  $('#sheet').hidden = false;
  // Bring the 여행 heading to the top of the sheet (beside the close button), not the section above it.
  if (at === 'sync' || at === 'ai') setTimeout(() => {
    const sec = $(at === 'ai' ? '#sheet-body .set-ai' : '#sheet-body .cloud-card')?.closest('.set-sec');
    const box = $('.sheet-panel');
    if (!sec || !box) return;
    box.scrollTo({ top: box.scrollTop + sec.getBoundingClientRect().top - box.getBoundingClientRect().top - 14, behavior: 'smooth' });
  }, 60);
}

function openPlaceNew() {
  state.aiFound = null;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>장소 추가</h3></div>
    ${finderHtml('pn')}
    <div id="pn-save" ${gKey() || aiKey() ? 'hidden' : ''}>
      <div class="pn-fields">
        <label class="field"><span>이름</span><input class="input" id="pn-name" maxlength="60" autocomplete="off" placeholder="예: 친구가 추천한 라멘집"></label>
        <label class="field"><span>분류</span><select class="input" id="pn-cat">${EX_CATS.filter(([k]) => k !== 'log').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field"><span>메모 (선택)</span><input class="input" id="pn-memo" maxlength="120" placeholder="추천 메뉴, 이유"></label>
      </div>
      <div class="btns"><button class="btn" data-place-create>장소만 저장</button><button class="btn primary" data-place-create="plan">저장하고 일정에 넣기</button></div>
    </div>
    ${gKey() || aiKey() ? '<button class="link pn-manual" data-pn-manual>직접 입력하기</button>' : ''}`;
  $('#sheet').hidden = false;
}
function createPlace(plan) {
  const name = $('#pn-name').value.trim();
  if (!name) return toast('이름을 입력해 주세요.');
  const found = state.aiFound;
  const memo = $('#pn-memo').value.trim();
  const place = found
    ? saveAiPlace({ ...found.pl, name, cat: $('#pn-cat').value, memo: memo || found.pl.memo }, found.url)
    : { id: uid('my'), name, cat: $('#pn-cat').value, memo };
  if (!found) store.set('myplaces', [...store.get('myplaces', []), place]);
  state.aiFound = null;
  if (plan) { closeSheet(); render(); return openPlan(place.id); }
  state.ex.cat = place.cat;
  state.ex.area = '내 장소';
  closeSheet();
  render();
  toast('내 장소에 추가했어요');
}
// Small centred popups in the app's own look, in place of the phone's grey confirm()/prompt() boxes.
// askConfirm → true/false · askText → the text, or null when cancelled.
function askBox({ title, body = '', ok = '확인', cancel = '취소', danger = false, input = null }) {
  return new Promise((resolve) => {
    let el = $('#ask');
    if (!el) { el = document.createElement('div'); el.id = 'ask'; el.className = 'ask'; document.body.appendChild(el); }
    el.innerHTML = `<div class="ask-dim"></div>
      <div class="ask-card" role="alertdialog" aria-modal="true">
        <b class="ask-t">${esc(title)}</b>${body ? `<p class="ask-s">${esc(body)}</p>` : ''}
        ${input ? `<input class="input ask-in" ${input.numeric ? 'inputmode="numeric"' : ''} value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
        <div class="ask-bs"><button type="button" class="btn" data-ask="0">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'danger primary' : 'primary'}" data-ask="1">${danger ? icon('trash') : ''}${esc(ok)}</button></div>
      </div>`;
    el.hidden = false;
    const inp = el.querySelector('.ask-in');
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const done = (v) => { el.hidden = true; resolve(v); };
    const no = () => done(input ? null : false);
    el.querySelector('.ask-dim').onclick = no;
    el.querySelector('[data-ask="0"]').onclick = no;
    el.querySelector('[data-ask="1"]').onclick = () => done(input ? inp.value : true);
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } };
  });
}
const askConfirm = (title, o = {}) => askBox({ title, ...o });
const askText = (title, value, o = {}) => askBox({ title, ok: '저장', body: o.body, input: { value, numeric: o.numeric, placeholder: o.placeholder } });

async function deletePlace(id) {
  if (!(await askConfirm('이 장소를 삭제할까요?', { body: '내 장소 목록과 이 장소의 기록이 지워져요.', ok: '삭제', danger: true }))) return;
  forget('myplaces:' + id);
  store.set('myplaces', store.get('myplaces', []).filter((p) => p.id !== id));
  closeSheet();
  render();
}

function openPlan(id) {
  const p = placeById(id);
  const { days } = state.trip;
  const today = tokyoNow().date;
  const def = days.find((d) => d.date >= today)?.date || days[0].date;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>일정에 넣기</h3></div>
    <div class="muted">${esc(p.name)}</div>
    <label class="field"><span>날짜</span><select class="input" id="pl-date">${days.map((d) => `<option value="${d.date}" ${d.date === def ? 'selected' : ''}>${esc(dayLabel(d.date))}</option>`).join('')}</select></label>
    <label class="field"><span>시작 시간</span><input class="input" id="pl-time" type="time" value="${(() => { const last = dayItems(dayOf(def)).filter((x) => !x.skip && x.endMin).pop(); return last && last.endMin + BUF < 1380 ? clock(Math.ceil((last.endMin + BUF) / 5) * 5) : '12:00'; })()}"></label>
    <div class="small muted">그날 마지막 일정이 끝나고 10분 뒤로 넣어 두었어요</div>
    <button class="btn primary wide doc-pick" data-plan-save="${esc(id)}">일정에 추가</button>`;
  $('#sheet').hidden = false;
}
function savePlan(id) {
  const p = placeById(id);
  const date = $('#pl-date').value;
  const start = $('#pl-time').value;
  if (!start) return toast('시간을 입력해 주세요.');
  store.set('myitems', [...store.get('myitems', []), { id: uid('my-it'), date, start, title: p.name, icon: CAT_ICON[p.cat], placeId: id, place: { nameJa: p.name, query: p.url ? p.name : p.name } }]);
  state.dayIndex = state.trip.days.findIndex((d) => d.date === date);
  closeSheet();
  go('days');
  toast('일정에 추가했어요');
}

// ---------- adding and changing stops ----------
const KINDS = [['🍽', '먹기'], ['☕', '카페'], ['🏛', '구경'], ['🛍', '쇼핑'], ['🚇', '이동'], ['🏨', '휴식']];
const DURS = [15, 30, 60, 90, 120];
const STAY_OPTS = [10, 15, 20, 25, 30, 35, 40, 45, 60, 75, 90, 105, 120, 150, 180, 240, 300];
const BUF = 10; // 장소 사이 여유 (분)
const fromClock = (v) => (/^\d{1,2}:\d{2}/.test(v || '') ? toMin(v) : null);

// One form for a new stop and for changing one. `opt.after` puts a new stop right after that one;
// `opt.catch` comes from "running late" and starts the stop now, or gives the stop under way 15 more minutes.
function openItemForm(id, opt = {}) {
  const it = id ? dayItems(dayOf(findItem(id).date)).find((x) => x.id === id) : null;
  const now = tokyoNow();
  const date = it?.date || opt.date;
  const list = dayItems(dayOf(date)).filter((x) => !x.skip);
  // The stop it goes after may be a skipped one, so look in the whole day.
  const prev = opt.after && dayItems(dayOf(date)).find((x) => x.id === opt.after);
  const prevEnd = prev ? prev.endMin ?? prev.startMin + 30 : null;
  const after = prev && list.find((x) => x.startMin >= prevEnd && x.id !== prev.id);
  // A new stop starts when the one before it ends and fills the free time up to the next, up to an hour;
  // with no free time it gets 30 minutes and the later stops move (the preview below shows how).
  const gap = prev ? (after?.startMin ?? 1440) - prevEnd : 0;
  const nowStart = now.date === date ? Math.ceil(now.min / 5) * 5 : 720;
  let s = it ? it.startMin : prev ? prevEnd : nowStart;
  let dur = it ? it.endMin - it.startMin : !prev ? 60 : gap >= 5 ? Math.min(60, gap) : 30;
  // 여유 시간 자동 (4.4): with room to spare, a new stop starts 10 minutes after the one before and leaves 10 before the next.
  let buffered = false;
  if (!it && prev && gap >= 40) { s = Math.ceil((prevEnd + BUF) / 5) * 5; dur = Math.min(60, (after ? after.startMin - BUF : 1440) - s); buffered = true; }
  if (opt.rest) dur = Math.min(30, Math.max(15, dur));
  const between = !it && prev ? `${stripEmoji(prev.title).split(' · ')[0]} 끝 ${clock(prevEnd)} → ${after ? `${stripEmoji(after.title).split(' · ')[0]} 시작 ${clock(after.startMin)}` : '그날 마지막'}${after ? ` · ${gap >= 5 ? `여유 ${formatLeft(gap)}` : '여유 없음, 뒤 일정이 밀려요'}` : ''}${buffered ? ' · 앞뒤로 10분씩 여유를 두었어요' : ''}` : '';
  let started = false;
  if (it && opt.catch) {
    started = isStarted(it, list);
    if (started) dur = Math.ceil((Math.max(now.min, it.endMin) + 15 - it.startMin) / 5) * 5;
    else s = now.min;
  }
  const range = it && !isMove(it) ? stayRange(it) : null;
  state.form = { id, date, s, dur, range, kind: it?.icon || (opt.rest ? '🏨' : ''), catch: !!opt.catch && !started, rip: null, fit: 'cut', mine: !it || String(id).startsWith('my-it') };
  const place = it?.place && !state.form.mine ? it.place.nameJa : it?.place?.query || '';
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>${it ? '일정 수정' : '일정 추가'}</h3></div>
    ${between ? `<div class="f-between ${gap < 5 && after ? 'tight' : ''}">${icon('clock')}<span>${esc(between)}</span></div>` : ''}
    ${opt.catch ? `<div class="small muted">${started ? '이 일정을 15분 늘리고' : '이 일정을 지금 시작으로 바꾸고'} 뒤 일정을 미뤄요. 아래 변경 내용을 확인하고 저장하세요.</div>` : ''}
    <form class="item-form" autocomplete="off">
      ${!it ? finderHtml('f') : ''}
      <label class="row-field"><span>제목</span><input class="input" id="f-title" value="${esc(it?.title || (opt.rest ? '여유 시간' : ''))}" placeholder="예: 편의점 들르기" maxlength="60"></label>
      <div class="row-field top"><span>종류</span><div class="kind-row">${KINDS.map(([e, label]) => `<button type="button" class="kind ${glyph(state.form.kind)[0] === glyph(e)[0] && state.form.kind ? 'on' : ''}" data-f-kind="${e}">${itemIcon(e)}${label}</button>`).join('')}</div></div>
      <label class="row-field"><span>날짜</span><select class="input" id="f-date">${state.trip.days.map((d, i) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${i + 1}일차 · ${esc(dayLabel(d.date))}</option>`).join('')}</select></label>
      <div class="row-field top"><span>시작</span><div>
        <input class="input" id="f-start" type="time" value="${clock(s)}" aria-label="시작">
        <div class="quick-row">
          ${now.date === date ? '<button type="button" data-f-adj="now">지금</button>' : ''}
          <button type="button" data-f-adj="-10">−10분</button><button type="button" data-f-adj="10">+10분</button><button type="button" data-f-adj="30">+30분</button>
        </div>
      </div></div>
      <div class="row-field top"><span>소요</span><div class="quick-row dur-row">${DURS.map((m) => `<button type="button" data-f-dur="${m}">${m === 90 ? '1시간 반' : formatLeft(m)}</button>`).join('')}</div></div>
      <label class="row-field"><span>종료</span><input class="input" id="f-end" type="time" value="${clock(Math.min(1439, s + dur))}"></label>
      <div class="f-sum" id="f-sum"></div>
      ${range ? `<div class="row-field top"><span>머무는<br>범위</span><div class="stay-pick">
        <label>최소 <select class="input" id="f-min">${STAY_OPTS.filter((m) => m <= Math.max(range.len, range.min)).map((m) => `<option value="${m}" ${m === range.min ? 'selected' : ''}>${formatLeft(m)}</option>`).join('')}${STAY_OPTS.includes(range.min) ? '' : `<option value="${range.min}" selected>${formatLeft(range.min)}</option>`}</select></label>
        <label>최대 <select class="input" id="f-max">${STAY_OPTS.filter((m) => m >= range.len).map((m) => `<option value="${m}" ${m === range.max ? 'selected' : ''}>${formatLeft(m)}</option>`).join('')}${STAY_OPTS.includes(range.max) ? '' : `<option value="${range.max}" selected>${formatLeft(range.max)}</option>`}</select></label>
        <small>늦어져서 줄일 때 최소까지만, '더 있을래요'는 최대를 넘으면 알려 줘요</small></div></div>` : ''}
      ${state.form.mine ? `
        <label class="row-field"><span>장소</span><input class="input" id="f-place" list="f-places" value="${esc(place)}" placeholder="선택 · 탐색 장소나 검색어"></label>
        <datalist id="f-places">${allPlaces().map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>`
    : place ? `<div class="row-field"><span>장소</span><div class="small">${esc(place)}</div></div>` : ''}
      <label class="row-field"><span>메모</span><input class="input" id="f-note" value="${esc(it?.note || '')}" maxlength="200" placeholder="선택"></label>
      <label class="lock-row"><input type="checkbox" id="f-lock" ${it && isFixed(it) ? 'checked' : ''}><span class="grow"><b>${icon('lock')}시간 고정</b><small>예약했거나 시간을 바꿀 수 없는 일정. 앞 일정이 늦어져도 밀리지 않아요.</small></span></label>
      <div id="f-ripple"></div>
      ${it && 'alarm' in it ? '<div class="small muted alarm-note">캘린더 알림은 자동으로 바뀌지 않아요.</div>' : ''}
      <div class="btns">
        <button class="btn primary" type="submit" id="f-save">${it ? '저장' : '일정에 추가'}</button>
        ${it ? `<button class="btn" type="button" data-edit-reset="${esc(id)}">원래대로</button>` : '<button class="btn" type="button" data-close>취소</button>'}
      </div>
      ${it ? `<button class="btn danger wide f-del" type="button" data-item-del="${esc(id)}">${icon('trash')}이 일정 삭제</button>` : ''}
    </form>`;
  $('#sheet').hidden = false;
  updateForm();
}

// The form's times as minutes; the summary line, the warnings and the knock-on preview follow every change.
// Moved to another day, the stop goes in there like a new one.
function formPlan() {
  const f = state.form;
  const date = $('#f-date').value;
  const same = f.id && findItem(f.id).date === date;
  const list = dayItems(dayOf(date)).filter((x) => !x.skip && (same || x.id !== f.id));
  const idx = same ? list.findIndex((x) => x.id === f.id) : -1;
  const e = Math.min(1439, f.s + f.dur);
  const base = ripple(list, idx, f.s, e);
  const cut = f.fit === 'cut' && base.walls.length ? fitCuts(list, idx, f.s, e) : null;
  return { date, list, idx, e, base, plan: cut ? ripple(list, idx, f.s, e, cut) : base };
}
function updateForm() {
  const f = state.form;
  const { date, idx, list, e, base, plan } = formPlan();
  const warn = [];
  if (e <= f.s) warn.push(['bad', '끝나는 시간이 시작보다 빨라요.']);
  if (f.s < 300) warn.push(['bad', `새벽 ${clock(f.s)}으로 되어 있어요. 낮이면 <button type="button" data-f-pm>${clock(f.s + 720)}으로 고치기</button>`]);
  const p = f.id ? placeOfItem(f.id) : null;
  const named = f.mine && allPlaces().find((x) => x.name === $('#f-place')?.value.trim());
  const spot = named || p;
  if (spot?.o && openNow(spot, { date, min: f.s }) === false) warn.push(['', `${esc(spot.name)} 영업시간이 아니에요 (${esc(placeHours(spot))}).`]);
  const it = f.id && list[idx];
  if (it?.closedDays?.includes(dowOf(date))) warn.push(['', '이 날은 휴무예요.']);
  if (it?.hard) warn.push(['', '예약·탑승 시간이 정해진 일정이에요. 예약 시간도 확인하세요.']);
  // 고정 일정 앞 20분 (4.4): ending too close to the next fixed stop leaves no room for a late train.
  const W = list.find((x, i) => i !== idx && isFixed(x) && x.startMin >= f.s && !isDone(x.id));
  if (W && !(f.id && isFixed(list[idx]))) {
    const room = W.startMin - e - (it ? travelMin(it, W) : 0);
    if (room >= 0 && room < GUARD) warn.push(['', `${esc(shortName(W))}(고정 ${esc(W.start)}) 앞 여유가 ${room}분뿐이에요 · 20분은 두는 게 좋아요.`]);
  }
  // A new stop or a changed time that lands on top of other stops says which.
  const overlaps = list.filter((x, i) => i !== idx && !isDone(x.id) && x.startMin < e && f.s < x.endMin && x.endMin - x.startMin > 0);
  $('#f-sum').innerHTML = `<b>${clock(f.s)} 시작 · ${clock(e)} 종료</b> <span>(${formatLeft(Math.max(0, e - f.s))})</span>
    ${warn.map(([c, t]) => `<div class="f-warn ${c}">${t}</div>`).join('')}`;
  $('#f-save').disabled = e <= f.s;
  document.querySelectorAll('[data-f-dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.fDur) === e - f.s));
  // What happens to the stops after it.
  const moving = plan.changes;
  const pull = plan.push < 0;
  const box = $('#f-ripple');
  if (!moving.length && !base.walls.length) {
    box.innerHTML = overlaps.length ? `<div class="f-warn">${esc(overlaps.map((x) => x.title).join(', '))}와 시간이 겹쳐요.</div>` : '';
    return;
  }
  // Pushing later is on by default; pulling earlier is offered but off.
  if (f.ripSign !== plan.push > 0) { f.ripSign = plan.push > 0; f.rip = !pull; }
  const wall = base.walls[0];
  const left = plan.walls[0]?.over || 0;
  const cut = moving.some((c) => c.cut);
  box.innerHTML = `
    <div class="rp">
      <label class="rp-toggle"><input type="checkbox" id="f-rip" ${f.rip ? 'checked' : ''}><b>뒤 일정 ${moving.length}개도 같이 ${pull ? '당기기' : '밀기'}</b></label>
      ${f.rip ? `
        <div class="rp-list">${moving.map((c) => `
          <div class="rp-row"><span class="grow">${esc(c.it.title)}</span>
            <span class="rp-t"><s>${clock(c.it.startMin)}</s> → <b>${clock(c.start)}</b>${c.cut ? ` <em>${formatLeft(c.it.endMin - c.it.startMin)} → ${formatLeft(c.end - c.start)}</em>` : ''}</span></div>`).join('')}
        </div>
        ${wall ? `
          <div class="rp-wall">${icon('lock')}<span><b>${esc(wall.it.start)} ${esc(wall.it.title)}</b>은 시간 고정이라 움직이지 않아요. 그대로 밀면 ${formatLeft(wall.over)} 겹쳐요.</span></div>
          <div class="rp-fit">
            <label><input type="radio" name="f-fit" value="cut" ${f.fit === 'cut' ? 'checked' : ''}><span>앞 일정을 줄여서 맞추기${f.fit !== 'cut' ? '' : !cut ? ' · 줄일 수 있는 일정이 없어요' : left ? ` · 그래도 ${formatLeft(left)} 겹쳐요` : ' · 딱 맞췄어요'}</span></label>
            <label><input type="radio" name="f-fit" value="keep" ${f.fit === 'keep' ? 'checked' : ''}><span>겹친 채로 두기</span></label>
          </div>
          ${!cut && f.dur - wall.over >= 10 && !(tokyoNow().date === date && f.s + f.dur - wall.over <= tokyoNow().min) ? `<button type="button" class="rp-short" data-f-dur="${f.dur - wall.over}">${icon('clock')}이 일정을 ${formatLeft(f.dur - wall.over)}만 하면 딱 맞아요</button>` : ''}` : ''}` : ''}
    </div>`;
}

async function saveItemForm() {
  const f = state.form;
  const { date, idx, e, plan } = formPlan();
  const title = $('#f-title').value.trim() || $('#f-place')?.value.trim();
  if (!title) return toast('제목을 입력해 주세요.');
  if (e <= f.s) return toast('끝나는 시간이 시작보다 늦어야 해요.');
  if (f.s < 300 && !(await askConfirm(`새벽 ${clock(f.s)}이 맞나요?`, { body: `낮이라면 ${clock(f.s + 720)}으로 고쳐 주세요.`, ok: '맞아요', cancel: '고칠게요' }))) return;
  const note = $('#f-note').value.trim();
  const lock = $('#f-lock').checked;
  const undo = {};
  const keep = (id) => { if (!(id in undo)) undo[id] = store.get('edit:' + id, null); };
  let id = f.id;
  if (id) {
    const raw = rawItem(id);
    const old = store.get('edit:' + id, null) || {};
    keep(id);
    const next = { ...old, date, start: clock(f.s), end: clock(e), title, note, icon: f.kind || raw.icon, lock };
    // Only what differs from the plan is kept, so "원래대로" and the trip file stay in step.
    for (const k of ['date', 'title', 'note', 'icon', 'start', 'end']) if ((raw[k] || '') === (next[k] || '')) delete next[k];
    if (lock === !!raw.hard) delete next.lock;
    if (f.mine) {
      const q = $('#f-place').value.trim();
      const p = allPlaces().find((x) => x.name === q);
      next.place = q ? { nameJa: p?.verified?.name || q, query: p?.verified?.name || q } : null;
      next.placeId = p?.id || null;
    }
    delete next.auto;
    store.set('edit:' + id, Object.keys(next).length ? next : null);
  } else {
    const q = $('#f-place').value.trim();
    const p = allPlaces().find((x) => x.name === q);
    id = uid('my-it');
    undo[id] = 'new';
    store.set('myitems', [...store.get('myitems', []), {
      id, date, start: clock(f.s), end: clock(e), title, icon: f.kind || (p ? CAT_ICON[p.cat] : '📍'), ...(note ? { note } : {}),
      ...(q ? { place: { nameJa: p?.verified?.name || q, query: p?.verified?.name || q } } : {}), ...(p ? { placeId: p.id } : {}), ...(lock ? { lock: true } : {}),
    }]);
  }
  let moved = 0;
  if (f.rip && (plan.changes.length)) {
    for (const c of plan.changes) {
      keep(c.it.id);
      const old = store.get('edit:' + c.it.id, null) || {};
      store.set('edit:' + c.it.id, { ...old, start: clock(c.start), ...(c.it.end || c.cut || old.end ? { end: clock(c.end) } : {}), auto: true });
      moved += 1;
    }
  }
  if (f.range && $('#f-min')) {
    const mn = Number($('#f-min').value); const mx = Number($('#f-max').value);
    if (mn !== f.range.min || mx !== f.range.max || f.range.set) store.set('stay:' + id, { min: Math.min(mn, e - f.s), max: Math.max(mx, e - f.s) });
  }
  if (f.catch) store.set('start:' + id, true);
  closeSheet();
  render();
  toast(`${f.id ? '일정을 바꿨어요' : '일정을 넣었어요'}${moved ? ` · 뒤 일정 ${moved}개 ${plan.push < 0 ? '당김' : '밀림'}` : ''}`, () => {
    for (const [k, v] of Object.entries(undo)) {
      if (v === 'new') { forget('myitems:' + k); store.set('myitems', store.get('myitems', []).filter((x) => x.id !== k)); }
      else store.set('edit:' + k, v);
    }
    if (f.catch) store.set('start:' + id, false);
    render();
  }, '되돌리기');
}

function toggleSkip(id) {
  if (isDone(id)) completeItem(id);
  const old = store.get('edit:' + id, null) || {};
  store.set('edit:' + id, { ...old, skip: !old.skip });
  closeSheet();
  render();
  // Bringing a stop back can squeeze a fixed one; the ways to fit it open right away.
  const it = findItem(id);
  // Brought back after its time has passed today (skipped in the morning, done in the afternoon): it goes in now,
  // with the same length, and the stops after it move along; the fitting opens if a fixed one is hit.
  if (old.skip && it && bringBackNow(id)) return;
  if (old.skip && it && squeezeOf(it.date, tokyoNow())) openSqueeze(it.date);
  // Skipping today leaves a hole: offer (never apply on its own) to bring the stops right after it forward.
  const pull = !old.skip && it && pullEarlier(it);
  if (pull) toast(`${shortName(it)} 건너뜀 · 다음 ${pull.length}개를 최대 ${formatLeft(Math.max(...pull.map((c) => c.it.startMin - c.start)))} 앞당길 수 있어요`, () => applyPull(pull), '앞당기기');
}
function bringBackNow(id) {
  const now = tokyoNow();
  const all = dayItems(dayOf(findItem(id).date));
  const it = all.find((x) => x.id === id);
  if (!it || now.date !== it.date || it.endMin > now.min || isFixed(it) || isDone(it.id)) return false;
  const len = Math.max(15, it.endMin - it.startMin);
  const cur = all.find((x) => x.id !== id && !x.skip && isBegun(x) && !isDone(x.id));
  const s = Math.min(1439, Math.ceil(Math.max(now.min, cur ? cur.endMin : 0) / 5) * 5);
  const e = Math.min(1439, s + len);
  const list = all.filter((x) => x.id !== id && !x.skip && !isDone(x.id) && x.startMin >= now.min - 1);
  const plan = ripple(list, -1, s, e);
  const undo = { [id]: store.get('edit:' + id, null) };
  store.set('edit:' + id, { ...(undo[id] || {}), skip: false, start: clock(s), end: clock(e), auto: true });
  for (const c of plan.changes) {
    undo[c.it.id] = store.get('edit:' + c.it.id, null);
    store.set('edit:' + c.it.id, { ...(undo[c.it.id] || {}), start: clock(c.start), ...(c.it.end || undo[c.it.id]?.end ? { end: clock(c.end) } : {}), auto: true });
  }
  render();
  toast(`${shortName(it)} 지금 ${clock(s)}로 다시 넣었어요${plan.changes.length ? ` · 뒤 일정 ${plan.changes.length}개 밀림` : ''}`, () => { for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v); render(); }, '되돌리기');
  if (squeezeOf(it.date, now)) openSqueeze(it.date);
  return true;
}
// 오늘은 여기까지: what's left today is skipped in one go and the hotel becomes the last stop, timed from where we are.
async function endDay(date) {
  const now = tokyoNow();
  if (now.date !== date) return;
  const all = dayItems(dayOf(date));
  const cur = all.find((x) => !x.skip && isBegun(x) && !isDone(x.id));
  const left = all.filter((x) => x !== cur && !x.skip && !isDone(x.id) && !x.autoHotel && !isFixed(x) && x.endMin > now.min);
  const stops = left.filter((x) => !isLegRow(x));
  if (!left.length) return toast('오늘 남은 일정이 없어요');
  if (!(await askConfirm(`남은 일정 ${stops.length}개를 건너뛰고 호텔로 돌아갈까요?`, { body: `${stops.slice(0, 3).map(shortName).join(', ')}${stops.length > 3 ? ' 등' : ''} · 건너뛴 일정은 일정 탭에서 다시 살릴 수 있어요.`, ok: '호텔로' }))) return;
  const undo = {};
  for (const x of left) { undo[x.id] = store.get('edit:' + x.id, null); store.set('edit:' + x.id, { ...(undo[x.id] || {}), skip: true }); }
  const here = (GEO.pos?.lat && GEO.pos) || legPoint(cur || all.filter((x) => isDone(x.id) && !isLegRow(x)).pop());
  const stay = state.trip.stay;
  const ride = here?.lat && stay?.lat ? (tableRoute(here, stay)?.min ?? Math.ceil(kmBetween(here, stay) * 3 + 10)) : 30;
  const at = clock(Math.min(1435, Math.ceil((Math.max(now.min, cur ? cur.endMin : now.min) + ride) / 5) * 5));
  const undoHotel = putHotelStop(date, at);
  render();
  toast(`호텔 ${at}쯤 도착 · 남은 일정 ${stops.length}개 건너뜀`, () => { for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v); undoHotel?.(); render(); }, '되돌리기');
}
// The stops that follow straight on from a skipped one (until a fixed stop, one under way, or free time),
// laid back to back from where the skipped one began, never before now.
function pullEarlier(item) {
  const now = tokyoNow();
  if (now.date !== item.date) return null;
  const all = dayItems(dayOf(item.date));
  const it = all.find((x) => x.id === item.id);
  if (!it || it.endMin <= now.min) return null;
  const items = all.filter((x) => !x.skip && x.id !== it.id);
  let prev = items.filter((x) => x.endMin <= it.startMin && !isLegRow(x)).pop() || null;
  let cur = Math.max(now.min, it.startMin);
  let lastEnd = it.endMin;
  const out = [];
  for (const x of items.filter((y) => y.startMin >= it.startMin && !isDone(y.id))) {
    if (isFixed(x) || isBegun(x) || x.startMin - lastEnd > 15) break;
    lastEnd = Math.max(lastEnd, x.endMin);
    const st = Math.max(cur + (isLegRow(x) ? 0 : travelMin(prev, x)), now.min);
    if (st >= x.startMin) break;
    out.push({ it: x, start: st, end: st + x.endMin - x.startMin });
    cur = st + x.endMin - x.startMin;
    if (!isLegRow(x)) prev = x;
  }
  return out.some((c) => !isLegRow(c.it) && c.it.startMin - c.start >= 5) ? out : null;
}
function applyPull(list) {
  const undo = {};
  for (const c of list) {
    const old = store.get('edit:' + c.it.id, null);
    undo[c.it.id] = old;
    store.set('edit:' + c.it.id, { ...(old || {}), start: clock(c.start), ...(c.it.end || old?.end ? { end: clock(c.end) } : {}), auto: true });
  }
  render();
  toast(`${list.length}개 앞당겼어요`, () => { for (const [k, v] of Object.entries(undo)) store.set('edit:' + k, v); render(); }, '되돌리기');
}
// Deleting only hides the stop, so it can come back from the day's edit mode.
function deleteItem(id) {
  const old = store.get('edit:' + id, null);
  store.set('edit:' + id, { ...old, del: true });
  closeSheet();
  render();
  toast('일정을 삭제했어요', () => { store.set('edit:' + id, old); render(); }, '되돌리기');
}
function restoreItem(id) {
  const { del, ...rest } = store.get('edit:' + id, null) || {};
  store.set('edit:' + id, Object.keys(rest).length ? rest : null);
  render();
}
// Back to the trip file's times for one day: stops the app moved and times changed by hand.
async function resetDay(date) {
  const list = effectiveItems(dayOf(date));
  if (!(await askConfirm('이날 일정 시간을 모두 원래 계획으로 되돌릴까요?', { body: '앱에서 옮긴 시간과 직접 바꾼 시간이 계획대로 돌아가요.', ok: '되돌리기' }))) return;
  for (const it of list) {
    const edit = store.get('edit:' + it.id, null);
    if (!edit) continue;
    const { start, end, auto, ...rest } = edit;
    store.set('edit:' + it.id, Object.keys(rest).length ? rest : null);
  }
  render();
  toast('원래 계획 시간으로 되돌렸어요');
}

function toggleSave(id) {
  store.set('save:' + id, !isSaved(id));
  render();
  if (!$('#sheet').hidden) openPlace(id);
}
const rateBtns = (id, again, from) => Object.entries(AGAIN).map(([k, label]) => `<button type="button" class="btn rate-${k} ${again === k ? 'primary' : ''}" data-rate="${esc(id)}" data-again="${k}" data-from="${from}">${againIcon(k)}${label}</button>`).join('');

// Done is saved on the first tap, so closing the sheet midway never loses the visit.
function completeItem(id) {
  const p = placeOfItem(id);
  if (findItem(id)?.skip) store.set('edit:' + id, { ...store.get('edit:' + id, null), skip: false });
  if (isDone(id)) {
    setDone(id, false);
    const v = p && visitOf(p.id);
    if (v && !v.again && !v.memo) store.set('visit:' + p.id, null);
    closeSheet();
    return render();
  }
  setDone(id, true);
  if (p && !visitOf(p.id)) store.set('visit:' + p.id, { at: Date.now(), by: meId(), memo: '', again: '' });
  render();
  openFinish(id);
}
function openFinish(id) {
  const it = findItem(id);
  const p = placeOfItem(id);
  const money = it.place && it.place.lang !== 'ko';
  if (!money && !p) return closeSheet();
  const v = p && visitOf(p.id);
  const spent = expenses().filter((e) => e.item === id);
  const next = nextStop(it);
  $('#sheet-body').innerHTML = `
    ${placeHero(p)}
    <div class="eyebrow dark">${doneLabel(it)}</div>
    <div class="sheet-head"><h3>${esc(p?.name || stripEmoji(it.title).split(' · ').pop())}</h3></div>
    <form class="finish" data-exp-item="${esc(id)}">
      ${money ? `
        <label class="finish-label" for="finish-amount">쓴 돈${spent.length ? ` · ${yen(spent.reduce((a, e) => a + e.amount, 0))}` : ''}</label>
        <input class="input amount" id="finish-amount" name="amount" inputmode="numeric" placeholder="${spent.length ? '추가 금액 (엔)' : '금액 (엔)'}" autocomplete="off">
        <div class="finish-pay">${expPick()}</div>
        ${spent.map(expRow).join('')}` : ''}
      ${p ? `
        <div class="finish-label">다시 갈 만한가요?</div>
        <div class="rate-row">${rateBtns(p.id, v?.again, 'finish')}</div>
        <label class="finish-label" for="finish-memo">한 줄 메모</label>
        <input class="input" id="finish-memo" data-place-memo="${esc(p.id)}" maxlength="300" placeholder="선택 입력" value="${esc(v?.memo || '')}" autocomplete="off">` : ''}
      <button class="btn primary finish-go" type="submit">${next ? `저장하고 다음: ${esc(next.title.split(' · ').pop())}` : '저장'}</button>
    </form>`;
  $('#sheet').hidden = false;
}
function setAgain(id, val, from) {
  const v = visitOf(id);
  const again = v?.again === val ? '' : val;
  store.set('visit:' + id, { at: v?.at || Date.now(), by: v?.by || meId(), memo: v?.memo || '', again });
  render();
  if (from === 'place') return openPlace(id);
  document.querySelectorAll('.finish [data-rate]').forEach((b) => b.classList.toggle('primary', b.dataset.again === again));
}

function toggleVisit(id) {
  const v = visitOf(id);
  store.set('visit:' + id, v ? null : { at: Date.now(), by: meId(), memo: '' });
  render();
  openPlace(id);
}

// ---------- docs ----------
const thumbUrls = [];
async function hydrateDocs() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  for (const slot of allDocs()) {
    const el = document.querySelector(`[data-doc="${CSS.escape(slot.id)}"]`);
    let keys = [];
    try { keys = await docs.of(slot.id); } catch { return; }
    if (!el || !keys.length) continue;
    const url = URL.createObjectURL(await docs.get(keys[0]));
    thumbUrls.push(url);
    const max = slot.max || 1;
    el.classList.add('has');
    el.querySelector('.doc-thumb').style.backgroundImage = `url("${url}")`;
    const count = el.querySelector('.doc-count');
    count.hidden = keys.length < 2;
    count.textContent = keys.length;
    el.querySelector('[data-doc-add]').textContent = max === 1 ? '교체' : keys.length >= max ? '가득 참' : '추가';
    el.querySelector('[data-doc-add]').disabled = max > 1 && keys.length >= max;
    el.querySelector('.doc-max').textContent = slot.custom ? `${keys.length}장` : max === 1 ? '1장' : `${keys.length} / ${max}장`;
  }
}

// Fixed slots from trip.json plus the titled sets added on the phones.
const CDOC_MAX = 30;
const allDocs = () => [
  ...state.trip.docs,
  ...store.get('cdocs', []).map((c) => ({ id: c.id, label: c.title, icon: '📎', max: CDOC_MAX, custom: true })),
];

// Place photos use the same store under a per-place slot, so they sync like any other photo.
const docSlot = (id) => {
  const place = id?.startsWith?.('place-') && placeById(id.slice(6));
  if (place) return { id, label: place.name, icon: '📎', max: 20 };
  const e = id?.startsWith?.('rcpt-') && expenses().find((x) => x.id === id.slice(5));
  return e ? { id, label: `영수증 · ${expTitle(e)}`, icon: '📎', max: 5, receipt: true } : allDocs().find((s) => s.id === id);
};

// Store a picked photo: single-photo slots replace, others append up to their limit.
const slotOf = (key) => key.split('#')[0];
async function refreshDocSlots() {
  try { state.docSlots = new Set((await docs.keys()).map(slotOf)); } catch { /* ignore */ }
  state.syncFile = null;
  // Photos from the old 기타 slot become an added set under the same id.
  const cdocs = store.get('cdocs', []);
  if (state.docSlots?.has('doc-etc') && !cdocs.some((c) => c.id === 'doc-etc')) store.set('cdocs', [...cdocs, { id: 'doc-etc', title: '기타' }]);
}

async function addDoc(slotId, file) {
  const slot = docSlot(slotId);
  const max = slot?.max || 1;
  const keys = await docs.of(slotId);
  if (max === 1) for (const k of keys) await docs.del(k);
  else if (keys.length >= max) { toast(`${slot.label}은 ${max}장까지 넣을 수 있어요.`); return false; }
  await docs.put(`${slotId}#${uid('')}`, await shrink(file));
  await refreshDocSlots();
  return true;
}

// Open the photo picker for a slot, or for a new set when a title is given.
function pickPhotos(slotId, title = null) {
  state.pendingDoc = slotId;
  state.pendingTitle = title;
  $('#doc-file').click();
}

function openDocNew() {
  $('#sheet-body').innerHTML = `
    <div class="sheet-head">${itemIcon('📎', 'lg')}<h3>바우처·자료 추가</h3></div>
    <label class="field"><span>제목</span>
      <input class="input" id="doc-title" maxlength="20" placeholder="예: 여행자보험 증권" autocomplete="off"></label>
    <button class="btn primary doc-pick" data-doc-pick>${icon('image')}사진 선택 (여러 장 가능)</button>`;
  $('#sheet').hidden = false;
}

// Buttons that open the photos an item needs (tickets at the airport, QR at immigration, voucher at check-in).
const docLabel = (slotId) => (docSlot(slotId)?.label || '').replace(/ \(2인\)$/, '');
const docBtns = (it, cls = 'btn') => (it.docs || []).map((slotId) => {
  const slot = docSlot(slotId);
  const has = state.docSlots.has(slotId);
  return `<button class="${cls} ${has ? 'has' : 'missing'}" data-doc-view="${esc(slotId)}">${itemIcon(slot?.icon, 'inline')}${esc(docLabel(slotId))}${has ? '' : ' · 추가'}</button>`;
}).join('');

// Full-screen viewer for every photo in a slot; swipe sideways between them.
const viewerUrls = [];
async function viewDoc(id) {
  const slot = docSlot(id);
  let keys = [];
  try { keys = await docs.of(id); } catch { /* ignore */ }
  if (!keys.length) {
    toast(`${slot?.label || '자료'} 사진이 아직 없어요. 예약 탭의 바우처·자료에서 추가하세요.`);
    if (state.tab === 'wallet') document.querySelector(`[data-doc="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  viewerUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const track = $('#viewer-track');
  track.innerHTML = '';
  for (const k of keys) {
    const url = URL.createObjectURL(await docs.get(k));
    viewerUrls.push(url);
    track.insertAdjacentHTML('beforeend', `<figure data-key="${esc(k)}"><img src="${url}" alt=""></figure>`);
  }
  track.scrollLeft = 0;
  state.viewer = { slot: id, keys };
  updateViewerCap();
  $('#viewer').hidden = false;
}
function viewerIndex() {
  const t = $('#viewer-track');
  return Math.round(t.scrollLeft / Math.max(1, t.clientWidth));
}
function updateViewerCap() {
  const slot = docSlot(state.viewer.slot);
  const n = state.viewer.keys.length;
  $('#viewer-cap').textContent = `${slot?.label || ''}${n > 1 ? ` · ${viewerIndex() + 1} / ${n}` : ''}${slot?.receipt ? '' : ' · QR은 화면 밝기를 올려 보여주세요'}`;
}

// The most used way out of the app, so it reads at a glance: red pin, bold label, what Google Maps adds.
const mapBtn = (url, label = '구글지도에서 보기') => `
  <a class="map-btn" href="${esc(url)}" target="_blank" rel="noopener">
    <span class="map-pin">${icon('pin')}</span>
    <span class="grow"><b>${esc(label)}</b><small>리뷰·사진·영업시간·팁</small></span>
    ${icon('ext')}
  </a>`;

// ---------- sheet & big japanese ----------
// Saved Google Maps facts for a stop, so they still open offline.
const INFO_BEST = { food: '추천 메뉴', cafe: '추천', sight: '볼거리', shop: '볼거리' };
const infoBadge = (it) => {
  const f = it.info;
  if (!f) return '';
  const parts = [f.r ? `★${f.r.toFixed(1)}` : '', f.wait ? `대기 ${f.wait}` : ''].filter(Boolean);
  return parts.length ? `<div class="tl-rate">${parts.join(' · ')}</div>` : '';
};
function infoCard(it) {
  const f = it.info;
  if (!f) return it.note ? `<div class="card note">${esc(it.note)}</div>` : '';
  const facts = [['영업', f.hours], ['휴무', f.closed], ['가격', f.price], ['대기', f.wait], ['예약', f.reserve], ['결제', f.pay]].filter(([, v]) => v);
  return `
    <div class="card info">
      ${f.r ? `<div class="info-rate"><b>★ ${f.r.toFixed(1)}</b><span>구글지도 ${esc(f.asOf ? shortDate(f.asOf) : state.trip.trip.infoAsOf || '')} · 리뷰 ${esc(f.n)}${f.recent ? ` · 최근 평균 ${f.recent.toFixed(1)}` : ''}</span></div>` : ''}
      ${f.ko ? `<div class="small muted info-ko">${/^최근/.test(f.ko) ? '' : '한국어 리뷰 '}${esc(f.ko)}</div>` : ''}
      ${facts.length ? `<dl class="info-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${f.best?.length ? `<div class="info-sec"><h4>${INFO_BEST[f.kind] || '볼거리'}</h4><div class="info-tags">${f.best.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${f.maps?.length ? `<div class="info-sec"><h4>구글지도 정보</h4><dl class="info-facts">${f.maps.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>` : ''}
      ${f.keywords?.length ? `<div class="info-sec"><h4>리뷰에 자주 나온 말</h4><div class="info-tags plain">${f.keywords.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${f.tips?.length ? `<div class="info-sec"><h4>${f.tipsOf === 'review' ? '리뷰 요약' : '알아둘 점'}</h4><ul class="info-tips">${f.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${f.know?.length ? `<div class="info-sec"><h4>알고 가면 좋은 팁</h4><ul class="info-tips">${f.know.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        ${it.place ? `<a class="info-more" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.place.query || it.place.nameJa)}" target="_blank" rel="noopener">${icon('pin')}구글지도에서 최신 팁 보기</a>` : ''}</div>` : ''}
      ${f.memo?.length ? `<div class="info-sec"><h4>일정 메모</h4><ul class="info-tips">${f.memo.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${f.alt ? `<div class="info-sec"><h4>대안</h4><div class="small">${esc(f.alt)}</div></div>` : ''}
      ${f.mine ? '' : `<div class="small muted info-asof">구글지도 ${esc(f.asOf ? shortDate(f.asOf) + ' 다시 채움' : state.trip.trip.infoAsOf || '')} 기준 · 방문 전 다시 확인</div>`}
    </div>`;
}

function nextStop(it) {
  const day = state.trip.days.find((d) => d.date === it.date);
  const items = dayItems(day);
  return items.slice(items.findIndex((x) => x.id === it.id) + 1).find((x) => !x.skip && x.place);
}

function openItem(id) {
  const it = findItem(id);
  if (!it) return;
  state.sheetItem = id;
  state.swapFor = null;
  state.talkBack = null;
  const now = tokyoNow();
  const done = isDone(it.id);
  const place = placeOfItem(it.id);
  const next = nextStop(it);
  const pending = !done && !it.skip;
  const spent = expenses().filter((e) => e.item === it.id).reduce((a, e) => a + e.amount, 0);
  const v = place && visitOf(place.id);
  const hasAlts = altPlaces(it).length > 0;
  const summary = [AGAIN[v?.again], spent ? yen(spent) : '', v?.memo].filter(Boolean).join(' · ');
  $('#sheet-body').innerHTML = `
    ${placeHero(place)}
    <div class="sheet-head item-head">
      ${itemIcon(it.icon, 'lg')}
      <div class="grow">
        <h3>${esc(it.title)}</h3>
        ${it.place ? `<div class="ja muted small">${esc(it.place.nameJa)}</div>` : ''}
        <div class="item-when">${esc(dayLabel(it.date))} · ${esc(it.start)}${it.end ? '–' + esc(it.end) : ''}${tagFor(it)}${chipsFor(it, now).filter(noTag).map(chipTag).join('')}</div>
        ${!isMove(it) && it.end ? (() => { const d = dayItems(dayOf(it.date)).find((x) => x.id === it.id); return d && d.endMin > d.startMin ? `<div class="stay-range">${icon('clock')}${esc(stayText(stayRange(d)))}</div>` : ''; })() : ''}
      </div>
    </div>
    ${it.line ? lineCard(it) : ''}
    ${it.leg?.steps ? legSteps(it) : it.leg?.source === 'estimate' ? `<div class="ai-note">직선거리로 계산한 이동이에요. 노선·역 번호는 구글 경로에서 받아요.<br><b>이유:</b> ${esc(routeWhy())}</div>${gKey() ? `<div class="btns"><button class="btn wide" data-route-retry="${esc(it.id)}">${icon('refresh')}구글 경로 다시 받기</button></div>` : ''}` : ''}
    ${isLegRow(it) && !isFixed(it) && !it.skip ? `<div class="btns"><button class="btn wide" data-releg="${esc(it.id)}">${icon('refresh')}이동 다시 계산 · 지금 앞뒤 일정 기준</button></div>` : ''}
    ${it.docs ? `<div class="section-title"><span>여기서 쓸 바우처</span></div><div class="btns">${docBtns(it, 'btn wide')}</div>` : ''}
    ${it.link ? `<div class="section-title"><span>${esc(it.link.title || '위치 안내')}</span></div><div class="btns"><a class="btn wide" href="${esc(/Android/i.test(navigator.userAgent) && it.link.android || it.link.url)}" target="_blank" rel="noopener">${icon('ext')}${esc(it.link.label)}</a></div>` : ''}
    ${it.place && it.place.lang !== 'ko' ? `
      <div class="map-row">
        ${mapBtn(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.place.query || it.place.nameJa)}`)}
        <button class="tool" data-ja="${esc(it.id)}">${icon('ja')}보여주기</button>
      </div>` : ''}
    <div class="btns">
      ${it.place?.lang === 'ko' ? navBtn(it.id, '네이버지도로 보기', pending ? 'primary wide' : 'wide') : ''}
      ${it.place && it.place.lang !== 'ko' ? navBtn(it.id, '길찾기', pending ? 'primary wide' : 'wide') : ''}
    </div>
    <div class="act" role="group" aria-label="일정 상태">
      ${canArrive(it, now) ? `<button class="act-arrive" data-arrive="${esc(it.id)}">${icon(isTransit(it) ? 'nav' : 'pin')}<span class="grow"><b>${arriveLabel(it)}</b><small>${now.min < toMin(it.start) ? `예정보다 일찍 왔으면 지금 ${clock(now.min)}부터 시작해요` : delayOf(it, now) && !isFixed(it) && now.min - toMin(it.start) >= 10 ? `지금 ${clock(now.min)} 기준으로 이 일정과 뒤 일정을 다시 맞춰요` : '늦음 표시가 멈추고, 나갈 때 완료를 누르면 돼요'}</small></span></button>` : ''}
      <button class="act-done ${done ? 'on' : ''} ${it.skip ? 'off' : ''}" data-done="${esc(it.id)}" aria-pressed="${done}">
        <i class="act-check">${icon('check')}</i>
        <span class="grow"><b>${done ? `${doneLabel(it)}했어요` : doneLabel(it)}</b><small>${done ? '잘못 눌렀다면 한 번 더 누르면 취소돼요' : it.skip ? '건너뛴 일정이에요 · 누르면 완료로 바꿔요' : '누르면 다음 일정으로 넘어가요'}</small></span>
      </button>
      <div class="act-sub">
        <button class="${it.skip ? 'on' : ''}" data-item-skip="${esc(it.id)}" aria-pressed="${!!it.skip}">${icon('skip')}${it.skip ? '건너뛰기 취소' : '건너뛰기'}</button>
        <button data-item-edit="${esc(it.id)}">${icon('pen')}시간·내용 수정</button>
      </div>
    </div>
    ${sceneOf(it) ? talkCard(sceneOf(it), it.id) : ''}
    <div class="btns">
      ${done && (it.place || place) ? `<button class="finish-sum" data-finish-open="${esc(it.id)}"><b>방문 기록</b><span>${esc(summary || '쓴 돈과 평가 남기기')}</span></button>` : ''}
      ${!pending && next ? navBtn(next.id, `다음: ${next.title.split(' · ').pop()}`, 'primary wide') : ''}
    </div>
    ${it.swap ? `<div class="btns"><button class="btn wide" data-item-unswap="${esc(it.id)}">${icon('refresh')}원래 일정으로 되돌리기</button></div>` : ''}
    ${infoCard(hasAlts ? { ...it, info: { ...it.info, alt: null } } : it)}
    ${altCard(it)}
    ${it.rainPlan ? `<div class="card note" id="item-rain"><b class="note-h">${icon('umbrella')}비 올 때</b><div class="small">${esc(it.rainPlan)}</div></div>` : ''}`;
  $('#sheet').hidden = false;
}
const closeSheet = () => { $('#sheet').hidden = true; };

function showJa({ ja, ko, read }) {
  $('#bigja-body').innerHTML = `
    <div class="ja ja-name">${esc(ja)}</div>
    ${read ? `<div class="ja-read">${esc(read)}</div>` : ''}
    ${ko ? `<div class="ja-ko">${esc(ko)}</div>` : ''}
    <button class="btn primary ja-speak" data-speak-text="${esc(ja)}">${icon('sound')}발음 듣기</button>`;
  $('#bigja').hidden = false;
}

// A card to hold up to staff or a driver: the place, plus what you want from them.
const JA_ASKS = [
  { label: '길 물을 때', ja: 'ここへ行きたいです。', read: '코코에 이키타이데스', ko: '여기에 가고 싶어요' },
  { label: '택시 탈 때', ja: 'ここまでお願いします。', read: '코코마데 오네가이시마스', ko: '여기까지 가 주세요' },
];
function showPlaceJa(name, sub, on, ko = '') {
  const ask = JA_ASKS[on];
  state.jaPlace = { name, sub, ko };
  $('#bigja-body').innerHTML = `
    <div class="ja-asks">${JA_ASKS.map((a, i) => `<button class="${i === on ? 'on' : ''}" data-ja-ask="${i}">${a.label}</button>`).join('')}</div>
    <div class="ja ja-name">${esc(name)}</div>
    ${ko && ko !== name ? `<div class="ja-place-ko">${esc(ko)}</div>` : ''}
    ${sub ? `<div class="ja ja-addr">${esc(sub)}</div>` : ''}
    <div class="ja ja-say">${esc(ask.ja)}</div>
    <div class="ja-read">${esc(ask.read)}</div>
    <div class="ja-ko">${esc(ask.ko)}</div>
    <button class="btn primary ja-speak" data-speak-text="${esc(`${name}\n${ask.ja}`)}">${icon('sound')}발음 듣기</button>`;
  $('#bigja').hidden = false;
}

function openJa(id) {
  if (id === '__stay') {
    const { stay } = state.trip;
    return showPlaceJa(stay.nameJa, `${stay.address}\n${stay.phone.replace('+81-', '0')}`, 1, stay.name);
  }
  const it = findItem(id);
  const place = it?.place;
  if (place) showPlaceJa(place.nameJa, place.query !== place.nameJa ? place.query : '', 0, placeOfItem(id)?.name || stripEmoji(it.title));
}

// ---------- shell ----------
function setHeader(eyebrow, title, sub) {
  $('#top-eyebrow').textContent = eyebrow;
  $('#top-eyebrow').hidden = !eyebrow;
  const el = $('#top-title');
  el.textContent = title;
  el.title = title;
  $('#top-sub').textContent = sub || '';
  fitTitle();
}

// The header stays one line tall: shrink long titles (25px → 18px), then ellipsis.
function fitTitle() {
  const el = $('#top-title');
  el.style.fontSize = '';
  for (let size = 25; size > 18 && el.scrollWidth > el.clientWidth; size -= 1) el.style.fontSize = size - 1 + 'px';
}
addEventListener('resize', fitTitle);

// The version this running code belongs to; keep it equal to VERSION in sw.js.
const APP_VERSION = 295;
async function loadLatest() {
  try {
    const text = await (await fetch(`sw.js?t=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = Number(text.match(/trip-v(\d+)/)?.[1]);
    if (latest && latest !== state.latest) { state.latest = latest; render(); }
  } catch { /* offline: keep showing the running version */ }
}
// On 오늘, the 앱 개선 요청 button (shown once a request-box token is saved) sits right next to the version.
const versionLine = () => {
  const ver = state.latest > APP_VERSION
    ? `<button class="app-ver new" data-update>새 버전 v${state.latest} 있음 · 지금 업데이트</button>`
    : `<div class="app-ver">앱 버전 v${APP_VERSION}${state.latest === APP_VERSION ? ' · 최신' : ''}</div>`;
  if (state.tab !== 'today' || !deskKey()) return ver;
  return `<div class="ver-row"><button class="btn ai req-btn" data-req-open aria-label="개선 요청">${aiLabel('앱 개선 요청')}</button>${ver}</div>`;
};

// Clear the saved app files and load everything fresh; photos and records live elsewhere and stay.
async function updateApp() {
  toast('업데이트하는 중이에요…');
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() || [];
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    await Promise.all(['./', 'index.html', 'app.js', 'styles.css', 'data/trip.json'].map((f) => fetch(f, { cache: 'reload' })));
  } catch { /* reload anyway */ }
  location.reload();
}

// The hourly strip opens with the current hour first; a redraw in the same hour keeps where it was dragged to.
function placeWxStrip(at) {
  const strip = $('.wx-strip');
  const cell = strip?.querySelector('.now');
  if (!cell) return;
  strip.scrollLeft = at ?? cell.getBoundingClientRect().left - strip.getBoundingClientRect().left - 16;
}

function render() {
  if (!state.trip) return;
  const views = { today: renderToday, days: renderDays, explore: renderExplore, wallet: renderWallet, talk: renderTalk, check: renderCheck };
  const stripKey = `${state.tab}:${state.dayIndex}:${Math.floor(tokyoNow().min / 60)}`;
  const stripAt = stripKey === state.stripKey ? $('.wx-strip')?.scrollLeft : null;
  $('#view').innerHTML = views[state.tab]() + versionLine();
  if (!$('#top-gear').firstChild) $('#top-gear').innerHTML = icon('gear');
  // The settings sheet follows the changes made in it (key saved, phone picked, name changed).
  if (!$('#sheet').hidden && $('#sheet-body .settings')) { const y = $('#sheet-body').scrollTop; $('#sheet-body').innerHTML = settingsBody(); $('#sheet-body').scrollTop = y; }
  syncReqFab();
  state.stripKey = stripKey;
  placeWxStrip(stripAt);
  $('#top-add').hidden = state.tab !== 'explore';
  document.documentElement.style.setProperty('--top-h', `${$('.top').offsetHeight}px`);
  $('#top-logo').hidden = state.tab !== 'today';
  $('.top').classList.toggle('has-logo', state.tab === 'today');
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === (state.tab === 'check' ? 'wallet' : state.tab))));
  if (state.tab === 'wallet') hydrateDocs();
  if (state.tab === 'explore' && state.ex.cat === 'log') hydrateLog();
  // Rendering resets the chip rows, so bring each row's selected chip back into view.
  document.querySelectorAll('.ex-row').forEach((row) => {
    const on = row.querySelector('.on');
    if (on) row.scrollLeft = on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
  });
}

function go(tab) {
  const from = state.tab;
  if (from === 'wallet') state.walletY = window.scrollY;
  state.tab = TABS.includes(tab) ? tab : 'today';
  store.set('tab', state.tab);
  closeSheet();
  render();
  // Back from the checklist lands where the bookings page was left.
  window.scrollTo(0, from === 'check' && state.tab === 'wallet' ? state.walletY || 0 : 0);
}

async function copy(key) {
  const v = store.get(key, '');
  if (!v) return toast('먼저 번호를 입력해 주세요.');
  try { await navigator.clipboard.writeText(v); toast('복사했어요'); }
  catch { toast('복사하지 못했어요'); }
}

const ACTIONS = '[data-tab],[data-go],[data-day],[data-nav],[data-ja],[data-ja-ask],[data-intro],[data-item],[data-check],[data-del],[data-done],[data-rate],[data-finish-open],'
  + '[data-close],[data-close-ja],[data-close-viewer],[data-copy],[data-copy-text],[data-open-secret],[data-doc-view],[data-doc-add],[data-doc-new],[data-doc-pick],[data-viewer-del],'
  + '[data-translate],[data-trans-app],[data-swap],[data-phrase],[data-speak],[data-speak-text],[data-talk-sheet],[data-phrase-step],[data-wx-refresh],'
  + '[data-band-off],[data-settings],[data-report-preview],[data-report-close],[data-report-image],[data-wx-fold],[data-sum-fold],[data-qk],[data-qk-min],[data-releg],[data-hotel-add],[data-route-retry],[data-qk-apply],[data-qk-swap],[data-talk-fold],[data-alt-pin],[data-rp-rate],[data-report-text],[data-seal],[data-start],[data-arrive],[data-squeeze-open],[data-squeeze],[data-place-new],[data-place-create],[data-place-del],[data-place-plan],[data-plan-save],[data-item-edit],[data-item-new],[data-catch],[data-day-edit],[data-item-restore],[data-day-reset],[data-f-kind],[data-f-adj],[data-f-dur],[data-f-pm],[data-edit-reset],[data-item-skip],[data-item-swap],[data-item-unswap],[data-item-del],[data-day-route],[data-day-share],[data-place-save],[data-place-visit],[data-ex-cat],[data-ex-area],[data-ex-toggle],[data-update],[data-alarm-sheet],[data-place],[data-go-exp],[data-exp-edit],[data-cash],[data-jump],[data-exp-view],[data-exp-rcpt],[data-gear],[data-prep],[data-wrap-day],[data-prep-done],[data-tomorrow],[data-nick],[data-brief],[data-req-open],[data-req-view],[data-req-attach],[data-req-unattach],[data-req-send],[data-req-open-one],[data-req-reply],[data-req-undo],[data-desk-save],[data-desk-forget],[data-desk-test],[data-sms-photo],[data-rcpt-ai],[data-geo-set],[data-auth-kakao],[data-auth-email],[data-auth-verify],[data-auth-back],[data-auth-out],[data-cloud-create],[data-cloud-now],[data-cloud-invite],[data-trip-open],[data-trip-new],[data-trip-cancel],[data-trip-create],[data-nt-day],[data-nt-reset],[data-nt-month],[data-menu-ai],[data-ai-plan],[data-ai-plan-go],[data-ai-plan-apply],[data-ai-eg],[data-ai-diary],[data-ai-trip-story],[data-diary-share],[data-find],[data-pick-local],[data-pn-manual],[data-place-refresh],[data-place-refresh-all],[data-ai-save],[data-ai-forget],[data-ai-test],[data-g-save],[data-g-forget],[data-g-test],[data-g-pick],[data-sms-open],[data-sms-paste],[data-sms-read],[data-sms-add],[data-day-sum],[data-exp-del],[data-budget],[data-inv-off],[data-inv-close],[data-inv-join],[data-inv-kakao],[data-join-code],[data-mate],[data-mate-kick],[data-mate-leave],[data-mate-all],[data-sync-build],[data-sync-share],[data-sync-pick],'
  + '[data-talk-clear],[data-ex-clear],[data-sync-toggle],[data-fx],[data-fx-swap],[data-fx-clear],[data-fx-set],[data-fx-refresh],[data-fx-log]';

document.addEventListener('click', async (e) => {
  const el = e.target.closest(ACTIONS);
  if (!el) return;
  const d = el.dataset;
  usageTrack(d);
  if (d.tab) go(d.tab);
  else if (d.go) go(d.go);
  else if (d.day) { state.dayIndex = Number(d.day); store.set('day', state.dayIndex); render(); }
  else if (d.nav) navigate(d.nav);
  else if ('intro' in d) playIntro();
  else if (d.ja) openJa(d.ja);
  else if (d.jaAsk) showPlaceJa(state.jaPlace.name, state.jaPlace.sub, Number(d.jaAsk), state.jaPlace.ko);
  else if (d.item) openItem(d.item);
  else if (d.check) {
    const c = checklist().find((x) => x.id === d.check);
    if (docsReady(c)) return viewDoc(c.docs[0]);
    setChecked(d.check, !isChecked(d.check));
    render();
  }
  else if (d.del) { forget('custom:' + d.del); store.set('custom', store.get('custom', []).filter((c) => c.id !== d.del)); render(); }
  else if (d.done) {
    if (el.classList.contains('act-done') && !el.classList.contains('on')) { el.classList.add('pop'); setTimeout(() => completeItem(d.done), 260); }
    else completeItem(d.done);
  }
  else if (d.rate) setAgain(d.rate, d.again, d.from);
  else if (d.finishOpen) openFinish(d.finishOpen);
  else if ('close' in d) closeSheet();
  else if ('closeJa' in d) { $('#bigja').hidden = true; window.speechSynthesis?.cancel(); player.onended = null; player.pause(); }
  else if ('closeViewer' in d) $('#viewer').hidden = true;
  else if ('viewerDel' in d) {
    if (!(await askConfirm('지금 보고 있는 사진을 삭제할까요?', { body: '이 폰에서 지워지고 되돌릴 수 없어요.', ok: '삭제', danger: true }))) return;
    const key = state.viewer.keys[viewerIndex()];
    try { await docs.del(key); } catch { /* ignore */ }
    await refreshDocSlots();
    // An added set disappears with its last photo.
    if (!state.docSlots.has(state.viewer.slot) && docSlot(state.viewer.slot)?.custom) {
      forget('cdocs:' + state.viewer.slot);
      store.set('cdocs', store.get('cdocs', []).filter((c) => c.id !== state.viewer.slot));
    }
    $('#viewer').hidden = true;
    render();
    if (state.viewer.keys.length > 1) viewDoc(state.viewer.slot);
  }
  else if (d.copy) copy(d.copy);
  else if (d.copyText) {
    try { await navigator.clipboard.writeText(d.copyText); toast(/^https?:/.test(d.copyText) ? '복사했어요 · Safari 주소창에 붙여넣으세요' : '복사했어요'); }
    catch { toast('복사하지 못했어요'); }
  }
  else if (d.openSecret) {
    const url = store.get(d.openSecret, '');
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    else toast('https로 시작하는 링크를 붙여넣어 주세요.');
  }
  else if (d.docView) {
    // No photo yet: open the picker right away (it has to happen inside the tap on iPhone).
    if (!state.docSlots.has(d.docView)) { toast(`${docLabel(d.docView)} 사진을 골라 주세요`); pickPhotos(d.docView); }
    else viewDoc(d.docView);
  }
  else if (d.docAdd) pickPhotos(d.docAdd);
  else if ('update' in d) updateApp();
  else if ('bandOff' in d) { state.bandOff = true; render(); }
  else if (d.start) { store.set('start:' + d.start, true); render(); }
  else if (d.arrive) arrive(d.arrive);
  else if (d.squeezeOpen) openSqueeze(d.squeezeOpen);
  else if (d.squeeze) applySqueeze(Number(d.squeeze));
  else if (d.seal) {
    store.set('seal:' + d.seal, true);
    state.sealHit = d.seal;
    navigator.vibrate?.(30);
    render();
  }
  else if ('alarmSheet' in d) openAlarms();
  else if ('placeNew' in d) openPlaceNew();
  else if ('placeCreate' in d) createPlace(d.placeCreate === 'plan');
  else if (d.find) runFind(d.find);
  else if (d.pickLocal) pickLocal(d.pickLocal, d.where);
  else if ('pnManual' in d) { $('#pn-save').hidden = false; el.remove(); $('#pn-name').value = $('#pn-name').value || fq('pn'); $('#pn-name').focus(); }
  else if (d.placeRefresh) refreshAnyPlace(d.placeRefresh);
  else if ('placeRefreshAll' in d) refreshAllPlaces();
  else if ('aiSave' in d) {
    const k = $('#ai-key').value.trim();
    if (!/^sk-ant-/.test(k)) return toast('sk-ant-로 시작하는 API 키를 넣어 주세요');
    store.set('aiKey', k); store.set('aiModel', $('#ai-model').value); state.aiTest = null; render(); toast('AI 도우미를 켰어요');
  }
  else if ('aiForget' in d) { if (await askConfirm('이 폰에서 API 키를 지울까요?', { body: 'AI 도우미 기능이 꺼져요. 키는 다시 넣을 수 있어요.', ok: '지우기', danger: true })) { store.set('aiKey', ''); render(); toast('키를 지웠어요'); } }
  else if ('aiTest' in d) aiTest();
  else if ('gSave' in d) {
    const k = $('#g-key').value.trim();
    if (!/^AIza/.test(k)) return toast('AIza로 시작하는 구글 API 키를 넣어 주세요');
    store.set('gKey', k); state.gTest = null; render(); toast('구글 장소 키를 저장했어요');
  }
  else if ('gForget' in d) { if (await askConfirm('이 폰에서 구글 키를 지울까요?', { body: '장소 찾기와 구글 경로가 꺼져요.', ok: '지우기', danger: true })) { store.set('gKey', ''); state.gTest = null; render(); } }
  else if ('gTest' in d) gTest();
  else if ('gPick' in d) gPick(d.gPick, d.where);
  else if (d.placeDel) deletePlace(d.placeDel);
  else if (d.placePlan) openPlan(d.placePlan);
  else if (d.planSave) savePlan(d.planSave);
  else if (d.itemEdit) openItemForm(d.itemEdit);
  else if ('itemNew' in d) openItemForm(null, { date: d.itemNew, after: d.after, rest: 'rest' in d });
  else if (d.catch) openItemForm(d.catch, { catch: true });
  else if ('dayEdit' in d) { const { date } = state.trip.days[state.dayIndex]; state.editDay = state.editDay === date ? null : date; render(); }
  else if (d.itemRestore) restoreItem(d.itemRestore);
  else if (d.dayReset) resetDay(d.dayReset);
  else if (d.fKind) {
    state.form.kind = state.form.kind === d.fKind ? '' : d.fKind;
    document.querySelectorAll('[data-f-kind]').forEach((b) => b.classList.toggle('on', b.dataset.fKind === state.form.kind));
  }
  else if (d.fAdj) {
    const f = state.form;
    f.s = Math.max(0, Math.min(1439 - 5, d.fAdj === 'now' ? tokyoNow().min : f.s + Number(d.fAdj)));
    $('#f-start').value = clock(f.s); $('#f-end').value = clock(Math.min(1439, f.s + f.dur)); updateForm();
  }
  else if (d.fDur) { state.form.dur = Number(d.fDur); $('#f-end').value = clock(Math.min(1439, state.form.s + state.form.dur)); updateForm(); }
  else if ('fPm' in d) { const f = state.form; f.s += 720; $('#f-start').value = clock(f.s); $('#f-end').value = clock(Math.min(1439, f.s + f.dur)); updateForm(); }
  // Back to the plan for this stop: times, name, day and lock. A swapped place and a skip stay.
  else if (d.editReset) {
    const { swap, skip } = store.get('edit:' + d.editReset, null) || {};
    store.set('edit:' + d.editReset, swap || skip ? { ...(swap ? { swap } : {}), ...(skip ? { skip } : {}) } : null);
    closeSheet();
    render();
  }
  else if (d.itemSkip) toggleSkip(d.itemSkip);
  else if (d.itemDel) deleteItem(d.itemDel);
  else if ('dayRoute' in d) dayRoute();
  else if ('dayShare' in d) shareDay();
  else if (d.placeSave) toggleSave(d.placeSave);
  else if (d.placeVisit) toggleVisit(d.placeVisit);
  else if (d.place) { state.swapFor = d.fromItem || null; openPlace(d.place); }
  else if (d.itemSwap) swapStop(state.swapFor, d.itemSwap);
  else if (d.itemUnswap) unswapStop(d.itemUnswap);
  else if (d.exCat) { state.ex.cat = d.exCat; render(); }
  else if (d.exArea) { state.ex.area = d.exArea; render(); }
  else if (d.exToggle) {
    const k = d.exToggle;
    if (k === 'near' && !state.ex.near) findNear();
    else { state.ex[k] = !state.ex[k]; render(); }
  }
  else if ('docNew' in d) openDocNew();
  else if ('docPick' in d) {
    const title = $('#doc-title').value.trim();
    if (!title) return toast('제목을 먼저 입력해 주세요.');
    pickPhotos(null, title);
  }
  else if (d.translate) {
    const text = $('#talk-text').value.trim();
    if (!text) return toast('번역할 말을 입력해 주세요.');
    translate(d.translate, text);
  }
  else if ('talkClear' in d) {
    store.set('talkText', '');
    const box = $('#talk-text');
    box.value = ''; el.hidden = true; box.focus();
  }
  else if ('fx' in d) openFx();
  else if ('fxSwap' in d) {
    const f = state.fxCalc; const { out } = fxCalc();
    f.value = out ? String(Math.round(out)) : ''; f.dir = f.dir === 'yen' ? 'won' : 'yen'; f.tax = false; openFx();
  }
  else if ('exClear' in d) {
    const input = $('#ex-q');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }
  else if ('fxClear' in d) { state.fxCalc.value = ''; $('#fx-in').value = ''; updateFx(); $('#fx-in').focus(); }
  else if (d.fxSet) {
    // Each tap adds, so 5,000 + 1,000 + 500 builds 6,500 without typing.
    const f = state.fxCalc;
    f.value = String((Number(String(f.value).replace(/[^0-9.]/g, '')) || 0) + Number(d.fxSet));
    $('#fx-in').value = commas(f.value); updateFx();
  }
  else if ('fxRefresh' in d) {
    if (state.fx) state.fx.at = 0;
    toast((await loadFx(true)) ? '환율을 새로 받았어요' : '지금은 환율을 받을 수 없어요 · 저장된 환율로 계산해요');
  }
  else if ('fxLog' in d) {
    const f = state.fxCalc; const { base, out } = fxCalc();
    const amount = Math.round(f.dir === 'yen' ? base : out);
    if (!amount) return toast('금액을 먼저 넣어 주세요.');
    closeSheet(); state.expView = 'spent'; go('wallet');
    const box = $('.exp-form [name=amount]');
    box.value = amount; $('#exp')?.scrollIntoView({ block: 'start' }); scrollBy(0, -100);
    $('.exp-form [name=memo]').focus();
    toast(`${yen(amount)} · 메모와 분류를 고르고 '기록'을 누르세요`);
  }
  else if ('settings' in d) openSettings(d.settings);
  else if ('reportPreview' in d) { state.reportPreview = true; window.scrollTo(0, 0); render(); }
  else if (d.hotelAdd) {
    const [date, at] = d.hotelAdd.split('|');
    const undo = putHotelStop(date, at);
    render();
    toast(`호텔 복귀 ${at} · 일정에 넣었어요`, () => { undo?.(); render(); }, '되돌리기');
  }
  else if (d.releg) relegMove(d.releg);
  else if (d.routeRetry) routeRetry(d.routeRetry);
  else if (d.qk) { const [k, id] = d.qk.split('|'); openQuick(k, id); }
  else if (d.qkMin) openQuick(state.qk.kind, state.qk.id, Number(d.qkMin));
  else if ('qkApply' in d) applyQuick();
  else if (d.altPin) { const [id, pid] = d.altPin.split('|'); pinAlt(id, pid); }
  else if (d.qkSwap) { const [id, pid] = d.qkSwap.split('|'); quickSwap(id, pid); }
  else if (d.sumFold) {
    try { const o = JSON.parse(localStorage.getItem('daySumOpen') || '[]'); localStorage.setItem('daySumOpen', JSON.stringify(o.includes(d.sumFold) ? o.filter((x) => x !== d.sumFold) : [...o, d.sumFold])); } catch { /* private mode */ }
    render();
  }
  else if ('wxFold' in d) {
    if (d.wxFold && isDayDone(d.wxFold)) lsToggle('wxOpenDone', d.wxFold);
    else { try { localStorage.setItem('wxCard', wxCardOpen() ? '0' : '1'); } catch { /* private mode */ } }
    render();
  }
  else if (d.rpRate) { state.rpRate = d.rpRate; render(); }
  else if ('reportImage' in d) reportImage();
  else if ('reportText' in d) reportText();
  else if ('reportClose' in d) { state.reportPreview = false; window.scrollTo(0, 0); render(); }
  else if ('syncToggle' in d) { state.syncOpen = !state.syncOpen; render(); }
  else if (d.transApp) {
    const dir = state.talkDir;
    state.talkDir = d.transApp === 'camera' ? 'ja-ko' : 'ko-ja';
    openLive();
    state.talkDir = dir;
    toast(d.transApp === 'camera' ? '앱이 열리면 카메라를 누르세요' : "앱이 열리면 '실시간 번역'에서 '대화'를 누르세요");
  }
  else if ('swap' in d) {
    state.talkDir = state.talkDir === 'ko-ja' ? 'ja-ko' : 'ko-ja';
    render();
    if (!$('#sheet').hidden && state.talkBack) openTalkSheet(state.talkBack);
  }
  else if (d.phrase) { const p = state.trip.phrases[d.phrase]; showJa({ ja: p.ja, read: p.read, ko: p.ko }); }
  else if (d.speak) speak(state.trip.phrases[d.speak].ja);
  else if (d.speakText) speak(d.speakText);
  else if ('wxRefresh' in d) {
    if (!state.wxBusy) {
      state.wxBusy = true;
      el.querySelector('.ico')?.classList.add('spin');
      if (el.lastChild?.nodeType === 3) el.lastChild.textContent = '받는 중';
      const t = Date.now();
      loadWeather(true).finally(() => setTimeout(() => { state.wxBusy = false; render(); }, Math.max(0, 700 - (Date.now() - t))));
    }
  }
  else if (d.talkSheet) openTalkSheet(d.talkSheet);
  else if (d.talkFold) {
    const card = el.closest('.talk-card');
    if (talkOpen.has(d.talkFold)) talkOpen.delete(d.talkFold); else talkOpen.add(d.talkFold);
    card.outerHTML = talkCard(card.dataset.scene, card.dataset.id);
  }
  else if ('phraseStep' in d) {
    const card = el.closest('.talk-card');
    phraseStep[card.dataset.scene] = Number(d.phraseStep);
    card.outerHTML = talkCard(card.dataset.scene, card.dataset.id);
  }
  else if (d.expEdit) openExpEdit(d.expEdit);
  else if ('cash' in d) {
    const v = await askText('환전한 엔화 금액', String(cashTotal()), { numeric: true, body: '엔화 현금 남은 돈 계산에 써요.' });
    if (v !== null) { store.set('cashYen', Number(v.replace(/[^0-9]/g, '')) || 0); render(); }
  }
  else if (d.jump) $(`#${d.jump}`)?.scrollIntoView({ block: 'start' });
  else if (d.expView) { state.expView = d.expView; render(); }
  else if ('goExp' in d) { state.expView = 'spent'; go('wallet'); $('#exp')?.scrollIntoView({ block: 'start' }); scrollBy(0, -100); }
  // Saved first, then the camera opens straight from the same tap (iPhone allows the picker only there).
  else if (d.gear) {
    const [date, k, v] = d.gear.split('|');
    const key = `gear:${date}:${meId()}`;
    const g = store.get(key, null) || {};
    store.set(key, { ...g, [k]: g[k] === v ? '' : v });
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el && g[k] !== v));
  }
  else if (d.wrapDay) {
    const ids = d.ids.split(',');
    const before = ids.map((id) => [id, store.get('done:' + id, false), store.get('edit:' + id, null)]);
    for (const id of ids) {
      if (d.wrapDay === 'done') setDone(id, true);
      else store.set('edit:' + id, { ...store.get('edit:' + id, null), skip: true });
    }
    render();
    toast(d.wrapDay === 'done' ? `${ids.length}개를 완료했어요` : `${ids.length}개를 건너뛰었어요`, () => {
      for (const [id, done, edit] of before) { setDone(id, done); store.set('edit:' + id, edit); }
      render();
    }, '되돌리기');
  }
  else if (d.prep) {
    const [date, k] = d.prep.split('|');
    const st = store.get('prep:' + date, {});
    store.set('prep:' + date, { ...st, ck: { ...st.ck, [k]: !st.ck?.[k] } });
    el.classList.toggle('on');
  }
  else if (d.prepDone) {
    briefStop();
    const key = 'prep:' + d.prepDone;
    store.set(key, { ...store.get(key, {}), done: true }); render();
    toast(`${callMe()}, 좋은 하루 보내세요`, () => { store.set(key, { ...store.get(key, {}), done: false }); render(); }, '다시 보기');
  }
  else if ('brief' in d) briefPlay(state.brief || '');
  else if ('smsOpen' in d) openSmsSheet();
  else if ('reqOpen' in d) openReq('new');
  else if (d.reqView) openReq(d.reqView);
  else if ('reqAttach' in d) attachReq();
  else if (d.reqUnattach) { state.reqFiles.splice(Number(d.reqUnattach), 1); drawReqFiles(); }
  else if ('reqSend' in d) sendReq(el);
  else if (d.reqOpenOne) openReqOne(d.reqOpenOne);
  else if (d.reqReply) replyReq(d.reqReply, $('#req-reply').value.trim());
  else if (d.reqUndo) replyReq(d.reqUndo, '방금 반영한 변경을 되돌려 주세요. 이전 상태로 돌려 놓고 새 버전으로 배포해 주세요.');
  else if ('deskSave' in d) {
    const k = $('#desk-key').value.trim();
    if (!/^(github_pat_|ghp_)/.test(k)) return toast('github_pat_로 시작하는 토큰을 넣어 주세요');
    store.set('deskKey', k); render(); toast('개선 요청함을 켰어요. 오늘 탭 맨 아래 ‘앱 개선 요청’ 버튼을 눌러 보세요');
  }
  else if ('deskForget' in d) { if (await askConfirm('이 폰에서 요청함 토큰을 지울까요?', { body: '앱 개선 요청 버튼이 사라져요.', ok: '지우기', danger: true })) { store.set('deskKey', ''); render(); } }
  else if ('deskTest' in d) ghApi(`repos/${DESK}`).then((r) => toast(r.private ? '요청함에 연결됐어요' : '연결됐지만 요청함이 공개 저장소예요. 비공개로 바꿔 주세요')).catch((e) => toast(e.message));
  else if ('smsPhoto' in d) smsFromPhoto();
  // The AI key lives on each phone, so a phone without one (another person's) still sees the button and is told how to turn it on.
  else if ('geoSet' in d) geoSet(d.geoSet === 'on');
  else if ('authKakao' in d) authKakao();
  else if ('authEmail' in d) authEmail();
  else if ('authVerify' in d) authVerify();
  else if ('authBack' in d) { AUTH.step = ''; AUTH.msg = ''; accountRefresh(); }
  else if ('authOut' in d) authOut();
  else if ('cloudCreate' in d) cloudCreateTrip();
  else if ('cloudNow' in d) { if (CLOUD.trip) cloudSync(true); else cloudStart(true); }
  else if ('cloudInvite' in d) cloudInvite();
  else if ('invOff' in d) inviteOff();
  else if ('invClose' in d) inviteClose();
  else if ('invJoin' in d) inviteJoin();
  else if ('invKakao' in d) inviteKakao();
  else if ('joinCode' in d) inviteAsk();
  else if (d.mate !== undefined) { CLOUD.mateOpen = CLOUD.mateOpen === d.mate ? '' : d.mate; cloudRefreshUi(); }
  else if (d.mateKick) mateKick(d.mateKick);
  else if ('mateLeave' in d) mateLeave();
  else if ('mateAll' in d) { CLOUD.mateAll = true; cloudRefreshUi(); }
  else if ('tripOpen' in d) tripSwitch(d.tripOpen);
  else if ('tripNew' in d) { Object.assign(NT, { title: '', start: '', end: '', month: '' }); CLOUD.form = true; cloudRefreshUi(); setTimeout(() => $('#nt-title')?.focus(), 50); }
  else if ('ntDay' in d) ntTap(d.ntDay);
  else if ('ntReset' in d) { NT.start = ''; NT.end = ''; ntRefresh(); }
  else if ('ntMonth' in d) ntMonth(+d.ntMonth);
  else if ('tripCancel' in d) { CLOUD.form = false; cloudRefreshUi(); }
  else if ('tripCreate' in d) tripCreate();
  else if ('rcptAi' in d) { if (aiKey()) rcptFromPhoto(); else { openSettings('ai'); toast('영수증 사진 읽기는 AI 도우미 키가 있어야 해요. 이 폰에서 키를 넣어 주세요.'); } }
  else if ('menuAi' in d) menuFromPhoto();
  else if ('aiPlan' in d) {
    if (d.aiPlan === 'late') {
      const now = tokyoNow();
      state.dayIndex = Math.max(0, state.trip.days.findIndex((x) => x.date === now.date));
      const late = dueQueue(dayItems(state.trip.days[state.dayIndex]).filter((it) => !it.skip), now)[0];
      const fixed = dayItems(state.trip.days[state.dayIndex]).filter((it) => isFixed(it) && it.startMin > now.min).map((it) => `${it.start} ${stripEmoji(it.title).split(' · ')[0]}`);
      openAiPlan(`지금 ${clock(now.min)}인데 ${late ? `${stripEmoji(late.title).split(' · ')[0]}부터` : ''} 일정이 밀렸어요. ${fixed.length ? `${fixed.join(', ')}은(는) 꼭 지키면서 ` : ''}남은 일정을 맞출 방법 2~3가지를 제안해 줘.`);
    } else openAiPlan();
  }
  else if ('aiPlanGo' in d) aiPlanGo();
  else if ('aiPlanApply' in d) aiPlanApply(Number(d.aiPlanApply));
  else if (d.aiEg) { $('#ai-plan-q').value = d.aiEg; $('#ai-plan-q').focus(); }
  else if (d.aiDiary) aiDiary(d.aiDiary, el);
  else if ('aiTripStory' in d) aiTripStory(el);
  else if (d.diaryShare) {
    const x = store.get('diary:' + d.diaryShare, null);
    if (x) {
      const text = `${x.title}\n\n${x.text}${x.tips?.length ? `\n\n다음 여행 팁\n${x.tips.map((t) => `· ${t}`).join('\n')}` : ''}`;
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else navigator.clipboard?.writeText(text).then(() => toast('복사했어요'));
    }
  }
  else if ('smsPaste' in d) {
    const manual = () => { $('#sms-text').focus(); toast('입력칸을 길게 눌러 붙여넣기 해 주세요'); };
    if (!navigator.clipboard?.readText) manual();
    else navigator.clipboard.readText().then((t) => { $('#sms-text').value = t; showSms(); }).catch(manual);
  }
  else if ('smsRead' in d) showSms();
  else if ('smsAdd' in d) addSms();
  else if ('nick' in d) editNick();
  else if (d.tomorrow) { if (d.sumOpen && !lsList('daySumOpen').includes(d.sumOpen)) lsToggle('daySumOpen', d.sumOpen); state.dayIndex = Number(d.tomorrow); store.set('day', state.dayIndex); go('days'); }
  else if (d.daySum) {
    state.dayIndex = Number(d.daySum); store.set('day', state.dayIndex); go('days');
    $('.day-sum .gear-fb')?.scrollIntoView({ block: 'center' });
  }
  else if ('expRcpt' in d) {
    const form = el.closest('form');
    const value = expValue(form);
    if (!value) return toast('금액을 입력한 뒤 누르면 지출과 영수증이 함께 등록돼요.');
    const f = new FormData(form);
    const id = addExpense({ value, cur: f.get('cur'), pay: f.get('pay'), memo: String(f.get('memo') || '').trim(), cat: f.get('cat'), date: f.get('date') || undefined });
    pickPhotos(rcptSlot(id));
    render();
  }
  else if (d.expDel) {
    if (!(await askConfirm('이 지출 기록을 삭제할까요?', { body: '영수증 사진도 함께 지워져요.', ok: '삭제', danger: true }))) return;
    forget('exp:' + d.expDel);
    try { for (const k of await docs.of(rcptSlot(d.expDel))) await docs.del(k); await refreshDocSlots(); } catch { /* ignore */ }
    store.set('exp', expenses().filter((x) => x.id !== d.expDel));
    const finishing = $('#sheet').hidden ? null : $('#sheet-body [data-exp-item]')?.dataset.expItem;
    if ($('.exp-edit')) closeSheet();
    render();
    if (finishing) openFinish(finishing);
  }
  else if ('budget' in d) {
    const v = await askText('예산 (엔, 쇼핑 제외)', String(store.get('budget', state.trip.budget?.yen || 0)), { numeric: true });
    if (v !== null && Number(v.replace(/[^0-9]/g, '')) >= 0) { store.set('budget', Number(v.replace(/[^0-9]/g, ''))); render(); }
  }
  else if ('syncBuild' in d) { state.syncFailed = false; prepareSync().then(() => { const c = $('#sheet-body .backup-card'); if (c) c.outerHTML = backupPanel(); }); const c = $('#sheet-body .backup-card'); if (c) c.outerHTML = backupPanel(); }
  else if ('syncShare' in d) shareSyncFile().then(() => { const c = $('#sheet-body .backup-card'); if (c) c.outerHTML = backupPanel(); });
  else if ('syncPick' in d) $('#sync-file').click();
});

document.addEventListener('compositionend', (e) => {
  if (e.target.classList?.contains('amount')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('.tpick input')) e.target.closest('.tpick').classList.toggle('no-time', !e.target.value);
  const sel = e.target.closest?.('.cat-pick select');
  if (sel) sel.previousElementSibling.innerHTML = expIcon(sel.value);
});
document.addEventListener('input', (e) => {
  if (e.target.matches?.('.tpick input')) e.target.closest('.tpick').classList.toggle('no-time', !e.target.value);
  const t = e.target;
  if (t.classList.contains('amount') && !e.isComposing) formatAmount(t);
  if (t.dataset.gearMemo) {
    const key = `gear:${t.dataset.gearMemo}:${meId()}`;
    store.set(key, { ...store.get(key, null), memo: t.value.trim() });
    return;
  }
  if (t.dataset.placeMemo) {
    const id = t.dataset.placeMemo;
    const v = visitOf(id);
    store.set('visit:' + id, { ...v, at: v?.at || Date.now(), by: v?.by || meId(), memo: t.value });
    return;
  }
  if (t.dataset.secret) store.set(t.dataset.secret, t.type === 'url' || t.type === 'tel' ? t.value.trim() : t.value.trim().toUpperCase());
  else if (t.id === 'fx-in') { state.fxCalc.value = t.value; updateFx(); }
  else if (t.id === 'fx-tax') { state.fxCalc.tax = t.checked; updateFx(); }
  else if (t.id === 'f-q' || t.id === 'pn-q') { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 120)}px`; finderTyped(t.id.split('-')[0]); }
  else if (t.id === 'f-nm' || t.id === 'pn-nm') suggestFor(t.id.split('-')[0], t.value);
  else if (t.id === 'ai-model') store.set('aiModel', t.value);
  else if (t.id === 'ex-q') {
    state.ex.q = t.value;
    const now = tokyoNow();
    $('#ex-list').innerHTML = exploreRows(exploreList(now), now);
    $('[data-ex-clear]').hidden = !t.value;
  }
  // Changing the start keeps the length, so the end follows; changing the end changes the length.
  else if (t.id === 'f-start') {
    const v = fromClock(t.value);
    if (v === null) return;
    if (state.form.dur <= 0) state.form.dur = 60;
    state.form.s = v; $('#f-end').value = clock(Math.min(1439, v + state.form.dur)); updateForm();
  }
  else if (t.id === 'f-end') {
    const v = fromClock(t.value);
    if (v !== null) { state.form.dur = v - state.form.s; updateForm(); }
  }
  else if (['f-date', 'f-place'].includes(t.id)) updateForm();
  else if (t.id === 'f-rip') { state.form.rip = t.checked; updateForm(); }
  else if (t.name === 'f-fit') { state.form.fit = t.value; updateForm(); }
  else if (t.id === 'talk-text') { store.set('talkText', t.value); $('.talk-clear').hidden = !t.value; }
});

// Swiping the explore list moves between its categories, and the 일정 tab between days. Edge starts stay
// the system's back gesture; rows that scroll sideways (chips, day picker, hourly weather) keep their own scroll.
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const open = !$('#sheet').hidden || !$('#bigja').hidden;
  const edge = t.clientX < 24 || t.clientX > innerWidth - 24;
  const off = !['explore', 'days'].includes(state.tab) || open || edge || e.touches.length > 1
    || !e.target.closest('main') || e.target.closest('.ex-row, .ex-cats, .daypick, .wx-strip, .doc-row, input, textarea, select');
  swipe = off ? null : { x: t.clientX, y: t.clientY, at: Date.now() };
}, { passive: true });
// Once a swipe is clearly sideways, stop the page from being dragged along with the finger (iPhone pans it otherwise).
document.addEventListener('touchmove', (e) => {
  if (!swipe || state.tab !== 'days') return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (swipe.side || (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5)) { swipe.side = true; e.preventDefault(); }
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  const quick = Date.now() - swipe.at < 800;
  swipe = null;
  if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
  if (state.tab === 'days') {
    const to = state.dayIndex + (dx < 0 ? 1 : -1);
    if (to < 0 || to >= state.trip.days.length) return toast(to < 0 ? '첫날이에요' : '마지막 날이에요');
    state.dayIndex = to;
    store.set('day', to);
    render();
    window.scrollTo(0, 0);
    // A short slide from the side the next day comes from.
    const v = $('#view');
    v.classList.remove('slide-l', 'slide-r');
    void v.offsetWidth;
    v.classList.add(dx < 0 ? 'slide-l' : 'slide-r');
    return;
  }
  const next = EX_CATS[EX_CATS.findIndex(([k]) => k === state.ex.cat) + (dx < 0 ? 1 : -1)];
  if (!next) return;
  state.ex.cat = next[0];
  render();
  window.scrollTo(0, 0);
}, { passive: true });

// While a popup is open the page behind it stays put. iPhone can still drag the page, so touches that
// would not scroll something inside the popup are stopped too.
const OVERLAYS = ['#sheet', '#bigja', '#viewer'];
const overlayOpen = () => OVERLAYS.some((s) => !$(s).hidden);
const lockPage = () => document.documentElement.classList.toggle('locked', overlayOpen());
const lockObserver = new MutationObserver(lockPage);
OVERLAYS.forEach((s) => lockObserver.observe($(s), { attributes: true, attributeFilter: ['hidden'] }));
// Each popup starts at its top; redrawing the same one (a ticked step, a saved rating) stays where it was.
const sheetTop = () => { $('.sheet-panel').scrollTop = 0; };
let sheetKey = '';
new MutationObserver(() => { if (!$('#sheet').hidden) sheetTop(); }).observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(() => {
  const key = $('#sheet-body h3')?.textContent || '';
  if (key !== sheetKey) { sheetTop(); sheetPanel.classList.remove('scrolled', 'titled'); }
  sheetKey = key;
}).observe($('#sheet-body'), { childList: true });
// With the popup at its top, pulling it down drags it along and closes it past a short distance or on a quick flick.
const sheetPanel = $('.sheet-panel');
// Once the content scrolls under the pinned top, a hairline marks the edge.
// A popup whose top isn't a pinned title row (a photo first, a stop's big head) shows its name small in the pinned band
// once the name has scrolled away.
const sheetTitle = () => {
  const grip = $('.sheet-panel > .sheet-grip');
  const pinned = $('#sheet-body > .sheet-head:first-child:not(.item-head)');
  const h = !pinned && $('#sheet-body h3');
  const on = !!h && h.getBoundingClientRect().bottom < sheetPanel.getBoundingClientRect().top + 30;
  grip.dataset.title = on ? h.textContent.trim() : '';
  sheetPanel.classList.toggle('titled', on);
};
sheetPanel.addEventListener('scroll', () => { sheetPanel.classList.toggle('scrolled', sheetPanel.scrollTop > 4); sheetTitle(); }, { passive: true });
let pull = null;
sheetPanel.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  // The pinned grip and title row pull the popup down even when its content has scrolled.
  const onTop = sheetPanel.scrollTop <= 0 || e.target.closest('.sheet-grip, #sheet-body > .sheet-head:first-child');
  const free = onTop && e.touches.length === 1 && !e.target.closest('textarea') && e.target !== document.activeElement;
  pull = free ? { x: t.clientX, y: t.clientY, at: Date.now(), dy: 0, on: false } : null;
}, { passive: true });
sheetPanel.addEventListener('touchmove', (e) => {
  if (!pull) return;
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - pull.x);
  const dy = t.clientY - pull.y;
  if (!pull.on) {
    if (dx + Math.abs(dy) < 8) return;
    if (dy <= 0 || dx > dy) { pull = null; return; }
    pull.on = true;
    sheetPanel.style.transition = 'none';
  }
  pull.dy = Math.max(0, dy);
  sheetPanel.style.transform = `translateY(${pull.dy}px)`;
  e.preventDefault();
}, { passive: false });
const endPull = () => {
  if (!pull?.on) { pull = null; return; }
  const { dy, at } = pull;
  pull = null;
  const close = dy > 110 || (dy > 40 && dy / (Date.now() - at) > 0.5);
  sheetPanel.style.transition = 'transform .2s ease';
  sheetPanel.style.transform = close ? 'translateY(100%)' : '';
  setTimeout(() => {
    if (close) closeSheet();
    sheetPanel.style.transition = sheetPanel.style.transform = '';
  }, 200);
};
sheetPanel.addEventListener('touchend', endPull);
sheetPanel.addEventListener('touchcancel', endPull);
// The photo viewer closes the same way: pull the photo down and let go.
const viewerEl = $('#viewer');
let vpull = null;
viewerEl.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  vpull = e.touches.length === 1 && !e.target.closest('button') ? { x: t.clientX, y: t.clientY, at: Date.now(), dy: 0, on: false } : null;
}, { passive: true });
viewerEl.addEventListener('touchmove', (e) => {
  if (!vpull) return;
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - vpull.x);
  const dy = t.clientY - vpull.y;
  if (!vpull.on) {
    if (dx + Math.abs(dy) < 8) return;
    if (dy <= 0 || dx > dy) { vpull = null; return; }
    vpull.on = true;
    viewerEl.style.transition = 'none';
  }
  vpull.dy = Math.max(0, dy);
  $('#viewer-track').style.transform = `translateY(${vpull.dy}px)`;
  viewerEl.style.backgroundColor = `rgba(0,0,0,${Math.max(0.35, 1 - vpull.dy / 400)})`;
  e.preventDefault();
}, { passive: false });
const endVPull = () => {
  if (!vpull?.on) { vpull = null; return; }
  const { dy, at } = vpull;
  vpull = null;
  const close = dy > 110 || (dy > 40 && dy / (Date.now() - at) > 0.5);
  const track = $('#viewer-track');
  track.style.transition = 'transform .2s ease';
  track.style.transform = close ? 'translateY(100vh)' : '';
  setTimeout(() => {
    if (close) viewerEl.hidden = true;
    track.style.transition = track.style.transform = viewerEl.style.backgroundColor = viewerEl.style.transition = '';
  }, 200);
};
viewerEl.addEventListener('touchend', endVPull);
// The full-screen phrase / address card closes the same way: pull it down and let go.
const bigEl = $('#bigja');
const bigPanel = $('#bigja .bigja-panel');
let bpull = null;
bigEl.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  bpull = e.touches.length === 1 && (bigPanel.scrollTop <= 0 || e.target.closest('.bigja-grip')) && !e.target.closest('button') ? { x: t.clientX, y: t.clientY, at: Date.now(), dy: 0, on: false } : null;
}, { passive: true });
bigEl.addEventListener('touchmove', (e) => {
  if (!bpull) return;
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - bpull.x);
  const dy = t.clientY - bpull.y;
  if (!bpull.on) {
    if (dx + Math.abs(dy) < 8) return;
    if (dy <= 0 || dx > dy) { bpull = null; return; }
    bpull.on = true;
    bigPanel.style.transition = 'none';
  }
  bpull.dy = Math.max(0, dy);
  bigPanel.style.transform = `translateY(${bpull.dy}px)`;
  e.preventDefault();
}, { passive: false });
const endBPull = () => {
  if (!bpull?.on) { bpull = null; return; }
  const { dy, at } = bpull;
  bpull = null;
  const close = dy > 110 || (dy > 40 && dy / (Date.now() - at) > 0.5);
  bigPanel.style.transition = 'transform .2s ease';
  bigPanel.style.transform = close ? 'translateY(100%)' : '';
  setTimeout(() => {
    if (close) $('.overlay-close[data-close-ja]').click();
    bigPanel.style.transition = bigPanel.style.transform = '';
  }, 200);
};
bigEl.addEventListener('touchend', endBPull);
bigEl.addEventListener('touchcancel', endBPull);
viewerEl.addEventListener('touchcancel', endVPull);
document.addEventListener('touchmove', (e) => {
  if (!overlayOpen() || e.touches.length > 1) return;
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
    const { overflowX, overflowY } = getComputedStyle(el);
    if (/auto|scroll/.test(overflowX + overflowY)) return;
  }
  e.preventDefault();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#bigja').hidden) $('[data-close-ja]').click();
  else if (!$('#sheet').hidden) closeSheet();
});

document.addEventListener('toggle', (e) => {
  const d = e.target.closest?.('.exp-day');
  if (d) (state.expOpen ||= {})[d.dataset.expDay] = d.open;
}, true);
document.addEventListener('submit', (e) => {
  if (e.target.classList.contains('item-form')) { e.preventDefault(); return saveItemForm(); }
  if (e.target.classList.contains('exp-edit')) {
    e.preventDefault();
    const value = expValue(e.target);
    if (!value) return toast('금액을 입력해 주세요.');
    const f = new FormData(e.target);
    store.set('exp', expenses().map((x) => (x.id === e.target.dataset.id
      ? { ...x, ...expAmount(value, f.get('cur')), pay: f.get('pay'), cat: f.get('cat'), date: f.get('date') || x.date, time: String(f.get('time') || ''), memo: String(f.get('memo') || '').trim(), at: Date.now() }
      : x)));
    closeSheet();
    render();
    return toast('수정했어요');
  }
  if (e.target.hasAttribute('data-rcpt-save')) { e.preventDefault(); return saveRcptAi(e.target); }
  if (e.target.classList.contains('exp-form')) {
    e.preventDefault();
    const f = new FormData(e.target);
    const value = expValue(e.target);
    if (!value) return toast('금액을 입력해 주세요.');
    const item = e.target.dataset.expItem || null;
    addExpense({ value, cur: f.get('cur'), pay: f.get('pay'), memo: String(f.get('memo') || '').trim(), cat: f.get('cat'), item, date: item ? findItem(item)?.date : f.get('date') || undefined });
    toast('지출을 기록했어요');
    render();
    return;
  }
  if (e.target.classList.contains('finish')) {
    e.preventDefault();
    const it = findItem(e.target.dataset.expItem);
    const value = expValue(e.target);
    if (value) {
      const f = new FormData(e.target);
      addExpense({ value, cur: f.get('cur'), pay: f.get('pay'), memo: stripEmoji(it.title).split(' · ').pop(), cat: SCENE_CAT[sceneOf(it)] || '기타', item: it.id, date: it.date });
      toast('지출을 기록했어요');
    }
    render();
    const next = nextStop(it);
    if (next) openItem(next.id); else closeSheet();
    return;
  }
  if (e.target.id !== 'add-form') return;
  e.preventDefault();
  const text = $('#add-text').value.trim();
  if (!text) return;
  store.set('custom', [...store.get('custom', []), { id: uid('u-'), text }]);
  render();
  $('#add-text')?.focus();
});

$('#doc-file').addEventListener('change', async (e) => {
  let files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !(state.pendingDoc || state.pendingTitle)) return;
  let slotId = state.pendingDoc;
  if (state.pendingTitle) {
    slotId = uid('cdoc-');
    store.set('cdocs', [...store.get('cdocs', []), { id: slotId, title: state.pendingTitle }]);
    closeSheet();
  }
  if ((docSlot(slotId)?.max || 1) === 1) files = files.slice(0, 1);
  let saved = 0;
  try {
    for (const file of files) {
      if (!(await addDoc(slotId, file))) break;
      saved += 1;
    }
    if (saved) toast(`${saved}장 저장했어요 · 다른 폰과는 설정 › 동기화로 맞출 수 있어요`);
  } catch { toast('사진을 저장하지 못했어요. 저장 공간을 확인해 주세요.'); }
  state.pendingDoc = state.pendingTitle = null;
  render();
  if (slotId.startsWith('place-')) openPlace(slotId.slice(6));
  if (slotId.startsWith('rcpt-') && !$('#sheet').hidden) openExpEdit(slotId.slice(5));
});

$('#sync-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await importSync(file);
});

$('#viewer-track').addEventListener('scroll', () => { if (state.viewer) updateViewerCap(); }, { passive: true });

// Re-render every minute so "now / next" stays current while the app is open.
setInterval(() => { loadWeather(); loadFx(); if (state.tab === 'today' && $('#sheet').hidden) render(); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  loadWeather();
  loadFx();
  loadLatest();
  if (!['wallet', 'talk', 'check'].includes(state.tab)) render();
});

// Plays on first install (index.html), after an app update, and when the logo is tapped.
let introTimer;
function playIntro() {
  const el = $('#intro');
  introLine();
  el.hidden = false;
  window.flyIntro();
  clearTimeout(introTimer);
  introTimer = setTimeout(() => { el.hidden = true; }, 1900);
}
function introOnUpdate() {
  let seen;
  try { seen = localStorage.getItem('introVer'); localStorage.setItem('introVer', APP_VERSION); } catch { return; }
  if (seen && seen !== String(APP_VERSION) && !matchMedia('(prefers-reduced-motion: reduce)').matches) playIntro();
}

function introLine() {
  const line = $('#intro-line');
  if (!line) return;
  const { trip, days } = state.trip;
  const { date } = tokyoNow();
  // 서버에서 만든 여행은 여행 이름으로 (도쿄 여행은 그대로)
  const name = state.planOf ? trip.title : '도쿄 여행';
  const b = $('.intro-text b');
  if (b) b.textContent = name;
  document.title = name;
  if (date < trip.start) line.textContent = `D-${daysBetween(date, trip.start)}`;
  else if (date > trip.end) line.textContent = '다녀왔어요';
  else line.textContent = `${days.findIndex((d) => d.date === date) + 1}일차`;
}

async function init() {
  try {
    // 서버에서 만든 여행이면 폰에 저장해 둔 일정으로, 아니면 앱에 들어 있는 도쿄 일정 파일로 열어요
    const cached = store.get('cloudTrip', '') ? store.get('plan', null) : null;
    if (cached?.data?.days) { state.trip = planFill(cached.data); state.planOf = store.get('cloudTrip', ''); }
    else {
      const res = await fetch('data/trip.json', { cache: 'no-cache' });
      state.trip = await res.json();
      state.planOf = '';
    }
    introLine();
    introOnUpdate();
  } catch {
    $('#view').innerHTML = '<div class="empty">일정 데이터를 불러오지 못했어요.<br>인터넷에 연결된 상태로 한 번 열어 주세요.</div>';
    return;
  }
  const now = tokyoNow();
  const todayIdx = state.trip.days.findIndex((d) => d.date === now.date);
  state.dayIndex = todayIdx >= 0 ? todayIdx : Math.min(store.get('day', 0), state.trip.days.length - 1);
  const saved = store.get('tab', 'today');
  state.tab = TABS.includes(saved) ? saved : saved === 'info' ? 'wallet' : 'today';
  if (todayIdx >= 0) state.tab = 'today';
  state.wx = store.get('wx', null);
  state.wxlog = store.get('wxlog', null);
  if (state.wx && !state.wxlog) logWeather(state.wx);
  state.fx = store.get('fx', null);
  await refreshDocSlots();
  render();
  loadWeather();
  loadFx();
  loadClips();
  loadLatest();
  geoStart();
  cloudJoinFromUrl();
  authStart();
  srvCheck();
}

// ---------- 계정 (서버 버전 S-1: 로그인만) ----------
// 공개용 키라 앱에 들어가도 돼요. 무엇을 읽고 쓸 수 있는지는 DB 규칙(RLS)이 정해요.
const SB_URL = 'https://fdyqogadwtaqfthhnpyj.supabase.co';
const SB_KEY = 'sb_publishable_P4QnIKfw07z9zip5cbnDSw_Kx21KkPF';
const AUTH = { sb: null, user: null, nick: '', step: '', email: '', msg: '', ok: false, busy: false };
// 이메일 로그인: Supabase 기본 메일엔 숫자 코드가 없어 홈 화면 앱에선 못 씀 → 개인 도메인·메일 서버 연결 후 true
const EMAIL_LOGIN = false;
const PROVIDER_KO = { email: '이메일', kakao: '카카오', apple: 'Apple' };
function sb() {
  if (AUTH.sb || !window.supabase?.createClient) return AUTH.sb;
  // implicit: 메일 링크를 다른 브라우저에서 열어도 로그인돼요 (아이폰 홈 화면 앱은 사파리와 저장소가 달라서)
  AUTH.sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'sb-auth' } });
  AUTH.sb.auth.onAuthStateChange((ev, session) => {
    const was = AUTH.user?.id;
    AUTH.user = session?.user || null;
    if (AUTH.user && AUTH.user.id !== was) { AUTH.step = ''; AUTH.msg = ''; authProfile(); setTimeout(() => cloudStart(true)); }
    if (ev === 'SIGNED_IN' && !was) toast('로그인했어요');
    if (ev === 'SIGNED_OUT') { AUTH.nick = ''; if (CLOUD.chan) sb().removeChannel(CLOUD.chan); Object.assign(CLOUD, { trip: null, chan: null, state: 'off', live: false, members: [] }); cloudRefreshUi(); }
    accountRefresh();
  });
  return AUTH.sb;
}
async function authStart() {
  // 카카오·메일 링크에서 돌아왔는데 실패했으면 이유를 보여 줘요
  const q = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
  const err = q.get('error_description');
  if (!sb()) return;
  const { data } = await sb().auth.getSession();
  AUTH.user = data.session?.user || null;
  if (AUTH.user) { authProfile(); cloudStart(); }
  if (err) { toast('로그인하지 못했어요: ' + err.replace(/\+/g, ' ')); history.replaceState(null, '', location.pathname); }
}
async function authProfile() {
  if (!AUTH.user || !navigator.onLine) return;
  const { data } = await sb().from('profiles').select('nick, role').eq('id', AUTH.user.id).maybeSingle();
  if (data) { AUTH.nick = data.nick; AUTH.role = data.role; accountRefresh(); }
}
function accountRefresh() {
  const el = $('#sheet-body .acct-card');
  if (el) el.outerHTML = accountCard();
  cloudRefreshUi();
}
function authProviderOf(u) { return PROVIDER_KO[u?.app_metadata?.provider] || '이메일'; }
function accountCard() {
  const u = AUTH.user;
  const msg = AUTH.msg ? `<div class="ai-msg ${AUTH.ok ? 'ok' : ''}">${esc(AUTH.msg)}</div>` : '';
  if (u) {
    const name = myNick();
    return `<div class="card set-card acct-card">
      <div class="set-row"><span class="grow"><b>${esc(name)}${AUTH.role === 'admin' ? ' <small class="acct-admin">관리자</small>' : ''}</b><small>${esc(u.email || '이메일 없음')} · ${authProviderOf(u)}로 로그인</small></span>
        <button class="btn" data-auth-out>로그아웃</button></div>
      <button class="set-row tap" data-nick><span class="grow"><b>닉네임</b><small>여행메이트에게 보이고, 아침 인사에서 이렇게 불러요</small></span><em>${esc(myNick())}</em>${icon('pen')}</button>
    </div>`;
  }
  if (!window.supabase) return `<div class="card set-card acct-card"><div class="set-row"><span class="grow"><b>로그인</b><small>인터넷에 연결된 상태에서 앱을 한 번 다시 열어 주세요</small></span></div></div>`;
  if (AUTH.step === 'code') return `<div class="card set-card acct-card">
      <div class="set-row"><span class="grow"><b>메일 확인</b><small>${esc(AUTH.email)}로 보낸 메일의 숫자 코드를 넣어 주세요. 메일의 링크를 눌러도 돼요</small></span></div>
      <input class="input acct-code" id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="숫자 코드">
      <div class="btns"><button class="btn" data-auth-back>이메일 다시 입력</button><button class="btn primary" data-auth-verify ${AUTH.busy ? 'disabled' : ''}>확인</button></div>
      ${msg}
    </div>`;
  return `<div class="card set-card acct-card">
      <div class="set-row"><span class="grow"><b>로그인</b><small>로그인해 두면 일정·경비가 함께하는 폰에 바로 보이고, 폰을 바꿔도 남아요</small></span></div>
      <button class="btn wide acct-kakao" data-auth-kakao><span class="acct-kakao-mark" aria-hidden="true"></span>카카오로 로그인</button>
      ${EMAIL_LOGIN ? `<div class="acct-or"><span>또는 이메일</span></div>
      <input class="input" id="auth-email" type="email" inputmode="email" autocomplete="email" placeholder="이메일 주소" value="${esc(AUTH.email)}">
      <div class="btns"><button class="btn wide" data-auth-email ${AUTH.busy ? 'disabled' : ''}>로그인 코드 받기</button></div>` : ''}
      ${msg}
      <div class="small muted set-note">${EMAIL_LOGIN ? 'Apple 로그인은 준비 중이에요.' : '이메일·Apple 로그인은 준비 중이에요.'}</div>
    </div>`;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'auth-email') { e.preventDefault(); authEmail(); }
  else if (e.target.id === 'auth-code') { e.preventDefault(); authVerify(); }
});
async function authEmail() {
  const email = ($('#auth-email')?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { AUTH.msg = '이메일 주소를 확인해 주세요'; AUTH.ok = false; return accountRefresh(); }
  if (!navigator.onLine) { AUTH.msg = '인터넷에 연결된 뒤 다시 눌러 주세요'; AUTH.ok = false; return accountRefresh(); }
  AUTH.email = email; AUTH.busy = true; AUTH.msg = ''; accountRefresh();
  const { error } = await sb().auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
  AUTH.busy = false;
  if (error) { AUTH.msg = /rate|seconds/i.test(error.message) ? '메일을 너무 자주 보냈어요. 잠시 뒤 다시 눌러 주세요' : '메일을 보내지 못했어요: ' + error.message; AUTH.ok = false; }
  else { AUTH.step = 'code'; AUTH.msg = '메일을 보냈어요'; AUTH.ok = true; }
  accountRefresh();
  setTimeout(() => $('#auth-code')?.focus(), 50);
}
async function authVerify() {
  const token = ($('#auth-code')?.value || '').replace(/\D/g, '');
  if (token.length < 6) { AUTH.msg = '메일에 있는 숫자 코드를 모두 넣어 주세요'; AUTH.ok = false; return accountRefresh(); }
  AUTH.busy = true; accountRefresh();
  const { error } = await sb().auth.verifyOtp({ email: AUTH.email, token, type: 'email' });
  AUTH.busy = false;
  if (error) { AUTH.msg = /expired|invalid/i.test(error.message) ? '코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요' : error.message; AUTH.ok = false; accountRefresh(); }
}
async function authKakao() {
  if (!navigator.onLine) return toast('인터넷에 연결된 뒤 다시 눌러 주세요');
  const { error } = await sb().auth.signInWithOAuth({ provider: 'kakao', options: { redirectTo: location.origin + location.pathname } });
  if (error) toast('카카오 로그인을 열지 못했어요: ' + error.message);
}
async function authOut() {
  if (!(await askConfirm('로그아웃할까요?', { body: '이 폰에 저장된 일정·경비는 그대로 남아요.', ok: '로그아웃' }))) return;
  await sb().auth.signOut({ scope: 'local' });
  AUTH.user = null; AUTH.step = ''; AUTH.msg = '';
  accountRefresh();
  toast('로그아웃했어요');
}

// ---------- 서버 동기화 (서버 버전 S-2) ----------
// 파일 동기화와 같은 규칙: 기록마다 나중에 바꾼 쪽이 남고, 목록(경비·추가 일정·장소·자료)은 합치고, 지운 건 되살아나지 않아요.
// 서버 표: trip_kv(함께 쓰는 기록) · trip_secrets(예약번호·eSIM·자료 목록) · 비공개 사진 저장소 docs/<여행>/<사진>
const TRIP_SLUG = 'tokyo-2026-11';
const SECRET_KEYS = ['pnr', 'agoda', 'esim1', 'esim2', 'cdocs'];
const CLOUD = { trip: null, trips: [], role: '', members: [], link: null, mateOpen: '', mateAll: false, chan: null, busy: false, again: false, state: 'off', err: '', at: 0, cursor: '', invite: '', form: false };

// ---------- 여러 여행 (서버 버전 S-5) ----------
// 일정 원본: 도쿄 여행은 앱에 들어 있는 data/trip.json (요청함으로 고치는 그대로), 새로 만든 여행은 서버 trips.plan.
// 이 폰 기록은 여행마다 따로: 여행을 바꾸면 지금 여행 기록·사진을 폰 안에 접어 두고(stash) 고른 여행 것을 펼쳐요.
// 아래 키는 여행과 상관없는 이 폰 설정·로그인이라 그대로 둬요.
const GLOBAL_KEYS = new Set(['aiModel', 'aiKey', 'gKey', 'deskKey', 'who', 'myNick', 'srvKeys', 'usageQ', 'cloudJoin', 'cloudTrip', 'reqLast', 'fx', 'talkText', 'geoOn', 'introVer', 'wxCard', 'lastPay', 'tab', 'routeOff', 'routeErr']);
const isGlobalKey = (k) => GLOBAL_KEYS.has(k) || k.startsWith('sb-') || k.startsWith('stash:');
const STASH = 'stash|';
// 빠진 칸을 채워서 빈 여행도 화면이 깨지지 않게
function planFill(p) {
  const t = p.trip || {};
  const stay = { name: '', nameJa: '', query: '', checkIn: '', checkOut: '', nights: 0, breakfast: '', stations: [], address: '', addressKo: '', phone: '', bookedVia: '', ...(p.stay || {}) };
  // 지갑 탭 경비는 '비용' 안내 하나를 꼭 찾아요
  const guides = Array.isArray(p.guides) ? p.guides : [];
  if (!guides.some((g) => g.costs)) guides.push({ title: '여행 비용', icon: '💴', lines: [], costs: [], costNote: '', cash: { yen: 0, label: '현금 환전' }, paid: [] });
  return {
    flights: [], checklist: [], links: {}, docs: [], phrases: [], transfers: [], emergency: [], places: [], phraseSteps: {}, sources: {}, unresolved: [],
    ...p, guides, links: { jejuair: { label: '항공권 예약 확인', url: 'https://www.google.com/travel/flights' }, agoda: { label: '숙소 예약 확인', url: 'https://www.google.com/travel/hotels' }, ...(p.links || {}) }, trip: { travelers: 2, timezone: TZ, ...t }, stay, budget: { yen: 0, note: '', ...(p.budget || {}) }, days: Array.isArray(p.days) ? p.days : [],
  };
}
const dateAdd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function blankPlan(title, start, end) {
  const n = daysBetween(start, end) + 1;
  const base = state.trip || {};
  return planFill({
    trip: { id: '', title, start, end, travelers: 2, timezone: TZ, infoAsOf: '' },
    stay: { nights: n - 1 },
    days: Array.from({ length: n }, (_, i) => ({ date: dateAdd(start, i), title: `${i + 1}일차`, items: [] })),
    // 일본 여행 공용: 회화·긴급 연락처는 그대로 가져가요
    phrases: base.phrases || [], phraseSteps: base.phraseSteps || {}, emergency: base.emergency || [],
  });
}
// 지금 여행의 이 폰 기록·사진을 접어 두고, 고른 여행 것을 펼쳐요
async function tripStashSwap(from, to) {
  const out = {};
  for (const k of Object.keys(localStorage)) if (!isGlobalKey(k)) out[k] = localStorage.getItem(k);
  localStorage.setItem('stash:' + from, JSON.stringify(out)); // 저장 공간이 모자라면 여기서 멈춰서 아무것도 안 바뀌어요
  for (const k of Object.keys(out)) localStorage.removeItem(k);
  const back = JSON.parse(localStorage.getItem('stash:' + to) || '{}');
  for (const [k, v] of Object.entries(back)) localStorage.setItem(k, v);
  localStorage.removeItem('stash:' + to);
  // 사진: 먼저 지금 여행 것을 접고, 그다음 고른 여행 것을 펼쳐요 (같은 이름이 겹치지 않게 두 번에 나눠서)
  const move = async (pick, rename) => {
    const all = (await docs.run('readonly', (s) => s.getAllKeys())).map(String).filter(pick);
    if (!all.length) return;
    await docs.run('readwrite', (s) => {
      let r;
      for (const k of all) { const g = s.get(k); g.onsuccess = () => { s.put(g.result, rename(k)); s.delete(k); }; r = g; }
      return r;
    });
  };
  const toPre = `${STASH}${to}|`;
  await move((k) => !k.startsWith(STASH), (k) => `${STASH}${from}|${k}`);
  await move((k) => k.startsWith(toPre), (k) => k.slice(toPre.length));
}
// 일정을 화면에 반영 (오늘 날짜면 그날로)
function tripPlanShow(plan, of) {
  state.trip = planFill(plan);
  state.planOf = of;
  const todayIdx = state.trip.days.findIndex((d) => d.date === tokyoNow().date);
  state.dayIndex = todayIdx >= 0 ? todayIdx : 0;
  introLine();
  refreshDocSlots().catch(() => {});
  render();
}
const strHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return `${s.length}.${h}`; };
// 여행을 연결할 때 일정 맞추기
async function tripPlanSync(trip) {
  if (trip.slug === TRIP_SLUG) {
    // 도쿄 여행: 앱 파일이 원본. 화면이 다른 여행 일정이면 파일로 돌아오고, 파일이 바뀌었으면 서버에도 올려 둬요 (네이티브·어드민용)
    if (state.planOf) {
      const res = await fetch('data/trip.json', { cache: 'no-cache' });
      tripPlanShow(await res.json(), '');
    }
    const h = strHash(JSON.stringify(state.trip));
    if (CLOUD.role !== 'viewer' && store.get('planPushed', '') !== h) {
      const { error } = await sb().from('trips').update({ plan: state.trip, plan_rev: (trip.plan_rev || 1) + 1 }).eq('id', trip.id);
      if (!error) store.set('planPushed', h);
    }
    return;
  }
  const cached = store.get('plan', null);
  if (cached?.rev === trip.plan_rev && cached.data?.days) {
    if (state.planOf !== trip.id) tripPlanShow(cached.data, trip.id);
    return;
  }
  const { data, error } = await sb().from('trips').select('plan, plan_rev').eq('id', trip.id).single();
  if (error) throw error;
  store.set('plan', { rev: data.plan_rev, data: data.plan });
  tripPlanShow(data.plan, trip.id);
}
// 다른 여행으로 바꾸기: 보낼 기록은 먼저 보내 보고(안 돼도 접어 둔 채로 남았다가 돌아오면 보내요), 접고 펼친 뒤 다시 연결
async function tripSwitch(id) {
  if (!id || id === CLOUD.trip?.id || CLOUD.switching) return;
  CLOUD.switching = true;
  try {
    if (CLOUD.trip && navigator.onLine) { await cloudSync(); while (CLOUD.busy) await new Promise((r) => setTimeout(r, 200)); }
    const from = store.get('cloudTrip', '') || 'none';
    const cachedPlan = JSON.parse(localStorage.getItem('stash:' + id) || '{}').plan;
    const target = CLOUD.trips.find((t) => t.id === id);
    if (!navigator.onLine && target?.slug !== TRIP_SLUG && !cachedPlan) return toast('처음 여는 여행은 인터넷에 연결된 뒤 바꿀 수 있어요');
    if (CLOUD.chan) { sb().removeChannel(CLOUD.chan); CLOUD.chan = null; }
    CLOUD.trip = null;
    await tripStashSwap(from, id);
    store.set('cloudTrip', id);
    const plan = store.get('plan', null);
    if (target?.slug === TRIP_SLUG) tripPlanShow(await (await fetch('data/trip.json')).json(), '');
    else if (plan?.data?.days) tripPlanShow(plan.data, id);
    CLOUD.form = false;
    await cloudStart(true);
    toast(`'${target?.title || '여행'}'으로 바꿨어요`);
  } catch (e) {
    toast('여행을 바꾸지 못했어요. 저장 공간을 확인해 주세요');
  } finally { CLOUD.switching = false; cloudRefreshUi(); }
}
async function tripCreate() {
  if (!AUTH.user) return toast('먼저 카카오로 로그인해 주세요');
  if (!navigator.onLine) return toast('인터넷에 연결된 뒤 다시 눌러 주세요');
  const title = ($('#nt-title')?.value || '').trim();
  const { start, end } = NT;
  if (!title) return toast('여행 이름을 적어 주세요');
  if (!start) return toast('달력에서 가는 날을 눌러 주세요');
  if (!end) return toast('달력에서 오는 날을 눌러 주세요');
  if (daysBetween(start, end) > 29) return toast('여행은 30일까지 만들 수 있어요');
  const plan = blankPlan(title.slice(0, 40), start, end);
  const { data, error } = await sb().from('trips').insert({ title: title.slice(0, 40), start_date: start, end_date: end, timezone: TZ, plan }).select('id, title, slug, owner_id, start_date, end_date, plan_rev').single();
  if (error) return toast('여행을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요');
  CLOUD.trips = [data, ...CLOUD.trips];
  // 새 여행은 빈 기록으로 시작: 일정은 바로 보이게 미리 넣어 둬요
  localStorage.setItem('stash:' + data.id, JSON.stringify({ plan: JSON.stringify({ rev: data.plan_rev, data: plan }) }));
  await tripSwitch(data.id);
}
function tripListHtml() {
  if (!CLOUD.trips.length) return '';
  const fmt = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '');
  const cur = CLOUD.trip?.id || store.get('cloudTrip', '');
  return `<div class="trip-list">${CLOUD.trips.map((t) => `<div class="set-row trip-row${t.id === cur ? ' on' : ''}">
      <span class="grow"><b>${esc(t.title)}</b><small>${fmt(t.start_date)}~${fmt(t.end_date)}${t.owner_id === AUTH.user.id ? '' : ' · 초대받은 여행'}</small></span>
      ${t.id === cur ? '<span class="trip-now">보는 중</span>' : `<button class="btn" data-trip-open="${esc(t.id)}" ${CLOUD.switching ? 'disabled' : ''}>열기</button>`}</div>`).join('')}</div>`;
}
function tripFormHtml() {
  if (!CLOUD.form) return `<div class="btns"><button class="btn wide" data-trip-new>${icon('plus')}새 여행 만들기</button></div>`;
  return `<div class="trip-form">
      <label class="small muted">여행 이름<input class="input" id="nt-title" maxlength="40" placeholder="예: 오사카 3박 4일" value="${esc(NT.title)}" oninput="NT.title=this.value"></label>
      ${ntPickHtml()}
      <div class="small muted set-note">날짜별 빈 일정이 만들어져요. 일정은 일정 탭에서 추가하거나 AI 도우미로 짜요. 지금 여행 기록은 그대로 남아 있다가 다시 열면 돌아와요.</div>
      <div class="btns"><button class="btn" data-trip-cancel>취소</button><button class="btn primary" data-trip-create ${NT.start && NT.end ? '' : 'disabled'}>만들기</button></div>
    </div>`;
}
// 여행 날짜 고르기: 항공권·숙소 예약 사이트처럼 달력에서 가는 날 → 오는 날을 차례로 누르면 기간이 칠해져요
const NT = { title: '', start: '', end: '', month: '' };
const ntLabel = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일 (${WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()]})`;
function ntPickHtml() {
  const today = tokyoNow().date;
  const m = NT.month || (NT.start || today).slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const nights = NT.start && NT.end ? daysBetween(NT.start, NT.end) : -1;
  const next = !NT.start ? 'start' : !NT.end ? 'end' : 'done';
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let n = 1; n <= count; n++) {
    const d = `${m}-${String(n).padStart(2, '0')}`;
    const dow = (lead + n - 1) % 7;
    const past = d < today;
    const tooLong = next === 'end' && daysBetween(NT.start, d) > 29;
    const cls = ['nt-day', dow === 0 ? 'sun' : dow === 6 ? 'sat' : '', d === today ? 'today' : '',
      d === NT.start ? 'start' : '', d === NT.end ? 'end' : '', NT.start && NT.end && d > NT.start && d < NT.end ? 'in' : '',
      NT.start && NT.end && NT.start !== NT.end ? 'range' : ''].filter(Boolean).join(' ');
    const tag = d === NT.start && d === NT.end ? '당일' : d === NT.start ? '가는 날' : d === NT.end ? '오는 날' : '';
    cells.push(`<button type="button" class="${cls}" data-nt-day="${d}" ${past || tooLong ? 'disabled' : ''} aria-label="${ntLabel(d)}${tag ? ' ' + tag : ''}"><b>${n}</b>${tag ? `<i>${tag}</i>` : ''}</button>`);
  }
  const canPrev = m > today.slice(0, 7);
  return `<div class="nt-pick" id="nt-pick">
      <div class="nt-sum">
        <button type="button" class="nt-box ${next === 'start' ? 'on' : ''}" data-nt-reset><small>가는 날</small><b>${NT.start ? ntLabel(NT.start) : '날짜 선택'}</b></button>
        <span class="nt-nights">${nights >= 0 ? (nights ? `${nights}박 ${nights + 1}일` : '당일') : ''}</span>
        <div class="nt-box ${next === 'end' ? 'on' : ''}"><small>오는 날</small><b>${NT.end ? ntLabel(NT.end) : '날짜 선택'}</b></div>
      </div>
      <div class="nt-hint small muted">${next === 'start' ? '달력에서 가는 날을 눌러 주세요' : next === 'end' ? '이제 오는 날을 눌러 주세요 · 당일치기는 같은 날을 한 번 더' : '다른 날을 누르면 가는 날부터 다시 골라요'}</div>
      <div class="nt-cal">
        <div class="nt-head"><button type="button" class="nt-nav" data-nt-month="-1" ${canPrev ? '' : 'disabled'} aria-label="이전 달">‹</button><b>${y}년 ${mo}월</b><button type="button" class="nt-nav" data-nt-month="1" aria-label="다음 달">›</button></div>
        <div class="nt-week">${WEEKDAYS.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
        <div class="nt-grid">${cells.join('')}</div>
      </div>
    </div>`;
}
function ntRefresh() {
  const el = $('#nt-pick');
  if (el) el.outerHTML = ntPickHtml();
  const go = $('[data-trip-create]');
  if (go) go.disabled = !(NT.start && NT.end);
}
function ntTap(d) {
  if (!d) return;
  // 처음 누르거나 기간이 다 정해진 뒤 누르면 가는 날부터 다시, 가는 날보다 앞을 누르면 가는 날을 옮겨요
  if (!NT.start || NT.end || d < NT.start) { NT.start = d; NT.end = ''; }
  else NT.end = d;
  ntRefresh();
}
function ntMonth(step) {
  const base = NT.month || (NT.start || tokyoNow().date).slice(0, 7);
  const [y, mo] = base.split('-').map(Number);
  const x = new Date(Date.UTC(y, mo - 1 + step, 1));
  NT.month = x.toISOString().slice(0, 7);
  ntRefresh();
}
// 바꾼 기록은 1.5초 모아서 보내요. 서버 연결 전이면 그냥 폰에 남아 있다가 연결되면 보내요.
function cloudSoon() { clearTimeout(cloudSoon.t); cloudSoon.t = setTimeout(() => { try { cloudSync(); } catch { /* not ready */ } }, 1500); }
const cloudTable = (k) => (SECRET_KEYS.includes(k) ? 'trip_secrets' : 'trip_kv');
const cloudSent = () => store.get('cloudSent', {});
const docName = (k) => encodeURIComponent(k).replace(/%/g, '!');
const docKey = (n) => decodeURIComponent(n.replace(/!/g, '%'));
function cloudPending() {
  if (!CLOUD.trip) return 0;
  const meta = store.get('meta', {}), sent = cloudSent();
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (isShared(k) && (meta[k] || 1) > (sent[k] || 0)) n += 1; }
  if (JSON.stringify(store.get('tomb', {})) !== (sent.__tomb || '{}')) n += 1;
  return n;
}
// 서버에서 온 기록 하나를 이 폰 기록과 합쳐요. 바뀌었으면 true.
function cloudMerge(k, r) {
  if (!r || typeof r !== 'object' || !('t' in r)) return false;
  const meta = store.get('meta', {}), sent = cloudSent();
  const lt = meta[k] || 0;
  if (k === 'tomb') {
    const tomb = { ...store.get('tomb', {}) };
    let changed = false;
    for (const [id, t] of Object.entries(r.v || {})) if ((tomb[id] || 0) < t) { tomb[id] = t; changed = true; }
    if (changed) {
      localStorage.setItem('tomb', JSON.stringify(tomb));
      for (const lk of MERGED_LISTS) {
        const list = store.get(lk, []);
        const kept = list.filter((x) => !tomb[`${lk}:${x.id}`]);
        if (kept.length !== list.length) localStorage.setItem(lk, JSON.stringify(kept));
      }
    }
    // 서버 것과 같아졌으면 다시 보낼 필요 없음
    if (Object.entries(tomb).every(([id, t]) => (r.v || {})[id] >= t)) store.set('cloudSent', { ...cloudSent(), __tomb: JSON.stringify(tomb) });
    return changed;
  }
  if (!isShared(k)) return false;
  if (MERGED_LISTS.includes(k)) {
    const tomb = store.get('tomb', {});
    const mine = store.get(k, []), theirs = Array.isArray(r.v) ? r.v : [];
    const byId = new Map(mine.map((x) => [x.id, x]));
    for (const x of theirs) { const m = byId.get(x.id); if (!m || (x.at || 0) > (m.at || 0)) byId.set(x.id, x); }
    const merged = [...byId.values()].filter((x) => !tomb[`${k}:${x.id}`]);
    const local = JSON.stringify(merged) !== JSON.stringify(mine);
    const canon = (l) => JSON.stringify([...l].sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const same = canon(merged) === canon(theirs);
    // 서버와 같아졌으면 다시 보낼 필요 없음, 이 폰에만 있던 게 섞였으면 합친 목록을 다시 보내요
    const t = same ? Math.max(r.t, lt) : Date.now();
    if (local || same) { localStorage.setItem(k, JSON.stringify(merged)); store.set('meta', { ...meta, [k]: t }); }
    if (same) store.set('cloudSent', { ...sent, [k]: t });
    return local;
  }
  if (r.t > lt) {
    localStorage.setItem(k, JSON.stringify(r.v));
    store.set('meta', { ...meta, [k]: r.t });
    store.set('cloudSent', { ...sent, [k]: r.t });
    return true;
  }
  if (r.t === lt) store.set('cloudSent', { ...sent, [k]: r.t });
  return false;
}
// 이 폰이 연결된 여행 찾기 (멤버인 여행만 보여요)
// 고르는 순서: 방금 초대받은 여행 → 이 폰이 보던 여행 → 도쿄 여행 → 가장 최근 여행
async function cloudFindTrip(prefer = '') {
  const { data: list, error } = await sb().from('trips').select('id, title, slug, owner_id, start_date, end_date, plan_rev').order('start_date', { ascending: false, nullsFirst: false });
  if (error) throw error;
  CLOUD.trips = list || [];
  const want = prefer || store.get('cloudTrip', '');
  const data = CLOUD.trips.find((t) => t.id === want) || CLOUD.trips.find((t) => t.slug === TRIP_SLUG) || CLOUD.trips[0];
  if (!data) return null;
  await cloudMembers(data);
  return data;
}
// 여행메이트 목록: 들어온 순서대로 색 점, 이름은 계정 닉네임. 나간 사람 이름은 이 폰에 남겨 둬요(지난 기록용).
async function cloudMembers(trip) {
  const { data: mem } = await sb().from('trip_members').select('user_id, role, joined_at').eq('trip_id', trip.id).order('joined_at');
  const { data: pro } = await sb().from('profiles').select('id, nick').in('id', (mem || []).map((m) => m.user_id));
  const nick = new Map((pro || []).map((p) => [p.id, p.nick]));
  CLOUD.members = (mem || []).map((m, i) => ({ id: m.user_id, role: m.role, nick: nick.get(m.user_id) || '여행자', color: MATE_COLORS[i % MATE_COLORS.length] }));
  CLOUD.role = CLOUD.members.find((m) => m.id === AUTH.user.id)?.role || '';
  if (CLOUD.members.length) store.set('mateNames', { ...store.get('mateNames', {}), ...Object.fromEntries(CLOUD.members.map((m) => [m.id, m.nick])) });
  CLOUD.link = null;
  if (CLOUD.role === 'owner') inviteLoad(trip.id).then((l) => { CLOUD.link = l; cloudRefreshUi(); });
}
// 로그인 전에 남긴 기록('me')을 내 계정 기록으로 옮겨요
function claimMine() {
  const id = AUTH.user?.id;
  if (!id) return;
  const ex = expenses();
  if (ex.some((e) => e.by === 'me')) store.set('exp', ex.map((e) => (e.by === 'me' ? { ...e, by: id } : e)));
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const k = localStorage.key(i);
    if (k?.startsWith('visit:')) { const v = store.get(k, null); if (v?.by === 'me') store.set(k, { ...v, by: id }); }
    else if (k?.startsWith('gear:') && k.endsWith(':me')) { const v = store.get(k, null); if (v) store.set(k.slice(0, -2) + id, { ...v, ...store.get(k.slice(0, -2) + id, {}) }); store.set(k, null); }
  }
}
async function cloudCreateTrip() {
  if (!AUTH.user) return toast('먼저 카카오로 로그인해 주세요');
  if (!navigator.onLine) return toast('인터넷에 연결된 뒤 다시 눌러 주세요');
  const t = state.trip.trip;
  const { error } = await sb().from('trips').insert({ slug: TRIP_SLUG, title: t.title, start_date: t.start, end_date: t.end, timezone: t.timezone || TZ, plan: state.trip });
  if (error) { toast(/duplicate|unique/i.test(error.message) ? '이미 서버에 여행이 있어요. 함께하는 사람에게 초대 링크를 받아 열어 주세요' : '여행을 만들지 못했어요: ' + error.message); return; }
  store.set('cloudSent', {});
  await cloudStart(true);
  toast('서버에 여행을 만들고 이 폰 기록을 올렸어요');
}
// 로그인 상태가 바뀌거나 앱을 열면: 여행 찾기 → 처음엔 전부 받아 합치기 → 보낼 것 보내기 → 실시간 구독
async function cloudStart(force = false) {
  if (CLOUD.starting) return CLOUD.starting;
  CLOUD.starting = cloudStartRun(force).finally(() => { CLOUD.starting = null; });
  return CLOUD.starting;
}
async function cloudStartRun(force) {
  if (!AUTH.user || !navigator.onLine) { CLOUD.state = AUTH.user ? 'offline' : 'off'; return cloudRefreshUi(); }
  try {
    const join = store.get('cloudJoin', '');
    let joined = '';
    if (join) {
      const { data, error } = await sb().rpc('join_trip', { invite: join });
      store.set('cloudJoin', '');
      joined = error ? '' : data || '';
      if (error) toast('이 초대 링크는 끝났어요. 초대한 분께 새 링크를 부탁해 주세요');
    }
    const trip = await cloudFindTrip(joined);
    if (!trip) { CLOUD.trip = null; CLOUD.state = 'none'; return cloudRefreshUi(); }
    const cur = store.get('cloudTrip', '');
    if (cur !== trip.id) {
      // 처음 연결하는 도쿄 여행이면 이 폰 기록을 그대로 합치고, 그 밖엔 지금 기록을 접어 두고 바꿔요
      if (!cur && trip.slug === TRIP_SLUG) { store.set('cloudSent', {}); store.set('cloudCursor', ''); }
      else { if (CLOUD.chan) { sb().removeChannel(CLOUD.chan); CLOUD.chan = null; } CLOUD.trip = null; await tripStashSwap(cur || 'none', trip.id); }
      store.set('cloudTrip', trip.id);
    }
    const fresh = !CLOUD.trip || force;
    CLOUD.trip = trip;
    if (fresh) cloudSubscribe();
    claimMine();
    await tripPlanSync(trip);
    await cloudSync(true);
    if (joined) inviteWelcome(trip);
  } catch (e) { CLOUD.state = 'error'; CLOUD.err = e.message || String(e); cloudRefreshUi(); }
}
function cloudSubscribe() {
  if (CLOUD.chan) sb().removeChannel(CLOUD.chan);
  const id = CLOUD.trip.id;
  const on = (payload) => {
    const row = payload.new;
    if (!row?.key) return;
    if (row.updated_by === AUTH.user?.id && row.value?.t === store.get('meta', {})[row.key]) return;
    if (row.updated_at > (store.get('cloudCursor', '') || '')) store.set('cloudCursor', row.updated_at);
    if (cloudMerge(row.key, row.value)) cloudRendered();
  };
  CLOUD.chan = sb().channel('trip-' + id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_kv', filter: `trip_id=eq.${id}` }, on)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_secrets', filter: `trip_id=eq.${id}` }, on)
    // 다른 사람이 일정 원본을 바꾸면 (새로 만든 여행만, 도쿄는 앱 파일이 원본)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${id}` }, (payload) => {
      const row = payload.new;
      if (!row || CLOUD.trip?.id !== row.id) return;
      CLOUD.trip = { ...CLOUD.trip, title: row.title, plan_rev: row.plan_rev };
      if (row.slug === TRIP_SLUG || store.get('plan', null)?.rev === row.plan_rev) return;
      if (!row.plan?.days) { tripPlanSync(CLOUD.trip).catch(() => {}); return; } // 큰 일정은 실시간으로 안 실려 와서 따로 받아요
      store.set('plan', { rev: row.plan_rev, data: row.plan });
      state.trip = planFill(row.plan);
      cloudRendered();
    })
    .subscribe((st) => { if (st === 'SUBSCRIBED') { CLOUD.live = true; cloudRefreshUi(); } else if (st === 'CLOSED' || st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') { CLOUD.live = false; cloudRefreshUi(); } });
}
// 받은 기록이 화면에 보이게: 입력 중이면 입력이 끝난 뒤에 다시 그려요
function cloudRendered() {
  refreshDocSlots().catch(() => {});
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { CLOUD.renderLater = true; return; }
  render();
}
document.addEventListener('focusout', () => { if (CLOUD.renderLater) setTimeout(() => { if (!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) { CLOUD.renderLater = false; render(); } }, 300); });
// 받기 → 보내기 → 사진. 동시에 두 번 돌지 않아요.
async function cloudSync(full = false) {
  if (!CLOUD.trip || !AUTH.user || !navigator.onLine) { if (CLOUD.trip) { CLOUD.state = 'offline'; cloudRefreshUi(); } return; }
  if (CLOUD.busy) { CLOUD.again = true; return; }
  CLOUD.busy = true; CLOUD.state = 'syncing'; cloudRefreshUi();
  try {
    const id = CLOUD.trip.id;
    let changed = false;
    // 1. 받기 (처음엔 전부, 그다음엔 마지막으로 받은 시각 이후만)
    const cursor = full ? '' : store.get('cloudCursor', '');
    for (const table of ['trip_kv', 'trip_secrets']) {
      let q = sb().from(table).select('key, value, updated_at').eq('trip_id', id).order('updated_at').limit(1000);
      if (cursor) q = q.gt('updated_at', cursor);
      const { data, error } = await q;
      if (error) throw error;
      for (const row of data || []) {
        if (cloudMerge(row.key, row.value)) changed = true;
        if (row.updated_at > (store.get('cloudCursor', '') || '')) store.set('cloudCursor', row.updated_at);
      }
    }
    // 2. 보내기
    const meta = store.get('meta', {}), sent = { ...cloudSent() };
    const rows = { trip_kv: [], trip_secrets: [] };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!isShared(k)) continue;
      const t = meta[k] || 1;
      if (t > (sent[k] || 0)) rows[cloudTable(k)].push({ trip_id: id, key: k, value: { v: store.get(k, null), t } });
    }
    const tombStr = JSON.stringify(store.get('tomb', {}));
    if (tombStr !== (sent.__tomb || '{}')) rows.trip_kv.push({ trip_id: id, key: 'tomb', value: { v: store.get('tomb', {}), t: Date.now() } });
    for (const [table, list] of Object.entries(rows)) {
      for (let i = 0; i < list.length; i += 200) {
        const { error } = await sb().from(table).upsert(list.slice(i, i + 200), { onConflict: 'trip_id,key' });
        if (error) throw error;
      }
      for (const r of list) { if (r.key === 'tomb') sent.__tomb = tombStr; else sent[r.key] = r.value.t; }
    }
    store.set('cloudSent', sent);
    // 3. 사진
    if (await cloudPhotos()) changed = true;
    CLOUD.state = 'ok'; CLOUD.err = ''; CLOUD.at = Date.now();
    if (changed) cloudRendered();
  } catch (e) {
    CLOUD.state = 'error'; CLOUD.err = e.message || String(e);
  } finally {
    CLOUD.busy = false;
    cloudRefreshUi();
    if (CLOUD.again) { CLOUD.again = false; setTimeout(() => cloudSync(), 300); }
  }
}
// 바우처·문서·영수증 사진: 없는 쪽으로 올리고 받고, 지운 건 양쪽에서 지워요
async function cloudPhotos() {
  const id = CLOUD.trip.id;
  const bucket = sb().storage.from('docs');
  const { data: files, error } = await bucket.list(id, { limit: 1000 });
  if (error) throw error;
  const remote = new Set((files || []).map((f) => docKey(f.name)));
  const local = new Set(await docs.keys());
  const tomb = store.get('tomb', {});
  let changed = false;
  const gone = [...remote].filter((k) => tomb['doc:' + k]);
  if (gone.length && CLOUD.role !== 'viewer') await bucket.remove(gone.map((k) => `${id}/${docName(k)}`));
  for (const k of local) {
    if (tomb['doc:' + k]) { await docs.run('readwrite', (st) => st.delete(k)); changed = true; continue; }
    if (remote.has(k) || CLOUD.role === 'viewer') continue;
    const blob = await docs.get(k);
    const { error: up } = await bucket.upload(`${id}/${docName(k)}`, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
    if (up && !/exist|duplicate/i.test(up.message)) throw up;
  }
  for (const k of remote) {
    if (local.has(k) || tomb['doc:' + k]) continue;
    const { data: blob, error: dl } = await bucket.download(`${id}/${docName(k)}`);
    if (dl) continue;
    await docs.run('readwrite', (st) => st.put(blob, k));
    changed = true;
  }
  return changed;
}
// 여행마다 공통 초대 링크 하나: 7일 동안 여러 명이 써요. 여행 마스터만 보내고 끌 수 있어요.
async function inviteLoad(tripId) {
  const { data, error } = await sb().from('trip_invites').select('code, expires_at, uses').eq('trip_id', tripId).is('revoked_at', null)
    .gt('expires_at', new Date().toISOString()).order('expires_at', { ascending: false }).limit(1);
  if (error) return null;
  const l = data?.[0];
  return l ? { code: l.code, until: l.expires_at, uses: l.uses || 0 } : null;
}
const inviteUrl = (code) => `${location.origin}${location.pathname}?join=${code}`;
const mdOf = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
async function cloudInvite() {
  if (!CLOUD.trip || CLOUD.role !== 'owner') return;
  if (!navigator.onLine) return toast('인터넷에 연결된 뒤 다시 눌러 주세요');
  let link = CLOUD.link || await inviteLoad(CLOUD.trip.id);
  if (!link) {
    const { data, error } = await sb().from('trip_invites').insert({ trip_id: CLOUD.trip.id }).select('code, expires_at').single();
    if (error) return toast('초대 링크를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요');
    link = { code: data.code, until: data.expires_at, uses: 0 };
  }
  CLOUD.link = link; cloudRefreshUi();
  const url = inviteUrl(link.code);
  const name = CLOUD.trip.title || '여행';
  const text = `'${name}'에 함께해요. 링크를 열고 카카오로 시작하면 바로 들어와져요 (${mdOf(link.until)}까지)\n${url}`;
  try {
    if (navigator.share) await navigator.share({ title: `${name} 초대`, text });
    else { await navigator.clipboard.writeText(text); toast('초대 링크를 복사했어요. 단톡방에 붙여 넣어 주세요'); }
  } catch (e) { if (e.name !== 'AbortError') { CLOUD.invite = url; cloudRefreshUi(); } }
}
async function inviteOff() {
  if (!CLOUD.link) return;
  if (!(await askConfirm('초대 링크를 끌까요?', { body: '이미 들어온 여행메이트는 그대로예요. 다시 보내면 새 링크가 만들어져요.', ok: '끄기', danger: true }))) return;
  const { error } = await sb().from('trip_invites').update({ revoked_at: new Date().toISOString() }).eq('code', CLOUD.link.code);
  if (error) return toast('링크를 끄지 못했어요. 잠시 뒤 다시 해 주세요');
  CLOUD.link = null; CLOUD.invite = ''; cloudRefreshUi(); toast('초대 링크를 껐어요');
}
// 초대 링크로 열었을 때: 로그인 전에도 여행 이름·날짜·초대한 사람·인원을 보여 주고, 한 번 누르면 들어가요
const INV = { code: '', info: null, err: '', busy: false };
function cloudJoinFromUrl() {
  const q = new URLSearchParams(location.search);
  const code = (q.get('join') || '').trim();
  if (!code) return;
  q.delete('join');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  setTimeout(() => inviteOpen(code), 500);
}
const inviteCodeOf = (txt) => (String(txt).match(/join=([0-9a-z]{6,})/i)?.[1] || String(txt).trim().match(/^[0-9a-z]{6,32}$/i)?.[0] || '').toLowerCase();
async function inviteAsk() {
  const v = await askText('초대 코드 입력', '', { body: '받은 초대 링크를 통째로 붙여 넣거나, 링크 끝의 12자리 코드를 넣어 주세요.', placeholder: '초대 링크 또는 코드' });
  if (v === null) return;
  const code = inviteCodeOf(v);
  if (!code) return toast('초대 코드를 찾지 못했어요. 링크를 다시 확인해 주세요');
  inviteOpen(code);
}
async function inviteOpen(code) {
  Object.assign(INV, { code, info: null, err: '', busy: false });
  inviteDraw();
  if (!sb() || !navigator.onLine) { INV.err = 'offline'; return inviteDraw(); }
  const { data, error } = await sb().rpc('invite_preview', { invite: code });
  // 미리보기를 못 받아도(서버 준비 전) 들어가기는 할 수 있게 빈 카드로 보여 줘요
  INV.info = error ? {} : data;
  if (!error && !data) INV.err = 'gone';
  else if (data && data.live === false) INV.err = 'gone';
  inviteDraw();
}
function inviteClose() { const el = $('#invite'); if (el) el.hidden = true; }
function inviteDraw() {
  let el = $('#invite');
  if (!el) { el = document.createElement('div'); el.id = 'invite'; el.className = 'ask invite'; document.body.appendChild(el); }
  const i = INV.info;
  const dates = i?.start ? `${dayLabel(i.start)} ~ ${dayLabel(i.end)}` : '';
  const body = INV.err === 'offline' ? `<b class="ask-t">인터넷에 연결해 주세요</b><p class="ask-s">초대 링크를 확인하려면 인터넷이 필요해요. 연결된 뒤 링크를 다시 열어 주세요.</p>
      <div class="ask-bs one"><button type="button" class="btn primary" data-inv-close>닫기</button></div>`
    : INV.err === 'gone' ? `<b class="ask-t">이 초대 링크는 끝났어요</b><p class="ask-s">기간(7일)이 지났거나 여행 마스터가 링크를 껐어요. 초대한 분께 새 링크를 부탁해 주세요.</p>
      <div class="ask-bs one"><button type="button" class="btn primary" data-inv-close>닫기</button></div>`
    : !i ? '<p class="ask-s inv-wait">초대를 확인하고 있어요…</p>'
    : `<div class="inv-top">${icon('plane')}<span>여행 초대</span></div>
      <b class="ask-t inv-title">${esc(i.title || '함께하는 여행')}</b>
      ${dates ? `<p class="inv-dates">${esc(dates)}</p>` : ''}
      ${i.owner ? `<p class="ask-s">${esc(i.owner)}님이 초대했어요 · 함께하는 사람 ${Number(i.members) || 1}명</p>` : ''}
      ${i.mine ? '<p class="ask-s">이미 함께하는 여행이에요.</p>' : `<p class="ask-s">${AUTH.user ? '참여하면 일정·예약·경비를 함께 보고 바꿀 수 있어요.' : '카카오로 시작하면 바로 이 여행의 여행메이트가 돼요.'}</p>`}
      <div class="ask-bs one">
        ${i.mine ? '<button type="button" class="btn primary" data-inv-join>여행 열기</button>'
          : AUTH.user ? `<button type="button" class="btn primary" data-inv-join ${INV.busy ? 'disabled' : ''}>${INV.busy ? '들어가는 중…' : '참여하기'}</button>`
          : '<button type="button" class="btn acct-kakao" data-inv-kakao><span class="acct-kakao-mark" aria-hidden="true"></span>카카오로 시작하기</button>'}
        <button type="button" class="btn ghost" data-inv-close>나중에</button></div>`;
  el.innerHTML = `<div class="ask-dim" data-inv-close></div><div class="ask-card inv-card" role="dialog" aria-modal="true">${body}</div>`;
  el.hidden = false;
}
async function inviteJoin() {
  if (!AUTH.user) return;
  INV.busy = true; inviteDraw();
  store.set('cloudJoin', INV.code);
  await cloudStart(true);
  INV.busy = false; inviteClose();
}
function inviteKakao() {
  // 카카오에서 돌아오면 로그인되자마자 이 코드로 들어가요
  store.set('cloudJoin', INV.code);
  authKakao();
}
// 들어온 직후 한 번: 여행메이트에게 보일 닉네임 확인
async function inviteWelcome(trip) {
  toast(`'${trip.title || '여행'}'에 들어왔어요`);
  const v = await askBox({ title: '여행메이트에게 보일 닉네임', body: '모든 여행에 같이 쓰여요. 설정 › 계정에서 언제든 바꿀 수 있어요.', ok: '시작하기', cancel: '그대로', input: { value: myNick(), placeholder: '1~12자' } });
  if (v !== null && v.trim() && v.trim() !== myNick()) await saveNick(v);
}
// 닉네임: 로그인하면 계정에 하나(모든 여행 공통), 로그인 전엔 이 폰에만
async function saveNick(v) {
  const t = String(v).trim().slice(0, 12);
  if (!t) { toast('한 글자 이상 넣어 주세요'); return false; }
  if (AUTH.user) {
    if (!navigator.onLine) { toast('인터넷에 연결된 뒤 다시 바꿔 주세요'); return false; }
    if (CLOUD.members.some((m) => m.id !== AUTH.user.id && m.nick === t)
      && !(await askConfirm('같은 닉네임의 여행메이트가 있어요', { body: '그래도 이 닉네임으로 쓸까요?', ok: '그대로 쓰기' }))) return false;
    const { error } = await sb().from('profiles').update({ nick: t }).eq('id', AUTH.user.id);
    if (error) { toast('닉네임을 바꾸지 못했어요. 잠시 뒤 다시 해 주세요'); return false; }
    AUTH.nick = t;
    const m = CLOUD.members.find((x) => x.id === AUTH.user.id);
    if (m) m.nick = t;
  } else store.set('myNick', t);
  render(); accountRefresh();
  toast(`앞으로 ${t}님${hasBatchim(t + '님') ? '이라고' : '라고'} 부를게요`);
  return true;
}
async function editNick() {
  const v = await askText('닉네임', myNick(), { body: AUTH.user ? '여행메이트에게 보이고, 아침 인사에서 이렇게 불러요. 모든 여행에 같이 쓰여요.' : '아침 인사에서 이렇게 불러요. 로그인하면 계정 닉네임을 써요.', placeholder: '1~12자' });
  if (v !== null) await saveNick(v);
}
// 여행메이트 관리: 여행 마스터는 내보내기, 동반자는 나가기
async function mateKick(id) {
  const m = CLOUD.members.find((x) => x.id === id);
  if (!m || CLOUD.role !== 'owner' || id === AUTH.user.id) return;
  if (!(await askConfirm(`${m.nick}님을 이 여행에서 내보낼까요?`, { body: '그동안 남긴 기록은 그대로 남아요. 다시 들어오려면 초대 링크가 필요해요.', ok: '내보내기', danger: true }))) return;
  const { error } = await sb().from('trip_members').delete().eq('trip_id', CLOUD.trip.id).eq('user_id', id);
  if (error) return toast('내보내지 못했어요. 잠시 뒤 다시 해 주세요');
  CLOUD.members = CLOUD.members.filter((x) => x.id !== id); CLOUD.mateOpen = '';
  cloudRefreshUi(); render(); toast(`${m.nick}님을 내보냈어요`);
}
async function mateLeave() {
  if (!CLOUD.trip || CLOUD.role === 'owner') return;
  if (!(await askConfirm('이 여행에서 나갈까요?', { body: '내가 남긴 기록은 여행에 남아요. 다시 들어오려면 초대 링크가 필요해요.', ok: '나가기', danger: true }))) return;
  const { error } = await sb().from('trip_members').delete().eq('trip_id', CLOUD.trip.id).eq('user_id', AUTH.user.id);
  if (error) return toast('나가지 못했어요. 잠시 뒤 다시 해 주세요');
  toast(`'${CLOUD.trip.title || '여행'}'에서 나왔어요`);
  await cloudStart(true);
  render();
}
const ROLE_KO = { owner: '여행 마스터', editor: '함께 편집', viewer: '보기만' };
function mateListHtml() {
  const list = CLOUD.members;
  const all = CLOUD.mateAll || list.length <= 6;
  const owner = CLOUD.role === 'owner';
  const l = CLOUD.link;
  return `
    <div class="set-row"><span class="grow"><b>함께하는 사람 ${list.length}명</b><small>${list.length > 1 ? '초대 링크로 들어온 여행메이트예요' : '아직 없어요. 초대 링크를 보내 주세요'}</small></span>
      ${owner ? `<button class="btn ${list.length > 1 ? '' : 'primary'}" data-cloud-invite>초대 링크 보내기</button>` : ''}</div>
    <div class="mate-list">${(all ? list : list.slice(0, 6)).map((m) => {
      const me = m.id === AUTH.user.id;
      const open = CLOUD.mateOpen === m.id;
      return `<div class="mate-row ${open ? 'open' : ''}"><i class="mate-dot" style="background:${m.color}"></i>
        <span class="grow"><b>${esc(m.nick)}${me ? ' <small class="mate-me">나</small>' : ''}</b><small>${ROLE_KO[m.role] || ''}</small></span>
        ${me ? `<button class="btn mate-btn" data-nick aria-label="내 닉네임 바꾸기">${icon('pen')}</button>`
          : owner ? `<button class="btn mate-btn" data-mate="${esc(m.id)}">${open ? '닫기' : '관리'}</button>` : ''}
        ${open ? `<div class="mate-acts"><button class="btn danger" data-mate-kick="${esc(m.id)}">내보내기</button></div>` : ''}
      </div>`; }).join('')}
      ${all ? '' : `<button class="btn wide" data-mate-all>외 ${list.length - 6}명 더 보기</button>`}</div>
    ${owner && l ? `<div class="set-row"><span class="grow"><b>초대 링크</b><small>${mdOf(l.until)}까지 · ${l.uses}명 들어옴</small></span><button class="btn" data-inv-off>링크 끄기</button></div>` : ''}
    ${!owner ? '<div class="btns"><button class="btn danger wide" data-mate-leave>이 여행에서 나가기</button></div>' : ''}`;
}
function cloudRefreshUi() {
  const el = $('#sheet-body .cloud-card');
  if (el) el.outerHTML = cloudCard();
}
function cloudCard() {
  if (!AUTH.user) return `<div class="card set-card cloud-card"><div class="set-row"><span class="grow"><b>내 여행</b><small>위 계정에서 카카오로 로그인하면 여행을 만들고 여행메이트를 초대할 수 있어요. 기록은 자동으로 맞춰져요</small></span></div></div>`;
  if (CLOUD.state === 'none') {
    // 도쿄 일정 기록이 이 폰에 있으면 그대로 올리는 버튼, 처음 쓰는 사람은 새 여행 만들기부터
    const hasLocal = !state.planOf && Object.keys(store.get('meta', {})).length > 0;
    if (!hasLocal) CLOUD.form = true;
    return `<div class="card set-card cloud-card">
      <div class="set-row"><span class="grow"><b>${hasLocal ? '이 폰 기록으로 여행 시작' : '내 여행 만들기'}</b><small>${hasLocal ? '먼저 시작하는 폰이 서버에 여행을 만들고 이 폰 기록(일정 변경·경비·예약번호·사진)을 올려요. 다른 폰은 그다음 초대 링크로 들어와요' : '여행 이름과 날짜만 넣으면 빈 일정이 만들어져요. 함께 갈 사람은 초대 링크로 들어와요'}</small></span></div>
      ${hasLocal ? '<div class="btns"><button class="btn primary wide" data-cloud-create>이 폰 도쿄 일정으로 만들기</button></div>' : ''}
      <div class="set-row"><span class="grow"><b>초대받았나요?</b><small>받은 초대 링크를 열거나, 링크를 여기에 붙여 넣어 주세요</small></span><button class="btn" data-join-code>초대 코드 입력</button></div>
      ${tripFormHtml()}
    </div>`;
  }
  const when = CLOUD.at ? new Date(CLOUD.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
  const pend = cloudPending();
  const line = CLOUD.state === 'syncing' ? '맞추는 중…'
    : CLOUD.state === 'offline' ? (pend ? `인터넷이 연결되면 바뀐 기록 ${pend}건을 보내요` : '인터넷이 연결되면 다시 맞춰요')
    : CLOUD.state === 'error' ? '서버와 맞추지 못했어요. 잠시 뒤 다시 해 볼게요'
    : CLOUD.trip ? `${when} 여행메이트와 맞췄어요${CLOUD.live ? ' · 실시간' : ''}` : '연결 중…';
  const bad = CLOUD.state === 'error' || CLOUD.state === 'offline';
  return `<div class="card set-card cloud-card">
      <div class="cloud-stat ${bad ? 'bad' : ''}">${icon(bad ? 'warn' : CLOUD.state === 'syncing' ? 'refresh' : 'check')}<span class="grow">${esc(line)}</span>
        <button class="btn mini" data-cloud-now ${CLOUD.state === 'syncing' ? 'disabled' : ''}>지금 맞추기</button></div>
      ${CLOUD.trip ? mateListHtml() : ''}
      ${CLOUD.invite ? `<input class="input" readonly value="${esc(CLOUD.invite)}" onclick="this.select()">` : ''}
      ${CLOUD.trip || CLOUD.trips.length ? `<div class="set-row trip-head"><span class="grow"><b>내 여행</b><small>여행마다 일정·기록·사진이 따로 저장돼요</small></span></div>${tripListHtml()}${tripFormHtml()}` : ''}
    </div>`;
}
window.addEventListener('online', () => cloudStart());
window.addEventListener('offline', () => { if (CLOUD.trip) { CLOUD.state = 'offline'; cloudRefreshUi(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && CLOUD.trip) cloudSync(); });

// ---------- 기능 사용 기록 (서버 버전 S-4) ----------
// 어떤 버튼을 눌렀는지 '이름'만 남겨요 (예: tab.today, qk.late, aiPlan). 장소·예약·금액 같은 내용은 남기지 않아요.
// 로그인한 폰만, 모아서 1분마다·앱을 내릴 때 보내요. 인터넷이 없으면 폰에 쌓아 두었다가 보내요 (최대 500개).
const USAGE_VALUE = new Set(['tab', 'go', 'qk', 'aiPlan', 'geoSet', 'fx', 'exCat', 'fKind']); // 값도 이름에 붙이는 버튼 (짧은 종류 이름만)
const USAGE_SKIP = new Set(['close', 'closeJa', 'closeViewer']);
let USAGE_KEYS = null;
function usageName(d) {
  // 눌린 버튼의 '동작' 속성 (ACTIONS 목록에 있는 것) 하나만
  USAGE_KEYS ??= new Set([...ACTIONS.matchAll(/\[data-([a-z0-9-]+)\]/g)].map((m) => m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())));
  const k = Object.keys(d).find((x) => USAGE_KEYS.has(x));
  if (!k || USAGE_SKIP.has(k)) return '';
  const v = d[k];
  return (USAGE_VALUE.has(k) && /^[a-z]{2,12}$/i.test(v || '') ? `${k}.${v}` : k).slice(0, 60);
}
function usageTrack(d) {
  try {
    if (!AUTH.user) return;
    const name = usageName(d);
    if (!name) return;
    const q = store.get('usageQ', []);
    q.push({ name, at: new Date().toISOString() });
    store.set('usageQ', q.slice(-500));
    if (q.length >= 30) usageFlush();
  } catch { /* 기록 실패는 앱 동작에 영향 없음 */ }
}
async function usageFlush() {
  if (usageFlush.busy || !AUTH.user || !navigator.onLine) return;
  const q = store.get('usageQ', []);
  if (!q.length) return;
  usageFlush.busy = true;
  try {
    const rows = q.map((x) => ({ name: x.name, at: x.at, app_version: String(APP_VERSION), trip_id: CLOUD.trip?.id || null, user_id: AUTH.user.id }));
    const { error } = await sb().from('usage_events').insert(rows);
    if (!error) store.set('usageQ', store.get('usageQ', []).slice(q.length));
  } catch { /* 다음에 다시 */ }
  usageFlush.busy = false;
}
setInterval(usageFlush, 60000);
document.addEventListener('visibilitychange', () => { if (document.hidden) usageFlush(); });

// ---------- 위치로 도착·이동 알아채기 (앱이 켜져 있는 동안만) ----------
// A: a banner from the top for the everyday ones (arrived? / on the way), C: a centred popup only when a fixed
// stop is about to be missed. Where the phone is stays on the phone: never stored, never sent.
// 'geoOn': null = not asked yet, true/false = the traveler's choice.
const GEO = { watch: null, pos: null, asked: {}, left: {}, late: {}, hideT: null };
const geoOn = () => store.get('geoOn', null);
function geoCard() {
  const on = geoOn() === true;
  return `<div class="card set-card"><div class="set-row"><span class="grow"><b>위치로 도착·이동 알림</b><small>앱을 열어 둔 동안 다음 장소 근처에 오면 '도착했어요?', 떠나면 '이동 시작'을 알려 줘요. 위치는 이 폰에서만 쓰고 저장하지 않아요</small></span>
    <button class="btn ${on ? '' : 'primary'}" data-geo-set="${on ? 'off' : 'on'}">${on ? '끄기' : '켜기'}</button></div></div>`;
}
const geoToday = () => { const now = tokyoNow(); return state.trip.days.some((d) => d.date === now.date) ? now : null; };
function geoStart() {
  if (!navigator.geolocation || !geoToday()) return;
  if (geoOn() === null) return geoBanner({ key: 'ask', kicker: '위치 알림', title: '도착하면 바로 알려 드릴까요?', sub: '앱을 열어 둔 동안만 위치를 써요 · 저장하지 않아요', yes: ['켜기', () => geoSet(true)], no: ['나중에', () => store.set('geoOn', false)] });
  if (geoOn() !== true || GEO.watch != null || document.hidden) return;
  GEO.watch = navigator.geolocation.watchPosition((p) => geoTick({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), () => {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
}
function geoStop() { if (GEO.watch != null) navigator.geolocation.clearWatch(GEO.watch); GEO.watch = null; }
function geoSet(on) {
  store.set('geoOn', on);
  if (on) geoStart(); else geoStop();
  if (!$('#sheet').hidden && $('#sheet-body .settings')) $('#sheet-body').innerHTML = settingsBody();
  toast(on ? '위치 알림을 켰어요' : '위치 알림을 껐어요');
}
document.addEventListener('visibilitychange', () => (document.hidden ? geoStop() : geoStart()));
// Each fix: arrived near the next stop → ask; walked away from the stop under way → 'on the way'; a fixed stop
// out of reach from here → the centred popup. Each asks once ('아직' waits 10 minutes, then once more).
function geoTick(pos) {
  GEO.pos = pos;
  const now = geoToday();
  if (!now) return;
  const items = dayItems(dayOf(now.date)).filter((x) => !x.skip && isStopRow(x) && !isDone(x.id));
  const cur = items.find((x) => isBegun(x));
  const next = items.find((x) => !isBegun(x) && x !== cur && (!cur || x.startMin >= cur.startMin));
  const near = (it) => { const pt = it && legPoint(it); return pt?.lat ? kmBetween(pos, pt) * 1000 : null; };
  const slack = Math.min(pos.acc || 0, 80);
  // C first: a fixed stop next and not reachable in time from where we are.
  if (next && isFixed(next)) {
    const d = near(next);
    const pt = legPoint(next);
    const eta = d != null ? geoEta(pos, pt) : null;
    const last = lastIn(next);
    const over = eta != null ? now.min + eta - last : 0;
    const k = next.id;
    if (d > 200 && over > 0 && Date.now() - (GEO.late[k] || 0) > 10 * 60000) {
      GEO.late[k] = Date.now();
      return geoLate(next, over, eta, d, now);
    }
  }
  // A: arrived?
  if (next) {
    const d = near(next);
    const a = GEO.asked[next.id] || { n: 0, at: 0 };
    if (d != null && d - slack <= 120 && a.n < 2 && Date.now() - a.at > 10 * 60000) {
      GEO.asked[next.id] = { n: a.n + 1, at: Date.now() };
      return geoBanner({ key: 'arr:' + next.id, kicker: `지금 위치 · ${Math.max(10, Math.round(d / 10) * 10)}m`, title: `${shortName(next)}에 도착했어요?`,
        sub: `${next.start} 예정${now.min > next.startMin ? ` · ${formatLeft(now.min - next.startMin)} 늦음` : ''}`,
        yes: ['도착했어요', () => arrive(next.id)], no: ['아직', () => {}] });
    }
    // Walked away again: the next arrival can ask afresh.
    if (d != null && d > 300 && a.n) GEO.asked[next.id] = { n: 0, at: 0 };
  }
  // A: left the stop under way → on the way to the next.
  if (cur && next && !GEO.left[cur.id]) {
    const d = near(cur);
    if (d != null && d - slack > 250) {
      GEO.left[cur.id] = true;
      const pt = legPoint(next);
      const dn = near(next);
      const eta = pt?.lat ? geoEta(pos, pt) : null;
      const arriveAt = eta != null ? now.min + eta : null;
      return geoBanner({ key: 'go:' + cur.id, dark: true, kicker: '이동 시작했어요', title: `${shortName(next)}까지 ${dn != null ? distLabel(dn / 1000) : ''}`,
        sub: eta != null ? `약 ${eta}분 · ${clock(arriveAt)} 도착 예상${arriveAt <= next.startMin ? ` (여유 ${next.startMin - arriveAt}분)` : ` (${arriveAt - next.startMin}분 늦음)`}` : '',
        yes: [`${shortName(cur)} 완료`, () => { setDone(cur.id, true); render(); }], no: ['길 안내', () => window.open(geoDir(pt), '_blank', 'noopener')] });
    }
  }
}
// Minutes from here to a point: the line table when a train helps, else walking.
function geoEta(a, b) {
  const t = kmBetween(a, b) > 1.2 && tableRoute(a, b);
  if (t) return t.min + Math.max(3, Math.ceil(t.min * 0.15));
  const km = kmBetween(a, b);
  return km <= 1.5 ? Math.max(1, Math.ceil((km * 1000 * 1.3) / 75)) : Math.ceil(km * 3 + 10);
}
const geoDir = (pt) => `https://www.google.com/maps/dir/?api=1&destination=${pt.lat},${pt.lng}&travelmode=transit`;
// A: the banner from the top. Slides up to close; after 8 s untouched it folds to a small pill that opens it again.
function geoBanner(o) {
  let el = $('#geo-pop');
  if (!el) { el = document.createElement('div'); el.id = 'geo-pop'; document.body.appendChild(el); geoSwipe(el); }
  clearTimeout(GEO.hideT);
  el.className = `geo-pop${o.dark ? ' dark' : ''}`;
  el.innerHTML = `
    <div class="gp-card" role="alertdialog" aria-live="assertive">
      <div class="gp-k"><i></i>${esc(o.kicker)}</div>
      <b class="gp-t">${esc(o.title)}</b>
      ${o.sub ? `<small class="gp-s">${esc(o.sub)}</small>` : ''}
      <div class="gp-bs"><button class="gp-yes" type="button">${esc(o.yes[0])}</button><button class="gp-no" type="button">${esc(o.no[0])}</button></div>
    </div>
    <button class="gp-pill" type="button">${icon('pin')}<span>${esc(o.title)}</span></button>`;
  const close = () => { el.classList.remove('in', 'mini'); clearTimeout(GEO.hideT); };
  el.querySelector('.gp-yes').onclick = () => { close(); o.yes[1](); };
  el.querySelector('.gp-no').onclick = () => { close(); o.no[1](); };
  el.querySelector('.gp-pill').onclick = () => { el.classList.remove('mini'); fold(); };
  const fold = () => { clearTimeout(GEO.hideT); GEO.hideT = setTimeout(() => el.classList.add('mini'), 8000); };
  requestAnimationFrame(() => el.classList.add('in'));
  navigator.vibrate?.(60);
  fold();
}
function geoSwipe(el) {
  let y0 = null;
  el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (y0 != null && e.touches[0].clientY - y0 < -30) { el.classList.remove('in', 'mini'); y0 = null; } }, { passive: true });
}
// C: the centred popup when a fixed stop slips out of reach; the ways come from the same fitting as '맞추는 방법'.
function geoLate(W, over, eta, d, now) {
  const q = squeezeOf(W.date, now);
  const ways = q ? squeezeWays(q).slice(0, 2) : [];
  if (q) state.squeeze = { ...q, ways };
  const k = kmBetween(GEO.pos, legPoint(W));
  const taxi = k >= 0.4 ? taxiMin(k) : null;
  let el = $('#geo-modal');
  if (!el) { el = document.createElement('div'); el.id = 'geo-modal'; document.body.appendChild(el); }
  el.className = 'geo-modal';
  el.innerHTML = `
    <div class="gm-dim"></div>
    <div class="gm-card" role="alertdialog" aria-modal="true">
      <div class="gm-k">${icon('warn')}이대로면 ${formatLeft(over)} 늦어요</div>
      <b class="gm-t">${esc(shortName(W))} ${esc(W.enterBy || W.start)}${W.enterBy ? '까지 입장' : ''}</b>
      <small class="gm-s">지금 위치에서 약 ${eta}분 · ${distLabel(d / 1000)}${taxi ? ` · 택시면 약 ${taxi}분 (${taxiFare(k).toLocaleString('ko-KR')}엔)` : ''}</small>
      <div class="gm-bs">
        ${ways.map((w, i) => `<button class="btn ${i ? '' : 'primary'}" data-gm-way="${i}">${esc(w.title)}</button>`).join('')}
        <button class="btn ${ways.length ? '' : 'primary'}" data-gm-dir>${icon('nav')}길 안내</button>
        <button class="btn gm-later" data-gm-close>나중에</button>
      </div>
    </div>`;
  const shut = () => { el.hidden = true; };
  el.hidden = false;
  el.querySelector('.gm-dim').onclick = shut;
  el.querySelector('[data-gm-close]').onclick = shut;
  el.querySelector('[data-gm-dir]').onclick = () => { shut(); window.open(geoDir(legPoint(W)), '_blank', 'noopener'); };
  el.querySelectorAll('[data-gm-way]').forEach((b) => { b.onclick = () => { shut(); applySqueeze(+b.dataset.gmWay); }; });
  navigator.vibrate?.([80, 60, 80]);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
