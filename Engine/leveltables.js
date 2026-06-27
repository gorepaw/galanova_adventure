// =============================================================================
// PROGRESSION — STAT-POINT ALLOCATION (Galanova)
//
// Replaces the old WoW per-level gain tables. Each character starts from its
// class's generated startingBaseline (level 1). Every level-up (2..99) grants
// 5 stat points: the class auto-allocates its guaranteedLevelUp (1–3) to its
// core stats, and the remaining points become unspentStatPoints the player
// allocates freely into any of the 8 stats.
//
// USAGE:
//   startingStats(classId)                    → level-1 stat block
//   guaranteedStatsAtLevel(classId, level)    → baseline + guaranteed×(level-1)
//   addXpToInst(inst, amount)                 → { inst, levelUpLines }
//   allocateStat(inst, stat, n)               → inst (spends unspent points)
//
// DEPENDENCIES: Data/classes.json
// =============================================================================

"use strict";

const _classData = require('../Data/classes.json');

const CLASSES          = _classData.classes || {};
const MAX_LEVEL        = _classData.maxLevel || 99;
const POINTS_PER_LEVEL = 5;
const STAT_KEYS        = ["str", "dex", "con", "int", "spi", "wis", "spd", "cha"];

// XP curve: xp to go from level L to L+1 lives at index L-1. Generated as a
// quadratic unless classes.json supplies an explicit xpTable.
const XP_TABLE = (Array.isArray(_classData.xpTable) && _classData.xpTable.length)
  ? _classData.xpTable
  : Array.from({ length: MAX_LEVEL }, (_, i) => 100 * (i + 1) * (i + 2));

// --- legacy/compat exports -------------------------------------------------
// Gain tables and race base stats are retired under stat-point allocation.
// Kept as empty maps so older callers using CLASS_BASE_HP[classId] || 0 still
// resolve to 0 (HP now derives purely from con, mana from int).
const RACE_BASE_STATS   = _classData.races || {};
const CLASS_BASE_HP     = {};
const CLASS_BASE_MP     = {};
const CLASS_GAIN_TABLES = {};

// =============================================================================
// CORE
// =============================================================================

const emptyStats = () => ({ str: 0, dex: 0, con: 0, int: 0, spi: 0, wis: 0, spd: 0, cha: 0 });

const startingStats = (classId) => {
  const cls = CLASSES[classId];
  if (!cls) throw new Error(`Unknown class: ${classId}`);
  return { ...emptyStats(), ...(cls.startingBaseline || {}) };
};

const guaranteedFor = (classId) =>
  (CLASSES[classId] && CLASSES[classId].guaranteedLevelUp) || {};

// Flat racial stat modifiers (e.g. Sephir: -1 str, -1 con, +2 int).
const raceStatMod = (raceId) =>
  (raceId && RACE_BASE_STATS[raceId] && RACE_BASE_STATS[raceId].statMod) || {};

const freePointsPerLevel = (classId) => {
  const used = Object.values(guaranteedFor(classId)).reduce((s, n) => s + n, 0);
  return Math.max(0, POINTS_PER_LEVEL - used);
};

// Baseline + guaranteed×(level-1). Excludes player-allocated free points (those
// live on the instance). Used for display and for generic (non-instance) units.
const guaranteedStatsAtLevel = (classId, level) => {
  const cls = CLASSES[classId];
  if (!cls) return emptyStats(); // tolerant: unknown/legacy class → zeroed stats
  const out = { ...emptyStats(), ...(cls.startingBaseline || {}) };
  const g   = cls.guaranteedLevelUp || {};
  const lv  = Math.max(1, Math.min(level, MAX_LEVEL));
  for (const [stat, pts] of Object.entries(g))
    if (stat in out) out[stat] += pts * (lv - 1);
  return out;
};

// Back-compat signature getStatsAtLevel(raceId, classId, level). raceId is
// ignored (races are decoupled from stats).
const getStatsAtLevel = (raceId, classId, level) => guaranteedStatsAtLevel(classId, level);

const xpToNextLevel = (level) => (level >= MAX_LEVEL ? Infinity : XP_TABLE[level - 1]);

const deriveHpMp = (raw) => ({ maxHp: (raw.con || 0) * 10, maxMp: (raw.int || 0) * 15 });

// Build a unit's resource pools from its class's resource list (mix-and-match).
// mana scales with the unit's mana pool; the others use fixed pools.
const _resourcePool = (resId, maxMana) => {
  switch (resId) {
    case "mana":         return { current: maxMana, max: maxMana };
    case "rage":         return { current: 0,   max: 100 };
    case "stamina":      return { current: 100, max: 100 };
    case "combo_points": return { current: 0,   max: 5 };
    default:             return null;
  }
};
const buildResources = (classId, maxMana = 0) => {
  const out  = {};
  const list = (CLASSES[classId] && CLASSES[classId].resources) || ["mana"];
  for (const r of list) { const pool = _resourcePool(r, maxMana); if (pool) out[r] = pool; }
  return out;
};

// Initialise a brand-new character instance for a class at level 1.
const newInstance = (instanceId, classId, opts = {}) => {
  const raw = startingStats(classId);
  // apply flat racial stat modifiers
  for (const [k, v] of Object.entries(raceStatMod(opts.raceId))) raw[k] = (raw[k] || 0) + v;
  const { maxHp, maxMp } = deriveHpMp(raw);
  return {
    instanceId, templateId: opts.templateId || instanceId,
    name: opts.name || (CLASSES[classId] && CLASSES[classId].name) || classId,
    classId, raceId: opts.raceId || null,
    xp: 0, level: 1, unspentStatPoints: 0,
    stats: { raw },
    // class skills at level 1 (startingSkills injected globally by skills.js)
    skills: (typeof startingSkills === "function") ? startingSkills(classId) : {},
    unlockedSkills: [],
    maxHp, maxMp, currentHp: maxHp, currentMp: maxMp,
    deathState: "alive",
  };
};

// Apply XP, levelling up (capped at MAX_LEVEL). Each level gained auto-applies
// the class's guaranteed points to stats.raw and adds the free points to
// unspentStatPoints.
const addXpToInst = (inst, amount) => {
  let xp    = inst.xp || 0;
  let level = inst.level || 1;
  const raw = { ...emptyStats(), ...((inst.stats && inst.stats.raw) || guaranteedStatsAtLevel(inst.classId, 1)) };
  let unspent = inst.unspentStatPoints || 0;
  const g    = guaranteedFor(inst.classId);
  const free = freePointsPerLevel(inst.classId);
  const levelUpLines = [];

  xp += amount;
  while (level < MAX_LEVEL && xp >= xpToNextLevel(level)) {
    xp    -= xpToNextLevel(level);
    level += 1;
    for (const [stat, pts] of Object.entries(g)) if (stat in raw) raw[stat] += pts;
    unspent += free;
    levelUpLines.push(`  ✦ ${inst.name || inst.instanceId} reached level ${level}!`);
    if (free > 0) levelUpLines.push(`    ✧ ${free} stat point${free === 1 ? "" : "s"} to allocate`);
  }
  if (level >= MAX_LEVEL) xp = 0;

  const { maxHp, maxMp } = deriveHpMp(raw);
  const alive = inst.deathState !== "downed" && inst.deathState !== "dead" && !inst.permadead;
  const out = {
    ...inst, xp, level, unspentStatPoints: unspent,
    stats: { ...inst.stats, raw }, maxHp, maxMp,
    currentHp: alive ? maxHp : (inst.currentHp || 0),
    currentMp: alive ? maxMp : (inst.currentMp || 0),
  };
  return { inst: out, levelUpLines };
};

const addXp = (inst, amount) => addXpToInst(inst, amount).inst;

// Allocate n unspent stat points into a stat (clamped to available points).
const allocateStat = (inst, stat, n = 1) => {
  if (!STAT_KEYS.includes(stat)) return inst;
  const spend = Math.max(0, Math.min(n, inst.unspentStatPoints || 0));
  if (spend <= 0) return inst;
  const raw = { ...emptyStats(), ...((inst.stats && inst.stats.raw) || {}) };
  raw[stat] = (raw[stat] || 0) + spend;
  const { maxHp, maxMp } = deriveHpMp(raw);
  return {
    ...inst,
    stats: { ...inst.stats, raw },
    unspentStatPoints: (inst.unspentStatPoints || 0) - spend,
    maxHp, maxMp,
  };
};

// Difference in guaranteed stats between two levels (for display).
const statGainsBetween = (raceId, classId, fromLevel, toLevel) => {
  const a = guaranteedStatsAtLevel(classId, fromLevel);
  const b = guaranteedStatsAtLevel(classId, toLevel);
  const out = {};
  for (const k of STAT_KEYS) out[k] = (b[k] || 0) - (a[k] || 0);
  return out;
};

// =============================================================================
// SELF-TEST
// =============================================================================

const runStatTableTests = () => {
  const results = [];
  let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  // starting baseline
  const arms1 = startingStats("armsman");
  assert("Armsman L1 dex = baseline 15", arms1.dex === 15);
  assert("Armsman L1 has all 8 stats", STAT_KEYS.every(k => typeof arms1[k] === "number"));

  // guaranteed allocation
  assert("Armsman free pts/level = 2", freePointsPerLevel("armsman") === 2);
  assert("Illusionist free pts/level = 3", freePointsPerLevel("illusionist") === 3);
  assert("Elementalist free pts/level = 2", freePointsPerLevel("elementalist") === 2);
  const arms2 = guaranteedStatsAtLevel("armsman", 2);
  assert("Armsman L2 dex = 16 (guaranteed +1)", arms2.dex === arms1.dex + 1);
  assert("Armsman L2 con = 16 (guaranteed +1)", arms2.con === arms1.con + 1);
  assert("Armsman L2 str unchanged (not core)", arms2.str === arms1.str);

  // xp curve / cap
  assert("MAX_LEVEL = 99", MAX_LEVEL === 99);
  assert("xpToNextLevel(1) = 200", xpToNextLevel(1) === 200);
  assert("xpToNextLevel(99) = Infinity", xpToNextLevel(99) === Infinity);

  // level-up via xp
  const inst = newInstance("test_arms", "armsman", { name: "Tester" });
  assert("newInstance starts at L1", inst.level === 1);
  assert("newInstance HP = con*10", inst.maxHp === inst.stats.raw.con * 10);
  const { inst: lvl2, levelUpLines } = addXpToInst(inst, 200);
  assert("addXpToInst: reaches L2", lvl2.level === 2);
  assert("addXpToInst: grants 2 unspent points", lvl2.unspentStatPoints === 2);
  assert("addXpToInst: guaranteed dex applied", lvl2.stats.raw.dex === inst.stats.raw.dex + 1);
  assert("addXpToInst: emits level-up line", levelUpLines.length >= 1);

  // allocation
  const allocated = allocateStat(lvl2, "str", 2);
  assert("allocateStat: spends points", allocated.unspentStatPoints === 0);
  assert("allocateStat: raises stat", allocated.stats.raw.str === lvl2.stats.raw.str + 2);
  const over = allocateStat(allocated, "str", 5);
  assert("allocateStat: cannot overspend", over.unspentStatPoints === 0 && over.stats.raw.str === allocated.stats.raw.str);

  // all 5 classes present & well-formed
  for (const id of ["armsman", "illusionist", "elementalist", "assassin", "survivalist"]) {
    assert(`Class exists: ${id}`, !!CLASSES[id]);
    assert(`Class ${id} has startingBaseline`, !!CLASSES[id].startingBaseline);
    assert(`Class ${id} guaranteed sums 1–3`, (() => {
      const s = Object.values(CLASSES[id].guaranteedLevelUp).reduce((a, b) => a + b, 0);
      return s >= 1 && s <= 3;
    })());
  }

  return { passed: p, failed: f, total: p + f, results };
};

if (typeof module !== "undefined") {
  module.exports = {
    // legacy/compat
    RACE_BASE_STATS, CLASS_BASE_HP, CLASS_BASE_MP, CLASS_GAIN_TABLES,
    XP_TABLE, MAX_LEVEL,
    getStatsAtLevel, xpToNextLevel, addXpToInst, addXp, statGainsBetween,
    // allocation API
    STAT_KEYS, POINTS_PER_LEVEL,
    startingStats, guaranteedStatsAtLevel, freePointsPerLevel, raceStatMod,
    allocateStat, newInstance, buildResources,
    runStatTableTests,
  };
}
