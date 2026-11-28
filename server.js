// RAAD war server — multiplayer, no bots. Zero deps, Node 22.12+.
// Sleep-tolerant: all time-based state is computed lazily from timestamps.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFS, PATHS, NEIGHBORS } from './gamedata.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 8080; // Railway injects PORT; 8080 is just the local fallback
const VERSION = '1.4.0';
// The world stays locked until the owner claims the admin account with this secret.
// If the env var is missing, a one-time secret is generated and printed to the log,
// so a public URL can never hand admin to a stranger.
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(4).toString('hex');
if (!process.env.ADMIN_SECRET) console.log('ADMIN_SECRET not set — one-time owner secret:', ADMIN_SECRET);

try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch (e) { console.log('data dir not creatable:', e.message); }
let db = { users: {}, sessions: {}, countries: {}, wars: {}, warSeq: 0, log: [], speed: 1 };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
if (!db.speed) db.speed = 1;
if (!db.alliances) { db.alliances = {}; db.allySeq = 0; }
let dirty = false;
const save = () => {
    if (!dirty) return;
    dirty = false;
    try {
        fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
        fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) {
        dirty = true; // keep retrying instead of crashing the world
        console.log('save failed:', e.message);
    }
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
// factories: the player builds these on his land; upkeep per hour, goods per hour.
// chain: mine -> iron -> (craft weapons/ammo, ammo plant, war supply); farm -> wheat -> meals
const FACTORIES = {
    mine: { name: 'منجم حديد', price: 300, out: 5, upkeep: 3, good: 'iron', desc: 'ينتج 5 حديد/ساعة لكل مستوى' },
    farm: { name: 'مزرعة قمح', price: 200, out: 8, upkeep: 2, good: 'wheat', desc: 'ينتج 8 قمح/ساعة لكل مستوى' },
    ammolab: { name: 'معمل ذخيرة', price: 800, out: 3, upkeep: 5, ammo: 'mid', consumesIron: 4, desc: 'يحوّل 4 حديد لـ 3 ذخيرة متوسطة/ساعة لكل مستوى' },
};
const FACTORY_MAX_LEVEL = 5;
const factoryCap = (p) => 2 + (p.skills.management || 0);
const factoryUpgradeCost = (f) => FACTORIES[f.type].price * f.level;
const CRAFT_AMMO_IRON = { light: 2, mid: 3, heavy: 5 };
const CRAFT_MEAL_WHEAT = 3;
const weaponIronCost = (i) => Math.ceil(WEAPONS[i].price / 20);
const SUPPLY = { iron: { amount: 10, points: 60 }, heavy: { amount: 5, points: 150 } }; // war supply donations
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
const LEVEL_MAX = 50;
const levelXp = (lvl) => lvl * 100;
// missions: dailies reset on the server day tick; story missions are one-time.
// stat counters: lifetime in p.mStats, today's in p.mDaily. Rewards auto-grant on completion.
const MISSIONS = [
    { id: 'd-work', daily: true, name: 'اشتغل 3 مرات', stat: 'work', target: 3, reward: { money: 50, xp: 30, sp: 1 } },
    { id: 'd-goods', daily: true, name: 'انتج 20 خامة من مصانعك', stat: 'goods', target: 20, reward: { money: 40, xp: 20, sp: 1 } },
    { id: 'd-craft', daily: true, name: 'اصنع أي حاجة', stat: 'crafts', target: 1, reward: { money: 30, xp: 20, sp: 1 } },
    { id: 'd-hits', daily: true, name: 'أصب 10 ضربات في الحرب', stat: 'hits', target: 10, reward: { money: 60, xp: 40, sp: 1 } },
    { id: 'd-supply', daily: true, name: 'زوّد المجهود الحربي مرة', stat: 'supply', target: 1, reward: { money: 40, xp: 30, sp: 1 } },
    { id: 's-factory', name: 'ابنِ أول مصنع', stat: 'factoriesBuilt', target: 1, reward: { money: 100, xp: 50, sp: 2 } },
    { id: 's-skill', name: 'طوّر أي مهارة', stat: 'skillsUp', target: 1, reward: { money: 50, xp: 30, sp: 1 } },
    { id: 's-weapon', name: 'اصنع سلاح من الحديد', stat: 'weaponsCrafted', target: 1, reward: { money: 150, xp: 100, sp: 2 } },
    { id: 's-hits', name: 'أصب 100 ضربة في الحروب', stat: 'hits', target: 100, reward: { money: 300, xp: 200, sp: 3 } },
    { id: 's-goods', name: 'انتج 200 خامة', stat: 'goods', target: 200, reward: { money: 250, xp: 150, sp: 3 } },
    { id: 's-prez', name: 'ابقى رئيس دولتك', stat: 'pres', target: 1, reward: { money: 200, xp: 150, sp: 2 } },
];
const todayStr = () => new Date().toISOString().slice(0, 10);
function bumpStat(p, stat, n) {
    p.mStats[stat] = (p.mStats[stat] || 0) + n;
    p.mDaily[stat] = (p.mDaily[stat] || 0) + n;
}
function checkMissions(p) {
    const done = [];
    for (const m of MISSIONS) {
        const list = m.daily ? p.mDailyDone : p.mStoryDone;
        if (list.includes(m.id)) continue;
        const cur = m.daily ? (p.mDaily[m.stat] || 0) : (p.mStats[m.stat] || 0);
        if (cur >= m.target) {
            list.push(m.id);
            p.money += m.reward.money; p.xp += m.reward.xp; p.skillPoints += m.reward.sp;
            gainXp(p);
            logLine(`${p.name} كمّل مهمة «${m.name}»`);
            done.push(m.name);
        }
    }
    if (done.length) mark();
    return done;
}

// ---------- model ----------
function newPlayer(name, admin) {
    return {
        name, country: null, money: 100, xp: 0, level: 1, skillPoints: 4, admin: !!admin,
        skills: { attack: 0, precision: 0, crit: 0, critdmg: 0, armor: 0, dodge: 0, production: 0, companies: 0, management: 0 },
        bars: { health: 100, hunger: 100, energy: 100 },
        weapon: 0, armorGear: 0, ammo: { light: 0, mid: 0, heavy: 0 },
        foods: { bread: 1, meal: 0, feast: 0 }, companiesOwned: 0,
        goods: { iron: 0, wheat: 0 }, factories: [], factSeq: 0,
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
    const c = db.countries[id];
    if (!c.offices) c.offices = {};            // office key -> player name
    if (!c.clogs) c.clogs = [];               // country feed: who did what
    if (c.taxRate == null) c.taxRate = 0.15;  // income tax, economy minister
    if (!c.swornEnemy) c.swornEnemy = null;
    if (!c.parties) { c.parties = []; c.partySeq = 0; }
    if (!c.resist) c.resist = {};             // occupied-region resistance (on the home country)
    if (!c.dev) c.dev = {};                   // development budget per region
    if (!c.hist) c.hist = [];                 // daily snapshots for stat cards
    if (!c.unit) c.unit = { name: 'الوحدة الرسمية', focusWar: null, members: [] };
    return c;
}
function citizens(id) { return Object.values(db.users).filter(u => u.player.country === id).map(u => u.player); }
const OFFICES = { defense: 'وزير الدفاع', economy: 'وزير الاقتصاد', foreign: 'وزير الخارجية', staff: 'رئيس الأركان', interior: 'وزير الداخلية' };
function clog(cid, msg) {
    const c = db.countries[cid]; if (!c) return;
    if (!c.clogs) c.clogs = [];
    c.clogs.unshift({ t: Date.now(), msg });
    if (c.clogs.length > 40) c.clogs.length = 40;
    mark();
}
function govOK(p, cid, ...offices) { // president or the named office holder, own country only
    if (p.country !== cid) return false;
    const c = db.countries[cid]; if (!c) return false;
    if (c.president === p.name) return true;
    return offices.some(o => c.offices[o] === p.name);
}
const countryDamage = (id) => citizens(id).reduce((a, pl) => a + (pl.totalDamage || 0), 0);
function congress(c) { // 20 seats split proportionally by party membership
    const SEATS = 20;
    const lists = c.parties.map(pt => ({ ...pt, n: pt.members.length }));
    const total = lists.reduce((a, pt) => a + pt.n, 0);
    if (!total) return { seats: [], majority: 0, total: SEATS };
    let seats = lists.map(pt => ({ id: pt.id, name: pt.name, color: pt.color, members: pt.members, raw: pt.n / total * SEATS }));
    seats.forEach(s => s.seats = Math.floor(s.raw));
    let left = SEATS - seats.reduce((a, s) => a + s.seats, 0);
    seats.sort((a, b) => (b.raw - b.seats) - (a.raw - a.seats));
    for (let i = 0; left > 0 && i < seats.length; i++, left--) seats[i].seats++;
    seats.sort((a, b) => b.seats - a.seats);
    return { seats, majority: seats[0] ? seats[0].seats : 0, total: SEATS };
}
function countryWars(id) { return Object.values(db.wars).filter(w => !w.over && (w.from === id || w.to === id)); }
function allianceOf(cid) { return Object.values(db.alliances).find(a => a.members.includes(cid)) || null; }
// which side a player fights on: his own country's side, or an ally's side once allies are called in
function warSide(p, w) {
    if (p.country === w.from) return 'att';
    if (p.country === w.to) return 'def';
    if (w.alliesCalled) {
        const al = allianceOf(p.country);
        if (al && al.members.includes(w.from)) return 'att';
        if (al && al.members.includes(w.to)) return 'def';
    }
    return null;
}

function rankBonus(p) {
    const d = p.totalDamage;
    if (d >= 100e6) return 0.375;
    if (d >= 1e6) return 0.15 + Math.min(0.125, (d / 86e6) * 0.125);
    return Math.min(0.1375, (d / 875000) * 0.1375);
}
const barMax = (p, b) => 100 + (p.skills[b] || 0) * 10;

function tickPlayer(p) {
    // migration for worlds saved before factories existed
    if (!p.goods) p.goods = { iron: 0, wheat: 0 };
    if (!p.factories) { p.factories = []; p.factSeq = 0; }
    // migration + daily reset for missions
    if (!p.mStats) p.mStats = {};
    if (!p.mStoryDone) p.mStoryDone = [];
    if (!p.mDailyDone) p.mDailyDone = [];
    if (!p.mDaily || p.mDaily.date !== todayStr()) { p.mDaily = { date: todayStr() }; p.mDailyDone = []; }
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
    // factories: pay upkeep, then produce. Can't cover upkeep -> the plant sits idle.
    for (const f of p.factories) {
        const def = FACTORIES[f.type];
        if (!def) continue;
        const up = def.upkeep * f.level * hours;
        if (p.money < up) continue;
        p.money -= up;
        const boost = 1 + (p.skills.production || 0) * 0.10;
        if (def.ammo) {
            const needIron = def.consumesIron * f.level * hours;
            const got = Math.min(p.goods.iron, needIron);
            p.goods.iron -= got;
            p.ammo[def.ammo] += def.out * f.level * hours * boost * (needIron > 0 ? got / needIron : 0);
        } else {
            const made = def.out * f.level * hours * boost;
            p.goods[def.good] += made;
            bumpStat(p, 'goods', made);
        }
    }
    checkMissions(p);
    mark();
}
function tickCountry(c) {
    const now = Date.now();
    const hours = (now - c.lastTick) / 3600000 * db.speed;
    if (hours <= 0) return;
    c.lastTick = now;
    for (const r of DEFS[c.id].regions) {
        if (c.regions[r.id] === c.id) { c.treasury += r.income * hours; continue; }
        // occupied home region: resistance builds; at 100 the region revolts back
        c.resist[r.id] = (c.resist[r.id] || 0) + hours * 2;
        if (c.resist[r.id] >= 100) {
            c.regions[r.id] = c.id; c.resist[r.id] = 0;
            logLine(`مقاومة ${r.name} انتصرت — الإقليم رجع لـ ${DEFS[c.id].name}`);
        }
    }
    const lastSnap = c.hist[c.hist.length - 1];
    if (!lastSnap || now - lastSnap.t >= 24 * 3600000) {
        c.hist.push({ t: now, dmg: countryDamage(c.id), pop: citizens(c.id).length, dev: Object.values(c.dev).reduce((a, v) => a + v, 0) });
        if (c.hist.length > 30) c.hist.shift();
    }
    mark();
}
function gainXp(p) {
    while (p.xp >= levelXp(p.level) && p.level < LEVEL_MAX) { p.xp -= levelXp(p.level); p.level++; p.skillPoints += 4; }
    if (p.level >= LEVEL_MAX) p.xp = Math.min(p.xp, levelXp(LEVEL_MAX) - 1);
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

// battles: best-of-3 rounds; each round is a race to 300 terrain. Every tick (2 min,
// scaled by world speed) the side with more damage in the window takes terrain
// (1-6, scaling with the leader's total). Defender wins ties. Old walls become round-1 defender terrain.
const BATTLE = { tickMs: 120000, terrainWin: 300, roundsToWin: 2 };
const ORDER_BONUS = { 1: 0.05, 2: 0.10, 3: 0.15 };
const ORDER_COST = { 1: 100, 2: 250, 3: 500 };
const terrainGain = (lead) => lead < 100 ? 1 : lead < 200 ? 2 : lead < 300 ? 3 : lead < 400 ? 4 : lead < 500 ? 5 : 6;
function migrateWar(w) {
    if (!w.rounds) {
        w.rounds = [{ tickAtt: 0, tickDef: 0, poolAtt: 0, poolDef: 0, terrAtt: 0, terrDef: 0 }];
        w.roundWins = { att: 0, def: 0 };
        w.tickAt = Date.now();
    }
    if (!w.orders) w.orders = {};
    if (!w.contrib) w.contrib = {};
    if (!w.hits) w.hits = [];      // live hit feed, newest last
    if (!w.sideOf) w.sideOf = {};  // player -> 'att'|'def' (first action fixes the side)
    return w;
}
const roundOf = (w) => w.rounds[w.rounds.length - 1];
const regionName = (w) => DEFS[w.to].regions.find(r => r.id === w.regionId)?.name || w.regionId;
function endBattle(w, side) {
    w.over = side === 'att' ? 'won' : 'lost';
    const def = db.countries[w.to];
    const rName = regionName(w);
    if (side === 'att') {
        def.regions[w.regionId] = w.from;
        logLine(`${DEFS[w.from].name} احتلت ${rName} من ${DEFS[w.to].name}`);
    } else {
        logLine(`${DEFS[w.to].name} صدّت هجوم ${DEFS[w.from].name} على ${rName}`);
    }
    mark();
}
function resolveWar(w) {
    if (w.over) return;
    migrateWar(w);
    const tick = Math.max(100, BATTLE.tickMs / db.speed);
    const now = Date.now();
    let guard = 0;
    while (!w.over && guard++ < 5000) {
        const r = roundOf(w);
        if (r.terrAtt >= BATTLE.terrainWin || r.terrDef >= BATTLE.terrainWin) {
            const attWon = r.terrAtt >= BATTLE.terrainWin;
            w.roundWins[attWon ? 'att' : 'def']++;
            logLine(`${DEFS[attWon ? w.from : w.to].name} حسمت الجولة ${w.rounds.length} في حرب ${regionName(w)}`);
            if (w.roundWins.att >= BATTLE.roundsToWin || w.roundWins.def >= BATTLE.roundsToWin) {
                endBattle(w, w.roundWins.att >= BATTLE.roundsToWin ? 'att' : 'def');
                break;
            }
            w.rounds.push({ tickAtt: 0, tickDef: 0, poolAtt: 0, poolDef: 0, terrAtt: 0, terrDef: 0, contrib: {} });
            continue;
        }
        if (now >= w.endsAt) {
            if (w.roundWins.att !== w.roundWins.def) endBattle(w, w.roundWins.att > w.roundWins.def ? 'att' : 'def');
            else if (r.terrAtt !== r.terrDef) endBattle(w, r.terrAtt > r.terrDef ? 'att' : 'def');
            else endBattle(w, 'def');
            break;
        }
        if (now < w.tickAt + tick) break;
        w.tickAt += tick;
        if (r.tickAtt === 0 && r.tickDef === 0) continue; // no damage, no movement
        const side = r.tickAtt > r.tickDef ? 'att' : 'def'; // ties to defender
        const gain = terrainGain(Math.max(r.tickAtt, r.tickDef));
        if (side === 'att') r.terrAtt += gain; else r.terrDef += gain;
        r.tickAtt = 0; r.tickDef = 0;
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
        bumpStat(p, 'pres', 1);
        checkMissions(p);
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
        const wp = db.users[winner] && db.users[winner].player;
        if (wp) { bumpStat(wp, 'pres', 1); checkMissions(wp); }
    }
    c.election = { candidates: [], votes: {}, closesAt: null };
    mark();
}

// ---------- public state shaping ----------
function countryStats(id) {
    const c = db.countries[id];
    const now = Date.now();
    const cur = { dmg: countryDamage(id), pop: citizens(id).length, dev: Object.values(c.dev).reduce((a, v) => a + v, 0) };
    const hist = c.hist || [];
    const snapAt = (h, t) => [...h].reverse().find(x => x.t <= t) || h[0] || null;
    const weekAgo = snapAt(hist, now - 7 * 86400000);
    const weeklyDmg = Math.max(0, cur.dmg - (weekAgo ? weekAgo.dmg : 0));
    const all = Object.keys(db.countries);
    const histVal = (i, k) => { const s = snapAt(db.countries[i].hist || [], now - 7 * 86400000); return s ? s[k] : 0; };
    const rankBy = (fnNow, fnThen) => {
        const rNow = all.map(i => [i, fnNow(i)]).sort((a, b) => b[1] - a[1]).findIndex(x => x[0] === id) + 1;
        const rThen = all.map(i => [i, fnThen(i)]).sort((a, b) => b[1] - a[1]).findIndex(x => x[0] === id) + 1;
        return { rank: rNow || all.length, delta: (rThen || (rNow || 1)) - (rNow || 1) };
    };
    const weekOf = i => Math.max(0, countryDamage(i) - histVal(i, 'dmg'));
    return {
        weeklyDmg: Math.floor(weeklyDmg),
        weeklyDmgCit: cur.pop ? Math.floor(weeklyDmg / cur.pop) : 0,
        totalDmg: Math.floor(cur.dmg),
        pop: cur.pop,
        dev: Math.floor(cur.dev / 100),
        rankWeek: rankBy(weekOf, () => 0),
        rankDmg: rankBy(i => countryDamage(i), i => histVal(i, 'dmg')),
        rankPop: rankBy(i => citizens(i).length, i => histVal(i, 'pop')),
        rankDev: rankBy(i => Object.values(db.countries[i].dev || {}).reduce((a, v) => a + v, 0), i => histVal(i, 'dev')),
        hist: hist.slice(-14),
    };
}
function publicCountry(id) {
    if (!db.countries[id]) return null;
    const c = ensureCountry(id);
    settleElection(c);
    tickCountry(c);
    const cz = citizens(id);
    return {
        id, name: DEFS[id].name, treasury: Math.floor(c.treasury), president: c.president,
        election: c.election, citizens: cz.map(p => p.name),
        regions: DEFS[id].regions.map(r => ({ ...r, owner: c.regions[r.id] })),
        defenseBonus: c.defenseBonus,
        wars: countryWars(id).map(publicWar),
        offices: Object.fromEntries(Object.entries(c.offices).map(([k, n]) => [k, { name: n, level: db.users[n] ? db.users[n].player.level : 1 }])),
        clogs: c.clogs.slice(0, 15),
        taxRate: Math.round(c.taxRate * 100),
        swornEnemy: c.swornEnemy,
        congress: congress(c),
        unit: c.unit,
        dev: c.dev, resist: c.resist,
        dailyIncome: DEFS[id].regions.filter(r => c.regions[r.id] === id).reduce((a, r) => a + r.income, 0) * 24,
        stats: countryStats(id),
    };
}
function warRanks(w, contrib, sideOf) {
    const rows = Object.entries(contrib || {}).map(([name, dmg]) => ({
        name, dmg: Math.floor(dmg), side: (sideOf || {})[name] || null,
        level: db.users[name] ? db.users[name].player.level : 1,
        country: db.users[name] ? db.users[name].player.country : null,
    })).filter(x => x.side);
    rows.sort((a, b) => b.dmg - a.dmg);
    return { att: rows.filter(x => x.side === 'att').slice(0, 10), def: rows.filter(x => x.side === 'def').slice(0, 10) };
}
function publicWar(w) {
    resolveWar(w);
    const r = roundOf(w);
    const tick = Math.max(100, BATTLE.tickMs / db.speed);
    return {
        id: w.id, from: w.from, to: w.to, regionId: w.regionId,
        regionName: regionName(w),
        attDmg: Math.floor(w.attDmg), defDmg: Math.floor(w.defDmg),
        over: w.over, endsAt: w.endsAt, alliesCalled: !!w.alliesCalled,
        round: w.rounds.length, roundWins: w.roundWins,
        terr: { att: r.terrAtt, def: r.terrDef, win: BATTLE.terrainWin },
        tickPools: { att: Math.floor(r.tickAtt), def: Math.floor(r.tickDef) },
        tickEndsAt: w.tickAt + tick,
        tickGain: (r.tickAtt || r.tickDef) ? terrainGain(Math.max(r.tickAtt, r.tickDef)) : 0,
        hits: (w.hits || []).slice(-20).reverse(),
        rankBattle: warRanks(w, w.contrib, w.sideOf),
        rankRound: warRanks(w, r.contrib || {}, w.sideOf),
        sideMods: {
            att: Math.round(((w.orders[w.from] && ORDER_BONUS[w.orders[w.from].priority]) || 0) * 100),
            def: Math.round(((w.orders[w.to] && ORDER_BONUS[w.orders[w.to].priority]) || 0) * 100),
        },
        sideCount: {
            att: Object.keys(w.sideOf || {}).filter(n => w.sideOf[n] === 'att').length,
            def: Object.keys(w.sideOf || {}).filter(n => w.sideOf[n] === 'def').length,
        },
        orders: w.orders,
        contrib: w.contrib,
    };
}

// ---------- http ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const auth = (req, url) => {
    const t = req.headers['x-token'] || (url && url.searchParams.get('token'));
    const name = db.sessions[t];
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
        if (Object.keys(db.users).length >= 20) return json(res, 403, { error: 'السيرفر مكتمل العدد (20 لاعب)' });
        const adminClaimed = Object.values(db.users).some(u => u.player.admin);
        if (!adminClaimed) {
            // the world stays locked until the owner claims admin with the secret
            if (String(body.secret || '') !== ADMIN_SECRET) return json(res, 403, { error: 'صاحب العالم لسه مفتحوش — التسجيل مقفول لحد ما يدخل بكود المالك' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[name] = { salt, hash: crypto.scryptSync(String(body.pass || ''), salt, 32).toString('hex'), player: newPlayer(name, !adminClaimed) };
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
            res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache, must-revalidate', 'x-raad-version': VERSION });
            return fs.createReadStream(fp).pipe(res);
        }
    }

    const p = auth(req, url);
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
                goods: { iron: Math.floor(p.goods.iron), wheat: Math.floor(p.goods.wheat) },
                factories: p.factories.map(f => ({ ...f, upNext: factoryUpgradeCost(f) })),
                factoryCap: factoryCap(p),
            },
            speed: db.speed, version: VERSION,
            missions: MISSIONS.map(m => ({
                id: m.id, name: m.name, daily: !!m.daily, target: m.target, reward: m.reward,
                progress: Math.floor(m.daily ? (p.mDaily[m.stat] || 0) : (p.mStats[m.stat] || 0)),
                done: (m.daily ? p.mDailyDone : p.mStoryDone).includes(m.id),
            })),
            alliances: Object.values(db.alliances).map(a => ({ id: a.id, name: a.name, leader: a.leader, members: a.members, pending: a.pending })),
            countries, wars: Object.values(db.wars).filter(w => !w.over).map(publicWar),
            world: Object.keys(DEFS).map(id => ({
                id, president: db.countries[id] ? db.countries[id].president : null,
                citizens: citizens(id).length,
                swornEnemy: db.countries[id] ? db.countries[id].swornEnemy : null,
            })),
            log: db.log.slice(0, 20),
            shop: { foods: FOODS, weapons: WEAPONS, armors: ARMORS, ammos: AMMOS, skills: SKILLS, skillMax: SKILL_MAX, company: COMPANY, factories: FACTORIES, factoryMaxLevel: FACTORY_MAX_LEVEL, craftAmmoIron: CRAFT_AMMO_IRON, craftMealWheat: CRAFT_MEAL_WHEAT, weaponIron: WEAPONS.map((_, i) => weaponIronCost(i)), supply: SUPPLY },
        });
    }

    const need = (cond, msg) => { if (!cond) { json(res, 400, { error: msg }); return true; } return false };

    // owner-only: download the whole world state as a JSON file (backup)
    if (P === '/api/admin/export' && req.method === 'GET') {
        if (need(p.admin, 'مش ليك')) return;
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': 'attachment; filename="raad-world.json"',
        });
        return res.end(JSON.stringify(db, null, 2));
    }

    if (P === '/api/country' && req.method === 'POST') {
        const cid = body.country || body.id;
        if (need(!p.country, 'اخترت دولتك بالفعل')) return;
        if (need(DEFS[cid], 'دولة غير معروفة')) return;
        ensureCountry(cid);
        p.country = cid; mark(); save();
        logLine(`${p.name} انضم لمواطني ${DEFS[cid].name}`);
        return json(res, 200, { ok: true });
    }
    // one-time owner claim: promotes the logged-in account with the owner secret.
    // Covers worlds created before ADMIN_SECRET existed, without wiping anything.
    // Sits above the country gate: the owner can claim before picking a country.
    if (P === '/api/claim' && req.method === 'POST') {
        if (need(String(body.secret || '') === ADMIN_SECRET, 'كود المالك غلط')) return;
        for (const u of Object.values(db.users)) u.player.admin = false;
        p.admin = true;
        logLine(`${p.name} استلم ملكية العالم`);
        mark(); save();
        return json(res, 200, { ok: true });
    }

    if (!p.country) return json(res, 400, { error: 'اختر دولة أولًا' });
    const home = db.countries[p.country];

    if (P === '/api/work' && req.method === 'POST') {
        if (need(p.bars.energy >= WORK.energy, 'طاقة غير كافية')) return;
        p.bars.energy -= WORK.energy;
        const salary = WORK.salary * (1 + p.skills.production * 0.05);
        const tax = salary * (home.taxRate != null ? home.taxRate : WORK.tax);
        p.money += salary - tax;
        home.treasury += tax;
        p.xp += WORK.xp; gainXp(p);
        bumpStat(p, 'work', 1);
        const mdw = checkMissions(p); mark();
        return json(res, 200, { ok: true, missions: mdw });
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
        p.skillPoints -= cur + 1; p.skills[s.id]++;
        bumpStat(p, 'skillsUp', 1);
        const mds = checkMissions(p); mark();
        return json(res, 200, { ok: true, missions: mds });
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
        migrateWar(w);
        // old defense walls become starting defender terrain in round 1
        const wall = db.countries[target.c].defenseBonus[regionId] || 0;
        if (wall > 0) { w.rounds[0].terrDef = Math.min(60, Math.floor(wall / 50)); db.countries[target.c].defenseBonus[regionId] = 0; }
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
        const hitSide = warSide(p, w);
        if (need(hitSide, 'مش طرف في المعركة دي — ولا حليف منادى')) return;
        if (need(p.bars.health >= HIT.health, 'صحتك أقل من 10 — كُل الأول')) return;
        const ammoKind = AMMOS[body.ammo] && p.ammo[body.ammo] > 0 ? body.ammo : null;
        const armorPct = ARMORS[p.armorGear].armor + p.skills.armor * 2;
        const dodged = Math.random() * 100 < p.skills.dodge * 1.5;
        const cost = dodged ? 0 : Math.max(1, Math.round(HIT.health * (1 - Math.min(90, armorPct) / 100)));
        p.bars.health -= cost;
        if (ammoKind) p.ammo[ammoKind]--;
        const { dmg, crit, missed } = hitDamage(p, ammoKind);
        // battle order bonus: your country's leadership marked this battle
        const ord = w.orders[p.country];
        const finalDmg = ord && ORDER_BONUS[ord.priority] ? Math.round(dmg * (1 + ORDER_BONUS[ord.priority])) : dmg;
        const r = roundOf(w);
        if (hitSide === 'att') { w.attDmg += finalDmg; r.poolAtt += finalDmg; r.tickAtt += finalDmg; }
        else { w.defDmg += finalDmg; r.poolDef += finalDmg; r.tickDef += finalDmg; }
        w.contrib[p.name] = (w.contrib[p.name] || 0) + finalDmg;
        w.sideOf[p.name] = hitSide;
        r.contrib = r.contrib || {};
        r.contrib[p.name] = (r.contrib[p.name] || 0) + finalDmg;
        w.hits.push({ t: Date.now(), side: hitSide, name: p.name, country: p.country, dmg: finalDmg, crit, missed, ammo: ammoKind, weapon: p.weapon, level: p.level });
        if (w.hits.length > 30) w.hits.splice(0, w.hits.length - 30);
        p.totalDamage += finalDmg; p.xp += HIT.xp; gainXp(p);
        if (!missed && finalDmg > 0) bumpStat(p, 'hits', 1);
        const mdh = checkMissions(p);
        resolveWar(w); mark(); save();
        return json(res, 200, { ok: true, dmg: finalDmg, crit, missed, cost, dodged, ordered: !!ord, war: publicWar(w), missions: mdh });
    }
    if (P === '/api/defense' && req.method === 'POST') { // defense/interior ministry funds a region's defense from treasury
        if (need(govOK(p, p.country, 'defense', 'interior'), 'للرئيس أو وزير الدفاع أو الداخلية بس')) return;
        const r = DEFS[p.country].regions.find(r => r.id === body.regionId);
        if (need(r, 'إقليم غير معروف')) return;
        const amount = Math.min(Number(body.amount) || 0, Math.floor(home.treasury));
        if (need(amount >= 10, 'أقل مبلغ 10')) return;
        home.treasury -= amount;
        home.defenseBonus[r.id] = (home.defenseBonus[r.id] || 0) + amount;
        mark();
        return json(res, 200, { ok: true });
    }

    // ---------- factories: build, upgrade, craft, supply the war ----------
    if (P === '/api/factory' && req.method === 'POST') {
        const def = FACTORIES[body.type];
        if (need(def, 'نوع مصنع غير معروف')) return;
        if (need(p.factories.length < factoryCap(p), 'وصلت لحد المصانع — طوّر مهارة إدارة')) return;
        if (need(p.money >= def.price, 'فلوس غير كافية')) return;
        p.money -= def.price;
        p.factories.push({ id: ++p.factSeq, type: body.type, level: 1 });
        bumpStat(p, 'factoriesBuilt', 1);
        logLine(`${p.name} بنى ${def.name} في ${DEFS[p.country].name}`);
        const mdf = checkMissions(p);
        mark(); save();
        return json(res, 200, { ok: true, missions: mdf });
    }
    if (P === '/api/factory/upgrade' && req.method === 'POST') {
        const f = p.factories.find(f => f.id === Number(body.id));
        if (need(f, 'مصنع غير موجود')) return;
        if (need(f.level < FACTORY_MAX_LEVEL, 'وصل لأقصى مستوى')) return;
        const cost = factoryUpgradeCost(f);
        if (need(p.money >= cost, 'فلوس غير كافية')) return;
        p.money -= cost; f.level++;
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/craft' && req.method === 'POST') {
        const what = String(body.what || '');
        if (what === 'meal') {
            if (need(p.goods.wheat >= CRAFT_MEAL_WHEAT, 'قمح غير كافي')) return;
            p.goods.wheat -= CRAFT_MEAL_WHEAT; p.foods.meal++;
        } else if (what.startsWith('ammo:')) {
            const k = what.slice(5);
            const cost = CRAFT_AMMO_IRON[k];
            if (need(cost && AMMOS[k], 'نوع غير معروف')) return;
            if (need(p.goods.iron >= cost, 'حديد غير كافي')) return;
            p.goods.iron -= cost; p.ammo[k]++;
        } else if (what.startsWith('weapon:')) {
            const i = Number(what.slice(7));
            const w = WEAPONS[i];
            if (need(w && i > p.weapon, 'سلاح غير متاح')) return;
            const cost = weaponIronCost(i);
            if (need(p.goods.iron >= cost, `محتاج ${cost} حديد`)) return;
            p.goods.iron -= cost; p.weapon = i;
        } else return json(res, 400, { error: 'غير معروف' });
        bumpStat(p, 'crafts', 1);
        if (what.startsWith('weapon:')) bumpStat(p, 'weaponsCrafted', 1);
        const mdc = checkMissions(p);
        mark(); save();
        return json(res, 200, { ok: true, missions: mdc });
    }
    if (P === '/api/supply' && req.method === 'POST') { // donate goods to your side's war effort
        const w = db.wars[body.warId];
        if (need(w, 'معركة غير موجودة')) return;
        resolveWar(w);
        if (need(!w.over, 'المعركة خلصت')) return;
        const supSide = warSide(p, w);
        if (need(supSide, 'مش طرف في المعركة دي — ولا حليف منادى')) return;
        const s = SUPPLY[body.kind];
        if (need(s, 'نوع تموين غير معروف')) return;
        if (body.kind === 'iron') {
            if (need(p.goods.iron >= s.amount, 'حديد غير كافي')) return;
            p.goods.iron -= s.amount;
        } else {
            if (need(p.ammo.heavy >= s.amount, 'ذخيرة ثقيلة غير كافية')) return;
            p.ammo.heavy -= s.amount;
        }
        if (supSide === 'att') { w.attDmg += s.points; const r = roundOf(w); r.poolAtt += s.points; r.tickAtt += s.points; }
        else { w.defDmg += s.points; const r = roundOf(w); r.poolDef += s.points; r.tickDef += s.points; }
        w.contrib[p.name] = (w.contrib[p.name] || 0) + s.points;
        w.sideOf[p.name] = supSide;
        logLine(`${p.name} زوّد الحرب بـ${s.amount} ${body.kind === 'iron' ? 'حديد' : 'ذخيرة ثقيلة'} (+${s.points} نقطة)`);
        bumpStat(p, 'supply', 1);
        const mdu = checkMissions(p);
        resolveWar(w); mark(); save();
        return json(res, 200, { ok: true, war: publicWar(w), missions: mdu });
    }

    if (P === '/api/order' && req.method === 'POST') { // president marks a battle with a damage order
        const w = db.wars[body.warId];
        if (need(w, 'معركة غير موجودة')) return;
        resolveWar(w);
        if (need(!w.over, 'المعركة خلصت')) return;
        if (need(p.country === w.from || p.country === w.to, 'دي مش معركة دولتك')) return;
        if (need(govOK(p, p.country, 'defense'), 'للرئيس أو وزير الدفاع بس')) return;
        const pr = Number(body.priority);
        if (need(ORDER_BONUS[pr], 'أولوية غير معروفة')) return;
        const cost = ORDER_COST[pr];
        if (need(home.treasury >= cost, 'الخزينة غير كافية')) return;
        home.treasury -= cost;
        w.orders[p.country] = { priority: pr, by: p.name, at: Date.now() };
        logLine(`قيادة ${DEFS[p.country].name} أصدرت أمر قتال +${Math.round(ORDER_BONUS[pr] * 100)}% في حرب ${regionName(w)}`);
        mark(); save();
        return json(res, 200, { ok: true, war: publicWar(w) });
    }

    // ---------- alliances: form, invite, leave, call into wars ----------
    if (P === '/api/alliance/create' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        if (need(!allianceOf(p.country), 'دولتك في تحالف بالفعل')) return;
        const name = String(body.name || '').trim().slice(0, 30);
        if (need(name.length >= 2, 'اسم التحالف قصير')) return;
        const a = { id: ++db.allySeq, name, leader: p.country, members: [p.country], pending: [] };
        db.alliances[a.id] = a;
        logLine(`${DEFS[p.country].name} أسست تحالف «${name}»`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/alliance/invite' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        const al = allianceOf(p.country);
        if (need(al, 'دولتك مش في تحالف')) return;
        const target = String(body.country || '');
        if (need(DEFS[target] && db.countries[target], 'دولة غير معروفة')) return;
        if (need(!al.members.includes(target) && !al.pending.includes(target), 'الدولة دي في التحالف أو مدعوة بالفعل')) return;
        if (need(!allianceOf(target), 'الدولة دي في تحالف تاني')) return;
        al.pending.push(target);
        logLine(`تحالف «${al.name}» دعا ${DEFS[target].name}`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/alliance/accept' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        const al = db.alliances[body.id];
        if (need(al, 'تحالف غير موجود')) return;
        if (need(al.pending.includes(p.country), 'مفيش دعوة لدولتك')) return;
        if (need(!allianceOf(p.country), 'دولتك في تحالف بالفعل')) return;
        al.pending = al.pending.filter(c => c !== p.country);
        al.members.push(p.country);
        logLine(`${DEFS[p.country].name} انضمت لتحالف «${al.name}»`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/alliance/decline' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        const al = db.alliances[body.id];
        if (need(al && al.pending.includes(p.country), 'مفيش دعوة لدولتك')) return;
        al.pending = al.pending.filter(c => c !== p.country);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/alliance/leave' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        const al = allianceOf(p.country);
        if (need(al, 'دولتك مش في تحالف')) return;
        al.members = al.members.filter(c => c !== p.country);
        if (!al.members.length) delete db.alliances[al.id];
        else if (al.leader === p.country) al.leader = al.members[0];
        logLine(`${DEFS[p.country].name} غادرت تحالف «${al.name}»`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/alliance/call' && req.method === 'POST') { // president calls allies into an active war
        const w = db.wars[body.warId];
        if (need(w, 'معركة غير موجودة')) return;
        resolveWar(w);
        if (need(!w.over, 'المعركة خلصت')) return;
        if (need(p.country === w.from || p.country === w.to, 'مش طرف في المعركة دي')) return;
        if (need(govOK(p, p.country, 'defense'), 'للرئيس أو وزير الدفاع بس')) return;
        const al = allianceOf(p.country);
        if (need(al && al.members.length > 1, 'مفيش حلفاء في التحالف')) return;
        if (need(!w.alliesCalled, 'الحلفاء اتحشدوا بالفعل')) return;
        w.alliesCalled = true;
        logLine(`${DEFS[p.country].name} نادت حلفاء «${al.name}» للحرب`);
        mark(); save();
        return json(res, 200, { ok: true, war: publicWar(w) });
    }

    // ---------- ministries: offices with real, server-enforced powers ----------
    if (P === '/api/country/appoint' && req.method === 'POST') { // president appoints a minister
        if (need(home.president === p.name, 'الرئيس بس اللي يعيّن الوزراء')) return;
        const office = String(body.office || '');
        if (need(OFFICES[office], 'منصب غير معروف')) return;
        const t = db.users[String(body.name || '')] && db.users[String(body.name || '')].player;
        if (need(t, 'لاعب غير موجود')) return;
        if (need(t.country === p.country, 'لازم يكون من مواطني دولتك')) return;
        if (need(t.name !== home.president, 'الرئيس مش بيتعيّن وزير')) return;
        if (need(!Object.values(home.offices).includes(t.name), 'اللاعب ده شاغل منصب بالفعل — لاعب واحد = منصب واحد')) return;
        home.offices[office] = t.name;
        clog(p.country, `${p.name} عيّن ${t.name} ${OFFICES[office]}`);
        logLine(`${t.name} أصبح ${OFFICES[office]} في ${DEFS[p.country].name}`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/country/dismiss' && req.method === 'POST') { // president dismisses a minister
        if (need(home.president === p.name, 'الرئيس بس')) return;
        const office = String(body.office || '');
        if (need(home.offices[office], 'المنصب ده فاضي أصلاً')) return;
        const old = home.offices[office];
        delete home.offices[office];
        clog(p.country, `${p.name} أقال ${old} من منصب ${OFFICES[office]}`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/country/tax' && req.method === 'POST') { // economy minister sets income tax %
        if (need(govOK(p, p.country, 'economy'), 'للرئيس أو وزير الاقتصاد بس')) return;
        const rate = Number(body.rate);
        if (need(Number.isFinite(rate) && rate >= 0 && rate <= 30, 'الضريبة بين 0% و 30%')) return;
        home.taxRate = rate / 100;
        clog(p.country, `${p.name} غيّر ضريبة الدخل لـ ${rate}%`);
        mark(); save();
        return json(res, 200, { ok: true, taxRate: rate });
    }
    if (P === '/api/country/devfund' && req.method === 'POST') { // economy minister funds a region's development
        if (need(govOK(p, p.country, 'economy'), 'للرئيس أو وزير الاقتصاد بس')) return;
        const r = DEFS[p.country].regions.find(r => r.id === body.regionId);
        if (need(r, 'إقليم غير معروف')) return;
        const amount = Math.min(Number(body.amount) || 0, Math.floor(home.treasury));
        if (need(amount >= 10, 'أقل مبلغ 10')) return;
        home.treasury -= amount;
        home.dev[r.id] = (home.dev[r.id] || 0) + amount;
        clog(p.country, `${p.name} خصص ${amount} ج من الخزينة لتنمية ${r.name}`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/country/enemy' && req.method === 'POST') { // foreign minister declares a sworn enemy (or clears it)
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        const target = String(body.country || '');
        if (target) {
            if (need(DEFS[target] && target !== p.country, 'دولة غير معروفة')) return;
            home.swornEnemy = target;
            clog(p.country, `${p.name} أعلن ${DEFS[target].name} عدوًا لدودًا`);
            logLine(`${DEFS[p.country].name} أعلنت ${DEFS[target].name} عدوًا لدودًا`);
        } else {
            home.swornEnemy = null;
            clog(p.country, `${p.name} سحب إعلان العدو اللدود`);
        }
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/country/suppress' && req.method === 'POST') { // interior minister spends treasury to calm a region we occupy
        if (need(govOK(p, p.country, 'interior'), 'للرئيس أو وزير الداخلية بس')) return;
        const [dcid] = String(body.regionId || '').split(':');
        if (db.countries[dcid]) ensureCountry(dcid);
        const def = db.countries[dcid];
        if (need(def && def.regions[body.regionId] === p.country, 'الإقليم ده مش محتل من دولتك')) return;
        const amount = Math.min(Number(body.amount) || 0, Math.floor(home.treasury));
        if (need(amount >= 10, 'أقل مبلغ 10')) return;
        home.treasury -= amount;
        def.resist[body.regionId] = Math.max(0, (def.resist[body.regionId] || 0) - amount / 10);
        clog(p.country, `${p.name} صرف ${amount} ج على تهدئة ${regionName({ to: dcid, regionId: body.regionId })}`);
        mark(); save();
        return json(res, 200, { ok: true, resist: Math.floor(def.resist[body.regionId]) });
    }
    if (P === '/api/war/peace' && req.method === 'POST') { // foreign ministry offers peace; other side accepts
        const w = db.wars[body.warId];
        if (need(w, 'معركة غير موجودة')) return;
        resolveWar(w);
        if (need(!w.over, 'المعركة خلصت')) return;
        const mySide = p.country === w.from ? 'att' : p.country === w.to ? 'def' : null;
        if (need(mySide, 'دي مش حرب دولتك')) return;
        if (need(govOK(p, p.country, 'foreign'), 'للرئيس أو وزير الخارجية بس')) return;
        if (!w.peaceOffer) {
            w.peaceOffer = { side: mySide, by: p.name };
            clog(p.country, `${p.name} عرض السلام في حرب ${regionName(w)}`);
            mark(); save();
            return json(res, 200, { ok: true, offered: true });
        }
        if (need(w.peaceOffer.side !== mySide, 'العرض من طرفكم — استنوا رد الطرف التاني')) return;
        w.over = 'lost'; // peace: defender keeps the region
        logLine(`سلام في حرب ${regionName(w)} — ${DEFS[w.to].name} احتفظت بالإقليم`);
        clog(w.from, `اتفاق سلام أنهى حرب ${regionName(w)}`);
        clog(w.to, `اتفاق سلام أنهى حرب ${regionName(w)}`);
        mark(); save();
        return json(res, 200, { ok: true, peace: true });
    }
    if (P === '/api/party/found' && req.method === 'POST') { // found a party in your country (500 ج)
        if (need(!home.parties.some(pt => pt.members.includes(p.name)), 'أنت في حزب بالفعل')) return;
        if (need(p.money >= 500, 'تأسيس حزب بـ 500 ج')) return;
        const name = String(body.name || '').trim().slice(0, 30);
        if (need(name.length >= 2, 'اسم الحزب قصير')) return;
        p.money -= 500;
        const colors = ['#7c4dff', '#00e5ff', '#ff3355', '#ffb300', '#4dff88', '#ff7ad9'];
        const pt = { id: ++home.partySeq, name, color: colors[home.parties.length % colors.length], members: [p.name] };
        home.parties.push(pt);
        clog(p.country, `${p.name} أسس حزب «${name}»`);
        mark(); save();
        return json(res, 200, { ok: true, party: pt });
    }
    if (P === '/api/party/join' && req.method === 'POST') {
        const pt = home.parties.find(pt => pt.id === Number(body.partyId));
        if (need(pt, 'حزب غير موجود')) return;
        for (const o of home.parties) o.members = o.members.filter(n => n !== p.name);
        pt.members.push(p.name);
        clog(p.country, `${p.name} انضم لحزب «${pt.name}»`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/unit/name' && req.method === 'POST') { // chief of staff renames the official unit
        if (need(govOK(p, p.country, 'staff'), 'للرئيس أو رئيس الأركان بس')) return;
        const name = String(body.name || '').trim().slice(0, 30);
        if (need(name.length >= 2, 'اسم قصير')) return;
        home.unit.name = name;
        clog(p.country, `${p.name} سمّى الوحدة الرسمية «${name}»`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/unit/focus' && req.method === 'POST') { // chief of staff points the unit at a battle
        if (need(govOK(p, p.country, 'staff'), 'للرئيس أو رئيس الأركان بس')) return;
        const w = db.wars[body.warId];
        if (need(w && !w.over, 'معركة غير موجودة')) return;
        home.unit.focusWar = w.id;
        clog(p.country, `${p.name} وجّه الوحدة لحرب ${regionName(w)}`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/unit/invite' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'staff'), 'للرئيس أو رئيس الأركان بس')) return;
        const t = db.users[String(body.name || '')] && db.users[String(body.name || '')].player;
        if (need(t && t.country === p.country, 'لاعب غير موجود في دولتك')) return;
        if (need(!home.unit.members.includes(t.name), 'في الوحدة بالفعل')) return;
        home.unit.members.push(t.name);
        clog(p.country, `${p.name} ضمّ ${t.name} للوحدة`);
        mark(); save();
        return json(res, 200, { ok: true });
    }
    if (P === '/api/unit/kick' && req.method === 'POST') {
        if (need(govOK(p, p.country, 'staff'), 'للرئيس أو رئيس الأركان بس')) return;
        const name = String(body.name || '');
        if (need(home.unit.members.includes(name), 'مش في الوحدة')) return;
        home.unit.members = home.unit.members.filter(n => n !== name);
        clog(p.country, `${p.name} طرد ${name} من الوحدة`);
        mark(); save();
        return json(res, 200, { ok: true });
    }

    // ---------- admin (his account only: the first registered account) ----------
    if (P === '/api/cheat' && req.method === 'POST') {
        if (need(p.admin, 'مش ليك')) return;
        const code = String(body.code || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (need(code === 'raad raad', 'كود غلط')) return;
        p.money += 100000;
        // max level + the skill points to max the whole tree
        const spent = Object.values(p.skills).reduce((a, l) => a + l * (l + 1) / 2, 0);
        const maxAll = SKILLS.length * (SKILL_MAX * (SKILL_MAX + 1) / 2); // 9 * 55 = 495
        p.level = LEVEL_MAX; p.xp = 0;
        p.skillPoints = Math.max(p.skillPoints, maxAll - spent);
        p.bars = { health: barMax(p, 'health'), hunger: barMax(p, 'hunger'), energy: barMax(p, 'energy') };
        for (const k of ['light', 'mid', 'heavy']) p.ammo[k] += 100;
        for (const k of ['bread', 'meal', 'feast']) p.foods[k] += 50;
        p.goods.iron += 500; p.goods.wheat += 500;
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
            migrateWar(w);
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

server.listen(PORT, '0.0.0.0', () => console.log('raad-war listening on', PORT));
