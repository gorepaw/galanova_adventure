// =============================================================================
// COMPANION TEMPLATES
// joinLevel = min party level to encounter them.
// baseStats are derived via getStatsAtLevel(raceId, classId, joinLevel)
// from stat_tables.js — do not hand-edit these numbers.
//
// DEPENDENCIES (must be loaded before this file):
//   stat_tables.js  — getStatsAtLevel, CLASS_BASE_HP, CLASS_BASE_MP
// DATA:
//   Data/companions.json
//   Data/classes.json
// =============================================================================

"use strict";

const _companionData = require('../Data/companions.json');
const _classData     = require('../Data/classes.json');

// Hydrate baseStats for each companion template at load time
const COMPANIONS = Object.fromEntries(
  Object.entries(_companionData.companions).map(([key, tmpl]) => [
    key,
    { ...tmpl, baseStats: getStatsAtLevel(tmpl.raceId, tmpl.classId, tmpl.joinLevel) },
  ])
);

// Index of class ability lists: classId → [{ id, level }, ...]
const CLASS_ABILITIES = Object.fromEntries(
  Object.entries(_classData.classes).map(([id, c]) => [id, c.abilities || []])
);

// Returns the ability IDs a class has learned by the given level.
const getAbilitiesForClass = (classId, upToLevel) =>
  (CLASS_ABILITIES[classId] || [])
    .filter(a => a.level <= upToLevel)
    .map(a => a.id);

// Sensible starting loadout per class. Slots not listed default to null.
// Cleared during the Galanova conversion — starter loadouts are TBD per class.
const STARTER_GEAR = {};


// =============================================================================
// COMPANION INSTANCE FACTORY
// =============================================================================

const buildCompanionInstance = (template, instanceId) => {
  const raw   = template.baseStats;
  const maxHp = raw.con * 10 + (CLASS_BASE_HP[template.classId] || 0);
  const maxMp = raw.int * 15 + (CLASS_BASE_MP[template.classId] || 0);

  return {
    instanceId,
    templateId:       template.id,
    _version:         1,
    name:             template.name,
    raceId:           template.raceId,
    classId:          template.classId,
    profession:       template.profession || null,
    level:            template.joinLevel,
    xp:               0,
    currentHp:        maxHp,
    currentMp:        maxMp,
    maxHp,
    maxMp,
    deathState:       "alive",
    permadead:        false,
    downedAt:         null,
    rezCost:          0,
    learnedAbilities: getAbilitiesForClass(template.classId, template.joinLevel),
    acquiredQuirks:   [],
    activeBuffs:      [],
    relationship:     0,
    skills:           { ...(template.startingSkills || {}) },
    gear: {
      head: null, neck: null, shoulders: null, back: null,
      chest: null, waist: null, tabard: null, wrist: null,
      hands: null, feet: null, legs: null, ring: null,
      trinket: null, mainhand: null, offhand: null,
      ranged: null, ammo: null, relic: null,
      ...(STARTER_GEAR[template.classId] || {}),
    },
    stats: { raw },
  };
};


// =============================================================================
// LOADER SEED FUNCTION
// =============================================================================

const seedCompanions = (DataStore) => {
  for (const [key, companion] of Object.entries(COMPANIONS)) {
    DataStore.write(`templates/companions/${key}`, companion);
  }
};


// =============================================================================
// ENCOUNTER FILTER
// =============================================================================

const canEncounterCompanion = (companionTemplate, partyInstances) => {
  return partyInstances.some(inst => (inst.level || 1) >= companionTemplate.joinLevel);
};


if (typeof module !== "undefined") {
  module.exports = {
    COMPANIONS,
    CLASS_ABILITIES,
    getAbilitiesForClass,
    buildCompanionInstance,
    seedCompanions,
    canEncounterCompanion,
  };
}
