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
// DEPENDENCIES: Data/classes.json, Data/races.json, Engine/skills.ts
// =============================================================================

import type { ClassesData, RacesData, ClassDef, RaceDef, StatKey, Skills } from "./types/data.js";
import { startingSkills } from "./skills.js";

const _classData = require("../Data/classes.json") as ClassesData;
const _raceData = require("../Data/races.json") as RacesData;

const CLASSES: Record<string, ClassDef> = _classData.classes || {};
export const MAX_LEVEL: number = _classData.maxLevel || 99;
export const POINTS_PER_LEVEL = 5;
export const STAT_KEYS: StatKey[] = ["str", "dex", "con", "int", "spi", "wis", "spd", "cha"];

// XP curve: xp to go from level L to L+1 lives at index L-1. Generated as a
// quadratic unless classes.json supplies an explicit xpTable.
export const XP_TABLE: number[] = (Array.isArray(_classData.xpTable) && _classData.xpTable.length)
  ? _classData.xpTable
  : Array.from({ length: MAX_LEVEL }, (_, i) => 100 * (i + 1) * (i + 2));

// --- legacy/compat exports -------------------------------------------------
// Gain tables and race base stats are retired under stat-point allocation.
// Kept as empty maps so older callers using CLASS_BASE_HP[classId] || 0 still
// resolve to 0 (HP now derives purely from con, mana from int).
export const RACE_BASE_STATS: Record<string, RaceDef> = _raceData.races || {};
export const CLASS_BASE_HP: Record<string, number> = {};
export const CLASS_BASE_MP: Record<string, number> = {};
export const CLASS_GAIN_TABLES: Record<string, unknown> = {};

// A loose instance shape — these helpers run on full CompanionInstances and on
// bare fixtures alike, so they only constrain the fields they touch.
type LevelInst = {
  instanceId?: string;
  templateId?: string;
  name?: string;
  classId?: string;
  raceId?: string | null;
  xp?: number;
  level?: number;
  unspentStatPoints?: number;
  stats?: { raw?: Record<string, number> };
  skills?: Skills;
  unlockedSkills?: string[];
  maxHp?: number;
  maxMp?: number;
  currentHp?: number;
  currentMp?: number;
  deathState?: string;
  permadead?: boolean;
  [key: string]: unknown;
};

interface NewInstanceOpts {
  templateId?: string;
  name?: string;
  raceId?: string | null;
}

// =============================================================================
// CORE
// =============================================================================

const emptyStats = (): Record<string, number> => ({ str: 0, dex: 0, con: 0, int: 0, spi: 0, wis: 0, spd: 0, cha: 0 });

export const startingStats = (classId: string): Record<string, number> => {
  const cls = CLASSES[classId];
  if (!cls) throw new Error(`Unknown class: ${classId}`);
  return { ...emptyStats(), ...(cls.startingBaseline || {}) };
};

const guaranteedFor = (classId: string): Partial<Record<StatKey, number>> =>
  (CLASSES[classId] && CLASSES[classId].guaranteedLevelUp) || {};

// Flat racial stat modifiers (e.g. Sephir: -1 str, -1 con, +2 int).
export const raceStatMod = (raceId: string | null | undefined): Partial<Record<StatKey, number>> =>
  (raceId && RACE_BASE_STATS[raceId] && RACE_BASE_STATS[raceId].statMod) || {};

export const freePointsPerLevel = (classId: string): number => {
  const used = Object.values(guaranteedFor(classId)).reduce((s: number, n) => s + (n ?? 0), 0);
  return Math.max(0, POINTS_PER_LEVEL - used);
};

// Baseline + guaranteed×(level-1). Excludes player-allocated free points (those
// live on the instance). Used for display and for generic (non-instance) units.
export const guaranteedStatsAtLevel = (classId: string, level: number): Record<string, number> => {
  const cls = CLASSES[classId];
  if (!cls) return emptyStats(); // tolerant: unknown/legacy class → zeroed stats
  const out: Record<string, number> = { ...emptyStats(), ...(cls.startingBaseline || {}) };
  const g   = cls.guaranteedLevelUp || {};
  const lv  = Math.max(1, Math.min(level, MAX_LEVEL));
  for (const [stat, pts] of Object.entries(g))
    if (stat in out) out[stat] += (pts ?? 0) * (lv - 1);
  return out;
};

// Back-compat signature getStatsAtLevel(raceId, classId, level). raceId is
// ignored (races are decoupled from stats).
export const getStatsAtLevel = (_raceId: string | null, classId: string, level: number): Record<string, number> =>
  guaranteedStatsAtLevel(classId, level);

export const xpToNextLevel = (level: number): number => (level >= MAX_LEVEL ? Infinity : XP_TABLE[level - 1]);

const deriveHpMp = (raw: Record<string, number>, level = 1): { maxHp: number; maxMp: number } =>
  ({ maxHp: (raw.con || 0) * 10 + (level || 1) * 20, maxMp: (raw.int || 0) * 15 });

// Build a unit's resource pools from its class's resource list (mix-and-match).
// mana scales with the unit's mana pool; the others use fixed pools.
const _resourcePool = (resId: string, maxMana: number): { current: number; max: number } | null => {
  switch (resId) {
    case "mana":         return { current: maxMana, max: maxMana };
    case "rage":         return { current: 0,   max: 100 };
    case "stamina":      return { current: 100, max: 100 };
    case "combo_points": return { current: 0,   max: 5 };
    default:             return null;
  }
};
export const buildResources = (classId: string, maxMana = 0): Record<string, { current: number; max: number }> => {
  const out: Record<string, { current: number; max: number }> = {};
  const list = (CLASSES[classId] && CLASSES[classId].resources) || ["mana"];
  for (const r of list) { const pool = _resourcePool(r, maxMana); if (pool) out[r] = pool; }
  return out;
};

// Initialise a brand-new character instance for a class at level 1.
export const newInstance = (instanceId: string, classId: string, opts: NewInstanceOpts = {}): LevelInst => {
  const raw = startingStats(classId);
  // apply flat racial stat modifiers
  for (const [k, v] of Object.entries(raceStatMod(opts.raceId))) raw[k] = (raw[k] || 0) + (v ?? 0);
  const { maxHp, maxMp } = deriveHpMp(raw, 1);
  return {
    instanceId, templateId: opts.templateId || instanceId,
    name: opts.name || (CLASSES[classId] && CLASSES[classId].name) || classId,
    classId, raceId: opts.raceId || null,
    xp: 0, level: 1, unspentStatPoints: 0,
    stats: { raw },
    skills: startingSkills(classId),
    unlockedSkills: [],
    maxHp, maxMp, currentHp: maxHp, currentMp: maxMp,
    deathState: "alive",
  };
};

// Apply XP, levelling up (capped at MAX_LEVEL). Each level gained auto-applies
// the class's guaranteed points to stats.raw and adds the free points to
// unspentStatPoints.
export const addXpToInst = (inst: LevelInst, amount: number): { inst: LevelInst; levelUpLines: string[] } => {
  let xp    = inst.xp || 0;
  let level = inst.level || 1;
  const raw = { ...emptyStats(), ...((inst.stats && inst.stats.raw) || guaranteedStatsAtLevel(inst.classId || "", 1)) };
  let unspent = inst.unspentStatPoints || 0;
  const g    = guaranteedFor(inst.classId || "");
  const free = freePointsPerLevel(inst.classId || "");
  const levelUpLines: string[] = [];

  xp += amount;
  while (level < MAX_LEVEL && xp >= xpToNextLevel(level)) {
    xp    -= xpToNextLevel(level);
    level += 1;
    for (const [stat, pts] of Object.entries(g)) if (stat in raw) raw[stat] += (pts ?? 0);
    unspent += free;
    levelUpLines.push(`  ✦ ${inst.name || inst.instanceId} reached level ${level}!`);
    if (free > 0) levelUpLines.push(`    ✧ ${free} stat point${free === 1 ? "" : "s"} to allocate`);
  }
  if (level >= MAX_LEVEL) xp = 0;

  const { maxHp, maxMp } = deriveHpMp(raw, level);
  const alive = inst.deathState !== "downed" && inst.deathState !== "dead" && !inst.permadead;
  // Preserve current HP/MP across XP gains so damage carries between fights. A
  // level-up heals only by the amount max increased (a reward, not a full restore);
  // a fresh instance with no currentHp yet starts full.
  const prevMaxHp = inst.maxHp ?? maxHp;
  const prevMaxMp = inst.maxMp ?? maxMp;
  const curHp = inst.currentHp ?? maxHp;
  const curMp = inst.currentMp ?? maxMp;
  const out: LevelInst = {
    ...inst, xp, level, unspentStatPoints: unspent,
    stats: { ...inst.stats, raw }, maxHp, maxMp,
    currentHp: alive ? Math.min(maxHp, curHp + Math.max(0, maxHp - prevMaxHp)) : (inst.currentHp || 0),
    currentMp: alive ? Math.min(maxMp, curMp + Math.max(0, maxMp - prevMaxMp)) : (inst.currentMp || 0),
  };
  return { inst: out, levelUpLines };
};

export const addXp = (inst: LevelInst, amount: number): LevelInst => addXpToInst(inst, amount).inst;

// Allocate n unspent stat points into a stat (clamped to available points).
export const allocateStat = (inst: LevelInst, stat: string, n = 1): LevelInst => {
  if (!STAT_KEYS.includes(stat as StatKey)) return inst;
  const spend = Math.max(0, Math.min(n, inst.unspentStatPoints || 0));
  if (spend <= 0) return inst;
  const raw = { ...emptyStats(), ...((inst.stats && inst.stats.raw) || {}) };
  raw[stat] = (raw[stat] || 0) + spend;
  const { maxHp, maxMp } = deriveHpMp(raw, inst.level || 1);
  return {
    ...inst,
    stats: { ...inst.stats, raw },
    unspentStatPoints: (inst.unspentStatPoints || 0) - spend,
    maxHp, maxMp,
  };
};

// Difference in guaranteed stats between two levels (for display).
export const statGainsBetween = (_raceId: string | null, classId: string, fromLevel: number, toLevel: number): Record<string, number> => {
  const a = guaranteedStatsAtLevel(classId, fromLevel);
  const b = guaranteedStatsAtLevel(classId, toLevel);
  const out: Record<string, number> = {};
  for (const k of STAT_KEYS) out[k] = (b[k] || 0) - (a[k] || 0);
  return out;
};

// =============================================================================
// SELF-TEST
// =============================================================================

interface TestResult { ok: boolean; label: string; }

export const runStatTableTests = (): { passed: number; failed: number; total: number; results: TestResult[] } => {
  const results: TestResult[] = [];
  let p = 0, f = 0;
  const assert = (label: string, cond: unknown) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

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
  assert("newInstance HP = con*10 + lv*20", inst.maxHp === inst.stats!.raw!.con * 10 + inst.level! * 20);
  const { inst: lvl2, levelUpLines } = addXpToInst(inst, 200);
  assert("addXpToInst: reaches L2", lvl2.level === 2);
  assert("addXpToInst: grants 2 unspent points", lvl2.unspentStatPoints === 2);
  assert("addXpToInst: guaranteed dex applied", lvl2.stats!.raw!.dex === inst.stats!.raw!.dex + 1);
  assert("addXpToInst: emits level-up line", levelUpLines.length >= 1);

  // allocation
  const allocated = allocateStat(lvl2, "str", 2);
  assert("allocateStat: spends points", allocated.unspentStatPoints === 0);
  assert("allocateStat: raises stat", allocated.stats!.raw!.str === lvl2.stats!.raw!.str + 2);
  const over = allocateStat(allocated, "str", 5);
  assert("allocateStat: cannot overspend", over.unspentStatPoints === 0 && over.stats!.raw!.str === allocated.stats!.raw!.str);

  // all 5 classes present & well-formed
  for (const id of ["armsman", "illusionist", "elementalist", "assassin", "survivalist"]) {
    assert(`Class exists: ${id}`, !!CLASSES[id]);
    assert(`Class ${id} has startingBaseline`, !!CLASSES[id].startingBaseline);
    assert(`Class ${id} guaranteed sums 1–3`, (() => {
      const s = Object.values(CLASSES[id].guaranteedLevelUp).reduce((a: number, b) => a + (b ?? 0), 0);
      return s >= 1 && s <= 3;
    })());
  }

  return { passed: p, failed: f, total: p + f, results };
};
