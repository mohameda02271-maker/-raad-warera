'use strict';
/* رعد RAAD — client. Full-bleed world map, sheets over it, live feed. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let token = localStorage.getItem('raad_token') || '';
let S = null, MAP = null;
let selCountry = null;
let battle = { warId: null, ammo: 'none' };
let curTab = 'map';
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
const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n);
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
  const apply = () => { const s = svg(); if (s) s.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.k})`; };
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
function updateMapColors(stageEl) {
  if (!S || !MAP) return;
  const alMap = {};
  (S.alliances || []).forEach((a, i) => a.members.forEach(m => { alMap[m] = i; }));
  stageEl.querySelectorAll('path').forEach(p => {
    const c = p.dataset.c;
    const pub = S.countries[c];
    let cl = '';
    if (S.you && S.you.country === c) cl = 'own';
    else if (pub && pub.wars && pub.wars.length) cl = 'war';
    else if (pub && pub.citizens && pub.citizens.length) cl = 'cit';
    if (selCountry === c) cl += ' sel';
    if (p.className.baseVal !== cl) p.className.baseVal = cl;
    const ai = alMap[c];
    const stroke = ai !== undefined ? ALLY_COLORS[ai % ALLY_COLORS.length] : '';
    if (p.style.stroke !== stroke) { p.style.stroke = stroke; p.style.strokeWidth = stroke ? '1.6' : ''; }
  });
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
  if (!S.you.country) { buildPick(); show('pick'); return; }
  if (!$('#stage svg')) {
    $('#stage').innerHTML = mapSVG();
    makePannable($('#stage'), c => { selCountry = selCountry === c ? null : c; render(true); });
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
    case 'war': return JSON.stringify([S.wars, y.ammo, y.goods, battle]);
    case 'gov': { const c = S.countries[y.country] || {}; return JSON.stringify([c.president, c.election, c.treasury, S.alliances]); }
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
  $('#war-dot').classList.toggle('hidden', !S.wars.some(w => w.from === y.country || w.to === y.country));
  $('#bars').innerHTML =
    bar('صحة', y.bars.health, y.barMax.health, 'health') + bar('جوع', y.bars.hunger, y.barMax.hunger, 'hunger') +
    bar('طاقة', y.bars.energy, y.barMax.energy, 'energy') + bar('XP', y.xp, y.levelXp, 'xp');

  /* dock + sheet visibility */
  [...$('#dock').children].forEach(x => x.classList.toggle('on', x.dataset.tab === curTab));
  const sheetOpen = curTab !== 'map' || !!selCountry;
  $('#sheet').classList.toggle('hidden', !sheetOpen);
  ['map', 'home', 'war', 'gov', 'admin'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== curTab));

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
  el.innerHTML = h + '</div>';
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
  <h3>المهمات <span class="pill">دي أسرع طريق للفلوس واللفل ونقاط المهارة — اليومية بتتصفّر كل يوم</span></h3>
  ${(S.missions || []).filter(m => m.daily).map(mrow).join('')}
  <h3 style="border:none;color:var(--cyan);font-size:13px">مهمات طويلة</h3>
  ${(S.missions || []).filter(m => !m.daily).map(mrow).join('')}
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
    return `<div class="skillrow"><span>${m.name}${m.daily ? ' <span class="pill">يومية</span>' : ''}<span class="lvl">${pr}/${m.target}</span><br><small class="have">مكافأة: ${m.reward.money} ج + ${m.reward.xp} XP + ${m.reward.sp} نقطة مهارة</small></span>
      ${m.done ? '<span class="pill" style="color:var(--green)">اتعملت ✓</span>' : `<div class="track" style="min-width:90px;align-self:center"><div class="fill xp" style="width:${pct(m.progress, m.target)}%"></div></div>`}</div>`;
  }
  function skillRow(s) {
    const lvl = y.skills[s.id] || 0;
    return `<div class="skillrow"><span>${s.name}<span class="lvl">${lvl}/${sh.skillMax}</span></span>
      <button data-skill="${s.id}" ${lvl >= sh.skillMax || y.skillPoints < lvl + 1 ? 'disabled' : ''} type="button">+${lvl + 1} نقطة</button></div>`;
  }
  $('#btn-work').onclick = async () => { try { await api('/api/work'); flash('اشتغلت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); } };
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

/* --- war tab --- */
function renderWar() {
  const el = $('#tab-war'), y = S.you, sh = S.shop;
  const myPub = S.countries[y.country] || {};
  const isPrez = myPub.president === y.name;
  const myAl = (S.alliances || []).find(a => a.members.includes(y.country));
  const inWar = w => w.from === y.country || w.to === y.country ||
    (w.alliesCalled && myAl && (myAl.members.includes(w.from) || myAl.members.includes(w.to)));
  const myWars = S.wars.filter(inWar);
  const otherWars = S.wars.filter(w => !inWar(w));
  let h = '';
  if (!S.wars.length) h = '<p class="hint" style="margin-top:14px">لا حروب حاليًا. الرئيس يقدر يعلن حرب على إقليم تابع لدولة جارة — اضغط على الدولة في الخريطة.</p>';
  for (const w of myWars) {
    const atkName = MAP.defs[w.from] ? MAP.defs[w.from].name : w.from;
    const defName = MAP.defs[w.to] ? MAP.defs[w.to].name : w.to;
    const mins = Math.max(0, Math.round((w.endsAt - Date.now()) / 60000));
    h += `<div class="card"><h4>حرب: ${esc(atkName)} × ${esc(defName)} — ${esc(w.regionName || '')}</h4>
      <div class="kv"><span>الوقت المتبقي</span><b>${mins >= 60 ? Math.floor(mins / 60) + ' س ' + mins % 60 + ' د' : mins + ' دقيقة'}</b></div>
      <div class="wall">
        <div class="lbl"><span>هجوم ${esc(atkName)}</span><b dir="ltr">${fmt(w.attDmg)} / ${fmt(w.threshold)}</b></div>
        <div class="track"><div class="fill wallA" style="width:${Math.min(100, w.attDmg / w.threshold * 100)}%"></div></div>
        <div class="lbl" style="margin-top:6px"><span>دفاع ${esc(defName)}</span><b>${fmt(w.defDmg)}</b></div>
        <div class="track"><div class="fill wallB" style="width:${w.attDmg ? Math.min(100, w.defDmg / w.attDmg * 100) : 0}%"></div></div>
      </div>
      <div class="amnoselect">
        ${['none', 'light', 'mid', 'heavy'].map(k => `<button data-ammo="${k}" data-w="${w.id}" class="${battle.warId === w.id && battle.ammo === k ? 'on' : ''}" type="button">${k === 'none' ? 'بدون' : S.shop.ammos[k].name + ' (' + fmt(y.ammo[k] || 0) + ')'}</button>`).join('')}
      </div>
      <button class="bigbtn hitbtn" data-hit="${w.id}" type="button">اضرب!</button>
      <div class="amnoselect" style="margin-top:8px">
        <button data-supply="iron:${w.id}" type="button">زوّد بـ${sh.supply.iron.amount} حديد (+${sh.supply.iron.points}) — عندك ${fmt(y.goods.iron)}</button>
        <button data-supply="heavy:${w.id}" type="button">زوّد بـ${sh.supply.heavy.amount} ثقيلة (+${sh.supply.heavy.points}) — عندك ${fmt(y.ammo.heavy || 0)}</button>
        ${w.alliesCalled ? '<button disabled type="button">الحلفاء في الحرب معاك</button>' : (isPrez && myAl && myAl.members.length > 1 ? `<button class="cyan" data-alcall="${w.id}" type="button">نادِ حلفاء «${esc(myAl.name)}»</button>` : '')}
      </div>
    </div>`;
  }
  for (const w of otherWars) {
    h += `<div class="card"><h4>حرب بعيدة: ${esc(MAP.defs[w.from] ? MAP.defs[w.from].name : w.from)} × ${esc(MAP.defs[w.to] ? MAP.defs[w.to].name : w.to)}</h4>
      <div class="kv"><span>هجوم</span><b>${fmt(w.attDmg)}</b></div><div class="kv"><span>دفاع</span><b>${fmt(w.defDmg)}</b></div></div>`;
  }
  el.innerHTML = h;
  if (!myWars.find(w => w.id === battle.warId)) battle = { warId: myWars[0] ? myWars[0].id : null, ammo: battle.ammo };
  el.querySelectorAll('[data-ammo]').forEach(b => b.onclick = () => { battle = { warId: Number(b.dataset.w), ammo: b.dataset.ammo }; renderWar(); });
  el.querySelectorAll('[data-alcall]').forEach(b => b.onclick = async () => {
    try { await api('/api/alliance/call', { warId: Number(b.dataset.alcall) }); flash('الحلفاء اتحشدوا', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
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
function renderGov() {
  const el = $('#tab-gov'), y = S.you;
  const pub = S.countries[y.country] || {};
  const ele = pub.election;
  let h = `<div class="card"><h4>رئاسة ${esc(pub.name || '')}</h4>
    <div class="kv"><span>الرئيس الحالي</span><b>${esc(pub.president || '— منصب شاغر —')}</b></div>`;
  if (ele && ele.closesAt) {
    const mins = Math.max(0, Math.round((ele.closesAt - Date.now()) / 60000));
    h += `<div class="kv"><span>انتخابات مفتوحة</span><b>تقفل خلال ${mins >= 60 ? Math.floor(mins / 60) + ' س ' + mins % 60 + ' د' : mins + ' دقيقة'}</b></div>`;
    for (const c of ele.candidates) {
      const votes = Object.values(ele.votes || {}).filter(v => v === c).length;
      h += `<div class="regionrow"><span>${esc(c)} <span class="pill">${votes} صوت</span></span>
        <button class="cyan" data-vote="${esc(c)}" type="button">انتخب</button></div>`;
    }
    if (!ele.candidates.includes(y.name)) h += `<button class="bigbtn" id="btn-run" type="button">رشّح نفسك</button>`;
  } else if (pub.president !== y.name) {
    h += `<p class="hint">لو رشّحت نفسك ومفيش حد ضدك، تبقى رئيس فورًا.</p>
      <button class="bigbtn" id="btn-run" type="button">رشّح نفسك للرئاسة</button>`;
  }
  h += `<h3>صلاحيات الرئيس</h3><p class="hint">يعلن حرب على أقاليم الدول الجارة (من الخريطة) — يحصّن أقاليم دولته بفلوس الخزينة — الخزينة بتتجمع من ضريبة شغل المواطنين.</p></div>`;

  /* alliances */
  const isPrez = pub.president === y.name;
  const myAl = (S.alliances || []).find(a => a.members.includes(y.country));
  const invites = (S.alliances || []).filter(a => a.pending.includes(y.country));
  h += `<div class="card"><h4>التحالفات</h4>`;
  if (myAl) {
    h += `<div class="kv"><span>تحالفك</span><b>«${esc(myAl.name)}»</b></div>
      <div class="kv"><span>الأعضاء</span><b>${myAl.members.map(m => esc(MAP.defs[m] ? MAP.defs[m].name : m) + (m === myAl.leader ? ' 👑' : '')).join('، ')}</b></div>`;
    if (myAl.pending.length) h += `<div class="kv"><span>دعوات مرسلة</span><b>${myAl.pending.map(m => esc(MAP.defs[m] ? MAP.defs[m].name : m)).join('، ')}</b></div>`;
    if (isPrez) {
      const opts = Object.keys(S.countries).filter(c => c !== y.country && !myAl.members.includes(c) && !myAl.pending.includes(c) && !(S.alliances || []).some(a => a.members.includes(c)))
        .map(c => `<option value="${esc(c)}">${esc(MAP.defs[c] ? MAP.defs[c].name : c)}</option>`).join('');
      if (opts) h += `<div class="row"><select id="al-inv">${opts}</select><button class="cyan" id="btn-al-invite" type="button">ادعُ</button></div>`;
      h += `<button class="bigbtn" id="btn-al-leave" type="button" style="margin-top:8px">اخرج من التحالف</button>`;
    }
    h += `<p class="hint">لون دول التحالف على الخريطة واحد — والرئيس يقدر ينادي الحلفاء لأي حرب من تاب الحرب.</p>`;
  } else {
    if (invites.length && isPrez) {
      for (const a of invites) h += `<div class="regionrow"><span>دعوة من «${esc(a.name)}»</span>
        <button class="cyan" data-al-accept="${a.id}" type="button">اقبل</button>
        <button data-al-decline="${a.id}" type="button">ارفض</button></div>`;
    }
    if (isPrez) h += `<div class="row"><input type="text" id="al-name" placeholder="اسم التحالف"><button class="cyan" id="btn-al-create" type="button">أسّس تحالف</button></div>`;
    else h += `<p class="hint">دولتك مش في تحالف. الرئيس هو اللي يقدر يأسس أو يقبل دعوات.</p>`;
  }
  h += `</div>`;
  h += `<div class="card"><h4>منطقة المالك</h4>
    <p class="hint">لو انت صاحب اللعبة وحسابك مش واخد الإدارة (حصل لما اتنقلنا لنظام كود المالك): اكتب كود المالك هنا وحسابك يبقى الأدمن — من غير مسح أي حاجة.</p>
    <div class="row"><input type="text" id="claim-secret" placeholder="كود المالك (ADMIN_SECRET)"><button class="cyan" id="btn-claim" type="button">استلم الملكية</button></div>
  </div>`;
  el.innerHTML = h;
  const run = $('#btn-run');
  if (run) run.onclick = async () => {
    try { await api('/api/run'); flash('تم', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  const claim = $('#btn-claim');
  if (claim) claim.onclick = async () => {
    try { await api('/api/claim', { secret: $('#claim-secret').value }); flash('انت المالك دلوقتي ★', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  el.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    try { await api('/api/vote', { candidate: b.dataset.vote }); flash('صوتك اتحسب', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  });
  const alCreate = $('#btn-al-create');
  if (alCreate) alCreate.onclick = async () => {
    try { await api('/api/alliance/create', { name: $('#al-name').value }); flash('التحالف اتأسس', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  const alInv = $('#btn-al-invite');
  if (alInv) alInv.onclick = async () => {
    try { await api('/api/alliance/invite', { country: $('#al-inv').value }); flash('الدعوة اتبعتت', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  const alLeave = $('#btn-al-leave');
  if (alLeave) alLeave.onclick = async () => {
    try { await api('/api/alliance/leave'); flash('خرجت من التحالف', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
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
  try { S = await api('/api/state'); detectFlips(); render(); } catch {}
  refreshing = false;
}
setInterval(refresh, 3000);

/* ---------- start ---------- */
const qp = new URLSearchParams(location.search);
if (qp.get('token')) { token = qp.get('token'); localStorage.setItem('raad_token', token); }
if (qp.get('tab')) curTab = qp.get('tab');
if (token) boot(); else show('auth');
