// RAAD war server — multiplayer, no bots. Zero deps, Node 18+.
// Sleep-tolerant: all time-based state is computed lazily from timestamps.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFS, PATHS, NEIGHBORS } from './gamedata.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const PORT = process.env.PORT || 3000;

let db = { users: {}, sessions: {}, countries: {}, wars: {}, warSeq: 0, log: [], speed: 1 };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
if (!db.speed) db.speed = 1;
let dirty = false;
const save = () => {
    if (!dirty) return;
    dirty = false;
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
};
setInterval(save, 4000).unref();
process.on('SIGTERM', () => { dirty = true; save(); process.exit(0); });
const mark = () => { dirty = true; };

// ---------- rules ----------
const REGEN = 0.10;                       // of bar max, per hour
const WORK = { energy: 10, salary: 50, tax: 0.10, xp: 10 };
const HIT = { health: 10, xp: 2 };
const WAR_BASE_THRESHOLD = 5000;
const COMPANY = { price: 500, income: 5 }; // per hour
const FOODS = {
    bread: { name: 'عيش', price: 10, heal: 10 },
    meal: { name: 'وجبة', price: 25, heal: 20 },
    feast: { name: 'وليمة', price: 45, heal: 30 },
};
const WEAPONS = [
    { name: 'خنجر', price: 0, atk: 30, crit: 3 },
    { name: 'مسدس', price: 200, atk: 55, crit: 8 },
    { name: 'بندقية', price: 600, atk: 80, crit: 13 },
    { name: 'قناصة', price: 1500, atk: 115, crit: 18 },
    { name: 'دبابة', price: 4000, atk: 155, crit: 30 },
    { name: 'مقاتلة', price: 9000, atk: 260, crit: 45 },
];
const ARMORS = [ // reduces the health cost per hit
    { name: 'ملابس عادية', price: 0, armor: 0 },
    { name: 'سترة جلد', price: 150, armor: 5 },
    { name: 'سترة واقية', price: 500, armor: 12 },
    { name: 'درع ميداني', price: 1200, armor: 20 },
    { name: 'درع متقدم', price: 3000, armor: 32 },
    { name: 'درع أسطوري', price: 8000, armor: 50 },
];
const AMMOS = {
    light: { name: 'خفيفة +10%', price: 15, bonus: 0.10 },
    mid: { name: 'متوسطة +20%', price: 30, bonus: 0.20 },
    heavy: { name: 'ثقيلة +40%', price: 55, bonus: 0.40 },
};
const SKILLS = [
    { id: 'attack', name: 'هجوم', side: 'war' }, { id: 'precision', name: 'دقة', side: 'war' },
    { id: 'crit', name: 'فرصة كريت', side: 'war' }, { id: 'critdmg', name: 'ضرر كريت', side: 'war' },
    { id: 'armor', name: 'درع', side: 'war' }, { id: 'dodge', name: 'مراوغة', side: 'war' },
    { id: 'production', name: 'إنتاجية', side: 'eco' }, { id: 'companies', name: 'شركات', side: 'eco' },
    { id: 'management', name: 'إدارة', side: 'eco' },
];
const SKILL_MAX = 10;
const levelXp = (lvl) => lvl * 100;

// ---------- model ----------
function newPlayer(name, admin) {
    return {
        name, country: null, money: 100, xp: 0, level: 1, skillPoints: 4, admin: !!admin,
        skills: { attack: 0, precision: 0, crit: 0, critdmg: 0, armor: 0, dodge: 0, production: 0, companies: 0, management: 0 },
        bars: { health: 100, hunger: 100, energy: 100 },
        weapon: 0, armorGear: 0, ammo: { light: 0, mid: 0, heavy: 0 },
        foods: { bread: 1, meal: 0, feast: 0 }, companiesOwned: 0,
        totalDamage: 0, lastTick: Date.now(),
    };
}
function ensureCountry(id) {
    if (!db.countries[id]) db.countries[id] = {
        id, treasury: 200, president: null,
        election: { candidates: [], votes: {}, closesAt: null },
        regions: Object.fromEntries(DEFS[id].regions.map(r => [r.id, id])),
        defenseBonus: {}, lastTick: Date.now(),
    };
    return db.countries[id];
}
function citizens(id) { return Object.values(db.users).filter(u => u.player.country === id).map(u => u.player); }
function countryWars(id) { return Object.values(db.wars).filter(w => !w.over && (w.from === id || w.to === id)); }

function rankBonus(p) {
    const d = p.totalDamage;
    if (d >= 100e6) return 0.375;
    if (d >= 1e6) return 0.15 + Math.min(0.125, (d / 86e6) * 0.125);
    return Math.min(0.1375, (d / 875000) * 0.1375);
}
const barMax = (p, b) => 100 + (p.skills[b] || 0) * 10;

function tickPlayer(p) {
    const now = Date.now();
    const hours = (now - p.lastTick) / 3600000 * db.speed;
    if (hours <= 0) return;
    p.lastTick = now;
    for (const b of ['health', 'hunger', 'energy']) {
        const max = barMax(p, b);
        p.bars[b] = Math.min(max, p.bars[b] + max * REGEN * hours);
    }
    // companies pay out
    if (p.companiesOwned > 0) {
        p.money += p.companiesOwned * COMPANY.income * (1 + p.skills.management * 0.10) * hours;
    }
    mark();
}
function tickCountry(c) {
    const now = Date.now();
    const hours = (now - c.lastTick) / 3600000 * db.speed;
    if (hours <= 0) return;
    c.lastTick = now;
    for (const r of DEFS[c.id].regions) if (c.regions[r.id] === c.id) c.treasury += r.income * hours;
    mark();
}
function gainXp(p) {
    while (p.xp >= levelXp(p.level)) { p.xp -= levelXp(p.level); p.level++; p.skillPoints += 4; }
}
function logLine(s) { db.log.unshift({ ts: Date.now(), msg: s }); db.log = db.log.slice(0, 50); mark(); }

function hitDamage(p, ammoKind) {
    const w = WEAPONS[p.weapon];
    const missed = Math.random() * 100 >= 50 + p.skills.precision * 5;
    const buff = 0.9 + Math.random() * 0.2;
    let dmg = (p.skills.attack * 4 + w.atk) * (1 + (ammoKind ? AMMOS[ammoKind].bonus : 0)) * (1 + rankBonus(p)) * buff;
    let crit = false;
    if (!missed && Math.random() * 100 < w.crit + p.skills.crit * 2) {
        crit = true; dmg *= 2 * (1 + p.skills.critdmg * 0.05);
    }
    if (missed) dmg = 0;
    return { dmg: Math.round(dmg), crit, missed };
}

function warThreshold(w) {
    const def = db.countries[w.to];
    return WAR_BASE_THRESHOLD + (def && def.defenseBonus[w.regionId] || 0);
}
function resolveWar(w) {
    if (w.over) return;
    const t = warThreshold(w);
    if (w.attDmg >= t || w.defDmg >= t || Date.now() > w.endsAt) {
        const attackerWins = w.attDmg >= t || (Date.now() > w.endsAt && w.attDmg > w.defDmg);
        w.over = attackerWins ? 'won' : 'lost';
        const def = db.countries[w.to];
        const rName = DEFS[w.to].regions.find(r => r.id === w.regionId)?.name || w.regionId;
        if (attackerWins) {
            def.regions[w.regionId] = w.from;
            logLine(`${DEFS[w.from].name} احتلت ${rName} من ${DEFS[w.to].name}`);
        } else {
            logLine(`${DEFS[w.to].name} صدّت هجوم ${DEFS[w.from].name} على ${rName}`);
        }
        mark();
    }
}

// election: run unopposed -> instant president; contested -> 24h vote
function runForPresident(p) {
    const c = db.countries[p.country];
    const el = c.election;
    if (c.president === p.name) return { error: 'أنت الرئيس بالفعل' };
    if (!el.candidates.includes(p.name)) el.candidates.push(p.name);
    if (!c.president && el.candidates.length === 1) {
        c.president = p.name;
        c.election = { candidates: [], votes: {}, closesAt: null };
        logLine(`${p.name} أصبح رئيس ${DEFS[c.id].name} بدون منافس`);
        mark();
        return { ok: true, president: true };
    }
    if (!el.closesAt) el.closesAt = Date.now() + 24 * 3600000;
    mark();
    return { ok: true, president: false };
}
function settleElection(c) {
    const el = c.election;
    if (!el.closesAt || Date.now() < el.closesAt) return;
    const tally = {};
    for (const v of Object.values(el.votes)) tally[v] = (tally[v] || 0) + 1;
    let winner = null, best = -1;
    for (const cand of el.candidates) {
        const n = tally[cand] || 0;
        if (n > best) { best = n; winner = cand; }
    }
    if (winner) {
        c.president = winner;
        logLine(`${winner} فاز برئاسة ${DEFS[c.id].name} (${best} صوت)`);
    }
    c.election = { candidates: [], votes: {}, closesAt: null };
    mark();
}

// ---------- public state shaping ----------
function publicCountry(id) {
    const c = db.countries[id];
    if (!c) return null;
    settleElection(c);
    tickCountry(c);
    const cz = citizens(id);
    return {
        id, name: DEFS[id].name, treasury: Math.floor(c.treasury), president: c.president,
        election: c.election, citizens: cz.map(p => p.name),
        regions: DEFS[id].regions.map(r => ({ ...r, owner: c.regions[r.id] })),
        defenseBonus: c.defenseBonus,
        wars: countryWars(id).map(publicWar),
    };
}
function publicWar(w) {
    resolveWar(w);
    return {
        id: w.id, from: w.from, to: w.to, regionId: w.regionId,
        regionName: DEFS[w.to].regions.find(r => r.id === w.regionId)?.name,
        attDmg: Math.floor(w.attDmg), defDmg: Math.floor(w.defDmg),
        threshold: warThreshold(w), over: w.over, endsAt: w.endsAt,
    };
}

// ---------- http ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const auth = (req) => {
    const name = db.sessions[req.headers['x-token']];
    return name && db.users[name] ? db.users[name].player : null;
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await new Promise(r => {
        let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } });
    }) : {};
    const P = url.pathname;

    if (P === '/api/register' && req.method === 'POST') {
        const name = String(body.name || '').trim();
        if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(name)) return json(res, 400, { error: 'الاسم 3-20 حرف أو رقم' });
        if (db.users[name]) return json(res, 409, { error: 'الاسم محجوز' });
        if (Object.keys(db.users).length >= 30) return json(res, 403, { error: 'السيرفر مكتمل العدد' });
        const salt = crypto.randomBytes(16).toString('hex');
        const isFirst = Object.keys(db.users).length === 0; // first account is the game admin, permanently
        db.users[name] = { salt, hash: crypto.scryptSync(String(body.pass || ''), salt, 32).toString('hex'), player: newPlayer(name, isFirst) };
        const token = crypto.randomBytes(24).toString('hex');
        db.sessions[token] = name; mark(); save();
        return json(res, 200, { token, name });
    }
    if (P === '/api/login' && req.method === 'POST') {
        const u = db.users[String(body.name || '')];
        const hash = u && crypto.scryptSync(String(body.pass || ''), u.salt, 32).toString('hex');
        if (!u || hash !== u.hash) return json(res, 401, { error: 'اسم أو باسورد غلط' });
        const token = crypto.randomBytes(24).toString('hex');
        db.sessions[token] = u.player.name; mark();
        return json(res, 200, { token, name: u.player.name });
    }
    if (P === '/api/mapdata') return json(res, 200, { defs: DEFS, paths: PATHS, neighbors: NEIGHBORS });

    // static client files are public; everything under /api below requires auth
    if (req.method === 'GET' && !P.startsWith('/api/')) {
        const fp = path.join(ROOT, 'public', P === '/' ? 'index.html' : P);
        if (fp.startsWith(path.join(ROOT, 'public')) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(fp)] || 'application/octet-stream';
            res.writeHead(200, { 'content-type': mime });
            return fs.createReadStream(fp).pipe(res);
        }
    }

    const p = auth(req);
    if (!p) return json(res, 401, { error: 'سجل دخول الأول' });
    tickPlayer(p);

    if (P === '/api/state') {
        gainXp(p);
        const countries = {};
        for (const id of Object.keys(db.countries)) countries[id] = publicCountry(id);
        return json(res, 200, {
            you: {
                name: p.name, country: p.country, money: Math.floor(p.money), xp: p.xp, level: p.level,
                levelXp: levelXp(p.level), skillPoints: p.skillPoints, skills: p.skills,
                bars: p.bars, barMax: { health: barMax(p, 'health'), hunger: barMax(p, 'hunger'), energy: barMax(p, 'energy') },
                weapon: p.weapon, armorGear: p.armorGear, ammo: p.ammo, foods: p.foods,
                companiesOwned: p.companiesOwned, totalDamage: p.totalDamage, rankBonus: rankBonus(p), admin: !!p.admin,
            },
            speed: db.speed,
            countries, wars: Object.values(db.wars).filter(w => !w.over).map(publicWar),
            log: db.log.slice(0, 20),
            shop: { foods: FOODS, weapons: WEAPONS, armors: ARMORS, ammos: AMMOS, skills: SKILLS, skillMax: SKILL_MAX, company: COMPANY },
        });
    }

    const need = (cond, msg) => { if (!cond) { json(res, 400, { error: msg }); return true; } return false };

    if (P === '/api/country' && req.method === 'POST') {
        const cid = body.country || body.id;
        if (need(!p.country, 'اخترت دولتك بالفعل')) return;
        if (need(DEFS[cid], 'دولة غير معروفة')) return;
        ensureCountry(cid);
        p.country = cid; mark(); save();
        logLine(`${p.name} انضم لمواطني ${DEFS[cid].name}`);
        return json(res, 200, { ok: true });
    }
    if (!p.country) return json(res, 400, { error: 'اختر دولة أولًا' });
    const home = db.countries[p.country];

    if (P === '/api/work' && req.method === 'POST') {
        if (need(p.bars.energy >= WORK.energy, 'طاقة غير كافية')) return;
        p.bars.energy -= WORK.energy;
        const salary = WORK.salary * (1 + p.skills.production * 0.05);
        const tax = salary * WORK.tax;
        p.money += salary - tax;
        home.treasury += tax;
        p.xp += WORK.xp; gainXp(p); mark();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/eat' && req.method === 'POST') {
        const f = FOODS[body.food];
        if (need(f && p.foods[body.food] > 0, 'مفيش أكل من ده')) return;
        if (need(p.bars.hunger >= 1, 'مش جعان')) return;
        p.foods[body.food]--; p.bars.hunger -= 1;
        p.bars.health = Math.min(barMax(p, 'health'), p.bars.health + f.heal); mark();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/buy' && req.method === 'POST') {
        const { kind, id } = body;
        if (kind === 'food' && FOODS[id]) { if (need(p.money >= FOODS[id].price, 'فلوس غير كافية')) return; p.money -= FOODS[id].price; p.foods[id]++; }
        else if (kind === 'ammo' && AMMOS[id]) { if (need(p.money >= AMMOS[id].price, 'فلوس غير كافية')) return; p.money -= AMMOS[id].price; p.ammo[id]++; }
        else if (kind === 'weapon') { const w = WEAPONS[id]; if (need(w && p.money >= w.price, 'فلوس غير كافية')) return; p.money -= w.price; p.weapon = id; }
        else if (kind === 'armor') { const g = ARMORS[id]; if (need(g && p.money >= g.price, 'فلوس غير كافية')) return; p.money -= g.price; p.armorGear = id; }
        else if (kind === 'company') {
            if (need(p.companiesOwned < 1 + p.skills.companies, 'وصلت لحد الشركات — طوّر مهارة شركات')) return;
            if (need(p.money >= COMPANY.price, 'فلوس غير كافية')) return;
            p.money -= COMPANY.price; p.companiesOwned++;
        }
        else return json(res, 400, { error: 'غير متاح' });
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/skill' && req.method === 'POST') {
        const s = SKILLS.find(s => s.id === body.id);
        if (need(s, 'مهارة غير معروفة')) return;
        const cur = p.skills[s.id];
        if (need(cur < SKILL_MAX, 'وصلت للحد الأقصى')) return;
        if (need(p.skillPoints >= cur + 1, 'نقط غير كافية')) return;
        p.skillPoints -= cur + 1; p.skills[s.id]++; mark();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/run' && req.method === 'POST') {
        return json(res, 200, runForPresident(p));
    }
    if (P === '/api/vote' && req.method === 'POST') {
        settleElection(home);
        const el = home.election;
        if (need(el.closesAt, 'مفيش انتخابات مفتوحة')) return;
        if (need(el.candidates.includes(body.candidate), 'مرشح غير معروف')) return;
        el.votes[p.name] = body.candidate; mark();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/war' && req.method === 'POST') { // president declares war on a neighbor region
        if (need(home.president === p.name, 'الرئيس بس اللي يعلن الحرب')) return;
        if (need(!countryWars(p.country).length, 'دولتك في حرب بالفعل')) return;
        const regionId = String(body.regionId || '');
        let target = null;
        for (const nid of NEIGHBORS[p.country] || []) {
            ensureCountry(nid);
            const r = DEFS[nid].regions.find(r => r.id === regionId);
            if (r && db.countries[nid].regions[r.id] === nid) { target = { c: nid, r }; break; }
        }
        if (need(target, 'الهدف لازم يكون إقليم تابع لدولة جارة')) return;
        const w = {
            id: ++db.warSeq, from: p.country, to: target.c, regionId,
            attDmg: 0, defDmg: 0, startedBy: p.name,
            endsAt: Date.now() + 24 * 3600000, over: null,
        };
        db.wars[w.id] = w;
        logLine(`${DEFS[p.country].name} أعلنت الحرب على ${target.r.name} (${DEFS[target.c].name})`);
        mark(); save();
        return json(res, 200, { ok: true, war: publicWar(w) });
    }
    if (P === '/api/hit' && req.method === 'POST') {
        const w = db.wars[body.warId];
        if (need(w, 'معركة غير موجودة')) return;
        resolveWar(w);
        if (need(!w.over, 'المعركة خلصت')) return;
        if (need(p.country === w.from || p.country === w.to, 'مش طرف في المعركة دي')) return;
        if (need(p.bars.health >= HIT.health, 'صحتك أقل من 10 — كُل الأول')) return;
        const ammoKind = AMMOS[body.ammo] && p.ammo[body.ammo] > 0 ? body.ammo : null;
        const armorPct = ARMORS[p.armorGear].armor + p.skills.armor * 2;
        const dodged = Math.random() * 100 < p.skills.dodge * 1.5;
        const cost = dodged ? 0 : Math.max(1, Math.round(HIT.health * (1 - Math.min(90, armorPct) / 100)));
        p.bars.health -= cost;
        if (ammoKind) p.ammo[ammoKind]--;
        const { dmg, crit, missed } = hitDamage(p, ammoKind);
        if (p.country === w.from) w.attDmg += dmg; else w.defDmg += dmg;
        p.totalDamage += dmg; p.xp += HIT.xp; gainXp(p);
        resolveWar(w); mark(); save();
        return json(res, 200, { ok: true, dmg, crit, missed, cost, dodged, war: publicWar(w) });
    }
    if (P === '/api/defense' && req.method === 'POST') { // president funds a region's defense from treasury
        if (need(home.president === p.name, 'الرئيس بس')) return;
        const r = DEFS[p.country].regions.find(r => r.id === body.regionId);
        if (need(r, 'إقليم غير معروف')) return;
        const amount = Math.min(Number(body.amount) || 0, Math.floor(home.treasury));
        if (need(amount >= 10, 'أقل مبلغ 10')) return;
        home.treasury -= amount;
        home.defenseBonus[r.id] = (home.defenseBonus[r.id] || 0) + amount;
        mark();
        return json(res, 200, { ok: true });
    }

    // ---------- admin (his account only: the first registered account) ----------
    if (P === '/api/cheat' && req.method === 'POST') {
        if (need(p.admin, 'مش ليك')) return;
        if (need(String(body.code || '').trim() === 'raad raad', 'كود غلط')) return;
        p.money += 100000;
        p.bars = { health: barMax(p, 'health'), hunger: barMax(p, 'hunger'), energy: barMax(p, 'energy') };
        for (const k of ['light', 'mid', 'heavy']) p.ammo[k] += 100;
        for (const k of ['bread', 'meal', 'feast']) p.foods[k] += 50;
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P.startsWith('/api/admin/') && req.method === 'POST') {
        if (need(p.admin, 'مش ليك')) return;
        if (P === '/api/admin/give') {
            const t = db.users[String(body.name || '')]?.player;
            if (need(t, 'لاعب غير موجود')) return;
            tickPlayer(t);
            t.money += Number(body.money) || 0;
            if (body.bars) t.bars = { health: barMax(t, 'health'), hunger: barMax(t, 'hunger'), energy: barMax(t, 'energy') };
            for (const k of ['light', 'mid', 'heavy']) if (body.ammo) t.ammo[k] += Number(body.ammo) || 0;
            mark(); save();
            return json(res, 200, { ok: true });
        }
        if (P === '/api/admin/region') {
            const [cid] = String(body.regionId || '').split(':');
            if (need(DEFS[cid] && DEFS[body.to], 'بيانات غلط')) return;
            ensureCountry(cid); ensureCountry(body.to);
            db.countries[cid].regions[body.regionId] = body.to;
            logLine(`الإدارة نقلت ملكية إقليم لـ ${DEFS[body.to].name}`);
            mark(); save();
            return json(res, 200, { ok: true });
        }
        if (P === '/api/admin/war') {
            const r = DEFS[body.to]?.regions.find(r => r.id === body.regionId);
            if (need(DEFS[body.from] && r, 'بيانات غلط')) return;
            ensureCountry(body.from); ensureCountry(body.to);
            const w = { id: ++db.warSeq, from: body.from, to: body.to, regionId: r.id,
                attDmg: 0, defDmg: 0, startedBy: 'الإدارة', endsAt: Date.now() + 24 * 3600000, over: null };
            db.wars[w.id] = w;
            logLine(`الإدارة أعلنت حرب: ${DEFS[body.from].name} ضد ${DEFS[body.to].name}`);
            mark(); save();
            return json(res, 200, { ok: true });
        }
        if (P === '/api/admin/president') {
            if (need(DEFS[body.country], 'دولة غير معروفة')) return;
            const c = ensureCountry(body.country);
            if (body.name) {
                const t = db.users[String(body.name)]?.player;
                if (need(t && t.country === body.country, 'اللاعب مش مواطن في الدولة دي')) return;
                c.president = t.name;
                logLine(`الإدارة عيّنت ${t.name} رئيسًا لـ ${DEFS[body.country].name}`);
            } else {
                c.president = null;
                logLine(`الإدارة أزالت رئيس ${DEFS[body.country].name}`);
            }
            c.election = { candidates: [], votes: {}, closesAt: null };
            mark(); save();
            return json(res, 200, { ok: true });
        }
        if (P === '/api/admin/kick') {
            const name = String(body.name || '');
            if (need(db.users[name], 'لاعب غير موجود')) return;
            if (need(!db.users[name].player.admin, 'مينفعش تمسح الأدمن')) return;
            for (const c of Object.values(db.countries)) {
                if (c.president === name) c.president = null;
                c.election.candidates = c.election.candidates.filter(x => x !== name);
                delete c.election.votes[name];
            }
            for (const [t, n] of Object.entries(db.sessions)) if (n === name) delete db.sessions[t];
            delete db.users[name];
            logLine(`الإدارة طردت ${name} من اللعبة`);
            mark(); save();
            return json(res, 200, { ok: true });
        }
        if (P === '/api/admin/speed') {
            const s = Number(body.speed);
            if (need(s >= 0.1 && s <= 100, 'السرعة بين 0.1 و 100')) return;
            // settle time-based state at the old speed before changing it
            for (const u of Object.values(db.users)) tickPlayer(u.player);
            for (const c of Object.values(db.countries)) tickCountry(c);
            db.speed = s;
            logLine(`الإدارة غيّرت سرعة العالم إلى ×${s}`);
            mark(); save();
            return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') {
        const fp = path.join(ROOT, 'public', P === '/' ? 'index.html' : P);
        if (fp.startsWith(path.join(ROOT, 'public')) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(fp)] || 'application/octet-stream';
            res.writeHead(200, { 'content-type': mime });
            return fs.createReadStream(fp).pipe(res);
        }
    }
    json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log('raad-war listening on', PORT));
