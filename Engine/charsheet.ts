// =============================================================================
// MODULE — character SHEET (display view-model)
// Single source of truth for the numbers shown on the character screen: gear-
// inclusive attribute totals, derived combat stats, resistances, and a display
// view of each skill (level + xp + xp-to-next). The renderer consumes this over
// IPC and does NOT recompute — so changing a formula here changes the UI with no
// separate UI edit. Mirrors the derivation in gameplayloop.js buildUnit.
//
// NOTE: combat still derives its own stats in gameplayloop/combatengine; those
// remain separate copies. This module governs the SHEET display only.
//
// DEPENDENCIES: Data/classes.json (resource lists), Data/skills.json (xp curve)
// =============================================================================

import type {
  ClassesData, SkillsData, ClassDef, SkillDef,
  StatBlock, StatKey, Gear, Item, CompanionInstance, SkillEntry,
} from "./types/data.js";
import type { CharacterSheet } from "./types/viewmodel.js";

const _classData = require("../Data/classes.json") as ClassesData;
const _skillsData = require("../Data/skills.json") as SkillsData;

const CLASS_DEFS: Record<string, ClassDef> = _classData.classes || {};
const SKILL_DEFS: Record<string, SkillDef> = _skillsData.skills || {};
const SKILL_MAX_LEVEL: number = _skillsData.maxLevel || 99;

// XP to go from skill level L to L+1 — matches Engine/skills.ts SKILL_XP_TABLE.
const SKILL_XP_TABLE: number[] = Array.from({ length: SKILL_MAX_LEVEL }, (_, i) => 50 * (i + 1) * (i + 2));
export const skillXpToNext = (level: number): number =>
  (level >= SKILL_MAX_LEVEL ? Infinity : SKILL_XP_TABLE[level - 1]);

// Accept the legacy plain-number skill form as well as { level, xp }.
export const normSkill = (v: SkillEntry | number | null | undefined): SkillEntry =>
  (typeof v === "number") ? { level: v, xp: 0 } : { level: (v?.level ?? 1), xp: (v?.xp ?? 0) };

const STATS: StatKey[] = ["str", "dex", "con", "int", "spi", "wis", "spd", "cha"];
const SCHOOLS = ["pyro", "cryo", "nature", "chaos", "order", "bio", "energy", "psychic"] as const;

// Sum statBonuses from every equipped item. gear: { slot: itemId }, catalog: { itemId: def }.
export function gearBonuses(gear: Gear | undefined, catalog: Record<string, Item>): Record<string, number> {
  const b: Record<string, number> = {};
  for (const itemId of Object.values(gear || {})) {
    if (!itemId || typeof itemId !== "string") continue;
    const sb = catalog?.[itemId]?.statBonuses as Record<string, number> | undefined;
    if (!sb) continue;
    for (const [k, v] of Object.entries(sb)) b[k] = (b[k] || 0) + v;
  }
  return b;
}

export interface DeriveInput {
  raw?: Partial<StatBlock>;
  level?: number;
  classId?: string;
  gear?: Gear;
}

export interface DerivedStats {
  maxHp: number;
  maxMana: number;
  attackPower: number;
  rangedAttackPower: number;
  spellPower: number;
  armor: number;
  critChanceMelee: number;
  critChanceSpell: number;
  dodge: number;
  manaRegen: number;
  resistances: Record<string, number>;
  critMultiplier: number;
}

export interface DeriveCoreResult {
  totals: Record<string, number>;
  gearBonuses: Record<string, number>;
  derived: DerivedStats;
}

// ── Shared derivation core ───────────────────────────────────────────────────
// THE single source of truth for stat derivation, used by BOTH combat
// (gameplayloop.js buildUnit) and the character-sheet display. Returns stats in
// canonical COMBAT form: crit/dodge as fractions (0–1), mana as `maxMana`,
// resistances as an object. The display wrapper (characterSheet) converts these
// to percentages/labels. Keep all formulas here — never duplicate them.
//
// Inputs: { raw, level, classId, gear }, plus an item catalog { itemId: def }
// to resolve equipped-gear statBonuses.
export function deriveCore(
  { raw = {}, level = 1, gear = {} }: DeriveInput = {},
  catalog: Record<string, Item> = {},
): DeriveCoreResult {
  const gb = gearBonuses(gear, catalog);

  const totals: Record<string, number> = {};
  for (const k of STATS) totals[k] = (raw[k] ?? 0) + (gb[k] ?? 0);

  const resBase = totals.wis * 0.5;
  const resistances: Record<string, number> = {};
  for (const s of SCHOOLS) resistances[s] = resBase + (gb[`${s}Resistance`] ?? 0);

  const derived: DerivedStats = {
    maxHp:              totals.con * 10 + level * 20 + (gb.maxHpBonus ?? 0),
    maxMana:            totals.int * 15,
    attackPower:        totals.str * 2 + totals.dex + (gb.attackPower ?? 0),
    rangedAttackPower:  Math.max(0, 2 * level + 2 * totals.dex - 10) + (gb.rangedAttackPower ?? 0),
    spellPower:         gb.spellPower ?? 0,
    armor:              totals.dex * 2 + (gb.armor ?? 0),
    critChanceMelee:    totals.dex / 20 / 100 + (gb.critChanceMelee ?? 0),
    critChanceSpell:    totals.int / 60 / 100 + (gb.critChanceSpell ?? 0),
    dodge:              totals.spd / 20 / 100 + (gb.dodgeChance ?? 0),
    manaRegen:          Math.floor(totals.spi / 5),
    resistances,
    critMultiplier:     2.0,
  };

  return { totals, gearBonuses: gb, derived };
}

// Build the display view-model for one character instance. Formats the shared
// core into the percentages/labels the UI renders (crit ×100, maxMp, mitigation).
export function characterSheet(inst: CompanionInstance | undefined, catalog: Record<string, Item> = {}): CharacterSheet {
  const classId = inst?.classId ?? "";
  const { totals, gearBonuses: gb, derived: c } = deriveCore(
    { raw: inst?.stats?.raw, level: inst?.level, classId, gear: inst?.gear },
    catalog,
  );

  const armor = Math.round(c.armor);
  const derived = {
    maxHp:       c.maxHp,
    maxMp:       c.maxMana,
    attackPower: Math.round(c.attackPower),
    rangedAP:    Math.round(c.rangedAttackPower),
    spellPower:  Math.round(c.spellPower),
    armor,
    mitPct:      armor / (armor + 1500) * 100,
    meleeCrit:   c.critChanceMelee * 100,
    spellCrit:   c.critChanceSpell * 100,
    dodge:       c.dodge * 100,
    manaRegen:   c.manaRegen,
    resistances: c.resistances,
  };

  const skills: Record<string, {
    level: number; xp: number; xpToNext: number | null; atMax: boolean; name: string | null;
  }> = {};
  for (const [id, v] of Object.entries(inst?.skills ?? {})) {
    const s     = normSkill(v);
    const atMax = s.level >= SKILL_MAX_LEVEL;
    skills[id] = {
      level:    s.level,
      xp:       s.xp,
      xpToNext: atMax ? null : skillXpToNext(s.level),
      atMax,
      name:     SKILL_DEFS[id]?.name ?? null,
    };
  }

  return {
    totals,
    gearBonuses: gb,
    derived,
    skills,
    resources:     CLASS_DEFS[classId]?.resources ?? [],
    skillMaxLevel: SKILL_MAX_LEVEL,
  };
}
