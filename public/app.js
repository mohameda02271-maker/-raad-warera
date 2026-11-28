'use strict';
/* رعد RAAD — client. Full-bleed world map, sheets over it, live feed. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let token = localStorage.getItem('raad_token') || '';
const CLIENT_VERSION = '1.6.0';
let S = null, MAP = null;
let selCountry = null;
let battle = { warId: null, ammo: 'none' };
let curTab = 'map';
let govMode = 'country'; // country | list
let govCid = null;       // viewed country (null = own)
let govTab = 'home';     // home|eco|pop|mil|gov|dip
let govSearch = '', govSort = 'pop';
let mapMode = 'pol'; // pol | ally | war | dev
let ranksOpen = false, misTab = 'daily', mktTab = 'inv';
let prevOwners = {};

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    body: body ? JSON.stringify(body) : '{}'
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'خطأ');
  if (Array.isArray(d.missions) && typeof d.missions[0] === 'string') d.missions.forEach(n => flash('مهمة اكتملت: ' + n + '!', 'good'));
  return d;
}
const apiGet = async p => (await fetch(p)).json();
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(n);
const pct = (c, m) => Math.max(0, Math.min(100, c / m * 100));

function show(id) { ['auth', 'pick', 'game'].forEach(x => $('#' + x).classList.toggle('hidden', x !== id)); }
function flash(txt, cls) {
  const d = document.createElement('div');
  d.className = 'flash ' + cls; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1000);
}
function floatDmg(txt, cls, near) {
  const r = near ? near.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0 };
  const d = document.createElement('div');
  d.className = 'dmgfloat ' + cls; d.textContent = txt;
  d.style.left = (r.left + r.width / 2 - 20 + (Math.random() * 40 - 20)) + 'px';
  d.style.top = (r.top - 8) + 'px';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1100);
}

/* ---------- auth ---------- */
$('#btn-register').onclick = () => auth('register');
$('#btn-login').onclick = () => auth('login');
async function auth(kind) {
  $('#auth-err').textContent = '';
  try {
    const d = await api('/api/' + kind, { name: $('#auth-name').value.trim(), pass: $('#auth-pass').value, secret: $('#auth-secret').value.trim() });
    token = d.token; localStorage.setItem('raad_token', token);
    await boot();
  } catch (e) { $('#auth-err').textContent = e.message; }
}

/* ---------- world map ---------- */
function mapSVG() {
  let h = `<svg viewBox="0 0 1000 520" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">`;
  for (const [name, path] of Object.entries(MAP.paths)) h += `<path d="${path}" data-c="${esc(name)}"></path>`;
  return h + '</svg>';
}
function makePannable(stage, onTap) {
  const st = { x: 0, y: 0, k: 1 };
  const svg = () => stage.querySelector('svg');
  let lastK = 1;
  const apply = () => {
    const s = svg(); if (s) s.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.k})`;
    window.__mapZoom = st.k;
    if (Math.abs(st.k - lastK) > 0.2) { lastK = st.k; if (window.__overlayRebuild) window.__overlayRebuild(); }
  };
  const pts = new Map();
  let pinch = null, moved = 0, downAt = 0;
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: st.k };
    }
    moved = 0; downAt = Date.now();
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) {
      st.x += e.clientX - prev[0]; st.y += e.clientY - prev[1];
      moved += Math.abs(e.clientX - prev[0]) + Math.abs(e.clientY - prev[1]);
      apply();
    } else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const r = stage.getBoundingClientRect();
      const mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
      const nk = Math.min(6, Math.max(1, pinch.k * d / pinch.d));
      st.x = mx - (mx - st.x) * (nk / st.k);
      st.y = my - (my - st.y) * (nk / st.k);
      st.k = nk; moved += 6;
      apply();
    }
  });
  const up = e => {
    const wasTap = pts.size === 1 && moved < 9 && Date.now() - downAt < 700;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (wasTap && onTap) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const p = el && el.closest ? el.closest('path') : null;
      if (p && p.dataset.c) onTap(p.dataset.c);
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const nk = Math.min(6, Math.max(1, st.k * (e.deltaY < 0 ? 1.15 : 0.87)));
    st.x = mx - (mx - st.x) * (nk / st.k);
    st.y = my - (my - st.y) * (nk / st.k);
    st.k = nk; apply();
  }, { passive: false });
}

/* colors: own=violet, at-war=red pulsing, has citizens=cyan-dark, selected=cyan outline; alliance=colored stroke */
const ALLY_COLORS = ['#f59e0b', '#22d3ee', '#a3e635', '#f472b6', '#fb7185', '#818cf8'];
function countryFill(cid) {
  const y = S.you, pub = S.countries[cid];
  if (mapMode === 'ally') {
    const i2 = (S.alliances || []).findIndex(a => a.members.includes(cid));
    return i2 >= 0 ? ALLY_COLORS[i2 % ALLY_COLORS.length] : '#211d3f';
  }
  if (mapMode === 'war') {
    return (pub && pub.wars && pub.wars.length) ? '' : '#141126'; // war countries keep their pulse class
  }
  if (mapMode === 'dev') {
    const d = pub && pub.stats ? pub.stats.dev : 0;
    const t = Math.min(1, d / 50);
    return `rgba(77,255,136,${(0.07 + t * 0.55).toFixed(2)})`;
  }
  return ''; // political: classes drive it
}
function updateMapColors(stageEl) {
  if (!S || !MAP) return;
  const alMap = {};
  (S.alliances || []).forEach((a, i) => a.members.forEach(m => { alMap[m] = i; }));
  stageEl.querySelectorAll('path[data-c]').forEach(p => {
    const c = p.dataset.c;
    const pub = S.countries[c];
    let cl = '';
    if (mapMode === 'pol' || mapMode === 'war') {
      if (mapMode === 'pol') {
        if (S.you && S.you.country === c) cl = 'own';
        else if (pub && pub.wars && pub.wars.length) cl = 'war';
        else if (pub && pub.citizens && pub.citizens.length) cl = 'cit';
      } else if (pub && pub.wars && pub.wars.length) cl = 'war';
      if (selCountry === c) cl += ' sel';
      if (p.style.fill) p.style.fill = '';
    } else {
      const f = countryFill(c);
      if (p.style.fill !== f) p.style.fill = f;
      if (selCountry === c) cl = 'sel';
    }
    if (p.className.baseVal !== cl) p.className.baseVal = cl;
    const ai = mapMode === 'ally' ? undefined : alMap[c];
    const stroke = ai !== undefined ? ALLY_COLORS[ai % ALLY_COLORS.length] : '';
    if (p.style.stroke !== stroke) { p.style.stroke = stroke; p.style.strokeWidth = stroke ? '1.6' : ''; }
  });
  buildRegionOverlay(stageEl);
  buildWarPins(stageEl);
}

/* region-level overlay: the selected country splits into its real regions, colored by owner */
const SVGNS = 'http://www.w3.org/2000/svg';
function buildRegionOverlay(stageEl) {
  window.__overlayRebuild = () => buildRegionOverlay(stageEl);
  const svg = stageEl.querySelector('svg');
  if (!svg) return;
  let old = svg.querySelector('g.regions-overlay');
  if (old) old.remove();
  if (!selCountry || !S.countries[selCountry]) return;
  const pathEl = svg.querySelector(`path[data-c="${CSS.escape(selCountry)}"]`);
  if (!pathEl) return;
  const bb = pathEl.getBBox();
  const pub = S.countries[selCountry];
  const regs = pub.regions || [];
  if (!regs.length) return;
  let defs = svg.querySelector('defs.mapdefs');
  if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); defs.setAttribute('class', 'mapdefs'); svg.prepend(defs); }
  const clipId = 'clip-' + selCountry.replace(/\W/g, '_');
  let clip = defs.querySelector('#' + clipId);
  if (clip) clip.remove();
  clip = document.createElementNS(SVGNS, 'clipPath');
  clip.setAttribute('id', clipId);
  const cp = document.createElementNS(SVGNS, 'path');
  cp.setAttribute('d', pathEl.getAttribute('d'));
  clip.appendChild(cp);
  defs.appendChild(clip);
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'regions-overlay');
  g.setAttribute('clip-path', `url(#${clipId})`);
  const n = regs.length;
  const horiz = bb.width >= bb.height;
  regs.forEach((r, i2) => {
    const rx = horiz ? bb.x : bb.x + i2 * bb.width / n;
    const ry = horiz ? bb.y + i2 * bb.height / n : bb.y;
    const rw = horiz ? bb.width : bb.width / n;
    const rh = horiz ? bb.height / n : bb.height;
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', rx); rect.setAttribute('y', ry);
    rect.setAttribute('width', rw); rect.setAttribute('height', rh);
    const owned = r.owner !== selCountry;
    rect.setAttribute('class', 'regmap-rect' + (owned ? ' occupied' : ''));
    if (owned) rect.style.fill = occupierFill(r.owner);
    g.appendChild(rect);
    const cx = rx + rw / 2, cy = ry + rh / 2;
    const k = window.__mapZoom || 1;
    const fs = Math.min(9, 12 / k); // ~12px on screen at any zoom
    const fits = (r.name.length + (owned ? 2 : 0)) * fs * 0.62 < rw && rh * k >= 13;
    if (fits) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', cx); t.setAttribute('y', cy + fs * 0.35);
      t.setAttribute('class', 'regmap-label');
      t.setAttribute('font-size', fs.toFixed(1));
      t.setAttribute('stroke-width', (fs * 0.22).toFixed(1));
      t.textContent = r.name + (owned ? ' ⚑' : '');
      g.appendChild(t);
    }
    const war = S.wars.find(w => w.regionId === r.id);
    if (war) {
      const pin = document.createElementNS(SVGNS, 'text');
      pin.setAttribute('x', cx); pin.setAttribute('y', cy - (rh > 20 ? 8 : 0));
      pin.setAttribute('class', 'wpin');
      pin.setAttribute('font-size', (14 / (window.__mapZoom || 1)).toFixed(1));
      pin.textContent = '⚔';
      g.appendChild(pin);
    }
  });
  const outline = document.createElementNS(SVGNS, 'path');
  outline.setAttribute('d', pathEl.getAttribute('d'));
  outline.setAttribute('class', 'regmap-outline' + (selCountry === S.you.country ? ' mine' : ''));
  svg.appendChild(outline);
  svg.appendChild(g);
}
function occupierFill(cid) {
  // occupied region takes a hostile tint of the occupier's alliance/political color
  if (mapMode === 'ally') {
    const i2 = (S.alliances || []).findIndex(a => a.members.includes(cid));
    return i2 >= 0 ? ALLY_COLORS[i2 % ALLY_COLORS.length] : '#6b2233';
  }
  return S.you && S.you.country === cid ? '#7c4dff' : '#a02040';
}
function buildWarPins(stageEl) {
  const svg = stageEl.querySelector('svg');
  if (!svg) return;
  let old = svg.querySelector('g.war-pins');
  if (old) old.remove();
  if (mapMode !== 'war' || !S.wars.length) return;
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'war-pins');
  const seen = {};
  for (const w of S.wars) {
    if (seen[w.to]) continue; seen[w.to] = 1;
    const pathEl = svg.querySelector(`path[data-c="${CSS.escape(w.to)}"]`);
    if (!pathEl) continue;
    const bb = pathEl.getBBox();
    const pin = document.createElementNS(SVGNS, 'text');
    pin.setAttribute('x', bb.x + bb.width / 2); pin.setAttribute('y', bb.y + bb.height / 2);
    pin.setAttribute('class', 'wpin big');
    pin.textContent = '⚔';
    g.appendChild(pin);
  }
  svg.appendChild(g);
}

function detectFlips() {
  if (!S) return;
  const now = {};
  for (const c of Object.values(S.countries)) for (const r of (c.regions || [])) now[r.id] = r.owner;
  for (const [rid, owner] of Object.entries(now)) {
    if (prevOwners[rid] && prevOwners[rid] !== owner) {
      const cid = rid.split(':')[0];
      const p = document.querySelector('#stage path[data-c="' + (window.CSS ? CSS.escape(cid) : cid) + '"]');
      if (p) { p.classList.add('flip'); setTimeout(() => p.classList.remove('flip'), 2300); }
    }
  }
  prevOwners = now;
}

/* ---------- boot ---------- */
async function boot() {
  if (!MAP) MAP = await apiGet('/api/mapdata');
  try { S = await api('/api/state'); } catch { token = ''; localStorage.removeItem('raad_token'); show('auth'); return; }
  stampVersion(S.version);
  if (!S.you.country) { buildPick(); show('pick'); return; }
  if (!$('#stage svg')) {
    $('#stage').innerHTML = mapSVG() + `<div id="mapmodes">
      <button data-mmode="pol" type="button">🗺 سياسي</button>
      <button data-mmode="ally" type="button">🤝 تحالفات</button>
      <button data-mmode="war" type="button">⚔ حروب</button>
      <button data-mmode="dev" type="button">🏗 تنمية</button>
    </div>`;
    makePannable($('#stage'), c => { selCountry = selCountry === c ? null : c; render(true); });
    $('#stage').querySelectorAll('[data-mmode]').forEach(b => b.onclick = () => {
      mapMode = b.dataset.mmode; updateMapColors($('#stage'));
      $('#stage').querySelectorAll('[data-mmode]').forEach(x => x.classList.toggle('on', x === b));
    });
    $('#stage').querySelectorAll('[data-mmode]').forEach(x => x.classList.toggle('on', x.dataset.mmode === mapMode));
  }
  $('#btn-tab-admin').classList.toggle('hidden', !S.you.admin);
  show('game');
  render(true);
}

/* ---------- pick screen ---------- */
function buildPick() {
  selCountry = null;
  $('#pick-stage').innerHTML = mapSVG();
  updateMapColors($('#pick-stage'));
  makePannable($('#pick-stage'), async c => {
    if (selCountry === c) {
      try { await api('/api/country', { country: c }); boot(); } catch (err) { flash(err.message, 'miss'); }
      return;
    }
    selCountry = c;
    updateMapColors($('#pick-stage'));
    $('#pick-name').textContent = (MAP.defs[c] ? MAP.defs[c].name : c) + ' — اضغط تاني للتأكيد';
  });
}

/* ---------- dock ---------- */
$('#dock').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  curTab = b.dataset.tab;
  if (curTab === 'map') selCountry = null;
  render(true);
};
$('#sheet-grip').onclick = () => { curTab = 'map'; selCountry = null; render(true); };

/* ---------- render discipline: never clobber typing ---------- */
let lastTabKey = null, pendingTabRender = false;
function tabDataKey() {
  const y = S.you;
  switch (curTab) {
    case 'home': return JSON.stringify([y.money, y.skillPoints, y.skills, y.weapon, y.armorGear, y.ammo, y.foods, y.companiesOwned, y.goods, y.factories, S.missions]);
    case 'war': return JSON.stringify([S.wars, y.ammo, y.goods, battle, battleView]);
    case 'gov': { const c = S.countries[y.country] || {}; return JSON.stringify([c.president, c.election, c.treasury, S.alliances]); }
    case 'market': return JSON.stringify([S.market, y.inv, y.money, mktTab]);
    case 'map': return JSON.stringify([S.countries, S.wars, selCountry]);
    case 'admin': return JSON.stringify([S.speed]);
    default: return '';
  }
}
const isTyping = () => {
  const a = document.activeElement;
  return a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
};
document.addEventListener('focusout', () => {
  if (!pendingTabRender) return;
  setTimeout(() => {
    if (!pendingTabRender || isTyping()) return;
    pendingTabRender = false; lastTabKey = null; render();
  }, 0);
});

function render(force) {
  if (!S || !S.you.country) return;
  const y = S.you;
  const myPub = S.countries[y.country] || {};
  const isPrez = myPub.president === y.name;

  /* HUD */
  $('#me-name').textContent = y.name + (y.admin ? ' ★' : '') + (isPrez ? ' 👑' : '');
  $('#me-country').textContent = myPub.name || y.country;
  $('#me-money').textContent = fmt(y.money);
  $('#me-level').textContent = y.level;
  $('#me-rank').textContent = '+' + Math.round(y.rankBonus * 100) + '%';
  const rkChip = $('#me-rank'); if (rkChip && !rkChip.dataset.bound) { rkChip.dataset.bound = 1; rkChip.style.cursor = 'pointer'; rkChip.title = 'الرتب العسكرية'; rkChip.onclick = () => { ranksOpen = true; curTab = 'war'; render(true); }; }
  $('#war-dot').classList.toggle('hidden', !S.wars.some(w => w.from === y.country || w.to === y.country));
  $('#bars').innerHTML =
    bar('صحة', y.bars.health, y.barMax.health, 'health') + bar('جوع', y.bars.hunger, y.barMax.hunger, 'hunger') +
    bar('طاقة', y.bars.energy, y.barMax.energy, 'energy') + bar('XP', y.xp, y.levelXp, 'xp');

  /* dock + sheet visibility */
  [...$('#dock').children].forEach(x => x.classList.toggle('on', x.dataset.tab === curTab));
  const sheetOpen = curTab !== 'map' || !!selCountry;
  $('#sheet').classList.toggle('hidden', !sheetOpen);
  ['map', 'home', 'war', 'gov', 'market', 'admin'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== curTab));

  /* map colors */
  updateMapColors($('#stage'));

  /* sheet content, fingerprinted */
  const key = curTab + '|' + tabDataKey();
  if (force || key !== lastTabKey) {
    if (force || !isTyping()) {
      lastTabKey = key;
      if (sheetOpen) {
        if (curTab === 'map') renderCountry();
        else if (curTab === 'home') renderHome();
        else if (curTab === 'war') renderWar();
        else if (curTab === 'gov') renderGov();
        else if (curTab === 'market') renderMarket();
        else if (curTab === 'admin') renderAdmin();
      }
    } else pendingTabRender = true;
  }
  $('#feed').classList.toggle('hidden', sheetOpen);
  renderFeed();
}
function bar(label, c, m, cls) {
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${pct(c, m)}%"></div></div><span class="val">${fmt(c)}/${m}</span></div>`;
}

/* ---------- live feed ---------- */
let lastFeedHead = '';
function renderFeed() {
  const items = S.log.slice(0, 3);
  const head = items.length ? items[0].ts + items[0].msg : 'x';
  if (head === lastFeedHead) return;
  lastFeedHead = head;
  $('#feed').innerHTML = items.map((l, i) =>
    `<div class="feedline${i === 0 ? ' fresh' : ''}"><time>${new Date(l.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>${esc(l.msg)}</div>`).join('');
}

/* --- country panel (map tab sheet) --- */
function renderCountry() {
  const el = $('#tab-map');
  if (!selCountry || !MAP.defs[selCountry]) {
    el.innerHTML = `<p class="hint" style="margin:14px 0">اضغط على أي دولة على الخريطة — البنفسجي دولتك، الأحمر دولة في حرب، الأزرق فيها لاعبين.</p>`;
    return;
  }
  const iso = selCountry, def = MAP.defs[iso];
  const pub = S.countries[iso] || null;
  const citizens = pub ? pub.citizens : [];
  const regions = pub ? pub.regions : def.regions.map(r => ({ ...r, owner: iso }));
  const myPub = S.countries[S.you.country] || {};
  const isPrez = myPub.president === S.you.name;
  const busy = S.wars.some(w => w.from === S.you.country || w.to === S.you.country);
  const canWar = isPrez && iso !== S.you.country && !busy && (MAP.neighbors[S.you.country] || []).includes(iso);

  let h = `<div class="card"><h4>${esc(def.name)}</h4>
    <div class="kv"><span>مواطنين</span><b>${citizens.length ? esc(citizens.join('، ')) : 'محدش هنا'}</b></div>
    <div class="kv"><span>الخزينة</span><b>${pub ? fmt(pub.treasury) : 0} ج</b></div>
    <div class="kv"><span>الرئيس</span><b>${esc(pub && pub.president ? pub.president : '— منصب شاغر —')}</b></div>
  </div><div class="card"><h4>الأقاليم</h4>`;
  for (const r of regions) {
    const own = r.owner === iso;
    const dbns = pub && pub.defenseBonus && pub.defenseBonus[r.id];
    const fundable = isPrez && iso === S.you.country && own;
    h += `<div class="regionrow"><span>${esc(r.name)}${own ? '' : ` <span class="pill">محتل: ${esc(MAP.defs[r.owner] ? MAP.defs[r.owner].name : r.owner)}</span>`}${dbns ? ` <span class="pill">حائط ${fmt(dbns)}</span>` : ''}</span>
      ${canWar && own ? `<button class="danger" data-war="${esc(r.id)}" type="button">أعلن حرب</button>` : ''}
      ${fundable ? `<button class="cyan" data-def="${esc(r.id)}" type="button">حصّنه</button>` : ''}
    </div>`;
  }
  h += `<button class="bigbtn" id="btn-open-country" type="button" style="margin-top:8px">افتح صفحة الدولة الكاملة</button>`;
  el.innerHTML = h + '</div>';
  const oc = $('#btn-open-country');
  if (oc) oc.onclick = () => { govMode = 'country'; govCid = iso; govTab = 'home'; curTab = 'gov'; render(true); };
  el.querySelectorAll('[data-war]').forEach(b => b.onclick = async () => {
    try { await api('/api/war', { regionId: b.dataset.war }); flash('أُعلنت الحرب!', 'dmg'); refresh(); }
    catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => {
    const amt = Number(prompt('مبلغ من الخزينة للحائط (أقل حاجة 10):', '100'));
    if (!amt) return;
    try { await api('/api/defense', { regionId: b.dataset.def, amount: amt }); flash('الحائط اتبنى', 'good'); refresh(); }
    catch (e) { flash(e.message, 'miss'); }
  });
}

/* --- home tab --- */
function renderHome() {
  const y = S.you, sh = S.shop;
  const wName = sh.weapons[y.weapon] ? sh.weapons[y.weapon].name : '—';
  const aName = sh.armors[y.armorGear] ? sh.armors[y.armorGear].name : '—';
  let h = `<div class="grid2">
    <button class="bigbtn" id="btn-work" type="button">اشتغل<br><small>+${Math.round(50 * (1 + y.skills.production * 0.05))} ج — 10 طاقة</small></button>
    <button class="bigbtn cyan" id="btn-company" type="button">شركاتك: ${y.companiesOwned}<br><small>شركة: ${sh.company.price} ج — ${sh.company.income} ج/ساعة</small></button>
  </div>
  <h3>المهمات <span class="pill">أسرع طريق للفلوس واللفل ونقاط المهارة</span></h3>
  <div class="rtoggle mistoggle">
    <button data-mistab="daily" class="${misTab === 'daily' ? 'on' : ''}" type="button">يومية ${(S.missions || []).filter(m => m.daily && m.done).length}/${(S.missions || []).filter(m => m.daily).length}</button>
    <button data-mistab="weekly" class="${misTab === 'weekly' ? 'on' : ''}" type="button">أسبوعية ${(S.missions || []).filter(m => m.weekly && m.done).length}/${(S.missions || []).filter(m => m.weekly).length}</button>
    <button data-mistab="story" class="${misTab === 'story' ? 'on' : ''}" type="button">إنجازات ${(S.missions || []).filter(m => !m.daily && !m.weekly && m.done).length}/${(S.missions || []).filter(m => !m.daily && !m.weekly).length}</button>
  </div>
  <p class="hint">${misTab === 'daily' ? 'بتتصفّر كل يوم' : misTab === 'weekly' ? 'بتتصفّر كل أسبوع' : 'مهمات مرة واحدة في العمر — مكافآتها أكبر'}</p>
  ${(S.missions || []).filter(m => (misTab === 'daily' && m.daily) || (misTab === 'weekly' && m.weekly) || (misTab === 'story' && !m.daily && !m.weekly)).sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)).map(mrow).join('')}
  <h3>المصانع <span class="pill">${y.factories.length}/${y.factoryCap} — مهارة إدارة بتزوّد الحد</span></h3>
  <p class="hint chain">السلسلة: <b>منجم ← حديد ← ذخيرة وسلاح ← الحرب</b> — ومزرعة ← قمح ← أكل. المصنع بيدفع صيانة كل ساعة، ولو الفلوس خلصت بيقف.</p>
  <div class="kv"><span>مخزونك</span><b>حديد: ${fmt(y.goods.iron)} — قمح: ${fmt(y.goods.wheat)}</b></div>
  <div class="grid3">${Object.entries(sh.factories).map(([k, f]) =>
    `<div class="shopitem">${f.name}<span class="have">${f.desc} — صيانة ${f.upkeep} ج/ساعة</span><b>${f.price} ج</b><button data-fbuild="${k}" type="button">ابنِ</button></div>`).join('')}</div>
  ${y.factories.map(f => {
    const def = sh.factories[f.type];
    const out = def.ammo ? `${Math.round(def.out * f.level * (1 + y.skills.production * 0.10) * 10) / 10} ذخيرة/ساعة (بيستهلك ${def.consumesIron * f.level} حديد/ساعة)` : `${Math.round(def.out * f.level * (1 + y.skills.production * 0.10) * 10) / 10} ${def.good === 'iron' ? 'حديد' : 'قمح'}/ساعة`;
    const idle = y.money < def.upkeep * f.level;
    return `<div class="regionrow"><span>${def.name} <span class="lvl">مستوى ${f.level}/${sh.factoryMaxLevel}</span><br><small class="have">${out} — صيانة ${def.upkeep * f.level} ج/ساعة${idle ? ' — <b style="color:var(--red)">هيقف: فلوس الصيانة مش كافية</b>' : ''}</small></span>
      ${f.level < sh.factoryMaxLevel ? `<button class="cyan" data-fup="${f.id}" type="button">طوّر (${fmt(f.upNext)} ج)</button>` : '<span class="pill">ماكس</span>'}</div>`;
  }).join('')}
  <h3>التصنيع <span class="pill">من غير فلوس — بخامات مصانعك</span></h3>
  <div class="grid3">
    <div class="shopitem">وجبة (+20 صحة)<span class="have">${sh.craftMealWheat} قمح — عندك: ${fmt(y.goods.wheat)}</span><button data-craft="meal" type="button">اصنع</button></div>
    ${Object.entries(sh.craftAmmoIron).map(([k, c]) =>
      `<div class="shopitem">${sh.ammos[k].name}<span class="have">${c} حديد — عندك: ${fmt(y.ammo[k] || 0)}</span><button data-craft="ammo:${k}" type="button">اصنع</button></div>`).join('')}
  </div>
  <h3>الأكل <span class="pill">الأكل بيعالج الصحة وبياخد 1 جوع</span></h3>
  <div class="grid3">${Object.entries(sh.foods).map(([k, f]) =>
    `<div class="shopitem">${f.name} <span class="have">(+${f.heal} صحة)</span><b>${f.price} ج</b><span class="have">عندك: ${y.foods[k] || 0}</span>
     <button data-buy="food:${k}" type="button">اشتري</button>
     <button class="cyan" data-eat="${k}" type="button">كل</button></div>`).join('')}</div>
  <h3>الذخيرة</h3>
  <div class="grid3">${Object.entries(sh.ammos).map(([k, a]) =>
    `<div class="shopitem">${a.name}<b>${a.price} ج</b><span class="have">عندك: ${fmt(y.ammo[k] || 0)}</span><button data-buy="ammo:${k}" type="button">اشتري</button></div>`).join('')}</div>
  <h3>السلاح <span class="pill">الحالي: ${esc(wName)}</span></h3>
  <div class="grid3">${sh.weapons.map((w, i) => i <= y.weapon ? '' :
    `<div class="shopitem">${w.name} <span class="have">(هجوم ${w.atk} — كريت ${w.crit}%)</span><b>${w.price} ج أو ${sh.weaponIron[i]} حديد</b><button data-buy="weapon:${i}" type="button">اشتري</button><button class="cyan" data-craft="weapon:${i}" type="button">اصنع</button></div>`).join('')}</div>
  <h3>الدرع <span class="pill">الحالي: ${esc(aName)}</span></h3>
  <div class="grid3">${sh.armors.map((a, i) => i <= y.armorGear ? '' :
    `<div class="shopitem">${a.name} <span class="have">(امتصاص ${a.armor}%)</span><b>${a.price} ج</b><button data-buy="armor:${i}" type="button">اشتري</button></div>`).join('')}</div>
  <h3>المهارات <span class="pill">نقاط متاحة: <b>${y.skillPoints}</b></span></h3>
  <h3 style="border:none;color:var(--red);font-size:13px">شجرة الحرب</h3>
  ${sh.skills.filter(s => s.side === 'war').map(skillRow).join('')}
  <h3 style="border:none;color:var(--green);font-size:13px">شجرة الاقتصاد</h3>
  ${sh.skills.filter(s => s.side === 'eco').map(skillRow).join('')}`;
  $('#tab-home').innerHTML = h;

  function mrow(m) {
    const pr = Math.min(m.progress, m.target);
    const pc = Math.min(100, Math.round(m.progress / m.target * 100));
    return `<div class="skillrow misrow ${m.done ? 'done' : ''}"><span>${m.name}<span class="lvl">${fmt(pr)}/${fmt(m.target)} — ${pc}%</span><br><small class="have">🪙 ${fmt(m.reward.money)} · ✨ ${m.reward.xp} XP · 🧠 ${m.reward.sp} مهارة</small></span>
      ${m.done ? '<span class="pill" style="color:var(--green)">اتعملت ✓</span>' : `<div class="track" style="min-width:90px;align-self:center"><div class="fill xp" style="width:${pc}%"></div></div>`}</div>`;
  }
  function skillRow(s) {
    const lvl = y.skills[s.id] || 0;
    return `<div class="skillrow"><span>${s.name}<span class="lvl">${lvl}/${sh.skillMax}</span></span>
      <button data-skill="${s.id}" ${lvl >= sh.skillMax || y.skillPoints < lvl + 1 ? 'disabled' : ''} type="button">+${lvl + 1} نقطة</button></div>`;
  }
  $('#btn-work').onclick = async () => { try { await api('/api/work'); flash('اشتغلت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  $('#tab-home').querySelectorAll('[data-mistab]').forEach(b => b.onclick = () => { misTab = b.dataset.mistab; renderHome(); });
  $('#btn-company').onclick = async () => { try { await api('/api/buy', { kind: 'company' }); flash('شركة جديدة!', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const el = $('#tab-home');
  el.querySelectorAll('[data-buy]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.buy.split(':');
    try { await api('/api/buy', { kind, id }); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-eat]').forEach(b => b.onclick = async () => {
    try { await api('/api/eat', { food: b.dataset.eat }); flash('أكلت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-skill]').forEach(b => b.onclick = async () => {
    try { await api('/api/skill', { id: b.dataset.skill }); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-fbuild]').forEach(b => b.onclick = async () => {
    try { await api('/api/factory', { type: b.dataset.fbuild }); flash('اتبنى!', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-fup]').forEach(b => b.onclick = async () => {
    try { await api('/api/factory/upgrade', { id: b.dataset.fup }); flash('اتطوّر', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-craft]').forEach(b => b.onclick = async () => {
    try { await api('/api/craft', { what: b.dataset.craft }); flash('اتصنع', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
}

/* --- war tab: world battles list + battle detail --- */
let battleView = null;
let rankMode = 'battle';
function frameClass(w, cid) {
  const y = S.you;
  const myAl = (S.alliances || []).find(a => a.members.includes(y.country));
  if (cid === y.country) return 'me';
  if (myAl && myAl.members.includes(cid)) return 'ally';
  return 'foe';
}
function roundsDots(w) {
  let d = '';
  for (let i = 1; i <= 3; i++) {
    let cls = 'dot';
    if (i < w.round || (w.over && i <= w.round)) cls += i <= w.roundWins.att + w.roundWins.def ? ' done' : '';
    if (i === w.round && !w.over) cls += ' now';
    d += `<span class="${cls}"></span>`;
  }
  return `<span class="dots">${d}</span> <span class="lvl">${w.roundWins.att} - ${w.roundWins.def}</span>`;
}
function tugBar(w) {
  const a = Math.min(100, w.terr.att / w.terr.win * 100);
  const d = Math.min(100, w.terr.def / w.terr.win * 100);
  return `<div class="tug">
    <div class="tug-half att"><div class="tug-fill" style="width:${a}%"></div></div>
    <div class="tug-mid"></div>
    <div class="tug-half def"><div class="tug-fill" style="width:${d}%"></div></div>
  </div>
  <div class="tuglbl"><span class="wallA-t">${fmt(w.terr.att)}</span><span>الأرض — أول 300 ياخد الجولة</span><span class="wallB-t">${fmt(w.terr.def)}</span></div>`;
}
function rankRow(r, i) {
  const cn = r.country && MAP.defs[r.country] ? MAP.defs[r.country].name : (r.country || '');
  return `<div class="rankrow"><span class="rr-n">${i + 1}</span><span class="rr-l">${r.level}</span><b>${esc(r.name)}</b><span class="rr-c">${esc(cn)}</span><b class="rr-d">${fmt(r.dmg)}</b></div>`;
}
function renderWar() {
  const el = $('#tab-war'), y = S.you, sh = S.shop;
  const myPub = S.countries[y.country] || {};
  const isPrez = myPub.president === y.name;
  const myAl = (S.alliances || []).find(a => a.members.includes(y.country));
  const inWar = w => w.from === y.country || w.to === y.country ||
    (w.alliesCalled && myAl && (myAl.members.includes(w.from) || myAl.members.includes(w.to)));
  const myWars = S.wars.filter(inWar);
  const otherWars = S.wars.filter(w => !inWar(w));
  const nm = id => MAP.defs[id] ? MAP.defs[id].name : id;
  let h = '';
  h += `<button id="btn-ranks" class="ghost ranksbtn" type="button">🏅 الرتب العسكرية وأقوى المقاتلين</button>`;
  if (!S.wars.length) h += '<p class="hint" style="margin-top:14px">لا حروب حاليًا. الرئيس يقدر يعلن حرب على إقليم تابع لدولة جارة — اضغط على الدولة في الخريطة.</p>';

  if (ranksOpen) {
    const myR = S.myRank || 0, ranks = S.ranks || [];
    const cur = ranks[myR] || { name: '—', icon: '🎖', dmg: 0, bonus: 0 };
    const next = ranks[myR + 1];
    const dmg = y.totalDamage || 0;
    const span = next ? next.dmg - cur.dmg : 1;
    const into = next ? Math.min(1, (dmg - cur.dmg) / span) : 1;
    h += `<div class="rankhero card">
      <button id="btn-ranks-back" class="ghost" type="button">← رجوع للحروب</button>
      <div class="rh-cur"><span class="rh-icon">${cur.icon}</span><div><b>${esc(cur.name)}</b><small>رتبتك الحالية — ضرر إضافي +${Math.round(cur.bonus * 100)}%</small></div></div>
      ${next ? `<div class="track big"><div class="fill xp" style="width:${Math.round(into * 100)}%"></div></div>
      <p class="hint">باقي <b dir="ltr">${fmt(next.dmg - dmg)}</b> ضرر لرتبة <b>${esc(next.name)}</b> ${next.icon} (+${Math.round(next.bonus * 100)}%)</p>`
      : '<p class="hint">وصلت أعلى رتبة في الجيش 👑</p>'}
    </div>
    <h3>سلّم الرتب العسكرية <span class="pill">الرتبة بتتاخد من إجمالي ضررك في الحروب وبتزوّد ضررك</span></h3>
    ${ranks.map((r, i2) => `<div class="ranktier ${i2 === myR ? 'cur' : ''} ${i2 < myR ? 'passed' : ''}">
      <span class="rt-icon">${r.icon}</span><b>${esc(r.name)}</b>
      <span class="rt-dmg" dir="ltr">${fmt(r.dmg)}</span><span class="rt-bonus">+${Math.round(r.bonus * 100)}%</span>
      ${i2 === myR ? '<span class="pill">أنت هنا</span>' : i2 < myR ? '<span class="rt-check">✓</span>' : ''}
    </div>`).join('')}
    <h3>أقوى المقاتلين</h3>
    ${(S.topFighters || []).map((f, i2) => `<div class="rankrow"><span class="rr-n">${i2 + 1}</span><span class="rr-l">${f.level}</span><b>${esc(f.name)}</b><span class="rr-c">${esc(nm(f.country) || '')}</span><span>${(S.ranks[f.rank] || {}).icon || ''}</span><b class="rr-d">${fmt(f.dmg)}</b></div>`).join('') || '<p class="hint">لسه مفيش مقاتلين</p>'}`;
    el.innerHTML = h;
    $('#btn-ranks-back').onclick = () => { ranksOpen = false; renderWar(); };
    return;
  }
  const openW = battleView != null ? S.wars.find(w => w.id === battleView) : null;
  if (openW) {
    const w = openW;
    const mine = inWar(w);
    const mins = Math.max(0, Math.round((w.endsAt - Date.now()) / 60000));
    const tickIn = Math.max(0, Math.round((w.tickEndsAt - Date.now()) / 1000));
    const myOrder = w.orders && w.orders[y.country];
    const canOrder = isPrez && (y.country === w.from || y.country === w.to) && !w.over;
    const tot = (w.attDmg + w.defDmg) || 1;
    const attPct = Math.round(w.attDmg / tot * 1000) / 10, defPct = Math.round(w.defDmg / tot * 1000) / 10;
    const sk = y.skills || {};
    const wName = ix => sh.weapons[ix] ? sh.weapons[ix].name : 'قبضة';
    const wAtk = ix => sh.weapons[ix] ? sh.weapons[ix].atk : 0;
    const rank = (w.rankRound && w.rankBattle) ? (rankMode === 'round' ? w.rankRound : w.rankBattle) : { att: [], def: [] };
    if (w.hits && w.hits.length) {
      h += `<div class="card hitfeed">` + w.hits.slice(0, 8).map(hx => `
        <div class="hitline ${hx.crit || hx.dmg >= 1000 ? 'big' : ''}">
          <span class="hl-side ${hx.side}"></span>
          <b>${esc(hx.name)}</b><span class="hl-c">${esc(hx.country ? nm(hx.country) : '')}</span>
          <span class="hl-w">${hx.weapon ? '🔫' : '👊'}${hx.ammo ? '➕' : ''}</span>
          <b class="hl-d">${hx.missed ? 'أخطأ' : fmt(hx.dmg) + (hx.crit ? '!' : '')}</b>
        </div>`).join('') + `</div>`;
    }
    h += `<div class="card">
      <div class="row" style="justify-content:space-between"><button class="cyan" id="btn-back-battles" type="button">← كل المعارك</button><span class="pill">الجولة ${Math.min(w.round, 3)} من 3 ${roundsDots(w)}</span></div>
      <h4 style="font-size:16px;text-align:center"><span class="side ${frameClass(w, w.from)}">${esc(nm(w.from))}</span> <b class="wscore" dir="ltr">${w.roundWins.att} - ${w.roundWins.def}</b> <span class="side ${frameClass(w, w.to)}">${esc(nm(w.to))}</span></h4>
      <div class="hint center" style="margin:0 0 4px">${esc(w.regionName || '')} — النقطة الجاية بعد ${Math.floor(tickIn / 60)}:${String(tickIn % 60).padStart(2, '0')}${w.tickGain ? ` <b class="cyan-t">+${w.tickGain} أرض</b>` : ''} — أقصى وقت ${mins >= 60 ? Math.floor(mins / 60) + ' س ' + mins % 60 + ' د' : mins + ' د'}</div>
      ${tugBar(w)}
      <div class="splitbar"><div class="sp-att" style="width:${attPct}%"></div><div class="sp-def" style="width:${defPct}%"></div></div>
      <div class="splitlbl"><span><b dir="ltr">${defPct}%</b> ${fmt(w.defDmg)} 🔥</span><span>🔥 ${fmt(w.attDmg)} <b dir="ltr">${attPct}%</b></span></div>
    </div>`;

    h += `<div class="sidecards">
      <div class="sidecard def"><div class="sc-mod">${w.sideMods.def ? '+' + w.sideMods.def + '%' : 'بدون أمر'}</div><div class="sc-name">🛡 دفاع — ${esc(nm(w.to))}</div><div class="sc-meta"><span>👥 ${w.sideCount.def}</span><span>${fmt(w.defDmg)} ضرر</span></div></div>
      <div class="sidecard att"><div class="sc-mod">${w.sideMods.att ? '+' + w.sideMods.att + '%' : 'بدون أمر'}</div><div class="sc-name">⚔ هجوم — ${esc(nm(w.from))}</div><div class="sc-meta"><span>👥 ${w.sideCount.att}</span><span>${fmt(w.attDmg)} ضرر</span></div></div>
    </div>`;
    if (mine && !w.over) {
      const best = ['feast', 'meal', 'bread'].find(f => y.foods[f] > 0);
      h += `<div class="card fighter">
        <div class="frow">
          <div class="favatar">${esc((y.name[0] || '?').toUpperCase())}<span class="flvl">${y.level}</span></div>
          <div class="fstats">
            <div>⚔ هجوم <b>${sk.attack || 0}</b></div><div>🎯 دقة <b>${sk.precision || 0}</b></div>
            <div>💥 كريت <b>${(sk.crit || 0) * 2}%</b></div><div>🛡 درع <b>${(sk.armor || 0) * 2 + (sh.armors[y.armorGear] ? sh.armors[y.armorGear].armor : 0)}%</b></div>
            <div>💨 مراوغة <b>${((sk.dodge || 0) * 1.5).toFixed(0)}%</b></div><div>🏅 رتبة <b>+${Math.round(y.rankBonus * 100)}%</b></div>
          </div>
          <button class="cyan feat" data-eat="${best || ''}" ${best ? '' : 'disabled'} type="button">🍽 كل${best ? ' (' + y.foods[best] + ')' : ''}</button>
        </div>
        <div class="equip">
          <div class="slot"><i>🗡</i><b>${esc(wName(y.weapon))}</b><span>${wAtk(y.weapon)} ضرر</span></div>
          <div class="slot"><i>🧨</i><b>${battle.ammo === 'none' ? 'بدون' : esc(sh.ammos[battle.ammo].name.split(' ')[0])}</b><span>${battle.ammo === 'none' ? '—' : fmt(y.ammo[battle.ammo] || 0)}</span></div>
          <div class="slot ${y.armorGear ? '' : 'empty'}"><i>🪖</i><b>${y.armorGear ? esc(sh.armors[y.armorGear].name) : 'فاضي'}</b><span>${y.armorGear ? sh.armors[y.armorGear].armor + '%' : ''}</span></div>
          <div class="slot empty"><i>🦺</i><b>فاضي</b><span></span></div>
          <div class="slot empty"><i>👖</i><b>فاضي</b><span></span></div>
          <div class="slot empty"><i>🥾</i><b>فاضي</b><span></span></div>
          <div class="slot empty"><i>🧤</i><b>فاضي</b><span></span></div>
        </div>
        <div class="amnoselect">
          ${['none', 'light', 'mid', 'heavy'].map(k => `<button data-ammo="${k}" data-w="${w.id}" class="${battle.warId === w.id && battle.ammo === k ? 'on' : ''}" type="button">${k === 'none' ? 'بدون' : sh.ammos[k].name + ' (' + fmt(y.ammo[k] || 0) + ')'}</button>`).join('')}
        </div>
        <button class="bigbtn hitbtn" data-hit="${w.id}" type="button">اضرب!</button>
      </div>`;
      h += `<div class="card">
        <div class="amnoselect" style="margin-top:0">
          <button data-supply="iron:${w.id}" type="button">زوّد بـ${sh.supply.iron.amount} حديد (+${sh.supply.iron.points}) — عندك ${fmt(y.goods.iron)}</button>
          <button data-supply="heavy:${w.id}" type="button">زوّد بـ${sh.supply.heavy.amount} ثقيلة (+${sh.supply.heavy.points}) — عندك ${fmt(y.ammo.heavy || 0)}</button>
          ${w.alliesCalled ? '<button disabled type="button">الحلفاء في الحرب معاك</button>' : (isPrez && myAl && myAl.members.length > 1 ? `<button class="cyan" data-alcall="${w.id}" type="button">نادِ حلفاء «${esc(myAl.name)}»</button>` : '')}
        </div>
        ${canOrder ? `<h3 style="border:none;font-size:13px">أمر قتال (من الخزينة)</h3>
        <div class="amnoselect">
          ${[1, 2, 3].map(pr => `<button data-order="${pr}:${w.id}" type="button">+${[5, 10, 15][pr - 1]}% — ${[100, 250, 500][pr - 1]} ج</button>`).join('')}
        </div>` : ''}
      </div>`;
    }
    h += `<div class="card">
      <div class="row" style="justify-content:space-between;align-items:center"><h3 style="border:none;margin:0">الترتيب</h3>
      <div class="rtoggle"><button data-rankmode="battle" class="${rankMode === 'battle' ? 'on' : ''}" type="button">معركة</button><button data-rankmode="round" class="${rankMode === 'round' ? 'on' : ''}" type="button">جولة ${Math.min(w.round, 3)}#</button></div></div>
      <div class="rankcols">
        <div class="rankcol"><h4>⚔ ${esc(nm(w.from))}</h4>${rank.att.length ? rank.att.map((r2, i2) => rankRow(r2, i2)).join('') : '<p class="hint">لسه مفيش ضرر</p>'}</div>
        <div class="rankcol"><h4>🛡 ${esc(nm(w.to))}</h4>${rank.def.length ? rank.def.map((r2, i2) => rankRow(r2, i2)).join('') : '<p class="hint">لسه مفيش ضرر</p>'}</div>
      </div>
    </div>`;
    if (w.over) h += `<p class="hint center">المعركة خلصت — ${w.over === 'won' ? 'الهجوم كسب والإقليم اتنقل' : 'الدفاع صمد'}.</p>`;
  } else {
    const card = w => {
      const mine = inWar(w);
      const myOrder = w.orders && w.orders[y.country];
      return `<div class="card battlecard ${mine ? 'mine' : ''}" data-open="${w.id}">
        <h4><span class="side ${frameClass(w, w.from)}">${esc(nm(w.from))}</span> × <span class="side ${frameClass(w, w.to)}">${esc(nm(w.to))}</span> — ${esc(w.regionName || '')}</h4>
        <div class="row" style="justify-content:space-between;align-items:center"><span>الجولة ${Math.min(w.round, 3)}/3 ${roundsDots(w)}</span>
        ${myOrder ? `<span class="pill orderbadge">أوامر +${[5, 10, 15][myOrder.priority - 1] || 0}%</span>` : ''}
        ${mine ? '<span class="pill">حربك</span>' : ''}</div>
        ${tugBar(w)}
      </div>`;
    };
    if (myWars.length) h += `<h3>معاركك <span class="pill">حمراء = عدو — زرقاء = حليف أو انت</span></h3>` + myWars.map(card).join('');
    if (otherWars.length) h += `<h3>معارك العالم</h3>` + otherWars.map(card).join('');
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-rankmode]').forEach(b => b.onclick = () => { rankMode = b.dataset.rankmode; renderWar(); });
  el.querySelectorAll('[data-eat]').forEach(b => b.onclick = async () => {
    if (!b.dataset.eat) return;
    try { await api('/api/eat', { food: b.dataset.eat }); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  if (!myWars.find(w => w.id === battle.warId)) battle = { warId: myWars[0] ? myWars[0].id : null, ammo: battle.ammo };
  const back = $('#btn-back-battles');
  if (back) back.onclick = () => { battleView = null; renderWar(); };
  el.querySelectorAll('[data-open]').forEach(c => c.onclick = () => { battleView = Number(c.dataset.open); renderWar(); });
  const rb = el.querySelector('#btn-ranks'); if (rb) rb.onclick = () => { ranksOpen = true; renderWar(); };
  el.querySelectorAll('[data-ammo]').forEach(b => b.onclick = () => { battle = { warId: Number(b.dataset.w), ammo: b.dataset.ammo }; renderWar(); });
  el.querySelectorAll('[data-alcall]').forEach(b => b.onclick = async () => {
    try { await api('/api/alliance/call', { warId: Number(b.dataset.alcall) }); flash('الحلفاء اتحشدوا', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-order]').forEach(b => b.onclick = async () => {
    const [pr, wid] = b.dataset.order.split(':');
    try { await api('/api/order', { warId: Number(wid), priority: Number(pr) }); flash('الأمر اتنشر', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-supply]').forEach(b => b.onclick = async () => {
    const [kind, wid] = b.dataset.supply.split(':');
    try { await api('/api/supply', { warId: Number(wid), kind }); flash('التموين وصل', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-hit]').forEach(b => b.onclick = async () => {
    const wid = Number(b.dataset.hit);
    try {
      const r = await api('/api/hit', { warId: wid, ammo: battle.warId === wid ? battle.ammo : 'none' });
      if (r.dodged) flash('راوغت!', 'good');
      else if (r.missed) flash('ضايعة!', 'miss');
      else if (r.crit) { flash('كريت!', 'crit'); floatDmg('-' + fmt(r.dmg), 'crit', b); }
      else floatDmg('-' + fmt(r.dmg), 'dmg', b);
      refresh();
    } catch (e) { flash(e.message, 'miss'); }
  });
}

/* --- gov tab --- */
/* --- gov tab: country page + countries list (WarEra country screen density) --- */
const GOV_TABS = [['home', '🏠'], ['eco', '💰'], ['pop', '👥'], ['mil', '⚔'], ['gov', '🏛'], ['dip', '🤝']];
const OFFICES_C = [
  ['defense', '🛡', 'وزير الدفاع', 'أوامر القتال على المعارك — تمويل الدفاع من الخزينة — نداء الحلفاء'],
  ['economy', '💰', 'وزير الاقتصاد', 'ضريبة الدخل والسوق — ميزانية تنمية الأقاليم'],
  ['foreign', '🤝', 'وزير الخارجية', 'عرض وقبول السلام — التحالفات والمعاهدات — العدو اللدود'],
  ['staff', '🎖', 'رئيس الأركان', 'إدارة الوحدة الرسمية وأوامرها وتشكيلها'],
  ['interior', '🏠', 'وزير الداخلية', 'مقاومة وتهدئة الأقاليم — تمويل دفاعها'],
];
function spark(points, color) {
  const w = 70, hh = 22;
  if (!points || points.length < 2) points = [0, 0];
  const min = Math.min(...points), max = Math.max(...points), span = (max - min) || 1;
  const pts = points.map((v, ix) => `${(ix / (points.length - 1) * w).toFixed(1)},${(hh - 2 - (v - min) / span * (hh - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}
function rankChip(r) {
  if (!r) return '';
  const up = r.delta > 0, dn = r.delta < 0;
  return `<span class="rankchip ${up ? 'up' : dn ? 'dn' : ''}">${up ? '↑' : dn ? '↓' : ''}${Math.abs(r.delta) || ''} <b>#${r.rank}</b></span>`;
}
function relationTo(cid) {
  const y = S.you;
  if (cid === y.country) return null;
  const myAl = (S.alliances || []).find(a => a.members.includes(y.country));
  if (myAl && myAl.members.includes(cid)) return ['حليف', 'ally'];
  const mine = S.countries[y.country], theirs = S.countries[cid];
  const atWar = S.wars.some(w => (w.from === y.country && w.to === cid) || (w.from === cid && w.to === y.country));
  if (atWar || (mine && mine.swornEnemy === cid) || (theirs && theirs.swornEnemy === y.country)) return ['عدو', 'foe'];
  return ['محايد', 'neutral'];
}
function cname(cid) { return MAP.defs[cid] ? MAP.defs[cid].name : cid; }

function renderMarket() {
  const el = $('#tab-market'), y = S.you, sh = S.shop;
  const inv = y.inv || { weapons: {}, armors: {} };
  let h = `<div class="rtoggle mistoggle">
    <button data-mkt="inv" class="${mktTab === 'inv' ? 'on' : ''}" type="button">🎒 مخزونك</button>
    <button data-mkt="mkt" class="${mktTab === 'mkt' ? 'on' : ''}" type="button">🛒 السوق <b>${(S.market || []).length}</b></button>
    <button data-mkt="cases" class="${mktTab === 'cases' ? 'on' : ''}" type="button">📦 صناديق</button>
  </div>`;
  if (mktTab === 'inv') {
    h += `<h3>المجهّز حاليًا</h3><div class="grid2">
      <div class="card mini"><b>⚔ ${esc(sh.weapons[y.weapon].name)}</b><small>${sh.weapons[y.weapon].atk} ضرر · كريت ${sh.weapons[y.weapon].crit}%</small></div>
      <div class="card mini"><b>🛡 ${esc(sh.armors[y.armorGear].name)}</b><small>${sh.armors[y.armorGear].armor}% درع</small></div>
    </div>
    <h3>مخزونك <span class="pill">بيع أي قطعة مش لابسها في السوق بسعرك</span></h3>`;
    const rows = [];
    for (const [i, n] of Object.entries(inv.weapons)) {
      if (!n) continue;
      const d = sh.weapons[i], eq = y.weapon === Number(i);
      rows.push(`<div class="skillrow"><span>${eq ? '⚔ ' : ''}${esc(d.name)} <span class="lvl">×${n}</span><br><small class="have">${d.atk} ضرر · كريت ${d.crit}%</small></span>
        <div class="invacts">${eq ? '<span class="pill">لابسه</span>' : `<button class="cyan" data-equip="weapon:${i}" type="button">جهّز</button>`}
        ${n > (eq ? 1 : 0) ? `<span class="sellbox"><input type="number" min="1" placeholder="السعر" data-price="weapon:${i}"><button data-sell="weapon:${i}" type="button">بيع</button></span>` : ''}</div></div>`);
    }
    for (const [i, n] of Object.entries(inv.armors)) {
      if (!n) continue;
      const d = sh.armors[i], eq = y.armorGear === Number(i);
      rows.push(`<div class="skillrow"><span>${eq ? '🛡 ' : ''}${esc(d.name)} <span class="lvl">×${n}</span><br><small class="have">${d.armor}% درع</small></span>
        <div class="invacts">${eq ? '<span class="pill">لابسه</span>' : `<button class="cyan" data-equip="armor:${i}" type="button">جهّز</button>`}
        ${n > (eq ? 1 : 0) ? `<span class="sellbox"><input type="number" min="1" placeholder="السعر" data-price="armor:${i}"><button data-sell="armor:${i}" type="button">بيع</button></span>` : ''}</div></div>`);
    }
    h += rows.join('') || '<p class="hint">مخزونك فاضي — اشترِ سلاح أو افتح صندوق</p>';
  } else if (mktTab === 'mkt') {
    const mine = (S.market || []).filter(l => l.seller === y.name);
    const others = (S.market || []).filter(l => l.seller !== y.name);
    h += `<h3>عروض اللاعبين</h3>`;
    h += others.length ? others.map(l => `<div class="skillrow"><span>${l.kind === 'weapon' ? '⚔' : '🛡'} ${esc(l.name)}<br><small class="have">${l.stat} — البائع: <b>${esc(l.seller)}</b></small></span>
      <button class="cyan" data-mbuy="${l.id}" type="button" ${y.money < l.price ? 'disabled' : ''}>اشتري ${fmt(l.price)} ج</button></div>`).join('') : '<p class="hint">مفيش عروض دلوقتي — كن أول واحد يبيع</p>';
    if (mine.length) h += `<h3>عروضك</h3>` + mine.map(l => `<div class="skillrow"><span>${esc(l.name)}<br><small class="have">${l.stat}</small></span>
      <button class="ghost" data-mcancel="${l.id}" type="button">إلغاء (${fmt(l.price)} ج)</button></div>`).join('');
  } else {
    h += `<h3>الصناديق <span class="pill">حظك ممكن يجيب سلاح نادر ببلاش تقريبًا</span></h3>
    <div class="grid2">${(S.cases || []).map(c => `<div class="card mini casecard"><span class="cicon">${c.icon}</span><b>${esc(c.name)}</b>
      <button class="cyan" data-case="${c.id}" type="button" ${y.money < c.price ? 'disabled' : ''}>افتح بـ ${fmt(c.price)} ج</button></div>`).join('')}</div>
    <p class="hint">صندوق الحرب: فلوس أو ذخيرة أو أسلحة ودروع لحد الدرع الأسطوري. الذهبي: فرص أعلى للأسلحة النادرة ونقاط مهارة.</p>
    <div id="case-result"></div>`;
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-mkt]').forEach(b => b.onclick = () => { mktTab = b.dataset.mkt; renderMarket(); });
  el.querySelectorAll('[data-equip]').forEach(b => b.onclick = async () => {
    const [kind, idx] = b.dataset.equip.split(':');
    try { await api('/api/equip', { kind, idx: Number(idx) }); flash('اتجهّز', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-sell]').forEach(b => b.onclick = async () => {
    const [kind, idx] = b.dataset.sell.split(':');
    const inp = el.querySelector(`[data-price="${kind}:${idx}"]`);
    const price = Number(inp && inp.value);
    if (!price || price < 1) { flash('حط سعر الأول', 'miss'); return; }
    try { await api('/api/market/sell', { kind, idx: Number(idx), price }); flash('اتعرض في السوق', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-mbuy]').forEach(b => b.onclick = async () => {
    try { await api('/api/market/buy', { id: Number(b.dataset.mbuy) }); flash('اتشتري!', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-mcancel]').forEach(b => b.onclick = async () => {
    try { await api('/api/market/cancel', { id: Number(b.dataset.mcancel) }); flash('اتلغى العرض', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-case]').forEach(b => b.onclick = async () => {
    try { const r = await api('/api/case', { caseId: b.dataset.case }); flash('طلعلك: ' + r.got + '!', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
}

function renderGov() {
  const el = $('#tab-gov'), y = S.you;
  let h = `<div class="govswitch">
    <button class="${govMode === 'country' ? 'on' : ''}" data-gmode="country" type="button">🏠 صفحة الدولة</button>
    <button class="${govMode === 'list' ? 'on' : ''}" data-gmode="list" type="button">🌍 كل الدول</button>
  </div>`;
  if (govMode === 'list') h += renderCountryList();
  else h += renderCountryPage(govCid || y.country);
  el.innerHTML = h;
  el.querySelectorAll('[data-gmode]').forEach(b => b.onclick = () => { govMode = b.dataset.gmode; renderGov(); });
  el.querySelectorAll('[data-gtab]').forEach(b => b.onclick = () => { govTab = b.dataset.gtab; renderGov(); });
  el.querySelectorAll('[data-open-country]').forEach(b => b.onclick = () => { govMode = 'country'; govCid = b.dataset.openCountry; govTab = 'home'; renderGov(); });
  const gs = $('#gov-search');
  if (gs) gs.oninput = () => { govSearch = gs.value; renderGov(); const n = $('#gov-search'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  el.querySelectorAll('[data-gsort]').forEach(b => b.onclick = () => { govSort = b.dataset.gsort; renderGov(); });
  bindGovActions(el);
}

function renderCountryList() {
  const y = S.you;
  let rows = (S.world || []).map(w => {
    const pub = S.countries[w.id];
    const al = (S.alliances || []).find(a => a.members.includes(w.id));
    return { id: w.id, name: cname(w.id), president: w.president, citizens: w.citizens, alliance: al ? al.name : null, rel: relationTo(w.id), treasury: pub ? pub.treasury : 0 };
  });
  if (govSearch.trim()) rows = rows.filter(r => r.name.includes(govSearch.trim()) || (r.president || '').includes(govSearch.trim()));
  if (govSort === 'pop') rows.sort((a, b) => b.citizens - a.citizens);
  else if (govSort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  else if (govSort === 'treasury') rows.sort((a, b) => b.treasury - a.treasury);
  let h = `<div class="card">
    <input type="text" id="gov-search" placeholder="ابحث عن دولة أو رئيس..." value="${esc(govSearch)}">
    <div class="chips">
      <button class="${govSort === 'pop' ? 'on' : ''}" data-gsort="pop" type="button">السكان</button>
      <button class="${govSort === 'treasury' ? 'on' : ''}" data-gsort="treasury" type="button">الخزينة</button>
      <button class="${govSort === 'name' ? 'on' : ''}" data-gsort="name" type="button">أبجدي</button>
    </div>`;
  for (const r of rows) {
    h += `<div class="crow" data-open-country="${esc(r.id)}">
      <span class="cflagdot ${r.rel ? r.rel[1] : 'me'}"></span>
      <div class="crow-main"><b>${esc(r.name)}</b>${r.id === y.country ? ' <span class="pill">دولتك</span>' : ''}<span class="crow-sub">${esc(r.president || 'بدون رئيس')}</span></div>
      <span class="crow-n">👥 ${r.citizens}</span>
      ${r.alliance ? `<span class="pill albadge">${esc(r.alliance)}</span>` : ''}
      ${r.rel ? `<span class="relchip ${r.rel[1]}">${r.rel[0]}</span>` : ''}
    </div>`;
  }
  return h + '</div>';
}

function renderCountryPage(cid) {
  const y = S.you, pub = S.countries[cid];
  const isOwn = cid === y.country;
  if (!pub) return `<div class="card"><h4>${esc(cname(cid))}</h4>
    <div class="kv"><span>الرئيس</span><b>— منصب شاغر —</b></div>
    <div class="kv"><span>المواطنين</span><b>محدش هنا لسه</b></div>
    <p class="hint">الدولة دي لسه مفيهاش نشاط. أول مواطن يختارها يفتح خزينتها وحكومتها.</p></div>`;
  const myPub = S.countries[y.country] || {};
  const isPrez = isOwn && pub.president === y.name;
  const can = (...offs) => isOwn && (isPrez || offs.some(o => pub.offices && pub.offices[o] && pub.offices[o].name === y.name));
  const al = (S.alliances || []).find(a => a.members.includes(cid));
  const rel = relationTo(cid);
  const st = pub.stats || {};
  const filled = 1 + Object.keys(pub.offices || {}).length;
  let h = `<div class="card chead">
    <div class="chead-top">
      <div class="cflagbig">${esc(pub.name.slice(0, 2))}</div>
      <div class="chead-name"><h4>${esc(pub.name)}</h4><span class="hint">${rel ? `<span class="relchip ${rel[1]}">${rel[0]}</span>` : 'دولتك'}${pub.swornEnemy ? ` — عدو لدود: ${esc(cname(pub.swornEnemy))}` : ''}</span></div>
      <span class="pill">المناصب ${filled}/6</span>
    </div>
    <div class="cfacts">
      <div><span>💰 الدخل اليومي</span><b>${fmt(pub.dailyIncome)} ج</b></div>
      <div><span>⚖ الحكومة</span><b>جمهورية</b></div>
      <div><span>🤝 التحالف</span><b>${al ? esc(al.name) : '—'}</b></div>
    </div>
    <div class="ctabs">${GOV_TABS.map(([t, ic]) => `<button class="${govTab === t ? 'on' : ''}" data-gtab="${t}" type="button">${ic}</button>`).join('')}</div>
  </div>`;

  if (govTab === 'home') {
    const hd = (st.hist || []);
    const card = (label, icon, val, rk, pts, color) => `<div class="statcard">
      <span class="sc-label">${icon} ${label}</span>
      <div class="sc-mid"><b>${val}</b>${spark(pts, color)}</div>
      ${rankChip(rk)}
    </div>`;
    h += `<div class="statgrid">
      ${card('الضرر الأسبوعي', '🔥', fmt(st.weeklyDmg || 0), st.rankWeek, hd.map(x => x.dmg), '#ff7a90')}
      ${card('الأسبوعي/مواطن', '🔥', fmt(st.weeklyDmgCit || 0), st.rankWeek, hd.map(x => x.dmg), '#ffb300')}
      ${card('إجمالي الضرر', '⚔', fmt(st.totalDmg || 0), st.rankDmg, hd.map(x => x.dmg), '#b9a3ff')}
      ${card('السكان', '👥', st.pop || 0, st.rankPop, hd.map(x => x.pop), '#00e5ff')}
    </div>
    <div class="statcard wide">
      <span class="sc-label">🏗 التنمية</span>
      <div class="sc-mid"><b>${fmt(st.dev || 0)}</b>${spark(hd.map(x => x.dev), '#4dff88')}</div>
      ${rankChip(st.rankDev)}
    </div>`;
    if (pub.clogs && pub.clogs.length) h += `<div class="card ministrip"><h4>📣 آخر قرارات الدولة</h4>` +
      pub.clogs.slice(0, 5).map(l => `<div class="clogline">${esc(l.msg)}</div>`).join('') + `</div>`;
    h += `<div class="card"><h4>الأقاليم (${pub.regions.filter(r => r.owner === cid).length}/${pub.regions.length})</h4>` +
      pub.regions.map(r => `<div class="regionrow"><span>${esc(r.name)}${r.owner !== cid ? ` <span class="pill">محتل: ${esc(cname(r.owner))}</span>` : ''}${pub.resist && pub.resist[r.id] > 0 ? ` <span class="pill res">مقاومة ${Math.floor(pub.resist[r.id])}%</span>` : ''}</span><span class="hint">${r.income} ج/س</span></div>`).join('') + `</div>`;
  }

  if (govTab === 'eco') {
    h += `<div class="card"><h4>الخزينة والضرايب</h4>
      <div class="kv"><span>الخزينة</span><b>${fmt(pub.treasury)} ج</b></div>
      <div class="kv"><span>ضريبة الدخل</span><b>${pub.taxRate}%</b></div>
      <div class="kv"><span>الدخل اليومي</span><b>${fmt(pub.dailyIncome)} ج</b></div>`;
    if (can('economy')) h += `<div class="hint">غيّر الضريبة (بتتطبق على شغل المواطنين فورًا):</div>
      <div class="chips">${[0, 5, 10, 15, 20, 25, 30].map(r2 => `<button data-tax="${r2}" class="${pub.taxRate === r2 ? 'on' : ''}" type="button">${r2}%</button>`).join('')}</div>`;
    h += `</div><div class="card"><h4>ميزانية التنمية</h4><p class="hint">كل 100 ج تنمية = نقطة تطوير للدولة في الترتيب.</p>`;
    for (const r of pub.regions) {
      h += `<div class="regionrow"><span>${esc(r.name)} <span class="pill">تنمية ${fmt((pub.dev && pub.dev[r.id]) || 0)}</span></span>
        ${can('economy') && r.owner === cid ? `<span class="chips-inline"><button class="cyan" data-devfund="${esc(r.id)}:50" type="button">+50 ج</button><button class="cyan" data-devfund="${esc(r.id)}:250" type="button">+250 ج</button></span>` : ''}</div>`;
    }
    h += `</div><div class="card"><h4>حيطان الدفاع</h4>`;
    for (const r of pub.regions) {
      const wall = (pub.defenseBonus && pub.defenseBonus[r.id]) || 0;
      h += `<div class="regionrow"><span>${esc(r.name)} <span class="pill">حائط ${fmt(wall)}</span></span>
        ${can('defense', 'interior') && r.owner === cid ? `<span class="chips-inline"><button class="cyan" data-deffund="${esc(r.id)}:100" type="button">+100 ج</button><button class="cyan" data-deffund="${esc(r.id)}:500" type="button">+500 ج</button></span>` : ''}</div>`;
    }
    h += `<p class="hint">الحائط بيتحول لأرض للمدافع في أول جولة لو اتهاجم الإقليم. التكلفة بتتخصم من الخزينة قدامك قبل ما تدوس.</p></div>`;
  }

  if (govTab === 'pop') {
    h += `<div class="card"><h4>المواطنين (${pub.citizens.length})</h4>`;
    const partyOf = n => { const pt = (pub.congress.seats || []).find(pt => pt.members.includes(n)); return pt ? pt.name : null; };
    for (const n of pub.citizens) {
      const off = Object.entries(pub.offices || {}).find(([, o]) => o.name === n);
      const pt = partyOf(n);
      h += `<div class="regionrow"><span>${pub.president === n ? '👑 ' : ''}${esc(n)}
        ${off ? `<span class="pill">${OFFICES_C.find(o => o[0] === off[0])[2]}</span>` : ''}
        ${pt ? `<span class="pill albadge">${esc(pt)}</span>` : ''}</span></div>`;
    }
    h += `</div>`;
  }

  if (govTab === 'mil') {
    h += `<div class="card"><h4>🎖 ${esc(pub.unit.name)}</h4>
      <div class="kv"><span>الأعضاء</span><b>${pub.unit.members.length ? pub.unit.members.map(m => esc(m)).join('، ') : 'فاضية'}</b></div>
      <div class="kv"><span>التركيز الحالي</span><b>${pub.unit.focusWar ? 'معركة #' + pub.unit.focusWar : '—'}</b></div>`;
    if (can('staff')) {
      const warOpts = S.wars.filter(w => w.from === cid || w.to === cid).map(w => `<option value="${w.id}">#${w.id} ${esc(w.regionName || '')}</option>`).join('');
      const czOpts = pub.citizens.filter(n => !pub.unit.members.includes(n)).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      h += `<div class="row"><input type="text" id="unit-name" placeholder="اسم الوحدة"><button class="cyan" id="btn-unit-name" type="button">سمّي</button></div>`;
      if (warOpts) h += `<div class="row"><select id="unit-focus">${warOpts}</select><button class="cyan" id="btn-unit-focus" type="button">وجّه الوحدة</button></div>`;
      if (czOpts) h += `<div class="row"><select id="unit-inv">${czOpts}</select><button class="cyan" id="btn-unit-inv" type="button">ضمّ</button></div>`;
      if (pub.unit.members.length) h += `<div class="chips">${pub.unit.members.map(m => `<button data-unit-kick="${esc(m)}" type="button">اطرد ${esc(m)}</button>`).join('')}</div>`;
    }
    h += `</div><div class="card"><h4>حروب الدولة</h4>`;
    const cw = S.wars.filter(w => w.from === cid || w.to === cid);
    h += cw.length ? cw.map(w => `<div class="regionrow"><span>${esc(cname(w.from))} × ${esc(cname(w.to))} — ${esc(w.regionName || '')}</span><button class="cyan" data-open-war="${w.id}" type="button">افتح المعركة</button></div>`).join('') : '<p class="hint">لا حروب حاليًا.</p>';
    h += `</div>`;
  }

  if (govTab === 'gov') {
    h += `<div class="card"><h4>الحكومة</h4>
      <div class="ministers">
        <div class="mincard ${pub.president ? '' : 'empty'}"><span class="mi-icon">⭐</span><span class="mi-title">الرئيس</span>
          ${pub.president ? `<div class="favatar sm">${esc(pub.president[0].toUpperCase())}</div><b>${esc(pub.president)}</b>` : '<div class="favatar sm empty-slot"></div><b class="hint">شاغر</b>'}
        </div>
        ${OFFICES_C.map(([k, ic, title]) => {
          const o = (pub.offices || {})[k];
          return `<div class="mincard ${o ? '' : 'empty'}"><span class="mi-icon">${ic}</span><span class="mi-title">${title}</span>
            ${o ? `<div class="favatar sm">${esc(o.name[0].toUpperCase())}<span class="flvl">${o.level}</span></div><b>${esc(o.name)}</b>
              ${isPrez ? `<button class="mini danger" data-dismiss="${k}" type="button">إقالة</button>` : ''}` : '<div class="favatar sm empty-slot"></div><b class="hint">شاغر</b>'}
          </div>`;
        }).join('')}
      </div>`;
    if (isPrez) {
      const czOpts = pub.citizens.filter(n => n !== pub.president && !Object.values(pub.offices || {}).some(o => o.name === n)).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      if (czOpts) h += `<div class="row"><select id="appoint-office">${OFFICES_C.filter(([k]) => !(pub.offices || {})[k]).map(([k, , t]) => `<option value="${k}">${t}</option>`).join('')}</select>
        <select id="appoint-name">${czOpts}</select><button class="cyan" id="btn-appoint" type="button">عيّن</button></div>`;
    }
    h += `<div class="hint" style="margin-top:6px">${OFFICES_C.map(([k, ic, t, pw]) => `${ic} <b>${t}</b>: ${pw}`).join('<br>')}</div></div>`;

    const cg = pub.congress || { seats: [], majority: 0, total: 20 };
    h += `<div class="card"><h4>الكونجرس — الأغلبية ${cg.majority} / ${cg.total} مقعد</h4>
      <div class="majbar">${cg.seats.map(s => `<div style="width:${s.seats / cg.total * 100}%;background:${s.color}" title="${esc(s.name)}"></div>`).join('')}</div>`;
    for (const s of cg.seats) {
      h += `<div class="regionrow"><span><span class="pdot" style="background:${s.color}"></span> ${esc(s.name)}
        <span class="pav">${s.members.slice(0, 5).map(m => `<span class="favatar xs">${esc(m[0].toUpperCase())}</span>`).join('')}</span></span>
        <b>${s.seats} (${Math.round(s.seats / cg.total * 100)}%)</b></div>`;
    }
    const myParty = cg.seats.find(s => s.members.includes(y.name));
    if (isOwn) {
      h += myParty ? `<p class="hint">حزبك: «${esc(myParty.name)}»</p>` :
        `<div class="row"><input type="text" id="party-name" placeholder="اسم حزب جديد (500 ج)"><button class="cyan" id="btn-party-found" type="button">أسّس</button></div>`;
      const others = cg.seats.filter(s => !s.members.includes(y.name));
      if (others.length) h += `<div class="chips">${others.map(s => `<button data-party-join="${s.id}" type="button">انضم لـ«${esc(s.name)}»</button>`).join('')}</div>`;
    }
    h += `</div>`;

    const ele = pub.election;
    h += `<div class="card"><h4>الرئاسة</h4>
      <div class="kv"><span>الرئيس الحالي</span><b>${esc(pub.president || '— منصب شاغر —')}</b></div>`;
    if (ele && ele.closesAt) {
      const mins = Math.max(0, Math.round((ele.closesAt - Date.now()) / 60000));
      h += `<div class="kv"><span>انتخابات مفتوحة</span><b>تقفل خلال ${mins >= 60 ? Math.floor(mins / 60) + ' س ' + mins % 60 + ' د' : mins + ' دقيقة'}</b></div>`;
      for (const c of ele.candidates) {
        const votes = Object.values(ele.votes || {}).filter(v => v === c).length;
        h += `<div class="regionrow"><span>${esc(c)} <span class="pill">${votes} صوت</span></span>
          ${isOwn ? `<button class="cyan" data-vote="${esc(c)}" type="button">انتخب</button>` : ''}</div>`;
      }
      if (isOwn && !ele.candidates.includes(y.name)) h += `<button class="bigbtn" id="btn-run" type="button">رشّح نفسك</button>`;
    } else if (isOwn && pub.president !== y.name) {
      h += `<p class="hint">لو رشّحت نفسك ومفيش حد ضدك، تبقى رئيس فورًا.</p>
        <button class="bigbtn" id="btn-run" type="button">رشّح نفسك للرئاسة</button>`;
    }
    h += `</div>`;
  }

  if (govTab === 'dip') {
    const invites = (S.alliances || []).filter(a => a.pending.includes(cid));
    h += `<div class="card"><h4>التحالفات</h4>`;
    if (al) {
      h += `<div class="kv"><span>التحالف</span><b>«${esc(al.name)}»</b></div>
        <div class="kv"><span>الأعضاء</span><b>${al.members.map(m => esc(cname(m)) + (m === al.leader ? ' 👑' : '')).join('، ')}</b></div>`;
      if (al.pending.length) h += `<div class="kv"><span>دعوات مرسلة</span><b>${al.pending.map(m => esc(cname(m))).join('، ')}</b></div>`;
      if (can('foreign')) {
        const opts = (S.world || []).filter(w => w.id !== cid && !al.members.includes(w.id) && !al.pending.includes(w.id) && !(S.alliances || []).some(a => a.members.includes(w.id)))
          .map(w => `<option value="${esc(w.id)}">${esc(cname(w.id))}</option>`).join('');
        if (opts) h += `<div class="row"><select id="al-inv">${opts}</select><button class="cyan" id="btn-al-invite" type="button">ادعُ</button></div>`;
        h += `<button class="bigbtn" id="btn-al-leave" type="button" style="margin-top:8px">اخرج من التحالف</button>`;
      }
    } else {
      if (invites.length && can('foreign')) {
        for (const a of invites) h += `<div class="regionrow"><span>دعوة من «${esc(a.name)}»</span>
          <button class="cyan" data-al-accept="${a.id}" type="button">اقبل</button>
          <button data-al-decline="${a.id}" type="button">ارفض</button></div>`;
      }
      if (can('foreign')) h += `<div class="row"><input type="text" id="al-name" placeholder="اسم التحالف"><button class="cyan" id="btn-al-create" type="button">أسّس تحالف</button></div>`;
      else h += `<p class="hint">الدولة مش في تحالف.</p>`;
    }
    h += `</div><div class="card"><h4>العدو اللدود</h4>
      <div class="kv"><span>الحالي</span><b>${pub.swornEnemy ? esc(cname(pub.swornEnemy)) : '—'}</b></div>`;
    if (can('foreign')) {
      const opts = (S.world || []).filter(w => w.id !== cid).map(w => `<option value="${esc(w.id)}">${esc(cname(w.id))}</option>`).join('');
      h += `<div class="row"><select id="enemy-sel">${opts}</select><button class="danger" id="btn-enemy" type="button">أعلن عدوًا لدودًا</button></div>
        ${pub.swornEnemy ? '<button id="btn-enemy-clear" type="button">اسحب الإعلان</button>' : ''}`;
    }
    h += `</div><div class="card"><h4>السلام</h4>`;
    const cw = S.wars.filter(w => w.from === cid || w.to === cid);
    h += cw.length && can('foreign') ? cw.map(w => `<div class="regionrow"><span>حرب ${esc(w.regionName || '')}</span><button class="cyan" data-peace="${w.id}" type="button">اعرض / اقبل السلام</button></div>`).join('')
      : '<p class="hint">' + (cw.length ? 'حروب جارية — قرارات السلام للرئيس أو وزير الخارجية.' : 'لا حروب حاليًا.') + '</p>';
    h += `</div>`;
  }

  if (isOwn) h += `<div class="card"><h4>منطقة المالك</h4>
    <p class="hint">لو انت صاحب اللعبة وحسابك مش واخد الإدارة: اكتب كود المالك هنا.</p>
    <div class="row"><input type="text" id="claim-secret" placeholder="كود المالك (ADMIN_SECRET)"><button class="cyan" id="btn-claim" type="button">استلم الملكية</button></div>
  </div>`;
  return h;
}

function bindGovActions(el) {
  const y = S.you;
  const run = $('#btn-run');
  if (run) run.onclick = async () => { try { await api('/api/run'); flash('تم', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const claim = $('#btn-claim');
  if (claim) claim.onclick = async () => { try { await api('/api/claim', { secret: $('#claim-secret').value }); flash('انت المالك دلوقتي ★', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  el.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    try { await api('/api/vote', { candidate: b.dataset.vote }); flash('صوتك اتحسب', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-tax]').forEach(b => b.onclick = async () => {
    try { await api('/api/country/tax', { rate: Number(b.dataset.tax) }); flash('الضريبة اتغيرت لـ ' + b.dataset.tax + '%', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-devfund]').forEach(b => b.onclick = async () => {
    const [regionId, amount] = b.dataset.devfund.split(':');
    try { await api('/api/country/devfund', { regionId, amount: Number(amount) }); flash(`اتخصص ${amount} ج للتنمية`, 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-deffund]').forEach(b => b.onclick = async () => {
    const [regionId, amount] = b.dataset.deffund.split(':');
    try { await api('/api/defense', { regionId, amount: Number(amount) }); flash(`الحائط اتموّل بـ ${amount} ج`, 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-dismiss]').forEach(b => b.onclick = async () => {
    try { await api('/api/country/dismiss', { office: b.dataset.dismiss }); flash('اتقال', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  const ap = $('#btn-appoint');
  if (ap) ap.onclick = async () => {
    try { await api('/api/country/appoint', { office: $('#appoint-office').value, name: $('#appoint-name').value }); flash('اتعيّن', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  const pf = $('#btn-party-found');
  if (pf) pf.onclick = async () => { try { await api('/api/party/found', { name: $('#party-name').value }); flash('الحزب اتأسس', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  el.querySelectorAll('[data-party-join]').forEach(b => b.onclick = async () => {
    try { await api('/api/party/join', { partyId: Number(b.dataset.partyJoin) }); flash('انضممت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  const un = $('#btn-unit-name');
  if (un) un.onclick = async () => { try { await api('/api/unit/name', { name: $('#unit-name').value }); flash('اتسمت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const uf = $('#btn-unit-focus');
  if (uf) uf.onclick = async () => { try { await api('/api/unit/focus', { warId: Number($('#unit-focus').value) }); flash('الوحدة اتحجزت على المعركة', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const ui = $('#btn-unit-inv');
  if (ui) ui.onclick = async () => { try { await api('/api/unit/invite', { name: $('#unit-inv').value }); flash('اتضمّ', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  el.querySelectorAll('[data-unit-kick]').forEach(b => b.onclick = async () => {
    try { await api('/api/unit/kick', { name: b.dataset.unitKick }); flash('اتطرد', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-open-war]').forEach(b => b.onclick = () => { battleView = Number(b.dataset.openWar); curTab = 'war'; render(true); });
  const en = $('#btn-enemy');
  if (en) en.onclick = async () => { try { await api('/api/country/enemy', { country: $('#enemy-sel').value }); flash('اتعلن العدو اللدود', 'dmg'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const enc = $('#btn-enemy-clear');
  if (enc) enc.onclick = async () => { try { await api('/api/country/enemy', { country: '' }); flash('اتسحب الإعلان', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  el.querySelectorAll('[data-peace]').forEach(b => b.onclick = async () => {
    try { const d = await api('/api/war/peace', { warId: Number(b.dataset.peace) }); flash(d.peace ? 'تم السلام!' : 'عرض السلام اتبعت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  const alCreate = $('#btn-al-create');
  if (alCreate) alCreate.onclick = async () => { try { await api('/api/alliance/create', { name: $('#al-name').value }); flash('التحالف اتأسس', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const alInv = $('#btn-al-invite');
  if (alInv) alInv.onclick = async () => { try { await api('/api/alliance/invite', { country: $('#al-inv').value }); flash('الدعوة اتبعتت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  const alLeave = $('#btn-al-leave');
  if (alLeave) alLeave.onclick = async () => { try { await api('/api/alliance/leave'); flash('خرجت من التحالف', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
  el.querySelectorAll('[data-al-accept]').forEach(b => b.onclick = async () => {
    try { await api('/api/alliance/accept', { id: b.dataset.alAccept }); flash('انضممت للتحالف', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  el.querySelectorAll('[data-al-decline]').forEach(b => b.onclick = async () => {
    try { await api('/api/alliance/decline', { id: b.dataset.alDecline }); flash('رفضت الدعوة', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
}

/* --- admin tab --- */
function renderAdmin() {
  const el = $('#tab-admin'), y = S.you;
  if (!y.admin) { el.innerHTML = ''; return; }
  const countryOpts = Object.entries(MAP.defs).map(([id, d]) => `<option value="${esc(id)}">${esc(d.name)}</option>`).join('');
  const regionOpts = Object.entries(MAP.defs).flatMap(([id, d]) => d.regions.map(r => `<option value="${esc(r.id)}">${esc(d.name)} — ${esc(r.name)}</option>`)).join('');
  el.innerHTML = `<div class="card"><h4>لوحة الإدارة — حسابك بس</h4>
    <div class="kv"><span>سرعة العالم</span><b>×${S.speed}</b></div>
    <div class="row"><input type="number" id="adm-speed" placeholder="0.1 إلى 100" step="0.5" min="0.1" max="100"><button id="adm-speed-go" type="button">غيّر</button></div>
  </div>
  <div class="card"><h4>نسخة احتياطية من العالم</h4>
    <p class="hint">نزّل ملف فيه كل حالة العالم — اعملها كل فترة لو السيرفر اتمسح.</p>
    <button id="adm-export" type="button" style="width:100%">نزّل نسخة من العالم</button>
  </div>
  <div class="card"><h4>كود الغش السريع</h4>
    <div class="row"><input type="text" id="adm-cheat" placeholder="الكود"><button class="cyan" id="adm-cheat-go" type="button">نفّذ</button></div>
    <p class="hint">يديك 100k فلوس + ذخيرة وأكل وبارات مليانة. الكود: raad raad</p>
  </div>
  <div class="card"><h4>امنح لاعب</h4>
    <input type="text" id="adm-give-name" placeholder="اسم اللاعب">
    <input type="number" id="adm-give-money" placeholder="فلوس">
    <div class="row"><button id="adm-give-go" type="button">امنح فلوس</button><button class="cyan" id="adm-give-bars" type="button">املأ باراته</button></div>
  </div>
  <div class="card"><h4>نقل ملكية إقليم</h4>
    <select id="adm-region">${regionOpts}</select>
    <select id="adm-region-to">${countryOpts}</select>
    <button id="adm-region-go" type="button" style="width:100%">انقل الملكية</button>
  </div>
  <div class="card"><h4>الرؤساء</h4>
    <select id="adm-prez-country">${countryOpts}</select>
    <input type="text" id="adm-prez-name" placeholder="اسم اللاعب">
    <div class="row"><button id="adm-prez-go" type="button">عيّن رئيس</button><button class="danger" id="adm-prez-del" type="button">أزل الرئيس</button></div>
  </div>
  <div class="card"><h4>طرد لاعب</h4>
    <div class="row"><input type="text" id="adm-kick-name" placeholder="اسم اللاعب"><button class="danger" id="adm-kick-go" type="button">اطرده</button></div>
  </div>
  <div class="card"><h4>إعلان حرب إداري</h4>
    <select id="adm-war-from">${countryOpts}</select>
    <select id="adm-war-to">${countryOpts}</select>
    <button class="danger" id="adm-war-go" type="button" style="width:100%">أعلن الحرب على عاصمة الهدف</button>
  </div>`;
  const go = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  const val = id => $(id).value;
  go('#adm-export', () => { window.open('/api/admin/export?token=' + encodeURIComponent(token), '_blank'); });
  go('#adm-speed-go', async () => { try { await api('/api/admin/speed', { speed: Number(val('#adm-speed')) }); flash('اتغيّرت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-cheat-go', async () => { try { await api('/api/cheat', { code: val('#adm-cheat') }); flash('اتنفّذ', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-give-go', async () => { try { await api('/api/admin/give', { name: val('#adm-give-name'), money: Number(val('#adm-give-money')) }); flash('اتبعت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-give-bars', async () => { try { await api('/api/admin/give', { name: val('#adm-give-name'), bars: true }); flash('اتملّت', 'good'); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-region-go', async () => { try { await api('/api/admin/region', { regionId: val('#adm-region'), to: val('#adm-region-to') }); flash('اتنقلت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-prez-go', async () => { try { await api('/api/admin/president', { country: val('#adm-prez-country'), name: val('#adm-prez-name') }); flash('اتعيّن', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-prez-del', async () => { try { await api('/api/admin/president', { country: val('#adm-prez-country'), name: '' }); flash('اتشال', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-kick-go', async () => { try { await api('/api/admin/kick', { name: val('#adm-kick-name') }); flash('اتطرد', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } });
  go('#adm-war-go', async () => {
    const to = val('#adm-war-to');
    try { await api('/api/admin/war', { from: val('#adm-war-from'), to, regionId: MAP.defs[to].regions[0].id }); flash('أُعلنت الحرب', 'dmg'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
}

/* ---------- polling ---------- */
let refreshing = false;
async function refresh() {
  if (refreshing || $('#game').classList.contains('hidden')) return;
  refreshing = true;
  try { S = await api('/api/state'); stampVersion(S.version); detectFlips(); render(); } catch {}
  refreshing = false;
}
setInterval(refresh, 3000);

/* ---------- version footer + self-healing refresh ---------- */
function stampVersion(sv) {
  let el = document.getElementById('verstamp');
  if (!el) { el = document.createElement('div'); el.id = 'verstamp'; document.body.appendChild(el); }
  el.textContent = 'v' + CLIENT_VERSION + (sv && sv !== CLIENT_VERSION ? ' — في تحديث جديد، بحدّث...' : '');
  if (sv && sv !== CLIENT_VERSION && !sessionStorage.getItem('ver_reload')) {
    sessionStorage.setItem('ver_reload', '1');
    setTimeout(() => location.reload(true), 800);
  }
}

/* ---------- start ---------- */
const qp = new URLSearchParams(location.search);
if (qp.get('token')) { token = qp.get('token'); localStorage.setItem('raad_token', token); }
if (qp.get('tab')) curTab = qp.get('tab');
if (qp.get('battle')) battleView = Number(qp.get('battle'));
if (qp.get('ranks')) ranksOpen = true;
if (qp.get('mk')) mktTab = qp.get('mk');
if (qp.get('gmode')) govMode = qp.get('gmode');
if (qp.get('gcountry')) { govMode = 'country'; govCid = qp.get('gcountry'); }
if (qp.get('gtab')) govTab = qp.get('gtab');
if (qp.get('selc')) selCountry = qp.get('selc');
if (qp.get('mmode')) mapMode = qp.get('mmode');
if (token) boot(); else show('auth');
