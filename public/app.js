'use strict';
/* رعد RAAD — client. Plain JS against the game server. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let token = localStorage.getItem('raad_token') || '';
let S = null, MAP = null;
let selCountry = null;
let battle = { warId: null, ammo: 'none' };
let curTab = 'map';

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    body: body ? JSON.stringify(body) : '{}'
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'خطأ');
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

/* ---------- auth ---------- */
$('#btn-register').onclick = () => auth('register');
$('#btn-login').onclick = () => auth('login');
async function auth(kind) {
  $('#auth-err').textContent = '';
  try {
    const d = await api('/api/' + kind, { name: $('#auth-name').value.trim(), pass: $('#auth-pass').value });
    token = d.token; localStorage.setItem('raad_token', token);
    await boot();
  } catch (e) { $('#auth-err').textContent = e.message; }
}

/* ---------- boot ---------- */
async function boot() {
  if (!MAP) MAP = await apiGet('/api/mapdata');
  try { S = await api('/api/state'); } catch { token = ''; localStorage.removeItem('raad_token'); show('auth'); return; }
  if (!S.you.country) { selCountry = null; buildPickMap(); show('pick'); return; }
  $('#btn-tab-admin').classList.toggle('hidden', !S.you.admin);
  show('game');
  render();
}

/* ---------- world map ---------- */
function mapSVG() {
  let h = `<svg viewBox="0 0 1000 520" xmlns="http://www.w3.org/2000/svg">`;
  for (const [name, path] of Object.entries(MAP.paths)) {
    const c = S && S.countries && S.countries[name];
    let cl = '';
    if (S && S.you && S.you.country === name) cl = 'own';
    else if (c && c.wars && c.wars.length) cl = 'war';
    if (selCountry === name) cl = 'sel';
    h += `<path d="${path}" data-c="${esc(name)}" class="${cl}"></path>`;
  }
  return h + '</svg>';
}
function wireMap(el, onPick) {
  el.addEventListener('click', e => {
    const t = e.target.closest('path'); if (!t) return;
    onPick(t.dataset.c);
  });
}
function buildPickMap() {
  $('#pick-map').innerHTML = mapSVG();
  wireMap($('#pick-map'), async c => {
    if (selCountry === c) {
      try { await api('/api/country', { country: c }); boot(); } catch (err) { flash(err.message, 'miss'); }
      return;
    }
    selCountry = c; $('#pick-map').innerHTML = mapSVG();
    $('#pick-name').textContent = (MAP.defs[c] ? MAP.defs[c].name : c) + ' — اضغط تاني للتأكيد';
  });
}

/* ---------- tabs ---------- */
$('#tabs').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  curTab = b.dataset.tab;
  [...$('#tabs').children].forEach(x => x.classList.toggle('on', x === b));
  ['map', 'home', 'war', 'gov', 'admin'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== curTab));
  render();
};

/* ---------- render ---------- */
function render() {
  if (!S || !S.you.country) return;
  [...$('#tabs').children].forEach(x => x.classList.toggle('on', x.dataset.tab === curTab));
  ['map', 'home', 'war', 'gov', 'admin'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== curTab));
  const y = S.you;
  const myPub = S.countries[y.country] || {};
  const isPrez = myPub.president === y.name;

  $('#me-name').textContent = y.name + (y.admin ? ' ★' : '') + (isPrez ? ' 👑' : '');
  $('#me-country').textContent = myPub.name || y.country;
  $('#me-money').textContent = fmt(y.money);
  $('#me-level').textContent = y.level;
  $('#me-rank').textContent = '+' + Math.round(y.rankBonus * 100) + '%';
  $('#war-dot').classList.toggle('hidden', !S.wars.some(w => w.from === y.country || w.to === y.country));

  const xpBase = 50 * y.level * (y.level - 1);
  $('#bars').innerHTML =
    bar('صحة', y.bars.health, y.barMax.health, 'health') + bar('جوع', y.bars.hunger, y.barMax.hunger, 'hunger') +
    bar('طاقة', y.bars.energy, y.barMax.energy, 'energy') +
    bar('مستوى ' + y.level, y.xp - xpBase, y.levelXp, 'xp');

  if (curTab === 'map') renderMap();
  else if (curTab === 'home') renderHome();
  else if (curTab === 'war') renderWar();
  else if (curTab === 'gov') renderGov();
  else if (curTab === 'admin') renderAdmin();
  renderLog();
}
function bar(label, c, m, cls) {
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${pct(c, m)}%"></div></div><span class="val">${fmt(c)}/${m}</span></div>`;
}

/* --- map tab --- */
function renderMap() {
  const el = $('#tab-map');
  el.innerHTML = `<div class="mapwrap">${mapSVG()}</div><div id="cpanel"></div>`;
  wireMap(el.querySelector('.mapwrap'), c => { selCountry = c; render(); });
  const cp = $('#cpanel');
  if (!selCountry || !MAP.defs[selCountry]) {
    cp.innerHTML = `<p class="hint" style="margin-top:10px">اضغط على دولة — البنفسجي دولتك، الأحمر دولة في حرب.</p>`;
    return;
  }
  const iso = selCountry;
  const def = MAP.defs[iso];
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
  cp.innerHTML = h + '</div>';
  cp.querySelectorAll('[data-war]').forEach(b => b.onclick = async () => {
    try { await api('/api/war', { regionId: b.dataset.war }); flash('أُعلنت الحرب!', 'dmg'); refresh(); }
    catch (e) { flash(e.message, 'miss'); }
  });
  cp.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => {
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
  <h3>الأكل <span class="pill">الأكل بيعالج الصحة وبياخد 1 جوع</span></h3>
  <div class="grid3">${Object.entries(sh.foods).map(([k, f]) =>
    `<div class="shopitem">${f.name} <span class="have">(+${f.heal} صحة)</span><b>${f.price} ج</b><span class="have">عندك: ${y.foods[k] || 0}</span>
     <button data-buy="food:${k}" type="button">اشتري</button>
     <button class="cyan" data-eat="${k}" type="button">كل</button></div>`).join('')}</div>
  <h3>الذخيرة</h3>
  <div class="grid3">${Object.entries(sh.ammos).map(([k, a]) =>
    `<div class="shopitem">${a.name}<b>${a.price} ج</b><span class="have">عندك: ${y.ammo[k] || 0}</span><button data-buy="ammo:${k}" type="button">اشتري</button></div>`).join('')}</div>
  <h3>السلاح <span class="pill">الحالي: ${esc(wName)}</span></h3>
  <div class="grid3">${sh.weapons.map((w, i) => i <= y.weapon ? '' :
    `<div class="shopitem">${w.name} <span class="have">(هجوم ${w.atk} — كريت ${w.crit}%)</span><b>${w.price} ج</b><button data-buy="weapon:${i}" type="button">اشتري</button></div>`).join('')}</div>
  <h3>الدرع <span class="pill">الحالي: ${esc(aName)}</span></h3>
  <div class="grid3">${sh.armors.map((a, i) => i <= y.armorGear ? '' :
    `<div class="shopitem">${a.name} <span class="have">(امتصاص ${a.armor}%)</span><b>${a.price} ج</b><button data-buy="armor:${i}" type="button">اشتري</button></div>`).join('')}</div>
  <h3>المهارات <span class="pill">نقاط متاحة: <b>${y.skillPoints}</b></span></h3>
  <h3 style="border:none;color:var(--red);font-size:13px">شجرة الحرب</h3>
  ${sh.skills.filter(s => s.side === 'war').map(skillRow).join('')}
  <h3 style="border:none;color:var(--green);font-size:13px">شجرة الاقتصاد</h3>
  ${sh.skills.filter(s => s.side === 'eco').map(skillRow).join('')}`;
  $('#tab-home').innerHTML = h;

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
}

/* --- war tab --- */
function renderWar() {
  const el = $('#tab-war'), y = S.you;
  const myWars = S.wars.filter(w => w.from === y.country || w.to === y.country);
  const otherWars = S.wars.filter(w => !(w.from === y.country || w.to === y.country));
  let h = '';
  if (!S.wars.length) h = '<p class="hint">لا حروب حاليًا. الرئيس يقدر يعلن حرب على إقليم تابع لدولة جارة من صفحة الخريطة.</p>';
  for (const w of myWars) {
    const atkName = MAP.defs[w.from] ? MAP.defs[w.from].name : w.from;
    const defName = MAP.defs[w.to] ? MAP.defs[w.to].name : w.to;
    const mins = Math.max(0, Math.round((w.endsAt - Date.now()) / 60000));
    h += `<div class="card"><h4>حرب: ${esc(atkName)} × ${esc(defName)} — ${esc(w.regionName || '')}</h4>
      <div class="kv"><span>الوقت المتبقي</span><b>${mins >= 60 ? Math.floor(mins / 60) + ' س ' + mins % 60 + ' د' : mins + ' دقيقة'}</b></div>
      <div class="wall">
        <div class="lbl"><span>هجوم ${esc(atkName)}</span><b>${fmt(w.attDmg)} / ${fmt(w.threshold)}</b></div>
        <div class="track" style="height:14px;background:var(--panel2);border-radius:999px;overflow:hidden;border:1px solid var(--line)"><div class="fill wallA" style="width:${Math.min(100, w.attDmg / w.threshold * 100)}%"></div></div>
        <div class="lbl" style="margin-top:6px"><span>دفاع ${esc(defName)}</span><b>${fmt(w.defDmg)}</b></div>
        <div class="track" style="height:14px;background:var(--panel2);border-radius:999px;overflow:hidden;border:1px solid var(--line)"><div class="fill wallB" style="width:${w.attDmg ? Math.min(100, w.defDmg / w.attDmg * 100) : 0}%"></div></div>
      </div>
      <div class="amnoselect">
        ${['none', 'light', 'mid', 'heavy'].map(k => `<button data-ammo="${k}" data-w="${w.id}" class="${battle.warId === w.id && battle.ammo === k ? 'on' : ''}" type="button">${k === 'none' ? 'بدون' : S.shop.ammos[k].name + ' (' + (y.ammo[k] || 0) + ')'}</button>`).join('')}
      </div>
      <button class="bigbtn hitbtn" data-hit="${w.id}" type="button">اضرب!</button>
    </div>`;
  }
  for (const w of otherWars) {
    h += `<div class="card"><h4>حرب بعيدة: ${esc(MAP.defs[w.from] ? MAP.defs[w.from].name : w.from)} × ${esc(MAP.defs[w.to] ? MAP.defs[w.to].name : w.to)}</h4>
      <div class="kv"><span>هجوم</span><b>${fmt(w.attDmg)}</b></div><div class="kv"><span>دفاع</span><b>${fmt(w.defDmg)}</b></div></div>`;
  }
  el.innerHTML = h;
  if (!myWars.find(w => w.id === battle.warId)) battle = { warId: myWars[0] ? myWars[0].id : null, ammo: battle.ammo };
  el.querySelectorAll('[data-ammo]').forEach(b => b.onclick = () => { battle = { warId: Number(b.dataset.w), ammo: b.dataset.ammo }; renderWar(); });
  el.querySelectorAll('[data-hit]').forEach(b => b.onclick = async () => {
    const wid = Number(b.dataset.hit);
    try {
      const r = await api('/api/hit', { warId: wid, ammo: battle.warId === wid ? battle.ammo : 'none' });
      if (r.dodged) flash('راوغت!', 'good');
      else if (r.missed) flash('ضايعة!', 'miss');
      else if (r.crit) flash('كريت! ' + fmt(r.dmg), 'crit');
      else flash('-' + fmt(r.dmg), 'dmg');
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
  } else {
    h += `<p class="hint">لو رشّحت نفسك ومفيش حد ضدك، تبقى رئيس فورًا.</p>
      <button class="bigbtn" id="btn-run" type="button">رشّح نفسك للرئاسة</button>`;
  }
  h += `<h3>صلاحيات الرئيس</h3><p class="hint">يعلن حرب على أقاليم الدول الجارة (من الخريطة) — يحصّن أقاليم دولته بفلوس الخزينة — الخزينة بتتجمع من ضريبة شغل المواطنين.</p></div>`;
  el.innerHTML = h;
  const run = $('#btn-run');
  if (run) run.onclick = async () => {
    try { await api('/api/run'); flash('تم', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
  };
  el.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    try { await api('/api/vote', { candidate: b.dataset.vote }); flash('صوتك اتحسب', 'good'); refresh(); } catch (e) { flash(e.message, 'miss'); }
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

/* --- log --- */
function renderLog() {
  $('#log').innerHTML = S.log.slice(0, 8).map(l =>
    `<div><time>${new Date(l.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>${esc(l.msg)}</div>`).join('');
}

/* ---------- polling ---------- */
let refreshing = false;
async function refresh() {
  if (refreshing || $('#game').classList.contains('hidden')) return;
  refreshing = true;
  try { S = await api('/api/state'); render(); } catch {}
  refreshing = false;
}
setInterval(refresh, 3000);

/* ---------- start ---------- */
const qp = new URLSearchParams(location.search);
if (qp.get('token')) { token = qp.get('token'); localStorage.setItem('raad_token', token); }
if (qp.get('tab')) curTab = qp.get('tab');
if (token) boot(); else show('auth');
