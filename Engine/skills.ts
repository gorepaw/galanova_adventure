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

import type { ClassesData, SkillsData, ClassDef, SkillDef, Skills, SkillEntry } from "./types/data.js";

const _skillsData = require("../Data/skills.json") as SkillsData;
const _classData = require("../Data/classes.json") as ClassesData;

export const SKILL_DEFS: Record<string, SkillDef> = _skillsData.skills || {};
export const SKILL_MAX_LEVEL: number = _skillsData.maxLevel || 99;
const CLASS_DEFS: Record<string, ClassDef> = _classData.classes || {};

// A loose instance shape — these helpers run on full CompanionInstances and on
// bare test fixtures alike, so they only constrain the fields they touch.
type SkillCarrier = {
  skills?: Skills;
  classId?: string;
  unlockedSkills?: string[];
  [key: string]: unknown;
};

// weaponType -> skillId (e.g. "sword_1h" -> "one_handed_swords")
export const WEAPON_TYPE_SKILL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of Object.values(SKILL_DEFS))
    for (const wt of (s.weaponTypes || [])) m[wt] = s.id;
  return m;
})();

// abilityId -> skillId (reverse of ability tables). basic_attack is granted by
// every weapon skill, so it is resolved by the equipped weapon at runtime, not here.
export const ABILITY_SKILL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of Object.values(SKILL_DEFS))
    for (const a of (s.abilities || [])) {
      if (a.id === "basic_attack") continue;
      if (!m[a.id]) m[a.id] = s.id;
    }
  return m;
})();

// XP to go from skill level L to L+1 (index L-1). Quadratic; tune later.
export const SKILL_XP_TABLE: number[] = Array.from({ length: SKILL_MAX_LEVEL }, (_, i) => 50 * (i + 1) * (i + 2));
export const skillXpToNext = (level: number): number =>
  (level >= SKILL_MAX_LEVEL ? Infinity : SKILL_XP_TABLE[level - 1]);

// Normalize a skill entry: number (legacy level) or { level, xp } -> { level, xp }.
export const normSkill = (v: SkillEntry | number | null | undefined): SkillEntry =>
  (typeof v === "number") ? { level: v, xp: 0 } : { level: (v?.level ?? 1), xp: (v?.xp ?? 0) };

export const getSkillLevel = (inst: SkillCarrier | undefined, skillId: string): number => {
  const v = inst?.skills?.[skillId];
  return v == null ? 0 : normSkill(v).level;
};

export interface SkillLevelUp { skillId: string; level: number; }

// Add skill XP, levelling to SKILL_MAX_LEVEL. Returns { inst, levelUps:[{skillId,level}] }.
export const addSkillXp = (inst: SkillCarrier, skillId: string, amount: number): { inst: SkillCarrier; levelUps: SkillLevelUp[] } => {
  if (!skillId || !amount || amount <= 0) return { inst, levelUps: [] };
  const skills: Skills = { ...(inst.skills || {}) };
  const cur = normSkill(skills[skillId] ?? { level: 1, xp: 0 });
  let { level, xp } = cur;
  xp += amount;
  const levelUps: SkillLevelUp[] = [];
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
export const abilitiesFromSkills = (inst: SkillCarrier | undefined): string[] => {
  const out = new Set<string>();
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
export const canEquipWeaponType = (inst: SkillCarrier | undefined, weaponType: string): boolean => {
  const skillId = WEAPON_TYPE_SKILL[weaponType];
  if (!skillId) return true; // unknown / non-gated weaponType
  return getSkillLevel(inst, skillId) >= 1;
};

// Which skill should an ability use grant XP to? basic_attack -> equipped weapon's
// skill; with no melee weapon, it trains the unarmed skill (the "unarmed" weaponType
// maps to it). Everything else -> its owning skill from the ability tables.
export const skillForAbilityUse = (abilityId: string, equippedWeaponType: string | null | undefined): string | null => {
  if (abilityId === "basic_attack")
    return WEAPON_TYPE_SKILL[equippedWeaponType || "unarmed"] || null;
  return ABILITY_SKILL[abilityId] || null;
};

// Universal skills every character has (not listed per class).
export const UNIVERSAL_SKILLS = ["running", "climbing", "swimming", "riding", "trading", "dungeoneering"];

// Trainable skills = class list (+ universal + narrative-unlocked skills on the instance).
export const trainableSkills = (classId: string, inst?: SkillCarrier): string[] => {
  const fromClass = (CLASS_DEFS[classId]?.skills) || [];
  const unlocked  = inst?.unlockedSkills || [];
  return [...new Set([...fromClass, ...UNIVERSAL_SKILLS, ...unlocked])];
};

// Starting skills map for a class: every class skill + universal skills at level 1.
export const startingSkills = (classId: string): Skills => {
  const out: Skills = {};
  for (const s of [...(CLASS_DEFS[classId]?.skills || []), ...UNIVERSAL_SKILLS]) out[s] = { level: 1, xp: 0 };
  return out;
};

// Grant a narrative-unlocked skill (outside the class list) at level 1.
export const grantSkill = (inst: SkillCarrier, skillId: string): SkillCarrier => {
  if (!SKILL_DEFS[skillId]) return inst;
  const unlockedSkills = [...new Set([...(inst.unlockedSkills || []), skillId])];
  const skills: Skills = { ...(inst.skills || {}) };
  if (skills[skillId] == null) skills[skillId] = { level: 1, xp: 0 };
  return { ...inst, unlockedSkills, skills };
};


// =============================================================================
// SELF-TEST
// =============================================================================

interface TestResult { ok: boolean; label: string; }

export const runSkillTests = (): { passed: number; failed: number; total: number; results: TestResult[] } => {
  const results: TestResult[] = []; let p = 0, f = 0;
  const assert = (label: string, cond: unknown) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  assert("weaponType map: sword_1h -> one_handed_swords", WEAPON_TYPE_SKILL["sword_1h"] === "one_handed_swords");
  assert("weaponType map: staff -> staves",               WEAPON_TYPE_SKILL["staff"] === "staves");
  assert("ability map excludes basic_attack",             !("basic_attack" in ABILITY_SKILL));

  const arms: SkillCarrier = { classId: "armsman", skills: startingSkills("armsman") };
  assert("startingSkills: armsman has one_handed_swords L1", normSkill(arms.skills!.one_handed_swords).level === 1);
  assert("abilitiesFromSkills: weapon skill grants basic_attack", abilitiesFromSkills(arms).includes("basic_attack"));

  assert("canEquip: armsman can equip sword_1h",  canEquipWeaponType(arms, "sword_1h"));
  const illu: SkillCarrier = { classId: "illusionist", skills: startingSkills("illusionist") };
  assert("canEquip: illusionist cannot equip sword_1h (no skill)", !canEquipWeaponType(illu, "sword_1h"));
  assert("canEquip: illusionist can equip staff", canEquipWeaponType(illu, "staff"));

  // skill xp / level up
  const { inst: leveled, levelUps } = addSkillXp(arms, "one_handed_swords", skillXpToNext(1));
  assert("addSkillXp: levels skill 1->2", normSkill(leveled.skills!.one_handed_swords).level === 2);
  assert("addSkillXp: reports level up", levelUps.length === 1 && levelUps[0].level === 2);

  assert("skillForAbilityUse: basic_attack -> equipped weapon skill",
    skillForAbilityUse("basic_attack", "dagger") === "daggers");
  assert("skillForAbilityUse: bare-handed basic_attack -> unarmed",
    skillForAbilityUse("basic_attack", null) === "unarmed");
  assert("weaponType map: unarmed -> unarmed skill", WEAPON_TYPE_SKILL["unarmed"] === "unarmed");

  // normalize legacy profession number
  const legacy: SkillCarrier = { skills: { mining: 40 } };
  assert("normSkill: legacy number -> level", getSkillLevel(legacy, "mining") === 40);

  // grant unlocked skill
  const granted = grantSkill(arms, "pyromancy");
  assert("grantSkill: adds unlocked skill", (granted.unlockedSkills || []).includes("pyromancy") && normSkill(granted.skills!.pyromancy).level === 1);
  assert("trainableSkills: includes unlocked", trainableSkills("armsman", granted).includes("pyromancy"));

  return { passed: p, failed: f, total: p + f, results };
};
