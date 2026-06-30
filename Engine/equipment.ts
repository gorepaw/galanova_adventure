// =============================================================================
// CLASS / EQUIPMENT RULES — Galanova
//
// Armor tiers: clothing < light < medium < heavy. Each class has one designated
// tier and may equip that tier and anything lower (no level-gated unlocks).
//
// Weapon / offhand gating moves to the skills system (deferred); permissive here
// for now so equipping is never blocked while skills are unbuilt.
//
// DEPENDENCIES: Data/classes.json
// =============================================================================

import type { ClassesData, ClassDef } from "./types/data.js";

const _classData = require("../Data/classes.json") as ClassesData;

export const CLASSES: Record<string, ClassDef> = _classData.classes;
export const ARMOR_TIERS = ["clothing", "light", "medium", "heavy"];
export const ARMOR_RANK: Record<string, number> = { clothing: 0, light: 1, medium: 2, heavy: 3 };

// Transition: legacy WoW armorType values still live on un-migrated item data;
// map them onto the new tiers so existing gear continues to validate.
export const LEGACY_ARMOR_MAP: Record<string, string> = { cloth: "clothing", leather: "light", mail: "medium", plate: "heavy" };

interface ClassRestrictedItem { allowedClasses?: string[]; }

export const ClassDB = (() => {

  const get = (classId: string): ClassDef | null => CLASSES[classId] || null;

  const normalizeTier = (t: string): string => LEGACY_ARMOR_MAP[t] || t;

  // A class can equip its designated tier and anything lower.
  const canWearArmor = (classId: string, armorType: string /*, level */): boolean => {
    const cls = CLASSES[classId];
    if (!cls) return false;
    const itemTier  = normalizeTier(armorType);
    const classTier = cls.armorTier;
    if (!(itemTier in ARMOR_RANK) || !(classTier in ARMOR_RANK)) return false;
    return ARMOR_RANK[itemTier] <= ARMOR_RANK[classTier];
  };

  // Deferred to the skills system — permissive for now.
  const canWieldWeapon = (_classId: string, _weaponType: string): boolean => true;
  const canUseOffhand  = (_classId: string, _offhandType: string): boolean => true;

  // Absent or empty allowedClasses = no restriction.
  const itemAllowedForClass = (item: ClassRestrictedItem, classId: string): boolean => {
    if (!item.allowedClasses || item.allowedClasses.length === 0) return true;
    return item.allowedClasses.includes(classId);
  };

  return { get, canWearArmor, canWieldWeapon, canUseOffhand, itemAllowedForClass, normalizeTier };
})();


// =============================================================================
// SELF-TEST
// =============================================================================

interface TestResult { ok: boolean; label: string; }
type TestRun = { passed: number; failed: number; total: number; results: TestResult[] };

export const runClassTests = (): TestRun => {
  const results: TestResult[] = []; let p = 0, f = 0;
  const assert = (label: string, cond: unknown) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  for (const id of ["armsman", "illusionist", "elementalist", "assassin", "survivalist"])
    assert(`Class exists: ${id}`, !!CLASSES[id]);

  // tier ladder — heavy (Armsman) can wear everything down the ladder
  assert("Armsman (heavy) can wear heavy",     ClassDB.canWearArmor("armsman", "heavy"));
  assert("Armsman (heavy) can wear medium",    ClassDB.canWearArmor("armsman", "medium"));
  assert("Armsman (heavy) can wear clothing",  ClassDB.canWearArmor("armsman", "clothing"));

  // clothing classes cannot wear heavier
  assert("Illusionist (clothing) can wear clothing",  ClassDB.canWearArmor("illusionist", "clothing"));
  assert("Illusionist (clothing) cannot wear light",  !ClassDB.canWearArmor("illusionist", "light"));
  assert("Elementalist (clothing) cannot wear heavy", !ClassDB.canWearArmor("elementalist", "heavy"));

  // light / medium
  assert("Assassin (light) can wear clothing",    ClassDB.canWearArmor("assassin", "clothing"));
  assert("Assassin (light) cannot wear medium",   !ClassDB.canWearArmor("assassin", "medium"));
  assert("Survivalist (medium) can wear light",   ClassDB.canWearArmor("survivalist", "light"));
  assert("Survivalist (medium) cannot wear heavy", !ClassDB.canWearArmor("survivalist", "heavy"));

  // legacy armorType mapping
  assert("Legacy 'cloth' maps to clothing",  ClassDB.canWearArmor("illusionist", "cloth"));
  assert("Legacy 'plate' blocked for light", !ClassDB.canWearArmor("assassin", "plate"));
  assert("Legacy 'mail' ok for heavy",       ClassDB.canWearArmor("armsman", "mail"));

  // class item restriction
  assert("Tier item: armsman allowed", ClassDB.itemAllowedForClass({ allowedClasses: ["armsman"] }, "armsman"));
  assert("Tier item: assassin blocked", !ClassDB.itemAllowedForClass({ allowedClasses: ["armsman"] }, "assassin"));
  assert("Open item: all allowed", ClassDB.itemAllowedForClass({}, "assassin"));

  return { passed: p, failed: f, total: p + f, results };
};

export const reportClassTests = (r: TestRun): string => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `CLASS / ARMOR TESTS: ${r.passed}/${r.total} passed`,
    "=".repeat(60),
    ...r.results.map(x => `  ${x.ok ? "✓" : "✗"} ${x.label}`),
    r.failed > 0 ? `\n  ${r.failed} FAILED` : `\n  All tests passed.`,
    "=".repeat(60),
  ];
  return lines.join("\n");
};
