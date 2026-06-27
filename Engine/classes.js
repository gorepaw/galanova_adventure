// =============================================================================
// CLASS DATABASE — Kalimdor RPG
//
// Authoritative class definitions for equipment validation, party composition,
// AI profiling, and display.
//
// ARMOR RULES:
//   Each class has two armor lists:
//     armorAllowed      — available from level 1
//     armorAllowedAt40  — unlocks at level 40 (enforced at equip time)
//   All classes can wear lighter armor than their cap (e.g. a warrior can
//   wear cloth). Equip validation checks both lists against companion level.
//
// WEAPON RULES:
//   All weapon skills are unlocked by default — no skill gating.
//   weaponTypes lists every weapon type the class can equip.
//   shieldAllowed / offhandTypes define what can go in the offhand slot.
//
// GEAR CLASS RESTRICTIONS:
//   Items can declare allowedClasses: ["warrior","paladin"] to restrict
//   equipping to specific classes (used for tier sets, class weapons, etc.)
//   Absent or empty allowedClasses means no restriction.
//
// DEPENDENCIES: Data/classes.json
// =============================================================================

"use strict";

const _classData = require('../Data/classes.json');

// Armor type constants for reference
const ARMOR_TYPES = ["cloth","leather","mail","plate"];

// Offhand slot options — kept as constants so callers and tests can reference by name
const OFFHAND_TYPES = {
  SHIELD:          "shield",
  WEAPON:          "weapon",
  HELD_IN_OFFHAND: "held",
};

const CLASSES = _classData.classes;


// =============================================================================
// EQUIP VALIDATION HELPERS
// Used by the equipment system to gate item equipping.
// =============================================================================

const ClassDB = (() => {

  const get = (classId) => CLASSES[classId] || null;

  // Returns true if the class can equip the given armor type at the given level.
  const canWearArmor = (classId, armorType, level = 1) => {
    const cls = CLASSES[classId];
    if (!cls) return false;
    if (cls.armorAllowed.includes(armorType)) return true;
    if (cls.armorAllowedAt40.includes(armorType) && level >= 40) return true;
    return false;
  };

  // Returns true if the class can equip the given weapon type.
  const canWieldWeapon = (classId, weaponType) => {
    const cls = CLASSES[classId];
    if (!cls) return false;
    if (weaponType === "shield") return cls.shieldAllowed;
    return cls.weaponTypes.includes(weaponType);
  };

  // Returns true if the class can use the given offhand type.
  const canUseOffhand = (classId, offhandType) => {
    const cls = CLASSES[classId];
    if (!cls) return false;
    return cls.offhandTypes.includes(offhandType);
  };

  // Returns true if the item's allowedClasses restriction permits this class.
  // Absent or empty allowedClasses = no restriction.
  const itemAllowedForClass = (item, classId) => {
    if (!item.allowedClasses || item.allowedClasses.length === 0) return true;
    return item.allowedClasses.includes(classId);
  };

  // Returns all classes that can fill a given role.
  const getByRole = (role) =>
    Object.values(CLASSES).filter(cls => cls.roles.includes(role));

  return { get, canWearArmor, canWieldWeapon, canUseOffhand, itemAllowedForClass, getByRole };
})();


// =============================================================================
// SELF-TEST
// =============================================================================

const runClassTests = () => {
  const results = []; let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  // all 9 classes present
  for (const id of ["warrior","paladin","hunter","rogue","priest","shaman","mage","warlock","druid"])
    assert(`Class exists: ${id}`, !!CLASSES[id]);

  // armor rules — base access
  assert("Warrior can wear leather at 1",      ClassDB.canWearArmor("warrior", "leather", 1));
  assert("Warrior can wear mail at 1",         ClassDB.canWearArmor("warrior", "mail",    1));
  assert("Warrior cannot wear plate at 1",    !ClassDB.canWearArmor("warrior", "plate",   1));
  assert("Warrior can wear plate at 40",       ClassDB.canWearArmor("warrior", "plate",  40));
  assert("Paladin cannot wear plate at 39",   !ClassDB.canWearArmor("paladin", "plate",  39));
  assert("Paladin can wear plate at 40",       ClassDB.canWearArmor("paladin", "plate",  40));
  assert("Hunter cannot wear mail at 1",      !ClassDB.canWearArmor("hunter",  "mail",    1));
  assert("Hunter can wear mail at 40",         ClassDB.canWearArmor("hunter",  "mail",   40));
  assert("Shaman cannot wear mail at 1",      !ClassDB.canWearArmor("shaman",  "mail",    1));
  assert("Shaman can wear mail at 40",         ClassDB.canWearArmor("shaman",  "mail",   40));
  assert("Mage can wear cloth",                ClassDB.canWearArmor("mage",    "cloth",   1));
  assert("Mage cannot wear leather",          !ClassDB.canWearArmor("mage",    "leather", 1));
  assert("Priest cannot wear leather",        !ClassDB.canWearArmor("priest",  "leather", 1));
  assert("Druid can wear leather",             ClassDB.canWearArmor("druid",   "leather", 1));
  assert("Druid cannot wear mail",            !ClassDB.canWearArmor("druid",   "mail",    1));
  assert("Rogue cannot wear mail",            !ClassDB.canWearArmor("rogue",   "mail",   40));

  // lighter armor always allowed
  assert("Warrior can wear cloth at 1",        ClassDB.canWearArmor("warrior", "cloth",   1));
  assert("Hunter can wear cloth at 1",         ClassDB.canWearArmor("hunter",  "cloth",   1));
  assert("Shaman can wear cloth at 1",         ClassDB.canWearArmor("shaman",  "cloth",   1));

  // weapon rules
  assert("Warrior can wield sword_2h",         ClassDB.canWieldWeapon("warrior", "sword_2h"));
  assert("Warrior can wield bow",              ClassDB.canWieldWeapon("warrior", "bow"));
  assert("Warrior cannot wield wand",         !ClassDB.canWieldWeapon("warrior", "wand"));
  assert("Paladin cannot wield dagger",       !ClassDB.canWieldWeapon("paladin", "dagger"));
  assert("Rogue can wield dagger",             ClassDB.canWieldWeapon("rogue",   "dagger"));
  assert("Rogue cannot wield sword_2h",       !ClassDB.canWieldWeapon("rogue",   "sword_2h"));
  assert("Priest can wield staff",             ClassDB.canWieldWeapon("priest",  "staff"));
  assert("Priest can wield wand",              ClassDB.canWieldWeapon("priest",  "wand"));
  assert("Priest cannot wield sword_1h",      !ClassDB.canWieldWeapon("priest",  "sword_1h"));
  assert("Mage can wield dagger",              ClassDB.canWieldWeapon("mage",    "dagger"));
  assert("Mage cannot wield axe_1h",          !ClassDB.canWieldWeapon("mage",    "axe_1h"));
  assert("Druid can wield staff",              ClassDB.canWieldWeapon("druid",   "staff"));
  assert("Druid cannot wield sword_1h",       !ClassDB.canWieldWeapon("druid",   "sword_1h"));
  assert("Hunter cannot wield shield",        !ClassDB.canWieldWeapon("hunter",  "shield"));
  assert("Warrior can wield shield",           ClassDB.canWieldWeapon("warrior", "shield"));
  assert("Shaman can wield shield",            ClassDB.canWieldWeapon("shaman",  "shield"));

  // offhand rules
  assert("Rogue can use weapon offhand",       ClassDB.canUseOffhand("rogue",   OFFHAND_TYPES.WEAPON));
  assert("Warrior can use shield offhand",     ClassDB.canUseOffhand("warrior", OFFHAND_TYPES.SHIELD));
  assert("Warrior cannot dual wield",         !ClassDB.canUseOffhand("warrior", OFFHAND_TYPES.WEAPON));
  assert("Mage can use held offhand",          ClassDB.canUseOffhand("mage",    OFFHAND_TYPES.HELD_IN_OFFHAND));
  assert("Mage cannot use shield",            !ClassDB.canUseOffhand("mage",    OFFHAND_TYPES.SHIELD));
  assert("Hunter has no offhand",             !ClassDB.canUseOffhand("hunter",  OFFHAND_TYPES.WEAPON));

  // class item restriction
  const tierItem    = { allowedClasses: ["warrior","paladin"] };
  const openItem    = { allowedClasses: [] };
  const absentItem  = {};
  assert("Tier item: warrior allowed",         ClassDB.itemAllowedForClass(tierItem,   "warrior"));
  assert("Tier item: rogue blocked",          !ClassDB.itemAllowedForClass(tierItem,   "rogue"));
  assert("Open item: all allowed",             ClassDB.itemAllowedForClass(openItem,   "rogue"));
  assert("Absent allowedClasses: all allowed", ClassDB.itemAllowedForClass(absentItem, "mage"));

  // roles
  assert("Tanks include warrior",              ClassDB.getByRole("tank").some(c => c.id === "warrior"));
  assert("Healers include priest",             ClassDB.getByRole("healer").some(c => c.id === "priest"));
  assert("Healers include druid",              ClassDB.getByRole("healer").some(c => c.id === "druid"));
  assert("DPS includes rogue",                 ClassDB.getByRole("dps").some(c => c.id === "rogue"));

  // sync check — baseHp/baseMana match stat_tables CLASS_BASE_HP/MP
  // (values hardcoded here for self-contained test)
  const expectedHp  = { warrior:60, paladin:45, hunter:45, rogue:40, priest:30, shaman:40, mage:25, warlock:28, druid:35 };
  const expectedMp  = { warrior:0,  paladin:60, hunter:40, rogue:0,  priest:80, shaman:60, mage:100,warlock:90, druid:70 };
  for (const [id, hp] of Object.entries(expectedHp))
    assert(`baseHp sync: ${id}`, CLASSES[id].baseHp === hp);
  for (const [id, mp] of Object.entries(expectedMp))
    assert(`baseMana sync: ${id}`, CLASSES[id].baseMana === mp);

  return { passed: p, failed: f, total: p + f, results };
};

const reportClassTests = (r) => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `CLASS TESTS: ${r.passed}/${r.total} passed`,
    "=".repeat(60),
    ...r.results.map(x => `  ${x.ok ? "✓" : "✗"} ${x.label}`),
    r.failed > 0 ? `\n  ${r.failed} FAILED` : `\n  All tests passed.`,
    "=".repeat(60),
  ];
  return lines.join("\n");
};


// =============================================================================
// EXPORTS
// =============================================================================

if (typeof module !== "undefined") {
  module.exports = {
    CLASSES, ARMOR_TYPES, OFFHAND_TYPES,
    ClassDB,
    runClassTests, reportClassTests,
  };
}