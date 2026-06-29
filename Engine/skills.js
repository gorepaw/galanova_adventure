// =============================================================================
// SKILLS SYSTEM (Galanova)
//
// All skills (weapon, magic, profession, utility) level 1..99 via their own XP.
// Abilities are unlocked by skill level (skills.json ability tables), never by
// class level. Weapon skills gate weapon equipping. Professions keep their
// function but level via XP like everything else.
//
// Skill storage on an instance: inst.skills[skillId] = { level, xp }.
// Legacy profession entries (plain numbers = level) are auto-normalized.
//
// DEPENDENCIES: Data/skills.json, Data/classes.json
// =============================================================================

"use strict";

const _skillsData = require('../Data/skills.json');
const _classData  = require('../Data/classes.json');

const SKILL_DEFS      = _skillsData.skills || {};
const SKILL_MAX_LEVEL = _skillsData.maxLevel || 99;
const CLASS_DEFS      = _classData.classes || {};

// weaponType -> skillId (e.g. "sword_1h" -> "one_handed_swords")
const WEAPON_TYPE_SKILL = (() => {
  const m = {};
  for (const s of Object.values(SKILL_DEFS))
    for (const wt of (s.weaponTypes || [])) m[wt] = s.id;
  return m;
})();

// abilityId -> skillId (reverse of ability tables). basic_attack is granted by
// every weapon skill, so it is resolved by the equipped weapon at runtime, not here.
const ABILITY_SKILL = (() => {
  const m = {};
  for (const s of Object.values(SKILL_DEFS))
    for (const a of (s.abilities || [])) {
      if (a.id === "basic_attack") continue;
      if (!m[a.id]) m[a.id] = s.id;
    }
  return m;
})();

// XP to go from skill level L to L+1 (index L-1). Quadratic; tune later.
const SKILL_XP_TABLE = Array.from({ length: SKILL_MAX_LEVEL }, (_, i) => 50 * (i + 1) * (i + 2));
const skillXpToNext  = (level) => (level >= SKILL_MAX_LEVEL ? Infinity : SKILL_XP_TABLE[level - 1]);

// Normalize a skill entry: number (legacy level) or { level, xp } -> { level, xp }.
const normSkill = (v) =>
  (typeof v === "number") ? { level: v, xp: 0 } : { level: (v?.level ?? 1), xp: (v?.xp ?? 0) };

const getSkillLevel = (inst, skillId) => {
  const v = inst?.skills?.[skillId];
  return v == null ? 0 : normSkill(v).level;
};

// Add skill XP, levelling to SKILL_MAX_LEVEL. Returns { inst, levelUps:[{skillId,level}] }.
const addSkillXp = (inst, skillId, amount) => {
  if (!skillId || !amount || amount <= 0) return { inst, levelUps: [] };
  const skills = { ...(inst.skills || {}) };
  const cur = normSkill(skills[skillId] ?? { level: 1, xp: 0 });
  let { level, xp } = cur;
  xp += amount;
  const levelUps = [];
  while (level < SKILL_MAX_LEVEL && xp >= skillXpToNext(level)) {
    xp -= skillXpToNext(level);
    level += 1;
    levelUps.push({ skillId, level });
  }
  if (level >= SKILL_MAX_LEVEL) xp = 0;
  skills[skillId] = { level, xp };
  return { inst: { ...inst, skills }, levelUps };
};

// Abilities a character has unlocked from its skills (skillLevel thresholds met).
const abilitiesFromSkills = (inst) => {
  const out = new Set();
  for (const [skillId, raw] of Object.entries(inst?.skills || {})) {
    const def = SKILL_DEFS[skillId];
    if (!def) continue;
    const lvl = normSkill(raw).level;
    for (const a of (def.abilities || []))
      if (lvl >= (a.skillLevel ?? 1)) out.add(a.id);
  }
  return [...out];
};

// Weapon equip gating: can this character equip the given weaponType?
const canEquipWeaponType = (inst, weaponType) => {
  const skillId = WEAPON_TYPE_SKILL[weaponType];
  if (!skillId) return true; // unknown / non-gated weaponType
  return getSkillLevel(inst, skillId) >= 1;
};

// Which skill should an ability use grant XP to? basic_attack -> equipped weapon's
// skill; with no melee weapon, it trains the unarmed skill (the "unarmed" weaponType
// maps to it). Everything else -> its owning skill from the ability tables.
const skillForAbilityUse = (abilityId, equippedWeaponType) => {
  if (abilityId === "basic_attack")
    return WEAPON_TYPE_SKILL[equippedWeaponType || "unarmed"] || null;
  return ABILITY_SKILL[abilityId] || null;
};

// Universal skills every character has (not listed per class).
const UNIVERSAL_SKILLS = ["running", "climbing", "swimming", "riding", "trading", "dungeoneering"];

// Trainable skills = class list (+ universal + narrative-unlocked skills on the instance).
const trainableSkills = (classId, inst) => {
  const fromClass = (CLASS_DEFS[classId]?.skills) || [];
  const unlocked  = inst?.unlockedSkills || [];
  return [...new Set([...fromClass, ...UNIVERSAL_SKILLS, ...unlocked])];
};

// Starting skills map for a class: every class skill + universal skills at level 1.
const startingSkills = (classId) => {
  const out = {};
  for (const s of [...(CLASS_DEFS[classId]?.skills || []), ...UNIVERSAL_SKILLS]) out[s] = { level: 1, xp: 0 };
  return out;
};

// Grant a narrative-unlocked skill (outside the class list) at level 1.
const grantSkill = (inst, skillId) => {
  if (!SKILL_DEFS[skillId]) return inst;
  const unlockedSkills = [...new Set([...(inst.unlockedSkills || []), skillId])];
  const skills = { ...(inst.skills || {}) };
  if (skills[skillId] == null) skills[skillId] = { level: 1, xp: 0 };
  return { ...inst, unlockedSkills, skills };
};


// =============================================================================
// SELF-TEST
// =============================================================================

const runSkillTests = () => {
  const results = []; let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  assert("weaponType map: sword_1h -> one_handed_swords", WEAPON_TYPE_SKILL["sword_1h"] === "one_handed_swords");
  assert("weaponType map: staff -> staves",               WEAPON_TYPE_SKILL["staff"] === "staves");
  assert("ability map excludes basic_attack",             !("basic_attack" in ABILITY_SKILL));

  const arms = { classId: "armsman", skills: startingSkills("armsman") };
  assert("startingSkills: armsman has one_handed_swords L1", arms.skills.one_handed_swords?.level === 1);
  assert("abilitiesFromSkills: weapon skill grants basic_attack", abilitiesFromSkills(arms).includes("basic_attack"));

  assert("canEquip: armsman can equip sword_1h",  canEquipWeaponType(arms, "sword_1h"));
  const illu = { classId: "illusionist", skills: startingSkills("illusionist") };
  assert("canEquip: illusionist cannot equip sword_1h (no skill)", !canEquipWeaponType(illu, "sword_1h"));
  assert("canEquip: illusionist can equip staff", canEquipWeaponType(illu, "staff"));

  // skill xp / level up
  const { inst: leveled, levelUps } = addSkillXp(arms, "one_handed_swords", skillXpToNext(1));
  assert("addSkillXp: levels skill 1->2", leveled.skills.one_handed_swords.level === 2);
  assert("addSkillXp: reports level up", levelUps.length === 1 && levelUps[0].level === 2);

  assert("skillForAbilityUse: basic_attack -> equipped weapon skill",
    skillForAbilityUse("basic_attack", "dagger") === "daggers");
  assert("skillForAbilityUse: bare-handed basic_attack -> unarmed",
    skillForAbilityUse("basic_attack", null) === "unarmed");
  assert("weaponType map: unarmed -> unarmed skill", WEAPON_TYPE_SKILL["unarmed"] === "unarmed");

  // normalize legacy profession number
  const legacy = { skills: { mining: 40 } };
  assert("normSkill: legacy number -> level", getSkillLevel(legacy, "mining") === 40);

  // grant unlocked skill
  const granted = grantSkill(arms, "pyromancy");
  assert("grantSkill: adds unlocked skill", granted.unlockedSkills.includes("pyromancy") && granted.skills.pyromancy?.level === 1);
  assert("trainableSkills: includes unlocked", trainableSkills("armsman", granted).includes("pyromancy"));

  return { passed: p, failed: f, total: p + f, results };
};


if (typeof module !== "undefined") {
  module.exports = {
    SKILL_DEFS, SKILL_MAX_LEVEL, UNIVERSAL_SKILLS, WEAPON_TYPE_SKILL, ABILITY_SKILL, SKILL_XP_TABLE,
    skillXpToNext, normSkill, getSkillLevel, addSkillXp, abilitiesFromSkills,
    canEquipWeaponType, skillForAbilityUse, trainableSkills, startingSkills, grantSkill,
    runSkillTests,
  };
}
