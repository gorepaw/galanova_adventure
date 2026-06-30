// =============================================================================
// COMPANION TEMPLATES
// joinLevel = min party level to encounter them.
// baseStats are derived via getStatsAtLevel(raceId, classId, joinLevel)
// from leveltables.ts — do not hand-edit these numbers.
//
// DEPENDENCIES (must be loaded before this file):
//   leveltables.ts  — getStatsAtLevel, CLASS_BASE_HP, CLASS_BASE_MP
// DATA:
//   Data/companions.json
//   Data/classes.json
// =============================================================================

import type { Companion, ClassDef } from "./types/data.js";
import { getStatsAtLevel, CLASS_BASE_HP, CLASS_BASE_MP } from "./leveltables.js";

const _companionData = require("../Data/companions.json") as { companions: Record<string, Companion> };
const _classData = require("../Data/classes.json") as { classes: Record<string, ClassDef> };

type HydratedCompanion = Companion & { baseStats: Record<string, number> };

// Hydrate baseStats for each companion template at load time
export const COMPANIONS: Record<string, HydratedCompanion> = Object.fromEntries(
  Object.entries(_companionData.companions).map(([key, tmpl]) => [
    key,
    { ...tmpl, baseStats: getStatsAtLevel(tmpl.raceId, tmpl.classId, tmpl.joinLevel ?? 1) },
  ])
);

interface ClassAbilityRef { id: string; level: number; }

// Index of class ability lists: classId → [{ id, level }, ...]
export const CLASS_ABILITIES: Record<string, ClassAbilityRef[]> = Object.fromEntries(
  Object.entries(_classData.classes).map(([id, c]) => [id, (c.abilities as ClassAbilityRef[]) || []])
);

// Returns the ability IDs a class has learned by the given level.
export const getAbilitiesForClass = (classId: string, upToLevel: number): string[] =>
  (CLASS_ABILITIES[classId] || [])
    .filter(a => a.level <= upToLevel)
    .map(a => a.id);

// Sensible starting loadout per class. Slots not listed default to null.
// Cleared during the Galanova conversion — starter loadouts are TBD per class.
const STARTER_GEAR: Record<string, Record<string, string | null>> = {};


// =============================================================================
// COMPANION INSTANCE FACTORY
// =============================================================================

export const buildCompanionInstance = (template: HydratedCompanion, instanceId: string) => {
  const raw   = template.baseStats as Record<string, number>;
  const maxHp = raw.con * 10 + (template.joinLevel || 1) * 20 + (CLASS_BASE_HP[template.classId] || 0);
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
    learnedAbilities: getAbilitiesForClass(template.classId, template.joinLevel ?? 1),
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

export const seedCompanions = (DataStore: { write: (path: string, data: any) => void }): void => {
  for (const [key, companion] of Object.entries(COMPANIONS)) {
    DataStore.write(`templates/companions/${key}`, companion);
  }
};


// =============================================================================
// ENCOUNTER FILTER
// =============================================================================

export const canEncounterCompanion = (
  companionTemplate: { joinLevel?: number },
  partyInstances: { level?: number }[],
): boolean => {
  return partyInstances.some(inst => (inst.level || 1) >= (companionTemplate.joinLevel ?? 1));
};
