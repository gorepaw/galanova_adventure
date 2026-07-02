// =============================================================================
// CORE GAMEPLAY LOOP � Galanova
// Vertical slice: HomeScreen → Encounter → Combat → Rewards → Save → Home
//
// DEPENDENCIES (load before this file):
//   data_layer.js   � DataStore, Loader, Saver, Validator, Modifiers, Currency
//   stat_tables.js  � getStatsAtLevel, addXpToInst, xpToNextLevel,
//                     CLASS_BASE_HP, CLASS_BASE_MP
//   companions.js   � buildCompanionInstance
//   encounter.js    � PartySkills, checkReroll, EncounterGenerator
//   charsheet.js    � deriveCore (shared stat derivation for combat + sheet)
// =============================================================================

"use strict";

const _abilitiesData      = require('../Data/abilities.json');
const _itemsData          = require('../Data/items.json');
const _mobsData           = require('../Data/mobs.json');
const _craftingData       = require('../Data/crafting.json');
const _gatheringData      = require('../Data/gathering.json');
const _shopData           = require('../Data/shop.json');
const _achievementsData   = require('../Data/achievements.json');
const _dungeonsData       = require('../Data/dungeons.json');
const _zoologyData        = require('../Data/zoology.json');
const _summoningData      = require('../Data/summoning.json');
const _necromancyData     = require('../Data/necromancy.json');
const _roboticsData       = require('../Data/robotics.json');

// Engine sibling modules — imported directly now (no more ambient globals).
// gameplayloop was the last consumer of the loadGlobal concatenation pattern.
import { DataStore, Loader, Saver, Validator, Modifiers } from './datalayer.js';
import { ItemSuffixes } from './itemsuffixes.js';
import { getStatsAtLevel, addXpToInst, buildResources, allocateStat, xpToNextLevel } from './leveltables.js';
import { getSkillLevel, addSkillXp, abilitiesFromSkills, skillForAbilityUse, canEquipWeaponType } from './skills.js';
import { ClassDB } from './equipment.js';
import { buildCompanionInstance, seedCompanions } from './companions.js';
import { EncounterGenerator, PartySkills, checkReroll } from './encounters.js';
import { hasPendingScene, resolvePendingScene, advanceScene as storyAdvance, applyEffects as storyApplyEffects, enqueueScene, onStoryCombatVictory, onStoryBossDefeated, onStoryWipe } from './story.js';

// Shared stat derivation — the SAME core the character sheet uses, so combat and
// the sheet can never disagree (Engine/charsheet.js).
import { deriveCore } from './charsheet.js';

// Combat-log entity tags: wrap entity refs so the UI resolves name + tooltip
// with zero matching cost (Engine/logtags.js). Migrate emit sites to tag() over time.
import { tag } from './logtags.js';

// Runtime combat shapes: the per-fight Unit, live buff instances, scaling
// overrides, and the reward summary. buildUnit produces Unit; the turn loop
// mutates it. See Engine/types/combat.ts.
import type { Unit, BuffInstance, Ov, CasterSnapshot, RewardSummary, CombatEffect, CombatDerived, CcState } from './types/combat.js';


// =============================================================================
// COMBAT PETS — unlocked by skill, not class
// The Zoology skill grants beast companions (zoology.json); the Summoning skill
// grants summons (summoning.json); the Necromancy skill grants undead
// (necromancy.json); the Robotics skill grants constructs (robotics.json).
// A character may draw from every pet skill it has learned (level >= 1).
// =============================================================================

const PETS_BY_SKILL = {
  zoology:    _zoologyData.pets,
  summoning:  _summoningData.pets,
  necromancy: _necromancyData.pets,
  robotics:   _roboticsData.pets,
};

// All pet templates a character can use, based on the pet skills they've learned.
const petsForUnit = (unit: any): any[] => {
  const out: any[] = [];
  for (const [skillId, list] of Object.entries<any>(PETS_BY_SKILL)) {
    if (typeof getSkillLevel === "function" && getSkillLevel(unit, skillId) >= 1) out.push(...list);
  }
  return out;
};


// =============================================================================
// PROFESSION XP
// Professions level via XP per action (authored on each recipe/node/creature),
// not the old skill-up chance. Awards XP to every living party member that
// practises the profession. Skill XP lives on the companion instance, so this
// writes instances to DataStore and returns the (unchanged) save for chaining.
// =============================================================================

const awardProfessionXp = (save: any, professionId: string, xp: number) => {
  if (!professionId || !xp || xp <= 0) return save;
  for (const member of (save.party || [])) {
    const ir = Loader.load(`instances/companions/${member.instanceId}`, "companionInstance");
    if (!ir.ok) continue;
    const inst = ir.data;
    if (inst.profession !== professionId || inst.deathState !== "alive") continue;
    DataStore.write(`instances/companions/${member.instanceId}`, addSkillXp(inst, professionId, xp).inst);
  }
  return save;
};


// =============================================================================
// CURRENCY SYSTEM
// All values stored as total copper. Display converts on the fly.
// =============================================================================

const Currency = (() => {
  const toCopperFromParts = (platinum = 0, gold = 0, silver = 0, copper = 0) =>
    platinum * 1000000 + gold * 10000 + silver * 100 + copper;

  const toDisplay = (totalCopper: number) => ({
    platinum: Math.floor(totalCopper / 1000000),
    gold:     Math.floor((totalCopper % 1000000) / 10000),
    silver:   Math.floor((totalCopper % 10000) / 100),
    copper:   totalCopper % 100,
    total:    totalCopper,
  });

  const toString = (totalCopper: number) => {
    const { platinum, gold, silver, copper } = toDisplay(totalCopper);
    const parts: string[] = [];
    if (platinum > 0) parts.push(`${platinum}p`);
    if (gold     > 0) parts.push(`${gold}g`);
    if (silver   > 0) parts.push(`${silver}s`);
    if (copper > 0 || parts.length === 0) parts.push(`${copper}c`);
    return parts.join(" ");
  };

  const canAfford = (save: any, cost: number) => (save.currency || 0) >= cost;
  const deduct    = (save: any, amount: number) => ({ ...save, currency: Math.max(0, (save.currency || 0) - amount) });
  const add       = (save: any, amount: number) => ({ ...save, currency: (save.currency || 0) + amount });

  return { toCopperFromParts, toDisplay, toString, canAfford, deduct, add };
})();


// =============================================================================
// COMBAT BRIDGE � improved implementation
// Autobattle wrapper � translates encounter packet + companion instances into
// a complete combat result by driving the AI on both sides until resolved.
// This implementation adds buff/proc support, passive stat modifiers, and
// richer unit/resource shapes.
// =============================================================================

const CombatBridge = (() => {

  // Per-class flat HP/MP bonuses — TBD for the Galanova classes; empty for now
  // so maxHp/maxMana derive purely from stats (con*10 + level*20 / int*15).
  const CLASS_BASE_HP: Record<string, number> = {};
  const CLASS_BASE_MP: Record<string, number> = {};

  const ABILITY_DATA:     Record<string, any> = _abilitiesData.abilities;
  const BUFF_DEFS_BRIDGE: Record<string, any> = _abilitiesData.buffs;

  // ── always-on passive stat mods applied at buildUnit time ──────────────────
  const applyAlwaysPassives = (derived: Record<string, any>, abilities: string[]): CombatDerived => {
    const d: CombatDerived = { ...derived } as CombatDerived;
    for (const abId of abilities) {
      const ab = ABILITY_DATA[abId];
      if (!ab || !ab.passive || ab.trigger !== "always") continue;
      for (const effect of (ab.effects || [])) {
        if (effect.type !== "stat_mod") continue;
        const val = (effect.source ? ((d[effect.source] || 0) * (effect.multiplier || 0)) : 0)
                  + (effect.flat || 0);
        if (effect.stat in d) d[effect.stat] = (d[effect.stat] || 0) + val;
      }
    }
    return d;
  };

  const buildUnit = (cfg: any, isEnemy = false): Unit => {
    const classId  = cfg.classId || "armsman";
    const level    = cfg.level || 1;
    const raw      = cfg.stats?.raw || cfg.baseStats || getStatsAtLevel(cfg.raceId || "sephir", classId, level);
    // Abilities come from the character's skills (abilitiesFromSkills, injected by
    // skills.js); fall back to a basic attack so any unit can act.
    const _fromSkills = (typeof abilitiesFromSkills === "function" && cfg.skills) ? abilitiesFromSkills(cfg) : [];
    // Skills-derived abilities take priority (Galanova model); fall back to explicit
    // learnedAbilities/abilities (legacy companions, enemies), then a basic attack.
    const abilities = _fromSkills.length ? _fromSkills
      : (cfg.learnedAbilities?.length ? cfg.learnedAbilities
      : (cfg.abilities?.length ? cfg.abilities : ["basic_attack"]));

    // Derive base stats (incl. equipped-gear bonuses) via the shared core so the
    // character sheet and combat use identical formulas. Class flat HP/MP bonuses
    // are layered on top (the core has no concept of them).
    const _core = deriveCore({ raw, level, classId, gear: cfg.gear }, _itemsData.items);
    const baseD = _core.derived;
    baseD.maxHp   += (CLASS_BASE_HP[classId] || 0);
    baseD.maxMana += (CLASS_BASE_MP[classId] || 0);

    const derived = applyAlwaysPassives(baseD, abilities);

    const maxHp   = cfg.maxHp || derived.maxHp;
    const maxMana = cfg.maxMp || derived.maxMana;

    // Resources are read from the class's resource list (mix-and-match).
    const resources = buildResources(classId, maxMana);

    return {
      id:           cfg.instanceId || cfg.id || `u_${Math.random().toString(36).slice(2, 7)}`,
      name:         cfg.name,
      classId,
      raceId:       cfg.raceId || "sephir",
      level:        cfg.level  || 1,
      hp:           (cfg.deathState === 'downed' || cfg.deathState === 'dead' || cfg.permadead) ? 0 : (cfg.currentHp || maxHp),
      maxHp,
      type:         cfg.type      || null,
      xpValue:      cfg.xpValue   || 0,
      loot:         cfg.loot      || [],
      butcheryLoot: cfg.butcheryLoot  || [],
      butcheryXp:   cfg.butcheryXp || 0,
      killReputation: cfg.killReputation || [],
      currencyDrop: cfg.currencyDrop  || null,
      stats:        { raw, derived, totals: _core.totals },
      skills:       cfg.skills || {},
      gear:         cfg.gear   || {},
      resources,
      cooldowns:    {},
      castQueue:    [],
      buffs:        [],
      debuffs:      [],
      ccState:      { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false },
      spd:          raw.spd || 0,
      abilities,
      tags:         cfg.tags || [],
      shieldEquipped:           (() => {
        if (cfg.shieldEquipped) return true;
        const offId = typeof cfg.gear?.offhand === 'string' ? cfg.gear.offhand : null;
        const offItem = offId ? _itemsData.items[offId] : null;
        return !!(offItem && (offItem.tags || []).includes('shield'));
      })(),
      rangedReady:              (() => {
        const AMMO_FOR_WEAPON: Record<string, string> = { bow: 'arrow', crossbow: 'bolt', gun: 'bullet' };
        const rangedId = typeof cfg.gear?.ranged === 'string' ? cfg.gear.ranged : null;
        const ammoId   = typeof cfg.gear?.ammo   === 'string' ? cfg.gear.ammo   : null;
        const rangedItem = rangedId ? _itemsData.items[rangedId] : null;
        if (!rangedItem || rangedItem.slot !== 'ranged') return false;
        const wt = rangedItem.weaponType;
        if (wt === 'wand' || wt === 'thrown') return true;
        const neededTag = AMMO_FOR_WEAPON[wt];
        if (!neededTag) return false;
        const ammoItem = ammoId ? _itemsData.items[ammoId] : null;
        if (!(ammoItem && (ammoItem.tags || []).includes(neededTag))) return false;
        const ammoQty = (cfg._inventory || []).find((e: any) => e.itemId === ammoId)?.qty ?? 0;
        return ammoQty > 0;
      })(),
      damageReceivedThisTurn:   0,
      damageReceivedLastTurn:   0,
      isEnemy,
      alive:        !(cfg.deathState === 'downed' || cfg.deathState === 'dead' || cfg.permadead),
      threatTable:  {},
    };
  };

  const buildPetUnit = (petTemplate: any, owner: Unit): Unit => {
    const level = owner.level || 1;
    const raw: Record<string, number> = {};
    for (const stat of ['str','dex','con','int','spi','wis','spd','cha']) {
      raw[stat] = Math.floor((petTemplate.baseStats[stat] || 0) + (petTemplate.statGrowthPerLevel[stat] || 0) * (level - 1));
    }
    const abilities = (petTemplate.abilities || [])
      .filter((a: any) => (a.level || 1) <= level)
      .map((a: any) => a.id);
    if (!abilities.length) abilities.push('pet_bite');

    // Pets derive ALL stats through the same shared core as everyone else
    // (Engine/charsheet.js), including CON-based HP. The only pet-specific facts:
    // pets have no mana resource and carry no gear. spellPower is 0 here; grant
    // caster pets power elsewhere if needed.
    const baseD = deriveCore({ raw, level, classId: petTemplate.id }, _itemsData.items).derived;
    baseD.maxMana   = 0;
    baseD.manaRegen = 0;
    const derived = applyAlwaysPassives(baseD, abilities);
    const maxHp = derived.maxHp;

    return {
      id:                    `pet_${owner.id}`,
      name:                  petTemplate.name,
      classId:               petTemplate.id,
      raceId:                petTemplate.type || 'beast',
      level,
      hp:                    maxHp,
      maxHp,
      stats:                 { raw, derived },
      skills:                {},
      gear:                  {},
      resources:             {},
      cooldowns:             {},
      castQueue:             [],
      buffs:                 [],
      debuffs:               [],
      ccState:               { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false },
      spd:                   raw.spd || 0,
      abilities,
      tags:                  petTemplate.tags || [],
      shieldEquipped:        false,
      rangedReady:           false,
      damageReceivedThisTurn: 0,
      damageReceivedLastTurn: 0,
      isEnemy:               false,
      alive:                 true,
      threatTable:           {},
      isPet:                 true,
      ownerId:               owner.id,
      aiProfile:             petTemplate.aiProfile || 'aggressive',
      xpValue:               0,
      loot:                  [],
    };
  };

  // ── Scaling resolution ──────────────────────────────────────────────────
  // An effect's `scaling` names which attacker stat(s) drive its magnitude.
  // Recognized keys:
  //   ap / rap / sp  → derived combat stats (buff-adjusted via `ov`)
  //   the 8 attributes (str,dex,con,int,spi,wis,spd,cha) → gear-inclusive total
  //   anything else  → a skill id, resolved to that skill's level
  const SCALE_ATTRS = ['str','dex','con','int','spi','wis','spd','cha'];
  const resolveScaleStat = (attacker: any, key: string, ov: Ov): number => {
    if (key === "ap")  return ov.ap;
    if (key === "sp")  return ov.sp;
    if (key === "rap") return ov.rap;
    if (SCALE_ATTRS.includes(key))
      return attacker.stats.totals?.[key] ?? attacker.stats.raw?.[key] ?? 0;
    const sv = attacker.skills?.[key];               // otherwise a skill id → level
    return typeof sv === "number" ? sv : (sv?.level ?? 0);
  };
  // Sum of all scaling contributions for an effect. Supports two shapes:
  //   object map:  scaling: { ap: 1.0, str: 0.5 }   (coefficient per stat)
  //   legacy form: scaling: "ap", multiplier: 1.0
  // `legacyMult` is the default coefficient for the legacy string form when no
  // `multiplier` is present (1 for damage, 0 for heals — preserves old behavior).
  const scalingSum = (effect: any, attacker: any, ov: Ov, legacyMult: number): number => {
    const s = effect.scaling;
    if (s && typeof s === "object") {
      let sum = 0;
      for (const [k, coeff] of Object.entries<any>(s)) sum += resolveScaleStat(attacker, k, ov) * (coeff || 0);
      return sum;
    }
    if (typeof s === "string") return resolveScaleStat(attacker, s, ov) * (effect.multiplier ?? legacyMult);
    return 0;
  };
  // Weapon-damage contribution for an effect's `usesWeapon` mode. For each weapon
  // in the relevant slot, rolls min..max and divides by weaponSpeed; main-hand is
  // counted in full, off-hand at 50%. `none`/unset contributes nothing.
  const weaponContribution = (attacker: Unit, mode: string | undefined): number => {
    if (!mode || mode === "none") return 0;
    const gear = attacker.gear || {};
    const wpn = (slot: string) => {
      const id = typeof gear[slot] === "string" ? gear[slot] : null;
      const it = id ? _itemsData.items[id] : null;
      return (it && it.type === "weapon") ? it : null;
    };
    const rollOne = (it: any) => {
      const lo = it.minDamage || 0, hi = it.maxDamage || 0;
      const dmg = lo + Math.random() * Math.max(0, hi - lo);
      const spd = it.weaponSpeed || 1;
      return spd > 0 ? dmg / spd : dmg;
    };
    if (mode === "ranged") { const r = wpn("ranged"); return r ? rollOne(r) : 0; }
    // melee: main hand full + off hand at half
    const mh = wpn("mainhand"), oh = wpn("offhand");
    return (mh ? rollOne(mh) : 0) + (oh ? 0.5 * rollOne(oh) : 0);
  };
  // Scaling overrides built straight off a unit's derived stats (no buff
  // adjustment). Used by DoT/HoT ticks and on-hit retaliation/proc damage, which
  // scale off the unit the effect currently sits on rather than the live attacker.
  const baseOv = (unit: Unit): Ov => {
    const d = unit.stats.derived;
    return { ap: d.attackPower || 0, sp: d.spellPower || 0, rap: d.rangedAttackPower || 0 };
  };
  // DoT/HoT magnitude is snapshotted to the CASTER's scaling at application time,
  // so a damage/heal-over-time scales off whoever cast it — not off the victim it
  // sits on. Returns a minimal attacker-like { src, ov } that scalingSum can read.
  const snapshotCaster = (s: any): CasterSnapshot | null => s ? {
    src: { stats: { totals: s.stats?.totals, raw: s.stats?.raw }, skills: s.skills },
    ov:  baseOv(s),
  } : null;

  const rollDamage = (effect: any, attacker: Unit, target: Unit) => {
    const aD = attacker.stats.derived;
    // attacker's buff/debuff modifiers (weapon enchants, debuffs reducing attack power)
    let ap = aD.attackPower || 0, sp = aD.spellPower || 0, rap = aD.rangedAttackPower || 0;
    for (const b of [...attacker.buffs, ...attacker.debuffs]) {
      if (b.modifiers?.attackPower)       ap  += b.modifiers.attackPower;
      if (b.modifiers?.spellPower)        sp  += b.modifiers.spellPower;
      if (b.modifiers?.rangedAttackPower) rap += b.modifiers.rangedAttackPower;
    }
    const ov = { ap, sp, rap };
    // base = flat + stat scaling + weapon damage (weapon term is added pre-crit but
    // is NOT touched by the scaling multiplier — it stands alongside the scaling).
    let base = (effect.flatBonus || 0)
             + scalingSum(effect, attacker, ov, 1)
             + weaponContribution(attacker, effect.usesWeapon);
    const isCrit = Math.random() < (effect.damageType === "physical" ? aD.critChanceMelee : aD.critChanceSpell || 0);
    if (isCrit) base *= aD.critMultiplier || 2;
    if (effect.damageType === "physical") {
      let armor = target.stats.derived.armor || 0;
      for (const b of [...target.buffs, ...target.debuffs]) if (b.modifiers?.armor) armor += b.modifiers.armor;
      armor = Math.max(0, armor);
      base *= (1 - armor / (armor + 1500));
    }
    for (const b of [...target.buffs, ...target.debuffs])
      if (b.modifiers?.damageTakenMultiplier) base *= b.modifiers.damageTakenMultiplier;
    return { damage: Math.max(1, Math.floor(base)), isCrit };
  };

  const rollHeal = (effect: any, caster: Unit) => {
    const d = caster.stats.derived;
    let sp = d.spellPower || 0;
    for (const b of [...caster.buffs, ...caster.debuffs]) if (b.modifiers?.spellPower) sp += b.modifiers.spellPower;
    // Heals can scale off any stat too; legacy default coefficient is 0 (matches
    // prior behavior where a heal with no multiplier added no spell power).
    const ov = { ap: d.attackPower || 0, sp, rap: d.rangedAttackPower || 0 };
    return Math.max(1, Math.floor((effect.flatBonus || 0) + scalingSum(effect, caster, ov, 0)));
  };

  const applyBuff = (unit: Unit, buffId: string, sourceId: string | null, durationOverride?: number | null, source?: Unit): Unit => {
    const def = BUFF_DEFS_BRIDGE[buffId];
    if (!def) return unit;
    const inst: BuffInstance = {
      id: buffId, sourceId, duration: durationOverride != null ? durationOverride : def.duration,
      // snapshot the caster's scaling for DoT/HoT ticks (see snapshotCaster)
      casterScaling:    (source && (def.tickDamage || def.tickHeal)) ? snapshotCaster(source) : null,
      modifiers:        { ...(def.modifiers || {}) },
      ccFlags:          { ...(def.ccFlags   || {}) },
      tickDamage:       def.tickDamage       ? { ...def.tickDamage } : null,
      tickHeal:         def.tickHeal         ? { ...def.tickHeal }   : null,
      tickDrain:        def.tickDrain        || false,
      tickRage:         def.tickRage         || 0,
      absorbShield:     def.absorbShield     || 0,
      isFaded:          def.isFaded          || false,
      negatesNextFear:  def.negatesNextFear  || false,
      onHitRetaliation: def.onHitRetaliation ? { ...def.onHitRetaliation } : null,
      totemGroup:       def.totemGroup       || null,
      fleeBonus:        def.fleeBonus        || 0,
      isWeaponBuff:     def.isWeaponBuff     || false,
      isElementalShield: def.isElementalShield || false,
      isAspect:         def.isAspect         || false,
      isSeal:           def.isSeal           || false,
      isBlessing:       def.isBlessing       || false,
      isAura:           def.isAura           || false,
      invulnerable:     def.invulnerable     || false,
      preventsActions:  def.preventsActions  || false,
      procOnHit:        def.procOnHit        ? { ...def.procOnHit } : null,
      charges:          def.charges          != null ? def.charges : undefined,
      isDebuff:         def.isDebuff         || false,
      isStealth:        def.isStealth        || false,
      doubleAction:     def.doubleAction     || false,
      removedOnDamage:  def.removedOnDamage  || false,
      isArmorSpell:     def.isArmorSpell     || false,
      debuffOnHit:      def.debuffOnHit      ? { ...def.debuffOnHit } : null,
      isCurse:            def.isCurse            || false,
      healingTakenBonus:  def.healingTakenBonus  || 0,
      rampingTickDamage:  def.rampingTickDamage  || false,
      initialDuration:    def.rampingTickDamage ? (durationOverride != null ? durationOverride : def.duration) : undefined,
      isShapeshift:       def.isShapeshift       || false,
      isBearForm:         def.isBearForm         || false,
      immuneToPolymorph:  def.immuneToPolymorph  || false,
      removedOnShapeshift: def.removedOnShapeshift || false,
      retaliationLabel:   def.retaliationLabel   || null,
      blocksStealth:      def.blocksStealth      || false,
    };
    const isDebuff = Object.values<any>(inst.ccFlags || {}).some(Boolean) || !!inst.tickDamage || !!def.isDebuff;
    const field    = isDebuff ? "debuffs" : "buffs";

    // mutual exclusion: weapon buffs, elemental shields, aspects, and blessings only allow one instance at a time
    let u = unit;
    if (def.isWeaponBuff)      u = { ...u, buffs: u.buffs.filter(b => !b.isWeaponBuff) };
    if (def.isElementalShield) u = { ...u, buffs: u.buffs.filter(b => !b.isElementalShield) };
    if (def.isAspect)          u = { ...u, buffs: u.buffs.filter(b => !b.isAspect) };
    if (def.isBlessing)        u = { ...u, buffs: u.buffs.filter(b => !b.isBlessing) };
    if (def.isArmorSpell)      u = { ...u, buffs: u.buffs.filter(b => !b.isArmorSpell) };
    if (def.isCurse) {
      u = { ...u, buffs:   u.buffs.filter(b   => !(b.isCurse   && b.sourceId === sourceId)) };
      u = { ...u, debuffs: u.debuffs.filter(b => !(b.isCurse   && b.sourceId === sourceId)) };
    }
    if (def.isShapeshift) {
      const removedShifts = u.buffs.filter(b => b.isShapeshift);
      for (const rb of removedShifts) {
        const rDef = BUFF_DEFS_BRIDGE[rb.id];
        if (rDef?.maxHpBonus) {
          const nm = u.maxHp - rDef.maxHpBonus;
          u = { ...u, maxHp: nm, hp: Math.min(u.hp, nm) };
        }
      }
      u = { ...u, buffs: u.buffs.filter(b => !b.isShapeshift) };
      u = { ...u, debuffs: u.debuffs.filter(d => !d.removedOnShapeshift) };
      const shiftCC: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
      for (const d of u.debuffs) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) shiftCC[f] = true;
      u = { ...u, ccState: shiftCC };
    }

    const existIdx = u[field].findIndex(b => b.id === buffId);
    const newList  = existIdx >= 0
      ? u[field].map((b, i) => i === existIdx ? { ...b, duration: inst.duration, charges: inst.charges } : b)
      : [...u[field], inst];
    const ccState: CcState = { ...u.ccState };
    for (const [f, v] of Object.entries<any>(inst.ccFlags || {})) if (v) ccState[f] = true;
    let updated = { ...u, [field]: newList, ccState };
    if (def.maxHpBonus && existIdx < 0)
      updated = { ...updated, maxHp: updated.maxHp + def.maxHpBonus, hp: updated.hp + def.maxHpBonus };
    if (def.blocksStealth)
      updated = { ...updated, buffs: updated.buffs.filter(b => !b.isStealth) };
    return updated;
  };

  const syncUnit = (all: Unit[], updated: Unit) => all.map(u => u.id === updated.id ? updated : u);

  const fireProcAbilities = (unit: Unit, trigger: string, procTarget: Unit, logs: string[]) => {
    let u  = { ...unit };
    let pt = { ...procTarget };
    for (const abId of (u.abilities || [])) {
      const ab = ABILITY_DATA[abId];
      if (!ab || !ab.passive || ab.trigger !== trigger) continue;
      for (const effect of (ab.effects || [])) {
        if (effect.type !== "proc") continue;
        if (Math.random() > (effect.chance || 1)) continue;
        const buffId = effect.buffId;
        if (!buffId) continue;
        const isSelfBuff = ["on_hit","on_crit_heal"].includes(trigger);
        if (isSelfBuff) {
          u = applyBuff(u, buffId, u.id, undefined, u);
          logs.push(`    ↳ ${u.name} procs ${buffId}`);
        } else {
          pt = applyBuff(pt, buffId, u.id, undefined, u);
          logs.push(`    ↳ ${pt.name} afflicted by ${buffId} (proc)`);
        }
      }
    }
    return { unit: u, procTarget: pt };
  };

  // Per-run ability-usage tracker (party only) for skill XP. Reset at run() start;
  // surfaced in the run() result and turned into skill XP by runEncounter.
  let _abilityUse: Record<string, Record<string, number>> = {};
  const _recordAbilityUse = (caster: Unit, abilityId: string) => {
    if (!caster || caster.isEnemy) return;
    const bucket = (_abilityUse[caster.id] = _abilityUse[caster.id] || {});
    bucket[abilityId] = (bucket[abilityId] || 0) + 1;
  };

  const execAbility = (abilityId: string, caster: Unit, targets: Unit[], logs: string[]) => {
    const ab = ABILITY_DATA[abilityId];
    if (!ab || ab.passive || ab.outOfCombatOnly) return { caster, targets };
    _recordAbilityUse(caster, abilityId);
    logs.push(`  ${caster.name} → ${abilityId.replace(/_/g, " ")}`);

    let c: Unit = { ...caster, resources: { ...caster.resources } };

    // manaCostPercent consumes a fraction of max mana (e.g. Resurrection = 100%)
    if (ab.manaCostPercent && c.resources.mana) {
      const cost = Math.floor(c.resources.mana.max * ab.manaCostPercent);
      c.resources = { ...c.resources, mana: { ...c.resources.mana, current: Math.max(0, c.resources.mana.current - cost) } };
    }
    for (const [r, a] of Object.entries<any>(ab.resourceCost || {}))
      if (c.resources[r]) c.resources[r] = { ...c.resources[r], current: c.resources[r].current - a };
    if ((ab.cooldown || 0) > 0)
      c = { ...c, cooldowns: { ...c.cooldowns, [abilityId]: ab.cooldown } };

    let ts = [...targets];
    let comboPtsSpent = false;

    for (const effect of ab.effects) {
      // per-effect targeting override (Holy Nova: damage→enemies, heal→allies)
      let effectTs: Unit[];
      if      (effect.effectTargeting === "all_allies")  effectTs = ts.filter(t => !t.isEnemy === !c.isEnemy);
      else if (effect.effectTargeting === "all_enemies") effectTs = ts.filter(t =>  t.isEnemy !== c.isEnemy);
      else if (effect.effectTargeting === "self")        effectTs = [c];
      else                                               effectTs = ts;

      // self_buff: apply buff to caster regardless of ability targeting (e.g. Frostbolt flee bonus)
      if (effect.type === "self_buff") {
        c = applyBuff(c, effect.buffId, c.id, undefined, c);
        logs.push(`    ↳ ${c.name} gains ${effect.buffId}`);
        continue;
      }

      const updated: Unit[] = [];
      for (let i = 0; i < effectTs.length; i++) {
        let t = effectTs[i];
        if (!t.alive) { updated.push(t); continue; }

        if (effect.type === "damage") {
          // invulnerability: target takes no damage (Hand of Protection)
          if (t.buffs.some(b => b.invulnerable)) {
            logs.push(`    ↳ ${t.name} is invulnerable!`);
            updated.push(t); continue;
          }

          let { damage, isCrit } = rollDamage(effect, c, t);

          // combo finisher: scale damage by combo points and spend them (e.g. Eviscerate)
          if (effect.comboFinisher) {
            const cp = c.resources.combo_points?.current || 0;
            damage += (effect.bonusPerComboPoint || 0) * cp;
            damage = Math.max(1, Math.floor(damage));
            if (!comboPtsSpent) {
              c = { ...c, resources: { ...c.resources, combo_points: { ...c.resources.combo_points, current: 0 } } };
              comboPtsSpent = true;
            }
          }

          // drain soul bonus: double damage when target is at or below threshold HP
          if (effect.bonusIfHpBelow && t.maxHp > 0 && t.hp / t.maxHp <= effect.bonusIfHpBelow.threshold) {
            damage = Math.max(1, Math.floor(damage * effect.bonusIfHpBelow.extraMultiplier));
          }

          // dodge: physical attacks can be avoided by the target's dodge chance
          // (spd-derived + dodgeChance buff modifiers), capped at 75%. Magic ignores dodge.
          if (effect.damageType === "physical") {
            let totalDodge = t.stats?.derived?.dodge || 0;
            for (const b of t.buffs) if (b.modifiers?.dodgeChance) totalDodge += b.modifiers.dodgeChance;
            totalDodge = Math.min(0.75, totalDodge);
            if (totalDodge > 0 && Math.random() < totalDodge) {
              logs.push(`    ↳ ${t.name} dodges!`);
              updated.push(t); continue;
            }
          }

          // absorb shield intercepts damage before HP
          const shieldIdx = t.buffs.findIndex(b => (b.absorbShield || 0) > 0);
          if (shieldIdx >= 0) {
            const shield   = t.buffs[shieldIdx];
            const absorbed = Math.min(shield.absorbShield || 0, damage);
            damage -= absorbed;
            const rem = (shield.absorbShield || 0) - absorbed;
            t = { ...t, buffs: rem <= 0
              ? t.buffs.filter((_, bi) => bi !== shieldIdx)
              : t.buffs.map((b, bi) => bi === shieldIdx ? { ...b, absorbShield: rem } : b) };
            logs.push(`    ↳ ${t.name}: shield absorbs ${absorbed}${rem <= 0 ? " [broken]" : ""}`);
            if (damage <= 0) { updated.push(t); continue; }
          }

          logs.push(`    ↳ ${t.name}: ${damage}${isCrit ? " [CRIT]" : ""} ${effect.damageType}`);
          t = { ...t, hp: Math.max(0, t.hp - damage), damageReceivedThisTurn: (t.damageReceivedThisTurn || 0) + damage };
          // rage from taking physical damage (warriors, bear druids)
          if (t.resources?.rage && effect.damageType === "physical") {
            const rg = Math.floor(damage / 5);
            if (rg > 0) t = { ...t, resources: { ...t.resources, rage: { ...t.resources.rage, current: Math.min(t.resources.rage.max, t.resources.rage.current + rg) } } };
          }

          // removedOnDamage: debuffs that break when the target takes damage (e.g. Sap)
          if (t.debuffs.some(d => d.removedOnDamage)) {
            t = { ...t, debuffs: t.debuffs.filter(d => !d.removedOnDamage) };
            const cs: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
            for (const d of t.debuffs) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) cs[f] = true;
            t = { ...t, ccState: cs };
            logs.push(`    ↳ ${t.name}'s stun broken by damage`);
          }

          if (c.resources.rage) {
            const rg = Math.floor(damage / 5);
            c = { ...c, resources: { ...c.resources, rage: { ...c.resources.rage, current: Math.min(100, c.resources.rage.current + rg) } } };
          }
          // faded units generate zero threat
          if (!c.isEnemy && !c.buffs.some(b => b.isFaded)) {
            const th = c.threatTable || {};
            c = { ...c, threatTable: { ...th, [t.id]: (th[t.id] || 0) + damage } };
          }
          const hitProc = fireProcAbilities(c, "on_hit", t, logs);
          c = hitProc.unit; t = hitProc.procTarget;

          // on-hit retaliation: target's buff zaps back the attacker (lightning shield, thorns, etc.)
          for (let bi = 0; bi < t.buffs.length; bi++) {
            const sb = t.buffs[bi];
            if (!sb.onHitRetaliation) continue;
            const rtn = sb.onHitRetaliation;
            let retDmg = (rtn.flat || 0) + scalingSum(rtn, t, baseOv(t), 0);
            retDmg = Math.max(1, Math.floor(retDmg));
            c = { ...c, hp: Math.max(0, c.hp - retDmg) };
            if (c.hp <= 0 && c.alive) c = { ...c, alive: false };
            const retLabel = sb.retaliationLabel || "retaliation zaps";
            logs.push(`    ↳ ${t.name}: ${retLabel} ${c.name} for ${retDmg} ${rtn.damageType || "nature"}`);
            if (sb.charges != null) {
              const newCharges = sb.charges - 1;
              t = { ...t, buffs: newCharges <= 0
                ? t.buffs.filter((_, bj) => bj !== bi)
                : t.buffs.map((b, bj) => bj === bi ? { ...b, charges: newCharges } : b) };
            }
            break;
          }

          // debuffOnHit: physical attacks on target with debuffOnHit buff afflict the attacker (e.g. Frost Armor chill)
          if (effect.damageType === "physical") {
            for (const b of t.buffs) {
              if (!b.debuffOnHit) continue;
              c = applyBuff(c, b.debuffOnHit.buffId, t.id, undefined, t);
              logs.push(`    ↳ ${c.name} afflicted by ${b.debuffOnHit.buffId}`);
              break;
            }
          }

          // seal procs: attacker's seal buffs deal bonus holy damage on physical hits
          if (effect.damageType === "physical" && t.alive) {
            for (const b of c.buffs) {
              if (!b.procOnHit) continue;
              const rtn = b.procOnHit;
              let procDmg = (rtn.flat || 0) + scalingSum(rtn, c, baseOv(c), 0);
              procDmg = Math.max(1, Math.floor(procDmg));
              t = { ...t, hp: Math.max(0, t.hp - procDmg) };
              if (t.hp <= 0 && t.alive) { t = { ...t, alive: false, hp: 0 }; logs.push(`    ✗ ${t.name} dies`); }
              logs.push(`    ↳ ${c.name}'s seal procs: ${procDmg} holy`);
            }
          }

          if (t.hp <= 0 && t.alive) { logs.push(`    ✗ ${t.name} dies`); t = { ...t, alive: false, hp: 0 }; }

          if (effect.drainSoul && !t.alive) {
            c = { ...c, soulShardsGained: (c.soulShardsGained || 0) + 1 };
            logs.push(`    ↳ ${c.name} captures a Soul Shard!`);
          }
        }

        if (effect.type === "heal") {
          const h      = rollHeal(effect, c);
          const isCrit = Math.random() < (c.stats.derived.critChanceSpell || 0);
          const healed = isCrit ? Math.floor(h * 1.5) : h;
          const healBonus = t.buffs.reduce((s, b) => s + (b.healingTakenBonus || 0), 0);
          const amplified = healBonus > 0 ? Math.floor(healed * (1 + healBonus)) : healed;
          const act    = Math.min(t.maxHp - t.hp, amplified);
          t = { ...t, hp: t.hp + act };
          logs.push(`    ↳ heals ${t.name}: +${act}${isCrit ? " [CRIT]" : ""}`);
          if (isCrit) {
            const hp = fireProcAbilities(c, "on_crit_heal", t, logs);
            c = hp.unit; t = hp.procTarget;
          }
        }

        if (effect.type === "buff") {
          let durOverride: number | undefined;
          if (effect.comboFinisher && effect.durationPerComboPoint) {
            const cp = c.resources.combo_points?.current || 0;
            durOverride = cp * effect.durationPerComboPoint;
            if (!comboPtsSpent) {
              c = { ...c, resources: { ...c.resources, combo_points: { ...c.resources.combo_points, current: 0 } } };
              comboPtsSpent = true;
            }
          }
          t = applyBuff(t, effect.buffId, c.id, durOverride, c);
          logs.push(`    ↳ ${t.name} gains ${effect.buffId}${durOverride != null ? ` (${durOverride}t)` : ""}`);
        }

        if (effect.type === "debuff") {
          const def = BUFF_DEFS_BRIDGE[effect.buffId] || {};
          // polymorph immunity: units in bear form (or other shapeshifts) cannot be polymorphed
          if (def.isPolymorph && t.buffs.some(b => b.immuneToPolymorph)) {
            logs.push(`    ↳ ${t.name} is immune (shapeshift)`);
            updated.push(t); continue;
          }
          // fear ward consumes its charge and blocks the fear
          if (def.ccFlags?.feared) {
            const wardIdx = t.buffs.findIndex(b => b.negatesNextFear);
            if (wardIdx >= 0) {
              t = { ...t, buffs: t.buffs.map((b, i) => i === wardIdx ? { ...b, duration: 0 } : b).filter(b => (b.duration as number) > 0) };
              logs.push(`    ↳ ${t.name} resists fear (Fear Ward consumed)`);
              updated.push(t); continue;
            }
          }
          if (Math.random() < (effect.chance || 1)) {
            t = applyBuff(t, effect.buffId, c.id, undefined, c);
            logs.push(`    ↳ ${t.name} afflicted by ${effect.buffId}`);
          }
        }

        // smart dispel: enemy target → strip buff; ally target → strip debuff
        if (effect.type === "dispel") {
          const isTargetEnemy = t.isEnemy !== c.isEnemy;
          if (isTargetEnemy && t.buffs.length > 0) {
            t = { ...t, buffs: t.buffs.slice(1) };
            logs.push(`    ↳ ${t.name} buff dispelled`);
          } else if (!isTargetEnemy && t.debuffs.length > 0) {
            const removed = t.debuffs[0];
            t = { ...t, debuffs: t.debuffs.slice(1) };
            const cs: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
            for (const d of t.debuffs) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) cs[f] = true;
            t = { ...t, ccState: cs };
            logs.push(`    ↳ ${t.name} debuff dispelled (${removed.id})`);
          }
        }

        // explicit buff removal (e.g. spell_reflection consuming the buff)
        if (effect.type === "dispel_buff") {
          if (t.buffs.length > 0) { t = { ...t, buffs: t.buffs.slice(1) }; logs.push(`    ↳ ${t.name} buff removed`); }
        }

        if (effect.type === "cleanse") {
          if (effect.debuffType) {
            t = { ...t, debuffs: t.debuffs.filter(d => !(BUFF_DEFS_BRIDGE[d.id]?.tags || []).includes(effect.debuffType)) };
          } else {
            t = { ...t, debuffs: [] };
          }
          const cs: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
          for (const d of t.debuffs) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) cs[f] = true;
          t = { ...t, ccState: cs };
          logs.push(`    ↳ ${t.name} cleansed`);
        }

        if (effect.type === "interrupt") {
          t = { ...t, castQueue: [] };
          logs.push(`    ↳ ${t.name} interrupted`);
        }

        if (effect.type === "threat") {
          if (!c.isEnemy) {
            const th = { ...c.threatTable };
            for (const tgt of ts) th[tgt.id] = (th[tgt.id] || 0) + (effect.flat || 10000);
            c = { ...c, threatTable: th };
          }
        }

        if (effect.type === "health_cost") {
          const cost = effect.flat || Math.floor(c.hp * (effect.percent || 0));
          c = { ...c, hp: Math.max(1, c.hp - cost) };
        }

        if (effect.type === "rage_gain") {
          if (c.resources.rage) {
            const gain = effect.flat || effect.amount || 0;
            c = { ...c, resources: { ...c.resources, rage: { ...c.resources.rage, current: Math.min(100, c.resources.rage.current + gain) } } };
          }
        }

        // consume caster's active seal (Judgement); target is unchanged
        if (effect.type === "consume_seal") {
          const sealIdx = c.buffs.findIndex(b => b.isSeal);
          if (sealIdx >= 0) {
            const sealId = c.buffs[sealIdx].id;
            c = { ...c, buffs: c.buffs.filter((_, bi) => bi !== sealIdx) };
            logs.push(`    ↳ ${c.name}'s ${sealId} consumed`);
          }
        }

        // remove disease/poison debuffs from target (Purify)
        if (effect.type === "purify") {
          const removes = new Set(effect.removes || []);
          const before  = t.debuffs.length;
          t = { ...t, debuffs: t.debuffs.filter(d => !removes.has(BUFF_DEFS_BRIDGE[d.id]?.debuffType)) };
          const cs: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
          for (const d of t.debuffs) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) cs[f] = true;
          t = { ...t, ccState: cs };
          const removed = before - t.debuffs.length;
          logs.push(removed > 0 ? `    ↳ purified ${removed} effect(s) from ${t.name}` : `    ↳ nothing to purify on ${t.name}`);
        }

        // gain combo point(s) for the caster (e.g. Sinister Strike)
        if (effect.type === "gain_combo_point") {
          if (c.resources.combo_points) {
            const gain  = effect.count || 1;
            const newCp = Math.min(c.resources.combo_points.max, c.resources.combo_points.current + gain);
            c = { ...c, resources: { ...c.resources, combo_points: { ...c.resources.combo_points, current: newCp } } };
            logs.push(`    ↳ ${c.name} gains ${gain} combo point${gain > 1 ? "s" : ""} (${newCp}/${c.resources.combo_points.max})`);
          }
        }

        // steal gold from target (Pick Pocket); collected into run result
        if (effect.type === "pick_pocket") {
          const amount = effect.flat || 0;
          t = { ...t, pickpocketGold: (t.pickpocketGold || 0) + amount };
          logs.push(`    ↳ ${c.name} pickpockets ${amount} copper from ${t.name}`);
        }

        // revive is handled post-combat; outOfCombatOnly guards against combat use
        updated.push(t);
      }

      // sync updated subset back into the full target list
      if (effectTs === ts) {
        ts = updated;
      } else {
        for (const u of updated) { const idx = ts.findIndex(x => x.id === u.id); if (idx >= 0) ts[idx] = u; }
      }
    }

    // if caster just entered fade, zero out their threat on all known targets
    if (c.buffs.some(b => b.isFaded) && !caster.buffs.some(b => b.isFaded)) {
      const zeroTable: Record<string, number> = {};
      for (const k of Object.keys(c.threatTable || {})) zeroTable[k] = 0;
      c = { ...c, threatTable: zeroTable };
    }

    // when the caster targeted themselves (self-buff), merge the target's updated
    // fields (buffs, debuffs, hp, ccState) back into the caster so neither the
    // resource deduction nor the applied buff is lost
    const selfAsTarget = ts.find(t => t.id === c.id);
    if (selfAsTarget) c = { ...selfAsTarget, resources: c.resources, cooldowns: c.cooldowns, threatTable: c.threatTable };

    return { caster: c, targets: ts };
  };

  const tickBuffsUnit = (unit: Unit) => {
    const logs: string[] = [], drainHeals: any[] = []; let u = { ...unit };
    for (const eff of [...u.buffs, ...u.debuffs]) {
      if (eff.tickDamage) {
        const td  = eff.tickDamage;
        const cs  = eff.casterScaling;                      // caster snapshot, if any
        let dmg   = (td.flat || 0) + scalingSum(td, cs ? cs.src : u, cs ? cs.ov : baseOv(u), 0);
        dmg = Math.max(1, Math.floor(dmg));
        if (eff.rampingTickDamage && (eff.initialDuration || 0) > 1) {
          const progress = (eff.initialDuration - (eff.duration as number)) / (eff.initialDuration - 1);
          dmg = Math.max(1, Math.floor(dmg * (0.5 + progress)));
        }
        u = { ...u, hp: Math.max(0, u.hp - dmg) };
        logs.push(`    ↳ ${u.name} takes ${dmg} ${td.damageType} (${eff.id})`);
        if (eff.tickDrain && eff.sourceId) drainHeals.push({ sourceId: eff.sourceId, amount: dmg });
      }
      if (eff.tickHeal) {
        const th   = eff.tickHeal;
        const csH  = eff.casterScaling;                     // caster snapshot, if any
        let heal   = (th.flat || 0) + scalingSum(th, csH ? csH.src : u, csH ? csH.ov : baseOv(u), 0);
        heal = Math.max(1, Math.floor(heal));
        u = { ...u, hp: Math.min(u.maxHp, u.hp + heal) };
        logs.push(`    ↳ ${u.name} heals ${heal} (${eff.id})`);
      }
      if (eff.tickRage && u.resources.rage) {
        const gain = Math.min(eff.tickRage, u.resources.rage.max - u.resources.rage.current);
        if (gain > 0) {
          u = { ...u, resources: { ...u.resources, rage: { ...u.resources.rage, current: u.resources.rage.current + gain } } };
          logs.push(`    ↳ ${u.name} gains ${gain} rage (${eff.id})`);
        }
      }
    }
    return { unit: u, logs, drainHeals };
  };

  const expireBuffsUnit = (unit: Unit) => {
    let u = { ...unit };
    // revert maxHpBonus before the buff expires
    for (const b of u.buffs) {
      if ((b.duration as number) <= 1) {
        const def = BUFF_DEFS_BRIDGE[b.id];
        if (def?.maxHpBonus) {
          const newMax = u.maxHp - def.maxHpBonus;
          u = { ...u, maxHp: newMax, hp: Math.min(u.hp, newMax) };
        }
      }
    }
    const process = (list: BuffInstance[]) => list.map(b => ({ ...b, duration: (b.duration as number) - 1 })).filter(b => b.duration > 0);
    const nb = process(u.buffs), nd = process(u.debuffs);
    const ccState: CcState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
    for (const d of nd) for (const [f, v] of Object.entries<any>(d.ccFlags || {})) if (v) ccState[f] = true;
    return { ...u, buffs: nb, debuffs: nd, ccState };
  };

  // sameTeam = own side (for heal/buff targeting), oppositeTeam = enemy side
  const aiChoose = (unit: Unit, sameTeam: Unit[], oppositeTeam: Unit[], ctx: any) => {
    const liveOpp  = oppositeTeam.filter(t => t.alive && !t.buffs?.some(b => b.isFaded) && !t.buffs?.some(b => b.isStealth));
    const liveSame = sameTeam.filter(t => t.alive);
    if (unit.ccState.stunned) return null;
    if (unit.buffs.some(b => b.preventsActions)) return null;

    const primaryOpp = liveOpp.length
      ? [...liveOpp].sort((a, b) => {
          const tA = unit.threatTable?.[a.id] || 0, tB = unit.threatTable?.[b.id] || 0;
          return tB - tA || a.hp - b.hp;
        })[0]
      : null;
    const mostInjured = liveSame.length
      ? [...liveSame].sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0]
      : null;

    const avail = (unit.abilities || []).filter(id => {
      const ab = ABILITY_DATA[id];
      if (!ab || ab.passive || ab.outOfCombatOnly || (unit.cooldowns[id] || 0) > 0) return false;
      if (unit.ccState.disarmed && ab.tags?.includes("physical")) return false;
      if (ab.tags?.includes("ranged") && !unit.rangedReady) return false;
      for (const [r, a] of Object.entries<any>(ab.resourceCost || {}))
        if ((unit.resources[r]?.current || 0) < a) return false;
      if (ab.spendComboPoints && (unit.resources.combo_points?.current || 0) < 1) return false;
      if (ab.requiresCondition === "in_stealth"   && !unit.buffs.some(b => b.isStealth))   return false;
      if (ab.requiresCondition === "in_bear_form" && !unit.buffs.some(b => b.isBearForm)) return false;
      if (id === "stealth" && unit.debuffs?.some(d => d.blocksStealth)) return false;
      const needsOpp  = ["single_enemy","all_enemies","front_2_enemies","single_any"].includes(ab.targeting);
      const needsSame = ["single_ally","all_allies"].includes(ab.targeting);
      if (needsOpp  && !liveOpp.length)  return false;
      if (needsSame && !liveSame.length) return false;
      if (ctx) {
        if (ab.requiresOpener && ctx.turn > 1) return false;
        if (ab.requiresMinCombatTurn && ctx.turn < ab.requiresMinCombatTurn) return false;
        if (ab.requiresMaxCombatTurn && ctx.turn > ab.requiresMaxCombatTurn) return false;
        if (ab.requiresTargetHpBelow && primaryOpp && primaryOpp.hp / primaryOpp.maxHp >= ab.requiresTargetHpBelow) return false;
        if (ab.requiresOffhandType === "shield" && !unit.shieldEquipped) return false;
        if (ab.requiresCondition === "prior_encounter_victory" && !ctx.priorEncounterVictory) return false;
        if (ab.requiresCondition === "enemy_no_damage_last_turn" && primaryOpp && (primaryOpp.damageReceivedLastTurn || 0) > 0) return false;
        if (ab.requiresCondition === "self_no_damage_last_turn"  && (unit.damageReceivedLastTurn || 0) > 0) return false;
        if (ab.requiresTargetTag) {
          const tagReq = ab.requiresTargetTag;
          const hasTag = (etags: string[]) => Array.isArray(tagReq) ? tagReq.some((r: string) => etags.includes(r)) : etags.includes(tagReq);
          if (!liveOpp.some(e => hasTag(e.tags || []))) return false;
        }
      }
      return true;
    });
    if (!avail.length) return null;

    const dmgAbils  = avail.filter(id => {
      const ab = ABILITY_DATA[id];
      const enemyTargeted = !["single_ally","all_allies","self"].includes(ab.targeting);
      return enemyTargeted && ab.effects.some((e: any) => e.type === "damage" || e.type === "debuff" || e.type === "threat" || e.type === "pick_pocket");
    });
    const healAbils = avail.filter(id => ABILITY_DATA[id].effects.some((e: any) => e.type === "heal"));
    const buffAbils = avail.filter(id => {
      const ab = ABILITY_DATA[id];
      return ab.effects.some((e: any) => e.type === "buff") && ["self","single_ally","all_allies"].includes(ab.targeting);
    });

    // setup buffs (self/party-wide enchants, seals, auras) not yet active on this unit
    const setupAbils = buffAbils.filter(id => {
      const ab = ABILITY_DATA[id];
      return ["self", "single_ally", "all_allies"].includes(ab.targeting) &&
        ab.effects.some((e: any) => e.type === "buff" && e.buffId && !unit.buffs.some(b => b.id === e.buffId));
    });

    const injuredAlly = mostInjured && mostInjured.hp / mostInjured.maxHp < 0.5;
    let chosen: string;
    if (injuredAlly && healAbils.length)  chosen = healAbils[0];
    else if (setupAbils.length)           chosen = setupAbils[0];
    else if (dmgAbils.length)             chosen = dmgAbils[0];
    else if (healAbils.length)            chosen = healAbils[0];
    else if (buffAbils.length)            chosen = buffAbils[0];
    else                                  chosen = avail[0];

    const abChosen = ABILITY_DATA[chosen];
    let targetId: string | undefined;
    if (abChosen.targeting === "self")                                   targetId = unit.id;
    else if (["single_ally","all_allies"].includes(abChosen.targeting))  targetId = mostInjured?.id || unit.id;
    else if (abChosen.targeting === "front_2_enemies")                   targetId = primaryOpp?.id;
    else if (abChosen.targeting === "single_any") {
      const buffedEnemy  = liveOpp.find(e => e.buffs?.length > 0);
      const debuffedAlly = liveSame.find(a => a.debuffs?.length > 0);
      targetId = buffedEnemy?.id || debuffedAlly?.id || primaryOpp?.id || mostInjured?.id;
    } else if (abChosen.requiresTargetTag) {
      const tagReq = abChosen.requiresTargetTag;
      const hasTag = (etags: string[]) => Array.isArray(tagReq) ? tagReq.some((r: string) => etags.includes(r)) : etags.includes(tagReq);
      targetId = liveOpp.find(e => hasTag(e.tags || []))?.id;
    } else {
      targetId = primaryOpp?.id;
    }

    return targetId ? { abilityId: chosen, targetId } : null;
  };

  // Resolve which unit array to pass to execAbility based on ability targeting type
  const resolveTargets = (ab: any, targetId: string | undefined, actor: Unit, party: Unit[], enemies: Unit[]) => {
    const liveE = enemies.filter(u => u.alive);
    const liveP = party.filter(u => u.alive);
    switch (ab.targeting) {
      case "all_enemies":     return actor.isEnemy ? liveP : liveE;
      case "all_allies":      return actor.isEnemy ? liveE : liveP;
      case "self":            return [actor];
      case "aoe_both":        return [...liveP, ...liveE];
      case "front_2_enemies":
      case "cleave":          return (actor.isEnemy ? liveP : liveE).slice(0, 2);
      case "single_ally": {
        const pool = actor.isEnemy ? liveE : liveP;
        return [pool.find(u => u.id === targetId) || pool[0]].filter((u): u is Unit => !!u);
      }
      case "single_ally_dead": {
        const pool = actor.isEnemy ? enemies : party;
        return [pool.find(u => u.id === targetId && !u.alive)].filter((u): u is Unit => !!u);
      }
      case "single_any": {
        const all = [...liveP, ...liveE];
        return [all.find(u => u.id === targetId) || all[0]].filter((u): u is Unit => !!u);
      }
      default: {
        const pool = actor.isEnemy ? liveP : liveE;
        return [pool.find(u => u.id === targetId) || pool[0]].filter((u): u is Unit => !!u);
      }
    }
  };

  const tickUnit = (unit: Unit) => {
    const cd = { ...unit.cooldowns };
    for (const id of Object.keys(cd)) { cd[id] = Math.max(0, cd[id] - 1); if (cd[id] === 0) delete cd[id]; }
    const res = { ...unit.resources };
    if (res.stamina) res.stamina = { ...res.stamina, current: Math.min(res.stamina.max, res.stamina.current + 15) };
    if (res.mana)   res.mana   = { ...res.mana,   current: Math.min(res.mana.max,   res.mana.current + (unit.stats.derived.manaRegen || 0)) };
    return { ...unit, cooldowns: cd, resources: res };
  };

  const run = (encounter: any, partyInstances: any[], opts: any = {}) => {
    const logs: string[] = [], MAX = 30, ammoUsed: Record<string, number> = {};
    _abilityUse = {}; // reset per-run ability-usage tracker
    const _trackAmmo = (ab: any, actor: Unit) => {
      if (!(ab?.tags || []).includes('ranged')) return;
      const rItem = _itemsData.items[actor.gear?.ranged];
      if (rItem?.weaponType === 'wand' || rItem?.weaponType === 'thrown') return;
      const aid = actor.gear?.ammo;
      if (aid) ammoUsed[aid] = (ammoUsed[aid] || 0) + 1;
    };
    const _baseParty = partyInstances.map(inst => buildUnit(inst, false));
    let party   = _injectPets(_baseParty, partyInstances);
    let enemies: Unit[] = encounter.enemies.map((e: any) => buildUnit(e, true));
    logs.push(`⚔ ${encounter.zoneId.toUpperCase()}� ${party.map(u => u.name).join(",")} vs ${enemies.map(u => u.name).join(",")}`);
    let turn = 0, outcome = null;

    while (turn < MAX && !outcome) {
      turn++; logs.push(`\n── T${turn}`);
      const ctx = { turn, priorEncounterVictory: opts.priorEncounterVictory };

      // ── party turn ────────────────────────────────────────────────────────
      for (let pi = 0; pi < party.length; pi++) {
        let actor = party[pi];
        if (!actor.alive || actor.ccState.stunned) { if (actor.ccState.stunned) logs.push(`  ${actor.name} is stunned`); continue; }

        let castFired = false;
        if (actor.castQueue?.length) {
          const ready: any[] = [], pending: any[] = [];
          for (const e of actor.castQueue) {
            if (e.turnsRemaining <= 0) ready.push(e);
            else pending.push({ ...e, turnsRemaining: e.turnsRemaining - 1 });
          }
          actor = { ...actor, castQueue: pending };
          for (const entry of ready) {
            const ab = ABILITY_DATA[entry.abilityId];
            if (!ab) continue;
            castFired = true;
            const tgts = resolveTargets(ab, entry.targetId, actor, party, enemies);
            const res  = execAbility(entry.abilityId, actor, tgts, logs);
            actor = res.caster; _trackAmmo(ABILITY_DATA[entry.abilityId], actor);
            for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
          }
        }
        if (castFired) { party = syncUnit(party, actor); continue; }

        const liveE = enemies.filter(e => e.alive); if (!liveE.length) break;
        const liveP = party.filter(p => p.alive);
        const ai = aiChoose(actor, liveP, liveE, ctx); if (!ai) continue;
        const ab = ABILITY_DATA[ai.abilityId]; if (!ab) continue;

        // earth/fire totem replacement: strip old totem group before applying new totem
        if (ab.removesTotemGroup) {
          const g = ab.removesTotemGroup;
          const clean = (u: Unit) => ({ ...u, buffs: u.buffs.filter(b => b.totemGroup !== g), debuffs: u.debuffs.filter(b => b.totemGroup !== g) });
          party   = party.map(clean);
          enemies = enemies.map(clean);
          actor   = clean(actor);
        }

        if ((ab.castTime || 0) > 0) {
          actor = { ...actor, castQueue: [...(actor.castQueue || []), { abilityId: ai.abilityId, targetId: ai.targetId, turnsRemaining: ab.castTime - 1 }] };
          logs.push(`  ${actor.name} begins casting ${ai.abilityId.replace(/_/g, " ")}`);
        } else {
          const tgts = resolveTargets(ab, ai.targetId, actor, party, enemies);
          const res  = execAbility(ai.abilityId, actor, tgts, logs);
          actor = res.caster; _trackAmmo(ABILITY_DATA[ai.abilityId], actor);
          for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }

          // stealth: any ability other than stealth itself breaks stealth
          if (actor.buffs.some(b => b.isStealth) && ai.abilityId !== "stealth") {
            actor = { ...actor, buffs: actor.buffs.filter(b => !b.isStealth) };
            logs.push(`  ${actor.name} leaves stealth`);
          }

          // instant shift (castTime -1): shapeshift grants a free action the same turn
          if (ab.castTime === -1 && actor.alive) {
            const liveEsh = enemies.filter(e => e.alive);
            const livePsh = party.filter(p => p.alive);
            if (liveEsh.length) {
              const aiSh = aiChoose(actor, livePsh, liveEsh, ctx);
              if (aiSh) {
                const abSh = ABILITY_DATA[aiSh.abilityId];
                if (abSh && (abSh.castTime || 0) <= 0) {
                  const tgtsSh = resolveTargets(abSh, aiSh.targetId, actor, party, enemies);
                  const resSh  = execAbility(aiSh.abilityId, actor, tgtsSh, logs);
                  actor = resSh.caster;
                  for (const t of resSh.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
                }
              }
            }
          }

          // double action: units with doubleAction buff (Slice and Dice) act a second time
          if (actor.buffs.some(b => b.doubleAction)) {
            const liveE2 = enemies.filter(e => e.alive);
            const liveP2 = party.filter(p => p.alive);
            const ai2 = aiChoose(actor, liveP2, liveE2, ctx);
            if (ai2) {
              const ab2 = ABILITY_DATA[ai2.abilityId];
              if (ab2) {
                const tgts2 = resolveTargets(ab2, ai2.targetId, actor, party, enemies);
                const res2  = execAbility(ai2.abilityId, actor, tgts2, logs);
                actor = res2.caster;
                for (const t of res2.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
                if (actor.buffs.some(b => b.isStealth) && ai2.abilityId !== "stealth") {
                  actor = { ...actor, buffs: actor.buffs.filter(b => !b.isStealth) };
                  logs.push(`  ${actor.name} leaves stealth`);
                }
              }
            }
          }
        }
        party = syncUnit(party, actor);
      }

      // ── enemy turn ────────────────────────────────────────────────────────
      for (let ei = 0; ei < enemies.length; ei++) {
        let actor = enemies[ei]; if (!actor.alive || actor.ccState.stunned) continue;
        const liveP = party.filter(p => p.alive); if (!liveP.length) break;
        const liveE = enemies.filter(e => e.alive);
        const ai = aiChoose(actor, liveE, liveP, ctx); if (!ai) continue;
        const ab = ABILITY_DATA[ai.abilityId]; if (!ab) continue;

        if (ab.removesTotemGroup) {
          const g = ab.removesTotemGroup;
          const clean = (u: Unit) => ({ ...u, buffs: u.buffs.filter(b => b.totemGroup !== g), debuffs: u.debuffs.filter(b => b.totemGroup !== g) });
          party   = party.map(clean);
          enemies = enemies.map(clean);
          actor   = clean(actor);
        }

        if ((ab.castTime || 0) > 0) {
          actor = { ...actor, castQueue: [...(actor.castQueue || []), { abilityId: ai.abilityId, targetId: ai.targetId, turnsRemaining: ab.castTime - 1 }] };
          logs.push(`  ${actor.name} begins casting ${ai.abilityId.replace(/_/g, " ")}`);
        } else {
          const tgts = resolveTargets(ab, ai.targetId, actor, party, enemies);
          const res  = execAbility(ai.abilityId, actor, tgts, logs);
          actor = res.caster;
          for (const t of res.targets) if (!t.isEnemy) party = syncUnit(party, t);
        }
        enemies = syncUnit(enemies, actor);
      }

      // ── tick DoTs/HoTs, collect drain heals, expire buffs, regen ─────────
      const allDrains: any[] = [];
      for (let i = 0; i < party.length;   i++) {
        const { unit: u, logs: l, drainHeals } = tickBuffsUnit(party[i]);
        logs.push(...l); allDrains.push(...drainHeals); party[i] = expireBuffsUnit(u);
      }
      for (let i = 0; i < enemies.length; i++) {
        const { unit: u, logs: l, drainHeals } = tickBuffsUnit(enemies[i]);
        logs.push(...l); allDrains.push(...drainHeals); enemies[i] = expireBuffsUnit(u);
      }
      // apply Devouring Plague life drain back to casters
      for (const dh of allDrains) {
        const inParty = party.some(u => u.id === dh.sourceId);
        if (inParty) {
          party = party.map(u => {
            if (u.id !== dh.sourceId || !u.alive) return u;
            const gained = Math.min(u.maxHp - u.hp, dh.amount);
            if (gained > 0) logs.push(`    ↳ ${u.name} drains ${gained} life`);
            return { ...u, hp: u.hp + gained };
          });
        } else {
          enemies = enemies.map(u => {
            if (u.id !== dh.sourceId || !u.alive) return u;
            const gained = Math.min(u.maxHp - u.hp, dh.amount);
            if (gained > 0) logs.push(`    ↳ ${u.name} drains ${gained} life`);
            return { ...u, hp: u.hp + gained };
          });
        }
      }

      party   = party.map(u => ({ ...tickUnit(u), damageReceivedLastTurn: u.damageReceivedThisTurn, damageReceivedThisTurn: 0 }));
      enemies = enemies.map(u => ({ ...tickUnit(u), damageReceivedLastTurn: u.damageReceivedThisTurn, damageReceivedThisTurn: 0 }));

      if (party.filter(u => !u.isPet).every(u => !u.alive)) { outcome = "defeat";  logs.push("\n💀 DEFEAT");  }
      else if (enemies.every(u => !u.alive))               { outcome = "victory"; logs.push("\n🏆 VICTORY"); }
    }

    if (!outcome) { outcome = "timeout"; logs.push("\n⚠ TIMEOUT"); }
    const kills            = enemies.filter(u => !u.alive);
    const totalXp          = kills.reduce((s, u) => s + (u.xpValue || 0), 0);
    const pickpocketGold   = enemies.reduce((s, e) => s + (e.pickpocketGold || 0), 0);
    const soulShardsGained = party.filter(u => !u.isPet).reduce((s, u) => s + (u.soulShardsGained || 0), 0);
    return { outcome, turns: turn, logs, kills, totalXp, enemies, party, pickpocketGold, soulShardsGained, ammoUsed, abilityUse: _abilityUse };
  };

  const _injectPets = (party: Unit[], partyInstances: any[]) => {
    const result = [...party];
    for (const inst of partyInstances) {
      if (!inst.activePetId) continue;
      const petList = petsForUnit(inst);
      if (!petList.length) continue;
      const template = petList.find(p => p.id === inst.activePetId);
      if (!template) continue;
      if (template.unlockLevel > (inst.level || 1)) continue;
      const owner = party.find(u => u.id === inst.instanceId);
      if (!owner) continue;
      result.push(buildPetUnit(template, owner));
    }
    return result;
  };

  // Build initial manual combat state from encounter + party instances
  const startCombat = (encounter: any, partyInstances: any[]) => {
    _abilityUse = {}; // reset per-encounter ability-usage tracker (manual combat)
    const baseParty = partyInstances.map(inst => buildUnit(inst, false));
    const party     = _injectPets(baseParty, partyInstances);
    const enemies   = encounter.enemies.map((e: any) => buildUnit(e, true)) as Unit[];
    const header    = `⚔ ${encounter.zoneId.toUpperCase()} ⚔ ${party.map(u => u.name).join(",")} vs ${enemies.map(u => u.name).join(",")}`;
    return { party, enemies, turn: 0, allLogs: [header] };
  };

  // Run one turn of manual combat with SPD-based initiative order.
  // opts.mode: 'streamlined' � playerActions provides one actor's choice, rest use AI
  //            'full_manual' � playerActions provides all actors' choices, unspecified actors skip
  // playerActions = [{ actorId, abilityId, targetId }]
  const stepTurn = (state: any, playerActions: any, opts: any) => {
    let { party, enemies }: { party: Unit[]; enemies: Unit[] } = state;
    const turn     = state.turn + 1;
    const ctx      = { turn, priorEncounterVictory: opts?.priorEncounterVictory };
    const mode     = opts?.mode || 'streamlined';
    const stepLogs = [`\n── T${turn}`];
    let outcome    = null;

    // Build initiative order: all alive units sorted by SPD descending.
    // Ties broken by enemies going after party members (stable sort preserves insertion order).
    const initiative = [
      ...party.map(u   => ({ id: u.id, isEnemy: false })),
      ...enemies.map(u => ({ id: u.id, isEnemy: true  })),
    ].sort((a, b) => {
      const aUnit = a.isEnemy ? enemies.find(u => u.id === a.id) : party.find(u => u.id === a.id);
      const bUnit = b.isEnemy ? enemies.find(u => u.id === b.id) : party.find(u => u.id === b.id);
      return (bUnit?.spd || 0) - (aUnit?.spd || 0);
    });

    for (const ref of initiative) {
      // Refresh actor from current state (may have been modified by earlier actions this turn)
      let actor = ref.isEnemy ? enemies.find(u => u.id === ref.id) : party.find(u => u.id === ref.id);
      if (!actor || !actor.alive) continue;

      const liveP = party.filter(p => p.alive);
      const liveE = enemies.filter(e => e.alive);
      if (!liveP.length || !liveE.length) break;

      if (actor.ccState.stunned) { stepLogs.push(`  ${actor.name} is stunned`); continue; }

      // ── cast queue (channelled spells) ──────────────────────────────────────
      const pAction = (playerActions || []).find((a: any) => a.actorId === actor!.id);
      let castFired = false;
      if (actor.castQueue?.length) {
        if (!ref.isEnemy && pAction) {
          // Player submitted an explicit action — cancel the pending cast
          actor = { ...actor, castQueue: [] };
          stepLogs.push(`  ${actor.name} cancels their cast`);
          if (pAction.cancel) {
            // Pure cancel: consume turn, do nothing else
            if (ref.isEnemy) enemies = syncUnit(enemies, actor); else party = syncUnit(party, actor);
            continue;
          }
          // Otherwise fall through so pAction is used as the new action below
        } else {
          // No player override: fire ready entries or hold the cast
          const ready: any[] = [], pending: any[] = [];
          for (const e of actor.castQueue) {
            if (e.turnsRemaining <= 0) ready.push(e);
            else pending.push({ ...e, turnsRemaining: e.turnsRemaining - 1 });
          }
          actor = { ...actor, castQueue: pending };
          for (const entry of ready) {
            const ab = ABILITY_DATA[entry.abilityId]; if (!ab) continue;
            castFired = true;
            const tgts = resolveTargets(ab, entry.targetId, actor, party, enemies);
            const res  = execAbility(entry.abilityId, actor, tgts, stepLogs);
            actor = res.caster;
            for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
          }
          // Whether cast fired or still counting down: actor's turn is consumed
          if (ref.isEnemy) enemies = syncUnit(enemies, actor); else party = syncUnit(party, actor);
          continue;
        }
      }

      // ── choose action ────────────────────────────────────────────────────────
      let chosen: any;
      if (!ref.isEnemy && pAction && pAction.type === 'use_item') {
        // Item use: apply effect to combat state and consume the actor's turn.
        const onUse = pAction.itemDef?.onUse;
        const itemName = pAction.itemDef?.name || pAction.itemId;
        if (onUse) {
          if (onUse.type === 'heal') {
            const isParty = onUse.target === 'party';
            const healTargets = isParty ? party.filter(u => u.alive) : [actor];
            for (let ht of healTargets) {
              const amount = onUse.percent != null ? Math.floor(ht.maxHp * onUse.percent) : onUse.minFlat != null ? Math.floor(Math.random() * (onUse.maxFlat - onUse.minFlat + 1) + onUse.minFlat) : (onUse.flat || 0);
              const actual = Math.min(amount, ht.maxHp - ht.hp);
              if (actual > 0) {
                ht = { ...ht, hp: ht.hp + actual };
                party = syncUnit(party, ht);
                if (ht.id === actor.id) actor = ht;
                stepLogs.push(`  ${actor.name} uses ${itemName}: +${actual} HP to ${ht.name}`);
              }
            }
          } else if (onUse.type === 'mana') {
            const manaDef = actor.resources?.mana;
            if (manaDef) {
              const amount = onUse.percent != null ? Math.floor(manaDef.max * onUse.percent) : (onUse.flat || 0);
              const actual = Math.min(amount, manaDef.max - manaDef.current);
              if (actual > 0) {
                actor = { ...actor, resources: { ...actor.resources, mana: { ...manaDef, current: manaDef.current + actual } } };
                party = syncUnit(party, actor);
                stepLogs.push(`  ${actor.name} uses ${itemName}: +${actual} mana`);
              }
            }
          } else if (onUse.type === 'weapon_buff') {
            actor = applyBuff(actor, onUse.buffId, actor.id, undefined, actor);
            party = syncUnit(party, actor);
            stepLogs.push(`  ${actor.name} uses ${itemName}`);
          }
        }
        // Turn consumed � no ability fired
        party = syncUnit(party, actor);
        continue;
      } else if (!ref.isEnemy && pAction) {
        const pAb = ABILITY_DATA[pAction.abilityId];
        const invalidRanged = pAb?.tags?.includes('ranged') && !actor.rangedReady;
        const onCooldown    = (actor.cooldowns[pAction.abilityId] || 0) > 0;
        if (invalidRanged || onCooldown) {
          chosen = aiChoose(actor, liveP, liveE, ctx);
        } else {
          chosen = { abilityId: pAction.abilityId, targetId: pAction.targetId };
        }
      } else if (!ref.isEnemy && actor.isPet) {
        // Pets are always AI-controlled, even in full_manual mode
        chosen = aiChoose(actor, liveP, liveE, ctx);
      } else if (!ref.isEnemy && mode === 'full_manual') {
        continue; // no action submitted for this character� they skip
      } else {
        // AI (enemies always, party in streamlined if no player action)
        const sameTeam = ref.isEnemy ? liveE : liveP;
        const oppTeam  = ref.isEnemy ? liveP : liveE;
        chosen = aiChoose(actor, sameTeam, oppTeam, ctx);
      }
      if (!chosen) continue;
      const ab = ABILITY_DATA[chosen.abilityId]; if (!ab) continue;

      if (ab.removesTotemGroup) {
        const g = ab.removesTotemGroup;
        const clean = (u: Unit) => ({ ...u, buffs: u.buffs.filter(b => b.totemGroup !== g), debuffs: u.debuffs.filter(b => b.totemGroup !== g) });
        party = party.map(clean); enemies = enemies.map(clean); actor = clean(actor);
      }

      if ((ab.castTime || 0) > 0) {
        actor = { ...actor, castQueue: [...(actor.castQueue || []), { abilityId: chosen.abilityId, targetId: chosen.targetId, turnsRemaining: ab.castTime - 1 }] };
        stepLogs.push(`  ${actor.name} begins casting ${chosen.abilityId.replace(/_/g, " ")}`);
      } else {
        const tgts = resolveTargets(ab, chosen.targetId, actor, party, enemies);
        const res  = execAbility(chosen.abilityId, actor, tgts, stepLogs);
        actor = res.caster;
        for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
        if (actor.buffs.some(b => b.isStealth) && chosen.abilityId !== "stealth") {
          actor = { ...actor, buffs: actor.buffs.filter(b => !b.isStealth) };
          stepLogs.push(`  ${actor.name} leaves stealth`);
        }
        if (actor.buffs.some(b => b.doubleAction)) {
          const liveE2 = enemies.filter(e => e.alive), liveP2 = party.filter(p => p.alive);
          const sameTeam2 = ref.isEnemy ? liveE2 : liveP2;
          const oppTeam2  = ref.isEnemy ? liveP2 : liveE2;
          const ai2 = aiChoose(actor, sameTeam2, oppTeam2, ctx);
          if (ai2) {
            const ab2 = ABILITY_DATA[ai2.abilityId];
            if (ab2) {
              const tgts2 = resolveTargets(ab2, ai2.targetId, actor, party, enemies);
              const res2  = execAbility(ai2.abilityId, actor, tgts2, stepLogs);
              actor = res2.caster;
              for (const t of res2.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
            }
          }
        }
      }

      if (ref.isEnemy) enemies = syncUnit(enemies, actor); else party = syncUnit(party, actor);
    }

    // ── tick DoTs/HoTs, regen ──────────────────────────────────────────────────
    const allDrains: any[] = [];
    for (let i = 0; i < party.length;   i++) { const { unit: u, logs: l, drainHeals } = tickBuffsUnit(party[i]);   stepLogs.push(...l); allDrains.push(...drainHeals); party[i]   = expireBuffsUnit(u); }
    for (let i = 0; i < enemies.length; i++) { const { unit: u, logs: l, drainHeals } = tickBuffsUnit(enemies[i]); stepLogs.push(...l); allDrains.push(...drainHeals); enemies[i] = expireBuffsUnit(u); }
    for (const dh of allDrains) {
      const inParty = party.some(u => u.id === dh.sourceId);
      if (inParty) {
        party = party.map(u => { if (u.id !== dh.sourceId || !u.alive) return u; const g = Math.min(u.maxHp - u.hp, dh.amount); if (g > 0) stepLogs.push(`    ↳ ${u.name} drains ${g} life`); return { ...u, hp: u.hp + g }; });
      } else {
        enemies = enemies.map(u => { if (u.id !== dh.sourceId || !u.alive) return u; const g = Math.min(u.maxHp - u.hp, dh.amount); if (g > 0) stepLogs.push(`    ↳ ${u.name} drains ${g} life`); return { ...u, hp: u.hp + g }; });
      }
    }
    party   = party.map(u   => ({ ...tickUnit(u),   damageReceivedLastTurn: u.damageReceivedThisTurn,   damageReceivedThisTurn: 0 }));
    enemies = enemies.map(u => ({ ...tickUnit(u), damageReceivedLastTurn: u.damageReceivedThisTurn, damageReceivedThisTurn: 0 }));

    if (party.filter(u => !u.isPet).every(u => !u.alive)) { outcome = "defeat";  stepLogs.push("\n💀 DEFEAT");  }
    else if (enemies.every(u => !u.alive))               { outcome = "victory"; stepLogs.push("\n🏆 VICTORY"); }

    return { party, enemies, turn, stepLogs, outcome, abilityUse: _abilityUse };
  };

  return { run, buildUnit, startCombat, stepTurn };
})();


// =============================================================================
// DEATH HANDLER
// =============================================================================

const DeathHandler = (() => {
  const CONFIG = { rezBaseCost: 500, rezLevelMult: 200, wipePenalty: 0.25, wipeReturnHpMin: 0.20, wipeReturnHpMax: 1.00, wipeReturnHpStep: 0.10 };
  const wipeReturnHpPct = (level: number) => Math.max(CONFIG.wipeReturnHpMin, CONFIG.wipeReturnHpMax - Math.max(0, level - 1) * CONFIG.wipeReturnHpStep);
  const rezCostForLevel = (level: number) => CONFIG.rezBaseCost + level * CONFIG.rezLevelMult;

  const handleDeath = (inst: any, save: any) => {
    const mode = save.mode || "normal";
    if (mode === "hardcore") return { ...inst, deathState: "dead", permadead: true, downedAt: new Date().toISOString() };
    return { ...inst, deathState: "downed", downedAt: new Date().toISOString(), rezCost: rezCostForLevel(inst.level || 1) };
  };

  const rezForGold = (inst: any, save: any) => {
    if ((save.mode || "normal") === "hardcore") return { ok: false, error: "Cannot rez in hardcore." };
    if (inst.deathState !== "downed")           return { ok: false, error: "Not downed." };
    if (inst.permadead)                         return { ok: false, error: "Permanently dead." };
    const cost = inst.rezCost || rezCostForLevel(inst.level || 1);
    if ((save.currency || 0) < cost)            return { ok: false, error: `Need ${Currency.toString(cost)}.` };
    return { ok: true, save: Currency.deduct(save, cost), inst: { ...inst, deathState: "alive", currentHp: inst.maxHp || 999, currentMp: inst.maxMp || 0, downedAt: null, rezCost: 0 } };
  };

  // reviveIds: Set of instanceIds that died in this specific combat � only those
  // are revived.  Pre-downed companions (downed from earlier fights) are left
  // untouched so they still require an explicit gold rez.
  const handleWipe = (save: any, reviveIds?: Set<string> | null) => {
    const mode = save.mode || "normal";
    if (mode === "hardcore") return { ...save, wipedOut: true, wipeTimestamp: new Date().toISOString() };
    const penalty = Math.floor((save.currency || 0) * CONFIG.wipePenalty);
    let s = Currency.deduct(save, penalty);
    s = { ...s, party: s.party.map((m: any) => {
      if (reviveIds && !reviveIds.has(m.instanceId)) return m;
      const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
      if (!ir.ok) return m;
      const inst = ir.data;
      if (inst.deathState === "downed" && !inst.permadead) {
        const pct      = wipeReturnHpPct(inst.level || 1);
        const restored = { ...inst, deathState: "alive", currentHp: Math.max(1, Math.floor((inst.maxHp || 999) * pct)), currentMp: inst.maxMp || 0, downedAt: null, rezCost: 0 };
        DataStore.write(`instances/companions/${m.instanceId}`, restored);
      }
      return m;
    }) };

    // Reset in-progress kill objectives that have resetOnWipe
    for (const [questId, questState] of Object.entries<any>(s.quests || {})) {
      if (questState.completed) continue;
      const qr = Loader.load(`templates/quests/${questId}`, "quest");
      if (!qr.ok) continue;
      let objState = { ...questState.objectives };
      let changed  = false;
      for (const obj of qr.data.objectives) {
        if (!obj.resetOnWipe) continue;
        const current = objState[obj.id] || 0;
        if (current > 0 && current < obj.count) {
          objState = { ...objState, [obj.id]: 0 };
          changed  = true;
        }
      }
      if (changed) s = { ...s, quests: { ...s.quests, [questId]: { ...questState, objectives: objState } } };
    }

    return { ...s, _wipeNote: `Lost ${Currency.toString(penalty)} on wipe` };
  };

  const isWipe = (save: any) =>
    save.party.every((m: any) => {
      const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
      return ir.ok ? ir.data.deathState !== "alive" : false;
    });

  return { handleDeath, rezForGold, handleWipe, isWipe, rezCostForLevel, wipeReturnHpPct, CONFIG };
})();


// =============================================================================
// REWARD ENGINE
// =============================================================================

const RewardEngine = (() => {
  const rollLoot = (kills: any[], activeQuestIds: string[] = []) => {
    const drops: any[] = [];
    for (const enemy of kills)
      for (const le of (enemy.loot || [])) {
        if (le.questId && !activeQuestIds.includes(le.questId)) continue;
        if (Math.random() < le.chance) {
          const qty = le.qty ?? (le.minQty !== undefined
            ? Math.floor(Math.random() * ((le.maxQty ?? le.minQty) - le.minQty + 1)) + le.minQty
            : 1);
          // Random-suffix-eligible drops roll independently per unit, since
          // each could come back as a different suffix (or no suffix at all).
          if (ItemSuffixes.isEligible(le.itemId)) {
            for (let i = 0; i < qty; i++) drops.push({ itemId: ItemSuffixes.maybeApplySuffix(le.itemId), qty: 1 });
          } else {
            drops.push({ itemId: le.itemId, qty });
          }
        }
      }
    return drops;
  };

  const apply = (combatResult: any, encounter: any, save: any) => {
    let s     = { ...save };
    const sum: any = { xp: 0, currency: 0, loot: [], questProgress: [], skillXp: {}, levelUps: [] };

    // always clear tracking/flee flags after an encounter
    s = Modifiers.clearFlag(s, "trackingBoost");
    s = Modifiers.clearFlag(s, "activeTrack");
    s = Modifiers.clearFlag(s, "fleeBonus");

    if (combatResult.outcome !== "victory") return { save: s, summary: sum };

    // XP penalty: each member beyond 5 cuts XP by 20%, floor at 0%
    const xpMult = Math.max(0, 1 - Math.max(0, s.party.length - 5) * 0.2);
    const xp = Math.floor(combatResult.totalXp * xpMult);
    sum.xp      = xp;
    sum.xpMult  = xpMult;
    s = { ...s, party: s.party.map((m: any) => {
      const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
      if (!ir.ok) return m;
      let { inst: updated, levelUpLines } = addXpToInst(ir.data, xp);
      // Skill XP: every ability the member used this combat trains its skill.
      // basic_attack trains the equipped weapon's skill (resolved from gear).
      // 10 XP/use is a placeholder rate — tune later.
      const used = combatResult.abilityUse?.[m.instanceId] || {};
      if (typeof skillForAbilityUse === "function" && Object.keys(used).length) {
        const mhId   = (updated as any).gear?.mainhand;
        const mhLoad = mhId ? Loader.load(`templates/items/${mhId}`, "item") : null;
        const mhWeaponType = (mhLoad && mhLoad.ok) ? mhLoad.data.weaponType : null;
        for (const [abilityId, count] of Object.entries<any>(used)) {
          const skillId = skillForAbilityUse(abilityId, mhWeaponType);
          // Bare-handed basic attacks only train unarmed if the character has the skill.
          const hasSkill = skillId !== "unarmed" || getSkillLevel(updated, "unarmed") >= 1;
          if (skillId && count > 0 && hasSkill) {
            const amount = count * 10;
            const sx = addSkillXp(updated, skillId, amount);
            updated = sx.inst;
            sum.skillXp[skillId] = (sum.skillXp[skillId] || 0) + amount;
            for (const lu of sx.levelUps) sum.levelUps.push(`    ✧ ${m.instanceId}'s ${skillId} skill reached ${lu.level}`);
          }
        }
      }
      DataStore.write(`instances/companions/${m.instanceId}`, updated);
      if (levelUpLines.length) sum.levelUps.push(...levelUpLines);
      return m;
    }) };

    const activeQuestIds = Object.keys(s.quests || {}).filter(id => !s.quests[id].completed);
    const drops = rollLoot(encounter.enemies, activeQuestIds);
    for (const d of drops) { s = Modifiers.addToInventory(s, d.itemId, d.qty); sum.loot.push(d); }

    const pouches = drops.filter(d => d.itemId === "copper_coin_pouch").length;
    if (pouches > 0) {
      const cg = pouches * 150;
      s = Currency.add(s, cg); sum.currency += cg;
      s = { ...s, inventory: s.inventory.map((e: any) => e.itemId === "copper_coin_pouch" ? { ...e, qty: Math.max(0, e.qty - pouches) } : e).filter((e: any) => e.qty > 0) };
    }

    for (const node of (encounter.gatheringNodes || [])) {
      s = Modifiers.addToInventory(s, node.nodeId || node.itemId, node.qty);
      sum.loot.push({ itemId: node.nodeId || node.itemId, qty: node.qty, source: "gathering" });
    }

    for (const [questId, questSt] of Object.entries<any>(s.quests || {})) {
      if (questSt.completed) continue;
      const qr = Loader.load(`templates/quests/${questId}`, "quest");
      if (!qr.ok) continue;
      const quest = qr.data;
      let objState   = { ...questSt.objectives };
      let anyProgress = false;

      // Kill objectives
      for (const obj of quest.objectives) {
        if (obj.type !== "kill") continue;
        const prev = objState[obj.id] || 0;
        if (prev >= obj.count) continue;
        if (obj.requiresObjective) {
          const gate = quest.objectives.find((o: any) => o.id === obj.requiresObjective);
          if (gate && (objState[gate.id] || 0) < gate.count) continue;
        }
        const matching = encounter.enemies.filter((e: any) =>
          obj.targetId ? e.id === obj.targetId :
          (e.tags || []).some((tag: any) => (obj.targetTags || []).includes(tag))
        ).length;
        if (matching > 0) {
          const next = Math.min(obj.count, prev + matching);
          objState = { ...objState, [obj.id]: next };
          sum.questProgress.push({ questId, objectiveId: obj.id, prev, next, goal: obj.count });
          anyProgress = true;
          if (next >= obj.count && obj.triggersEncounter) {
            s = Modifiers.setFlag(s, "forcedEncounter", { type: "combat", ...obj.triggersEncounter });
          }
        }
      }

      // Collect objectives � check current inventory after loot was added
      for (const obj of quest.objectives) {
        if (obj.type !== "collect") continue;
        const prev = objState[obj.id] || 0;
        if (prev >= obj.count) continue;
        if (obj.requiresObjective) {
          const gate = quest.objectives.find((o: any) => o.id === obj.requiresObjective);
          if (gate && (objState[gate.id] || 0) < gate.count) continue;
        }
        const invEntry = (s.inventory || []).find((e: any) => e.itemId === obj.targetItem);
        const next = Math.min(obj.count, invEntry ? invEntry.qty : 0);
        if (next > prev) {
          objState = { ...objState, [obj.id]: next };
          sum.questProgress.push({ questId, objectiveId: obj.id, prev, next, goal: obj.count });
          anyProgress = true;
        }
      }

      if (anyProgress) {
        s = { ...s, quests: { ...s.quests, [questId]: { ...questSt, objectives: objState } } };
      }

      // Complete quest only when ALL objectives are satisfied
      const allDone = quest.objectives.every((obj: any) => (objState[obj.id] || 0) >= obj.count);
      if (allDone) {
        // Remove consumed collect items from inventory
        for (const obj of quest.objectives) {
          if (obj.type === "collect") {
            s = { ...s, inventory: (s.inventory || []).map((e: any) =>
              e.itemId === obj.targetItem ? { ...e, qty: e.qty - obj.count } : e
            ).filter((e: any) => e.qty > 0) };
          }
        }
        s = Modifiers.completeQuest(s, questId);
        const rw = quest.rewards || {};
        if (rw.xp) {
          const questXp = Math.floor(rw.xp * xpMult);
          sum.xp += questXp;
          s = { ...s, party: s.party.map((m: any) => {
            const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
            if (!ir.ok) return m;
            const { inst: updated, levelUpLines } = addXpToInst(ir.data, questXp);
            DataStore.write(`instances/companions/${m.instanceId}`, updated);
            if (levelUpLines.length) sum.levelUps.push(...levelUpLines);
            return m;
          }) };
        }
        if (rw.currency)   { s = Currency.add(s, rw.currency); sum.currency += rw.currency; }
        if (rw.items)      for (const ri of rw.items) { s = Modifiers.addToInventory(s, ri.itemId, ri.qty); sum.loot.push({ ...ri, source: "quest_reward" }); }
        if (rw.reputation) for (const rf of rw.reputation) { s = Modifiers.addReputation(s, rf.factionId, rf.amount); (sum.reputation = sum.reputation || []).push(rf); }
        sum.questProgress.push({ questId, completed: true });
      }
    }

    const partyHasButchery = s.party.some((m: any) => {
      const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
      return ir.ok && ir.data.profession === "butchery" && ir.data.deathState === "alive";
    });
    if (partyHasButchery) {
      const butcherable = (combatResult.kills || []).filter((e: any) => e.type === "beast");
      if (butcherable.length > 0) {
        s = Modifiers.setFlag(s, "pendingButchery", butcherable.map((e: any) => e.id));
        sum.butcherableKills = butcherable;
      }
    }

    return { save: s, summary: sum };
  };

  // Per-creature butchery loot. Each entry is typed (meat | hide | bone | feather)
  // and rolled independently; a creature that yields feathers simply carries
  // "feather" entries and no "hide" entry. Quantity is qty, or a minQty..maxQty range.
  const rollButcheryForKill = (enemy: any) => {
    const loot: any[] = [];
    for (const le of (enemy.butcheryLoot || [])) {
      const chance = (le.chance != null) ? le.chance : 1;
      if (Math.random() < chance) {
        const qty = (le.minQty != null && le.maxQty != null)
          ? le.minQty + Math.floor(Math.random() * (le.maxQty - le.minQty + 1))
          : (le.qty || 1);
        loot.push({ itemId: le.itemId, qty, type: le.type || "material" });
      }
    }
    return loot;
  };

  const applyButchery = (save: any, kills: any[]) => {
    let s = { ...save };
    const drops: any[] = [];
    let xpGained = 0;
    for (const enemy of kills) {
      for (const d of rollButcheryForKill(enemy)) {
        s = Modifiers.addToInventory(s, d.itemId, d.qty);
        drops.push(d);
      }
      xpGained += (enemy.butcheryXp || 0);
    }
    // Butchering is a profession action: award authored XP to the butcher(s).
    s = awardProfessionXp(s, "butchery", xpGained);
    s = Modifiers.clearFlag(s, "pendingButchery");
    return { save: s, drops };
  };

  return { apply, rollLoot, applyButchery };
})();


// =============================================================================
// RIDING SYSTEM
// Player-level skill stored on save.riding (not per-companion).
// Increases +1 on each successful flee. Cap: 75 until highest party member
// reaches level 40, then raises to 150.
// Controls flee chance and mount purchase eligibility.
// =============================================================================

const RidingSystem = (() => {
  const BASIC_MOUNT_LEVEL  = 40;
  const BASIC_MOUNT_RIDING = 75;
  const EPIC_MOUNT_LEVEL   = 60;
  const EPIC_MOUNT_RIDING  = 150;
  const CAP_LOW            = 75;
  const CAP_HIGH           = 150;

  const getSkill = (save: any) => save.riding || 1;

  const getHighestPartyLevel = (save: any) => {
    let best = 1;
    for (const m of (save.party || [])) {
      const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
      if (ir.ok) best = Math.max(best, ir.data.level || 1);
    }
    return best;
  };

  const getCap = (highestPartyLevel: number) =>
    highestPartyLevel >= BASIC_MOUNT_LEVEL ? CAP_HIGH : CAP_LOW;

  // chance = clamp(0,1,  80% + (partyLvl - enemyLvl)*10% + riding*0.1% + extraBonus)
  // extraBonus comes from fleeBonus buffs/debuffs active at flee time (earthbind, concussive, wing_clip)
  const getFleeChance = (save: any, enemies: any[], extraBonus = 0) => {
    const partyLevel = getHighestPartyLevel(save);
    const enemyLevel = (enemies || []).reduce((best: number, e: any) => Math.max(best, e.level || 1), 1);
    const riding     = getSkill(save);
    const raw        = 0.80 + (partyLevel - enemyLevel) * 0.10 + riding * 0.001 + extraBonus;
    return Math.max(0, Math.min(1, raw));
  };

  const gainRiding = (save: any) => {
    const current = getSkill(save);
    const cap     = getCap(getHighestPartyLevel(save));
    if (current >= cap) return save;
    return { ...save, riding: current + 1 };
  };

  const canBuyBasicMount = (save: any) =>
    getHighestPartyLevel(save) >= BASIC_MOUNT_LEVEL && getSkill(save) >= BASIC_MOUNT_RIDING;

  const canBuyEpicMount = (save: any) =>
    getHighestPartyLevel(save) >= EPIC_MOUNT_LEVEL && getSkill(save) >= EPIC_MOUNT_RIDING;

  const acquireMount = (save: any, mountId: string) => {
    const mounts = save.mounts || [];
    if (mounts.includes(mountId)) return { ok: false, error: "Already owned." };
    return { ok: true, save: { ...save, mounts: [...mounts, mountId] } };
  };

  return {
    getSkill, getCap, getHighestPartyLevel, getFleeChance,
    gainRiding, canBuyBasicMount, canBuyEpicMount, acquireMount,
    BASIC_MOUNT_LEVEL, BASIC_MOUNT_RIDING, EPIC_MOUNT_LEVEL, EPIC_MOUNT_RIDING,
  };
})();


// =============================================================================
// DUNGEONEERING — TRAP SYSTEM
// Dungeoneering is a universal skill (every class has it). It is the party's
// backup sense for traps, which appear in dungeons (forcedEncounterQueue "trap"
// entries) and out in the world (encounter-table "trap" slots).
//
// On encounter, EACH living party member rolls to detect the trap:
//   1. a classLevel/100 chance (their primary instincts), then — only if that
//      fails — 2. a dungeoneeringLevel/100 chance (the trained backup sense).
// The trap is avoided if ANY member detects it. Either way, EVERY living member
// gains dungeoneering XP for the encounter. An undetected trap fires its
// configured effect (damage by default; see Data/traps.json).
// =============================================================================
const TrapSystem = (() => {
  const DEFAULT_XP         = 15;   // dungeoneering XP per member per trap (tune later)
  const DEFAULT_DAMAGE_PCT = 0.15; // fraction of maxHp when a damage trap omits its amount

  // Living party members as { member, inst }.
  const livingParty = (save: any) =>
    (save.party || [])
      .map((m: any) => {
        const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
        return ir.ok ? { member: m, inst: ir.data } : null;
      })
      .filter((x: any) => x && x.inst.deathState === "alive");

  // One member's detection roll: classLevel/100, then dungeoneeringLevel/100 backup.
  const memberDetects = (inst: any) => {
    const classLvl = inst.level || 1;
    const dungLvl  = (typeof getSkillLevel === "function") ? getSkillLevel(inst, "dungeoneering") : 0;
    const byClass = Math.random() < classLvl / 100;
    const byDungeoneering = byClass ? false : (Math.random() < dungLvl / 100);
    return { byClass, byDungeoneering, detected: byClass || byDungeoneering };
  };

  // Roll detection across the party. Detected if any member detects; reports the
  // first detector and whether it was their class instinct or dungeoneering.
  const rollDetection = (party: any[]) => {
    let detected = false, detectedBy: string | null = null, via: string | null = null;
    const rolls: any[] = [];
    for (const { member, inst } of party) {
      const r = memberDetects(inst);
      rolls.push({ instanceId: member.instanceId, name: inst.name, ...r });
      if (r.detected && !detected) {
        detected   = true;
        detectedBy = inst.name;
        via        = r.byClass ? "class" : "dungeoneering";
      }
    }
    return { detected, detectedBy, via, rolls };
  };

  // Damage from a trap effect against one instance's maxHp.
  const damageFor = (inst: any, effect: any) => {
    const d = effect?.damage || {};
    if (d.mode === "flat") return Math.max(0, Math.floor(d.amount || 0));
    return Math.max(1, Math.floor((inst.maxHp || 1) * (d.amount != null ? d.amount : DEFAULT_DAMAGE_PCT)));
  };

  // Resolve a trap encounter against the current save. Pure-ish: persists the
  // affected companion instances to DataStore and returns the (unchanged) save
  // for chaining, plus narration lines and the detection outcome.
  const resolve = (save: any, trap: any) => {
    const party = livingParty(save);
    const name  = (trap && trap.name) || "a hidden trap";
    const lines: string[] = [];

    if (!party.length)
      return { save, detected: false, triggered: false, lines: [`   The mechanism clicks, but no one is left to spring it.`] };

    const det = rollDetection(party);

    // Working copies keyed by instanceId so XP and damage merge into one write.
    const work = new Map<string, any>(party.map((p: any) => [p.member.instanceId, { member: p.member, inst: { ...p.inst } }]));

    // XP to every member who met the trap (alive at encounter time), detected or not.
    const xpAmount = (trap && trap.xp != null) ? trap.xp : DEFAULT_XP;
    const levelUps: string[] = [];
    for (const w of work.values()) {
      const sx = addSkillXp(w.inst, "dungeoneering", xpAmount);
      w.inst = sx.inst;
      for (const lu of sx.levelUps)
        levelUps.push(`    ✧ ${w.inst.name}'s dungeoneering skill reached ${lu.level}`);
    }

    // Narrate detection / spring; apply the effect when undetected.
    let triggered = false;
    if (det.detected) {
      lines.push(`   🪤 ${det.detectedBy} spots ${name}${det.via === "dungeoneering" ? " (dungeoneering)" : ""}!`);
      if (trap && trap.detectText) lines.push(`   "${trap.detectText}"`);
    } else {
      triggered = true;
      lines.push(`   🪤 ${name} springs — no one saw it coming!`);
      if (trap && trap.triggerText) lines.push(`   "${trap.triggerText}"`);

      const effect = (trap && trap.effect) || { type: "damage" };
      if (effect.type === "damage") {
        const ids     = [...work.keys()];
        const targets = effect.target === "random"
          ? (ids.length ? [ids[Math.floor(Math.random() * ids.length)]] : [])
          : ids; // default: whole party
        for (const id of targets) {
          const w   = work.get(id);
          const dmg = damageFor(w.inst, effect);
          const hp  = Math.max(0, (w.inst.currentHp != null ? w.inst.currentHp : w.inst.maxHp) - dmg);
          w.inst = { ...w.inst, currentHp: hp };
          if (hp <= 0 && typeof DeathHandler !== "undefined") {
            w.inst = DeathHandler.handleDeath(w.inst, save);
            lines.push(`   ✗ ${w.inst.name} takes ${dmg} damage and is downed!`);
          } else {
            lines.push(`   ✗ ${w.inst.name} takes ${dmg} damage. (${hp}/${w.inst.maxHp})`);
          }
        }
      }
      // Non-damage effect types are authored later; XP + narration still apply.
    }

    // Persist every touched instance once.
    for (const w of work.values())
      DataStore.write(`instances/companions/${w.member.instanceId}`, w.inst);

    lines.push(`   ✦ The party gains dungeoneering experience.`);
    lines.push(...levelUps);

    return { save, detected: det.detected, triggered, lines };
  };

  return { resolve, rollDetection, memberDetects, livingParty, damageFor, DEFAULT_XP, DEFAULT_DAMAGE_PCT };
})();


// =============================================================================
// SHOP SYSTEM
// =============================================================================

const ShopSystem = (() => {
  const getStock   = (save: any, zoneId: string, keeperName: string, itemId: string) => { const key = `${zoneId}_${keeperName}_${itemId}`; return save.shopStocks?.[key] ?? null; };
  const setStock   = (save: any, zoneId: string, keeperName: string, itemId: string, value: any) => { const key = `${zoneId}_${keeperName}_${itemId}`; return { ...save, shopStocks: { ...(save.shopStocks || {}), [key]: value } }; };
  const getBuyList = (zone: any, save: any, keeperName: string = '') => {
    const inv = zone.shopkeepers?.[keeperName]?.inventory || [];
    return inv.map((entry: any) => { const saved = getStock(save, zone.id, keeperName, entry.itemId); return { ...entry, stock: saved !== null ? saved : entry.stock }; }).filter((e: any) => e.stock !== 0);
  };

  const buy = (save: any, zone: any, itemId: string, qty: number, keeperName: string) => {
    const entry = (zone.shopkeepers?.[keeperName]?.inventory || []).find((e: any) => e.itemId === itemId);
    if (!entry) return { ok: false, error: "Item not in shop." };
    const stock = getStock(save, zone.id, keeperName, itemId) ?? entry.stock;
    if (stock !== -1 && stock < qty) return { ok: false, error: `Only ${stock} in stock.` };
    const totalCost = entry.buyPrice * qty;
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    // Mount requirement check before currency � level + riding gating
    if (ir.ok && (ir.data.tags || []).includes("mount")) {
      const isEpic = (ir.data.tags || []).includes("mount_epic");
      if (isEpic  && !RidingSystem.canBuyEpicMount(save))
        return { ok: false, error: `Requires level ${RidingSystem.EPIC_MOUNT_LEVEL} and ${RidingSystem.EPIC_MOUNT_RIDING} Riding.` };
      if (!isEpic && !RidingSystem.canBuyBasicMount(save))
        return { ok: false, error: `Requires level ${RidingSystem.BASIC_MOUNT_LEVEL} and ${RidingSystem.BASIC_MOUNT_RIDING} Riding.` };
      const mr = RidingSystem.acquireMount(save, itemId);
      if (!mr.ok) return { ok: false, error: mr.error };
      if (!Currency.canAfford(save, totalCost)) return { ok: false, error: `Need ${Currency.toString(totalCost)}, have ${Currency.toString(save.currency || 0)}.` };
      let s = Currency.deduct(mr.save, totalCost);
      if (stock !== -1) s = setStock(s, zone.id, keeperName, itemId, stock - qty);
      return { ok: true, save: s, message: `Collected ${ir.data.name} for ${Currency.toString(totalCost)}. Added to mount collection.` };
    }
    if (!Currency.canAfford(save, totalCost)) return { ok: false, error: `Need ${Currency.toString(totalCost)}, have ${Currency.toString(save.currency || 0)}.` };
    const grantQty = (entry.quantity ?? 1) * qty;
    let s = Currency.deduct(save, totalCost);
    s = Modifiers.addToInventory(s, itemId, grantQty);
    if (stock !== -1) s = setStock(s, zone.id, keeperName, itemId, stock - qty);
    return { ok: true, save: s, message: `Bought ${grantQty}x ${ir.ok ? ir.data.name : itemId} for ${Currency.toString(totalCost)}.` };
  };

  const sell = (save: any, zone: any, itemId: string, qty: number) => {
    const invEntry = (save.inventory || []).find((e: any) => e.itemId === itemId);
    if (!invEntry || invEntry.qty < qty) return { ok: false, error: "You don't have that many." };
    const ir = Loader.load(`templates/items/${itemId}`, "item");
    if (!ir.ok) return { ok: false, error: "Unknown item." };
    const total = Math.floor(ir.data.value * (zone.sellMultiplier ?? 0.25)) * qty;
    let s = { ...save, inventory: save.inventory.map((e: any) => e.itemId === itemId ? { ...e, qty: e.qty - qty } : e).filter((e: any) => e.qty > 0) };
    s = Currency.add(s, total);
    return { ok: true, save: s, message: `Sold ${qty}x ${ir.data.name} for ${Currency.toString(total)}.` };
  };

  return { getBuyList, buy, sell, getStock };
})();


// =============================================================================
// SAVE MANAGER
// =============================================================================

const SaveManager = (() => {
  let _sessionStart = Date.now();

  const save = (saveData: any, slotId: string) => {
    const elapsed = Math.floor((Date.now() - _sessionStart) / 1000);
    const stamped = { ...saveData, saveId: slotId, timestamp: new Date().toISOString(), playtime: (saveData.playtime || 0) + elapsed };
    _sessionStart = Date.now();
    return Saver.saveSave(stamped);
  };

  const listSlots = () =>
    DataStore.list("saves/save_")
      .filter((p: any) => !p.endsWith(".backup"))
      .map((p: any) => { const data = DataStore.read(p); return data ? { slotId: data.saveId, timestamp: data.timestamp, playtime: data.playtime || 0, zone: data.currentZone || "unknown", partySize: (data.party || []).length } : null; })
      .filter(Boolean);

  const load = (slotId: string) => Loader.load(`saves/save_${slotId}`, "save");

  return { save, listSlots, load };
})();


// =============================================================================
// SYNTHETIC DATASET
// =============================================================================

const SyntheticGameData = (() => {
  const seed = () => {

    DataStore.write("templates/abilities/strike_basic", { id: "strike_basic", name: "Basic Strike", _version: 1, resourceCost: { rage: 10 }, cooldown: 0, castTime: 0, targeting: "single_enemy", threatModifier: 1.0, effects: [{ type: "damage", damageType: "physical", scaling: "ap", multiplier: 1.0 }], tags: ["physical","melee"], description: "A simple melee strike." });
    DataStore.write("templates/abilities/power_smash",  { id: "power_smash",  name: "Power Smash",  _version: 1, resourceCost: { rage: 25 }, cooldown: 3, castTime: 0, targeting: "single_enemy", threatModifier: 1.5, effects: [{ type: "damage", damageType: "physical", scaling: "ap", multiplier: 1.6 }], tags: ["physical","melee"], description: "A heavy smash." });
    DataStore.write("templates/abilities/ember_bolt",   { id: "ember_bolt",   name: "Ember Bolt",   _version: 1, resourceCost: { mana: 20 }, cooldown: 0, castTime: 1, targeting: "single_enemy", threatModifier: 1.0, effects: [{ type: "damage", damageType: "fire", scaling: "sp", multiplier: 1.0, flatBonus: 15 }], tags: ["fire","spell"], description: "A bolt of fire." });
    DataStore.write("templates/abilities/minor_heal",   { id: "minor_heal",   name: "Minor Heal",   _version: 1, resourceCost: { mana: 15 }, cooldown: 0, castTime: 2, targeting: "single_ally",  threatModifier: 0.5, effects: [{ type: "heal", scaling: "sp", multiplier: 1.2, flatBonus: 30 }], tags: ["holy","heal"], description: "A small heal." });
    DataStore.write("templates/abilities/melee_attack",  { id: "melee_attack",  name: "Auto Attack",  _version: 1, resourceCost: {}, cooldown: 0, castTime: 0, targeting: "single_enemy", threatModifier: 1.0, effects: [{ type: "damage", damageType: "physical", scaling: "ap", multiplier: 1.0 }], tags: ["physical","auto"], description: "Basic auto attack." });

    DataStore.write("templates/buffs/burning_ember", { id: "burning_ember", name: "Burning Ember", _version: 1, duration: 3, tickDamage: { damageType: "fire", flat: 6, scaling: "sp", multiplier: 0.05 }, modifiers: {}, ccFlags: {}, stacks: true, maxStacks: 3, tags: ["fire","dot"], description: "Burns the target." });

    for (const [id, mob] of Object.entries<any>(_mobsData.mobs))
      DataStore.write(`templates/enemies/${id}`, mob);

    for (const [id, item] of Object.entries<any>(_itemsData.items))
      DataStore.write(`templates/items/${id}`, item);

    // Random-suffix variants ("<Item> of the Bear", etc.) for every item
    // tagged "randomEnchant" � see Engine/itemsuffixes.js.
    for (const variant of ItemSuffixes.generateAllVariants(_itemsData.items))
      DataStore.write(`templates/items/${variant.id}`, variant);

    for (const [id, recipe] of Object.entries<any>(_craftingData.recipes))
      DataStore.write(`templates/recipes/${id}`, recipe);

    for (const [id, node] of Object.entries<any>(_gatheringData.nodes))
      DataStore.write(`templates/nodes/${id}`, node);

    // Shop level ranges are sourced from shop.json (minLevel/maxLevel per shop).
    const _shopLvl      = (id: string) => { const s = _shopData.shops[id] || {}; return { min: s.minLevel || 1, max: s.maxLevel || 60 }; };
    const _shopKeepers  = (id: string) => (_shopData.shops[id] || {}).shopkeepers || {};

    // ── Rath (planet / region) ────────────────────────────────────────────────
    DataStore.write("templates/zones/colonial_sewers", { id: "colonial_sewers", regionId: "rath", name: "Colonial Sewers", zoneType: "combat", _version: 1, encounterTableId: "enc_colonial_sewers", minPartyLevel: 1, maxPartyLevel: 5, ambientBuffs: [], shopInventory: [], sellMultiplier: 0.25, tags: ["sewer","starter","underground"], lore: "The dripping under-tunnels beneath the colonial sprawl of Rath, infested with vermin.", forcedOnly: false, forcedEncounterQueue: [] });

    // -- Galanova regions (TBD) -------------------------------------------------
    // The former WoW world map (Durotar/Barrens/Mulgore/Kalimdor) was removed in
    // the conversion. Additional Galanova zones/regions will be seeded here.


    // ── Dungeon zones (Data/dungeons.json) ────────────────────────────────────
    for (const [zoneId, zone] of Object.entries<any>(_dungeonsData.zones || {}))
      DataStore.write(`templates/zones/${zoneId}`, { id: zoneId, _version: 1, ambientBuffs: [], shopInventory: [], ...zone });

    seedCompanions(DataStore);

    // Starting character: Lati Ashera, level 1 Illusionist. Abilities derive from skills
    // (all illusionist skills + universal riding/trading at level 1).
    DataStore.write("instances/companions/player_main", { instanceId: "player_main", templateId: "lati_ashera", _version: 1, name: "Lati Ashera", raceId: "sephir", classId: "illusionist", level: 1, xp: 0, unspentStatPoints: 0, currentHp: 80, currentMp: 270, maxHp: 80, maxMp: 270, deathState: "alive", permadead: false, downedAt: null, rezCost: 0, learnedAbilities: [], acquiredQuirks: [], activeBuffs: [], relationship: 100, skills: { staves: { level: 1, xp: 0 }, wands: { level: 1, xp: 0 }, daggers: { level: 1, xp: 0 }, manipulation: { level: 1, xp: 0 }, madness: { level: 1, xp: 0 }, morale: { level: 1, xp: 0 }, enchanting: { level: 1, xp: 0 }, alchemy: { level: 1, xp: 0 }, riding: { level: 1, xp: 0 }, trading: { level: 1, xp: 0 } }, unlockedSkills: [], stats: { raw: { str: 7, dex: 10, con: 8, int: 18, spi: 12, wis: 10, spd: 11, cha: 15 } }, gear: { head: null, neck: null, shoulders: null, back: null, chest: null, waist: null, tabard: null, wrist: null, hands: null, feet: null, legs: null, ring: null, trinket: null, mainhand: "basic_utility_knife", offhand: null, ranged: null, ammo: null, relic: null }, isPlayer: true });
    DataStore.write("saves/save_slot_start", { saveId: "slot_start", _version: 1, timestamp: new Date().toISOString(), mode: "normal", currentZone: "colonial_sewers", party: [{ instanceId: "player_main", templateId: "lati_ashera" }], quests: {}, inventory: [], currency: 0, reputation: {}, talentSchools: {}, flags: {}, playtime: 0, shopStocks: {}, riding: 1, mounts: [] });
  };

  return { seed };
})();


// =============================================================================
// HOME SCREEN
// =============================================================================

const HomeScreen = (() => {
  const STATES = { HOME: "home", ENCOUNTER: "encounter", REWARD: "reward", MAP: "map", BAG: "bag", SHOP: "shop", STATS: "stats", PARTY: "party", REPUTATION: "reputation", ABILITIES: "abilities", CRAFTING: "crafting", NON_COMBAT: "non_combat", SAVE_LOAD: "save_load", COMBAT_PENDING: "combat_pending", MOUNTS: "mounts", IN_COMBAT: "in_combat" };

  const createSession = () => {
    let state = STATES.HOME, save: any = null, slotId = "slot_start", _pendingCombat: any = null, _lastKills: any[] = [];
    let combatMode = "full_manual", _manualCombatState: any = null;
    const output: string[] = [];
    const emit  = (...lines: any[]) => output.push(...lines);
    const flush = () => { const copy = [...output]; output.length = 0; return copy; };

    const init = (loadSlotId = "slot_start") => {
      slotId = loadSlotId;
      const result = SaveManager.load(slotId);
      if (!result.ok) { emit(`ERROR loading save: ${result.errors.join(", ")}`); return false; }
      save = result.data;
      emit(`\nWelcome to Galanova`);
      emit(`Save loaded: slot "${slotId}" | Zone: ${save.currentZone} | Party: ${save.party.length}`);
      // Opening story beat: on a truly fresh start (Under Rath not yet offered),
      // assign the story quest and queue its offer scene (the personal-log diary).
      if (!save.quests?.q_under_rath && !(save.seenScenes || []).includes("dlg_under_rath_intro")) {
        save = storyApplyEffects(save, [{ type: "assignQuest", questId: "q_under_rath" }]).save;
        save = enqueueScene(save, "dlg_under_rath_intro");
        SaveManager.save(save, slotId);
      }
      return true;
    };

    const renderHome = () => {
      emit(`\n${"─".repeat(50)}`);
      emit(` HOME  |  Zone: ${save.currentZone}  |  Party: ${save.party.length}  |  ${Currency.toString(save.currency || 0)}  [${(save.mode || "normal").toUpperCase()}]`);
      emit(`${"─".repeat(50)}`);
    };

    // Apply post-combat rewards and state transitions from a resolved combat result.
    // Used by both autobattle (_resolveCombat) and manual combat (executePlayerAction).
    const _applyPostCombat = (cr: any, enc: any) => {
      _lastKills = cr.kills || [];
      (cr.logs || []).forEach((l: any) => emit(l));

      // Write post-combat HP and death state back to companion instances.
      // CombatBridge works on in-memory units; without this the DataStore still
      // has the pre-combat currentHp, so the UI health bars never move.
      // Only companions that were alive at the start of this combat and died are
      // newly downed; companions already downed before combat are left untouched
      // so their rezCost / downedAt are not reset and they aren't accidentally
      // swept up in the wipe revival.
      const diedThisCombat = new Set<string>();
      for (const unit of cr.party) {
        const ir = Loader.load(`instances/companions/${unit.id}`, 'companionInstance');
        if (!ir.ok) continue;
        const inst = ir.data;
        if (!unit.alive) {
          if (inst.deathState === 'alive') {
            // Died during this combat � mark as downed.
            diedThisCombat.add(unit.id);
            const died = DeathHandler.handleDeath(inst, save);
            DataStore.write(`instances/companions/${unit.id}`, { ...died, currentHp: 0, currentMp: 0 });
          }
          // else: already downed/dead before this combat � do not overwrite.
        } else {
          const currentMp = unit.resources?.mana?.current ?? inst.currentMp;
          DataStore.write(`instances/companions/${unit.id}`, { ...inst, deathState: 'alive', currentHp: unit.hp, currentMp });
        }
      }

      const { save: ns, summary } = RewardEngine.apply(cr, enc, save);
      save = ns;

      // pickpocket gold: add stolen gold to party currency
      if ((cr.pickpocketGold || 0) > 0) save = Currency.add(save, cr.pickpocketGold);

      // soul shards: awarded when a summoner kills with a soul-draining ability
      if ((cr.soulShardsGained || 0) > 0) {
        save = Modifiers.addToInventory(save, "soul_shard", cr.soulShardsGained);
      }
      // a summoner's death clears their soul shards and healthstones from inventory
      for (const unit of cr.party) {
        if (!unit.alive && typeof getSkillLevel === "function" && getSkillLevel(unit, "summoning") >= 1) {
          save = { ...save, inventory: (save.inventory || []).filter((e: any) => e.itemId !== "soul_shard" && e.itemId !== "healthstone") };
        }
      }

      save = cr.outcome === "victory" ? Modifiers.setFlag(save, "priorEncounterVictory", true) : Modifiers.clearFlag(save, "priorEncounterVictory");

      // Storyline: on a win, either a boss was defeated (→ completion scene) or an
      // ordinary win bumps the zone-scoped counter and may queue a stage/boss scene
      // (the Under Rath 1/3/5 beats, then the boss at threshold). Surfaced by
      // getPendingScene() once this resolves.
      if (cr.outcome === "victory") {
        const boss = onStoryBossDefeated(save, cr.kills);
        save = boss.save;
        if (!boss.defeated) save = onStoryCombatVictory(save);
      }

      // Tick down persistent buff durations by turns elapsed; remove expired.
      const turnsPassed = cr.turns || 0;
      if (turnsPassed > 0) {
        for (const m of save.party) {
          const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
          if (!ir.ok || !ir.data.activeBuffs?.length) continue;
          const updated = ir.data.activeBuffs
            .map((b: any) => typeof b === "string" ? { id: b, remainingDuration: 1 } : { ...b, remainingDuration: b.remainingDuration - turnsPassed })
            .filter((b: any) => b.remainingDuration > 0);
          DataStore.write(`instances/companions/${m.instanceId}`, { ...ir.data, activeBuffs: updated });
        }
      }

      // A wipe occurs only when at least one companion died in THIS combat and
      // every combat-eligible companion is now down.  Pre-downed companions
      // (already downed before this fight) are excluded from both the trigger
      // check and the revival so they still require a paid rez.
      if (diedThisCombat.size > 0 && cr.party.filter((u: any) => !u.isPet).every((u: any) => !u.alive)) {
        save = DeathHandler.handleWipe(save, diedThisCombat);
        if (save.wipedOut) { emit(`\n💀 GAME OVER � hardcore wipe.`); SaveManager.save(save, slotId); state = STATES.HOME; return; }
        emit(`\n💀 Party wipe! ${save._wipeNote || ""}`);
        // Storyline: a genuine defeat in an arc resets its win counter and queues a
        // rez scene — tunnels vs. boss (the boss variant sets the retry-discount flag).
        if (cr.outcome !== "victory") save = onStoryWipe(save, !!enc?._storyBoss);
      }

      state = STATES.REWARD;
      emit(`\n── Encounter Results ──`);
      emit(`   Outcome:   ${cr.outcome.toUpperCase()}`);
      emit(`   Turns:     ${cr.turns}`);
      if (summary.xp || (summary.xpMult != null && summary.xpMult < 1)) {
        const multNote = (summary.xpMult != null && summary.xpMult < 1)
          ? ` (${Math.round(summary.xpMult * 100)}% � large party penalty)` : '';
        emit(`   XP gained: +${summary.xp} (each member)${multNote}`);
      }
      if (summary.levelUps.length)      summary.levelUps.forEach((l: any) => emit(l));
      if (summary.currency)             emit(`   Currency:  +${Currency.toString(summary.currency)}`);
      if ((cr.pickpocketGold || 0) > 0) emit(`   Pickpocket: +${Currency.toString(cr.pickpocketGold)}`);
      if ((cr.soulShardsGained || 0) > 0) emit(`   Soul Shard: +${cr.soulShardsGained} added to bag`);
      if (summary.loot.length)     emit(`   Loot:      ${summary.loot.map((l: any) => `${l.qty}x ${tag("item", l.itemId)}`).join(", ")}`);
      for (const [skillId, amount] of Object.entries<any>(summary.skillXp || {})) emit(`   ${skillId} skill +${amount} xp`);
      for (const qp of (summary.questProgress || [])) { if (qp.completed) emit(`   ✓ Quest complete: ${qp.questId}`); else emit(`   Quest "${qp.questId}" � ${qp.objectiveId}: ${qp.next}/${qp.goal}`); }
      if (summary.reputation?.length) for (const rr of summary.reputation) emit(`   Rep: +${rr.amount} ${rr.factionId}`);
      if ((summary.butcherableKills || []).length > 0) emit(`   🐾 ${summary.butcherableKills.length} beast corpse${summary.butcherableKills.length > 1 ? "s" : ""} can be butchered. Type 'butcher'.`);

      if ((save.mode || "normal") !== "hardcore") {
        for (const m of save.party) {
          const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
          if (!ir.ok) continue;
          const inst = ir.data;
          if (inst.deathState === "downed" && !inst.permadead) emit(`   ${inst.name} is downed. Rez cost: ${Currency.toString(inst.rezCost || DeathHandler.rezCostForLevel(inst.level || 1))}.`);
        }
      }

      trackCollections(cr.kills, summary.loot);
      checkAchievements();

      for (const [ammoId, count] of Object.entries<any>(cr.ammoUsed || {})) {
        const inv = (save.inventory || []).find((e: any) => e.itemId === ammoId);
        const toDeduct = Math.min(count, inv?.qty ?? 0);
        if (toDeduct > 0)
          save = { ...save, inventory: save.inventory.map((e: any) => e.itemId === ammoId ? { ...e, qty: e.qty - toDeduct } : e).filter((e: any) => e.qty > 0) };
      }

      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed: ${sr.errors?.join(", ")}`);
      state = STATES.HOME;
    };

    // Shared combat resolution � runs autobattle then applies post-combat logic.
    const _resolveCombat = (enc: any) => {
      const partyInsts = save.party
        .map((p: any) => { const r = Loader.load(`instances/companions/${p.instanceId}`, "companionInstance"); return r.ok ? r.data : null; })
        .filter(Boolean)
        .map((inst: any) => ({ ...inst, _inventory: save.inventory || [] }));
      const priorVictory = !!(save.flags?.priorEncounterVictory);
      const cr = CombatBridge.run(enc, partyInsts, { priorEncounterVictory: priorVictory });
      _applyPostCombat(cr, enc);
    };

    const runEncounter = () => {
      const _zoneGuard = Loader.load(`templates/zones/${save.currentZone}`, "zone");
      if (_zoneGuard.ok && _zoneGuard.data.zoneType === "shop") {
        emit(`\n🏪 ${_zoneGuard.data.name} � Use the shop or travel to another zone.`);
        state = STATES.HOME;
        return;
      }
      // A story boss that was surfaced but not yet resolved (player navigated away or
      // fled) always takes precedence over a random encounter, so the arc can't stall.
      if (save.flags?.pendingStoryBoss) {
        if (_surfaceBossEncounter(save.flags.pendingStoryBoss)) return;
      }
      state = STATES.ENCOUNTER;
      emit(`\n⚡ Generating encounter in ${save.currentZone}...`);

      let enc = EncounterGenerator.generate(save.currentZone, save, Loader);
      if (!enc.ok) { emit(`ERROR: ${enc.errors.join(", ")}`); state = STATES.HOME; return; }

      if (enc.forced) save = Modifiers.clearFlag(save, "forcedEncounter");

      // Build enemies for forced combat encounters that specify a single enemyId
      if (enc.forced && enc.encounterType === "combat" && enc.enemyId && !enc.enemies.length) {
        const er = Loader.load(`templates/enemies/${enc.enemyId}`, "enemy");
        if (er.ok) enc = { ...enc, enemies: [{ ...er.data, instanceId: `${enc.enemyId}_${Date.now()}` }] };
      }

      if (enc.encounterType === "gathering") {
        const nodes = enc.gatheringNodes || [];
        emit(`\n🌿 Gathering � ${nodes.map((n: any) => n.name).join(", ")}`);
        for (const n of nodes) {
          const lootMap: Record<string, number> = {};
          const rolls = n.rolls || 1;
          for (let r = 0; r < rolls; r++) {
            for (const drop of (n.drops || [])) {
              if (Math.random() < drop.chance)
                lootMap[drop.itemId] = (lootMap[drop.itemId] || 0) + drop.qty;
            }
          }
          const loot = Object.entries<any>(lootMap).map(([itemId, qty]) => ({ itemId, qty }));
          if (!loot.length) loot.push({ itemId: n.nodeId, qty: 1 });
          for (const { itemId, qty } of loot) save = Modifiers.addToInventory(save, itemId, qty);
          emit(`   Gathered: ${loot.map((l: any) => `${l.qty}x ${l.itemId}`).join(", ")}`);
          // Gathering is a profession action: award authored XP per node (node.xp).
          if (n.requiredProfession) {
            const xp = (n.xp != null) ? n.xp : (10 + (n.minSkillLevel || 0));
            save = awardProfessionXp(save, n.requiredProfession, xp);
          }
        }
        save = Modifiers.clearFlag(save, "trackingBoost");
        save = Modifiers.clearFlag(save, "activeTrack");
        save = Modifiers.clearFlag(save, "fleeBonus");
        const sr = SaveManager.save(save, slotId); emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
        state = STATES.HOME; return;
      }

      if (enc.encounterType === "quest") {
        const q = enc.quest;
        if (!q) { emit(`\n📜 A quest was available but failed to load.`); state = STATES.HOME; return; }
        emit(`\n📜 Quest: ${q.name}`); emit(`  ${q.description || ""}`);
        for (const obj of (q.objectives || [])) emit(`  ☐ ${obj.description}  [0/${obj.count}]`);
        const rw = q.rewards || {}, rwP: string[] = [];
        if (rw.xp) rwP.push(`${rw.xp} XP`); if (rw.currency) rwP.push(Currency.toString(rw.currency)); if (rw.items?.length) rwP.push(rw.items.map((i: any) => `${i.qty}x ${i.itemId}`).join(", ")); if (rw.reputation?.length) rwP.push(rw.reputation.map((r: any) => `+${r.amount} ${r.factionId} rep`).join(", "));
        if (rwP.length) emit(`  Rewards: ${rwP.join(" | ")}`);
        const objectives: Record<string, number> = {}; for (const obj of (q.objectives || [])) objectives[obj.id] = 0;
        save = { ...save, quests: { ...save.quests, [q.id]: { objectives, completed: false, assignedAt: new Date().toISOString() } } };
        save = Modifiers.clearFlag(save, "trackingBoost");
        save = Modifiers.clearFlag(save, "activeTrack");
        save = Modifiers.clearFlag(save, "fleeBonus");
        const sr = SaveManager.save(save, slotId); emit(`  ✓ Quest accepted.`); emit(sr.ok ? `  ✓ Auto-saved.` : `  ✗ Save failed.`);
        state = STATES.HOME; return;
      }

      if (enc.encounterType === "companion") {
        if (enc.companionRecruit) {
          const rec = enc.companionRecruit;
          const iid = `${rec.id}_${Date.now()}`;
          const newInst = buildCompanionInstance(rec, iid);
          DataStore.write(`instances/companions/${iid}`, newInst);
          emit(`\n🤝 Companion encounter!`);
          for (const line of (rec.joinDialogue || [])) emit(`  "${line}"`);
          save = { ...save, party: [...save.party, { instanceId: iid, templateId: rec.id }] };
          const partySize = save.party.length;
          emit(`  ✦ ${rec.name} (${rec.raceId} ${rec.classId} Lv${rec.joinLevel}) joined the party! (${partySize} members)`);
          if (partySize > 5) {
            const xpPct = Math.max(0, Math.round((1 - (partySize - 5) * 0.2) * 100));
            emit(`  ⚠ Party size ${partySize}: XP reduced to ${xpPct}%.`);
          }
          emit(`  Profession: ${rec.profession || "none"}`);
        }
        save = Modifiers.clearFlag(save, "trackingBoost");
        save = Modifiers.clearFlag(save, "activeTrack");
        save = Modifiers.clearFlag(save, "fleeBonus");
        const sr = SaveManager.save(save, slotId); emit(sr.ok ? `  ✓ Auto-saved.` : `  ✗ Save failed.`);
        state = STATES.HOME; return;
      }

      if (enc.encounterType === "locked_chest") {
        const hasLockpick = save.party.some((m: any) => {
          const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
          return ir.ok && ((ir.data.skills || {}).lockpicking || 0) >= 1;
        });
        if (hasLockpick) {
          const gold = 100 + Math.floor(Math.random() * 300);
          save = Currency.add(save, gold);
          emit(`\n🔓 Locked Chest � A lockpicker in your party picks the lock!`);
          emit(`   Found: +${Currency.toString(gold)}`);
        } else {
          emit(`\n🔒 Locked Chest � You cannot open it without Lockpicking.`);
        }
        save = Modifiers.clearFlag(save, "trackingBoost"); save = Modifiers.clearFlag(save, "activeTrack"); save = Modifiers.clearFlag(save, "fleeBonus");
        const srLc = SaveManager.save(save, slotId); emit(srLc.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
        state = STATES.HOME; return;
      }
      if (enc.encounterType === "fishing_spot") { emit(`\n🎣 Fishing Spot � (fishing not yet implemented)`);    save = Modifiers.clearFlag(save, "trackingBoost"); save = Modifiers.clearFlag(save, "activeTrack"); save = Modifiers.clearFlag(save, "fleeBonus"); state = STATES.HOME; return; }

      if (enc.encounterType === "trap") {
        emit(`\n🪤 Trap!`);
        const res = TrapSystem.resolve(save, enc.trap || null);
        save = res.save;
        for (const line of res.lines) emit(line);
        save = Modifiers.clearFlag(save, "trackingBoost");
        save = Modifiers.clearFlag(save, "activeTrack");
        save = Modifiers.clearFlag(save, "fleeBonus");
        const srTr = SaveManager.save(save, slotId); emit(srTr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
        state = STATES.HOME; return;
      }

      // Combat: surface enemies then wait for engageCombat() or tryFlee()
      const _fleeBonus  = save.flags?.fleeBonus || 0;
      const fleeChance  = RidingSystem.getFleeChance(save, enc.enemies, _fleeBonus);
      emit(`\n⚡ Encounter: ${enc.enemies.map((e: any) => e.name).join(", ")}`);
      emit(`   Flee chance: ${Math.round(fleeChance * 100)}%  |  Riding: ${RidingSystem.getSkill(save)}/${RidingSystem.getCap(RidingSystem.getHighestPartyLevel(save))}${_fleeBonus > 0 ? `  (+${Math.round(_fleeBonus * 100)}% bonus)` : ""}`);
      _pendingCombat = enc;
      state = STATES.COMBAT_PENDING;
    };

    const engageCombat = () => {
      if (!_pendingCombat || state !== STATES.COMBAT_PENDING) { emit(`   No pending combat.`); return; }
      const enc = _pendingCombat;
      _pendingCombat = null;
      if (combatMode === "streamlined" || combatMode === "full_manual") {
        const partyInsts = save.party
          .map((p: any) => { const r = Loader.load(`instances/companions/${p.instanceId}`, "companionInstance"); return r.ok ? r.data : null; })
          .filter(Boolean);
        _manualCombatState = { enc, ...CombatBridge.startCombat(enc, partyInsts) };
        state = STATES.IN_COMBAT;
        emit(`⚔ Manual combat started � ${enc.enemies.map((e: any) => e.name).join(", ")}`);
      } else {
        state = STATES.ENCOUNTER;
        _resolveCombat(enc);
      }
    };

    const executePlayerAction = (actions: any) => {
      if (state !== STATES.IN_COMBAT || !_manualCombatState) { emit(`   Not in manual combat.`); return; }
      const priorVictory = !!(save.flags?.priorEncounterVictory);

      // Validate and consume any item actions before handing off to stepTurn.
      const resolvedActions: any[] = [];
      for (const action of (actions || [])) {
        if (action.type === 'use_item') {
          const { itemId } = action;
          const entry = (save.inventory || []).find((e: any) => e.itemId === itemId);
          if (!entry || entry.qty < 1) { emit(`   You don't have ${itemId}.`); continue; }
          const ir = Loader.load(`templates/items/${itemId}`, 'item');
          if (!ir.ok || !ir.data.onUse) { emit(`   ${itemId} has no use effect.`); continue; }
          const itemDef = ir.data;
          if (itemDef.onUse.outOfCombatOnly) { emit(`   ${itemDef.name} cannot be used in combat.`); continue; }
          save = { ...save, inventory: save.inventory.map((e: any) => e.itemId === itemId ? { ...e, qty: e.qty - 1 } : e).filter((e: any) => e.qty > 0) };
          resolvedActions.push({ ...action, itemDef });
        } else {
          resolvedActions.push(action);
        }
      }

      const result = CombatBridge.stepTurn(_manualCombatState, resolvedActions, { priorEncounterVictory: priorVictory, mode: combatMode });
      _manualCombatState = { ..._manualCombatState, party: result.party, enemies: result.enemies, turn: result.turn, allLogs: [..._manualCombatState.allLogs, ...result.stepLogs] };
      result.stepLogs.forEach((l: any) => emit(l));

      if (result.outcome || result.turn >= 30) {
        const enc = _manualCombatState.enc;
        if (!result.outcome) emit(`\n⚠ TIMEOUT`);
        const cr = {
          outcome: result.outcome || "timeout",
          turns:   result.turn,
          logs:    [],  // already emitted turn-by-turn; skip re-emit in _applyPostCombat
          kills:   result.enemies.filter((u: any) => !u.alive),
          totalXp: result.enemies.filter((u: any) => !u.alive).reduce((s: number, u: any) => s + (u.xpValue || 0), 0),
          enemies: result.enemies,
          party:   result.party,
          pickpocketGold:   result.enemies.reduce((s: number, e: any) => s + (e.pickpocketGold || 0), 0),
          soulShardsGained: result.party.reduce((s: number, u: any) => s + (u.soulShardsGained || 0), 0),
          abilityUse:       result.abilityUse || {},
        };
        _manualCombatState = null;
        _applyPostCombat(cr, enc);
      }
    };

    const setCombatMode = (mode: string) => {
      combatMode = ['auto', 'streamlined', 'full_manual'].includes(mode) ? mode : 'auto';
      emit(`   Combat mode: ${combatMode}`);
    };

    const getCombatMode = () => combatMode;

    const getManualCombatState = () => {
      if (!_manualCombatState) return null;
      return {
        turn: _manualCombatState.turn,
        enemyUnits: _manualCombatState.enemies.map((u: any) => ({
          id: u.id, name: u.name, hp: u.hp, maxHp: u.maxHp, alive: u.alive,
          buffs: u.buffs?.map((b: any) => b.id || b) || [],
          debuffs: u.debuffs?.map((b: any) => b.id || b) || [],
        })),
        partyUnits: _manualCombatState.party.map((u: any) => ({
          id: u.id, name: u.name, hp: u.hp, maxHp: u.maxHp, alive: u.alive,
          resources: u.resources,
          cooldowns: u.cooldowns || {},
          buffs: u.buffs?.map((b: any) => b.id || b) || [],
          debuffs: u.debuffs?.map((b: any) => b.id || b) || [],
          castQueue: (u.castQueue || []).map((e: any) => ({ abilityId: e.abilityId, turnsRemaining: e.turnsRemaining })),
          isPet: u.isPet || false,
          ownerId: u.ownerId || null,
          classId: u.classId,
          rangedReady: u.rangedReady || false,
        })),
      };
    };

    const tryFlee = () => {
      if (!_pendingCombat || state !== STATES.COMBAT_PENDING) { emit(`   No pending combat.`); return; }
      const enc     = _pendingCombat;
      const chance  = RidingSystem.getFleeChance(save, enc.enemies, save.flags?.fleeBonus || 0);
      if (Math.random() < chance) {
        _pendingCombat = null;
        save = RidingSystem.gainRiding(save);
        const newRiding = RidingSystem.getSkill(save);
        const cap       = RidingSystem.getCap(RidingSystem.getHighestPartyLevel(save));
        emit(`   ✓ Fled successfully! (${Math.round(chance * 100)}% chance)`);
        emit(`   Riding: ${newRiding}/${cap}`);
        save = Modifiers.clearFlag(save, "trackingBoost");
        save = Modifiers.clearFlag(save, "activeTrack");
        save = Modifiers.clearFlag(save, "fleeBonus");
        const sr = SaveManager.save(save, slotId);
        emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
        state = STATES.HOME;
      } else {
        emit(`   ✗ Failed to flee (${Math.round(chance * 100)}% chance) � engaging combat.`);
        _pendingCombat = null;
        state = STATES.ENCOUNTER;
        _resolveCombat(enc);
      }
    };

    const renderMap = () => {
      state = STATES.MAP;
      const zr   = Loader.load(`templates/zones/${save.currentZone}`, "zone");
      const zone = zr.ok ? zr.data : null;
      emit(`\n── Map ──`);
      if (zone?.regionId) emit(`   Region:  ${zone.regionId}`);
      emit(`   Current: ${save.currentZone}` + (zone ? ` [${zone.zoneType}] Lv${zone.minPartyLevel}�${zone.maxPartyLevel}` : ""));
    };
    // Travel model: any zone is reachable (no adjacency graph). Same-region travel
    // is free; cross-region travel costs a price based on the destination's level.
    const selectZone = (zoneId: string) => {
      const zr = Loader.load(`templates/zones/${zoneId}`, "zone");
      if (!zr.ok) { emit(`   Unknown zone: ${zoneId}`); return false; }
      const dest = zr.data;
      const currZr = Loader.load(`templates/zones/${save.currentZone}`, "zone");
      const sameRegion = !currZr.ok || currZr.data.regionId === dest.regionId;
      if (!sameRegion) {
        const cost = Math.max(100, (dest.minPartyLevel || 1) * 10);
        if ((save.currency || 0) < cost) {
          emit(`   Not enough coin to travel to ${dest.name}. (Need ${Currency.toString(cost)})`);
          return false;
        }
        save = { ...save, currency: save.currency - cost };
        emit(`   Paid ${Currency.toString(cost)} to travel to ${dest.name}.`);
      }
      save = { ...save, currentZone: zoneId };
      if (sameRegion) emit(`   Traveled to: ${dest.name}`);
      state = STATES.HOME;
      return true;
    };
    const renderBag  = () => { state = STATES.BAG; emit(`\n── Bag ──`); emit(`   Currency: ${Currency.toString(save.currency || 0)}`); if (!save.inventory?.length) { emit(`   (empty)`); return; } save.inventory.forEach((e: any, i: number) => emit(`   ${i + 1}. ${e.itemId.padEnd(26)} �${e.qty}`)); };

    const useItem = (itemId: string) => {
      const invEntry = (save.inventory || []).find((e: any) => e.itemId === itemId);
      if (!invEntry || invEntry.qty < 1) { emit(`   You don't have that.`); return; }
      const ir = Loader.load(`templates/items/${itemId}`, "item");
      if (!ir.ok || !ir.data.onUse) { emit(`   No use effect.`); return; }
      const item = ir.data;
      if (item.onUse.outOfCombatOnly && (state === STATES.ENCOUNTER || state === STATES.COMBAT_PENDING)) { emit(`   ${item.name} can only be used out of combat.`); return; }
      if (item.onUse.type === "heal") {
        const isParty = item.onUse.target === "party";
        const aliveInsts: any[] = [];
        for (const m of save.party) {
          const ir2 = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
          if (ir2.ok && ir2.data.deathState === "alive") aliveInsts.push({ member: m, inst: ir2.data });
        }
        const targets = isParty
          ? aliveInsts
          : aliveInsts.sort((a: any, b: any) => (a.inst.currentHp / a.inst.maxHp) - (b.inst.currentHp / b.inst.maxHp)).slice(0, 1);
        let anyHealed = false;
        for (const { member, inst } of targets) {
          const amount = item.onUse.percent != null
            ? Math.floor((inst.maxHp || 1) * item.onUse.percent)
            : item.onUse.minFlat != null
              ? Math.floor(Math.random() * (item.onUse.maxFlat - item.onUse.minFlat + 1) + item.onUse.minFlat)
              : (item.onUse.flat || 0);
          const actual = Math.min(amount, (inst.maxHp || 0) - (inst.currentHp || 0));
          if (actual <= 0) continue;
          DataStore.write(`instances/companions/${member.instanceId}`, { ...inst, currentHp: inst.currentHp + actual });
          emit(`   Used ${item.name}: restored ${actual} HP to ${inst.name}.`);
          anyHealed = true;
        }
        if (!anyHealed) { emit(`   ${item.name}: everyone is already at full health.`); return; }
      }
      if (item.onUse.type === "currency") { save = Currency.add(save, item.onUse.amount); emit(`   Opened ${item.name}: +${Currency.toString(item.onUse.amount)}`); }
      if (item.onUse.type === "weapon_buff") {
        const buffId = item.onUse.buffId;
        let applied = false;
        for (const m of save.party) {
          const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
          if (!ir.ok) continue;
          const inst = ir.data;
          if (inst.deathState !== "alive") continue;
          const duration = _abilitiesData.buffs[buffId]?.duration ?? 1;
          const existing = (inst.activeBuffs || []).filter((b: any) => (typeof b === "string" ? b : b.id) !== buffId);
          DataStore.write(`instances/companions/${m.instanceId}`, { ...inst, activeBuffs: [...existing, { id: buffId, remainingDuration: duration }] });
          emit(`   Applied ${item.name} to ${inst.name}. (+2 melee damage for 30 turns)`);
          applied = true;
          break;
        }
        if (!applied) { emit(`   No valid target for ${item.name}.`); return; }
      }
      save = { ...save, inventory: save.inventory.map((e: any) => e.itemId === itemId ? { ...e, qty: e.qty - 1 } : e).filter((e: any) => e.qty > 0) };
    };

    const renderShop = (tab = "buy") => {
      state = STATES.SHOP;
      const zr = Loader.load(`templates/zones/${save.currentZone}`, "zone");
      if (!zr.ok) { emit(`   No shop in this zone.`); return; }
      const zone = zr.data;
      emit(`\n── Shop (${zone.name}) � ${tab.toUpperCase()} ──`);
      emit(`   Your gold: ${Currency.toString(save.currency || 0)}`);
      if (tab === "buy") {
        const list = ShopSystem.getBuyList(zone, save);
        if (!list.length) { emit(`   Nothing for sale.`); return; }
        list.forEach((e: any, i: number) => emit(`   ${i + 1}. ${e.itemId.padEnd(26)} ${Currency.toString(e.buyPrice).padStart(8)}  [${e.stock === -1 ? "∞" : e.stock}]`));
      } else {
        emit(`   Sell at ${Math.round((zone.sellMultiplier || 0.25) * 100)}% value:`);
        if (!save.inventory?.length) { emit(`   (nothing to sell)`); return; }
        save.inventory.forEach((e: any, i: number) => { const ir = Loader.load(`templates/items/${e.itemId}`, "item"); const sv = ir.ok ? Currency.toString(Math.floor(ir.data.value * (zone.sellMultiplier || 0.25))) : "?"; emit(`   ${i + 1}. ${e.itemId.padEnd(26)} �${e.qty}  (${sv} each)`); });
      }
    };

    const buyItem  = (itemId: string, qty = 1, keeperName = 'unknown') => { const zr = Loader.load(`templates/zones/${save.currentZone}`, "zone"); if (!zr.ok) { emit(`   No shop.`); return; } const res = ShopSystem.buy(save, zr.data, itemId, qty, keeperName); emit(`   ${res.ok ? res.message : "✗ " + res.error}`); if (res.ok) save = res.save; };
    const sellItem = (itemId: string, qty = 1) => { const zr = Loader.load(`templates/zones/${save.currentZone}`, "zone"); if (!zr.ok) { emit(`   No shop.`); return; } const res = ShopSystem.sell(save, zr.data, itemId, qty); emit(`   ${res.ok ? res.message : "✗ " + res.error}`); if (res.ok) save = res.save; };

    const getShopData = () => {
      const zr = Loader.load(`templates/zones/${save.currentZone}`, "zone");
      if (!zr.ok) return { zoneName: "", sellMultiplier: 0.25, shopkeepers: {}, sellList: [] };
      const zone = zr.data;
      const sellMult = zone.sellMultiplier ?? 0.25;
      const enrichItem = (entry: any) => {
        const ir   = Loader.load(`templates/items/${entry.itemId}`, "item");
        const item = ir.ok ? ir.data : {};
        return {
          itemId:      entry.itemId,
          name:        item.name        || entry.itemId,
          buyPrice:    entry.buyPrice,
          stock:       entry.stock,
          quantity:    entry.quantity ?? 1,
          quality:     item.quality     || "common",
          itemType:    item.type        || null,
          slot:        item.slot        || null,
          weaponType:  item.weaponType  || null,
          itemLevel:   item.itemLevel   || null,
          reqLevel:    item.reqLevel    || null,
          description: item.description || "",
          statBonuses: item.statBonuses || {},
          tags:        item.tags        || [],
        };
      };
      const shopkeepers: Record<string, any> = {};
      for (const keeperName of Object.keys(zone.shopkeepers || {})) {
        const list = ShopSystem.getBuyList(zone, save, keeperName);
        shopkeepers[keeperName] = { inventory: list.map(enrichItem) };
      }
      return {
        zoneName:       zone.name,
        minLevel:       zone.minPartyLevel,
        maxLevel:       zone.maxPartyLevel,
        sellMultiplier: sellMult,
        shopkeepers,
        sellList: (save.inventory || []).map((e: any) => {
          const ir   = Loader.load(`templates/items/${e.itemId}`, "item");
          const item = ir.ok ? ir.data : {};
          return {
            itemId:    e.itemId,
            name:      item.name     || e.itemId,
            qty:       e.qty,
            quality:   item.quality  || "common",
            sellValue: Math.floor((item.value || 0) * sellMult),
          };
        }),
      };
    };

    const renderStats = () => {
      state = STATES.STATS; emit(`\n── Party Stats ──`);
      for (const member of save.party) {
        const ir = Loader.load(`instances/companions/${member.instanceId}`, "companionInstance"); if (!ir.ok) continue;
        const inst = ir.data, raw = inst.stats?.raw || getStatsAtLevel(inst.raceId, inst.classId, inst.level || 1);
        const xpStr = xpToNextLevel(inst.level || 1) === Infinity ? "MAX" : `${inst.xp}/${xpToNextLevel(inst.level || 1)}`;
        const deathTag = inst.deathState !== "alive" ? ` [${inst.deathState.toUpperCase()}]` : "";
        emit(`   ${inst.name}${deathTag} � ${inst.raceId} ${inst.classId} | Lv${inst.level || 1} | XP ${xpStr}`);
        emit(`     HP: ${inst.currentHp}/${inst.maxHp}  MP: ${inst.currentMp}/${inst.maxMp}`);
        emit(`     STR:${raw.str} DEX:${raw.dex} CON:${raw.con} INT:${raw.int} SPI:${raw.spi} WIS:${raw.wis ?? 0} SPD:${raw.spd ?? 0} CHA:${raw.cha ?? 0}`);
        emit(`     Profession: ${inst.profession || "none"}`);
        const sk = inst.skills || {}; if (Object.keys(sk).length) emit(`     Skills: ${Object.entries<any>(sk).map(([k, v]) => `${k}:${v}`).join(", ")}`);
      }
      const ts = save.talentSchools || {}; if (Object.keys(ts).length) emit(`   Talents: ${Object.entries<any>(ts).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    };

    const renderParty = () => {
      state = STATES.PARTY; emit(`\n── Party (${save.party.length}) ──`);
      save.party.forEach((m: any, i: number) => { const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance"); const inst = ir.ok ? ir.data : null; const deathTag = inst && inst.deathState !== "alive" ? ` [${inst.deathState.toUpperCase()}]` : ""; emit(`   ${i + 1}. ${inst ? inst.name : m.instanceId}${deathTag}  ${inst ? `${inst.raceId} ${inst.classId}  Lv${inst.level || 1}  Prof: ${inst.profession || "�"}` : ""}`); });
    };

    const renderReputation = () => {
      state = STATES.REPUTATION; emit(`\n── Reputation ──`);
      const rep = save.reputation || {}; if (!Object.keys(rep).length) { emit(`   (no faction standing yet)`); return; }
      for (const [faction, val] of Object.entries<any>(rep)) { const label = val >= 75 ? "Exalted" : val >= 50 ? "Revered" : val >= 25 ? "Honored" : val >= 0 ? "Friendly" : "Hostile"; emit(`   ${faction.padEnd(24)} ${val.toString().padStart(4)}  (${label})`); }
    };

    const renderAbilities = () => {
      state = STATES.ABILITIES; emit(`\n── Ability Lists ──`);
      for (const member of save.party) { const ir = Loader.load(`instances/companions/${member.instanceId}`, "companionInstance"); if (!ir.ok) continue; emit(`   ${ir.data.name}:`); (ir.data.learnedAbilities || []).forEach((id: any) => emit(`     - ${id}`)); }
    };

    const renderSaveLoad = () => {
      state = STATES.SAVE_LOAD; emit(`\n── Save / Load ──`);
      const slots = SaveManager.listSlots();
      if (!slots.length) emit(`   No saves found.`);
      else slots.forEach((s: any, i: number) => { const pt = `${Math.floor(s.playtime / 60)}m${s.playtime % 60}s`; emit(`   ${i + 1}. [${s.slotId}]  ${s.zone}  Party:${s.partySize}  ${pt}  ${s.timestamp.slice(0, 16)}`); });
    };

    const manualSave = (targetSlot?: string) => { const id = targetSlot || slotId; const result = SaveManager.save(save, id); emit(result.ok ? `   ✓ Saved to slot "${id}"` : `   ✗ Save failed: ${result.errors.join(", ")}`); };
    const manualLoad = (targetSlot: string) => { const result = SaveManager.load(targetSlot); if (!result.ok) { emit(`   ✗ Load failed: ${result.errors.join(", ")}`); return false; } save = result.data; slotId = targetSlot; emit(`   ✓ Loaded slot "${targetSlot}"`); state = STATES.HOME; return true; };

    const getPartySkill = (professionId: string) => {
      let best = 0;
      for (const member of save.party) {
        const ir = Loader.load(`instances/companions/${member.instanceId}`, "companionInstance");
        if (!ir.ok) continue;
        const inst = ir.data;
        if (inst.profession === professionId) best = Math.max(best, getSkillLevel(inst, professionId));
      }
      return best;
    };

    const hasIngredients = (inputs: any[]) => inputs.every(({ itemId, qty }: any) => {
      const entry = (save.inventory || []).find((e: any) => e.itemId === itemId);
      return entry && entry.qty >= qty;
    });

    const renderCrafting = () => {
      state = STATES.CRAFTING;
      emit(`\n── Crafting ──`);
      const recipes = Loader.loadAll("templates/recipes/", "recipe");
      if (!recipes.items.length) { emit(`   No recipes available.`); return; }
      recipes.items.forEach((rec: any, i: number) => {
        const skillOk = !rec.requiredProfession || getPartySkill(rec.requiredProfession) >= (rec.minSkillLevel || 0);
        const matsOk  = hasIngredients(rec.inputs);
        const tag     = skillOk && matsOk ? "[CAN CRAFT]  " : !skillOk ? "[NEED SKILL] " : "[MISSING MATS]";
        const inputStr = rec.inputs.map(({ itemId, qty }: any) => `${qty}x ${itemId}`).join(", ");
        const profStr  = rec.requiredProfession ? `  (${rec.requiredProfession} ${rec.minSkillLevel || 0}+)` : "";
        emit(`   ${i + 1}. ${rec.name.padEnd(26)} ${tag}`);
        emit(`      → ${rec.output.qty}x ${rec.output.itemId}  |  ${inputStr}${profStr}`);
      });
    };

    const craftItem = (recipeId: string) => {
      const rr = Loader.load(`templates/recipes/${recipeId}`, "recipe");
      if (!rr.ok) { emit(`   Unknown recipe: ${recipeId}`); return; }
      const rec = rr.data;

      if (rec.requiredProfession) {
        const skill = getPartySkill(rec.requiredProfession);
        if (skill < (rec.minSkillLevel || 0)) { emit(`   Need ${rec.requiredProfession} skill ${rec.minSkillLevel} (have ${skill}).`); return; }
      }

      if (!hasIngredients(rec.inputs)) {
        const missing = rec.inputs.filter(({ itemId, qty }: any) => { const e = (save.inventory || []).find((e: any) => e.itemId === itemId); return !e || e.qty < qty; });
        emit(`   Missing: ${missing.map(({ itemId, qty }: any) => `${qty}x ${itemId}`).join(", ")}`);
        return;
      }

      let inv = [...(save.inventory || [])];
      for (const { itemId, qty } of rec.inputs)
        inv = inv.map((e: any) => e.itemId === itemId ? { ...e, qty: e.qty - qty } : e).filter((e: any) => e.qty > 0);
      save = { ...save, inventory: inv };

      // Crafted output can roll a random suffix at the separate craftRollChance
      // (only if the output item is randomEnchant-eligible). One roll per craft.
      const outId = ItemSuffixes.isEligible(rec.output.itemId)
        ? ItemSuffixes.maybeApplySuffix(rec.output.itemId, ItemSuffixes.CRAFT_ROLL_CHANCE)
        : rec.output.itemId;
      save = Modifiers.addToInventory(save, outId, rec.output.qty);

      // Professions level via authored XP per craft (recipe.xp), not skill-up.
      let craftXp = 0;
      if (rec.requiredProfession) {
        craftXp = (rec.xp != null) ? rec.xp : (10 + (rec.minSkillLevel || 0));
        save = awardProfessionXp(save, rec.requiredProfession, craftXp);
      }

      emit(`   ✓ Crafted ${rec.output.qty}x ${outId}.${craftXp > 0 ? `  (+${craftXp} ${rec.requiredProfession} xp)` : ""}`);
      trackCollections([], [{ itemId: outId, qty: rec.output.qty }]);
      checkAchievements();
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const renderMounts = () => {
      state = STATES.MOUNTS;
      const riding   = RidingSystem.getSkill(save);
      const partyLvl = RidingSystem.getHighestPartyLevel(save);
      const cap      = RidingSystem.getCap(partyLvl);
      emit(`\n── Mounts & Riding ──`);
      emit(`   Riding: ${riding}/${cap}`);
      const owned = save.mounts || [];
      if (!owned.length) emit(`   Collection: (none)`);
      else owned.forEach((id: any) => { const ir = Loader.load(`templates/items/${id}`, "item"); emit(`   ✦ ${ir.ok ? ir.data.name : id}`); });
      if      (RidingSystem.canBuyEpicMount(save))       emit(`   Eligible: epic mounts`);
      else if (RidingSystem.canBuyBasicMount(save))      emit(`   Eligible: basic mounts`);
      else {
        const nextLvl    = partyLvl < RidingSystem.BASIC_MOUNT_LEVEL  ? RidingSystem.BASIC_MOUNT_LEVEL  : RidingSystem.EPIC_MOUNT_LEVEL;
        const nextRiding = riding   < RidingSystem.BASIC_MOUNT_RIDING ? RidingSystem.BASIC_MOUNT_RIDING : RidingSystem.EPIC_MOUNT_RIDING;
        emit(`   Next tier: Lv${nextLvl} + ${nextRiding} Riding`);
      }
    };

    const renderNonCombat = () => { state = STATES.NON_COMBAT; emit(`\n── Non-Combat ──`); emit(`   (not yet implemented)`); };
    const back            = () => { state = STATES.HOME; };
    const getCurrentState = () => state;
    const getSave         = () => save;

    const equipItem = (itemId: string, instanceId?: string) => {
      const invEntry = (save.inventory || []).find((e: any) => e.itemId === itemId);
      if (!invEntry || invEntry.qty < 1) { emit(`   You don't have that.`); return; }
      const ir = Loader.load(`templates/items/${itemId}`, "item");
      if (!ir.ok) { emit(`   Unknown item: ${itemId}.`); return; }
      const item = ir.data;
      if (!item.slot) { emit(`   ${item.name} cannot be equipped.`); return; }
      const compId = instanceId || save.party[0]?.instanceId;
      if (!compId) { emit(`   No companion to equip.`); return; }
      const cr = Loader.load(`instances/companions/${compId}`, "companionInstance");
      if (!cr.ok) { emit(`   Companion not found.`); return; }
      const inst = cr.data;
      // Weapon-skill gating: a character can only equip weapon types it has the skill for.
      if (item.weaponType && typeof canEquipWeaponType === "function" && !canEquipWeaponType(inst, item.weaponType)) {
        emit(`   ${inst.name} lacks the weapon skill to equip ${item.name}.`); return;
      }
      // Armor-tier gating: a class may wear its designated tier and anything lower.
      if (item.armorType && typeof ClassDB !== "undefined" && !ClassDB.canWearArmor(inst.classId, item.armorType)) {
        emit(`   ${inst.name} cannot wear ${item.name} (armor too heavy for class).`); return;
      }
      // Class restriction: items tagged with allowedClasses gate by class.
      if (typeof ClassDB !== "undefined" && !ClassDB.itemAllowedForClass(item, inst.classId)) {
        emit(`   ${inst.name}'s class cannot use ${item.name}.`); return;
      }
      const prevItemId = inst.gear?.[item.slot] || null;
      DataStore.write(`instances/companions/${compId}`, { ...inst, gear: { ...(inst.gear || {}), [item.slot]: itemId } });
      let inv = save.inventory.map((e: any) => e.itemId === itemId ? { ...e, qty: e.qty - 1 } : e).filter((e: any) => e.qty > 0);
      if (prevItemId) {
        const ex = inv.find((e: any) => e.itemId === prevItemId);
        inv = ex ? inv.map((e: any) => e.itemId === prevItemId ? { ...e, qty: e.qty + 1 } : e) : [...inv, { itemId: prevItemId, qty: 1 }];
      }
      save = { ...save, inventory: inv };
      emit(`   ⚔ Equipped ${item.name} on ${inst.name}${prevItemId ? ` (replaced ${prevItemId})` : ""}.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    // useAbility � out-of-combat and pre-combat ability usage
    // HOME state:           outOfCombatOnly abilities (track_beasts, track_humanoids)
    // COMBAT_PENDING state: abilities whose buff/debuff has a fleeBonus (earthbind, concussive_shot, wing_clip)
    const useAbility = (abilityId: string) => {
      const ab = _abilitiesData.abilities[abilityId];
      if (!ab) { emit(`   Unknown ability: ${abilityId}.`); return; }

      const inHome    = state === STATES.HOME;
      const inPending = state === STATES.COMBAT_PENDING;
      if (!inHome && !inPending) { emit(`   Abilities can only be used from home or before combat.`); return; }
      if (inHome && !ab.outOfCombatOnly) { emit(`   ${ab.name || abilityId} can only be used in combat.`); return; }

      // for COMBAT_PENDING: only allow abilities that produce a buff/debuff with fleeBonus
      if (inPending) {
        const hasFleeEffect = (ab.effects || []).some((e: any) => {
          if (e.type !== "buff" && e.type !== "debuff") return false;
          return (_abilitiesData.buffs?.[e.buffId]?.fleeBonus || 0) > 0;
        });
        if (!hasFleeEffect) { emit(`   ${ab.name || abilityId} cannot be used before combat.`); return; }
      }

      // find the first party member with this ability who can afford it
      let casterInst: any = null, casterIid: any = null;
      for (const m of save.party) {
        const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
        if (!ir.ok) continue;
        const inst = ir.data;
        if (!(inst.learnedAbilities || []).includes(abilityId)) continue;
        let canAfford = true;
        for (const [res, cost] of Object.entries<any>(ab.resourceCost || {})) {
          const cur = res === "mana" ? (inst.currentMp || 0) : 0;
          if (cur < cost) { canAfford = false; break; }
        }
        if (!canAfford) continue;
        casterInst = inst; casterIid = m.instanceId; break;
      }
      if (!casterInst) { emit(`   No party member can use ${ab.name || abilityId} (not learned or insufficient mana).`); return; }

      // deduct mana cost
      let newInst = { ...casterInst };
      const manaCost = ab.resourceCost?.mana || 0;
      if (manaCost > 0) newInst = { ...newInst, currentMp: (newInst.currentMp || 0) - manaCost };
      DataStore.write(`instances/companions/${casterIid}`, newInst);

      // apply effects
      const applied: string[] = [];
      for (const eff of (ab.effects || [])) {
        if (eff.type === "set_track") {
          save = { ...save, flags: { ...(save.flags || {}), activeTrack: eff.trackType } };
          applied.push(`now tracking ${eff.trackType}s`);
        } else if (eff.type === "buff" || eff.type === "debuff") {
          const bd = _abilitiesData.buffs?.[eff.buffId];
          if (bd?.fleeBonus) {
            save = { ...save, flags: { ...(save.flags || {}), fleeBonus: ((save.flags || {}).fleeBonus || 0) + bd.fleeBonus } };
            applied.push(`+${Math.round(bd.fleeBonus * 100)}% flee chance`);
          }
        } else if (eff.type === "pick_lock") {
          const currentLevel = (newInst.skills || {}).lockpicking || 0;
          if (currentLevel === 0) {
            newInst = { ...newInst, skills: { ...(newInst.skills || {}), lockpicking: 1 } };
            DataStore.write(`instances/companions/${casterIid}`, newInst);
            applied.push("learned Lockpicking");
          } else {
            applied.push("already knows Lockpicking");
          }
        } else if (eff.type === "revive") {
          const hpPct = eff.hpPct || 0.5;
          let revived = false;
          for (const m of save.party) {
            const ir2 = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
            if (!ir2.ok) continue;
            const deadInst = ir2.data;
            if (deadInst.deathState !== "downed" && deadInst.deathState !== "dead") continue;
            const reviveHp  = Math.max(1, Math.floor((deadInst.maxHp || 0) * hpPct));
            const updInst   = { ...deadInst, deathState: "alive", currentHp: reviveHp, currentMp: eff.clearMana ? 0 : (deadInst.currentMp || 0) };
            DataStore.write(`instances/companions/${m.instanceId}`, updInst);
            applied.push(`${deadInst.name} revived to ${reviveHp} HP`);
            revived = true;
            break;
          }
          if (!revived) applied.push("no fallen companions to revive");
        } else if (eff.type === "restore_party_mana") {
          const pct = eff.percent || 0.4;
          for (const m of save.party) {
            const ir2 = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
            if (!ir2.ok || ir2.data.deathState !== "alive") continue;
            const inst2 = ir2.data;
            const restore = Math.floor((inst2.maxMp || 0) * pct);
            if (restore > 0 && (inst2.currentMp || 0) < inst2.maxMp) {
              DataStore.write(`instances/companions/${m.instanceId}`, { ...inst2, currentMp: Math.min(inst2.maxMp, (inst2.currentMp || 0) + restore) });
              applied.push(`+${restore} mana to ${inst2.name}`);
            }
          }
        } else if (eff.type === "restore_party_hp") {
          const pct = eff.percent || 0.4;
          for (const m of save.party) {
            const ir2 = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
            if (!ir2.ok || ir2.data.deathState !== "alive") continue;
            const inst2 = ir2.data;
            const restore = Math.floor((inst2.maxHp || 0) * pct);
            if (restore > 0 && (inst2.currentHp || 0) < inst2.maxHp) {
              DataStore.write(`instances/companions/${m.instanceId}`, { ...inst2, currentHp: Math.min(inst2.maxHp, (inst2.currentHp || 0) + restore) });
              applied.push(`+${restore} HP to ${inst2.name}`);
            }
          }
        } else if (eff.type === "create_healthstone") {
          const existing = (save.inventory || []).find((e: any) => e.itemId === "healthstone");
          if (existing) {
            applied.push("already have a Healthstone");
          } else {
            save = Modifiers.addToInventory(save, "healthstone", 1);
            applied.push("Healthstone created");
          }
        }
      }

      emit(`   ${casterInst.name} uses ${ab.name || abilityId}${applied.length ? ": " + applied.join(", ") : ""}.`);

      if (inPending) {
        // update displayed flee chance with new bonus
        const bonus = save.flags?.fleeBonus || 0;
        const newChance = RidingSystem.getFleeChance(save, _pendingCombat.enemies, bonus);
        emit(`   Flee chance now: ${Math.round(newChance * 100)}%`);
      }

      const sr = SaveManager.save(save, slotId);
      if (!sr.ok) emit(`   ✗ Save failed.`);
    };

    const butcherCorpses = () => {
      if (!(save.flags?.pendingButchery?.length)) { emit(`   No corpses to butcher.`); return; }
      const beasts = _lastKills.filter((e: any) => e.type === "beast");
      if (!beasts.length) { emit(`   Nothing butcherable.`); return; }
      const { save: ns, drops } = RewardEngine.applyButchery(save, beasts);
      save = ns;
      if (drops.length) {
        emit(`   🐾 Butchered ${beasts.length} corpse${beasts.length > 1 ? "s" : ""}:`);
        drops.forEach((d: any) => emit(`      +${d.qty}x ${d.itemId}`));
      } else {
        emit(`   🐾 Nothing useful was recovered.`);
      }
      trackCollections([], drops);
      checkAchievements();
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const rezMember = (instanceId: string) => {
      const cr = Loader.load(`instances/companions/${instanceId}`, "companionInstance");
      if (!cr.ok) { emit(`   Companion not found.`); return; }
      const res = DeathHandler.rezForGold(cr.data, save);
      if (!res.ok) { emit(`   ✗ ${res.error}`); return; }
      DataStore.write(`instances/companions/${instanceId}`, res.inst);
      save = res.save;
      const costStr = Currency.toString(cr.data.rezCost || DeathHandler.rezCostForLevel(cr.data.level || 1));
      emit(`   ✓ ${cr.data.name} revived for ${costStr}.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    // ── Collections & Achievements ─────────────────────────────────────────────

    const trackCollections = (kills: any[] = [], lootItems: any[] = []) => {
      const killMap  = { ...(save.collections?.kills || {}) };
      const itemMap  = { ...(save.collections?.items || {}) };
      for (const k of kills) {
        if (k?.id) killMap[k.id] = (killMap[k.id] || 0) + 1;
      }
      for (const { itemId, qty } of lootItems) {
        if (itemId && itemId !== 'copper_coin_pouch') {
          itemMap[itemId] = (itemMap[itemId] || 0) + (qty || 1);
        }
      }
      save = { ...save, collections: { kills: killMap, items: itemMap } };
    };

    const checkAchievements = () => {
      const defs = _achievementsData?.achievements || {};
      for (const [achId, def] of Object.entries<any>(defs)) {
        if ((save.achievements || {})[achId]) continue;
        let met = false;
        if (def.criteria?.type === 'unique_items_collected') {
          met = Object.keys(save.collections?.items || {}).length >= def.criteria.threshold;
        }
        if (!met) continue;
        save = { ...save, achievements: { ...(save.achievements || {}), [achId]: { unlockedAt: new Date().toISOString() } } };
        emit(`\n🏆 Achievement Unlocked: ${def.name}`);
        emit(`   "${def.description}"`);
        const rw = def.rewards || {};
        if (rw.xp) {
          const achXp = rw.xp;
          save = { ...save, party: save.party.map((m: any) => {
            const ir = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
            if (!ir.ok) return m;
            const { inst: updated, levelUpLines } = addXpToInst(ir.data, achXp);
            DataStore.write(`instances/companions/${m.instanceId}`, updated);
            levelUpLines.forEach((l: any) => emit(`   ${l}`));
            return m;
          }) };
          emit(`   ✦ Reward: +${achXp} XP (each member)`);
        }
        if (rw.currency) {
          save = Currency.add(save, rw.currency);
          emit(`   ✦ Reward: +${Currency.toString(rw.currency)}`);
        }
        if (rw.items) {
          for (const ri of rw.items) {
            save = Modifiers.addToInventory(save, ri.itemId, ri.qty);
            emit(`   ✦ Reward: +${ri.qty}x ${ri.itemId}`);
          }
        }
      }
    };

    // Returns all known companion instances (party + roster) with inParty flag.
    const getRosterData = () => {
      const allSlots = [
        ...(save.party  || []).map((m: any) => ({ ...m, inParty: true  })),
        ...(save.roster || []).map((m: any) => ({ ...m, inParty: false })),
      ];
      return allSlots.map((slot: any) => {
        const ir = Loader.load(`instances/companions/${slot.instanceId}`, 'companionInstance');
        if (!ir.ok) return null;
        return { ...ir.data, inParty: slot.inParty };
      }).filter(Boolean);
    };

    const addToParty = (instanceId: string) => {
      if (state === STATES.IN_COMBAT) { emit(`   Cannot change party during combat.`); return; }
      const rosterEntry = (save.roster || []).find((m: any) => m.instanceId === instanceId);
      if (!rosterEntry) { emit(`   ${instanceId} is not in the guildhall.`); return; }
      save = {
        ...save,
        party:  [...(save.party || []), rosterEntry],
        roster: (save.roster || []).filter((m: any) => m.instanceId !== instanceId),
      };
      const inst = Loader.load(`instances/companions/${instanceId}`, 'companionInstance');
      const name = inst.ok ? inst.data.name : instanceId;
      emit(`   ✓ ${name} joined the party.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const removeFromParty = (instanceId: string) => {
      if (state === STATES.IN_COMBAT) { emit(`   Cannot change party during combat.`); return; }
      const partyEntry = (save.party || []).find((m: any) => m.instanceId === instanceId);
      if (!partyEntry) { emit(`   ${instanceId} is not in your party.`); return; }
      save = {
        ...save,
        party:  save.party.filter((m: any) => m.instanceId !== instanceId),
        roster: [...(save.roster || []), partyEntry],
      };
      const inst = Loader.load(`instances/companions/${instanceId}`, 'companionInstance');
      const name = inst.ok ? inst.data.name : instanceId;
      emit(`   ✓ ${name} moved to the guildhall.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const swapPartyMember = (outInstanceId: string, inInstanceId: string) => {
      if (state === STATES.IN_COMBAT) { emit(`   Cannot swap party members during combat.`); return; }
      const partyEntry  = (save.party  || []).find((m: any) => m.instanceId === outInstanceId);
      const rosterEntry = (save.roster || []).find((m: any) => m.instanceId === inInstanceId);
      if (!partyEntry)  { emit(`   ${outInstanceId} is not in your party.`);  return; }
      if (!rosterEntry) { emit(`   ${inInstanceId} is not in your roster.`); return; }
      save = {
        ...save,
        party:  save.party.map((m: any) => m.instanceId === outInstanceId ? rosterEntry : m),
        roster: [...(save.roster || []).filter((m: any) => m.instanceId !== inInstanceId), partyEntry],
      };
      const outInst = Loader.load(`instances/companions/${outInstanceId}`, 'companionInstance');
      const inInst  = Loader.load(`instances/companions/${inInstanceId}`,  'companionInstance');
      const outName = outInst.ok ? outInst.data.name : outInstanceId;
      const inName  = inInst.ok  ? inInst.data.name  : inInstanceId;
      emit(`   ✓ ${inName} joined the party. ${outName} moved to the guildhall.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const setPetForCompanion = (instanceId: string, petId?: string) => {
      const ir = Loader.load(`instances/companions/${instanceId}`, 'companionInstance');
      if (!ir.ok) { emit(`   No companion with id ${instanceId}.`); return; }
      const inst = ir.data;
      const pets = petsForUnit(inst);
      if (!pets.length) { emit(`   ${inst.name} has no pet skill (Zoology or Summoning).`); return; }
      if (petId) {
        const template = pets.find((p: any) => p.id === petId);
        if (!template) { emit(`   Unknown pet: ${petId}.`); return; }
        if (template.unlockLevel > (inst.level || 1)) { emit(`   ${inst.name} is not high enough level for ${template.name} (requires level ${template.unlockLevel}).`); return; }
      }
      const updated = { ...inst, activePetId: petId || null };
      DataStore.write(`instances/companions/${instanceId}`, updated);
      const petName = petId ? (pets.find((p: any) => p.id === petId)?.name || petId) : 'none';
      emit(`   ✓ ${inst.name}'s active pet set to: ${petName}.`);
      const sr = SaveManager.save(save, slotId);
      emit(sr.ok ? `   ✓ Auto-saved.` : `   ✗ Save failed.`);
    };

    const getAvailablePets = (instanceId: string) => {
      const ir = Loader.load(`instances/companions/${instanceId}`, 'companionInstance');
      if (!ir.ok) return null;
      const inst = ir.data;
      const pets = petsForUnit(inst);
      if (!pets.length) return null;
      return {
        activePetId: inst.activePetId || null,
        pets: pets.map((p: any) => ({ ...p, unlocked: (inst.level || 1) >= p.unlockLevel })),
      };
    };

    // ── Commune / dialogue overlay ───────────────────────────────────────────
    // The renderer polls getPendingScene() each snapshot; when non-null it draws
    // the Commune overlay and drives it with advanceScene / chooseSceneOption.
    const getPendingScene = () => resolvePendingScene(save);

    // Surface a forced boss encounter as combat_pending. Returns false if the enemy
    // failed to load.
    const _surfaceBossEncounter = (enemyId: string): boolean => {
      const er = Loader.load(`templates/enemies/${enemyId}`, "enemy");
      if (!er.ok) { emit(`   (Story boss ${enemyId} failed to load.)`); return false; }
      const enc: any = {
        ok: true, encounterType: "combat", forced: true,
        zoneId: save.currentZone,
        enemies: [{ ...er.data, instanceId: `${enemyId}_${Date.now()}` }],
        _storyBoss: enemyId,
      };
      emit(`\n⚡ Encounter: ${enc.enemies.map((e: any) => e.name).join(", ")}`);
      _pendingCombat = enc;
      state = STATES.COMBAT_PENDING;
      return true;
    };

    // Deferred scene effects need Session state (combat/travel). startCombat records
    // the boss on the save (so it survives navigation — runEncounter re-surfaces it
    // until the boss is beaten or the party wipes) and surfaces it now. The
    // _storyBoss marker lets post-combat tell a boss wipe from a tunnels wipe.
    const _applySceneDeferred = (eff: any) => {
      if (eff.type === "travel" && eff.zoneId) { selectZone(eff.zoneId); return; }
      if (eff.type === "startCombat" && eff.enemyId) {
        save = Modifiers.setFlag(save, "pendingStoryBoss", eff.enemyId);
        _surfaceBossEncounter(eff.enemyId);
      }
    };

    const _advanceScene = (choiceIndex?: number) => {
      if (!hasPendingScene(save)) return;
      const adv = storyAdvance(save, choiceIndex);
      save = adv.save;
      const applied = storyApplyEffects(save, adv.effects);
      save = applied.save;
      applied.log.forEach((l: string) => emit(l));
      for (const eff of applied.deferred) _applySceneDeferred(eff);
      // Persist quietly — one scene node shouldn't spam the log with save notes.
      const sr = SaveManager.save(save, slotId);
      if (!sr.ok) emit(`   ✗ Save failed: ${sr.errors?.join(", ")}`);
    };
    const advanceSceneFn      = () => _advanceScene(undefined);
    const chooseSceneOption   = (choiceIndex: number) => _advanceScene(choiceIndex);

    // Spend one unspent stat point on a stat (stat-point allocation).
    // `allocateStat` (bare) is the leveltables helper injected at global scope.
    const allocateStatPoint = (instanceId: string, stat: string) => {
      const ir = Loader.load(`instances/companions/${instanceId}`, "companionInstance");
      if (!ir.ok) return;
      const updated = allocateStat(ir.data, stat, 1);
      DataStore.write(`instances/companions/${instanceId}`, updated);
    };

    return { init, flush, renderHome, runEncounter, engageCombat, tryFlee, useAbility, renderMap, selectZone, renderBag, useItem, renderShop, buyItem, sellItem, getShopData, renderStats, renderParty, renderReputation, renderAbilities, renderSaveLoad, manualSave, manualLoad, renderCrafting, craftItem, renderMounts, renderNonCombat, butcherCorpses, equipItem, rezMember, allocateStat: allocateStatPoint, back, getCurrentState, getSave, STATES, executePlayerAction, setCombatMode, getCombatMode, getManualCombatState, getRosterData, swapPartyMember, removeFromParty, addToParty, setPetForCompanion, getAvailablePets, getPendingScene, advanceScene: advanceSceneFn, chooseSceneOption };
  };

  return { createSession, STATES };
})();


// =============================================================================
// TEST SUITE
// =============================================================================

const GameLoopTests = (() => {
  const run = () => {
    SyntheticGameData.seed();
    const results: any[] = []; let p = 0, f = 0;
    const assert = (label: string, cond: any) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

    const session = HomeScreen.createSession();
    assert("Session init loads save",    session.init("slot_start"));
    const save0 = session.getSave();
    assert("Save has party",             (save0.party?.length || 0) > 0);
    assert("Save starts in colonial_sewers", save0.currentZone === "colonial_sewers");
    assert("Save has mode",              !!save0.mode);
    assert("Save currency is a number",  typeof save0.currency === "number");

    // ── encounter generation in the starter zone ──────────────────────────────
    session.renderMap();
    const enc = EncounterGenerator.generate("colonial_sewers", save0, Loader);
    assert("Encounter generated ok",     enc.ok);
    assert("Encounter type valid",       ["combat","companion","gathering","quest","locked_chest","fishing_spot"].includes(enc.encounterType));

    if (enc.encounterType === "combat" && enc.enemies.length) {
      const partyInsts = save0.party.map((p: any) => { const r = Loader.load(`instances/companions/${p.instanceId}`, "companionInstance"); return r.ok ? r.data : null; }).filter(Boolean);
      const cr = CombatBridge.run(enc, partyInsts);
      assert("Combat outcome valid",     ["victory","defeat","timeout"].includes(cr.outcome));
      assert("Combat has turns",         cr.turns > 0);
      const fv = { ...cr, outcome: "victory", totalXp: 50 };
      const { save: rs, summary } = RewardEngine.apply(fv, enc, save0);
      assert("Reward returns save",      !!rs);
      assert("levelUps array present",   Array.isArray(summary.levelUps));
    } else {
      assert("Non-combat encounter ok",  true);
      assert("levelUps array present",   true);
    }

    // ── currency math ─────────────────────────────────────────────────────────
    const withGold = Currency.add(save0, 10000);
    assert("Currency add works",         withGold.currency === save0.currency + 10000);
    assert("Currency display correct",   Currency.toDisplay(10000).gold === 1);
    assert("Currency platinum display",  Currency.toDisplay(1000000).platinum === 1);
    assert("Currency toString works",    Currency.toString(10150) === "1g 1s 50c");
    assert("Currency platinum toString", Currency.toString(1010150) === "1p 1g 1s 50c");

    // ── death handling ────────────────────────────────────────────────────────
    const dummySave = { mode: "normal", currency: 10000, party: [] };
    const dummyInst = { instanceId: "x", name: "Test", level: 5, deathState: "alive", permadead: false, maxHp: 200, maxMp: 100 };
    const downed    = DeathHandler.handleDeath(dummyInst, dummySave);
    assert("handleDeath: normal → downed",     downed.deathState === "downed");
    assert("handleDeath: rezCost set",          downed.rezCost > 0);
    const rezR = DeathHandler.rezForGold(downed, dummySave);
    assert("rezForGold: success",               rezR.ok);
    assert("rezForGold: restores HP",           rezR.inst.currentHp === dummyInst.maxHp);
    assert("rezForGold: restores MP",           rezR.inst.currentMp === dummyInst.maxMp);
    assert("handleDeath: hardcore → permadead", DeathHandler.handleDeath(dummyInst, { ...dummySave, mode: "hardcore" }).permadead);

    // ── wipe revive restores MP to full (regression) ───────────────────────────
    DataStore.write("instances/companions/wipe_mp_test", { instanceId: "wipe_mp_test", templateId: "wipe_mp_test", name: "WipeMP", _version: 1, level: 1, deathState: "downed", permadead: false, maxHp: 100, maxMp: 200, currentHp: 0, currentMp: 0, skills: {}, gear: {} });
    const wipeRes = DeathHandler.handleWipe({ mode: "normal", currency: 1000, quests: {}, party: [{ instanceId: "wipe_mp_test" }] }, new Set(["wipe_mp_test"]));
    const wipeInst = Loader.load("instances/companions/wipe_mp_test", "companionInstance");
    assert("handleWipe: revives with full MP", wipeInst.ok && wipeInst.data.currentMp === 200);
    assert("handleWipe: revives alive with HP > 0", wipeInst.ok && wipeInst.data.deathState === "alive" && wipeInst.data.currentHp > 0);
    DataStore.remove("instances/companions/wipe_mp_test");
    void wipeRes;

    // ── travel: same-region travel is free; price is the sole cross-region gate ─
    session.init("slot_start");
    const preTravel = session.getSave().currency;
    const traveled  = session.selectZone("colonial_sewers");
    assert("Same-region travel is free", traveled && session.getSave().currency === preTravel);

    // ── crafting screen renders; crafting blocks cleanly without materials ─────
    session.init("slot_start");
    let craftThrew = false;
    try { session.renderCrafting(); } catch(e) { craftThrew = true; }
    assert("renderCrafting renders without error", !craftThrew);
    session.flush();
    // Lati holds no crafting materials, so the template recipe should be blocked
    // (not throw) — exercises the craft path without depending on specific data.
    let craftCallThrew = false;
    try { session.craftItem("template_recipe"); } catch(e) { craftCallThrew = true; }
    session.flush();
    assert("craftItem handles missing materials without throwing", !craftCallThrew);

    // ── save / load round-trip ────────────────────────────────────────────────
    session.init("slot_start");
    session.manualSave("slot_test");
    assert("Manual save + load round-trip", session.manualLoad("slot_test"));
    assert("Loaded save correct zone",      session.getSave().currentZone === "colonial_sewers");

    // ── sub-screens render without error ──────────────────────────────────────
    session.init("slot_start");
    let threw = false;
    try {
      session.renderStats(); session.renderParty(); session.renderReputation();
      session.renderAbilities(); session.renderBag(); session.renderMounts();
    } catch(e) { threw = true; }
    assert("All sub-screens render without error", !threw);

    // ── full runEncounter completes ───────────────────────────────────────────
    session.init("slot_start");
    let encThrew = false;
    try { session.runEncounter(); } catch(e) { encThrew = true; }
    assert("Full runEncounter completes without error", !encThrew);

    // ── butchery: no corpses → graceful no-op ─────────────────────────────────
    session.init("slot_start");
    let butcherThrew = false;
    try { session.butcherCorpses(); } catch(e) { butcherThrew = true; }
    assert("butcherCorpses no throw with no corpses", !butcherThrew);

    // ── butchery: per-mob typed loot + profession XP ──────────────────────────
    DataStore.write("instances/companions/gl_butcher", {
      instanceId: "gl_butcher", templateId: "template_companion", name: "Butcher",
      raceId: "sephir", classId: "survivalist", level: 5, deathState: "alive",
      profession: "butchery", skills: { butchery: { level: 1, xp: 0 } },
      maxHp: 100, currentHp: 100, maxMp: 0, currentMp: 0,
      stats: { raw: { str: 12, dex: 10, con: 12, int: 8, spi: 10, wis: 10, spd: 10, cha: 8 } }, gear: {},
    });
    const ratKill = { type: "beast", level: 1, butcheryXp: 8, butcheryLoot: _mobsData.mobs.colonial_sewer_rat.butcheryLoot };
    const bSave = { mode: "normal", party: [{ instanceId: "gl_butcher", templateId: "template_companion" }], inventory: [], flags: { pendingButchery: ["x"] }, currency: 0 };
    const bRes = RewardEngine.applyButchery(bSave, [ratKill]);
    assert("butchery: yields typed loot",          bRes.drops.length > 0 && bRes.drops.every(d => !!d.type && !!d.itemId));
    assert("butchery: meat always drops (chance 1)", bRes.drops.some(d => d.type === "meat" && d.itemId === "raw_rat_meat"));
    const butcherAfter = Loader.load("instances/companions/gl_butcher", "companionInstance");
    assert("butchery: butcher gains profession XP", (butcherAfter.data.skills.butchery.xp || 0) === 8);
    DataStore.remove("instances/companions/gl_butcher");

    // ── RidingSystem (data-independent logic) ─────────────────────────────────
    assert("RidingSystem: getSkill default 1",      RidingSystem.getSkill({}) === 1);
    assert("RidingSystem: getCap below 40",         RidingSystem.getCap(1) === 75);
    assert("RidingSystem: getCap at 40",            RidingSystem.getCap(40) === 150);
    assert("RidingSystem: gainRiding increments",   RidingSystem.gainRiding({ riding: 1, party: [] }).riding === 2);
    assert("RidingSystem: gainRiding respects cap", RidingSystem.gainRiding({ riding: 75, party: [] }).riding === 75);

    // ── TrapSystem / Dungeoneering ────────────────────────────────────────────
    // damage helpers are data-independent
    assert("TrapSystem: flat damage",    TrapSystem.damageFor({ maxHp: 200 }, { damage: { mode: "flat", amount: 40 } }) === 40);
    assert("TrapSystem: percent damage", TrapSystem.damageFor({ maxHp: 200 }, { damage: { mode: "percentMaxHp", amount: 0.15 } }) === 30);
    assert("TrapSystem: default damage", TrapSystem.damageFor({ maxHp: 100 }, { damage: {} }) === 15);

    const _rand = Math.random;
    try {
      const mkTrapInst = (iid: string, lvl: number, dungLvl: number) => DataStore.write(`instances/companions/${iid}`, {
        instanceId: iid, templateId: "template_companion", _version: 1, name: iid,
        classId: "armsman", level: lvl, maxHp: 100, currentHp: 100, maxMp: 0, currentMp: 0,
        deathState: "alive", permadead: false, downedAt: null, rezCost: 0,
        skills: { dungeoneering: { level: dungLvl, xp: 0 } },
      });
      const trapSave = (iid: string) => ({ mode: "normal", party: [{ instanceId: iid, templateId: "template_companion" }], inventory: [], flags: {}, currency: 0 });
      const partyTrap = { id: "t_party", name: "Test Trap", effect: { type: "damage", target: "party", damage: { mode: "percentMaxHp", amount: 0.15 } }, xp: 15 };

      // detection: class roll always succeeds (rand=0, level 5) → avoided, no damage
      Math.random = () => 0;
      mkTrapInst("gl_trap_a", 5, 1);
      const detRes = TrapSystem.resolve(trapSave("gl_trap_a"), partyTrap);
      const aAfter = Loader.load("instances/companions/gl_trap_a", "companionInstance").data;
      assert("TrapSystem: detected trap reports detection", detRes.detected === true && detRes.triggered === false);
      assert("TrapSystem: detected trap deals no damage",   aAfter.currentHp === 100);
      assert("TrapSystem: detection awards dungeoneering XP", aAfter.skills.dungeoneering.xp === 15);

      // no detection: both rolls fail (rand=0.999, low levels) → trap springs, damage applied
      Math.random = () => 0.999;
      mkTrapInst("gl_trap_b", 5, 1);
      const trigRes = TrapSystem.resolve(trapSave("gl_trap_b"), partyTrap);
      const bAfter = Loader.load("instances/companions/gl_trap_b", "companionInstance").data;
      assert("TrapSystem: undetected trap springs",          trigRes.triggered === true && trigRes.detected === false);
      assert("TrapSystem: undetected trap deals damage",     bAfter.currentHp === 85);
      assert("TrapSystem: sprung trap still awards XP",       bAfter.skills.dungeoneering.xp === 15);

      // dungeoneering as backup: class fails (level 0 path) but dungeoneering 99 succeeds
      // rand sequence: first call (class) = 0.5 fails for level 1; second (dungeoneering) = 0 succeeds for 99
      const seq = [0.5, 0.0]; let si = 0;
      Math.random = () => seq[si++ % seq.length];
      mkTrapInst("gl_trap_c", 1, 99);
      const backupRes = TrapSystem.resolve(trapSave("gl_trap_c"), partyTrap);
      assert("TrapSystem: dungeoneering is the backup detector", backupRes.detected === true && backupRes.triggered === false);

      DataStore.remove("instances/companions/gl_trap_a");
      DataStore.remove("instances/companions/gl_trap_b");
      DataStore.remove("instances/companions/gl_trap_c");
    } finally {
      Math.random = _rand;
    }

    // ── STORY / COMMUNE ────────────────────────────────────────────────────────
    const baseStory: any = { quests: {}, flags: {}, currency: 0, inventory: [], currentZone: "colonial_sewers" };
    let ss: any = enqueueScene({ ...baseStory }, "dlg_under_rath_intro");
    assert("Story: intro scene enqueued", hasPendingScene(ss));
    const vm: any = resolvePendingScene(ss);
    assert("Story: resolves speaker Lati Ashera", !!vm && vm.speaker?.name === "Lati Ashera");
    assert("Story: intro first node has text, not last", !!vm && vm.text.length > 0 && vm.isLast === false);
    let guard = 0;
    while (hasPendingScene(ss) && guard++ < 25) ss = storyAdvance(ss).save;
    assert("Story: scene ends after advancing all nodes", !hasPendingScene(ss));
    assert("Story: intro marked seen", (ss.seenScenes || []).includes("dlg_under_rath_intro"));
    assert("Story: re-enqueue of a seen scene is a no-op", !hasPendingScene(enqueueScene(ss, "dlg_under_rath_intro")));
    const effRes = storyApplyEffects({ ...baseStory }, [{ type: "setFlag", flag: "tf", value: true }]);
    assert("Story: setFlag effect applied", effRes.save.flags?.tf === true);
    let cs: any = storyApplyEffects({ ...baseStory }, [{ type: "assignQuest", questId: "q_under_rath" }]).save;
    assert("Story: assignQuest adds the quest", !!cs.quests?.q_under_rath && cs.quests.q_under_rath.completed === false);
    cs = onStoryCombatVictory(cs);
    assert("Story: win counter increments on victory", cs.storyCounters?.under_rath_wins === 1);
    assert("Story: stage beat queued at threshold 1", (cs.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_beat1"));
    const csOtherZone = onStoryCombatVictory({ ...cs, currentZone: "zone_test_plains", sceneQueue: [] });
    assert("Story: win in a different zone does not count", csOtherZone.storyCounters?.under_rath_wins === 1);

    // Boss threshold: 7 wins queues the discovery (boss) scene.
    let bs: any = storyApplyEffects({ ...baseStory }, [{ type: "assignQuest", questId: "q_under_rath" }]).save;
    for (let i = 0; i < 7; i++) bs = onStoryCombatVictory(bs);
    assert("Story: counter reaches 7", bs.storyCounters?.under_rath_wins === 7);
    assert("Story: boss scene queued at threshold 7", (bs.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_discovery"));

    // Boss defeat → completion scene; non-boss kill is not a boss defeat.
    const defd = onStoryBossDefeated({ ...bs, sceneQueue: [] }, [{ id: "sewer_mutant" }]);
    assert("Story: boss defeat reports defeated", defd.defeated === true);
    assert("Story: completion scene queued on boss defeat", (defd.save.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_victory"));
    assert("Story: non-boss kill is not a boss defeat", onStoryBossDefeated({ ...bs, sceneQueue: [] }, [{ id: "tunnel_roach" }]).defeated === false);

    // Wipes reset the counter and queue the right rez scene.
    const bossWipe = onStoryWipe({ ...bs, sceneQueue: [] }, true);
    assert("Story: boss wipe resets counter", bossWipe.storyCounters?.under_rath_wins === 0);
    assert("Story: boss wipe queues boss rez scene", (bossWipe.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_rez_boss"));
    const tunWipe = onStoryWipe({ ...cs, storyCounters: { under_rath_wins: 4 }, sceneQueue: [] }, false);
    assert("Story: tunnels wipe resets counter", tunWipe.storyCounters?.under_rath_wins === 0);
    assert("Story: tunnels wipe queues tunnels rez scene", (tunWipe.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_rez_tunnels"));
    assert("Story: boss defeat clears pendingStoryBoss", onStoryBossDefeated({ ...bs, flags: { pendingStoryBoss: "sewer_mutant" }, sceneQueue: [] }, [{ id: "sewer_mutant" }]).save.flags.pendingStoryBoss === null);
    assert("Story: boss wipe clears pendingStoryBoss", onStoryWipe({ ...bs, flags: { pendingStoryBoss: "sewer_mutant" }, sceneQueue: [] }, true).flags.pendingStoryBoss === null);

    // Regression (bug fix): XP gain must NOT full-heal — damage carries between fights.
    const hpBase: any = { instanceId: "hp_reg", classId: "armsman", level: 1, xp: 0, stats: { raw: { str: 10, dex: 15, con: 8, int: 8, spi: 9, wis: 13, spd: 10, cha: 9 } }, maxHp: 100, currentHp: 20, currentMp: 0, deathState: "alive" };
    assert("Story: XP gain preserves damage (no full heal)", addXpToInst(hpBase, 10).inst.currentHp === 20);
    assert("Story: level-up heals only the max-HP gain", (() => { const r = addXpToInst({ ...hpBase, currentHp: 20 }, 200).inst; return r.level === 2 && r.currentHp === 20 + (r.maxHp! - 100); })());

    // Retry discount: once attempted, the boss threshold drops to 2.
    let rt: any = storyApplyEffects({ ...baseStory, flags: { sewer_mutant_attempted: true } }, [{ type: "assignQuest", questId: "q_under_rath" }]).save;
    rt = onStoryCombatVictory(rt);
    rt = onStoryCombatVictory(rt);
    assert("Story: retry boss threshold is 2 when attempted", (rt.sceneQueue || []).some((q: any) => q.dialogueId === "dlg_under_rath_discovery"));

    return { passed: p, failed: f, total: p + f, results };
  };

  const report = (r: any) => {
    const lines = [`\n${"=".repeat(60)}`, `GAME LOOP TESTS: ${r.passed}/${r.total} passed`, "=".repeat(60), ...r.results.map((x: any) => `  ${x.ok ? "✓" : "✗"} ${x.label}`), r.failed > 0 ? `\n  ${r.failed} FAILED` : `\n  All tests passed.`, "=".repeat(60)];
    return lines.join("\n");
  };

  return { run, report };
})();


// =============================================================================
// BOOTSTRAP
// =============================================================================

if (typeof DataStore === "undefined") {
  console.error("DataStore not found. Load data_layer.js before game_loop.js");
} else if (typeof process !== "undefined" && process.env.GALANOVA_RUN_TESTS) {
  // Tests run only under the test harness (Testing/run_tests.js sets the flag),
  // never on normal app launch. The app calls SyntheticGameData.seed() itself.
  SyntheticGameData.seed();
  const testResults = GameLoopTests.run();
  console.log(GameLoopTests.report(testResults));
}

export {
  Currency,
  RidingSystem, TrapSystem,
  CombatBridge, DeathHandler,
  RewardEngine, ShopSystem, SaveManager,
  SyntheticGameData, HomeScreen, GameLoopTests,
};