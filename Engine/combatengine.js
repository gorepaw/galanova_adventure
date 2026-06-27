// =============================================================================
// COMBAT ENGINE — Kalimdor RPG
// Pure simulation. No UI. No DOM. No rendering.
//
// PRIMARY API:
//   processTurn(state, actions) => { state, logs }
//   actions: Array<{ actorId, abilityId, targetId }> — one per acting party member
//
// To start a combat:
//   const state = createGameState({ partyConfigs, enemyConfigs });
//
// DEPENDENCIES: Data/classes.json
//
// NOTE ON AUTOBATTLE:
//   This engine is manual turn-based. The caller supplies actions each turn.
//   Any auto-run / AI-vs-AI loop belongs in a wrapper layer (UI or playtesting),
//   not here.
// =============================================================================

"use strict";

const _classData     = require('../Data/classes.json');
const _abilitiesData = require('../Data/abilities.json');
const _mobsData      = require('../Data/mobs.json');

// =============================================================================
// DATA — races and classes (loaded from Data/classes.json)
// =============================================================================

const RACES   = _classData.races;
const CLASSES = _classData.classes;


// =============================================================================
// DATA — passive hooks registry
// =============================================================================

const PASSIVE_HOOKS = {
  rage_on_hit: (unit, ctx) => {
    const rage = ctx.damageDone ? Math.floor(ctx.damageDone / 5) : 0;
    return { resourceDelta: { rage }, logs: rage > 0 ? [`${unit.name} generates ${rage} rage`] : [] };
  },
  rage_on_being_hit: (unit, ctx) => {
    const rage = ctx.damageTaken ? Math.floor(ctx.damageTaken / 4) : 0;
    return { resourceDelta: { rage }, logs: rage > 0 ? [`${unit.name} generates ${rage} rage from being hit`] : [] };
  },
  combo_on_hit: (unit, _ctx) => ({
    resourceDelta: { combo_points: 1 }, logs: [`${unit.name} generates 1 combo point`],
  }),
  holy_on_being_hit: (unit, ctx) => {
    if (Math.random() >= 0.1) return { logs: [] };
    const heal = Math.floor((ctx.damageTaken || 0) * 0.1);
    return { healSelf: heal, logs: heal > 0 ? [`${unit.name} procs Holy for ${heal} heal`] : [] };
  },
  berserking: (unit, _ctx) => {
    const pct   = unit.hp / unit.maxHp;
    const bonus = pct < 0.4 ? 0.3 : pct < 0.7 ? 0.2 : 0.1;
    return { tempDamageMod: bonus, logs: [`${unit.name} Berserking: +${Math.round(bonus*100)}% damage`] };
  },
  regeneration: (unit, _ctx) => ({
    healSelf: Math.floor(unit.maxHp * 0.01), logs: [],
  }),
  endurance: (unit, _ctx) => ({
    statBonus: { sta: Math.floor(unit.stats.raw.sta * 0.05) }, logs: [],
  }),
  hardiness: (_unit, ctx) => {
    const resisted = ctx.ccApplied && Math.random() < 0.25;
    return { ccResisted: resisted, logs: resisted ? ["Hardiness: CC resisted"] : [] };
  },
  quickness: (_unit, ctx) => {
    const dodged = ctx.incomingPhysical && Math.random() < 0.01;
    return { dodge: dodged, logs: dodged ? ["Quickness: dodged"] : [] };
  },
  nature_resistance:      (_u, _c) => ({ resistBonus: { nature: 10 }, logs: [] }),
  shadow_resistance:      (_u, _c) => ({ resistBonus: { shadow: 10 }, logs: [] }),
  gift_of_the_naaru:      (u,  _c) => ({ healSelf: Math.floor(u.maxHp * 0.02), logs: [`${u.name}: Gift of the Naaru`] }),
  heroic_presence:        (_u, _c) => ({ statBonus: { int: 2 }, logs: [] }),
  blood_fury:             (u,  ctx) => ctx.activated ? { tempDamageMod: 0.25, logs: [`${u.name}: Blood Fury +25% dmg`] } : { logs: [] },
  axe_specialization:     (_u, _c) => ({ statBonus: { str: 1 }, logs: [] }),
  beast_slaying:          (_u, ctx) => {
    const b = ctx.targetType === "beast" ? 0.05 : 0;
    return { tempDamageMod: b, logs: b > 0 ? ["Beast Slaying: +5% dmg"] : [] };
  },
  war_stomp:              (_u, _c) => ({ logs: [] }),
  cultivation:            (_u, _c) => ({ logs: [] }),
  rocket_jump:            (_u, _c) => ({ logs: [] }),
  best_deals:             (_u, _c) => ({ logs: [] }),
  alchemy_specialization: (_u, _c) => ({ logs: [] }),
  shadowmeld:             (_u, _c) => ({ logs: [] }),
};


// =============================================================================
// DATA — abilities (loaded from Data/abilities.json)
// =============================================================================

const ABILITIES = _abilitiesData.abilities;


// =============================================================================
// DATA — buffs / debuffs (loaded from Data/abilities.json)
// =============================================================================

const BUFF_DEFS = _abilitiesData.buffs;


// =============================================================================
// DATA — enemy definitions (loaded from Data/mobs.json)
// =============================================================================

const ENEMY_DEFS = _mobsData.mobs;


// =============================================================================
// DATA — AI profiles
// =============================================================================

const AI_PROFILES = {
  aggressive: { id: "aggressive", targetStrategy: "lowest_hp_party",    abilityStrategy: "weighted_damage" },
  healer:     { id: "healer",     targetStrategy: "lowest_hp_ally",      abilityStrategy: "prefer_heal" },
  random:     { id: "random",     targetStrategy: "random_party_member", abilityStrategy: "random" },
};


// =============================================================================
// MODULE — stat derivation
// =============================================================================

const StatSystem = (() => {
  const derive = (raw, level = 1) => ({
    maxHp:              raw.con * 10,
    maxMana:            raw.int * 15,
    attackPower:        raw.str * 2 + raw.dex,
    rangedAttackPower:  Math.max(0, 2 * level + 2 * raw.dex - 10),
    spellPower:         0,
    armor:              raw.dex * 2,
    critChanceMelee:    raw.dex / 20 / 100,
    critChanceSpell:    raw.int / 60 / 100,
    // dodge is sourced from spd (1 pt = 0.05%); dex no longer grants dodge
    dodge:              (raw.spd || 0) / 20 / 100,
    manaRegen:          Math.floor(raw.spi / 5),
    // wis grants +0.5 resistance per point to every non-physical school
    resistances:        (() => {
      const rv = (raw.wis || 0) * 0.5;
      return { pyro: rv, cryo: rv, nature: rv, chaos: rv, order: rv, bio: rv, energy: rv, psychic: rv };
    })(),
    critMultiplier:     2.0,
  });

  const buildUnitStats = (raceId, classId) => {
    const cls = CLASSES[classId];
    if (!cls) throw new Error(`Unknown class: ${classId}`);
    // Races are decoupled from stats; a generic unit starts from the class's
    // level-1 startingBaseline (player instances carry their own allocated raw).
    const raw = {};
    for (const s of ["str","dex","con","int","spi","wis","spd","cha"])
      raw[s] = (cls.startingBaseline?.[s] || 0);
    return { raw, derived: derive(raw) };
  };

  const applyBuffModifiers = (derived, buffs) => {
    const r = { ...derived, resistances: { ...derived.resistances } };
    for (const b of buffs) {
      const m = b.modifiers || {};
      const s = b.stacks || 1;
      if (m.attackPower)  r.attackPower     = (r.attackPower     || 0) + m.attackPower * s;
      if (m.spellPower)   r.spellPower      = (r.spellPower      || 0) + m.spellPower;
      if (m.armor)        r.armor           = (r.armor           || 0) + m.armor * s;
      if (m.maxHpBonus)   r.maxHp           = (r.maxHp           || 0) + m.maxHpBonus;
      // legacy unified critChance key — kept for backward compat with old buff defs
      if (m.critChance)  { r.critChanceMelee = (r.critChanceMelee || 0) + m.critChance; r.critChanceSpell = (r.critChanceSpell || 0) + m.critChance; }
      // split crit keys (canonical going forward)
      if (m.meleeCrit)    r.critChanceMelee = (r.critChanceMelee || 0) + m.meleeCrit;
      if (m.spellCrit)    r.critChanceSpell = (r.critChanceSpell || 0) + m.spellCrit;
      for (const school of ["pyro","cryo","nature","chaos","order","bio","energy","psychic"])
        if (m[`resist_${school}`]) r.resistances[school] += m[`resist_${school}`];
    }
    return r;
  };

  // Applies equipped gear stat bonuses to a raw stat block.
  // Raw stat bonuses (str/dex/con/int/spi/wis/spd/cha) are added before derivation.
  // cha is carried but has no combat derive (social/economy stat).
  // Flat bonuses (attackPower/spellPower/armor/meleeCrit/spellCrit) are
  // injected as a synthetic buff entry so applyBuffModifiers handles them.
  const applyGearBonuses = (rawStats, gear) => {
    if (!gear) return { raw: rawStats, gearBuff: null };
    const raw = { ...rawStats };
    const flatMods = {};
    for (const item of Object.values(gear)) {
      if (!item?.statBonuses) continue;
      const b = item.statBonuses;
      if (b.str)         raw.str         = (raw.str         || 0) + b.str;
      if (b.dex)         raw.dex         = (raw.dex         || 0) + b.dex;
      if (b.con)         raw.con         = (raw.con         || 0) + b.con;
      if (b.int)         raw.int         = (raw.int         || 0) + b.int;
      if (b.spi)         raw.spi         = (raw.spi         || 0) + b.spi;
      if (b.wis)         raw.wis         = (raw.wis         || 0) + b.wis;
      if (b.spd)         raw.spd         = (raw.spd         || 0) + b.spd;
      if (b.cha)         raw.cha         = (raw.cha         || 0) + b.cha;
      if (b.attackPower) flatMods.attackPower = (flatMods.attackPower || 0) + b.attackPower;
      if (b.spellPower)  flatMods.spellPower  = (flatMods.spellPower  || 0) + b.spellPower;
      if (b.armor)       flatMods.armor       = (flatMods.armor       || 0) + b.armor;
      if (b.meleeCrit)   flatMods.meleeCrit   = (flatMods.meleeCrit   || 0) + b.meleeCrit;
      if (b.spellCrit)   flatMods.spellCrit   = (flatMods.spellCrit   || 0) + b.spellCrit;
    }
    // wrap flat bonuses as a synthetic buff so applyBuffModifiers picks them up
    const gearBuff = Object.keys(flatMods).length
      ? { id: "_gear", modifiers: flatMods, ccFlags: {} }
      : null;
    return { raw, gearBuff };
  };

  return { buildUnitStats, derive, applyBuffModifiers };
})();


// =============================================================================
// MODULE — game state factory
// =============================================================================

const createGameState = ({ partyConfigs, enemyConfigs }) => {
  if (!partyConfigs || partyConfigs.length < 1 || partyConfigs.length > 5)
    throw new Error("Party must be 1–5 members");

  const buildUnit = (cfg, isEnemy = false) => {
    const defId = cfg.enemyDefId;
    const def   = defId ? ENEMY_DEFS[defId] : null;

    const raceId  = cfg.raceId  || def?.raceId  || "orc";
    const classId = cfg.classId || def?.classId || "warrior";
    const cls     = CLASSES[classId];
    const race    = RACES[raceId];

    // For enemies defined in ENEMY_DEFS, use their baseStats directly rather
    // than deriving from race+class contribution, so HP matches the template.
    const baseRaw = (def?.baseStats) ? def.baseStats : (() => {
      const { raw } = StatSystem.buildUnitStats(raceId, classId);
      return raw;
    })();

    const level = cfg.level || def?.level || 1;

    // Apply gear stat bonuses (raw stats first, flat bonuses as synthetic buff)
    const { raw: rawStats, gearBuff } = StatSystem.applyGearBonuses(baseRaw, cfg.gear);
    const derived      = StatSystem.derive(rawStats, level);
    const baseMaxHp    = derived.maxHp + (cls?.baseHp || 0);
    const maxHp        = (def?.tags || []).includes("elite") ? Math.round(baseMaxHp * 2.5) : baseMaxHp;
    const maxMana      = derived.maxMana + (cls?.baseMana  || 0);

    const resources = {};
    for (const r of (cls?.resources || ["mana"])) {
      if (r === "mana")         resources.mana         = { current: maxMana, max: maxMana };
      if (r === "rage")         resources.rage         = { current: 0, max: 100 };
      if (r === "stamina")      resources.stamina      = { current: 100, max: 100 };
      if (r === "combo_points") resources.combo_points = { current: 0, max: 5 };
    }

    return {
      id:           cfg.id || `unit_${Math.random().toString(36).slice(2,8)}`,
      threatTable:  {},
      name:         cfg.name || def?.name || `${race?.name || raceId} ${cls?.name || classId}`,
      raceId,
      classId,
      level,
      unitType:     cfg.unitType || def?.type || "humanoid",
      hp:           cfg.currentHp || maxHp,
      maxHp,
      stats:        { raw: rawStats, derived },
      resources,
      cooldowns:    {},
      castQueue:    [],
      buffs:        [],
      debuffs:      [],
      ccState:      { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false },
      passiveHooks: [...(cls?.passiveHooks || []), ...(race?.racialPassives || [])],
      abilities:    cfg.abilities || def?.abilities || [],
      aiProfile:    cfg.aiProfile || def?.aiProfile || "aggressive",
      shieldEquipped:           !!(cfg.gear?.offhand?.itemType === "shield" || cfg.shieldEquipped),
      damageReceivedThisTurn:   0,
      damageReceivedLastTurn:   0,
      alive:        true,
      isEnemy,
      // carry through any extra fields (instanceId, templateId, etc.)
      ...(cfg.extra || {}),
    };
  };

  return {
    turn:                   0,
    combatOver:             false,
    outcome:                null,
    priorEncounterVictory:  false,
    party:      partyConfigs.map((c, i) => buildUnit({ id: `party_${i}`, ...c }, false)),
    enemies:    enemyConfigs.map((c, i) => buildUnit({ id: `enemy_${i}`, ...c }, true)),
    logs:       [],
  };
};


// =============================================================================
// MODULE — threat system
// =============================================================================

const ThreatSystem = (() => {
  const addThreat = (unit, enemyId, amount) => {
    const current = unit.threatTable[enemyId] || 0;
    return { ...unit, threatTable: { ...unit.threatTable, [enemyId]: current + amount } };
  };

  const addHealThreat = (unit, enemies, amount) => {
    const living = enemies.filter(e => e.alive);
    if (!living.length) return unit;
    const split = amount * 0.5 / living.length;
    let updated = unit;
    for (const e of living) updated = addThreat(updated, e.id, split);
    return updated;
  };

  const getHighestThreat = (enemyId, party) => {
    const living = party.filter(u => u.alive);
    if (!living.length) return null;
    return living.reduce((top, u) => {
      const t = u.threatTable[enemyId] || 0;
      return t > (top.threatTable[enemyId] || 0) ? u : top;
    }, living[0]);
  };

  const clearThreat = (unit) => ({ ...unit, threatTable: {} });

  return { addThreat, addHealThreat, getHighestThreat, clearThreat };
})();


// =============================================================================
// MODULE — targeting
// =============================================================================

const TargetingSystem = (() => {
  const getLiving = (arr) => arr.filter(u => u.alive);

  const resolve = (targeting, actor, state, opts = {}) => {
    const actorIsEnemy = actor.isEnemy;
    const friendlies   = getLiving(actorIsEnemy ? state.enemies : state.party);
    const hostiles     = getLiving(actorIsEnemy ? state.party   : state.enemies);

    switch (targeting) {
      case "self":           return [actor];
      case "single_enemy": {
        const preferred = opts.targetId ? hostiles.filter(u => u.id === opts.targetId) : [];
        return preferred.length ? preferred : hostiles.slice(0, 1);
      }
      case "single_ally": {
        const preferred = opts.targetId ? friendlies.filter(u => u.id === opts.targetId) : [];
        return preferred.length ? preferred : friendlies.slice(0, 1);
      }
      case "all_enemies":       return hostiles;
      case "all_allies":        return friendlies;
      case "random_enemy":      return hostiles.length  ? [hostiles[Math.floor(Math.random()  * hostiles.length)]]  : [];
      case "random_ally":       return friendlies.length? [friendlies[Math.floor(Math.random()* friendlies.length)]]: [];
      case "lowest_hp_enemy": {
        const s = [...hostiles].sort((a,b) => (a.hp/a.maxHp) - (b.hp/b.maxHp));
        return s.slice(0, 1);
      }
      case "lowest_hp_ally": {
        const s = [...friendlies].sort((a,b) => (a.hp/a.maxHp) - (b.hp/b.maxHp));
        return s.slice(0, 1);
      }
      case "cleave": {
        // Primary target + 1-2 random additional enemies
        const preferred = opts.targetId ? hostiles.filter(u => u.id === opts.targetId) : [];
        const primary   = preferred.length ? preferred : hostiles.slice(0, 1);
        if (!primary.length) return [];
        const others     = hostiles.filter(u => u.id !== primary[0].id);
        const extraCount = Math.min(others.length, Math.floor(Math.random() * 2) + 1);
        const shuffled   = [...others].sort(() => Math.random() - 0.5);
        return [...primary, ...shuffled.slice(0, extraCount)];
      }
      default: return [];
    }
  };

  return { resolve };
})();


// =============================================================================
// MODULE — damage
// =============================================================================

const DamageSystem = (() => {
  const resistFrac = (r) => Math.min(r / (r + 400), 0.75);

  const rollDamage = (effect, attacker, target) => {
    // attacker debuffs (e.g. Demoralizing Shout) reduce their own effective stats
    const aDerived = StatSystem.applyBuffModifiers(attacker.stats.derived, [...attacker.buffs, ...attacker.debuffs]);
    const tDerived = StatSystem.applyBuffModifiers(target.stats.derived, [...target.buffs, ...target.debuffs]);

    let base = effect.flatBonus || 0;

    if (effect.scaling === "ap") {
      const mainhand   = attacker.gear?.mainhand;
      const weaponRoll = (mainhand?.minDamage != null && mainhand?.maxDamage != null && mainhand?.weaponSpeed)
        ? (mainhand.minDamage + Math.random() * (mainhand.maxDamage - mainhand.minDamage)) / mainhand.weaponSpeed
        : 0;
      base += weaponRoll + (aDerived.attackPower || 0) * (effect.multiplier || 1);
    }
    if (effect.scaling === "rap") {
      const ranged     = attacker.gear?.ranged;
      const weaponRoll = (ranged?.minDamage != null && ranged?.maxDamage != null && ranged?.weaponSpeed)
        ? (ranged.minDamage + Math.random() * (ranged.maxDamage - ranged.minDamage)) / ranged.weaponSpeed
        : 0;
      base += weaponRoll + (aDerived.rangedAttackPower || 0) * (effect.multiplier || 1);
    }
    if (effect.scaling === "sp")  base += (aDerived.spellPower  || 0) * (effect.multiplier || 1);
    if (effect.scaling === "combo") {
      const cp         = attacker.resources.combo_points?.current || 0;
      const mainhand   = attacker.gear?.mainhand;
      const weaponRoll = (mainhand?.minDamage != null && mainhand?.maxDamage != null && mainhand?.weaponSpeed)
        ? (mainhand.minDamage + Math.random() * (mainhand.maxDamage - mainhand.minDamage)) / mainhand.weaponSpeed
        : 0;
      base += weaponRoll
            + (aDerived.attackPower || 0) * (effect.multiplier || 1)
            + cp * ((aDerived.attackPower || 0) * (effect.comboMultiplier || 0.3));
    }

    const critChance = effect.damageType === "physical" ? aDerived.critChanceMelee : aDerived.critChanceSpell;
    const hasGuaranteedCrit = effect.damageType === "physical"
      && attacker.buffs.some(b => b.modifiers?.guaranteedMeleeCrit);
    const isCrit = hasGuaranteedCrit || Math.random() < (critChance || 0);
    if (isCrit) base *= (aDerived.critMultiplier || 2);

    if (effect.damageType === "physical") {
      const armor         = Math.max(0, tDerived.armor || 0);
      const armorConstant = 400 + 85 * (attacker.level || 1);
      base *= (1 - Math.min(0.75, armor / (armor + armorConstant)));
    } else {
      const resist = tDerived.resistances?.[effect.damageType] || 0;
      base *= (1 - resistFrac(resist));
    }

    // damageDoneMultiplier applies from attacker's own buffs AND debuffs
    let doneMult = 1;
    for (const b of [...attacker.buffs, ...attacker.debuffs])
      if (b.modifiers?.damageDoneMultiplier) doneMult *= b.modifiers.damageDoneMultiplier;
    base *= doneMult;

    let takenMult = 1;
    for (const b of [...target.buffs, ...target.debuffs])
      if (b.modifiers?.damageTakenMultiplier) takenMult *= b.modifiers.damageTakenMultiplier;
    base *= takenMult;

    let shieldAbsorb = 0;
    for (const b of target.buffs) if (b.modifiers?.damageShield) shieldAbsorb += b.modifiers.damageShield;

    const finalDmg = Math.max(0, Math.floor(base) - shieldAbsorb);

    // legacy fractional reflect
    let reflected = 0;
    for (const b of target.buffs) if (b.modifiers?.reflectDamage) reflected += Math.floor(finalDmg * b.modifiers.reflectDamage);

    // Spell Reflection: full reflect on next non-physical spell, consume charge
    let spellReflected = false;
    if (effect.damageType !== "physical") {
      const reflIdx = target.buffs.findIndex(b => b.modifiers?.reflectNextSpell && (b.charges ?? 1) > 0);
      if (reflIdx >= 0) spellReflected = true;
    }

    // Retaliation: counter on physical hit
    const hasRetaliation = effect.damageType === "physical"
      && target.buffs.some(b => b.modifiers?.retaliation);

    return { damage: spellReflected ? 0 : finalDmg, isCrit, reflected, spellReflected, hasRetaliation };
  };

  return { rollDamage };
})();


// =============================================================================
// MODULE — healing
// =============================================================================

const HealingSystem = (() => {
  const rollHeal = (effect, caster) => {
    const d    = StatSystem.applyBuffModifiers(caster.stats.derived, caster.buffs);
    let base   = effect.flatBonus || 0;
    if (effect.scaling === "sp") base += (d.spellPower  || 0) * (effect.multiplier || 1);
    if (effect.scaling === "ap") base += (d.attackPower || 0) * (effect.multiplier || 0.3);

    const isCrit = Math.random() < (d.critChanceSpell || 0);
    if (isCrit) base *= 1.5;

    let doneMult = 1;
    for (const b of caster.buffs) if (b.modifiers?.healingDoneMultiplier) doneMult *= b.modifiers.healingDoneMultiplier;
    base *= doneMult;

    return { heal: Math.floor(base), isCrit };
  };

  return { rollHeal };
})();


// =============================================================================
// MODULE — resources
// =============================================================================

const ResourceSystem = (() => {
  const canAfford = (unit, cost) => {
    for (const [res, amt] of Object.entries(cost))
      if (!(unit.resources[res]?.current >= amt)) return false;
    return true;
  };

  const spend = (unit, cost) => {
    const r = { ...unit.resources };
    for (const [res, amt] of Object.entries(cost))
      if (r[res]) r[res] = { ...r[res], current: r[res].current - amt };
    return { ...unit, resources: r };
  };

  const generate = (unit, gains) => {
    const r = { ...unit.resources };
    for (const [res, amt] of Object.entries(gains))
      if (r[res]) r[res] = { ...r[res], current: Math.min(r[res].max, r[res].current + amt) };
    return { ...unit, resources: r };
  };

  const tickRegen = (unit) => {
    const r = { ...unit.resources };
    if (r.stamina) r.stamina = { ...r.stamina, current: Math.min(r.stamina.max, r.stamina.current + 15) };
    if (r.mana)   r.mana   = { ...r.mana,   current: Math.min(r.mana.max,   r.mana.current + (unit.stats.derived.manaRegen || 0)) };
    return { ...unit, resources: r };
  };

  const decrementCooldowns = (unit) => {
    const cd = { ...unit.cooldowns };
    for (const id of Object.keys(cd)) {
      cd[id] = Math.max(0, cd[id] - 1);
      if (cd[id] === 0) delete cd[id];
    }
    return { ...unit, cooldowns: cd };
  };

  const setCooldown = (unit, abilityId, turns) => {
    if (!turns) return unit;
    return { ...unit, cooldowns: { ...unit.cooldowns, [abilityId]: turns } };
  };

  const spendComboPoints = (unit) => {
    if (!unit.resources.combo_points) return unit;
    return { ...unit, resources: { ...unit.resources, combo_points: { ...unit.resources.combo_points, current: 0 } } };
  };

  return { canAfford, spend, generate, tickRegen, decrementCooldowns, setCooldown, spendComboPoints };
})();


// =============================================================================
// MODULE — buff system
// =============================================================================

const BuffSystem = (() => {
  const isDebuffInstance = (inst) =>
    Object.values(inst.ccFlags || {}).some(Boolean) || !!inst.tickDamage || !!inst.isDebuff;

  const applyBuff = (unit, buffId, sourceId, overrides = {}) => {
    const def = BUFF_DEFS[buffId];
    if (!def) return unit;

    const inst = {
      id:         buffId,
      sourceId,
      duration:   overrides.duration ?? def.duration,
      stacks:     1,
      charges:    overrides.charges ?? (def.charges ?? null),
      isDebuff:   def.isDebuff || false,
      modifiers:  { ...(def.modifiers || {}) },
      ccFlags:    { ...(def.ccFlags   || {}) },
      tickDamage: def.tickDamage ? { ...def.tickDamage } : null,
      tickRage:   def.tickRage   ?? null,
      tickHeal:   def.tickHeal   ? { ...def.tickHeal }   : null,
    };

    const field    = isDebuffInstance(inst) ? "debuffs" : "buffs";
    const defMaxStacks = def.stacks ? (def.maxStacks || 99) : 1;
    const existIdx = unit[field].findIndex(b => b.id === buffId);
    let newList;
    if (existIdx >= 0) {
      newList = unit[field].map((b, i) => i === existIdx
        ? { ...b, duration: inst.duration, stacks: Math.min(defMaxStacks, b.stacks + 1) }
        : b);
    } else {
      newList = [...unit[field], inst];
    }

    const ccState = { ...unit.ccState };
    for (const [f, v] of Object.entries(inst.ccFlags)) if (v) ccState[f] = true;

    // commanding_shout_buff: grant bonus HP immediately when applied
    let hp = unit.hp, maxHp = unit.maxHp;
    if (def.modifiers?.maxHpBonus && existIdx < 0) {
      maxHp += def.modifiers.maxHpBonus;
      hp    += def.modifiers.maxHpBonus;
    }

    return { ...unit, [field]: newList, ccState, hp, maxHp };
  };

  const removeBuff = (unit, buffId) => ({
    ...unit,
    buffs:   unit.buffs.filter(b => b.id !== buffId),
    debuffs: unit.debuffs.filter(b => b.id !== buffId),
  });

  const tickBuffs = (unit) => {
    const logs = [];
    let updated = { ...unit };

    for (const effect of [...unit.buffs, ...unit.debuffs]) {
      // tick damage (DoTs)
      if (effect.tickDamage) {
        const td  = effect.tickDamage;
        let dmg   = td.flat || 0;
        if (td.scaling === "sp") dmg += (unit.stats.derived.spellPower  || 0) * (td.multiplier || 0);
        if (td.scaling === "ap") dmg += (unit.stats.derived.attackPower || 0) * (td.multiplier || 0);
        dmg = Math.max(1, Math.floor(dmg));
        updated = { ...updated, hp: Math.max(0, updated.hp - dmg) };
        logs.push(`${unit.name} takes ${dmg} ${td.damageType} from ${effect.id}`);
      }
      // tick rage (Bloodrage)
      if (effect.tickRage) {
        const rg = effect.tickRage;
        if (updated.resources.rage) {
          updated = { ...updated, resources: { ...updated.resources,
            rage: { ...updated.resources.rage, current: Math.min(updated.resources.rage.max, updated.resources.rage.current + rg) }
          }};
          logs.push(`${unit.name} regenerates ${rg} rage from ${effect.id}`);
        }
      }
      // tick heal (Enraged Regeneration)
      if (effect.tickHeal) {
        const th  = effect.tickHeal;
        let amt   = 0;
        if (th.scaling === "maxHp") amt = Math.floor((updated.maxHp || 0) * (th.multiplier || 0));
        amt = Math.max(1, amt);
        updated = { ...updated, hp: Math.min(updated.maxHp, updated.hp + amt) };
        logs.push(`${unit.name} regenerates ${amt} health from ${effect.id}`);
      }
    }
    return { unit: updated, logs };
  };

  const expireBuffs = (unit) => {
    const logs    = [];
    let maxHp = unit.maxHp;

    const process = (list) => list
      .map(b => ({ ...b, duration: b.duration - 1 }))
      .filter(b => {
        if (b.duration <= 0) {
          logs.push(`${b.id} fades from ${unit.name}`);
          // revert maxHp bonus on expiry
          if (b.modifiers?.maxHpBonus) maxHp -= b.modifiers.maxHpBonus;
          return false;
        }
        return true;
      });

    const newBuffs   = process(unit.buffs);
    const newDebuffs = process(unit.debuffs);

    const ccState = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
    for (const d of newDebuffs) for (const [f, v] of Object.entries(d.ccFlags || {})) if (v) ccState[f] = true;

    const hp = Math.min(unit.hp, maxHp);
    return { unit: { ...unit, buffs: newBuffs, debuffs: newDebuffs, ccState, maxHp, hp }, logs };
  };

  return { applyBuff, removeBuff, tickBuffs, expireBuffs };
})();


// =============================================================================
// MODULE — passive system
// =============================================================================

const PassiveSystem = (() => {
  const fireAll = (unit, context) => {
    const logs = [];
    let resourceDelta = {};
    let healSelf = 0;

    for (const hookId of (unit.passiveHooks || [])) {
      const hook = PASSIVE_HOOKS[hookId];
      if (!hook) continue;
      const result = hook(unit, context);
      logs.push(...(result.logs || []));
      if (result.resourceDelta)
        for (const [k, v] of Object.entries(result.resourceDelta))
          resourceDelta[k] = (resourceDelta[k] || 0) + v;
      if (result.healSelf)   healSelf += result.healSelf;
      if (result.dodge)      context.dodged     = true;
      if (result.ccResisted) context.ccResisted = true;
    }

    return { resourceDelta, healSelf, logs };
  };

  return { fireAll };
})();


// =============================================================================
// MODULE — effect dispatcher
// =============================================================================

const EffectDispatcher = (() => {
  const dispatch = (effect, caster, target, state, logs) => {
    let c = caster;
    let t = target;

    switch (effect.type) {
      case "damage": {
        // Dodge: physical attacks can be avoided by the target's dodge chance
        // (spd-derived + dodgeChance buff modifiers), capped at 75%. Magic ignores dodge.
        if (effect.damageType === "physical") {
          let dodgeChance = t.stats?.derived?.dodge || 0;
          for (const b of (t.buffs || [])) if (b.modifiers?.dodgeChance) dodgeChance += b.modifiers.dodgeChance;
          dodgeChance = Math.min(0.75, dodgeChance);
          if (dodgeChance > 0 && Math.random() < dodgeChance) {
            logs.push(`${t.name} dodges ${c.name}'s attack`);
            break;
          }
        }

        const { damage, isCrit, reflected, spellReflected, hasRetaliation } =
          DamageSystem.rollDamage(effect, c, t);

        if (spellReflected) {
          // reflect full damage to caster, target takes none
          logs.push(`${t.name} reflects the spell — ${c.name} takes ${damage} ${effect.damageType} damage`);
          c = { ...c, hp: Math.max(0, c.hp - damage) };
          // consume the spell reflection charge
          t = { ...t, buffs: t.buffs.map(b =>
            b.modifiers?.reflectNextSpell ? { ...b, charges: (b.charges ?? 1) - 1, duration: 0 } : b
          )};
          break;
        }

        // Intervene: redirect hit to the intervenor
        const interveneBuff = t.buffs.find(b => b.modifiers?.intervene && (b.charges ?? 1) > 0);
        if (interveneBuff) {
          const intervenor = [...(state.party || []), ...(state.enemies || [])]
            .find(u => u.id === interveneBuff.sourceId && u.alive);
          if (intervenor) {
            logs.push(`${c.name} hits ${t.name} for ${damage} — intercepted by ${intervenor.name}`);
            // We can only update t here; intervenor update returned as sideEffect
            t = { ...t, buffs: t.buffs.map(b =>
              b.modifiers?.intervene ? { ...b, charges: (b.charges ?? 1) - 1, duration: 0 } : b
            )};
            return { caster: c, target: t,
              sideEffects: [{ unitId: intervenor.id, hpDelta: -damage }] };
          }
        }

        logs.push(`${c.name} hits ${t.name} for ${damage} ${effect.damageType} damage${isCrit ? " (CRIT)" : ""}`);
        t = { ...t, hp: Math.max(0, t.hp - damage), damageReceivedThisTurn: (t.damageReceivedThisTurn || 0) + damage };

        // Berserker Rage: extra rage for the unit that was hit
        const berserkBuff = t.buffs.find(b => b.modifiers?.bonusRageOnHit);
        if (berserkBuff && t.resources?.rage) {
          const bonusRage = berserkBuff.modifiers.bonusRageOnHit;
          t = ResourceSystem.generate(t, { rage: bonusRage });
          logs.push(`${t.name} generates ${bonusRage} bonus rage (Berserker Rage)`);
        }

        // Retaliation: counter-attack (damage back at caster using target's AP)
        if (hasRetaliation) {
          const aDer = StatSystem.applyBuffModifiers(t.stats.derived, t.buffs);
          const retDmg = Math.max(1, Math.floor((aDer.attackPower || 0) * 0.6));
          logs.push(`${t.name} retaliates for ${retDmg} physical damage`);
          c = { ...c, hp: Math.max(0, c.hp - retDmg) };
        }

        const onHit = PassiveSystem.fireAll(c, { damageDone: damage, targetType: t.unitType });
        logs.push(...onHit.logs);
        if (Object.keys(onHit.resourceDelta).length) c = ResourceSystem.generate(c, onHit.resourceDelta);
        if (onHit.healSelf) c = { ...c, hp: Math.min(c.maxHp, c.hp + onHit.healSelf) };

        const onHit2 = PassiveSystem.fireAll(t, { damageTaken: damage, incomingPhysical: effect.damageType === "physical" });
        logs.push(...onHit2.logs);
        if (Object.keys(onHit2.resourceDelta).length) t = ResourceSystem.generate(t, onHit2.resourceDelta);
        if (onHit2.healSelf) t = { ...t, hp: Math.min(t.maxHp, t.hp + onHit2.healSelf) };

        if (reflected > 0) {
          logs.push(`${t.name} reflects ${reflected} damage to ${c.name}`);
          c = { ...c, hp: Math.max(0, c.hp - reflected) };
        }
        break;
      }
      case "heal": {
        const { heal, isCrit } = HealingSystem.rollHeal(effect, c);
        const actual = Math.min(t.maxHp - t.hp, heal);
        t = { ...t, hp: t.hp + actual };
        logs.push(`${c.name} heals ${t.name} for ${actual}${isCrit ? " (CRIT)" : ""}`);
        break;
      }
      case "buff": {
        if (Math.random() < (effect.chance ?? 1)) {
          t = BuffSystem.applyBuff(t, effect.buffId, c.id);
          logs.push(`${t.name} gains ${effect.buffId}`);
        }
        break;
      }
      case "debuff": {
        if (Math.random() < (effect.chance ?? 1)) {
          const ccCtx = { ccApplied: true };
          const check = PassiveSystem.fireAll(t, ccCtx);
          logs.push(...check.logs);
          if (!ccCtx.ccResisted) {
            t = BuffSystem.applyBuff(t, effect.buffId, c.id);
            logs.push(`${t.name} is afflicted by ${effect.buffId}`);
          }
        }
        break;
      }
      case "resource": {
        c = ResourceSystem.generate(c, effect.gains || {});
        break;
      }
      case "rage_gain": {
        if (c.resources.rage) {
          c = ResourceSystem.generate(c, { rage: effect.amount || 0 });
          logs.push(`${c.name} generates ${effect.amount} rage`);
        }
        break;
      }
      case "health_cost": {
        const cost = effect.amount || 0;
        c = { ...c, hp: Math.max(1, c.hp - cost) };
        logs.push(`${c.name} loses ${cost} health`);
        break;
      }
      case "threat": {
        if (!c.isEnemy) {
          c = ThreatSystem.addThreat(c, t.id, effect.amount || 0);
          logs.push(`${c.name} generates ${effect.amount} threat on ${t.name}`);
        }
        break;
      }
      case "interrupt": {
        if (t.castQueue?.length) {
          logs.push(`${t.name}'s cast is interrupted`);
          t = { ...t, castQueue: [] };
        }
        break;
      }
      case "cleanse": {
        logs.push(`${c.name}'s debuffs are cleansed`);
        const clearedCC = { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false };
        c = { ...c, debuffs: [], ccState: clearedCC };
        break;
      }
      case "dispel_buff": {
        if (!t.buffs.length) break;
        let toStrip = t.buffs;
        if (effect.prioritizeInvulnerability) {
          const invulnIdx = t.buffs.findIndex(b => b.modifiers?.invulnerable);
          if (invulnIdx >= 0) {
            logs.push(`${t.name} loses ${t.buffs[invulnIdx].id} (dispelled)`);
            t = { ...t, buffs: t.buffs.filter((_, i) => i !== invulnIdx) };
            break;
          }
        }
        const count   = effect.count || 1;
        const removed = toStrip.slice(0, count);
        t = { ...t, buffs: toStrip.slice(count) };
        for (const b of removed) logs.push(`${t.name} loses ${b.id} (dispelled)`);
        break;
      }
    }

    return { caster: c, target: t };
  };

  return { dispatch };
})();


// =============================================================================
// MODULE — ability executor
// =============================================================================

const AbilityExecutor = (() => {
  const execute = (abilityId, caster, targets, state) => {
    const ability = ABILITIES[abilityId];
    if (!ability) return { caster, targets, logs: [`Unknown ability: ${abilityId}`], sideEffects: [] };

    const logs = [];
    const sideEffects = [];
    let c  = caster;
    let ts = [...targets];

    if (ability.requiresComboPoints) c = ResourceSystem.spendComboPoints(c);
    c = ResourceSystem.spend(c, ability.resourceCost || {});
    c = ResourceSystem.setCooldown(c, abilityId, ability.cooldown || 0);
    logs.push(`${c.name} uses ${ability.name}`);

    // Execute: burn all remaining rage for bonus damage on the first damage effect
    let executeBonusDmg = 0;
    if (ability.executeRageBurn && c.resources.rage) {
      const extraRage = c.resources.rage.current;
      executeBonusDmg = Math.floor(extraRage * ((c.stats.derived.attackPower || 0) / 100));
      c = { ...c, resources: { ...c.resources, rage: { ...c.resources.rage, current: 0 } } };
      if (extraRage > 0) logs.push(`${c.name} burns ${extraRage} rage for ${executeBonusDmg} bonus damage`);
    }

    let executeBonusApplied = false;
    for (let i = 0; i < ts.length; i++) {
      let t = ts[i];
      for (const effect of ability.effects) {
        const result = EffectDispatcher.dispatch(effect, c, t, state, logs);
        c  = result.caster;
        t  = result.target;
        if (result.sideEffects) sideEffects.push(...result.sideEffects);
      }
      // Apply execute rage-burn bonus as flat damage to the primary target
      if (executeBonusDmg > 0 && !executeBonusApplied && t.alive) {
        t = { ...t, hp: Math.max(0, t.hp - executeBonusDmg),
               damageReceivedThisTurn: (t.damageReceivedThisTurn || 0) + executeBonusDmg };
        executeBonusApplied = true;
      }
      ts[i] = t;
    }

    return { caster: c, targets: ts, logs, sideEffects };
  };

  return { execute };
})();


// =============================================================================
// MODULE — cast queue
// =============================================================================

const CastQueue = (() => {
  const enqueue = (unit, abilityId, targetId) => {
    const castTime = ABILITIES[abilityId]?.castTime ?? 0;
    return { ...unit, castQueue: [...unit.castQueue, { abilityId, targetId, turnsRemaining: castTime }] };
  };

  const tick = (unit) => {
    const ready = [], remaining = [];
    for (const e of unit.castQueue) {
      if (e.turnsRemaining <= 0) ready.push(e);
      else remaining.push({ ...e, turnsRemaining: e.turnsRemaining - 1 });
    }
    return { unit: { ...unit, castQueue: remaining }, ready };
  };

  return { enqueue, tick };
})();


// =============================================================================
// MODULE — AI
// =============================================================================

const AISystem = (() => {
  const chooseAction = (enemy, state) => {
    if (!enemy.alive || enemy.ccState.stunned || enemy.ccState.feared) return null;

    let target = ThreatSystem.getHighestThreat(enemy.id, state.party);
    if (!target) {
      const living = state.party.filter(u => u.alive);
      if (!living.length) return null;
      target = [...living].sort((a, b) => a.hp - b.hp)[0];
    }

    const available = (enemy.abilities || []).filter(id => {
      const ab = ABILITIES[id];
      if (!ab || ab.passive) return false;
      if (enemy.cooldowns[id] > 0) return false;
      if (!ResourceSystem.canAfford(enemy, ab.resourceCost || {})) return false;
      if (ab.requiresOpener && state.turn !== 0) return false;
      if (ab.requiresOffhandType === "shield" && !enemy.shieldEquipped) return false;
      if (ab.requiresTargetHpBelow != null) {
        const bestTarget = state.party.filter(u => u.alive)
          .sort((a,b) => a.hp/a.maxHp - b.hp/b.maxHp)[0];
        if (!bestTarget || (bestTarget.hp / bestTarget.maxHp) >= ab.requiresTargetHpBelow) return false;
      }
      if (enemy.ccState.disarmed) {
        const isPhysicalMelee = (ab.tags || []).includes("melee") ||
          ab.effects?.some(e => e.type === "damage" && e.damageType === "physical" && e.scaling === "ap");
        if (isPhysicalMelee) return false;
      }
      return true;
    });
    if (!available.length) return null;

    const profile  = AI_PROFILES[enemy.aiProfile] || AI_PROFILES.aggressive;
    let chosenId;
    if (profile.abilityStrategy === "random") {
      chosenId = available[Math.floor(Math.random() * available.length)];
    } else {
      const dmg = available.filter(id => ABILITIES[id].effects.some(e => e.type === "damage"));
      chosenId  = dmg.length ? dmg[0] : available[0];
    }

    return { abilityId: chosenId, targetId: target.id };
  };

  return { chooseAction };
})();


// =============================================================================
// MODULE — death system
// =============================================================================

const DeathSystem = (() => {
  const evaluate = (unit, logs) => {
    if (unit.hp <= 0 && unit.alive) {
      logs.push(`${unit.name} has died`);
      return { ...unit, hp: 0, alive: false, buffs: [], debuffs: [],
               ccState: { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false },
               threatTable: {} };
    }
    return unit;
  };

  const checkOutcome = (state) => {
    if (state.party.every(u => !u.alive))   return "defeat";
    if (state.enemies.every(u => !u.alive)) return "victory";
    return null;
  };

  return { evaluate, checkOutcome };
})();


// =============================================================================
// MODULE — turn order
// =============================================================================

const TurnOrder = (() => {
  const sync = (state, unit) => {
    if (state.party.some(u => u.id === unit.id))
      return { ...state, party: state.party.map(u => u.id === unit.id ? unit : u) };
    return { ...state, enemies: state.enemies.map(e => e.id === unit.id ? unit : e) };
  };

  const resolveCasts = (unit, state) => {
    const logs = [];
    const { unit: ticked, ready } = CastQueue.tick(unit);
    let s = sync(state, ticked);
    let u = ticked;
    for (const entry of ready) {
      const ab = ABILITIES[entry.abilityId];
      if (!ab) continue;
      const targets = TargetingSystem.resolve(ab.targeting, u, s, { targetId: entry.targetId });
      if (!targets.length) continue;
      const result = AbilityExecutor.execute(entry.abilityId, u, targets, s);
      logs.push(...result.logs);
      u = result.caster;
      for (const t of result.targets) s = sync(s, t);
    }
    s = sync(s, u);
    return { state: s, logs };
  };

  // ── ability condition checks ─────────────────────────────────────────────────
  const checkConditions = (ability, abilityId, actor, targets, state) => {
    if (ability.requiresOpener && state.turn !== 0)
      return `${ability.name} can only be used on the first turn of combat`;
    if (ability.requiresMinCombatTurn != null && state.turn < ability.requiresMinCombatTurn)
      return `${ability.name} cannot be used on the first turn`;
    if (ability.requiresMaxCombatTurn != null && state.turn >= ability.requiresMaxCombatTurn)
      return `${ability.name} is no longer available`;
    if (ability.requiresOffhandType === "shield" && !actor.shieldEquipped)
      return `${ability.name} requires a shield`;
    if (ability.requiresCondition === "prior_encounter_victory" && !state.priorEncounterVictory)
      return `${ability.name} requires a prior victory`;
    if (ability.requiresCondition === "enemy_no_damage_last_turn") {
      const primaryTarget = targets[0];
      if (!primaryTarget || (primaryTarget.damageReceivedLastTurn || 0) > 0)
        return `${ability.name} requires the enemy to have dealt no damage last turn`;
    }
    if (ability.requiresCondition === "self_no_damage_last_turn") {
      if ((actor.damageReceivedLastTurn || 0) > 0)
        return `${ability.name} requires you to have taken no damage last turn`;
    }
    if (ability.requiresTargetHpBelow != null) {
      const primaryTarget = targets[0];
      if (!primaryTarget || (primaryTarget.hp / primaryTarget.maxHp) >= ability.requiresTargetHpBelow)
        return `${ability.name} requires the target to be below ${Math.round(ability.requiresTargetHpBelow * 100)}% health`;
    }
    if (actor.ccState.disarmed) {
      const isPhysicalMelee = (ability.tags || []).includes("melee") ||
        ability.effects?.some(e => e.type === "damage" && e.damageType === "physical" && e.scaling === "ap");
      if (isPhysicalMelee) return `${actor.name} is disarmed`;
    }
    return null;
  };

  // Phase 1: party actions
  // actions: Array<{ actorId, abilityId, targetId }> — one per party member (may be sparse)
  const partyPhase = (state, actions) => {
    const logs = [];
    let s = state;
    const actionMap = {};
    for (const a of (actions || [])) actionMap[a.actorId] = a;

    for (const member of s.party.filter(u => u.alive)) {
      const cr = resolveCasts(member, s);
      logs.push(...cr.logs);
      s = cr.state;

      const current = s.party.find(u => u.id === member.id);
      if (!current?.alive) continue;

      const action = actionMap[member.id];
      if (!action) continue;

      const { abilityId, targetId } = action;
      const ability = ABILITIES[abilityId];
      if (!ability) { logs.push(`Unknown ability: ${abilityId}`); continue; }

      if (current.ccState.stunned) { logs.push(`${current.name} is stunned`); continue; }
      if (current.ccState.feared)  { logs.push(`${current.name} is feared`);  continue; }
      if (current.ccState.silenced && ability.resourceCost?.mana) { logs.push(`${current.name} is silenced`); continue; }
      if (!ResourceSystem.canAfford(current, ability.resourceCost || {})) { logs.push(`${current.name}: not enough resources for ${ability.name}`); continue; }
      if ((current.cooldowns[abilityId] || 0) > 0) { logs.push(`${ability.name} is on cooldown`); continue; }

      if ((ability.castTime || 0) > 0) {
        const queued = CastQueue.enqueue(current, abilityId, targetId);
        s = sync(s, ResourceSystem.spend(queued, ability.resourceCost || {}));
        logs.push(`${current.name} begins casting ${ability.name} (${ability.castTime} turns)`);
      } else {
        const targets = TargetingSystem.resolve(ability.targeting, current, s, { targetId });
        if (!targets.length) { logs.push(`${current.name}: no valid targets for ${ability.name}`); continue; }

        const condErr = checkConditions(ability, abilityId, current, targets, s);
        if (condErr) { logs.push(condErr); continue; }

        const result = AbilityExecutor.execute(abilityId, current, targets, s);
        logs.push(...result.logs);
        s = sync(s, result.caster);
        for (const t of result.targets) s = sync(s, t);
        for (const se of (result.sideEffects || [])) {
          const u = [...s.party, ...s.enemies].find(u => u.id === se.unitId);
          if (u) s = sync(s, { ...u, hp: Math.max(0, u.hp + (se.hpDelta || 0)) });
        }
      }
    }
    return { state: s, logs };
  };

  // Phase 2: enemy actions (AI-driven)
  const enemyPhase = (state) => {
    const logs = [];
    let s = state;

    for (const enemy of s.enemies.filter(e => e.alive)) {
      const cr = resolveCasts(enemy, s);
      logs.push(...cr.logs);
      s = cr.state;

      const current = s.enemies.find(e => e.id === enemy.id);
      if (!current?.alive) continue;

      const aiAction = AISystem.chooseAction(current, s);
      if (!aiAction) continue;

      const ability = ABILITIES[aiAction.abilityId];
      if (!ability) continue;

      if ((ability.castTime || 0) > 0) {
        const queued = CastQueue.enqueue(current, aiAction.abilityId, aiAction.targetId);
        s = sync(s, ResourceSystem.spend(queued, ability.resourceCost || {}));
        logs.push(`${current.name} begins casting ${ability.name}`);
        continue;
      }

      const targets = TargetingSystem.resolve(ability.targeting, current, s, { targetId: aiAction.targetId });
      if (!targets.length) continue;
      const result = AbilityExecutor.execute(aiAction.abilityId, current, targets, s);
      logs.push(...result.logs);
      s = sync(s, result.caster);
      for (const t of result.targets) s = sync(s, t);
      for (const se of (result.sideEffects || [])) {
        const u = [...s.party, ...s.enemies].find(u => u.id === se.unitId);
        if (u) s = sync(s, { ...u, hp: Math.max(0, u.hp + (se.hpDelta || 0)) });
      }
    }
    return { state: s, logs };
  };

  // Phase 3: tick (DoTs, regen)
  const tickPhase = (state) => {
    const logs = [];
    let s = state;
    for (const unit of [...s.party, ...s.enemies].filter(u => u.alive)) {
      const { unit: ticked, logs: tl } = BuffSystem.tickBuffs(unit);
      logs.push(...tl);
      s = sync(s, ResourceSystem.tickRegen(ticked));
    }
    return { state: s, logs };
  };

  // Phase 4: cleanup (expire buffs, decrement cooldowns, evaluate deaths, check outcome)
  const cleanupPhase = (state) => {
    const logs = [];
    let s = state;

    for (const unit of [...s.party, ...s.enemies]) {
      const { unit: expired, logs: el } = BuffSystem.expireBuffs(unit);
      logs.push(...el);
      s = sync(s, expired);
    }

    s = {
      ...s,
      party:   s.party.map(u => ResourceSystem.decrementCooldowns(u)),
      enemies: s.enemies.map(e => ResourceSystem.decrementCooldowns(e)),
    };

    // rotate per-turn damage tracking: this → last, reset this
    const rotateDmg = u => ({
      ...u,
      damageReceivedLastTurn: u.damageReceivedThisTurn || 0,
      damageReceivedThisTurn: 0,
    });
    s = { ...s, party: s.party.map(rotateDmg), enemies: s.enemies.map(rotateDmg) };

    s = {
      ...s,
      party:   s.party.map(u => DeathSystem.evaluate(u, logs)),
      enemies: s.enemies.map(e => DeathSystem.evaluate(e, logs)),
    };

    const outcome = DeathSystem.checkOutcome(s);
    if (outcome) s = { ...s, combatOver: true, outcome };

    return { state: { ...s, turn: s.turn + 1 }, logs };
  };

  return { partyPhase, enemyPhase, tickPhase, cleanupPhase };
})();


// =============================================================================
// ENGINE — primary entry point
// actions: Array<{ actorId: string, abilityId: string, targetId: string }>
// =============================================================================

const processTurn = (state, actions) => {
  if (state.combatOver) return { state, logs: ["Combat is already over"] };

  const allLogs = [`--- Turn ${state.turn + 1} ---`];
  const p1 = TurnOrder.partyPhase(state, actions);  allLogs.push(...p1.logs);
  const p2 = TurnOrder.enemyPhase(p1.state);         allLogs.push(...p2.logs);
  const p3 = TurnOrder.tickPhase(p2.state);           allLogs.push(...p3.logs);
  const p4 = TurnOrder.cleanupPhase(p3.state);        allLogs.push(...p4.logs);

  return {
    state: { ...p4.state, logs: [...state.logs, ...allLogs] },
    logs:  allLogs,
  };
};


// =============================================================================
// TEST HARNESS — 3-member party vs 2 enemies
// Uncomment runTestHarness() at the bottom to execute in Node.
// =============================================================================

const runTestHarness = () => {
  console.log("=== Combat Engine Test Harness ===\n");

  let state = createGameState({
    partyConfigs: [
      { id: "p0", name: "Grak",    raceId: "orc",       classId: "warrior", abilities: ["heroic_strike","shield_wall","melee_attack"] },
      { id: "p1", name: "Zin'ara", raceId: "troll",     classId: "mage",    abilities: ["fireball","moonfire"] },
      { id: "p2", name: "Shayla",  raceId: "night_elf", classId: "priest",  abilities: ["heal","melee_attack"] },
    ],
    enemyConfigs: [
      { id: "e0", enemyDefId: "defias_bandit",   raceId: "orc",    classId: "rogue" },
      { id: "e1", enemyDefId: "kultiran_sailor",  raceId: "tauren", classId: "warrior" },
    ],
  });

  const printState = (s) => {
    console.log("  PARTY:");
    for (const m of s.party)   console.log(`    [${m.alive ? "ALIVE" : "DEAD "}] ${m.name.padEnd(10)} HP: ${String(m.hp).padStart(3)}/${m.maxHp}`);
    console.log("  ENEMIES:");
    for (const e of s.enemies) console.log(`    [${e.alive ? "ALIVE" : "DEAD "}] ${e.name.padEnd(18)} HP: ${String(e.hp).padStart(3)}/${e.maxHp}`);
    console.log();
  };

  printState(state);

  const turnActions = [
    [
      { actorId: "p0", abilityId: "melee_attack",   targetId: "e0" },
      { actorId: "p1", abilityId: "moonfire",       targetId: "e0" },
      { actorId: "p2", abilityId: "melee_attack",   targetId: "e1" },
    ],
    [
      { actorId: "p0", abilityId: "heroic_strike", targetId: "e0" },
      { actorId: "p1", abilityId: "fireball",       targetId: "e1" },
      { actorId: "p2", abilityId: "heal",           targetId: "p0" },
    ],
    [
      { actorId: "p0", abilityId: "melee_attack",   targetId: "e1" },
      { actorId: "p1", abilityId: "moonfire",       targetId: "e1" },
      { actorId: "p2", abilityId: "melee_attack",   targetId: "e1" },
    ],
    [
      { actorId: "p0", abilityId: "shield_wall",   targetId: "p0" },
      { actorId: "p1", abilityId: "fireball",       targetId: "e1" },
      { actorId: "p2", abilityId: "heal",           targetId: "p1" },
    ],
    [
      { actorId: "p0", abilityId: "heroic_strike", targetId: "e1" },
      { actorId: "p1", abilityId: "moonfire",       targetId: "e1" },
      { actorId: "p2", abilityId: "melee_attack",   targetId: "e1" },
    ],
  ];

  for (let i = 0; i < turnActions.length && !state.combatOver; i++) {
    const { state: next, logs } = processTurn(state, turnActions[i]);
    logs.forEach(l => console.log(l));
    printState(next);
    state = next;
  }

  console.log(`Outcome: ${state.outcome || "ongoing"}`);
  return state;
};

// runTestHarness();

if (typeof module !== "undefined") {
  module.exports = {
    processTurn, createGameState,
    RACES, CLASSES, ABILITIES, BUFF_DEFS, ENEMY_DEFS, AI_PROFILES,
    StatSystem, ResourceSystem, BuffSystem, DamageSystem,
    HealingSystem, TargetingSystem, PassiveSystem, ThreatSystem,
    AbilityExecutor, AISystem, DeathSystem, TurnOrder,
    CastQueue, runTestHarness,
  };
}