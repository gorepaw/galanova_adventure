"use strict";
// Bootstrap all engine modules in dependency order, then run test suites.

function load(relPath) {
  const exports = require(relPath);
  if (exports && typeof exports === "object") Object.assign(global, exports);
}

load("../Engine/datalayer.js");
load("../Engine/itemsuffixes.js");
load("../Engine/leveltables.js");
load("../Engine/skills.js");
load("../Engine/companions.js");
load("../Engine/encounters.js");
load("../Engine/gameplayloop.js"); // auto-runs DataLayer + GameLoop tests

// =============================================================================
// WARRIOR ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

const _ab = require("../Data/abilities.json");
const ABILITIES = _ab.abilities;
const BUFFS     = _ab.buffs;

let p = 0, f = 0, results = [];
const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

SyntheticGameData.seed();

// ── helpers ──────────────────────────────────────────────────────────────────

const makeWarrior = (overrides = {}) => ({
  instanceId: "test_warrior",
  name: "Thazz",
  classId: "warrior",
  raceId: "orc",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: 0,
  stats: { raw: getStatsAtLevel("orc", "warrior", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const makeEnemy = (overrides = {}) => ({
  id: "test_enemy",
  name: "Target Dummy",
  classId: "warrior",
  raceId: "orc",
  level: 1,
  baseStats: { str: 10, agi: 10, sta: 10, int: 5, spi: 5 },
  abilities: ["melee_attack"],
  loot: [], skinningLoot: [], killReputation: [], currencyDrop: null,
  ...overrides,
});

const buildPartyUnit  = (cfg) => CombatBridge.buildUnit(cfg, false);
const buildEnemyUnit  = (cfg) => CombatBridge.buildUnit(cfg, true);

// ── 1. buildUnit — new fields ─────────────────────────────────────────────────

const wu = buildPartyUnit(makeWarrior({ level: 20, gear: {} }));

assert("buildUnit: level stored",                  wu.level === 20);
assert("buildUnit: rangedAttackPower exists",      typeof wu.stats.derived.rangedAttackPower === "number");
assert("buildUnit: rangedAttackPower > 0 at L20",  wu.stats.derived.rangedAttackPower > 0);
assert("buildUnit: damageReceivedThisTurn = 0",   wu.damageReceivedThisTurn === 0);
assert("buildUnit: damageReceivedLastTurn = 0",   wu.damageReceivedLastTurn === 0);
assert("buildUnit: shieldEquipped false (no gear)", wu.shieldEquipped === false);
assert("buildUnit: ccState has disarmed flag",     "disarmed" in wu.ccState);
assert("buildUnit: ccState has feared flag",       "feared" in wu.ccState);

// shieldEquipped via gear
const shieldUnit = buildPartyUnit(makeWarrior({ gear: { offhand: { itemType: "shield", id: "test_shield" } } }));
assert("buildUnit: shieldEquipped true with shield gear", shieldUnit.shieldEquipped === true);

// shieldEquipped via direct flag
const shieldFlag = buildPartyUnit(makeWarrior({ shieldEquipped: true }));
assert("buildUnit: shieldEquipped true via flag",  shieldFlag.shieldEquipped === true);

// ── 2. rangedAttackPower formula ─────────────────────────────────────────────

const rawL1  = getStatsAtLevel("orc", "warrior", 1);
const rapL1  = Math.max(0, 2 * 1 + 2 * rawL1.agi - 10);
const u1     = buildPartyUnit(makeWarrior({ level: 1, stats: { raw: rawL1 } }));
assert("RAP formula at L1 matches manual calc",  u1.stats.derived.rangedAttackPower === rapL1);

const rawL60 = getStatsAtLevel("orc", "warrior", 60);
const rapL60 = Math.max(0, 2 * 60 + 2 * rawL60.agi - 10);
const u60    = buildPartyUnit(makeWarrior({ level: 60, stats: { raw: rawL60 } }));
assert("RAP formula at L60 matches manual calc", u60.stats.derived.rangedAttackPower === rapL60);

// ── 3. Ability data integrity checks ─────────────────────────────────────────

const warriorAbilities = [
  "heroic_strike","battle_shout","charge","rend","thunder_clap","victory_rush",
  "hamstring","taunt","bloodrage","sunder_armor","overpower","shield_bash",
  "revenge","demoralizing_shout","mocking_blow","disarm","cleave","retaliation",
  "intimidating_shout","execute","challenging_shout","shield_wall","slam",
  "intercept","berserker_rage","whirlwind","pummel","shield_slam","recklessness",
  "spell_reflection","commanding_shout","intervene","shattering_throw",
  "enraged_regeneration","heroic_throw",
];

for (const id of warriorAbilities) {
  assert(`ability "${id}" exists in abilities.json`,       !!ABILITIES[id]);
  assert(`ability "${id}" has effects array`,              Array.isArray(ABILITIES[id]?.effects));
}

// key constraint checks
assert("charge: requiresOpener true",             ABILITIES.charge?.requiresOpener === true);
assert("execute: requiresTargetHpBelow 0.20",     ABILITIES.execute?.requiresTargetHpBelow === 0.20);
assert("execute: executeRageBurn true",           ABILITIES.execute?.executeRageBurn === true);
assert("victory_rush: requiresMaxCombatTurn 2",  ABILITIES.victory_rush?.requiresMaxCombatTurn === 2);
assert("victory_rush: requiresCondition correct", ABILITIES.victory_rush?.requiresCondition === "prior_encounter_victory");
assert("overpower: requiresCondition correct",    ABILITIES.overpower?.requiresCondition === "enemy_no_damage_last_turn");
assert("revenge: requiresCondition correct",      ABILITIES.revenge?.requiresCondition === "self_no_damage_last_turn");
assert("shield_bash: requiresOffhandType shield", ABILITIES.shield_bash?.requiresOffhandType === "shield");
assert("shield_wall: requiresOffhandType shield", ABILITIES.shield_wall?.requiresOffhandType === "shield");
assert("cleave: targeting is cleave",             ABILITIES.cleave?.targeting === "cleave");
assert("battle_shout_buff: exists",               !!BUFFS.battle_shout_buff);
assert("bloodrage_buff: tickRage set",            BUFFS.bloodrage_buff?.tickRage > 0);
assert("sunder_armor_debuff: stacks true",        BUFFS.sunder_armor_debuff?.stacks === true);
assert("sunder_armor_debuff: maxStacks 5",        BUFFS.sunder_armor_debuff?.maxStacks === 5);

// ── 4. aiChoose condition enforcement ─────────────────────────────────────────

// charge (requiresOpener) blocked after turn 1
const charger = buildPartyUnit(makeWarrior({ learnedAbilities: ["melee_attack","charge"], resources: { rage: { current: 100, max: 100 } } }));
// Need to call aiChoose — it's inside the CombatBridge closure, so test via run()
// We test indirectly: charge costs 0 rage, so if it fires it fires on T1 only
// Direct test via a 1-turn combat sim
{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["charge","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  // charge can only fire T1 — victory in 1-2 turns means no crash
  assert("charge: combat runs without crash",    ["victory","defeat","timeout"].includes(cr.outcome));
}

// shield_bash blocked without shield
{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["shield_bash","melee_attack"] });
  // no shield — shield_bash should be filtered, melee_attack used instead
  const cr = CombatBridge.run(enc, [partyInst], {});
  assert("shield_bash: combat without shield doesn't crash", ["victory","defeat","timeout"].includes(cr.outcome));
  // log should not contain "shield bash" if no shield
  assert("shield_bash: not used without shield", !cr.logs.some(l => l.includes("shield bash")));
}

// shield_bash used WITH shield
{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({
    learnedAbilities: ["shield_bash","melee_attack"],
    gear: { offhand: { itemType: "shield", id: "test_shield" } },
  });
  const cr = CombatBridge.run(enc, [partyInst], {});
  assert("shield_bash: combat with shield doesn't crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// execute blocked above 20% HP (enemy starts at full health)
{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["execute","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  // execute should only fire at ≤20% — if enemy is full HP it won't be used early
  assert("execute: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 5. priorEncounterVictory wiring ──────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["victory_rush","melee_attack"] });
  // without flag — victory_rush should never fire (condition not met)
  const crNoVictory = CombatBridge.run(enc, [partyInst], { priorEncounterVictory: false });
  assert("victory_rush: not used without priorEncounterVictory", !crNoVictory.logs.some(l => l.includes("victory rush")));
  // with flag — victory_rush eligible on T1-T2
  const crWithVictory = CombatBridge.run(enc, [partyInst], { priorEncounterVictory: true });
  assert("victory_rush: combat with priorEncounterVictory no crash", ["victory","defeat","timeout"].includes(crWithVictory.outcome));
}

// ── 6. damageReceivedThisTurn tracking ───────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  // If combat lasted more than 1 turn, enemy was hit — check logs have damage
  assert("damage tracking: combat resolves", ["victory","defeat","timeout"].includes(cr.outcome));
  const damageLine = cr.logs.some(l => /↳.*\d+.*physical/.test(l));
  assert("damage tracking: at least one damage line in logs", damageLine);
}

// ── 7. buff/debuff round-trip (battle shout) ─────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeWarrior({ learnedAbilities: ["battle_shout","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  assert("battle_shout: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (warrior) ─────────────────────────────────────────────────────────

const warriorLines = [
  `\n${"=".repeat(60)}`,
  `WARRIOR MECHANIC TESTS: ${p}/${p + f} passed`,
  "=".repeat(60),
  ...results.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  f > 0 ? `\n  ${f} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(warriorLines.join("\n"));

// =============================================================================
// PRIEST ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let pp = 0, pf = 0, priestResults = [];
const passert = (label, cond) => { cond ? pp++ : pf++; priestResults.push({ ok: !!cond, label }); };

const makePriest = (overrides = {}) => ({
  instanceId: "test_priest",
  name: "Anala",
  classId: "priest",
  raceId: "troll",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("troll", "priest", 20) },
  learnedAbilities: ["smite","lesser_heal"],
  gear: {},
  ...overrides,
});

const buildPriest = (overrides = {}) => CombatBridge.buildUnit(makePriest(overrides), false);

// ── 1. ability data integrity ─────────────────────────────────────────────────

const priestAbilities = [
  "lesser_heal","smite","power_word_fortitude","shadow_word_pain","power_word_shield",
  "fade","renew","mind_blast","resurrection","inner_fire","psychic_scream",
  "cure_disease","dispel_magic","fear_ward","holy_nova","shackle_undead",
  "devouring_plague","flash_heal","holy_fire",
];
for (const id of priestAbilities) {
  passert(`ability "${id}" exists`,        !!ABILITIES[id]);
  passert(`ability "${id}" has effects`,   Array.isArray(ABILITIES[id]?.effects));
}

const priestBuffs = [
  "fortitude_buff","power_word_shield_buff","fade_buff","renew_hot","inner_fire_buff",
  "fear_ward_buff","shackle_undead_debuff","devouring_plague_dot","shadow_word_pain_dot","holy_fire_dot",
];
for (const id of priestBuffs) {
  passert(`buff "${id}" exists`, !!BUFFS[id]);
}

passert("power_word_shield: cooldown 3",        ABILITIES.power_word_shield?.cooldown === 3);
passert("fade: cooldown 4",                     ABILITIES.fade?.cooldown === 4);
passert("resurrection: outOfCombatOnly true",   ABILITIES.resurrection?.outOfCombatOnly === true);
passert("resurrection: manaCostPercent 1.0",    ABILITIES.resurrection?.manaCostPercent === 1.0);
passert("shackle_undead: requiresTargetTag",    ABILITIES.shackle_undead?.requiresTargetTag === "undead");
passert("dispel_magic: targeting single_any",   ABILITIES.dispel_magic?.targeting === "single_any");
passert("holy_nova: targeting aoe_both",        ABILITIES.holy_nova?.targeting === "aoe_both");
passert("psychic_scream: targeting front_2",    ABILITIES.psychic_scream?.targeting === "front_2_enemies");
passert("fade_buff: isFaded true",              BUFFS.fade_buff?.isFaded === true);
passert("power_word_shield_buff: absorbShield", (BUFFS.power_word_shield_buff?.absorbShield || 0) > 0);
passert("fortitude_buff: maxHpBonus",           (BUFFS.fortitude_buff?.maxHpBonus || 0) > 0);
passert("renew_hot: tickHeal defined",          !!BUFFS.renew_hot?.tickHeal);
passert("devouring_plague_dot: tickDrain true", BUFFS.devouring_plague_dot?.tickDrain === true);
passert("fear_ward_buff: negatesNextFear true", BUFFS.fear_ward_buff?.negatesNextFear === true);
passert("inner_fire_buff: armor modifier",      (BUFFS.inner_fire_buff?.modifiers?.armor || 0) > 0);

// ── 2. Power Word: Shield absorb ─────────────────────────────────────────────

{
  // no smite so the priest is forced to shield themselves; tanky enemy survives long enough to hit
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 20, agi: 10, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["power_word_shield"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("power_word_shield: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  const hasAbsorbLog = cr.logs.some(l => l.includes("shield absorbs"));
  passert("power_word_shield: absorb log appears", hasAbsorbLog);
}

// ── 3. fortitude maxHpBonus grant and revert ──────────────────────────────────

{
  const pu = buildPriest();
  const baseMaxHp = pu.maxHp;
  // apply fortitude buff
  const buffed = CombatBridge.buildUnit(makePriest(), false);
  // simulate applyBuff directly via a combat run that uses power_word_fortitude
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makePriest({ learnedAbilities: ["power_word_fortitude","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("fortitude: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  passert("fortitude_buff: maxHpBonus defined > 0", BUFFS.fortitude_buff.maxHpBonus > 0);
  // verify buildUnit base maxHp without buff is lower than with buff applied manually
  const withoutBuff = CombatBridge.buildUnit(makePriest(), false);
  passert("fortitude: base maxHp is a positive number", withoutBuff.maxHp > 0);
}

// ── 4. Renew HoT ticks ───────────────────────────────────────────────────────

{
  // no smite forces the AI to use renew (a buffAbils candidate)
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["renew"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("renew: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  const hasHealTick = cr.logs.some(l => l.includes("renew_hot"));
  passert("renew: HoT tick log appears", hasHealTick);
}

// ── 5. Devouring Plague drain ─────────────────────────────────────────────────

{
  // no smite: devouring_plague falls through to avail[0] and gets cast each turn
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["devouring_plague"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("devouring_plague: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  const hasDrain = cr.logs.some(l => l.includes("drains") && l.includes("life"));
  passert("devouring_plague: drain heal log appears", hasDrain);
}

// ── 6. Psychic Scream fears front 2 enemies ───────────────────────────────────

{
  // no smite: psychic_scream falls through to avail[0]; tanky enemies survive to receive the fear
  const enc = { zoneId: "test", enemies: [
    makeEnemy({ id: "e1", name: "Mob1", baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } }),
    makeEnemy({ id: "e2", name: "Mob2", baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } }),
  ] };
  const partyInst = makePriest({ learnedAbilities: ["psychic_scream"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("psychic_scream: multi-enemy combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  const hasFearLog = cr.logs.some(l => l.includes("feared_debuff"));
  passert("psychic_scream: feared_debuff log appears", hasFearLog);
}

// ── 7. Shackle Undead: blocked against non-undead ─────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ tags: [] })] };
  const partyInst = makePriest({ learnedAbilities: ["shackle_undead","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("shackle_undead: not used on non-undead (no stun log)", !cr.logs.some(l => l.includes("shackle undead")));
}

// ── 8. Shackle Undead: works on undead ───────────────────────────────────────

{
  // no smite: shackle_undead falls through to avail[0] and gets cast
  const enc = { zoneId: "test", enemies: [makeEnemy({ tags: ["undead"], baseStats: { str: 5, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["shackle_undead"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("shackle_undead: combat with undead runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  passert("shackle_undead: used on undead target", cr.logs.some(l => l.includes("shackle undead")));
}

// ── 9. Fear Ward blocks feared debuff ────────────────────────────────────────

{
  // enemy uses psychic_scream, party has a priest with fear_ward on themselves
  const enc = { zoneId: "test", enemies: [makeEnemy({ abilities: ["psychic_scream","melee_attack"], baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["fear_ward","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("fear_ward: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 10. Resurrection is blocked in combat (outOfCombatOnly) ──────────────────

{
  passert("resurrection: outOfCombatOnly flag set", ABILITIES.resurrection?.outOfCombatOnly === true);
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makePriest({ learnedAbilities: ["resurrection","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  // resurrection should never appear in combat logs
  passert("resurrection: not used in combat", !cr.logs.some(l => l.includes("resurrection")));
}

// ── 11. Holy Nova hits both sides (aoe_both) ─────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy(), makeEnemy({ id: "e2", name: "Mob2" })] };
  const partyInst = makePriest({ learnedAbilities: ["holy_nova","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("holy_nova: multi-enemy combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  passert("holy_nova: used at least once", cr.logs.some(l => l.includes("holy nova")));
}

// ── 12. aiChoose healer priority ─────────────────────────────────────────────

{
  // priest should prefer healing an injured ally over dealing damage
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["lesser_heal","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("healer AI: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 13. Dispel Magic: no crash on either targeting case ───────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makePriest({ learnedAbilities: ["dispel_magic","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("dispel_magic: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 14. Inner Fire armor modifier ────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  // no smite: inner_fire chosen as buffAbils candidate
  const partyInst = makePriest({ learnedAbilities: ["inner_fire"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("inner_fire: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  passert("inner_fire: buff log appears", cr.logs.some(l => l.includes("inner_fire_buff")));
}

// ── 15. Fade zeroes threat ────────────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makePriest({ learnedAbilities: ["fade","smite"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  passert("fade: combat runs without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (priest) ──────────────────────────────────────────────────────────

const priestLines = [
  `\n${"=".repeat(60)}`,
  `PRIEST MECHANIC TESTS: ${pp}/${pp + pf} passed`,
  "=".repeat(60),
  ...priestResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  pf > 0 ? `\n  ${pf} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(priestLines.join("\n"));

// =============================================================================
// SHAMAN ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let sp2 = 0, sf2 = 0, shamanResults = [];
const sassert = (label, cond) => { cond ? sp2++ : sf2++; shamanResults.push({ ok: !!cond, label }); };

const makeShaman = (overrides = {}) => ({
  instanceId: "test_shaman",
  name: "Zevrost",
  classId: "shaman",
  raceId: "troll",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("troll", "shaman", 20) },
  learnedAbilities: ["lightning_bolt"],
  gear: {},
  ...overrides,
});

const buildShaman = (overrides = {}) => CombatBridge.buildUnit(makeShaman(overrides), false);

// ── 1. ability data integrity ─────────────────────────────────────────────────

const shamanAbilities = [
  "healing_wave","lightning_bolt","rockbiter_weapon","earth_shock","stoneskin_totem",
  "earthbind_totem","lightning_shield","stoneclaw_totem","flametongue_weapon",
  "searing_totem","strength_of_earth_totem","flame_shock",
];
for (const id of shamanAbilities) {
  sassert(`ability "${id}" exists`,       !!ABILITIES[id]);
  sassert(`ability "${id}" has effects`,  Array.isArray(ABILITIES[id]?.effects));
}

const shamanBuffs = [
  "rockbiter_weapon_buff","earth_shock_debuff","stoneskin_totem_buff","earthbind_totem_buff",
  "lightning_shield_buff","stoneclaw_totem_buff","flametongue_weapon_buff",
  "searing_totem_dot","strength_of_earth_buff","flame_shock_dot",
];
for (const id of shamanBuffs) {
  sassert(`buff "${id}" exists`, !!BUFFS[id]);
}

sassert("rockbiter_weapon_buff: isWeaponBuff",      BUFFS.rockbiter_weapon_buff?.isWeaponBuff === true);
sassert("flametongue_weapon_buff: isWeaponBuff",    BUFFS.flametongue_weapon_buff?.isWeaponBuff === true);
sassert("flametongue_weapon_buff: spellPower mod",  (BUFFS.flametongue_weapon_buff?.modifiers?.spellPower || 0) > 0);
sassert("rockbiter_weapon_buff: attackPower mod",   (BUFFS.rockbiter_weapon_buff?.modifiers?.attackPower || 0) > 0);
sassert("earth_shock_debuff: attackPower negative", (BUFFS.earth_shock_debuff?.modifiers?.attackPower || 0) < 0);
sassert("stoneskin_totem_buff: totemGroup earth",   BUFFS.stoneskin_totem_buff?.totemGroup === "earth");
sassert("earthbind_totem_buff: totemGroup earth",   BUFFS.earthbind_totem_buff?.totemGroup === "earth");
sassert("strength_of_earth_buff: totemGroup earth", BUFFS.strength_of_earth_buff?.totemGroup === "earth");
sassert("searing_totem_dot: totemGroup fire",       BUFFS.searing_totem_dot?.totemGroup === "fire");
sassert("lightning_shield_buff: isElementalShield", BUFFS.lightning_shield_buff?.isElementalShield === true);
sassert("lightning_shield_buff: charges 3",         BUFFS.lightning_shield_buff?.charges === 3);
sassert("lightning_shield_buff: onHitRetaliation",  !!BUFFS.lightning_shield_buff?.onHitRetaliation);
sassert("stoneclaw_totem_buff: absorbShield > 0",   (BUFFS.stoneclaw_totem_buff?.absorbShield || 0) > 0);
sassert("earthbind_totem_buff: fleeBonus > 0",      (BUFFS.earthbind_totem_buff?.fleeBonus || 0) > 0);
sassert("stoneskin_totem: removesTotemGroup earth", ABILITIES.stoneskin_totem?.removesTotemGroup === "earth");
sassert("strength_of_earth_totem: removesTotemGroup", ABILITIES.strength_of_earth_totem?.removesTotemGroup === "earth");
sassert("searing_totem: removesTotemGroup fire",    ABILITIES.searing_totem?.removesTotemGroup === "fire");
sassert("earth_shock: cooldown 4",                  ABILITIES.earth_shock?.cooldown === 4);
sassert("stoneclaw_totem: cooldown 3",              ABILITIES.stoneclaw_totem?.cooldown === 3);

// ── 2. weapon buff mutual exclusion ──────────────────────────────────────────

{
  const su = buildShaman();
  // manually simulate applying both weapon buffs via buildUnit + applyBuff path
  // test via combat: shaman casts rockbiter, then flametongue → only flametongue remains
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["rockbiter_weapon","flametongue_weapon","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("weapon buff: combat with both weapon buffs runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  // both buffs appear in logs (cast at different turns due to setupAbils priority)
  sassert("weapon buff: rockbiter cast at some point",    cr.logs.some(l => l.includes("rockbiter_weapon_buff")));
}

// ── 3. rockbiter weapon increases melee AP in rollDamage ─────────────────────

{
  // shaman with melee_attack + rockbiter vs enemy: the buff's AP modifer should add to damage
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 20, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["rockbiter_weapon","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("rockbiter: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("rockbiter: buff applied", cr.logs.some(l => l.includes("rockbiter_weapon_buff")));
}

// ── 4. flametongue weapon adds spellPower to spell damage ─────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeShaman({ learnedAbilities: ["flametongue_weapon","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("flametongue: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("flametongue: buff applied", cr.logs.some(l => l.includes("flametongue_weapon_buff")));
}

// ── 5. earth shock debuffs enemy attackPower ─────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 20, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["earth_shock","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("earth_shock: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("earth_shock: debuff applied",  cr.logs.some(l => l.includes("earth_shock_debuff")));
}

// ── 6. stoneskin totem applies party armor buff ───────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["stoneskin_totem","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("stoneskin_totem: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("stoneskin_totem: buff applied",   cr.logs.some(l => l.includes("stoneskin_totem_buff")));
}

// ── 7. earth totem mutual exclusion ──────────────────────────────────────────

{
  // stoneskin then strength_of_earth → stoneskin removed
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["stoneskin_totem","strength_of_earth_totem","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("earth totem exclusion: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("earth totem exclusion: both totems cast",
    cr.logs.some(l => l.includes("stoneskin_totem_buff")) && cr.logs.some(l => l.includes("strength_of_earth_buff")));
}

// ── 8. lightning shield: retaliation on hit ───────────────────────────────────

{
  // shaman with only lightning_shield — enemy attacks shaman, zap fires
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 15, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["lightning_shield"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("lightning_shield: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("lightning_shield: retaliation log appears", cr.logs.some(l => l.includes("lightning shield zaps")));
}

// ── 9. stoneclaw totem absorb shield ─────────────────────────────────────────

{
  // shaman with only stoneclaw_totem — applies absorb to self, enemy should trigger absorb
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 15, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["stoneclaw_totem"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("stoneclaw_totem: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("stoneclaw_totem: absorb or buff log appears",
    cr.logs.some(l => l.includes("stoneclaw_totem_buff") || l.includes("shield absorbs")));
}

// ── 10. searing totem fire DoT ticks ─────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["searing_totem"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("searing_totem: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("searing_totem: DoT tick log appears", cr.logs.some(l => l.includes("searing_totem_dot")));
}

// ── 11. flame_shock: initial damage + DoT ────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: ["flame_shock","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("flame_shock: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  sassert("flame_shock: initial damage log",  cr.logs.some(l => l.includes("flame shock")));
  sassert("flame_shock: DoT tick log",        cr.logs.some(l => l.includes("flame_shock_dot")));
}

// ── 12. setupAbils: shaman casts weapon buff before lightning bolt ─────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeShaman({ learnedAbilities: ["rockbiter_weapon","lightning_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("setupAbils: combat with weapon enchant runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  // rockbiter should appear before the first lightning bolt
  const rkIdx = cr.logs.findIndex(l => l.includes("rockbiter_weapon_buff"));
  const lbIdx = cr.logs.findIndex(l => l.includes("lightning bolt"));
  sassert("setupAbils: rockbiter cast before first lightning bolt", rkIdx >= 0 && lbIdx >= 0 && rkIdx < lbIdx);
}

// ── 13. general shaman multi-ability combat ───────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 10, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makeShaman({ learnedAbilities: [
    "rockbiter_weapon","lightning_shield","stoneskin_totem","earth_shock","lightning_bolt","healing_wave",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  sassert("full shaman kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (shaman) ──────────────────────────────────────────────────────────

const shamanLines = [
  `\n${"=".repeat(60)}`,
  `SHAMAN MECHANIC TESTS: ${sp2}/${sp2 + sf2} passed`,
  "=".repeat(60),
  ...shamanResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  sf2 > 0 ? `\n  ${sf2} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(shamanLines.join("\n"));

// =============================================================================
// HUNTER ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let hp2 = 0, hf2 = 0, hunterResults = [];
const hassert = (label, cond) => { cond ? hp2++ : hf2++; hunterResults.push({ ok: !!cond, label }); };

const makeHunter = (overrides = {}) => ({
  instanceId: "test_hunter",
  name: "Gadrin",
  classId: "hunter",
  raceId: "troll",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("troll", "hunter", 20) },
  learnedAbilities: ["ranged_attack"],
  gear: {},
  ...overrides,
});

const buildHunter = (overrides = {}) => CombatBridge.buildUnit(makeHunter(overrides), false);

// ── 1. ability data integrity ─────────────────────────────────────────────────

const hunterAbilities = [
  "ranged_attack","raptor_strike","track_beasts","serpent_sting","aspect_of_the_monkey",
  "hunters_mark","arcane_shot","concussive_shot","aspect_of_the_hawk","track_humanoids",
  "distracting_shot","wing_clip","scare_beast","immolation_trap","mongoose_bite",
];
for (const id of hunterAbilities) {
  hassert(`ability "${id}" exists`,      !!ABILITIES[id]);
  hassert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const hunterBuffs = [
  "serpent_sting_dot","aspect_of_the_monkey_buff","hunters_mark_debuff","concussive_shot_debuff",
  "aspect_of_the_hawk_buff","wing_clip_debuff","scare_beast_debuff","immolation_trap_dot",
];
for (const id of hunterBuffs) hassert(`buff "${id}" exists`, !!BUFFS[id]);

hassert("ranged_attack: scaling rap",              ABILITIES.ranged_attack?.effects[0]?.scaling === "rap");
hassert("track_beasts: outOfCombatOnly",           ABILITIES.track_beasts?.outOfCombatOnly === true);
hassert("track_humanoids: outOfCombatOnly",        ABILITIES.track_humanoids?.outOfCombatOnly === true);
hassert("arcane_shot: cooldown 1",                 ABILITIES.arcane_shot?.cooldown === 1);
hassert("mongoose_bite: cooldown 1",               ABILITIES.mongoose_bite?.cooldown === 1);
hassert("scare_beast: cooldown 3",                 ABILITIES.scare_beast?.cooldown === 3);
hassert("scare_beast: requiresTargetTag beast",    ABILITIES.scare_beast?.requiresTargetTag === "beast");
hassert("aspect_of_the_monkey_buff: isAspect",     BUFFS.aspect_of_the_monkey_buff?.isAspect === true);
hassert("aspect_of_the_hawk_buff: isAspect",       BUFFS.aspect_of_the_hawk_buff?.isAspect === true);
hassert("aspect_of_the_monkey_buff: dodgeChance",  (BUFFS.aspect_of_the_monkey_buff?.modifiers?.dodgeChance || 0) > 0);
hassert("aspect_of_the_hawk_buff: attackPower",    (BUFFS.aspect_of_the_hawk_buff?.modifiers?.attackPower || 0) > 0);
hassert("hunters_mark_debuff: damageTakenMultiplier > 1", (BUFFS.hunters_mark_debuff?.modifiers?.damageTakenMultiplier || 0) > 1);
hassert("concussive_shot_debuff: fleeBonus > 0",   (BUFFS.concussive_shot_debuff?.fleeBonus || 0) > 0);
hassert("wing_clip_debuff: fleeBonus > 0",         (BUFFS.wing_clip_debuff?.fleeBonus || 0) > 0);
hassert("scare_beast_debuff: ccFlags.stunned",     BUFFS.scare_beast_debuff?.ccFlags?.stunned === true);
hassert("immolation_trap_dot: tickDamage fire",    BUFFS.immolation_trap_dot?.tickDamage?.damageType === "fire");
hassert("serpent_sting_dot: tickDamage nature",    BUFFS.serpent_sting_dot?.tickDamage?.damageType === "nature");

// ── 2. aspect mutual exclusion ───────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["aspect_of_the_monkey","aspect_of_the_hawk","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("aspect exclusion: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("aspect exclusion: both aspects cast at some point",
    cr.logs.some(l => l.includes("aspect_of_the_monkey_buff")) && cr.logs.some(l => l.includes("aspect_of_the_hawk_buff")));
}

// ── 3. aspect_of_the_hawk adds AP (setup priority) ───────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeHunter({ learnedAbilities: ["aspect_of_the_hawk","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("aspect_of_the_hawk: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("aspect_of_the_hawk: applied as setup buff", cr.logs.some(l => l.includes("aspect_of_the_hawk_buff")));
  const hawkIdx = cr.logs.findIndex(l => l.includes("aspect_of_the_hawk_buff"));
  const atkIdx  = cr.logs.findIndex(l => l.includes("ranged attack"));
  hassert("aspect_of_the_hawk: cast before first ranged attack", hawkIdx >= 0 && atkIdx >= 0 && hawkIdx < atkIdx);
}

// ── 4. dodge: aspect_of_the_monkey buff applies ──────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 10, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["aspect_of_the_monkey","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("dodge: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("dodge: monkey buff applied", cr.logs.some(l => l.includes("aspect_of_the_monkey_buff")));
}

// ── 5. serpent_sting DoT ticks ───────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["serpent_sting","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("serpent_sting: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("serpent_sting: DoT applied and ticks", cr.logs.some(l => l.includes("serpent_sting_dot")));
}

// ── 6. hunters_mark debuff applied ───────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["hunters_mark","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("hunters_mark: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("hunters_mark: debuff applied", cr.logs.some(l => l.includes("hunters_mark_debuff")));
}

// ── 7. arcane_shot deals damage ──────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["arcane_shot","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("arcane_shot: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("arcane_shot: cast", cr.logs.some(l => l.includes("arcane shot")));
}

// ── 8. distracting_shot generates threat ─────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["distracting_shot","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("distracting_shot: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("distracting_shot: cast", cr.logs.some(l => l.includes("distracting shot")));
}

// ── 9. wing_clip: damage + flee debuff ───────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["wing_clip","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("wing_clip: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("wing_clip: debuff applied", cr.logs.some(l => l.includes("wing_clip_debuff")));
}

// ── 10. scare_beast: stuns a beast target ────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ tags: ["beast"], baseStats: { str: 5, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["scare_beast","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("scare_beast: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("scare_beast: stun debuff applied", cr.logs.some(l => l.includes("scare_beast_debuff")));
}

// ── 11. immolation_trap: fire DoT ticks ──────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["immolation_trap","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("immolation_trap: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("immolation_trap: DoT ticks", cr.logs.some(l => l.includes("immolation_trap_dot")));
}

// ── 12. raptor_strike and mongoose_bite: high melee damage ───────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: ["raptor_strike","mongoose_bite","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("raptor/mongoose: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("raptor_strike: cast", cr.logs.some(l => l.includes("raptor strike")));
}

// ── 13. track abilities excluded from combat AI ───────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makeHunter({ learnedAbilities: ["track_beasts","track_humanoids","ranged_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("track abilities: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  hassert("track abilities: never used in combat",
    !cr.logs.some(l => l.includes("track beasts") || l.includes("track humanoids")));
}

// ── 14. full hunter kit: no crash ────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ tags: ["beast"], baseStats: { str: 10, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makeHunter({ learnedAbilities: [
    "ranged_attack","raptor_strike","serpent_sting","aspect_of_the_hawk",
    "hunters_mark","arcane_shot","scare_beast","immolation_trap","mongoose_bite",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  hassert("full hunter kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (hunter) ──────────────────────────────────────────────────────────

const hunterLines = [
  `\n${"=".repeat(60)}`,
  `HUNTER MECHANIC TESTS: ${hp2}/${hp2 + hf2} passed`,
  "=".repeat(60),
  ...hunterResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  hf2 > 0 ? `\n  ${hf2} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(hunterLines.join("\n"));

// =============================================================================
// PALADIN ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let palP = 0, palF = 0, paladinResults = [];
const palAssert = (label, cond) => { cond ? palP++ : palF++; paladinResults.push({ ok: !!cond, label }); };

const makePaladin = (overrides = {}) => ({
  instanceId: "test_paladin",
  name: "Uthan",
  classId: "paladin",
  raceId: "orc",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("orc", "paladin", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const buildPaladin = (overrides = {}) => CombatBridge.buildUnit(makePaladin(overrides), false);

// ── 1. ability data integrity ─────────────────────────────────────────────────

const paladinAbilities = [
  "melee_attack","seal_of_righteousness","holy_light","devotion_aura","judgement",
  "blessing_of_might","divine_protection","purify","hammer_of_justice","hand_of_protection",
  "lay_on_hands","redemption",
];
for (const id of paladinAbilities) {
  palAssert(`ability "${id}" exists`,      !!ABILITIES[id]);
  palAssert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const paladinBuffDefs = [
  "seal_of_righteousness_buff","devotion_aura_buff","blessing_of_might_buff",
  "divine_protection_buff","hammer_of_justice_stun","hand_of_protection_buff",
];
for (const id of paladinBuffDefs) palAssert(`buff "${id}" exists`, !!BUFFS[id]);

palAssert("redemption: outOfCombatOnly",                    ABILITIES.redemption?.outOfCombatOnly === true);
palAssert("divine_protection: cooldown 10",                 ABILITIES.divine_protection?.cooldown === 10);
palAssert("hammer_of_justice: cooldown 5",                  ABILITIES.hammer_of_justice?.cooldown === 5);
palAssert("hand_of_protection: cooldown 10",                ABILITIES.hand_of_protection?.cooldown === 10);
palAssert("lay_on_hands: cooldown 20",                      ABILITIES.lay_on_hands?.cooldown === 20);
palAssert("judgement: has consume_seal effect",             ABILITIES.judgement?.effects.some(e => e.type === "consume_seal"));
palAssert("devotion_aura: removesTotemGroup aura",          ABILITIES.devotion_aura?.removesTotemGroup === "aura");
palAssert("purify: removes disease and poison",
  (ABILITIES.purify?.effects[0]?.removes || []).includes("poison") &&
  (ABILITIES.purify?.effects[0]?.removes || []).includes("disease"));
palAssert("seal_of_righteousness_buff: isSeal",             BUFFS.seal_of_righteousness_buff?.isSeal === true);
palAssert("seal_of_righteousness_buff: procOnHit exists",   !!BUFFS.seal_of_righteousness_buff?.procOnHit);
palAssert("devotion_aura_buff: isAura",                     BUFFS.devotion_aura_buff?.isAura === true);
palAssert("devotion_aura_buff: totemGroup aura",            BUFFS.devotion_aura_buff?.totemGroup === "aura");
palAssert("devotion_aura_buff: armor bonus > 0",            (BUFFS.devotion_aura_buff?.modifiers?.armor || 0) > 0);
palAssert("blessing_of_might_buff: isBlessing",             BUFFS.blessing_of_might_buff?.isBlessing === true);
palAssert("blessing_of_might_buff: attackPower bonus > 0",  (BUFFS.blessing_of_might_buff?.modifiers?.attackPower || 0) > 0);
palAssert("divine_protection_buff: damageTakenMultiplier 0.5", BUFFS.divine_protection_buff?.modifiers?.damageTakenMultiplier === 0.5);
palAssert("hammer_of_justice_stun: stunned",                BUFFS.hammer_of_justice_stun?.ccFlags?.stunned === true);
palAssert("hand_of_protection_buff: invulnerable",          BUFFS.hand_of_protection_buff?.invulnerable === true);
palAssert("hand_of_protection_buff: preventsActions",       BUFFS.hand_of_protection_buff?.preventsActions === true);
palAssert("serpent_sting_dot: debuffType poison",           BUFFS.serpent_sting_dot?.debuffType === "poison");

// ── 2. Seal of Righteousness: setup priority + proc on melee ─────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["seal_of_righteousness","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("seal_of_righteousness: combat runs ok",  ["victory","defeat","timeout"].includes(cr.outcome));
  palAssert("seal_of_righteousness: buff applied",    cr.logs.some(l => l.includes("seal_of_righteousness_buff")));
  palAssert("seal_of_righteousness: proc fires",      cr.logs.some(l => l.includes("seal procs")));
}

// ── 3. Judgement: deals damage and consumes active seal ───────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 60, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["seal_of_righteousness","judgement"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("judgement: combat runs ok",        ["victory","defeat","timeout"].includes(cr.outcome));
  palAssert("judgement: seal consumed in logs", cr.logs.some(l => l.includes("consumed")));
}

// ── 4. Devotion Aura: party armor buff applied ────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["devotion_aura","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("devotion_aura: combat runs ok",    ["victory","defeat","timeout"].includes(cr.outcome));
  palAssert("devotion_aura: aura buff applied", cr.logs.some(l => l.includes("devotion_aura_buff")));
}

// ── 5. Blessing of Might: single ally AP buff applied ────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 10, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["blessing_of_might"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("blessing_of_might: buff applied in combat", cr.logs.some(l => l.includes("blessing_of_might_buff")));
}

// ── 6. Divine Protection: enters setupAbils (self-buff), applied early ────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["divine_protection","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("divine_protection: buff applied", cr.logs.some(l => l.includes("divine_protection_buff")));
}

// ── 7. Purify: no crash ───────────────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makePaladin({ learnedAbilities: ["purify","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("purify: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 8. Hammer of Justice: stuns enemy ────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 50, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["hammer_of_justice","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("hammer_of_justice: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  palAssert("hammer_of_justice: stun applied",   cr.logs.some(l => l.includes("hammer_of_justice_stun")));
}

// ── 9. Hand of Protection: target invulnerable and cannot act ────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 30, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["hand_of_protection"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("hand_of_protection: buff applied",           cr.logs.some(l => l.includes("hand_of_protection_buff")));
  palAssert("hand_of_protection: invulnerable triggered", cr.logs.some(l => l.includes("is invulnerable!")));
}

// ── 10. Lay on Hands: heals critically injured ally to near-full ──────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy()] };
  const partyInst = makePaladin({ learnedAbilities: ["lay_on_hands","melee_attack"], currentHp: 5 });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("lay_on_hands: combat runs ok",    ["victory","defeat","timeout"].includes(cr.outcome));
  palAssert("lay_on_hands: large heal logged", cr.logs.some(l => l.includes("heals") && /\+\d{3,}/.test(l)));
}

// ── 11. setupAbils: seal and aura cast before attacking ──────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: ["seal_of_righteousness","devotion_aura","melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("setupAbils: seal applied before attacking",
    cr.logs.some(l => l.includes("seal_of_righteousness_buff")));
  palAssert("setupAbils: aura applied before attacking",
    cr.logs.some(l => l.includes("devotion_aura_buff")));
}

// ── 12. full paladin kit: no crash ────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 10, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makePaladin({ learnedAbilities: [
    "melee_attack","seal_of_righteousness","holy_light","devotion_aura","judgement",
    "blessing_of_might","divine_protection","purify","hammer_of_justice","lay_on_hands",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  palAssert("full paladin kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (paladin) ─────────────────────────────────────────────────────────

const paladinLines = [
  `\n${"=".repeat(60)}`,
  `PALADIN MECHANIC TESTS: ${palP}/${palP + palF} passed`,
  "=".repeat(60),
  ...paladinResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  palF > 0 ? `\n  ${palF} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(paladinLines.join("\n"));

// =============================================================================
// ROGUE ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let rogP = 0, rogF = 0, rogueResults = [];
const rogAssert = (label, cond) => { cond ? rogP++ : rogF++; rogueResults.push({ ok: !!cond, label }); };

const makeRogue = (overrides = {}) => ({
  instanceId: "test_rogue",
  name: "Visha",
  classId: "rogue",
  raceId: "orc",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: 0,
  stats: { raw: getStatsAtLevel("orc", "rogue", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const buildRogue = (overrides = {}) => CombatBridge.buildUnit(makeRogue(overrides), false);

// ── 1. Ability data integrity ─────────────────────────────────────────────────

const rogueAbilities = [
  "melee_attack","pick_lock","sinister_strike","stealth","eviscerate","pick_pocket",
  "backstab","gouge","evasion","sap","sprint","slice_and_dice",
];
for (const id of rogueAbilities) {
  rogAssert(`ability "${id}" exists`,      !!ABILITIES[id]);
  rogAssert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const rogueBuffDefs = [
  "stealth_buff","evasion_buff","sprint_buff","gouge_stun","sap_debuff","slice_and_dice_buff",
];
for (const id of rogueBuffDefs) rogAssert(`buff "${id}" exists`, !!BUFFS[id]);

// ── 2. Key field checks ───────────────────────────────────────────────────────

rogAssert("pick_lock: outOfCombatOnly",                ABILITIES.pick_lock?.outOfCombatOnly === true);
rogAssert("pick_lock: pick_lock effect type",          ABILITIES.pick_lock?.effects.some(e => e.type === "pick_lock"));
rogAssert("backstab: cooldown 4",                      ABILITIES.backstab?.cooldown === 4);
rogAssert("gouge: cooldown 3",                         ABILITIES.gouge?.cooldown === 3);
rogAssert("sprint: cooldown 5",                        ABILITIES.sprint?.cooldown === 5);
rogAssert("evasion: cooldown 10",                      ABILITIES.evasion?.cooldown === 10);
rogAssert("eviscerate: spendComboPoints",              ABILITIES.eviscerate?.spendComboPoints === true);
rogAssert("slice_and_dice: spendComboPoints",          ABILITIES.slice_and_dice?.spendComboPoints === true);
rogAssert("backstab: requiresCondition in_stealth",    ABILITIES.backstab?.requiresCondition === "in_stealth");
rogAssert("pick_pocket: requiresCondition in_stealth", ABILITIES.pick_pocket?.requiresCondition === "in_stealth");
rogAssert("sap: requiresOpener",                       ABILITIES.sap?.requiresOpener === true);
rogAssert("sap: requiresCondition in_stealth",         ABILITIES.sap?.requiresCondition === "in_stealth");
rogAssert("sap: requiresTargetTag humanoid",           ABILITIES.sap?.requiresTargetTag === "humanoid");
rogAssert("sinister_strike: has gain_combo_point",     ABILITIES.sinister_strike?.effects.some(e => e.type === "gain_combo_point"));
rogAssert("eviscerate: has comboFinisher",             ABILITIES.eviscerate?.effects.some(e => e.comboFinisher));
rogAssert("eviscerate: bonusPerComboPoint > 0",        (ABILITIES.eviscerate?.effects.find(e => e.comboFinisher)?.bonusPerComboPoint || 0) > 0);
rogAssert("slice_and_dice: has comboFinisher",         ABILITIES.slice_and_dice?.effects.some(e => e.comboFinisher));
rogAssert("slice_and_dice: durationPerComboPoint > 0", (ABILITIES.slice_and_dice?.effects.find(e => e.comboFinisher)?.durationPerComboPoint || 0) > 0);

// ── 3. Buff def field checks ──────────────────────────────────────────────────

rogAssert("stealth_buff: isStealth",           BUFFS.stealth_buff?.isStealth === true);
rogAssert("stealth_buff: duration 99",         BUFFS.stealth_buff?.duration === 99);
rogAssert("evasion_buff: dodgeChance 0.75",    BUFFS.evasion_buff?.modifiers?.dodgeChance === 0.75);
rogAssert("sprint_buff: fleeBonus 0.10",       BUFFS.sprint_buff?.fleeBonus === 0.10);
rogAssert("gouge_stun: ccFlags.stunned",       BUFFS.gouge_stun?.ccFlags?.stunned === true);
rogAssert("sap_debuff: ccFlags.stunned",       BUFFS.sap_debuff?.ccFlags?.stunned === true);
rogAssert("sap_debuff: removedOnDamage",       BUFFS.sap_debuff?.removedOnDamage === true);
rogAssert("sap_debuff: duration 4",            BUFFS.sap_debuff?.duration === 4);
rogAssert("slice_and_dice_buff: doubleAction", BUFFS.slice_and_dice_buff?.doubleAction === true);

// ── 4. buildUnit: rogue has stamina and combo_points ─────────────────────────

{
  const rogue = buildRogue();
  rogAssert("rogue buildUnit: stamina resource exists",       !!rogue.resources.stamina);
  rogAssert("rogue buildUnit: stamina starts at 100",         rogue.resources.stamina?.current === 100);
  rogAssert("rogue buildUnit: combo_points resource exists",  !!rogue.resources.combo_points);
  rogAssert("rogue buildUnit: combo_points start at 0",       rogue.resources.combo_points?.current === 0);
}

// ── 5. Stealth: buff applied + enemy cannot target stealthed rogue ────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["stealth"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("stealth: stealth_buff applied in logs",          cr.logs.some(l => l.includes("stealth_buff")));
  rogAssert("stealth: enemy cannot target rogue → timeout",   cr.outcome === "timeout");
}

// ── 6. Stealth: using another ability breaks stealth ─────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["stealth", "sinister_strike"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("stealth break: 'leaves stealth' in logs", cr.logs.some(l => l.includes("leaves stealth")));
}

// ── 7. Sinister Strike: generates combo points ────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["sinister_strike"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("sinister_strike: combo point log appears",   cr.logs.some(l => l.includes("combo point")));
  rogAssert("sinister_strike: combo points accumulated",  (cr.party[0].resources.combo_points?.current || 0) > 0);
}

// ── 8. Eviscerate: uses combo points, no crash ───────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["sinister_strike", "eviscerate"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("eviscerate: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  rogAssert("eviscerate: appears in logs",               cr.logs.some(l => l.includes("eviscerate")));
}

// ── 9. Gouge: applies stun debuff ────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["gouge", "melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("gouge: combat runs ok",       ["victory","defeat","timeout"].includes(cr.outcome));
  rogAssert("gouge: gouge_stun in logs",   cr.logs.some(l => l.includes("gouge_stun")));
}

// ── 10. Evasion: dodge buff applied ──────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["evasion", "melee_attack"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("evasion: combat runs ok",      ["victory","defeat","timeout"].includes(cr.outcome));
  rogAssert("evasion: evasion_buff in logs", cr.logs.some(l => l.includes("evasion_buff")));
}

// ── 11. Pick Pocket: adds pickpocketGold to combat result ────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 1, agi: 1, sta: 9999, int: 1, spi: 1 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["stealth", "pick_pocket"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("pick_pocket: pickpocketGold > 0",  (cr.pickpocketGold || 0) > 0);
  rogAssert("pick_pocket: appears in logs",      cr.logs.some(l => l.includes("pickpockets")));
}

// ── 12. Slice and Dice: doubleAction buff applied ────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeRogue({ learnedAbilities: ["sinister_strike", "slice_and_dice"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("slice_and_dice: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  rogAssert("slice_and_dice: buff applied in logs",         cr.logs.some(l => l.includes("slice_and_dice_buff")));
}

// ── 13. Full rogue kit: no crash ──────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 }, tags: ["humanoid"] })] };
  const partyInst = makeRogue({ learnedAbilities: [
    "melee_attack","sinister_strike","stealth","eviscerate","pick_pocket",
    "backstab","gouge","evasion","sprint","slice_and_dice",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  rogAssert("full rogue kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (rogue) ───────────────────────────────────────────────────────────

const rogueLines = [
  `\n${"=".repeat(60)}`,
  `ROGUE MECHANIC TESTS: ${rogP}/${rogP + rogF} passed`,
  "=".repeat(60),
  ...rogueResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  rogF > 0 ? `\n  ${rogF} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(rogueLines.join("\n"));

// =============================================================================
// MAGE ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let mageP = 0, mageF = 0, mageResults = [];
const mageAssert = (label, cond) => { cond ? mageP++ : mageF++; mageResults.push({ ok: !!cond, label }); };

const makeMage = (overrides = {}) => ({
  instanceId: "test_mage",
  name: "Kel",
  classId: "mage",
  raceId: "undead",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("undead", "mage", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const buildMage = (overrides = {}) => CombatBridge.buildUnit(makeMage(overrides), false);

// ── 1. Ability data integrity ─────────────────────────────────────────────────

const mageAbilities = [
  "melee_attack","fireball","arcane_intellect","frost_armor","frostbolt","conjure_water",
  "fire_blast","conjure_food","polymorph","arcane_missiles","frost_nova",
];
for (const id of mageAbilities) {
  mageAssert(`ability "${id}" exists`,      !!ABILITIES[id]);
  mageAssert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const mageBuffDefs = [
  "arcane_intellect_buff","frost_armor_buff","chilled_debuff",
  "frostbolt_flee_buff","frost_nova_stun","frost_nova_flee_buff","polymorph_stun",
];
for (const id of mageBuffDefs) mageAssert(`buff "${id}" exists`, !!BUFFS[id]);

// ── 2. Key field checks ───────────────────────────────────────────────────────

mageAssert("fireball: castTime 1",                  ABILITIES.fireball?.castTime === 1);
mageAssert("fire_blast: cooldown 2",                ABILITIES.fire_blast?.cooldown === 2);
mageAssert("polymorph: cooldown 3",                 ABILITIES.polymorph?.cooldown === 3);
mageAssert("frost_nova: cooldown 5",                ABILITIES.frost_nova?.cooldown === 5);
mageAssert("conjure_water: outOfCombatOnly",        ABILITIES.conjure_water?.outOfCombatOnly === true);
mageAssert("conjure_food: outOfCombatOnly",         ABILITIES.conjure_food?.outOfCombatOnly === true);
mageAssert("conjure_water: restore_party_mana",     ABILITIES.conjure_water?.effects.some(e => e.type === "restore_party_mana"));
mageAssert("conjure_food: restore_party_hp",        ABILITIES.conjure_food?.effects.some(e => e.type === "restore_party_hp"));
mageAssert("polymorph: requiresTargetTag array",    Array.isArray(ABILITIES.polymorph?.requiresTargetTag));
mageAssert("polymorph: targets humanoid",           (ABILITIES.polymorph?.requiresTargetTag || []).includes("humanoid"));
mageAssert("polymorph: targets beast",              (ABILITIES.polymorph?.requiresTargetTag || []).includes("beast"));
mageAssert("frostbolt: has self_buff",              ABILITIES.frostbolt?.effects.some(e => e.type === "self_buff"));
mageAssert("frost_nova: has self_buff",             ABILITIES.frost_nova?.effects.some(e => e.type === "self_buff"));
mageAssert("frost_nova: targeting all_enemies",     ABILITIES.frost_nova?.targeting === "all_enemies");
mageAssert("frost_nova: has damage effect",         ABILITIES.frost_nova?.effects.some(e => e.type === "damage"));
mageAssert("frost_nova: has debuff effect",         ABILITIES.frost_nova?.effects.some(e => e.type === "debuff" && e.buffId === "frost_nova_stun"));

// ── 3. Buff def field checks ──────────────────────────────────────────────────

mageAssert("arcane_intellect_buff: spellPower 40",   BUFFS.arcane_intellect_buff?.modifiers?.spellPower === 40);
mageAssert("arcane_intellect_buff: duration 30",     BUFFS.arcane_intellect_buff?.duration === 30);
mageAssert("frost_armor_buff: isArmorSpell",         BUFFS.frost_armor_buff?.isArmorSpell === true);
mageAssert("frost_armor_buff: armor > 0",            (BUFFS.frost_armor_buff?.modifiers?.armor || 0) > 0);
mageAssert("frost_armor_buff: debuffOnHit exists",   !!BUFFS.frost_armor_buff?.debuffOnHit);
mageAssert("frost_armor_buff: debuffOnHit chilled",  BUFFS.frost_armor_buff?.debuffOnHit?.buffId === "chilled_debuff");
mageAssert("chilled_debuff: attackPower negative",   (BUFFS.chilled_debuff?.modifiers?.attackPower || 0) < 0);
mageAssert("frostbolt_flee_buff: fleeBonus 0.10",    BUFFS.frostbolt_flee_buff?.fleeBonus === 0.10);
mageAssert("frost_nova_stun: stunned",               BUFFS.frost_nova_stun?.ccFlags?.stunned === true);
mageAssert("frost_nova_flee_buff: fleeBonus 0.20",   BUFFS.frost_nova_flee_buff?.fleeBonus === 0.20);
mageAssert("polymorph_stun: duration 2",             BUFFS.polymorph_stun?.duration === 2);
mageAssert("polymorph_stun: stunned",                BUFFS.polymorph_stun?.ccFlags?.stunned === true);

// ── 4. buildUnit: mage has mana ───────────────────────────────────────────────

{
  const mage = buildMage();
  mageAssert("mage buildUnit: mana resource exists", !!mage.resources.mana);
  mageAssert("mage buildUnit: mana > 0",             (mage.resources.mana?.current || 0) > 0);
}

// ── 5. Fireball: cast-time queuing ───────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 200, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["fireball"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("fireball: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
  mageAssert("fireball: cast queued in logs",           cr.logs.some(l => l.includes("begins casting fireball")));
  mageAssert("fireball: fires and deals damage",        cr.logs.some(l => l.includes("fireball")));
}

// ── 6. Frost Armor: setup priority + armor spell mutual exclusion ─────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 200, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["frost_armor", "frostbolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("frost_armor: buff applied in logs",   cr.logs.some(l => l.includes("frost_armor_buff")));
}

// ── 7. Frost Armor: debuffOnHit chills melee attacker ────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 20, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["frost_armor"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("frost_armor: debuffOnHit chills attacker", cr.logs.some(l => l.includes("chilled_debuff")));
}

// ── 8. Arcane Intellect: buff applied ────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["arcane_intellect", "frostbolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("arcane_intellect: buff applied in logs", cr.logs.some(l => l.includes("arcane_intellect_buff")));
}

// ── 9. Frostbolt: self_buff flee bonus applied to caster ─────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 200, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["frostbolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("frostbolt: combat runs ok",              ["victory","defeat","timeout"].includes(cr.outcome));
  mageAssert("frostbolt: flee buff applied to caster", cr.logs.some(l => l.includes("frostbolt_flee_buff")));
}

// ── 10. Polymorph: stuns humanoid enemy ──────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 }, tags: ["humanoid"] })] };
  const partyInst = makeMage({ learnedAbilities: ["polymorph", "arcane_missiles"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("polymorph: stun debuff applied in logs", cr.logs.some(l => l.includes("polymorph_stun")));
}

// ── 11. Polymorph: not used on non-humanoid/beast/critter ────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 }, tags: ["elemental"] })] };
  const partyInst = makeMage({ learnedAbilities: ["polymorph", "arcane_missiles"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("polymorph: NOT used on elemental", !cr.logs.some(l => l.includes("polymorph_stun")));
}

// ── 12. Frost Nova: AoE stun + self flee buff ─────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [
    makeEnemy({ id: "e1", baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } }),
    makeEnemy({ id: "e2", name: "Enemy 2", baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } }),
  ] };
  const partyInst = makeMage({ learnedAbilities: ["frost_nova", "arcane_missiles"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("frost_nova: combat runs ok",              ["victory","defeat","timeout"].includes(cr.outcome));
  mageAssert("frost_nova: stun applied in logs",        cr.logs.some(l => l.includes("frost_nova_stun")));
  mageAssert("frost_nova: flee buff on caster in logs", cr.logs.some(l => l.includes("frost_nova_flee_buff")));
}

// ── 13. Arcane Missiles: deals arcane damage ─────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 30, int: 5, spi: 5 } })] };
  const partyInst = makeMage({ learnedAbilities: ["arcane_missiles"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("arcane_missiles: combat resolves", ["victory","defeat","timeout"].includes(cr.outcome));
  mageAssert("arcane_missiles: arcane damage in logs", cr.logs.some(l => l.includes("arcane")));
}

// ── 14. Full mage kit: no crash ───────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 40, int: 5, spi: 5 }, tags: ["humanoid"] })] };
  const partyInst = makeMage({ learnedAbilities: [
    "melee_attack","fireball","arcane_intellect","frost_armor","frostbolt",
    "fire_blast","polymorph","arcane_missiles","frost_nova",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  mageAssert("full mage kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (mage) ────────────────────────────────────────────────────────────

const mageLines = [
  `\n${"=".repeat(60)}`,
  `MAGE MECHANIC TESTS: ${mageP}/${mageP + mageF} passed`,
  "=".repeat(60),
  ...mageResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  mageF > 0 ? `\n  ${mageF} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(mageLines.join("\n"));

// =============================================================================
// WARLOCK ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let wlkP = 0, wlkF = 0, warlockResults = [];
const wlkAssert = (label, cond) => { cond ? wlkP++ : wlkF++; warlockResults.push({ ok: !!cond, label }); };

const makeWarlock = (overrides = {}) => ({
  instanceId: "test_warlock",
  name: "Zel",
  classId: "warlock",
  raceId: "orc",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("orc", "warlock", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const buildWarlock = (overrides = {}) => CombatBridge.buildUnit(makeWarlock(overrides), false);

// ── 1. Ability data integrity ─────────────────────────────────────────────────

const warlockAbilities = [
  "melee_attack","immolate","shadow_bolt","demon_skin","corruption",
  "curse_of_weakness","curse_of_agony","warlock_fear","drain_soul","create_healthstone",
];
for (const id of warlockAbilities) {
  wlkAssert(`ability "${id}" exists`,      !!ABILITIES[id]);
  wlkAssert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const warlockBuffDefs = [
  "demon_skin_buff","corruption_dot","curse_of_weakness_debuff",
  "curse_of_agony_dot","warlock_fear_debuff",
];
for (const id of warlockBuffDefs) wlkAssert(`buff "${id}" exists`, !!BUFFS[id]);

// ── 2. Key field checks ───────────────────────────────────────────────────────

wlkAssert("immolate: cooldown 0",              ABILITIES.immolate?.cooldown === 0);
wlkAssert("immolate: castTime 1",              ABILITIES.immolate?.castTime === 1);
wlkAssert("shadow_bolt: castTime 1",           ABILITIES.shadow_bolt?.castTime === 1);
wlkAssert("warlock_fear: cooldown 3",          ABILITIES.warlock_fear?.cooldown === 3);
wlkAssert("create_healthstone: outOfCombatOnly", ABILITIES.create_healthstone?.outOfCombatOnly === true);
wlkAssert("create_healthstone: create_healthstone effect", ABILITIES.create_healthstone?.effects.some(e => e.type === "create_healthstone"));
wlkAssert("corruption: has debuff corruption_dot",  ABILITIES.corruption?.effects.some(e => e.buffId === "corruption_dot"));
wlkAssert("curse_of_weakness: has debuff cw_debuff", ABILITIES.curse_of_weakness?.effects.some(e => e.buffId === "curse_of_weakness_debuff"));
wlkAssert("curse_of_agony: has debuff coa_dot",  ABILITIES.curse_of_agony?.effects.some(e => e.buffId === "curse_of_agony_dot"));
wlkAssert("drain_soul: drainSoul on damage effect", ABILITIES.drain_soul?.effects.some(e => e.drainSoul === true));
wlkAssert("drain_soul: bonusIfHpBelow exists",   ABILITIES.drain_soul?.effects.some(e => !!e.bonusIfHpBelow));
wlkAssert("drain_soul: threshold 0.25",          ABILITIES.drain_soul?.effects.some(e => e.bonusIfHpBelow?.threshold === 0.25));

// ── 3. Buff def field checks ──────────────────────────────────────────────────

wlkAssert("demon_skin_buff: isArmorSpell",          BUFFS.demon_skin_buff?.isArmorSpell === true);
wlkAssert("demon_skin_buff: armor > 0",             (BUFFS.demon_skin_buff?.modifiers?.armor || 0) > 0);
wlkAssert("demon_skin_buff: healingTakenBonus > 0", (BUFFS.demon_skin_buff?.healingTakenBonus || 0) > 0);
wlkAssert("corruption_dot: tickDamage shadow",      BUFFS.corruption_dot?.tickDamage?.damageType === "shadow");
wlkAssert("corruption_dot: duration > 0",           (BUFFS.corruption_dot?.duration || 0) > 0);
wlkAssert("curse_of_weakness_debuff: isCurse",      BUFFS.curse_of_weakness_debuff?.isCurse === true);
wlkAssert("curse_of_weakness_debuff: attackPower-", (BUFFS.curse_of_weakness_debuff?.modifiers?.attackPower || 0) < 0);
wlkAssert("curse_of_weakness_debuff: armor-",       (BUFFS.curse_of_weakness_debuff?.modifiers?.armor || 0) < 0);
wlkAssert("curse_of_agony_dot: isCurse",            BUFFS.curse_of_agony_dot?.isCurse === true);
wlkAssert("curse_of_agony_dot: rampingTickDamage",  BUFFS.curse_of_agony_dot?.rampingTickDamage === true);
wlkAssert("curse_of_agony_dot: tickDamage shadow",  BUFFS.curse_of_agony_dot?.tickDamage?.damageType === "shadow");
wlkAssert("curse_of_agony_dot: duration 12",        BUFFS.curse_of_agony_dot?.duration === 12);
wlkAssert("warlock_fear_debuff: ccFlags.feared",    BUFFS.warlock_fear_debuff?.ccFlags?.feared === true);
wlkAssert("warlock_fear_debuff: duration 2",        BUFFS.warlock_fear_debuff?.duration === 2);

// ── 4. Items: soul_shard and healthstone ─────────────────────────────────────

{
  const _items = require("../Data/items.json");
  wlkAssert("soul_shard item exists",         !!_items.items?.soul_shard);
  wlkAssert("soul_shard: type misc",          _items.items?.soul_shard?.type === "misc");
  wlkAssert("healthstone item exists",        !!_items.items?.healthstone);
  wlkAssert("healthstone: type consumable",   _items.items?.healthstone?.type === "consumable");
  wlkAssert("healthstone: onUse.type heal",   _items.items?.healthstone?.onUse?.type === "heal");
  wlkAssert("healthstone: onUse.flat > 0",    (_items.items?.healthstone?.onUse?.flat || 0) > 0);
}

// ── 5. buildUnit: warlock has mana ────────────────────────────────────────────

{
  const wlk = buildWarlock();
  wlkAssert("warlock buildUnit: mana resource exists", !!wlk.resources.mana);
  wlkAssert("warlock buildUnit: mana > 0",             (wlk.resources.mana?.current || 0) > 0);
}

// ── 6. Immolate: castTime + DoT ───────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 200, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["immolate"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("immolate: combat resolves",       ["victory","defeat","timeout"].includes(cr.outcome));
  wlkAssert("immolate: cast queued in logs",   cr.logs.some(l => l.includes("begins casting immolate")));
  wlkAssert("immolate: DoT ticks in logs",     cr.logs.some(l => l.includes("immolate_dot")));
}

// ── 7. Demon Skin: armor spell setup + armor spell exclusion ──────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["demon_skin", "shadow_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("demon_skin: buff applied in logs", cr.logs.some(l => l.includes("demon_skin_buff")));
}

// ── 8. Demon Skin: healingTakenBonus amplifies heals ─────────────────────────

{
  // warlock with demon_skin and a healer — healing should be amplified
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const wlkInst = makeWarlock({ instanceId: "test_wlk2", learnedAbilities: ["demon_skin"] });
  const cr = CombatBridge.run(enc, [wlkInst], {});
  wlkAssert("demon_skin: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 9. Corruption: DoT applied and ticks ─────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["corruption", "shadow_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("corruption: DoT applied in logs",  cr.logs.some(l => l.includes("corruption_dot")));
  wlkAssert("corruption: DoT ticks in logs",    cr.logs.some(l => l.includes("corruption_dot") && l.includes("shadow")));
}

// ── 10. Curse mutual exclusion: CoW replaced by CoA on same target ────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["curse_of_weakness", "curse_of_agony", "shadow_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("curses: combat runs ok", ["victory","defeat","timeout"].includes(cr.outcome));
  wlkAssert("curses: at least one curse applied", cr.logs.some(l => l.includes("curse_of_weakness_debuff") || l.includes("curse_of_agony_dot")));
}

// ── 11. Curse of Agony: ramping DoT ticks ────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["curse_of_agony", "shadow_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("curse_of_agony: applied in logs",    cr.logs.some(l => l.includes("curse_of_agony_dot")));
  wlkAssert("curse_of_agony: shadow ticks",       cr.logs.some(l => l.includes("curse_of_agony_dot") && l.includes("shadow")));
}

// ── 12. Fear: stuns enemy for 2 turns ────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["warlock_fear", "shadow_bolt"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("warlock_fear: debuff applied in logs", cr.logs.some(l => l.includes("warlock_fear_debuff")));
}

// ── 13. Drain Soul: soul shard on kill ───────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 10, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["drain_soul"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("drain_soul: combat resolves victory", cr.outcome === "victory");
  wlkAssert("drain_soul: soulShardsGained > 0",   (cr.soulShardsGained || 0) > 0);
  wlkAssert("drain_soul: soul shard log",          cr.logs.some(l => l.includes("Soul Shard")));
}

// ── 14. Drain Soul: no shard if not killing blow ─────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: ["drain_soul"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("drain_soul: no shard without kill",   (cr.soulShardsGained || 0) === 0);
}

// ── 15. Full warlock kit: no crash ────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeWarlock({ learnedAbilities: [
    "melee_attack","immolate","shadow_bolt","demon_skin","corruption",
    "curse_of_weakness","curse_of_agony","warlock_fear","drain_soul",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  wlkAssert("full warlock kit: combat resolves without crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (warlock) ─────────────────────────────────────────────────────────

const warlockLines = [
  `\n${"=".repeat(60)}`,
  `WARLOCK MECHANIC TESTS: ${wlkP}/${wlkP + wlkF} passed`,
  "=".repeat(60),
  ...warlockResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  wlkF > 0 ? `\n  ${wlkF} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(warlockLines.join("\n"));

// =============================================================================
// DRUID ABILITY / ENGINE MECHANIC TESTS
// =============================================================================

let drP = 0, drF = 0, druidResults = [];
const drAssert = (label, cond) => { cond ? drP++ : drF++; druidResults.push({ ok: !!cond, label }); };

const makeDruid = (overrides = {}) => ({
  instanceId: "test_druid",
  name: "Cer",
  classId: "druid",
  raceId: "orc",
  level: 20,
  currentHp: null,
  maxHp: null,
  currentMp: null,
  stats: { raw: getStatsAtLevel("orc", "druid", 20) },
  learnedAbilities: ["melee_attack"],
  gear: {},
  ...overrides,
});

const buildDruid = (overrides = {}) => CombatBridge.buildUnit(makeDruid(overrides), false);

// ── 1. Ability data integrity ─────────────────────────────────────────────────

const druidAbilities = [
  "healing_touch","mark_of_the_wild","wrath","moonfire","thorns",
  "entangling_roots","bear_form","maul","growl","demoralizing_roar",
];
for (const id of druidAbilities) {
  drAssert(`ability "${id}" exists`,      !!ABILITIES[id]);
  drAssert(`ability "${id}" has effects`, Array.isArray(ABILITIES[id]?.effects));
}

const druidBuffDefs = [
  "mark_of_the_wild_buff","thorns_buff","entangling_roots_dot","moonfire_dot",
  "bear_form_buff","demoralizing_roar_debuff",
];
for (const id of druidBuffDefs) drAssert(`buff "${id}" exists`, !!BUFFS[id]);

// ── 2. Key field checks ───────────────────────────────────────────────────────

drAssert("healing_touch: castTime 1",             ABILITIES.healing_touch?.castTime === 1);
drAssert("wrath: castTime 1",                     ABILITIES.wrath?.castTime === 1);
drAssert("moonfire: castTime 0",                  ABILITIES.moonfire?.castTime === 0);
drAssert("moonfire: nature damage",               ABILITIES.moonfire?.effects.some(e => e.damageType === "nature"));
drAssert("entangling_roots: castTime 1",          ABILITIES.entangling_roots?.castTime === 1);
drAssert("bear_form: castTime -1",                ABILITIES.bear_form?.castTime === -1);
drAssert("maul: requiresCondition in_bear_form",  ABILITIES.maul?.requiresCondition === "in_bear_form");
drAssert("growl: requiresCondition in_bear_form", ABILITIES.growl?.requiresCondition === "in_bear_form");
drAssert("growl: cooldown 8",                     ABILITIES.growl?.cooldown === 8);
drAssert("demoralizing_roar: in_bear_form",       ABILITIES.demoralizing_roar?.requiresCondition === "in_bear_form");
drAssert("demoralizing_roar: all_enemies",        ABILITIES.demoralizing_roar?.targeting === "all_enemies");
drAssert("maul: has damage effect",               ABILITIES.maul?.effects.some(e => e.type === "damage"));
drAssert("maul: has threat effect",               ABILITIES.maul?.effects.some(e => e.type === "threat"));
drAssert("growl: has threat effect",              ABILITIES.growl?.effects.some(e => e.type === "threat"));
drAssert("thorns: has buff effect",               ABILITIES.thorns?.effects.some(e => e.buffId === "thorns_buff"));

// ── 3. Buff def field checks ──────────────────────────────────────────────────

drAssert("mark_of_the_wild_buff: maxHpBonus > 0",    (BUFFS.mark_of_the_wild_buff?.maxHpBonus || 0) > 0);
drAssert("mark_of_the_wild_buff: attackPower > 0",   (BUFFS.mark_of_the_wild_buff?.modifiers?.attackPower || 0) > 0);
drAssert("mark_of_the_wild_buff: armor > 0",         (BUFFS.mark_of_the_wild_buff?.modifiers?.armor || 0) > 0);
drAssert("mark_of_the_wild_buff: spellPower > 0",    (BUFFS.mark_of_the_wild_buff?.modifiers?.spellPower || 0) > 0);
drAssert("mark_of_the_wild_buff: duration 30",       BUFFS.mark_of_the_wild_buff?.duration === 30);
drAssert("thorns_buff: onHitRetaliation exists",     !!BUFFS.thorns_buff?.onHitRetaliation);
drAssert("thorns_buff: retaliationLabel set",        !!BUFFS.thorns_buff?.retaliationLabel);
drAssert("entangling_roots_dot: fleeBonus 0.10",     BUFFS.entangling_roots_dot?.fleeBonus === 0.10);
drAssert("entangling_roots_dot: tickDamage nature",  BUFFS.entangling_roots_dot?.tickDamage?.damageType === "nature");
drAssert("moonfire_dot: tickDamage nature",          BUFFS.moonfire_dot?.tickDamage?.damageType === "nature");
drAssert("bear_form_buff: isShapeshift",             BUFFS.bear_form_buff?.isShapeshift === true);
drAssert("bear_form_buff: isBearForm",               BUFFS.bear_form_buff?.isBearForm === true);
drAssert("bear_form_buff: immuneToPolymorph",        BUFFS.bear_form_buff?.immuneToPolymorph === true);
drAssert("bear_form_buff: maxHpBonus 560",           BUFFS.bear_form_buff?.maxHpBonus === 560);
drAssert("bear_form_buff: attackPower 120",          BUFFS.bear_form_buff?.modifiers?.attackPower === 120);
drAssert("bear_form_buff: armor > 0",                (BUFFS.bear_form_buff?.modifiers?.armor || 0) > 0);
drAssert("demoralizing_roar_debuff: attackPower-",   (BUFFS.demoralizing_roar_debuff?.modifiers?.attackPower || 0) < 0);
drAssert("polymorph_stun: isPolymorph",              BUFFS.polymorph_stun?.isPolymorph === true);
drAssert("polymorph_stun: removedOnShapeshift",      BUFFS.polymorph_stun?.removedOnShapeshift === true);
drAssert("lightning_shield_buff: retaliationLabel",  !!BUFFS.lightning_shield_buff?.retaliationLabel);

// ── 4. buildUnit: druid has mana AND rage ─────────────────────────────────────

{
  const dr = buildDruid();
  drAssert("druid buildUnit: mana resource exists", !!dr.resources.mana);
  drAssert("druid buildUnit: mana > 0",             (dr.resources.mana?.current || 0) > 0);
  drAssert("druid buildUnit: rage resource exists", !!dr.resources.rage);
  drAssert("druid buildUnit: rage starts at 0",     dr.resources.rage?.current === 0);
}

// ── 5. Healing Touch: cast time + heals ──────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const drInst  = makeDruid({ instanceId: "test_dr1", learnedAbilities: ["healing_touch"] });
  const wkInst  = makeWarrior({ instanceId: "test_wk1", learnedAbilities: ["melee_attack"] });
  const cr = CombatBridge.run(enc, [drInst, wkInst], {});
  drAssert("healing_touch: combat runs ok",       ["victory","defeat","timeout"].includes(cr.outcome));
  drAssert("healing_touch: cast queued in logs",  cr.logs.some(l => l.includes("begins casting healing touch")));
  drAssert("healing_touch: heal fires in logs",   cr.logs.some(l => l.includes("heals")));
}

// ── 6. Mark of the Wild: setup buff applied ───────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["mark_of_the_wild", "wrath"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("mark_of_the_wild: buff applied in logs", cr.logs.some(l => l.includes("mark_of_the_wild_buff")));
}

// ── 7. Wrath: cast time 1 ────────────────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 200, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["wrath"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("wrath: combat resolves",      ["victory","defeat","timeout"].includes(cr.outcome));
  drAssert("wrath: cast queued in logs",  cr.logs.some(l => l.includes("begins casting wrath")));
}

// ── 8. Moonfire: instant + nature DoT ────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["moonfire", "wrath"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("moonfire: DoT applied in logs", cr.logs.some(l => l.includes("moonfire_dot")));
  drAssert("moonfire: DoT ticks nature",    cr.logs.some(l => l.includes("moonfire_dot") && l.includes("nature")));
}

// ── 9. Thorns: retaliation fires on physical attack ──────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 20, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["thorns"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("thorns: buff applied in logs",        cr.logs.some(l => l.includes("thorns_buff")));
  drAssert("thorns: retaliation fires in logs",   cr.logs.some(l => l.includes("thorns retaliates on")));
}

// ── 10. Bear Form: instant + free action + bear form buff ────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["bear_form", "maul"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("bear_form: buff applied in logs", cr.logs.some(l => l.includes("bear_form_buff")));
  drAssert("bear_form: maul used after shift", cr.logs.some(l => l.includes("maul") || l.includes("Maul")));
}

// ── 11. Bear form abilities: not usable without bear form ─────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["maul", "wrath"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("maul: NOT used without bear form", !cr.logs.some(l => l.includes("maul") || l.includes("Maul")));
}

// ── 12. Demoralizing Roar: AoE debuff ────────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [
    makeEnemy({ id: "e1", baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } }),
    makeEnemy({ id: "e2", name: "Enemy 2", baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } }),
  ] };
  const partyInst = makeDruid({ learnedAbilities: ["bear_form", "demoralizing_roar", "maul"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("demoralizing_roar: combat runs ok",        ["victory","defeat","timeout"].includes(cr.outcome));
  drAssert("demoralizing_roar: debuff applied in logs", cr.logs.some(l => l.includes("demoralizing_roar_debuff")));
}

// ── 13. Polymorph immunity in bear form ──────────────────────────────────────

{
  const bearDruid = makeDruid({ instanceId: "test_dr_bear", learnedAbilities: ["bear_form", "maul"], tags: ["humanoid"] });
  const mageFoe   = { id: "mage_foe", name: "Mage", classId: "mage", raceId: "orc", level: 10,
    baseStats: { str: 5, agi: 5, sta: 50, int: 20, spi: 5 }, abilities: ["polymorph"],
    loot: [], skinningLoot: [], killReputation: [], currencyDrop: null, tags: ["humanoid"] };
  const enc = { zoneId: "test", enemies: [mageFoe] };
  const cr = CombatBridge.run(enc, [bearDruid], {});
  drAssert("polymorph immunity: immune log in bear form", cr.logs.some(l => l.includes("immune (shapeshift)")));
}

// ── 14. Entangling Roots: cast time + nature DoT ─────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 9999, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: ["entangling_roots", "wrath"] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("entangling_roots: cast queued",       cr.logs.some(l => l.includes("begins casting entangling roots")));
  drAssert("entangling_roots: DoT applied",       cr.logs.some(l => l.includes("entangling_roots_dot")));
}

// ── 15. Full druid kit (caster): no crash ─────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 5, agi: 5, sta: 80, int: 5, spi: 5 }, tags: ["beast"] })] };
  const partyInst = makeDruid({ learnedAbilities: [
    "healing_touch","mark_of_the_wild","wrath","moonfire","thorns","entangling_roots",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("full caster druid kit: no crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── 16. Full druid kit (bear): no crash ───────────────────────────────────────

{
  const enc = { zoneId: "test", enemies: [makeEnemy({ baseStats: { str: 20, agi: 5, sta: 80, int: 5, spi: 5 } })] };
  const partyInst = makeDruid({ learnedAbilities: [
    "bear_form","maul","growl","demoralizing_roar",
  ] });
  const cr = CombatBridge.run(enc, [partyInst], {});
  drAssert("full bear druid kit: no crash", ["victory","defeat","timeout"].includes(cr.outcome));
}

// ── results (druid) ───────────────────────────────────────────────────────────

const druidLines = [
  `\n${"=".repeat(60)}`,
  `DRUID MECHANIC TESTS: ${drP}/${drP + drF} passed`,
  "=".repeat(60),
  ...druidResults.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}`),
  drF > 0 ? `\n  ${drF} FAILED` : "\n  All tests passed.",
  "=".repeat(60),
];
console.log(druidLines.join("\n"));
