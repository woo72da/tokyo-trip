'use strict';

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TABS = ['today', 'days', 'wallet', 'talk', 'check'];

const state = { trip: null, tab: 'today', dayIndex: 0, talkDir: 'ko-ja', pendingDoc: null };

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

// Booking numbers typed on this phone only (the repo is public, so they never go in trip.json).
const SECRETS = [
  { key: 'pnr', label: '항공 예약번호 (PNR)', placeholder: '예: AB12CD' },
  { key: 'agoda', label: '아고다 예약번호', placeholder: '숫자 9~10자리' },
  { key: 'agodaPin', label: '아고다 PIN / 호텔 확인번호', placeholder: '바우처에 적힌 번호' },
];

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
  del: (id) => docs.run('readwrite', (s) => s.delete(id)),
  keys: () => docs.run('readonly', (s) => s.getAllKeys()),
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
function chipsFor(it, now) {
  const chips = [];
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
  if (it.rainPlan) chips.push(['', '☔ 대안']);
  return chips;
}
const chipsHtml = (chips) => chips.length
  ? `<div class="chips">${chips.map(([cls, t]) => `<span class="chip ${cls}">${esc(t)}</span>`).join('')}</div>`
  : '';

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
  openApp(
    `comgooglemaps://?daddr=${e}&directionsmode=transit`,
    `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=transit`,
    '구글맵',
  );
}
const navBtn = (key, label = '길찾기', cls = 'primary') =>
  `<button class="btn ${cls}" data-nav="${esc(key)}">${icon('nav')}${esc(label)}</button>`;

const LANG = { 'ko-ja': ['ko', 'ja'], 'ja-ko': ['ja', 'ko'] };
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
    window.open(`https://papago.naver.com/?sk=${sl}&tk=${tl}&st=${t}`, '_blank', 'noopener');
  }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return toast('이 기기에서는 음성을 지원하지 않아요.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 0.9;
  speechSynthesis.speak(u);
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
const ICONS = {
  nav: '<path d="M12 2.8l7 18-7-4-7 4z"/>',
  ja: '<path d="M4 5h9M8.5 3v2M6 5c.6 3.5 3 6 6 7.5M11 5c-.7 3.4-3 6.3-6.5 8"/><path d="M12.5 21l4-9.5 4 9.5M14 17.5h5"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  home: '<path d="M4 11l8-6.5 8 6.5V20H4z"/><path d="M10 20v-5h4v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- views ----------
function renderToday() {
  const now = tokyoNow();
  const { trip, days, flights } = state.trip;
  const dayIdx = days.findIndex((d) => d.date === now.date);

  if (now.date < trip.start) {
    const left = daysBetween(now.date, trip.start);
    const list = checklist();
    const todo = list.filter((c) => !isChecked(c.id));
    const urgent = todo.filter((c) => c.group === '예약');
    const f = flights[0];
    setHeader('TOKYO · 2026', trip.title, `${dayLabel(trip.start)} 출발 · ${trip.travelers}명`);
    return `
      <div class="hero countdown">
        <div class="hero-sun"></div>
        <div class="eyebrow">DEPARTURE IN</div>
        <div class="big">D-${left}</div>
        <div class="route"><b>${esc(f.from)}</b><i></i><b>${esc(f.to)}</b></div>
        <div class="hero-meta">${esc(f.airline)} ${esc(f.no)} · ${esc(dayLabel(f.date))} ${esc(f.depart)} · 인천 T${esc(f.fromTerminal)}</div>
        <div class="meter"><i style="width:${Math.round(((list.length - todo.length) / list.length) * 100)}%"></i></div>
        <div class="hero-meta">준비 ${list.length - todo.length} / ${list.length}</div>
      </div>
      ${urgent.length ? `
        <div class="section-title"><span>지금 예약해야 할 것</span><em>${urgent.length}</em></div>
        <div class="card list">${urgent.map(checkRow).join('')}</div>` : ''}
      <div class="quick">
        <button data-go="check"><b>${todo.length}</b><span>남은 준비</span></button>
        <button data-go="wallet"><b>${icon('ext')}</b><span>예약 확인</span></button>
        <button data-go="talk"><b>あ</b><span>번역</span></button>
      </div>
      <div class="section-title"><span>첫날 · ${esc(dayLabel(days[0].date))}</span></div>
      ${timeline(dayItems(days[0]).slice(0, 4), null)}
    `;
  }
  if (dayIdx === -1) {
    setHeader('TOKYO · 2026', trip.title, '여행이 끝났어요');
    return `<div class="empty">おつかれさまでした 🙇<br>즐거운 여행이었기를!</div>`;
  }

  const day = days[dayIdx];
  const items = dayItems(day);
  const active = items.filter((it) => it.startMin <= now.min && now.min < it.endMin && !isDone(it.id));
  const current = active[active.length - 1];
  const upcoming = items.filter((it) => it.startMin > now.min);
  const next = upcoming[0];
  setHeader(`DAY ${dayIdx + 1} · ${dayLabel(day.date)}`, day.title, `일몰 ${day.sunset} · ${items.length}개 일정`);

  let html = '';
  if (current) html += heroCard(current, 'now', now);
  if (next) html += heroCard(next, 'next', now);
  if (!current && !next) html += `<div class="card empty">오늘 일정이 모두 끝났어요. 푹 쉬세요 🛌</div>`;
  html += `
    <div class="quick">
      <button data-nav="__stay"><b>${icon('home')}</b><span>호텔로</span></button>
      <button data-go="talk"><b>あ</b><span>번역</span></button>
      <button data-go="wallet"><b>${icon('ext')}</b><span>예약</span></button>
    </div>`;

  const later = upcoming.slice(1);
  if (later.length) html += `<div class="section-title"><span>이후 일정</span><em>${later.length}</em></div>${timeline(later, now)}`;
  return html;
}

function heroCard(it, kind, now) {
  const progress = kind === 'now'
    ? Math.max(0, Math.min(100, ((now.min - it.startMin) / (it.endMin - it.startMin)) * 100))
    : 0;
  const label = kind === 'now' ? `NOW · ${it.endMin - now.min}분 남음` : `NEXT · ${formatLeft(it.startMin - now.min)} 후`;
  return `
    <div class="hero ${kind}">
      <div class="hero-sun"></div>
      <div class="eyebrow"><i class="pulse"></i>${esc(label)}</div>
      <div class="hero-time">${esc(it.start)}${it.end ? ' — ' + esc(it.end) : ''}</div>
      <div class="hero-title">${esc(it.icon || '')} ${esc(it.title)}</div>
      ${it.place ? `<div class="hero-ja ja">${esc(it.place.nameJa)}</div>` : ''}
      ${it.note ? `<div class="hero-note">${esc(it.note)}</div>` : ''}
      ${chipsHtml(chipsFor(it, now))}
      ${kind === 'now' ? `<div class="meter"><i style="width:${progress}%"></i></div>` : ''}
      <div class="btns">
        ${it.place ? `${navBtn(it.id, '구글맵 길찾기')}<button class="btn ghost" data-ja="${esc(it.id)}">${icon('ja')}일본어</button>` : ''}
        <button class="btn ghost wide" data-item="${esc(it.id)}">자세히</button>
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
      it.priority || '',
    ].join(' ');
    const warn = chipsFor(it, now).filter(([c]) => c === 'warn');
    return `
      <div class="tl-item ${cls}">
        <div class="tl-time">${esc(it.start)}</div>
        <div class="tl-card" data-item="${esc(it.id)}" role="button" tabindex="0">
          <div class="tl-main">
            <div class="tl-title">${esc(it.icon || '')} ${esc(it.title)}</div>
            ${it.note ? `<div class="tl-sub">${esc(it.note)}</div>` : ''}
            ${chipsHtml(warn)}
          </div>
          ${it.place ? `<button class="tl-nav" data-nav="${esc(it.id)}" aria-label="구글맵 길찾기">${icon('nav')}</button>` : ''}
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderDays() {
  const now = tokyoNow();
  const { days, stay } = state.trip;
  const day = days[state.dayIndex];
  setHeader(`DAY ${state.dayIndex + 1} / ${days.length}`, day.title, `${dayLabel(day.date)} · 일몰 ${day.sunset} · ${stay.name}`);
  return `
    <div class="daypick" role="group" aria-label="날짜 선택">
      ${days.map((d, i) => `
        <button class="dp ${d.date === now.date ? 'today' : ''}" data-day="${i}" aria-pressed="${i === state.dayIndex}">
          <small>DAY</small><b>${i + 1}</b><span>${esc(shortDate(d.date))} ${WEEKDAYS[dowOf(d.date)]}</span>
        </button>`).join('')}
    </div>
    ${timeline(dayItems(day), now)}
  `;
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

function renderWallet() {
  const { flights, stay, guides, trip, links, docs: slots } = state.trip;
  const agoda = store.get('agoda', '');
  const pin = store.get('agodaPin', '');
  setHeader('WALLET', '예약 · 문서', `${dayLabel(trip.start)} ~ ${dayLabel(trip.end)} · ${trip.travelers}명`);
  return `
    <div class="section-title"><span>항공</span></div>
    ${flights.map(boardingPass).join('')}
    <div class="btns solo">
      <a class="btn" href="${esc(links.jejuair.url)}" target="_blank" rel="noopener">${icon('ext')}${esc(links.jejuair.label)}</a>
      <button class="btn" data-doc-view="doc-eticket">✈️ e-티켓 사진</button>
    </div>

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
        <div><small>CHECK-IN</small><b>${esc(dayLabel(trip.start))} ${esc(stay.checkIn)}</b></div>
        <div><small>CHECK-OUT</small><b>${esc(dayLabel(trip.end))} ${esc(stay.checkOut)}</b></div>
        <div><small>AGODA</small><b class="mono">${esc(agoda || '—')}</b></div>
        <div><small>PIN</small><b class="mono">${esc(pin || '—')}</b></div>
      </div>
      <div class="addr">
        <div class="ja">${esc(stay.address)}</div>
        <div class="muted small">${esc(stay.addressKo)}</div>
      </div>
      <div class="small muted">조식 ${esc(stay.breakfast)}</div>
      <div class="btns">
        ${navBtn('__stay', '호텔 길찾기')}
        <button class="btn" data-ja="__stay">${icon('ja')}택시 기사용</button>
        <a class="btn" href="tel:${esc(stay.phone)}">${icon('phone')}호텔 전화</a>
        <a class="btn" href="${esc(links.agoda.url)}" target="_blank" rel="noopener">${icon('ext')}아고다 예약</a>
        <button class="btn wide" data-doc-view="doc-agoda">🏨 바우처 사진</button>
      </div>
      <details class="more"><summary>가까운 역</summary>
        <ul class="plain">${stay.stations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      </details>
    </div>

    <div class="section-title"><span>예약번호</span><em class="muted">이 폰에만 저장</em></div>
    <div class="card">
      ${SECRETS.map((s) => `
        <label class="field">
          <span>${esc(s.label)}</span>
          <div class="field-row">
            <input class="input mono" data-secret="${s.key}" autocomplete="off" autocapitalize="characters" spellcheck="false"
              value="${esc(store.get(s.key, ''))}" placeholder="${esc(s.placeholder)}">
            <button class="icon-btn" data-copy="${s.key}" aria-label="복사">${icon('copy')}</button>
          </div>
        </label>`).join('')}
    </div>

    <div class="section-title"><span>문서 사진</span><em class="muted">캡처해 두면 오프라인에서도 열려요</em></div>
    <div class="docs">
      ${slots.map((s) => `
        <div class="doc" data-doc="${esc(s.id)}">
          <button class="doc-thumb" data-doc-view="${esc(s.id)}"><span>${esc(s.icon)}</span></button>
          <div class="doc-label">${esc(s.label)}</div>
          <div class="doc-actions">
            <button data-doc-add="${esc(s.id)}">추가</button>
            <button data-doc-del="${esc(s.id)}" hidden>삭제</button>
          </div>
        </div>`).join('')}
    </div>

    ${guides.map((g) => `
      <div class="section-title"><span>${esc(g.icon)} ${esc(g.title)}</span></div>
      <div class="card"><ul class="plain">${g.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('')}
  `;
}

function renderTalk() {
  const { phrases } = state.trip;
  const [from, to] = state.talkDir === 'ko-ja' ? ['한국어', '日本語'] : ['日本語', '한국어'];
  setHeader('TRANSLATE', '번역 · 회화', 'Google 번역 · 파파고 바로 연결');
  const groups = [...new Set(phrases.map((p) => p.group))];
  return `
    <div class="talk">
      <div class="talk-dir">
        <b>${from}</b>
        <button class="icon-btn" data-swap aria-label="방향 바꾸기">${icon('swap')}</button>
        <b>${to}</b>
      </div>
      <textarea id="talk-text" class="talk-input" rows="3" placeholder="${state.talkDir === 'ko-ja' ? '번역할 말을 입력하세요' : '日本語を入力'}">${esc(store.get('talkText', ''))}</textarea>
      <div class="btns">
        <button class="btn primary" data-translate="google">Google 번역 앱</button>
        <button class="btn papago" data-translate="papago">파파고</button>
      </div>
      <div class="small muted talk-hint">실시간 음성·카메라 통역은 열린 앱에서 마이크·카메라 버튼을 누르면 됩니다.</div>
    </div>

    <div class="section-title"><span>바로 쓰는 일본어</span><em class="muted">탭하면 크게 · 🔊 발음</em></div>
    ${groups.map((g) => `
      <div class="phrase-group">${esc(g)}</div>
      <div class="card list">${phrases.map((p, i) => (p.group !== g ? '' : `
        <div class="phrase">
          <button class="phrase-main" data-phrase="${i}">
            <span class="phrase-ko">${esc(p.ko)}</span>
            <span class="phrase-ja ja">${esc(p.ja)}</span>
            <span class="phrase-read">${esc(p.read)}</span>
          </button>
          <button class="icon-btn" data-speak="${i}" aria-label="발음 듣기">${icon('sound')}</button>
        </div>`)).join('')}</div>`).join('')}
  `;
}

function checkRow(c) {
  const on = isChecked(c.id);
  return `
    <div class="ck ${on ? 'on' : ''}">
      <button class="ck-hit" data-check="${esc(c.id)}" aria-pressed="${on}">
        <span class="ck-box"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>
        <span class="ck-text">${esc(c.text)}</span>
      </button>
      ${c.custom ? `<button class="ck-del" data-del="${esc(c.id)}" aria-label="삭제">✕</button>` : ''}
    </div>`;
}

function renderCheck() {
  const list = checklist();
  const done = list.filter((c) => isChecked(c.id)).length;
  setHeader('CHECKLIST', '준비물 · 예약', `${done} / ${list.length} 완료`);
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

// ---------- docs ----------
const thumbUrls = [];
async function hydrateDocs() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  let keys = [];
  try { keys = await docs.keys(); } catch { return; }
  for (const id of keys) {
    const el = document.querySelector(`[data-doc="${CSS.escape(id)}"]`);
    if (!el) continue;
    const blob = await docs.get(id);
    const url = URL.createObjectURL(blob);
    thumbUrls.push(url);
    el.classList.add('has');
    el.querySelector('.doc-thumb').style.backgroundImage = `url("${url}")`;
    el.querySelector('[data-doc-add]').textContent = '교체';
    el.querySelector('[data-doc-del]').hidden = false;
  }
}

async function viewDoc(id) {
  const slot = state.trip.docs.find((s) => s.id === id);
  let blob;
  try { blob = await docs.get(id); } catch { /* ignore */ }
  if (!blob) {
    toast(`${slot?.label || '문서'} 사진이 아직 없어요.`);
    if (state.tab === 'wallet') document.querySelector(`[data-doc="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const img = $('#viewer-img');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  $('#viewer-cap').textContent = `${slot?.label || ''} · QR은 화면 밝기를 올려 보여주세요`;
  $('#viewer').hidden = false;
}

// ---------- sheet & big japanese ----------
function openItem(id) {
  const it = findItem(id);
  if (!it) return;
  const now = tokyoNow();
  const done = isDone(it.id);
  $('#sheet-body').innerHTML = `
    <div class="eyebrow dark">${esc(dayLabel(it.date))} · ${esc(it.start)}${it.end ? ' — ' + esc(it.end) : ''}</div>
    <h3>${esc(it.icon || '')} ${esc(it.title)}</h3>
    ${it.place ? `<div class="ja muted">${esc(it.place.nameJa)}</div>` : ''}
    ${chipsHtml(chipsFor(it, now))}
    ${it.note ? `<div class="card note">${esc(it.note)}</div>` : ''}
    ${it.rainPlan ? `<div class="card note"><b>☔ 비 올 때</b><div class="small">${esc(it.rainPlan)}</div></div>` : ''}
    <div class="btns">
      ${it.place ? `${navBtn(it.id, '구글맵 길찾기', 'primary wide')}
        <button class="btn" data-ja="${esc(it.id)}">${icon('ja')}일본어 크게</button>
        <button class="btn" data-talk-text="${esc(it.place.nameJa)}">번역기로</button>` : ''}
      <button class="btn wide" data-done="${esc(it.id)}">${done ? '↩︎ 완료 취소' : '✓ 완료 표시'}</button>
    </div>`;
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
  $('#top-title').textContent = title;
  $('#top-sub').textContent = sub || '';
}

function render() {
  if (!state.trip) return;
  const views = { today: renderToday, days: renderDays, wallet: renderWallet, talk: renderTalk, check: renderCheck };
  $('#view').innerHTML = views[state.tab]();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  if (state.tab === 'wallet') hydrateDocs();
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

const ACTIONS = '[data-tab],[data-go],[data-day],[data-nav],[data-ja],[data-item],[data-check],[data-del],[data-done],'
  + '[data-close],[data-close-ja],[data-close-viewer],[data-copy],[data-doc-view],[data-doc-add],[data-doc-del],'
  + '[data-translate],[data-swap],[data-phrase],[data-speak],[data-speak-text],[data-talk-text]';

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
  else if (d.check) { setChecked(d.check, !isChecked(d.check)); render(); }
  else if (d.del) { store.set('custom', store.get('custom', []).filter((c) => c.id !== d.del)); render(); }
  else if (d.done) { setDone(d.done, !isDone(d.done)); closeSheet(); render(); }
  else if ('close' in d) closeSheet();
  else if ('closeJa' in d) { $('#bigja').hidden = true; window.speechSynthesis?.cancel(); }
  else if ('closeViewer' in d) $('#viewer').hidden = true;
  else if (d.copy) copy(d.copy);
  else if (d.docView) viewDoc(d.docView);
  else if (d.docAdd) { state.pendingDoc = d.docAdd; $('#doc-file').click(); }
  else if (d.docDel) {
    if (!confirm('이 사진을 삭제할까요?')) return;
    try { await docs.del(d.docDel); } catch { /* ignore */ }
    render();
  }
  else if (d.translate) {
    const text = $('#talk-text').value.trim();
    if (!text) return toast('번역할 말을 입력해 주세요.');
    translate(d.translate, text);
  }
  else if ('swap' in d) { state.talkDir = state.talkDir === 'ko-ja' ? 'ja-ko' : 'ko-ja'; render(); }
  else if (d.phrase) { const p = state.trip.phrases[d.phrase]; showJa({ ja: p.ja, read: p.read, ko: p.ko }); }
  else if (d.speak) speak(state.trip.phrases[d.speak].ja);
  else if (d.speakText) speak(d.speakText);
  else if (d.talkText) { store.set('talkText', d.talkText); state.talkDir = 'ja-ko'; go('talk'); }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.secret) store.set(t.dataset.secret, t.value.trim().toUpperCase());
  else if (t.id === 'talk-text') store.set('talkText', t.value);
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'add-form') return;
  e.preventDefault();
  const text = $('#add-text').value.trim();
  if (!text) return;
  store.set('custom', [...store.get('custom', []), { id: 'u-' + Date.now(), text }]);
  render();
  $('#add-text')?.focus();
});

$('#doc-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.pendingDoc) return;
  try {
    await docs.put(state.pendingDoc, await shrink(file));
    toast('저장했어요 · 이 폰에서만 보여요');
  } catch { toast('사진을 저장하지 못했어요'); }
  render();
});

// Re-render every minute so "now / next" stays current while the app is open.
setInterval(() => { if (state.tab === 'today' && $('#sheet').hidden) render(); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !['wallet', 'talk', 'check'].includes(state.tab)) render();
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
  render();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
