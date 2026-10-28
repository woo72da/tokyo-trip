'use strict';

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const state = { trip: null, tab: 'today', dayIndex: 0 };

// ---------- storage (localStorage can throw in private mode) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
const isChecked = (id) => store.get('ck:' + id, false);
const setChecked = (id, on) => store.set('ck:' + id, on);
const isDone = (id) => store.get('done:' + id, false);
const setDone = (id, on) => store.set('done:' + id, on);

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
const fmtMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const dowOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const shortDate = (date) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
const dayLabel = (date) => `${shortDate(date)} (${WEEKDAYS[dowOf(date)]})`;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

function allItems() {
  return state.trip.days.flatMap((d) => d.items.map((it) => ({ ...it, date: d.date })));
}
function findItem(id) {
  return allItems().find((it) => it.id === id);
}

// Items sorted by start, with startMin/endMin filled in (missing end = next start or +30 min).
function dayItems(day) {
  const items = [...day.items].sort((a, b) => toMin(a.start) - toMin(b.start));
  return items.map((it, i) => {
    const startMin = toMin(it.start);
    const nextStart = items.slice(i + 1).map((n) => toMin(n.start)).find((m) => m > startMin);
    const endMin = it.end ? toMin(it.end) : Math.min(nextStart ?? startMin + 30, startMin + 120);
    return { ...it, date: day.date, startMin, endMin };
  });
}

function bookingNeeded(it) {
  if (!it.booking?.required) return false;
  const ck = state.trip.checklist.find((c) => c.linkItem === it.id);
  return !(ck && isChecked(ck.id));
}

// Warning chips for an item on its date; `now` adds "closing soon" when it is today.
function chipsFor(it, now) {
  const chips = [];
  if (it.priority === 'must') chips.push(['must', '필수']);
  if (it.priority === 'optional') chips.push(['', '선택']);
  if (it.booking?.required) chips.push(bookingNeeded(it) ? ['warn', '🎫 예약 필요'] : ['ok', '🎫 예약 완료']);
  if (it.closedDays?.includes(dowOf(it.date))) chips.push(['warn', '⛔ 이 날 휴무']);
  if (it.hours) {
    chips.push(['', '🕘 ' + it.hours]);
    const close = it.hours.split('~')[1];
    if (now && now.date === it.date && close) {
      const left = toMin(close) - now.min;
      if (left > 0 && left <= 60) chips.push(['warn', `곧 마감 (${left}분)`]);
      if (left <= 0) chips.push(['warn', '영업 종료']);
    }
  }
  if (it.verify) chips.push(['warn', '⚠️ 확인 필요']);
  if (it.rainPlan) chips.push(['', '☔ 대안 있음']);
  return chips;
}
const chipsHtml = (chips) => chips.length
  ? `<div class="chips">${chips.map(([cls, t]) => `<span class="chip ${cls}">${esc(t)}</span>`).join('')}</div>`
  : '';

function mapLinks(place) {
  const q = encodeURIComponent(place.query || place.nameJa);
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=transit`,
    apple: `https://maps.apple.com/?daddr=${q}&dirflg=r`,
  };
}

// ---------- views ----------
function renderToday() {
  const now = tokyoNow();
  const { trip, days } = state.trip;
  const dayIdx = days.findIndex((d) => d.date === now.date);

  if (now.date < trip.start) {
    const left = daysBetween(now.date, trip.start);
    const todo = state.trip.checklist.filter((c) => !isChecked(c.id));
    const urgent = todo.filter((c) => c.group === '예약');
    setHeader(trip.title, `${dayLabel(trip.start)} 출발`);
    return `
      <div class="card countdown">
        <div class="muted">출발까지</div>
        <div class="big">D-${left}</div>
        <div class="muted small">${esc(state.trip.flights[0].no)} · ${esc(state.trip.flights[0].depart)} 인천 T${esc(state.trip.flights[0].fromTerminal)}</div>
      </div>
      ${urgent.length ? `
        <div class="section-title">🚨 지금 예약해야 할 것</div>
        <div class="card">${urgent.map(checkRow).join('')}</div>` : ''}
      <div class="section-title">남은 준비 ${todo.length}개</div>
      <div class="card"><button class="btn wide" data-go="check">체크리스트 열기</button></div>
      <div class="section-title">첫날 미리보기 · ${esc(dayLabel(days[0].date))}</div>
      ${timeline(dayItems(days[0]).slice(0, 4), null)}
    `;
  }
  if (dayIdx === -1) {
    setHeader(trip.title, '여행이 끝났어요');
    return `<div class="empty">おつかれさまでした 🙇<br>즐거운 여행이었기를!</div>`;
  }

  const day = days[dayIdx];
  const items = dayItems(day);
  const active = items.filter((it) => it.startMin <= now.min && now.min < it.endMin && !isDone(it.id));
  const current = active[active.length - 1];
  const upcoming = items.filter((it) => it.startMin > now.min);
  const next = upcoming[0];
  setHeader(`D${dayIdx + 1} · ${dayLabel(day.date)}`, `${day.title} · 일몰 ${day.sunset}`);

  let html = '';
  if (current) html += heroCard(current, 'now', now);
  if (next) html += (current ? '<div style="height:10px"></div>' : '') + heroCard(next, 'next', now);
  if (!current && !next) html += `<div class="card empty">오늘 일정이 모두 끝났어요. 푹 쉬세요 🛌</div>`;

  const later = upcoming.slice(1);
  if (later.length) html += `<div class="section-title">이후 일정</div>${timeline(later, now)}`;
  return html;
}

function heroCard(it, kind, now) {
  const links = it.place ? mapLinks(it.place) : null;
  const progress = kind === 'now'
    ? Math.max(0, Math.min(100, ((now.min - it.startMin) / (it.endMin - it.startMin)) * 100))
    : 0;
  const label = kind === 'now'
    ? `지금 · ${it.endMin - now.min}분 남음`
    : `다음 · ${formatLeft(it.startMin - now.min)} 후`;
  return `
    <div class="hero ${kind === 'now' ? 'now' : ''}">
      <div class="hero-label ${kind}">${esc(label)}</div>
      <div class="hero-time">${esc(it.start)}${it.end ? '~' + esc(it.end) : ''}</div>
      <div class="hero-title">${esc(it.icon || '')} ${esc(it.title)}</div>
      ${it.note ? `<div class="hero-note">${esc(it.note)}</div>` : ''}
      ${chipsHtml(chipsFor(it, now))}
      ${kind === 'now' ? `<div class="progress"><i style="width:${progress}%"></i></div>` : ''}
      <div class="btns">
        ${links ? `<a class="btn primary" href="${links.google}" target="_blank" rel="noopener">🧭 길찾기</a>
                   <button class="btn" data-ja="${esc(it.id)}">🇯🇵 일본어</button>` : ''}
        <button class="btn wide" data-item="${esc(it.id)}">자세히</button>
      </div>
    </div>`;
}
const formatLeft = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? (m % 60) + '분' : ''}`.trim() : `${m}분`);

function timeline(items, now) {
  if (!items.length) return '';
  return `<div class="tl">${items.map((it) => {
    const isToday = now && now.date === it.date;
    const cls = [
      isDone(it.id) ? 'done' : '',
      isToday && it.endMin <= now.min ? 'past' : '',
      isToday && it.startMin <= now.min && now.min < it.endMin ? 'current' : '',
    ].join(' ');
    const warn = chipsFor(it, now).filter(([c]) => c === 'warn');
    return `
      <button class="tl-item ${cls}" data-item="${esc(it.id)}">
        <div class="tl-time">${esc(it.start)}</div>
        <div class="tl-card ${esc(it.priority || '')}">
          <div class="tl-title">${esc(it.icon || '')} ${esc(it.title)}</div>
          ${it.note ? `<div class="tl-sub">${esc(it.note)}</div>` : ''}
          ${chipsHtml(warn)}
        </div>
      </button>`;
  }).join('')}</div>`;
}

function renderDays() {
  const now = tokyoNow();
  const { days } = state.trip;
  const day = days[state.dayIndex];
  setHeader('일정', `${days.length}일 · 사도닉스 우에노`);
  return `
    <div class="daypick" role="group" aria-label="날짜 선택">
      ${days.map((d, i) => `
        <button class="dp ${d.date === now.date ? 'today' : ''}" data-day="${i}" aria-pressed="${i === state.dayIndex}">
          <b>D${i + 1}</b><span>${esc(dayLabel(d.date))}</span>
        </button>`).join('')}
    </div>
    <div class="day-head">
      <h2>${esc(day.title)}</h2>
      <div class="muted small">일몰 ${esc(day.sunset)} · ${day.items.length}개 일정</div>
    </div>
    ${timeline(dayItems(day), now)}
  `;
}

function renderInfo() {
  const { flights, stay, guides, trip } = state.trip;
  const pnr = store.get('pnr', '');
  setHeader('여행 정보', `${dayLabel(trip.start)} ~ ${dayLabel(trip.end)} · ${trip.travelers}명`);
  const stayLinks = mapLinks(stay);
  return `
    <div class="section-title">✈️ 항공</div>
    ${flights.map((f) => `
      <div class="card">
        <div class="row"><b class="grow">${esc(f.label)} · ${esc(f.airline)} ${esc(f.no)}</b><span class="muted small">${esc(dayLabel(f.date))}</span></div>
        <div class="flight">
          <div><div class="code">${esc(f.from)}</div><div class="t">${esc(f.depart)}</div><div class="muted small">${esc(f.fromName)} T${esc(f.fromTerminal)}</div></div>
          <div class="muted small">${esc(f.duration)}<br>→</div>
          <div><div class="code">${esc(f.to)}</div><div class="t">${esc(f.arrive)}</div><div class="muted small">${esc(f.toName)} T${esc(f.toTerminal)}</div></div>
        </div>
        <dl class="kv"><dt>좌석</dt><dd>${esc(f.cabin)}</dd><dt>위탁</dt><dd>${esc(f.baggage)}</dd></dl>
      </div>`).join('')}
    <div class="card">
      <label class="small muted" for="pnr">예약번호 (이 기기에만 저장)</label>
      <input id="pnr" class="input" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(pnr)}" placeholder="예약번호 입력">
    </div>

    <div class="section-title">🏨 숙소</div>
    <div class="card">
      <b>${esc(stay.name)}</b>
      <div class="ja muted">${esc(stay.nameJa)}</div>
      <dl class="kv">
        <dt>체크인</dt><dd>${esc(stay.checkIn)}</dd>
        <dt>체크아웃</dt><dd>${esc(stay.checkOut)}</dd>
        <dt>조식</dt><dd>${esc(stay.breakfast)}</dd>
      </dl>
      <ul class="plain">${stay.stations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="btns">
        <a class="btn primary" href="${stayLinks.google}" target="_blank" rel="noopener">🧭 호텔로</a>
        <button class="btn" data-ja="__stay">🇯🇵 택시용</button>
      </div>
    </div>

    ${guides.map((g) => `
      <div class="section-title">${esc(g.icon)} ${esc(g.title)}</div>
      <div class="card"><ul class="plain">${g.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('')}
  `;
}

function checkRow(c) {
  const on = isChecked(c.id);
  return `
    <button class="ck ${on ? 'on' : ''}" data-check="${esc(c.id)}" aria-pressed="${on}">
      <span class="ck-box">✓</span><span class="ck-text grow">${esc(c.text)}</span>
    </button>`;
}

function renderCheck() {
  const { checklist } = state.trip;
  const done = checklist.filter((c) => isChecked(c.id)).length;
  setHeader('체크리스트', `${done} / ${checklist.length} 완료`);
  const groups = [...new Set(checklist.map((c) => c.group))];
  return groups.map((g) => `
    <div class="section-title">${esc(g)}</div>
    <div class="card">${checklist.filter((c) => c.group === g).map(checkRow).join('')}</div>
  `).join('');
}

// ---------- sheet & big japanese ----------
function openItem(id) {
  const it = findItem(id);
  if (!it) return;
  const now = tokyoNow();
  const links = it.place ? mapLinks(it.place) : null;
  const done = isDone(it.id);
  $('#sheet-body').innerHTML = `
    <div class="muted small">${esc(dayLabel(it.date))} · ${esc(it.start)}${it.end ? '~' + esc(it.end) : ''}</div>
    <h3>${esc(it.icon || '')} ${esc(it.title)}</h3>
    ${it.place ? `<div class="ja muted">${esc(it.place.nameJa)}</div>` : ''}
    ${chipsHtml(chipsFor(it, now))}
    ${it.note ? `<div class="card" style="margin-top:12px">${esc(it.note)}</div>` : ''}
    ${it.rainPlan ? `<div class="card"><b>☔ 비 올 때</b><div class="small" style="margin-top:4px">${esc(it.rainPlan)}</div></div>` : ''}
    <div class="btns">
      ${links ? `
        <a class="btn primary" href="${links.google}" target="_blank" rel="noopener">🧭 구글맵</a>
        <a class="btn" href="${links.apple}" target="_blank" rel="noopener">🗺 애플맵</a>
        <button class="btn wide" data-ja="${esc(it.id)}">🇯🇵 일본어 크게 보기</button>` : ''}
      <button class="btn wide" data-done="${esc(it.id)}">${done ? '↩︎ 완료 취소' : '✓ 완료 표시'}</button>
    </div>`;
  $('#sheet').hidden = false;
}
const closeSheet = () => { $('#sheet').hidden = true; };

function openJa(id) {
  const place = id === '__stay'
    ? { nameJa: state.trip.stay.nameJa }
    : findItem(id)?.place;
  if (!place) return;
  $('#bigja-body').innerHTML = `
    <div class="ja ja-name">${esc(place.nameJa)}</div>
    ${place.query && place.query !== place.nameJa ? `<div class="ja ja-addr">${esc(place.query)}</div>` : ''}
    <div class="ja ja-ask">ここへ行きたいです。<br><span style="font-size:15px">(여기에 가고 싶어요)</span></div>`;
  $('#bigja').hidden = false;
}

// ---------- shell ----------
function setHeader(title, sub) {
  $('#top-title').textContent = title;
  $('#top-sub').textContent = sub || '';
}

function render() {
  const views = { today: renderToday, days: renderDays, info: renderInfo, check: renderCheck };
  $('#view').innerHTML = views[state.tab]();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
}

function go(tab) {
  state.tab = tab;
  store.set('tab', tab);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tab],[data-go],[data-day],[data-item],[data-ja],[data-check],[data-done],[data-close],[data-close-ja]');
  if (!el) return;
  const d = el.dataset;
  if (d.tab) go(d.tab);
  else if (d.go) go(d.go);
  else if (d.day) { state.dayIndex = Number(d.day); store.set('day', state.dayIndex); render(); }
  else if (d.ja) openJa(d.ja);
  else if (d.item) openItem(d.item);
  else if (d.check) { setChecked(d.check, !isChecked(d.check)); render(); }
  else if (d.done) { setDone(d.done, !isDone(d.done)); closeSheet(); render(); }
  else if ('close' in d) closeSheet();
  else if ('closeJa' in d) $('#bigja').hidden = true;
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'pnr') store.set('pnr', e.target.value.trim().toUpperCase());
});

// Re-render every minute so "now / next" stays current while the app is open.
setInterval(() => { if (state.tab === 'today' && $('#sheet').hidden) render(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

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
  state.tab = store.get('tab', 'today');
  if (todayIdx >= 0) state.tab = 'today';
  render();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
