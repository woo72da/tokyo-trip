'use strict';

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TABS = ['today', 'days', 'explore', 'wallet', 'talk', 'check'];

const state = {
  trip: null, wx: null, fx: null, tab: 'today', dayIndex: 0, talkDir: 'ko-ja',
  pendingDoc: null, viewer: null, docSlots: new Set(), syncFile: null,
  ex: { cat: 'eat', area: '전체', open: false, plan: false, saved: false, again: false, near: false }, geo: null,
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
      }
    } catch { /* ignore */ }
  },
};
// What the sync carries: checks, done marks, own checklist items, added document sets, booking numbers, links, expenses, budget.
const isShared = (key) => /^(ck|done|visit|save|edit):/.test(key) || ['custom', 'cdocs', 'myitems', 'myplaces', 'pnr', 'agoda', 'esim1', 'esim2', 'sosCard', 'sosIns', 'exp', 'budget'].includes(key);
// Deleted list entries and photos are remembered so a sync doesn't bring them back.
// Ids stay unique across both phones even when two records are made in the same millisecond.
const uid = (prefix) => `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const forget = (id) => store.set('tomb', { ...store.get('tomb', {}), [id]: Date.now() });
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

// Our own contacts for emergencies, kept with the booking numbers on the phones only.
const SOS_FIELDS = [
  { key: 'sosCard', label: '카드 분실 신고', placeholder: '카드사 해외 분실 번호' },
  { key: 'sosIns', label: '여행자보험 긴급 지원', placeholder: '보험사 해외 긴급 번호' },
];

const isTyped = (key) => [...SECRETS, ...SOS_FIELDS].some((s) => s.key === key);

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
  put: (id, blob) => docs.run('readwrite', (s) => s.put(blob, id)),
  del: (id) => { forget('doc:' + id); return docs.run('readwrite', (s) => s.delete(id)); },
  keys: () => docs.run('readonly', (s) => s.getAllKeys()),
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

// A day's stops as planned here: added stops included, with any time change or skip laid over the trip file.
function effectiveItems(day) {
  const added = store.get('myitems', []).filter((x) => x.date === day.date);
  return [...day.items, ...added].map((it) => {
    const edit = store.get('edit:' + it.id, null);
    return edit ? { ...it, ...edit } : it;
  });
}
function allItems() {
  return state.trip.days.flatMap((d) => effectiveItems(d).map((it) => ({ ...it, date: d.date })));
}
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

// Warning chips for an item on its date; `now` adds "closing soon" when it is today.
// A must or fixed-time stop whose time has passed without being marked done, today only.
function lateness(it, now) {
  if (!now || now.date !== it.date || it.skip || isDone(it.id) || !(it.hard || it.priority === 'must')) return null;
  const over = now.min - it.endMin;
  return over > 0 ? { hard: !!it.hard, over } : null;
}
const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function chipsFor(it, now) {
  const chips = [];
  const late = lateness(it, now);
  if (late) chips.push(late.hard ? ['late', `${formatLeft(late.over)} 지연`] : ['warn', '시간 지남']);
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
  if (it.verify) chips.push(['warn', '확인 필요']);
  const w = wxFor(it);
  // Rain only matters per item when there is an indoor alternative; the day card covers umbrellas.
  if (it.rainPlan) chips.push(w && w.pop >= 50 ? ['warn', `비 ${w.pop}% · 대안 보기`, 'umbrella'] : ['', '비 올 때 대안', 'umbrella']);
  return chips;
}
const chipsHtml = (chips) => chips.length
  ? `<div class="chips">${chips.map(([cls, t, ic]) => `<span class="chip ${cls}">${ic ? icon(ic) : ''}${esc(t)}</span>`).join('')}</div>`
  : '';

// ---------- weather (Open-Meteo, no key; last forecast kept on this phone for offline) ----------
const WX_URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.69&longitude=139.75'
  + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
  + '&timezone=Asia%2FTokyo&forecast_days=16';
const WX_TTL = 30 * 60 * 1000;
// WMO weather codes: each entry covers codes from its number up to the next entry.
const WMO = [[0, 'wx-sun', '맑음'], [1, 'wx-partly', '대체로 맑음'], [2, 'wx-partly', '구름 조금'], [3, 'wx-cloud', '흐림'], [45, 'wx-fog', '안개'],
  [51, 'wx-rain', '이슬비'], [61, 'wx-rain', '비'], [66, 'wx-rain', '어는 비'], [71, 'wx-snow', '눈'], [80, 'wx-rain', '소나기'], [85, 'wx-snow', '눈 소나기'], [95, 'wx-storm', '뇌우']];
const wmo = (code) => {
  const hit = WMO.filter(([c]) => code >= c).pop() || WMO[0];
  return { icon: hit[1], label: hit[2] };
};

async function loadWeather(force = false) {
  if (!force && state.wx && Date.now() - state.wx.at < WX_TTL) return;
  try {
    const res = await fetch(WX_URL);
    if (!res.ok) throw new Error(String(res.status));
    const { hourly, daily } = await res.json();
    state.wx = { at: Date.now(), hourly, daily };
    store.set('wx', state.wx);
    if (force) toast('날씨를 업데이트했어요');
    if ($('#sheet').hidden) render();
  } catch {
    if (force) toast(state.wx ? '인터넷이 안 돼서 저장된 예보를 보여줘요' : '날씨를 불러오지 못했어요');
  }
}

function wxDay(date) {
  const d = state.wx?.daily;
  const i = d ? d.time.indexOf(date) : -1;
  if (i < 0) return null;
  return {
    ...wmo(d.weather_code[i]),
    max: Math.round(d.temperature_2m_max[i]),
    min: Math.round(d.temperature_2m_min[i]),
    pop: d.precipitation_probability_max[i] ?? 0,
  };
}

function wxHour(date, min) {
  const h = state.wx?.hourly;
  const hour = Math.floor(min / 60);
  const i = h ? h.time.indexOf(`${date}T${String(hour).padStart(2, '0')}:00`) : -1;
  if (i < 0) return null;
  return {
    ...wmo(h.weather_code[i]),
    hour,
    temp: Math.round(h.temperature_2m[i]),
    feels: Math.round(h.apparent_temperature[i]),
    pop: h.precipitation_probability[i] ?? 0,
  };
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
  const wet = hrs.reduce((a, b) => (b.pop > a.pop ? b : a));
  const wetHours = hrs.filter((h) => h.pop >= 50).length;
  if (wetHours >= 6) tips.push(['warn', `우산 필수 · 낮 내내 비 최대 ${wet.pop}%`, 'umbrella']);
  else if (wet.pop >= 50) tips.push(['warn', `우산 필수 · ${wet.hour}시쯤 비 ${wet.pop}%`, 'umbrella']);
  else if (wet.pop >= 30) tips.push(['', `접이식 우산 · ${wet.hour}시쯤 비 ${wet.pop}%`, 'umbrella']);
  const lo = Math.min(...hrs.map((h) => h.feels));
  const hi = Math.max(...hrs.map((h) => h.temp));
  if (lo <= 10) tips.push(['', `체감 ${lo}°까지 · 따뜻한 겉옷`, 'coat']);
  else if (lo <= 15) tips.push(['', `아침저녁 체감 ${lo}° · 가벼운 겉옷`, 'coat']);
  if (hi - lo >= 8) tips.push(['', `일교차 ${hi - lo}° · 겹쳐 입기`, 'temp']);
  if (hi >= 24) tips.push(['', `낮 ${hi}° · 가벼운 옷`, 'tshirt']);
  return tips;
}

function wxAge() {
  const m = Math.round((Date.now() - state.wx.at) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  return m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}

// Weather card for one day: now (if `now` is that day) or the day overall, advice, hourly strip.
function wxCard(date, now) {
  const day = wxDay(date);
  if (!day) {
    return state.wx ? '' : `<button class="wx wx-empty" data-wx-refresh>${wxIcon('wx-partly')}날씨를 불러오는 중이에요 · 탭해서 다시 시도</button>`;
  }
  const cur = now ? wxHour(date, now.min) : null;
  const from = cur ? cur.hour : 8;
  const strip = wxHours(date, from, cur ? Math.min(from + 11, 23) : 22);
  const tips = wxTips(date);
  return `
    <div class="wx">
      <div class="wx-head">
        <div class="wx-big">${wxIcon((cur || day).icon)}</div>
        <div class="grow">
          <div class="wx-temp">${cur ? cur.temp : day.max}°<span>${esc((cur || day).label)}${cur ? '' : ' · 낮 최고'}</span></div>
          <div class="wx-sub">최고 ${day.max}° · 최저 ${day.min}° · 비 ${day.pop}%${cur ? ` · 체감 ${cur.feels}°` : ''}</div>
        </div>
        <button class="wx-refresh" data-wx-refresh aria-label="날씨 새로고침">${icon('refresh')}${wxAge()}</button>
      </div>
      ${chipsHtml(tips)}
      ${strip.length ? `<div class="wx-strip">${strip.map((h) => `
        <div class="${h.pop >= 50 ? 'wet' : ''}"><small>${cur && h.hour === cur.hour ? '지금' : h.hour + '시'}</small><span>${wxIcon(h.icon)}</span><b>${h.temp}°</b><i>${h.pop >= 10 ? h.pop + '%' : ''}</i></div>`).join('')}
      </div>` : ''}
    </div>`;
}

// Five-day outlook with packing advice, shown before departure.
function wxTrip() {
  const rows = state.trip.days.map((d) => ({ date: d.date, w: wxDay(d.date) }));
  const known = rows.filter((r) => r.w);
  if (!known.length) {
    return `<div class="card small muted">출발 16일 전부터 여행 기간 예보가 나와요. 그 전엔 예약 탭의 평년 날씨를 참고하세요.</div>`;
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
        <div class="${r.w && r.w.pop >= 50 ? 'wet' : ''}">
          <small>${esc(shortDate(r.date))} ${WEEKDAYS[dowOf(r.date)]}</small>
          ${r.w ? `<span>${wxIcon(r.w.icon)}</span><b>${r.w.max}°<em>${r.w.min}°</em></b><i>비 ${r.w.pop}%</i>` : '<span>·</span><i>예보 전</i>'}
        </div>`).join('')}
      </div>
      ${chipsHtml(tips)}
      <div class="wx-foot"><span>예보는 바뀔 수 있어요 · 앱을 열 때마다 새로 받아요</span><button data-wx-refresh>${icon('refresh')}${wxAge()}</button></div>
    </div>`;
}

// ---------- expenses (yen, shown with won) ----------
const EXP_CATS = ['식당', '카페', '교통', '쇼핑', '관광', '기타'];
const SCENE_CAT = { 식당: '식당', 카페: '카페', 교통: '교통', 공항: '교통', 쇼핑: '쇼핑', 관광: '관광', 호텔: '기타' };
const expenses = () => store.get('exp', []);
const yen = (n) => `${Math.round(n).toLocaleString('ko-KR')}엔`;
const won = (n) => `${(Math.round((n * (state.fx?.rate || 8.5)) / 10) * 10).toLocaleString('ko-KR')}원`;
const PEOPLE = ['안드레아', '다희'];
// Records and files made before the names were set still say 나 / 와이프.
const person = (name) => ({ 나: '안드레아', 와이프: '다희' })[name] || name;
const who = () => person(store.get('who', '나'));

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
    <div class="sheet-head">${itemIcon('💴', 'lg')}<h3>환율 계산기</h3></div>
    <div class="fx">
      <div class="talk-dir"><b>${f.dir === 'yen' ? '일본 엔' : '한국 원'}</b>
        <button class="icon-btn" data-fx-swap aria-label="방향 바꾸기">${icon('swap')}</button>
        <b>${f.dir === 'yen' ? '한국 원' : '일본 엔'}</b></div>
      <div class="fx-field">
        <input id="fx-in" class="fx-in" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.value)}">
        <span class="fx-unit">${from}</span>
        <button class="talk-clear fx-clear" data-fx-clear aria-label="지우기">${icon('x')}</button>
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
  loadFx(true);
}

function addExpense({ amount, memo, cat, item, date }) {
  const list = expenses();
  list.push({ id: uid('e-'), amount, memo, cat, item: item || null, date: date || tokyoNow().date, by: who() });
  store.set('exp', list);
}
function expRow(e) {
  return `
    <div class="exp-row">
      <span class="exp-cat">${esc(e.cat)}</span>
      <span class="grow"><b>${esc(e.memo || e.cat)}</b><small>${esc(shortDate(e.date))} · ${esc(person(e.by))}</small></span>
      <span class="exp-amt"><b>${yen(e.amount)}</b><small>${won(e.amount)}</small></span>
      <button type="button" class="ck-del" data-exp-del="${esc(e.id)}" aria-label="삭제">${icon('x')}</button>
    </div>`;
}
const expForm = (item = null, memo = '', cat = '식당') => `
  <form class="exp-form" data-exp-item="${esc(item || '')}">
    <input class="input" name="amount" inputmode="numeric" pattern="[0-9]*" placeholder="금액 (엔)" autocomplete="off" required>
    <input class="input" name="memo" placeholder="메모" value="${esc(memo)}" autocomplete="off">
    <select class="input" name="cat">${EXP_CATS.map((c) => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <button class="btn primary" type="submit">${icon('plus')}기록</button>
  </form>`;

function expenseSection() {
  const list = expenses().sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));
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
      ${expForm()}
      ${list.length ? `<div class="exp-list">${list.map(expRow).join('')}</div>` : '<div class="small muted exp-empty">아직 기록이 없어요. 일정을 눌러서도 기록할 수 있어요.</div>'}`}
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
  const body = JSON.stringify({ app: 'tokyo-trip', v: 1, from: who(), at: Date.now(), kv, tomb: store.get('tomb', {}), photos });
  const d = new Date();
  const name = `도쿄여행-${who()}폰-${d.getMonth() + 1}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
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
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: '도쿄 여행 동기화' });
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
  try { data = JSON.parse(await file.text()); } catch { return toast('동기화 파일을 읽지 못했어요.'); }
  if (data?.app !== 'tokyo-trip') return toast('도쿄 여행 앱의 동기화 파일이 아니에요.');
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
      const merged = [...mine, ...extra].filter((x) => !tomb[`${k}:${x.id}`]);
      if (extra.length || merged.length !== mine.length) { store.set(k, merged, Math.max(t, meta[k] || 0)); records += extra.length; }
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
  store.set('syncGot', { at: Date.now(), from: person(data.from) });
  render();
  toast(records || photos ? `${person(data.from)}폰에서 기록 ${records}건 · 사진 ${photos}장을 합쳤어요` : '이미 같은 내용이에요');
}

function syncCard() {
  const got = store.get('syncGot', null);
  const sent = store.get('syncSent', 0);
  const f = state.syncFile;
  const last = Math.max(sent, got?.at || 0);
  if (state.syncOpen && !f && !state.syncBuilding && !state.syncFailed) setTimeout(prepareSync);
  const head = `
      <button class="sync-head" data-sync-toggle aria-expanded="${!!state.syncOpen}">
        <span class="ii">${icon('refresh')}</span>
        <span class="sync-title"><b>예약정보 동기화</b>
          <small class="muted">${last ? `${who()} 폰 · 마지막 ${new Date(last).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '예약번호·링크·문서 사진·체크·지출 전체'}</small></span>
        <i class="chev"></i>
      </button>`;
  if (!state.syncOpen) return `<div class="card sync">${head}</div>`;
  return `
    <div class="card sync open">
      ${head}
      <div class="sync-who"><span>이 폰은</span>${PEOPLE.map((w) => `<button class="seg ${who() === w ? 'on' : ''}" data-who="${w}">${w}폰</button>`).join('')}</div>
      <div class="btns">
        ${state.syncFailed ? `<button class="btn primary" data-sync-build>${icon('refresh')}다시 준비하기</button>`
            : f ? `<button class="btn primary" data-sync-share>${icon('ext')}보내기</button>`
            : `<button class="btn primary" disabled>준비 중…</button>`}
        <button class="btn" data-sync-pick>${icon('clip')}받은 파일 합치기</button>
      </div>
      ${f ? `<div class="small muted sync-size">사진 ${state.syncPhotos}장 포함 · ${f.size < 1048576 ? Math.max(1, Math.round(f.size / 1024)) + 'KB' : (f.size / 1048576).toFixed(1) + 'MB'}</div>` : ''}
      <ol class="small muted sync-note">
        <li>보내기를 누르고 공유 창에서 카카오톡이나 AirDrop을 고르세요.</li>
        <li>받은 폰에서 파일을 열어 '파일에 저장'하세요.</li>
        <li>받은 폰의 앱에서 '받은 파일 합치기'를 누르면 끝이에요.</li>
      </ol>
      <div class="small muted sync-note">
        서로 한 번씩 주고받으면 두 폰이 같아져요. 예약번호와 사진이 들어 있으니 보낸 뒤 대화방의 파일은 지워 주세요.
        ${sent ? `<br>보낸 시각 ${new Date(sent).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
        ${got ? `<br>${esc(got.from)}폰에서 받은 시각 ${new Date(got.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
      </div>
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
  openApp(
    `comgooglemaps://?daddr=${e}&directionsmode=transit`,
    `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=transit`,
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

function speak(text) {
  const clip = clips.get(text);
  if (clip) {
    window.speechSynthesis?.cancel();
    player.src = clip;
    player.play().catch(() => speakEngine(text));
    return;
  }
  speakEngine(text);
}
function speakEngine(text) {
  const synth = window.speechSynthesis;
  if (!synth) return speakFallback(text, '이 기기 브라우저는 음성을 지원하지 않아요.');
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
// No usable voice: Google 번역 reads Japanese aloud with its speaker button.
function speakFallback(text, why) {
  const t = encodeURIComponent(text);
  toast(`${why} Google 번역에서 스피커를 눌러 들을 수 있어요.`, `https://translate.google.com/?sl=ja&tl=ko&text=${t}&op=translate`, 'Google 번역');
}

let toastTimer;
function toast(msg, href, label) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, href ? 6000 : 2200);
}

// ---------- icons ----------
// Phosphor Icons duotone (MIT, phosphoricons.com); torii, tower and lantern drawn to match.
// The 20% layer (class "d") takes the category tint.
const ICONS = {
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
  'plus': '<path d="M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z" class="d"/><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/>',
  'swap': '<path d="M208,80v96H48V80Z" class="d"/><path d="M213.66,181.66l-32,32a8,8,0,0,1-11.32-11.32L188.69,184H48a8,8,0,0,1,0-16H188.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,213.66,181.66Zm-139.32-64a8,8,0,0,0,11.32-11.32L67.31,88H208a8,8,0,0,0,0-16H67.31L85.66,53.66A8,8,0,0,0,74.34,42.34l-32,32a8,8,0,0,0,0,11.32Z"/>',
  'refresh': '<path d="M216,128a88,88,0,1,1-88-88A88,88,0,0,1,216,128Z" class="d"/><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/>',
  'check': '<path d="M232,56V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56Z" class="d"/><path d="M205.66,85.66l-96,96a8,8,0,0,1-11.32,0l-40-40a8,8,0,0,1,11.32-11.32L104,164.69l90.34-90.35a8,8,0,0,1,11.32,11.32Z"/>',
  'x': '<path d="M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z" class="d"/><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>',
  'pin': '<path d="M128,24a80,80,0,0,0-80,80c0,72,80,128,80,128s80-56,80-128A80,80,0,0,0,128,24Zm0,112a32,32,0,1,1,32-32A32,32,0,0,1,128,136Z" class="d"/><path d="M128,64a40,40,0,1,0,40,40A40,40,0,0,0,128,64Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,128Zm0-112a88.1,88.1,0,0,0-88,88c0,31.4,14.51,64.68,42,96.25a254.19,254.19,0,0,0,41.45,38.3,8,8,0,0,0,9.18,0A254.19,254.19,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25A88.1,88.1,0,0,0,128,16Zm0,206c-16.53-13-72-60.75-72-118a72,72,0,0,1,144,0C200,161.23,144.53,209,128,222Z"/>',
  'ticket': '<path d="M200,128a32,32,0,0,0,32,32v32a8,8,0,0,1-8,8H96V56H224a8,8,0,0,1,8,8V96A32,32,0,0,0,200,128Z" class="d"/><path d="M232,104a8,8,0,0,0,8-8V64a16,16,0,0,0-16-16H32A16,16,0,0,0,16,64V96a8,8,0,0,0,8,8,24,24,0,0,1,0,48,8,8,0,0,0-8,8v32a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V160a8,8,0,0,0-8-8,24,24,0,0,1,0-48ZM32,167.2a40,40,0,0,0,0-78.4V64H88V192H32Zm192,0V192H104V64H224V88.8a40,40,0,0,0,0,78.4Z"/>',
  'calendar': '<path d="M216,48V88H40V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z" class="d"/><path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-68-76a12,12,0,1,1-12-12A12,12,0,0,1,140,132Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,132ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,140,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
  'checklist': '<path d="M216,48V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z" class="d"/><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM224,48V208a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM208,208V48H48V208H208Z"/>',
  'warn': '<path d="M215.46,216H40.54C27.92,216,20,202.79,26.13,192.09L113.59,40.22c6.3-11,22.52-11,28.82,0l87.46,151.87C236,202.79,228.08,216,215.46,216Z" class="d"/><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/>',
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
  '🏨': 'bed stay', '📎': 'clip stay', '🛋': 'coffee stay', '🎫': 'ticket move',
  '🎮': 'game see', '🌳': 'park see', '🏛': 'museum see', '⛩': 'torii see', '🗼': 'tower see', '🌺': 'flower see',
  '🎨': 'art see', '🌉': 'bridge see', '🏮': 'lantern see', '🌇': 'sunset see', '🌤': 'wx-partly see',
};
const glyph = (emoji) => (GLYPHS[String(emoji || '').replace(/\uFE0F/g, '')] || 'pin see').split(' ');
const itemIcon = (emoji, cls = '') => { const [name, kind] = glyph(emoji); return `<span class="ii ${kind} ${cls}">${icon(name)}</span>`; };
const stripEmoji = (s) => String(s || '').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
const wxIcon = (name) => icon(name, 'wxi ' + name);
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- views ----------
function renderToday() {
  const now = tokyoNow();
  const { trip, days, flights } = state.trip;
  const dayIdx = days.findIndex((d) => d.date === now.date);

  if (now.date < trip.start) {
    const left = daysBetween(now.date, trip.start);
    const list = checklist();
    const todo = list.filter((c) => !isChecked(c.id));
    const f = flights[0];
    setHeader('도쿄 · 2026년 11월', trip.title, `${dayLabel(trip.start)} 출발 · ${trip.travelers}명`);
    return `
      <div class="hero countdown">
        <div class="hero-sun"></div>
        <div class="eyebrow">출발까지</div>
        <div class="big">D-${left}</div>
        <div class="route"><b>${esc(f.from)}</b><i></i><b>${esc(f.to)}</b></div>
        <div class="hero-meta">${esc(f.airline)} ${esc(f.no)} · ${esc(dayLabel(f.date))} ${esc(f.depart)} · 인천 T${esc(f.fromTerminal)}</div>
        ${state.trip.transfers.map((t) => `<div class="hero-meta">${itemIcon(t.icon, 'inline')}${esc(t.label)} ${esc(t.from)} ${esc(t.depart)} → ${esc(t.to)}</div>`).join('')}
        <div class="meter"><i style="width:${Math.round(((list.length - todo.length) / list.length) * 100)}%"></i></div>
        <div class="hero-meta">준비 ${list.length - todo.length} / ${list.length}</div>
      </div>
      ${todoCard(now.date, '지금 할 일', 5)}
      <button class="btn wide alarm-btn" data-alarm-sheet>${icon('ext')}일정 알림 받기</button>
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
  if (dayIdx === -1) {
    setHeader('도쿄 · 2026년 11월', trip.title, '여행이 끝났어요');
    return `<div class="empty">おつかれさまでした<br>즐거운 여행이었기를!</div>`;
  }

  const day = days[dayIdx];
  const items = dayItems(day).filter((it) => !it.skip);
  const active = items.filter((it) => it.startMin <= now.min && now.min < it.endMin && !isDone(it.id));
  const current = active[active.length - 1];
  const upcoming = items.filter((it) => it.startMin > now.min);
  const next = upcoming[0];
  setHeader(`${dayIdx + 1}일차 · ${dayLabel(day.date)}`, stripEmoji(day.title), `일몰 ${day.sunset} · ${items.length}개 일정`);

  let html = wxCard(day.date, now);
  html += leaveCard(items, now);
  html += lateCard(items, now);
  html += todoCard(now.date, '오늘 할 일', 3);
  if (current) html += heroCard(current, 'now', now);
  if (next) html += heroCard(next, 'next', now);
  if (!current && !next) html += `<div class="card empty">오늘 일정이 모두 끝났어요. 푹 쉬세요.</div>`;
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
function leaveCard(items, now) {
  const it = items.find((x) => x.hard && !isDone(x.id) && now.min >= x.startMin - (x.lead || 0) - 30 && now.min < x.startMin);
  if (!it) return '';
  const leave = it.startMin - (it.lead || 0);
  const left = leave - now.min;
  return `
    <div class="leave ${left <= 15 ? 'urgent' : ''}">
      <div class="leave-main">
        <b>${left > 0 ? `${formatLeft(left)} 뒤 출발` : left === 0 ? '지금 출발하세요' : `출발 시간 ${formatLeft(-left)} 지남`}</b>
        <span>${esc(it.title)} · ${clock(leave)}까지 출발 · ${esc(it.start)} 시작</span>
      </div>
      <button class="btn" data-done="${esc(it.id)}">${icon('check')}방문 완료</button>
    </div>`;
}

// One line for the most pressing stop still not marked done, so a forgotten tap doesn't pile up warnings.
function lateCard(items, now) {
  const late = items.filter((it) => lateness(it, now));
  if (!late.length) return '';
  const it = late.find((x) => x.hard) || late[late.length - 1];
  const info = lateness(it, now);
  return `
    <div class="leave late ${info.hard ? 'urgent' : ''}">
      <div class="leave-main">
        <b>${info.hard ? `${formatLeft(info.over)} 지연` : '시간 지남'} · ${esc(it.title)}</b>
        <span>끝났으면 방문 완료를 눌러 주세요${late.length > 1 ? ` · 외 ${late.length - 1}개` : ''}</span>
      </div>
      <button class="btn" data-done="${esc(it.id)}">${icon('check')}방문 완료</button>
    </div>`;
}

function heroCard(it, kind, now) {
  const progress = kind === 'now'
    ? Math.max(0, Math.min(100, ((now.min - it.startMin) / (it.endMin - it.startMin)) * 100))
    : 0;
  const label = kind === 'now' ? `지금 · ${it.endMin - now.min}분 남음` : `다음 · ${formatLeft(it.startMin - now.min)} 후`;
  return `
    <div class="hero ${kind}">
      <div class="hero-sun"></div>
      <div class="eyebrow"><i class="pulse"></i>${esc(label)}</div>
      <div class="hero-time">${esc(it.start)}${it.end ? ' — ' + esc(it.end) : ''}${heroWx(it)}</div>
      <div class="hero-head">${itemIcon(it.icon, 'lg')}<div class="hero-title">${esc(it.title)}</div></div>
      ${it.place && it.place.lang !== 'ko' ? `<div class="hero-ja ja">${esc(it.place.nameJa)}</div>` : ''}
      ${it.note ? `<div class="hero-note">${esc(it.note)}</div>` : ''}
      ${chipsHtml(chipsFor(it, now))}
      ${kind === 'now' ? `<div class="meter"><i style="width:${progress}%"></i></div>` : ''}
      ${it.docs ? `<div class="doc-row">${docBtns(it, 'doc-chip')}</div>` : ''}
      <div class="btns">
        ${it.place?.lang === 'ko' ? navBtn(it.id, '네이버지도로 보기', 'primary wide') : ''}
        ${it.place && it.place.lang !== 'ko' ? `${navBtn(it.id, '구글맵 길찾기')}<button class="btn ghost" data-ja="${esc(it.id)}">${icon('ja')}일본어</button>` : ''}
        <button class="btn ghost wide" data-item="${esc(it.id)}">${sceneOf(it) ? '자세히 · 현지 회화' : '자세히'}</button>
      </div>
    </div>`;
}
function heroWx(it) {
  const w = wxFor(it);
  return w ? `<span class="hero-wx">${wxIcon(w.icon)}${w.temp}°${w.pop >= 10 ? ` · 비 ${w.pop}%` : ''}</span>` : '';
}
const formatLeft = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? (m % 60) + '분' : ''}`.trim() : `${m}분`);

// Straight-line distance to the next stop; real travel time comes from the directions button.
function gapLabel(it, next) {
  const a = next && !it.skip && !next.skip && placeOfItem(it.id);
  const b = a && placeOfItem(next.id);
  if (!b || a === b || !a.lat || !b.lat) return '';
  return `<div class="tl-gap">다음 장소까지 ${distLabel(kmBetween(a, b))}</div>`;
}

function timeline(items, now) {
  if (!items.length) return '';
  return `<div class="tl">${items.map((it, i) => {
    const isToday = now && now.date === it.date;
    const cls = [
      isDone(it.id) ? 'done' : '',
      isToday && it.endMin <= now.min ? 'past' : '',
      isToday && it.startMin <= now.min && now.min < it.endMin ? 'current' : '',
      lateness(it, now)?.hard ? 'late' : '',
      it.skip ? 'skipped' : '',
      it.priority || '',
    ].join(' ');
    const warn = chipsFor(it, now).filter(([c]) => c === 'warn' || c === 'late');
    return `
      <div class="tl-item ${cls}">
        <div class="tl-time">${esc(it.start)}${tlWx(it)}</div>
        <div class="tl-card" data-item="${esc(it.id)}" role="button" tabindex="0">
          ${itemIcon(it.icon)}
          <div class="tl-main">
            <div class="tl-title">${esc(it.title)}</div>
            ${infoBadge(it)}
            ${it.note ? `<div class="tl-sub">${esc(it.note)}</div>` : ''}
            ${chipsHtml(warn)}
            ${it.docs ? `<div class="doc-row">${docBtns(it, 'doc-chip')}</div>` : ''}
          </div>
          ${it.place ? `<button class="tl-nav" data-nav="${esc(it.id)}" aria-label="구글맵 길찾기">${icon('nav')}</button>` : ''}
        </div>
        ${gapLabel(it, items[i + 1])}
      </div>`;
  }).join('')}</div>`;
}

function tlWx(it) {
  const w = wxFor(it);
  return w ? `<span class="tl-wx">${wxIcon(w.icon)}${w.temp}°</span>${w.pop >= 30 ? `<span class="tl-pop">${w.pop}%</span>` : ''}` : '';
}

function renderDays() {
  const now = tokyoNow();
  const { days, stay } = state.trip;
  const day = days[state.dayIndex];
  setHeader(`${state.dayIndex + 1}일차 / ${days.length}일`, stripEmoji(day.title), `${dayLabel(day.date)} · 일몰 ${day.sunset} · ${stay.name}`);
  return `
    <div class="daypick" role="group" aria-label="날짜 선택">
      ${days.map((d, i) => `
        <button class="dp ${d.date === now.date ? 'today' : ''}" data-day="${i}" aria-pressed="${i === state.dayIndex}">
          <small>${i + 1}일차</small><b>${Number(d.date.slice(8))}</b><span>${WEEKDAYS[dowOf(d.date)]}</span>
          ${wxDay(d.date) ? `<span class="dp-wx">${wxIcon(wxDay(d.date).icon)}${wxDay(d.date).max}°</span>` : ''}
        </button>`).join('')}
    </div>
    ${wxCard(day.date, now.date === day.date ? now : null)}
    <div class="btns day-actions">
      <button class="btn" data-day-route>${icon('nav')}오늘 동선 지도</button>
      <button class="btn" data-day-share>${icon('ext')}일정 공유</button>
    </div>
    ${timeline(dayItems(day), now)}
  `;
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
        <div><small>DATE</small><b>${esc(dayLabel(f.date))}</b></div>
        <div><small>DEPART</small><b>${esc(f.depart)}</b></div>
        <div><small>ARRIVE</small><b>${esc(f.arrive)}</b></div>
        <div><small>CLASS</small><b>${esc(f.cabin)}</b></div>
        <div><small>BAG</small><b>${esc(f.baggage)}</b></div>
        <div><small>PNR</small><b class="mono">${esc(pnr || '—')}</b></div>
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

function renderWallet() {
  const { flights, stay, guides, trip, links } = state.trip;
  const agoda = store.get('agoda', '');
  setHeader('도쿄 · 2026년 11월', '예약 · 여행 정보', `${dayLabel(trip.start)} ~ ${dayLabel(trip.end)} · ${trip.travelers}명`);
  const list = checklist();
  return `
    <button class="btn wide check-link" data-go="check">${icon('check')}체크리스트 ${list.filter((c) => isChecked(c.id)).length} / ${list.length}</button>
    ${syncCard()}
    ${expenseSection()}
    <div class="section-title"><span>항공</span></div>
    ${flights.map(boardingPass).join('')}
    <div class="btns solo">
      <a class="btn" href="${esc(links.jejuair.url)}" target="_blank" rel="noopener">${icon('ext')}${esc(links.jejuair.label)}</a>
      <button class="btn" data-doc-view="doc-eticket">${icon('plane')}e-티켓 사진</button>
    </div>

    <div class="section-title"><span>공항 가는 길</span></div>
    ${state.trip.transfers.map(transferPass).join('')}

    <div class="section-title"><span>숙소 · ${esc(stay.bookedVia)}</span></div>
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

    <div class="section-title"><span>예약번호 · 링크</span><em class="muted">폰에만 저장, 동기화로 공유</em></div>
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

    <div class="section-title"><span>문서 사진</span><button class="title-add" data-doc-new>${icon('plus')}추가</button></div>
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

    <div class="section-title"><span>긴급 연락처</span></div>
    <div class="card">
      ${(state.trip.emergency || []).map((e) => `
        <a class="sos-row" href="tel:${esc(e.tel.replace(/-/g, ''))}">
          <span class="grow"><b>${esc(e.label)}</b>${e.note ? `<small>${esc(e.note)}</small>` : ''}</span>
          <span class="sos-tel">${icon('phone')}${esc(e.tel)}</span>
        </a>`).join('')}
      ${SOS_FIELDS.map((s) => `
        <label class="field">
          <span>${esc(s.label)}</span>
          <div class="field-row">
            <input class="input mono" data-secret="${s.key}" type="tel" autocomplete="off" value="${esc(store.get(s.key, ''))}" placeholder="${esc(s.placeholder)}">
            <button class="icon-btn" data-call="${s.key}" aria-label="전화 걸기">${icon('phone')}</button>
          </div>
        </label>`).join('')}
      <button class="btn wide sos-hotel" data-ja="__stay">${icon('ja')}호텔 주소 크게 보기</button>
    </div>

    ${guides.filter((g) => !g.costs).map((g) => `
      <div class="section-title">${itemIcon(g.icon, 'sm')}<span>${esc(g.title)}</span></div>
      <div class="card"><ul class="plain">${g.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('')}
  `;
}

function renderTalk() {
  const { phrases } = state.trip;
  const [from, to] = state.talkDir === 'ko-ja' ? ['한국어', '日本語'] : ['日本語', '한국어'];
  setHeader('도쿄 · 2026년 11월', '번역 · 회화', 'Google 번역 앱 · 파파고 웹');
  const groups = [...new Set(phrases.map((p) => p.group))];
  return `
    <div class="talk">
      <div class="talk-dir">
        <b>${from}</b>
        <button class="icon-btn" data-swap aria-label="방향 바꾸기">${icon('swap')}</button>
        <b>${to}</b>
      </div>
      <div class="talk-field">
        <textarea id="talk-text" class="talk-input" rows="3" placeholder="${state.talkDir === 'ko-ja' ? '번역할 말을 입력하세요' : '日本語を入力'}">${esc(store.get('talkText', ''))}</textarea>
        <button class="talk-clear" data-talk-clear aria-label="모두 지우기" ${store.get('talkText', '') ? '' : 'hidden'}>${icon('x')}</button>
      </div>
      <div class="btns">
        <button class="btn primary" data-translate="google">Google 번역 앱</button>
        <button class="btn papago" data-translate="papago">파파고 웹</button>
        <button class="btn wide" data-live>${icon('ext')}Google 번역 앱 열기 · 실시간 번역 (대화)</button>
      </div>
      <div class="small muted talk-hint">Google 번역은 앱에 문장이 바로 들어가요. 파파고는 웹에서 열려요. 실시간 번역은 앱이 열리면 '실시간 번역'을 누른 뒤 '대화'를 고르세요.</div>
    </div>

    ${nowPhrases()}
    <div class="section-title"><span>상황별 일본어</span><em class="muted">탭하면 크게 · 스피커로 발음</em></div>
    <div class="scene-pick">${groups.map((g) => `<a href="#ph-${esc(g)}">${esc(g)}</a>`).join('')}</div>
    ${groups.map((g) => `
      <div class="phrase-group" id="ph-${esc(g)}">${esc(g)}</div>
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
  setHeader('도쿄 · 2026년 11월', '체크리스트', `${done} / ${list.length} 완료`);
  const groups = [...new Set(list.map((c) => c.group))];
  return `
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
const EX_AREAS = ['전체', '우에노·아키하바라', '아사쿠사·스카이트리', '긴자·쓰키지', '시부야·하라주쿠', '오다이바·도요스', '나카메구로·에비스', '도쿄역·신주쿠', '내 장소'];
const CAT_ICON = { eat: '🍽', drink: '☕', see: '🏛', shop: '🛍' };
const EX_KIND = { eat: 'food', drink: 'cafe', see: 'sight', shop: 'shop' };
const isSaved = (id) => !!store.get('save:' + id, false);
const visitOf = (id) => store.get('visit:' + id, null);
// Trip places plus the ones added on the phones.
const allPlaces = () => [
  ...(state.trip.places || []),
  ...store.get('myplaces', []).map((p) => ({ ...p, area: '내 장소', mine: true, desc: p.memo })),
];
const placeById = (id) => allPlaces().find((p) => p.id === id);
function placeOfItem(itemId) {
  const added = store.get('myitems', []).find((x) => x.id === itemId);
  return added ? placeById(added.placeId) : allPlaces().find((p) => p.itemId === itemId);
}
const placeInfo = (p) => (p.itemId && findItem(p.itemId)?.info)
  || { kind: EX_KIND[p.cat], r: p.r, n: p.n, recent: p.recent, hours: placeHours(p), best: p.best, tips: p.tips || (p.memo ? [p.memo] : []), mine: p.mine };
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
const placeThumb = (p, size) => `
  <span class="thumb">${itemIcon(CAT_ICON[p.cat], 'lg')}${p.photo ? `<img src="${esc(p.photo)}=${size}-k-no" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;

const AGAIN = { yes: '또 갈래요', no: '한 번이면 충분' };
const placeHero = (p) => (p?.photo ? `<div class="place-hero"><img src="${esc(p.photo)}=w800-h400-k-no" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></div>` : '');

function placeCard(p, now) {
  const info = placeInfo(p);
  const open = openNow(p, now);
  const item = p.itemId && findItem(p.itemId);
  const v = visitOf(p.id);
  const line = [info?.r ? `★${info.r.toFixed(1)}` : '', p.area.split('·')[0], p.desc || item?.title?.split(' · ').pop()].filter(Boolean).join(' · ');
  const sub = [
    open === null ? '' : open ? '영업 중' : '영업 종료',
    item ? `${dayLabel(item.date)} ${item.start}` : '일정 없음',
    p.lat ? (state.geo ? distLabel(kmBetween(state.geo, p)) : `호텔 ${distLabel(kmBetween(state.trip.stay, p))}`) : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="place ${v ? 'visited' : ''}" data-place="${esc(p.id)}" role="button" tabindex="0">
      ${placeThumb(p, 'w160-h160')}
      <div class="place-main">
        <b>${esc(p.name)}${v ? `<i>${v.again === 'yes' ? AGAIN.yes : '방문'}</i>` : ''}</b>
        <span>${esc(line)}</span>
        <small>${esc(sub)}</small>
      </div>
      <button class="place-save ${isSaved(p.id) ? 'on' : ''}" data-place-save="${esc(p.id)}" aria-label="저장">${isSaved(p.id) ? '♥' : '♡'}</button>
    </div>`;
}

function exploreList(now) {
  const f = state.ex;
  let list = allPlaces().filter((p) => p.cat === f.cat);
  if (f.area !== '전체') list = list.filter((p) => p.area === f.area);
  if (f.open) list = list.filter((p) => openNow(p, now));
  if (f.plan) list = list.filter((p) => p.itemId);
  if (f.again) list = list.filter((p) => visitOf(p.id)?.again === 'yes');
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
          <span>${esc([person(v.by), AGAIN[v.again]].filter(Boolean).join(' · '))}</span>
          ${v.memo ? `<small>${esc(v.memo)}</small>` : ''}
        </div>
      </div>`;
  }).join('')}`).join('') : '<div class="card small muted">다녀온 곳에서 방문 표시를 누르면 여기에 모여요.</div>'}
    <div class="section-title"><span>가고 싶은 곳</span><em>${saved.length}</em></div>
    ${saved.length ? saved.map((p) => placeCard(p, now)).join('') : '<div class="card small muted">하트를 누른 곳이 여기에 모여요.</div>'}`;
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
  setHeader('도쿄 · 2026년 11월', '탐색', `${allPlaces().length}곳 · 방문 ${seen}곳`);
  const toggles = [['open', '지금 영업'], ['plan', '일정 장소'], ['saved', '저장함'], ['again', '또 갈 곳'], ['near', '내 주변']];
  const list = f.cat === 'log' ? [] : exploreList(now);
  return `
    <div class="ex-cats">${EX_CATS.map(([k, label, ico]) => `<button class="seg ${f.cat === k ? 'on' : ''}" data-ex-cat="${k}">${icon(ico)}${label}</button>`).join('')}</div>
    ${f.cat === 'log' ? exploreLog(now) : `
      <div class="ex-row">${EX_AREAS.map((a) => `<button class="${f.area === a ? 'on' : ''}" data-ex-area="${esc(a)}">${esc(a)}</button>`).join('')}</div>
      <button class="btn wide ex-add" data-place-new>${icon('plus')}내 장소 추가</button>
      <div class="ex-row">${toggles.map(([k, label]) => `<button class="${f[k] ? 'on' : ''}" data-ex-toggle="${k}">${label}</button>`).join('')}</div>
      ${list.length ? list.map((p) => placeCard(p, now)).join('') : '<div class="card small muted">조건에 맞는 곳이 없어요. 필터를 줄여 보세요.</div>'}
      <div class="small muted ex-asof">구글지도 ${esc(state.trip.trip.infoAsOf || '')} 기준 저장 정보 · 영업시간은 다시 확인</div>`}`;
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

function openPlace(id) {
  const p = placeById(id);
  if (!p) return;
  const v = visitOf(id);
  const item = p.itemId && findItem(p.itemId);
  const q = encodeURIComponent(item?.place?.query || p.name);
  const mapUrl = p.url || `https://www.google.com/maps/search/?api=1&query=${q}`;
  const hasPhoto = state.docSlots.has('place-' + id);
  $('#sheet-body').innerHTML = `
    ${placeHero(p)}
    <div class="eyebrow dark">${esc(p.area)}</div>
    <div class="sheet-head"><h3>${esc(p.name)}</h3></div>
    ${p.desc ? `<div class="muted">${esc(p.desc)}</div>` : ''}
    ${infoCard({ info: placeInfo(p) })}
    <div class="btns">
      <a class="btn" href="${esc(mapUrl)}" target="_blank" rel="noopener">${icon('ext')}구글지도</a>
      <a class="btn primary" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat ? `${p.lat},${p.lng}` : q}&travelmode=transit" target="_blank" rel="noopener">${icon('nav')}길찾기</a>
      <button class="btn" data-place-save="${esc(id)}">${isSaved(id) ? '♥ 저장됨' : '♡ 저장'}</button>
      <button class="btn" data-place-visit="${esc(id)}">${v ? `${icon('check')}방문함` : '방문 표시'}</button>
      ${item ? `<button class="btn wide" data-item="${esc(item.id)}">${esc(dayLabel(item.date))} ${esc(item.start)} 일정 보기</button>`
    : `<button class="btn wide" data-place-plan="${esc(id)}">${icon('plus')}일정에 넣기</button>`}
      ${p.mine ? `<button class="btn wide" data-place-del="${esc(id)}">내 장소 삭제</button>` : ''}
    </div>
    <div class="section-title"><span>내 기록</span></div>
    ${v ? `<div class="rate-row">${rateBtns(id, v.again, 'place')}</div>` : ''}
    <textarea class="input place-memo" data-place-memo="${esc(id)}" rows="3" maxlength="300" placeholder="맛, 분위기, 다시 가고 싶은지 남겨 보세요">${esc(v?.memo || '')}</textarea>
    <div class="btns">
      <button class="btn" data-doc-add="place-${esc(id)}">${icon('plus')}사진 추가</button>
      <button class="btn" data-doc-view="place-${esc(id)}" ${hasPhoto ? '' : 'disabled'}>사진 보기</button>
    </div>`;
  $('#sheet').hidden = false;
}

function openPlaceNew() {
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>내 장소 추가</h3></div>
    <label class="field"><span>이름</span><input class="input" id="pn-name" maxlength="30" placeholder="예: 친구가 추천한 라멘집"></label>
    <label class="field"><span>분류</span><select class="input" id="pn-cat">${EX_CATS.filter(([k]) => k !== 'log').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    <label class="field"><span>구글지도 링크 (선택)</span><input class="input" id="pn-url" type="url" autocomplete="off" placeholder="공유 링크 붙여넣기"></label>
    <label class="field"><span>메모 (선택)</span><input class="input" id="pn-memo" maxlength="80" placeholder="추천 메뉴, 이유"></label>
    <button class="btn primary wide doc-pick" data-place-create>저장</button>`;
  $('#sheet').hidden = false;
}
function createPlace() {
  const name = $('#pn-name').value.trim();
  if (!name) return toast('이름을 입력해 주세요.');
  const url = $('#pn-url').value.trim();
  const hit = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) || url.match(/@(-?[\d.]+),(-?[\d.]+)/);
  const place = { id: uid('my'), name, cat: $('#pn-cat').value, memo: $('#pn-memo').value.trim(), ...(/^https?:/.test(url) ? { url } : {}), ...(hit ? { lat: Number(hit[1]), lng: Number(hit[2]) } : {}) };
  store.set('myplaces', [...store.get('myplaces', []), place]);
  state.ex.cat = place.cat;
  state.ex.area = '내 장소';
  closeSheet();
  render();
  toast('내 장소에 추가했어요');
}
function deletePlace(id) {
  if (!confirm('이 장소를 삭제할까요?')) return;
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
    <label class="field"><span>시작 시간</span><input class="input" id="pl-time" type="time" value="12:00"></label>
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

function openEditItem(id) {
  const it = findItem(id);
  $('#sheet-body').innerHTML = `
    <div class="sheet-head"><h3>일정 시간 변경</h3></div>
    <div class="muted">${esc(it.title)}</div>
    <label class="field"><span>시작</span><input class="input" id="ed-start" type="time" value="${esc(it.start)}"></label>
    <label class="field"><span>종료</span><input class="input" id="ed-end" type="time" value="${esc(it.end || '')}"></label>
    ${'alarm' in it ? '<div class="small muted alarm-note">캘린더 알림은 자동으로 바뀌지 않아요.</div>' : ''}
    ${it.hard ? '<div class="small muted alarm-note">예약·탑승 시간이 정해진 일정이에요. 예약 시간도 확인하세요.</div>' : ''}
    <div class="btns">
      <button class="btn primary" data-edit-save="${esc(id)}">저장</button>
      <button class="btn" data-edit-reset="${esc(id)}">원래대로</button>
    </div>`;
  $('#sheet').hidden = false;
}
function saveEdit(id) {
  const start = $('#ed-start').value;
  const end = $('#ed-end').value;
  if (!start) return toast('시작 시간을 입력해 주세요.');
  if (end && end <= start) return toast('종료는 시작보다 늦어야 해요.');
  const old = store.get('edit:' + id, null) || {};
  store.set('edit:' + id, { ...old, start, ...(end ? { end } : {}) });
  closeSheet();
  render();
  toast('일정을 바꿨어요');
}
function toggleSkip(id) {
  if (isDone(id)) completeItem(id);
  const old = store.get('edit:' + id, null) || {};
  store.set('edit:' + id, { ...old, skip: !old.skip });
  closeSheet();
  render();
}
function deleteItem(id) {
  if (!confirm('추가한 일정을 삭제할까요?')) return;
  forget('myitems:' + id);
  store.set('myitems', store.get('myitems', []).filter((x) => x.id !== id));
  closeSheet();
  render();
}

function toggleSave(id) {
  store.set('save:' + id, !isSaved(id));
  render();
  if (!$('#sheet').hidden) openPlace(id);
}
const rateBtns = (id, again, from) => Object.entries(AGAIN).map(([k, label]) => `<button type="button" class="btn ${again === k ? 'primary' : ''}" data-rate="${esc(id)}" data-again="${k}" data-from="${from}">${label}</button>`).join('');

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
  if (p && !visitOf(p.id)) store.set('visit:' + p.id, { at: Date.now(), by: who(), memo: '', again: '' });
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
    <div class="eyebrow dark">방문 완료</div>
    <div class="sheet-head"><h3>${esc(p?.name || stripEmoji(it.title).split(' · ').pop())}</h3></div>
    <form class="finish" data-exp-item="${esc(id)}">
      ${money ? `
        <label class="finish-label" for="finish-amount">쓴 돈${spent.length ? ` · ${yen(spent.reduce((a, e) => a + e.amount, 0))}` : ''}</label>
        <input class="input" id="finish-amount" name="amount" inputmode="numeric" pattern="[0-9]*" placeholder="${spent.length ? '추가 금액 (엔)' : '금액 (엔)'}" autocomplete="off">
        ${spent.map(expRow).join('')}` : ''}
      ${p ? `
        <div class="finish-label">또 갈래요?</div>
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
  store.set('visit:' + id, { at: v?.at || Date.now(), by: v?.by || who(), memo: v?.memo || '', again });
  render();
  if (from === 'place') return openPlace(id);
  document.querySelectorAll('.finish [data-rate]').forEach((b) => b.classList.toggle('primary', b.dataset.again === again));
}

function toggleVisit(id) {
  const v = visitOf(id);
  store.set('visit:' + id, v ? null : { at: Date.now(), by: who(), memo: '' });
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
  return place ? { id, label: place.name, icon: '📎', max: 20 } : allDocs().find((s) => s.id === id);
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
    <div class="sheet-head">${itemIcon('📎', 'lg')}<h3>문서 추가</h3></div>
    <label class="field"><span>제목</span>
      <input class="input" id="doc-title" maxlength="20" placeholder="예: 여행자보험 증권" autocomplete="off"></label>
    <button class="btn primary doc-pick" data-doc-pick>${icon('plus')}사진 선택 (여러 장 가능)</button>`;
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
    toast(`${slot?.label || '문서'} 사진이 아직 없어요. 예약 탭의 문서 사진에서 추가하세요.`);
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
  $('#viewer-cap').textContent = `${slot?.label || ''}${n > 1 ? ` · ${viewerIndex() + 1} / ${n}` : ''} · QR은 화면 밝기를 올려 보여주세요`;
}

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
      ${f.r ? `<div class="info-rate"><b>★ ${f.r.toFixed(1)}</b><span>리뷰 ${esc(f.n)}${f.recent ? ` · 최근 평균 ${f.recent.toFixed(1)}` : ''}</span></div>` : ''}
      ${f.ko ? `<div class="small muted info-ko">${/^최근/.test(f.ko) ? '' : '한국어 리뷰 '}${esc(f.ko)}</div>` : ''}
      ${facts.length ? `<dl class="info-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${f.best?.length ? `<div class="info-sec"><h4>${INFO_BEST[f.kind] || '볼거리'}</h4><div class="info-tags">${f.best.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${f.tips?.length ? `<div class="info-sec"><h4>알아둘 점</h4><ul class="info-tips">${f.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${f.alt ? `<div class="info-sec"><h4>대안</h4><div class="small">${esc(f.alt)}</div></div>` : ''}
      ${f.mine ? '' : `<div class="small muted info-asof">구글지도 ${esc(state.trip.trip.infoAsOf || '')} 기준 · 방문 전 다시 확인</div>`}
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
  const now = tokyoNow();
  const done = isDone(it.id);
  const place = placeOfItem(it.id);
  const next = nextStop(it);
  const pending = !done && !it.skip;
  const mine = String(it.id).startsWith('my-it');
  const spent = expenses().filter((e) => e.item === it.id).reduce((a, e) => a + e.amount, 0);
  const v = place && visitOf(place.id);
  const summary = [AGAIN[v?.again], spent ? yen(spent) : '', v?.memo].filter(Boolean).join(' · ');
  $('#sheet-body').innerHTML = `
    ${placeHero(place)}
    <div class="eyebrow dark">${esc(dayLabel(it.date))} · ${esc(it.start)}${it.end ? ' — ' + esc(it.end) : ''}</div>
    <div class="sheet-head">${itemIcon(it.icon, 'lg')}<h3>${esc(it.title)}</h3></div>
    ${it.place ? `<div class="ja muted">${esc(it.place.nameJa)}</div>` : ''}
    ${chipsHtml(chipsFor(it, now))}
    ${infoCard(it)}
    ${it.rainPlan ? `<div class="card note"><b class="note-h">${icon('umbrella')}비 올 때</b><div class="small">${esc(it.rainPlan)}</div></div>` : ''}
    ${it.docs ? `<div class="section-title"><span>여기서 꺼낼 서류</span></div><div class="btns">${docBtns(it, 'btn wide')}</div>` : ''}
    ${it.link ? `<div class="section-title"><span>위치 안내</span></div><div class="btns"><a class="btn wide" href="${esc(it.link.url)}" target="_blank" rel="noopener">${icon('ext')}${esc(it.link.label)}</a></div>` : ''}
    <div class="btns">
      ${it.place?.lang === 'ko' ? navBtn(it.id, '네이버지도로 보기', pending ? 'primary wide' : 'wide') : ''}
      ${it.place && it.place.lang !== 'ko' ? navBtn(it.id, '길찾기', pending ? 'primary wide' : 'wide') : ''}
    </div>
    ${it.place && it.place.lang !== 'ko' ? `
      <div class="sheet-tools">
        <a class="tool" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.place.query || it.place.nameJa)}" target="_blank" rel="noopener">${icon('ext')}구글지도</a>
        <button class="tool" data-ja="${esc(it.id)}">${icon('ja')}일본어 크게</button>
        <button class="tool" data-talk-text="${esc(it.place.nameJa)}">${icon('swap')}번역기로</button>
      </div>` : ''}
    <div class="state-seg" role="group" aria-label="일정 상태">
      <button class="seg ${done ? 'on' : ''}" data-done="${esc(it.id)}" aria-pressed="${done}"><i class="check-box"></i>방문 완료</button>
      ${mine ? '' : `<button class="seg ${it.skip ? 'on' : ''}" data-item-skip="${esc(it.id)}" aria-pressed="${!!it.skip}">${icon('skip')}건너뛰기</button>`}
      <button class="seg" data-item-edit="${esc(it.id)}">${icon('clock')}시간 변경</button>
      ${mine ? `<button class="seg" data-item-del="${esc(it.id)}">${icon('x')}일정 삭제</button>` : ''}
    </div>
    <div class="btns">
      ${done && (it.place || place) ? `<button class="finish-sum" data-finish-open="${esc(it.id)}"><b>방문 기록</b><span>${esc(summary || '쓴 돈과 평가 남기기')}</span></button>` : ''}
      ${!pending && next ? navBtn(next.id, `다음: ${next.title.split(' · ').pop()}`, 'primary wide') : ''}
    </div>
    ${sceneOf(it) ? `
      <details class="sheet-more">
        <summary><span>${icon('ja')}여기서 쓸 일본어 · ${esc(sceneOf(it))}</span><i class="chev"></i></summary>
        <div class="card list">${phrasesFor(sceneOf(it)).slice(0, 6).map(phraseRow).join('')}</div>
      </details>` : ''}`;
  $('#sheet').hidden = false;
}
const closeSheet = () => { $('#sheet').hidden = true; };

function showJa({ ja, sub, ko, read }) {
  $('#bigja-body').innerHTML = `
    <div class="ja ja-name">${esc(ja)}</div>
    ${read ? `<div class="ja-read">${esc(read)}</div>` : ''}
    ${sub ? `<div class="ja ja-addr">${esc(sub)}</div>` : ''}
    ${ko ? `<div class="ja-ko">${esc(ko)}</div>` : ''}
    <button class="btn primary ja-speak" data-speak-text="${esc(ja)}">${icon('sound')}발음 듣기</button>`;
  $('#bigja').hidden = false;
}

function openJa(id) {
  if (id === '__stay') {
    const { stay } = state.trip;
    return showJa({ ja: stay.nameJa, sub: `${stay.address}\nここへ行ってください。`, ko: '이 호텔로 가 주세요' });
  }
  const place = findItem(id)?.place;
  if (!place) return;
  showJa({
    ja: place.nameJa,
    sub: `${place.query && place.query !== place.nameJa ? place.query + '\n' : ''}ここへ行きたいです。`,
    ko: '여기에 가고 싶어요',
  });
}

// ---------- shell ----------
function setHeader(eyebrow, title, sub) {
  $('#top-eyebrow').textContent = eyebrow;
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
const APP_VERSION = 72;
async function loadLatest() {
  try {
    const text = await (await fetch(`sw.js?t=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = Number(text.match(/trip-v(\d+)/)?.[1]);
    if (latest && latest !== state.latest) { state.latest = latest; render(); }
  } catch { /* offline: keep showing the running version */ }
}
const versionLine = () => (state.latest > APP_VERSION
  ? `<button class="app-ver new" data-update>새 버전 v${state.latest} 있음 · 지금 업데이트</button>`
  : `<div class="app-ver">앱 버전 v${APP_VERSION}${state.latest === APP_VERSION ? ' · 최신' : ''}</div>`);

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

function render() {
  if (!state.trip) return;
  const views = { today: renderToday, days: renderDays, explore: renderExplore, wallet: renderWallet, talk: renderTalk, check: renderCheck };
  $('#view').innerHTML = views[state.tab]() + versionLine();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === (state.tab === 'check' ? 'wallet' : state.tab))));
  if (state.tab === 'wallet') hydrateDocs();
  if (state.tab === 'explore' && state.ex.cat === 'log') hydrateLog();
}

function go(tab) {
  state.tab = TABS.includes(tab) ? tab : 'today';
  store.set('tab', state.tab);
  closeSheet();
  render();
  window.scrollTo(0, 0);
}

async function copy(key) {
  const v = store.get(key, '');
  if (!v) return toast('먼저 번호를 입력해 주세요.');
  try { await navigator.clipboard.writeText(v); toast('복사했어요'); }
  catch { toast('복사하지 못했어요'); }
}

const ACTIONS = '[data-tab],[data-go],[data-day],[data-nav],[data-ja],[data-item],[data-check],[data-del],[data-done],[data-rate],[data-finish-open],'
  + '[data-close],[data-close-ja],[data-close-viewer],[data-copy],[data-copy-text],[data-call],[data-open-secret],[data-doc-view],[data-doc-add],[data-doc-new],[data-doc-pick],[data-viewer-del],'
  + '[data-translate],[data-live],[data-swap],[data-phrase],[data-speak],[data-speak-text],[data-talk-text],[data-wx-refresh],'
  + '[data-place-new],[data-place-create],[data-place-del],[data-place-plan],[data-plan-save],[data-item-edit],[data-edit-save],[data-edit-reset],[data-item-skip],[data-item-del],[data-day-route],[data-day-share],[data-place-save],[data-place-visit],[data-ex-cat],[data-ex-area],[data-ex-toggle],[data-update],[data-alarm-sheet],[data-place],[data-go-exp],[data-exp-view],[data-exp-del],[data-budget],[data-who],[data-sync-build],[data-sync-share],[data-sync-pick],'
  + '[data-talk-clear],[data-sync-toggle],[data-fx],[data-fx-swap],[data-fx-clear],[data-fx-set],[data-fx-refresh],[data-fx-log]';

document.addEventListener('click', async (e) => {
  const el = e.target.closest(ACTIONS);
  if (!el) return;
  const d = el.dataset;
  if (d.tab) go(d.tab);
  else if (d.go) go(d.go);
  else if (d.day) { state.dayIndex = Number(d.day); store.set('day', state.dayIndex); render(); }
  else if (d.nav) navigate(d.nav);
  else if (d.ja) openJa(d.ja);
  else if (d.item) openItem(d.item);
  else if (d.check) {
    const c = checklist().find((x) => x.id === d.check);
    if (docsReady(c)) return viewDoc(c.docs[0]);
    setChecked(d.check, !isChecked(d.check));
    render();
  }
  else if (d.del) { forget('custom:' + d.del); store.set('custom', store.get('custom', []).filter((c) => c.id !== d.del)); render(); }
  else if (d.done) completeItem(d.done);
  else if (d.rate) setAgain(d.rate, d.again, d.from);
  else if (d.finishOpen) openFinish(d.finishOpen);
  else if ('close' in d) closeSheet();
  else if ('closeJa' in d) { $('#bigja').hidden = true; window.speechSynthesis?.cancel(); }
  else if ('closeViewer' in d) $('#viewer').hidden = true;
  else if ('viewerDel' in d) {
    if (!confirm('지금 보고 있는 사진을 삭제할까요?')) return;
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
    try { await navigator.clipboard.writeText(d.copyText); toast('복사했어요 · Safari 주소창에 붙여넣으세요'); }
    catch { toast('복사하지 못했어요'); }
  }
  else if (d.call) {
    const tel = store.get(d.call, '').replace(/[^0-9+]/g, '');
    if (tel) location.href = `tel:${tel}`; else toast('먼저 번호를 입력해 주세요.');
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
  else if ('alarmSheet' in d) openAlarms();
  else if ('placeNew' in d) openPlaceNew();
  else if ('placeCreate' in d) createPlace();
  else if (d.placeDel) deletePlace(d.placeDel);
  else if (d.placePlan) openPlan(d.placePlan);
  else if (d.planSave) savePlan(d.planSave);
  else if (d.itemEdit) openEditItem(d.itemEdit);
  else if (d.editSave) saveEdit(d.editSave);
  else if (d.editReset) { store.set('edit:' + d.editReset, null); closeSheet(); render(); }
  else if (d.itemSkip) toggleSkip(d.itemSkip);
  else if (d.itemDel) deleteItem(d.itemDel);
  else if ('dayRoute' in d) dayRoute();
  else if ('dayShare' in d) shareDay();
  else if (d.placeSave) toggleSave(d.placeSave);
  else if (d.placeVisit) toggleVisit(d.placeVisit);
  else if (d.place) openPlace(d.place);
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
  else if ('fxClear' in d) { state.fxCalc.value = ''; $('#fx-in').value = ''; updateFx(); $('#fx-in').focus(); }
  else if (d.fxSet) {
    // Each tap adds, so 5,000 + 1,000 + 500 builds 6,500 without typing.
    const f = state.fxCalc;
    f.value = String((Number(String(f.value).replace(/[^0-9.]/g, '')) || 0) + Number(d.fxSet));
    $('#fx-in').value = f.value; updateFx();
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
  else if ('syncToggle' in d) { state.syncOpen = !state.syncOpen; render(); }
  else if ('live' in d) openLive();
  else if ('swap' in d) { state.talkDir = state.talkDir === 'ko-ja' ? 'ja-ko' : 'ko-ja'; render(); }
  else if (d.phrase) { const p = state.trip.phrases[d.phrase]; showJa({ ja: p.ja, read: p.read, ko: p.ko }); }
  else if (d.speak) speak(state.trip.phrases[d.speak].ja);
  else if (d.speakText) speak(d.speakText);
  else if ('wxRefresh' in d) loadWeather(true);
  else if (d.talkText) { store.set('talkText', d.talkText); state.talkDir = 'ja-ko'; go('talk'); }
  else if (d.expView) { state.expView = d.expView; render(); }
  else if ('goExp' in d) { state.expView = 'spent'; go('wallet'); $('#exp')?.scrollIntoView({ block: 'start' }); scrollBy(0, -100); }
  else if (d.expDel) {
    if (!confirm('이 지출 기록을 삭제할까요?')) return;
    forget('exp:' + d.expDel);
    store.set('exp', expenses().filter((x) => x.id !== d.expDel));
    if ($('#sheet').hidden) render(); else { const id = $('#sheet-body [data-exp-item]')?.dataset.expItem; render(); if (id) openFinish(id); }
  }
  else if ('budget' in d) {
    const v = prompt('예산 (엔, 쇼핑 제외)', String(store.get('budget', state.trip.budget?.yen || 0)));
    if (v !== null && Number(v.replace(/[^0-9]/g, '')) >= 0) { store.set('budget', Number(v.replace(/[^0-9]/g, ''))); render(); }
  }
  else if (d.who) { store.set('who', d.who); state.syncFile = null; render(); }
  else if ('syncBuild' in d) { state.syncFailed = false; render(); }
  else if ('syncShare' in d) shareSyncFile();
  else if ('syncPick' in d) $('#sync-file').click();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.placeMemo) {
    const id = t.dataset.placeMemo;
    const v = visitOf(id);
    store.set('visit:' + id, { ...v, at: v?.at || Date.now(), by: v?.by || who(), memo: t.value });
    return;
  }
  if (t.dataset.secret) store.set(t.dataset.secret, t.type === 'url' || t.type === 'tel' ? t.value.trim() : t.value.trim().toUpperCase());
  else if (t.id === 'fx-in') { state.fxCalc.value = t.value; updateFx(); }
  else if (t.id === 'fx-tax') { state.fxCalc.tax = t.checked; updateFx(); }
  else if (t.id === 'talk-text') { store.set('talkText', t.value); $('.talk-clear').hidden = !t.value; }
});

document.addEventListener('submit', (e) => {
  if (e.target.classList.contains('exp-form')) {
    e.preventDefault();
    const f = new FormData(e.target);
    const amount = Number(String(f.get('amount')).replace(/[^0-9]/g, ''));
    if (!amount) return toast('금액을 엔으로 입력해 주세요.');
    const item = e.target.dataset.expItem || null;
    addExpense({ amount, memo: String(f.get('memo') || '').trim(), cat: f.get('cat'), item, date: item ? findItem(item)?.date : undefined });
    toast(`${yen(amount)} (${won(amount)}) 기록했어요`);
    render();
    return;
  }
  if (e.target.classList.contains('finish')) {
    e.preventDefault();
    const it = findItem(e.target.dataset.expItem);
    const amount = Number(String(new FormData(e.target).get('amount') || '').replace(/[^0-9]/g, ''));
    if (amount) {
      addExpense({ amount, memo: stripEmoji(it.title).split(' · ').pop(), cat: SCENE_CAT[sceneOf(it)] || '기타', item: it.id, date: it.date });
      toast(`${yen(amount)} (${won(amount)}) 기록했어요`);
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
    if (saved) toast(`${saved}장 저장했어요 · 다른 폰과는 예약정보 동기화로 맞출 수 있어요`);
  } catch { toast('사진을 저장하지 못했어요. 저장 공간을 확인해 주세요.'); }
  state.pendingDoc = state.pendingTitle = null;
  render();
  if (slotId.startsWith('place-')) openPlace(slotId.slice(6));
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

async function init() {
  try {
    const res = await fetch('data/trip.json', { cache: 'no-cache' });
    state.trip = await res.json();
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
  state.fx = store.get('fx', null);
  await refreshDocSlots();
  render();
  loadWeather();
  loadFx();
  loadClips();
  loadLatest();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
