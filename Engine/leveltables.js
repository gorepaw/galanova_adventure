// =============================================================================
// CLASSIC WOW — PER-LEVEL STAT GAIN TABLES
// Source: Classic WoW client data (patch 1.12 / era)
//
// USAGE:
//   getStatsAtLevel(raceId, classId, level) → { str, agi, sta, int, spi }
//   addXpToInst(inst, amount) → { inst, levelUpLines }
//
// HOW IT WORKS:
//   finalStat = raceBase[stat] + classGainTables[classId][level-1][statIndex]
//   Level 1 gains are 0 — race base IS the level 1 value.
//   Gains are stored as cumulative arrays for O(1) lookup.
//   Each entry: [str, agi, sta, int, spi]
//
// DEPENDENCIES: Data/classes.json
// =============================================================================

"use strict";

const _classData = require('../Data/classes.json');

// =============================================================================
// DATA — loaded from Data/classes.json
// =============================================================================

const RACE_BASE_STATS  = Object.fromEntries(
  Object.entries(_classData.races).map(([id, r]) => [id, r.baseStats])
);
const CLASS_BASE_HP    = Object.fromEntries(
  Object.entries(_classData.classes).map(([id, c]) => [id, c.baseHp])
);
const CLASS_BASE_MP    = Object.fromEntries(
  Object.entries(_classData.classes).map(([id, c]) => [id, c.baseMana])
);
const CLASS_GAIN_TABLES = _classData.classGainTables;
const XP_TABLE          = _classData.xpTable;
const MAX_LEVEL         = _classData.maxLevel;
const CLASS_ABILITIES   = Object.fromEntries(
  Object.entries(_classData.classes).map(([id, c]) => [id, c.abilities || []])
);


// =============================================================================
// PUBLIC API
// =============================================================================

// Returns fully derived stats for a race/class/level combination.
const getStatsAtLevel = (raceId, classId, level) => {
  const base  = RACE_BASE_STATS[raceId];
  const table = CLASS_GAIN_TABLES[classId];
  if (!base)  throw new Error(`Unknown race: ${raceId}`);
  if (!table) throw new Error(`Unknown class: ${classId}`);
  const clampedLevel = Math.max(1, Math.min(level, MAX_LEVEL));
  const gains = table[clampedLevel - 1]; // index 0 = level 1
  return {
    str: base.str + gains[0],
    agi: base.agi + gains[1],
    sta: base.sta + gains[2],
    int: base.int + gains[3],
    spi: base.spi + gains[4],
  };
};

// Returns XP required to reach the next level from the given level.
const xpToNextLevel = (level) => {
  if (level >= MAX_LEVEL) return Infinity;
  return XP_TABLE[level - 1];
};

// Applies XP gain to a companion instance, levelling up as needed.
// Recalculates stats, maxHp, maxMp, and grants class abilities on each level-up.
// Returns { inst, levelUpLines } so the caller can emit level-up messages.
const addXpToInst = (inst, amount) => {
  let { xp, level } = inst;
  xp += amount;
  const levelUpLines = [];

  while (level < MAX_LEVEL && xp >= xpToNextLevel(level)) {
    xp    -= xpToNextLevel(level);
    level += 1;

    const newStats = getStatsAtLevel(inst.raceId, inst.classId, level);
    const newHp    = newStats.sta * 10 + (CLASS_BASE_HP[inst.classId] || 0);
    const newMp    = newStats.int * 15 + (CLASS_BASE_MP[inst.classId] || 0);

    const existing    = inst.learnedAbilities || [];
    const newAbilities = (CLASS_ABILITIES[inst.classId] || [])
      .filter(a => a.level === level && !existing.includes(a.id))
      .map(a => a.id);

    inst = {
      ...inst,
      stats:            { ...inst.stats, raw: newStats },
      maxHp:            newHp,
      maxMp:            newMp,
      currentHp:        inst.deathState !== 'alive' ? (inst.currentHp || 0) : newHp,
      currentMp:        inst.deathState !== 'alive' ? (inst.currentMp || 0) : newMp,
      learnedAbilities: [...existing, ...newAbilities],
    };

    levelUpLines.push(`  ✦ ${inst.name} reached level ${level}!`);
    for (const id of newAbilities) levelUpLines.push(`    ✧ Learned: ${id}`);
  }

  if (level >= MAX_LEVEL) xp = 0;

  return { inst: { ...inst, xp, level }, levelUpLines };
};

// Backward-compatible alias used by older callers and the self-test.
// Returns the updated instance only (no levelUpLines).
const addXp = (inst, amount) => addXpToInst(inst, amount).inst;

// Returns a summary of stat gains from levelA to levelB for display.
const statGainsBetween = (raceId, classId, fromLevel, toLevel) => {
  const a = getStatsAtLevel(raceId, classId, fromLevel);
  const b = getStatsAtLevel(raceId, classId, toLevel);
  return {
    str: b.str - a.str,
    agi: b.agi - a.agi,
    sta: b.sta - a.sta,
    int: b.int - a.int,
    spi: b.spi - a.spi,
  };
};


// =============================================================================
// SELF-TEST
// =============================================================================

const runStatTableTests = () => {
  const results = [];
  let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  // level 1 should equal race base exactly
  const orcWarL1 = getStatsAtLevel("orc", "warrior", 1);
  assert("Orc warrior L1 STR = race base", orcWarL1.str === RACE_BASE_STATS.orc.str);
  assert("Orc warrior L1 INT = race base", orcWarL1.int === RACE_BASE_STATS.orc.int);

  // warriors gain STR faster than mages
  const orcWarL20 = getStatsAtLevel("orc", "warrior", 20);
  const orcMagL20 = getStatsAtLevel("orc", "mage",    20);
  assert("Warrior STR > Mage STR at L20", orcWarL20.str > orcMagL20.str);
  assert("Mage INT > Warrior INT at L20", orcMagL20.int > orcWarL20.int);
  assert("Mage SPI > Warrior SPI at L20", orcMagL20.spi > orcWarL20.spi);

  // rogue should have highest AGI at 60
  const trollRogL60 = getStatsAtLevel("troll", "rogue",   60);
  const trollWarL60 = getStatsAtLevel("troll", "warrior", 60);
  assert("Rogue AGI > Warrior AGI at L60", trollRogL60.agi > trollWarL60.agi);

  // priest should have highest SPI at 60
  const trollPriL60 = getStatsAtLevel("troll", "priest", 60);
  const trollShaL60 = getStatsAtLevel("troll", "shaman", 60);
  assert("Priest SPI > Shaman SPI at L60", trollPriL60.spi > trollShaL60.spi);

  // XP table sanity
  assert("XP to L2 = 400",            xpToNextLevel(1)  === 400);
  assert("XP to L60 = 232800",        xpToNextLevel(59) === 232800);
  assert("XP at max level = Infinity", xpToNextLevel(60) === Infinity);

  // addXpToInst — level-up, stat recalc, hp/mp restore
  const inst = {
    instanceId: "test", name: "Thazz'ril",
    xp: 0, level: 1,
    raceId: "orc", classId: "warrior",
    currentHp: 100, maxHp: 100, currentMp: 0, maxMp: 0,
    stats: { raw: getStatsAtLevel("orc", "warrior", 1) },
  };
  const { inst: levelled, levelUpLines } = addXpToInst(inst, 400);
  assert("addXpToInst: levels up at threshold",    levelled.level === 2);
  assert("addXpToInst: rolls over remaining XP",   levelled.xp    === 0);
  assert("addXpToInst: updates stats on level-up", levelled.stats.raw.str >= inst.stats.raw.str);
  assert("addXpToInst: recalculates maxHp",        levelled.maxHp > inst.maxHp);
  assert("addXpToInst: restores currentHp to max", levelled.currentHp === levelled.maxHp);
  assert("addXpToInst: emits level-up line",        levelUpLines.length === 1);
  assert("addXpToInst: level-up line contains name", levelUpLines[0].includes("Thazz'ril"));

  // addXp alias still works
  const legacyInst = addXp(inst, 400);
  assert("addXp alias: levels up", legacyInst.level === 2);

  // CLASS_BASE_HP / CLASS_BASE_MP sanity
  assert("CLASS_BASE_HP warrior = 60",  CLASS_BASE_HP.warrior === 60);
  assert("CLASS_BASE_HP mage = 25",     CLASS_BASE_HP.mage    === 25);
  assert("CLASS_BASE_MP warrior = 0",   CLASS_BASE_MP.warrior === 0);
  assert("CLASS_BASE_MP priest = 80",   CLASS_BASE_MP.priest  === 80);

  // stat gains between levels
  const gains = statGainsBetween("orc", "warrior", 1, 10);
  assert("Warrior gains STR 1→10", gains.str > 0);
  assert("Warrior gains STA 1→10", gains.sta > 0);

  // all 9 classes have tables with correct length
  for (const cls of ["warrior","paladin","hunter","rogue","priest","shaman","mage","warlock","druid"]) {
    assert(`Gain table exists: ${cls}`,        !!CLASS_GAIN_TABLES[cls]);
    assert(`Gain table has 60 entries: ${cls}`, CLASS_GAIN_TABLES[cls].length === 60);
    assert(`CLASS_BASE_HP exists: ${cls}`,     CLASS_BASE_HP[cls] !== undefined);
    assert(`CLASS_BASE_MP exists: ${cls}`,     CLASS_BASE_MP[cls] !== undefined);
  }

  // all Kalimdor races have base stats
  for (const race of ["orc","troll","tauren","night_elf","draenei","goblin"]) {
    assert(`Race base stats exist: ${race}`, !!RACE_BASE_STATS[race]);
  }

  return { passed: p, failed: f, total: p + f, results };
};


if (typeof module !== "undefined") {
  module.exports = {
    RACE_BASE_STATS,
    CLASS_BASE_HP,
    CLASS_BASE_MP,
    CLASS_GAIN_TABLES,
    XP_TABLE,
    MAX_LEVEL,
    getStatsAtLevel,
    xpToNextLevel,
    addXpToInst,
    addXp,
    statGainsBetween,
    runStatTableTests,
  };
}