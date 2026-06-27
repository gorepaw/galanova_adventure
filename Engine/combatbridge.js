// =============================================================================
// COMBAT BRIDGE  — replace the entire existing CombatBridge const block
// All other code in game_loop.js is unchanged.
// =============================================================================

const _abilitiesData = require('../Data/abilities.json');

const CombatBridge = (() => {

  const CLASS_BASE_HP = { warrior:60, paladin:45, hunter:45, rogue:40, priest:30, shaman:40, mage:25, warlock:28, druid:35 };
  const CLASS_BASE_MP = { warrior:0,  paladin:60, hunter:40, rogue:0,  priest:80, shaman:60, mage:100, warlock:90, druid:70 };

  const ABILITY_DATA     = _abilitiesData.abilities;
  const BUFF_DEFS_BRIDGE = _abilitiesData.buffs;

  // ── always-on passive stat mods applied at buildUnit time ──────────────────
  const applyAlwaysPassives = (derived, abilities) => {
    const d = { ...derived };
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

  const buildUnit = (cfg, isEnemy = false) => {
    const classId  = cfg.classId || "warrior";
    const minLevel = cfg.level || 1;
    const level    = isEnemy
      ? minLevel + Math.floor(Math.random() * ((cfg.levelMax ?? minLevel + 1) - minLevel + 1))
      : minLevel;
    const raw      = cfg.stats?.raw || cfg.baseStats || getStatsAtLevel(cfg.raceId || "orc", classId, level);
    const abilities = cfg.learnedAbilities || cfg.abilities || ["basic_attack"];

    const baseD = {
      maxHp:              raw.con * 10 + (CLASS_BASE_HP[classId] || 0),
      maxMana:            raw.int * 15 + (CLASS_BASE_MP[classId] || 0),
      attackPower:        raw.str * 2 + raw.dex,
      rangedAttackPower:  Math.max(0, 2 * level + 2 * raw.dex - 10),
      spellPower:         0,
      armor:              raw.dex * 2,
      critChanceMelee:    raw.dex / 20 / 100,
      critChanceSpell:    raw.int / 60 / 100,
      dodge:              (raw.spd || 0) / 20 / 100,
      manaRegen:          Math.floor(raw.spi / 5),
      resistances:        (() => {
        const rv = (raw.wis || 0) * 0.5;
        return { pyro: rv, cryo: rv, nature: rv, chaos: rv, order: rv, bio: rv, energy: rv, psychic: rv };
      })(),
      critMultiplier:     2.0,
    };

    // apply always-on passives before finalising derived stats
    const derived = applyAlwaysPassives(baseD, abilities);

    const maxHp   = cfg.maxHp || derived.maxHp;
    const maxMana = cfg.maxMp || derived.maxMana;

    // Resources are read from the class's resource list (mix-and-match).
    const resources = buildResources(classId, maxMana);

    return {
      id:           cfg.instanceId || cfg.id || `u_${Math.random().toString(36).slice(2, 7)}`,
      name:         cfg.name,
      classId,
      raceId:       cfg.raceId || "orc",
      level,
      hp:           cfg.currentHp || maxHp,
      maxHp,
      xpValue:      cfg.xpValue   || 0,
      loot:         cfg.loot      || [],
      skinningLoot: cfg.skinningLoot  || [],
      killReputation: cfg.killReputation || [],
      currencyDrop: cfg.currencyDrop  || null,
      stats:        { raw, derived },
      resources,
      cooldowns:    {},
      castQueue:    [],
      buffs:        [],
      debuffs:      [],
      ccState:      { stunned: false, silenced: false, disarmed: false, rooted: false, feared: false },
      abilities,
      shieldEquipped:           !!(cfg.gear?.offhand?.itemType === "shield" || cfg.shieldEquipped),
      damageReceivedThisTurn:   0,
      damageReceivedLastTurn:   0,
      isEnemy,
      alive:        true,
      threatTable:  {},
    };
  };

  const rollDamage = (effect, attacker, target) => {
    const aD = attacker.stats.derived, tD = target.stats.derived;
    let base = effect.flatBonus || 0;
    if (effect.scaling === "ap") base += (aD.attackPower || 0) * (effect.multiplier || 1);
    if (effect.scaling === "sp") base += (aD.spellPower  || 0) * (effect.multiplier || 1);
    for (const b of (attacker.buffs || []))
      if (b.modifiers?.flatDamage) base += b.modifiers.flatDamage;
    const isCrit = Math.random() < (effect.damageType === "physical" ? aD.critChanceMelee : aD.critChanceSpell || 0);
    if (isCrit) base *= aD.critMultiplier || 2;
    if (effect.damageType === "physical") {
      const arm = Math.max(0, tD.armor || 0);
      base *= (1 - arm / (arm + 1500));
    }
    for (const b of target.buffs.concat(target.debuffs))
      if (b.modifiers?.damageTakenMultiplier) base *= b.modifiers.damageTakenMultiplier;
    return { damage: Math.max(1, Math.floor(base)), isCrit };
  };

  const rollHeal = (effect, caster) => {
    const d = caster.stats.derived;
    return Math.max(1, Math.floor((effect.flatBonus || 0) + (d.spellPower || 0) * (effect.multiplier || 0)));
  };

  const applyBuff = (unit, buffId, sourceId, overrideDuration) => {
    const def = BUFF_DEFS_BRIDGE[buffId];
    if (!def) return unit;
    const inst = {
      id: buffId, sourceId, duration: overrideDuration ?? def.duration,
      modifiers: { ...(def.modifiers || {}) },
      ccFlags:   { ...(def.ccFlags   || {}) },
      tickDamage: def.tickDamage ? { ...def.tickDamage } : null,
    };
    const isDebuff = Object.values(inst.ccFlags).some(Boolean) || !!inst.tickDamage;
    const field    = isDebuff ? "debuffs" : "buffs";
    const existIdx = unit[field].findIndex(b => b.id === buffId);
    const newList  = existIdx >= 0
      ? unit[field].map((b, i) => i === existIdx ? { ...b, duration: inst.duration } : b)
      : [...unit[field], inst];
    const ccState = { ...unit.ccState };
    for (const [f, v] of Object.entries(inst.ccFlags)) if (v) ccState[f] = true;
    return { ...unit, [field]: newList, ccState };
  };

  const syncUnit  = (all, updated) => all.map(u => u.id === updated.id ? updated : u);

  // ── proc firing ────────────────────────────────────────────────────────────
  // Scans caster's abilities for passive procs matching the given trigger.
  // Self-buffs (on_hit, on_crit_heal) apply to the caster.
  // on_being_hit procs would apply to the procTarget — add when needed.
  const fireProcAbilities = (unit, trigger, procTarget, logs) => {
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
          u = applyBuff(u, buffId, u.id);
          logs.push(`    ↳ ${u.name} procs ${buffId}`);
        } else {
          pt = applyBuff(pt, buffId, u.id);
          logs.push(`    ↳ ${pt.name} afflicted by ${buffId} (proc)`);
        }
      }
    }
    return { unit: u, procTarget: pt };
  };

  const execAbility = (abilityId, caster, targets, logs) => {
    const ab = ABILITY_DATA[abilityId];
    if (!ab || ab.passive) return { caster, targets };   // skip passive entries
    logs.push(`  ${caster.name} → ${abilityId.replace(/_/g, " ")}`);

    let c  = { ...caster, resources: { ...caster.resources } };
    for (const [r, a] of Object.entries(ab.resourceCost || {}))
      if (c.resources[r]) c.resources[r] = { ...c.resources[r], current: c.resources[r].current - a };
    if ((ab.cooldown || 0) > 0)
      c = { ...c, cooldowns: { ...c.cooldowns, [abilityId]: ab.cooldown } };

    let ts = [...targets];
    for (const effect of ab.effects) {
      for (let i = 0; i < ts.length; i++) {
        let t = ts[i];
        if (!t.alive) continue;

        if (effect.type === "damage") {
          const { damage, isCrit } = rollDamage(effect, c, t);
          logs.push(`    ↳ ${t.name}: ${damage}${isCrit ? " [CRIT]" : ""} ${effect.damageType}`);
          t = { ...t, hp: Math.max(0, t.hp - damage), damageReceivedThisTurn: (t.damageReceivedThisTurn || 0) + damage };

          // rage generation
          if (c.resources.rage) {
            const rg = Math.floor(damage / 5);
            c = { ...c, resources: { ...c.resources, rage: { ...c.resources.rage, current: Math.min(100, c.resources.rage.current + rg) } } };
          }
          // threat
          if (!c.isEnemy) {
            const th = c.threatTable || {};
            c = { ...c, threatTable: { ...th, [t.id]: (th[t.id] || 0) + damage } };
          }
          // on_hit procs (fire before death check so killing blows don't proc)
          const hitProc = fireProcAbilities(c, "on_hit", t, logs);
          c = hitProc.unit; t = hitProc.procTarget;

          if (t.hp <= 0 && t.alive) { logs.push(`    ✗ ${t.name} dies`); t = { ...t, alive: false, hp: 0 }; }
        }

        if (effect.type === "heal") {
          const h      = rollHeal(effect, c);
          const isCrit = Math.random() < (c.stats.derived.critChanceSpell || 0);
          const healed = isCrit ? Math.floor(h * 1.5) : h;
          const act    = Math.min(t.maxHp - t.hp, healed);
          t = { ...t, hp: t.hp + act };
          logs.push(`    ↳ heals ${t.name}: +${act}${isCrit ? " [CRIT]" : ""}`);
          // on_crit_heal procs
          if (isCrit) {
            const healProc = fireProcAbilities(c, "on_crit_heal", t, logs);
            c = healProc.unit; t = healProc.procTarget;
          }
        }

        if (effect.type === "debuff") {
          if (Math.random() < (effect.chance || 1)) {
            t = applyBuff(t, effect.buffId, c.id);
            logs.push(`    ↳ ${t.name} afflicted by ${effect.buffId}`);
          }
        }

        ts[i] = t;
      }
    }
    return { caster: c, targets: ts };
  };

  const tickBuffsUnit = (unit) => {
    const logs = []; let u = { ...unit };
    for (const eff of [...u.buffs, ...u.debuffs]) {
      if (!eff.tickDamage) continue;
      const td  = eff.tickDamage;
      let dmg   = td.flat || 0;
      if (td.scaling === "sp") dmg += (u.stats.derived.spellPower || 0) * (td.multiplier || 0);
      dmg = Math.max(1, Math.floor(dmg));
      u = { ...u, hp: Math.max(0, u.hp - dmg) };
      logs.push(`    ↳ ${u.name} takes ${dmg} ${td.damageType} (${eff.id})`);
    }
    return { unit: u, logs };
  };

  const expireBuffsUnit = (unit) => {
    const process = list => list.map(b => ({ ...b, duration: b.duration - 1 })).filter(b => b.duration > 0);
    const nb = process(unit.buffs), nd = process(unit.debuffs);
    const ccState = { stunned: false };
    for (const d of nd) for (const [f, v] of Object.entries(d.ccFlags || {})) if (v) ccState[f] = true;
    return { ...unit, buffs: nb, debuffs: nd, ccState };
  };

  const aiChoose = (unit, targets, ctx) => {
    const living = targets.filter(t => t.alive);
    if (!living.length || unit.ccState.stunned || unit.ccState.disarmed) return null;
    const target = [...living].sort((a, b) => {
      const tA = unit.threatTable[a.id] || 0, tB = unit.threatTable[b.id] || 0;
      return tB - tA || a.hp - b.hp;
    })[0];
    const avail = (unit.abilities || []).filter(id => {
      const ab = ABILITY_DATA[id];
      if (!ab || ab.passive || (unit.cooldowns[id] || 0) > 0) return false;
      if (unit.ccState.disarmed && ab.tags?.includes("physical")) return false;
      for (const [r, a] of Object.entries(ab.resourceCost || {}))
        if ((unit.resources[r]?.current || 0) < a) return false;
      if (ctx) {
        if (ab.requiresOpener && ctx.turn > 1) return false;
        if (ab.requiresMinCombatTurn && ctx.turn < ab.requiresMinCombatTurn) return false;
        if (ab.requiresMaxCombatTurn && ctx.turn > ab.requiresMaxCombatTurn) return false;
        if (ab.requiresTargetHpBelow && target.hp / target.maxHp >= ab.requiresTargetHpBelow) return false;
        if (ab.requiresOffhandType === "shield" && !unit.shieldEquipped) return false;
        if (ab.requiresCondition === "prior_encounter_victory" && !ctx.priorEncounterVictory) return false;
        if (ab.requiresCondition === "enemy_no_damage_last_turn" && (target.damageReceivedLastTurn || 0) > 0) return false;
        if (ab.requiresCondition === "self_no_damage_last_turn"  && (unit.damageReceivedLastTurn  || 0) > 0) return false;
      }
      return true;
    });
    if (!avail.length) return null;
    const dmg = avail.filter(id => ABILITY_DATA[id]?.effects?.some(e => e.type === "damage"));
    return { abilityId: dmg.length ? dmg[0] : avail[0], targetId: target.id };
  };

  const tickUnit = (unit) => {
    const cd = { ...unit.cooldowns };
    for (const id of Object.keys(cd)) { cd[id] = Math.max(0, cd[id] - 1); if (cd[id] === 0) delete cd[id]; }
    const res = { ...unit.resources };
    if (res.stamina) res.stamina = { ...res.stamina, current: Math.min(res.stamina.max, res.stamina.current + 15) };
    if (res.mana)   res.mana   = { ...res.mana,   current: Math.min(res.mana.max,   res.mana.current + (unit.stats.derived.manaRegen || 0)) };
    return { ...unit, cooldowns: cd, resources: res };
  };

  const run = (encounter, partyInstances, opts = {}) => {
    const logs = [], MAX = 30;
    let party   = partyInstances.map(inst => {
      const unit = buildUnit(inst, false);
      return (inst.activeBuffs || []).reduce((u, entry) => {
        const buffId   = typeof entry === "string" ? entry : entry.id;
        const duration = typeof entry === "object"  ? entry.remainingDuration : undefined;
        return applyBuff(u, buffId, u.id, duration);
      }, unit);
    });
    let enemies = encounter.enemies.map(e => buildUnit(e, true));
    logs.push(`⚔ ${encounter.zoneId.toUpperCase()} — ${party.map(u => u.name).join(",")} vs ${enemies.map(u => u.name).join(",")}`);
    let turn = 0, outcome = null;

    while (turn < MAX && !outcome) {
      turn++; logs.push(`\n── T${turn}`);
      const ctx = { turn, priorEncounterVictory: opts.priorEncounterVictory };

      // party turn
      for (let pi = 0; pi < party.length; pi++) {
        let actor = party[pi];
        if (!actor.alive || actor.ccState.stunned) { if (actor.ccState.stunned) logs.push(`  ${actor.name} is stunned`); continue; }

        let castFired = false;
        if (actor.castQueue?.length) {
          const ready = [], pending = [];
          for (const e of actor.castQueue) {
            if (e.turnsRemaining <= 0) ready.push(e);
            else pending.push({ ...e, turnsRemaining: e.turnsRemaining - 1 });
          }
          actor = { ...actor, castQueue: pending };
          for (const entry of ready) {
            const ab = ABILITY_DATA[entry.abilityId];
            if (!ab) continue;
            castFired = true;
            let tgts;
            if (ab.targeting === "single_ally") {
              const alive = party.filter(u => u.alive);
              const preferred = alive.find(u => u.id === entry.targetId);
              tgts = [preferred || alive.sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0]].filter(Boolean);
            } else {
              tgts = enemies.filter(u => u.alive);
            }
            if (!tgts.length) continue;
            const res  = execAbility(entry.abilityId, actor, tgts, logs);
            actor = res.caster;
            for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
          }
        }
        if (castFired) { party = syncUnit(party, actor); continue; }

        const liveE = enemies.filter(e => e.alive); if (!liveE.length) break;
        const ai = aiChoose(actor, liveE, ctx); if (!ai) continue;
        const ab = ABILITY_DATA[ai.abilityId]; if (!ab) continue;

        if ((ab.castTime || 0) > 0) {
          actor = { ...actor, castQueue: [...(actor.castQueue || []), { abilityId: ai.abilityId, targetId: ai.targetId, turnsRemaining: ab.castTime - 1 }] };
          logs.push(`  ${actor.name} begins casting ${ai.abilityId.replace(/_/g, " ")}`);
        } else {
          const tgt = liveE.find(e => e.id === ai.targetId) || liveE[0];
          const res = execAbility(ai.abilityId, actor, [tgt], logs);
          actor = res.caster;
          for (const t of res.targets) { if (t.isEnemy) enemies = syncUnit(enemies, t); else party = syncUnit(party, t); }
        }
        party = syncUnit(party, actor);
      }

      // enemy turn
      for (let ei = 0; ei < enemies.length; ei++) {
        let actor = enemies[ei]; if (!actor.alive || actor.ccState.stunned) continue;
        const liveP = party.filter(p => p.alive); if (!liveP.length) break;
        const ai = aiChoose(actor, liveP, ctx); if (!ai) continue;
        const ab = ABILITY_DATA[ai.abilityId]; if (!ab) continue;
        if ((ab.castTime || 0) > 0) {
          actor = { ...actor, castQueue: [...(actor.castQueue || []), { abilityId: ai.abilityId, targetId: ai.targetId, turnsRemaining: ab.castTime - 1 }] };
          logs.push(`  ${actor.name} begins casting ${ai.abilityId.replace(/_/g, " ")}`);
        } else {
          const tgt = liveP.find(p => p.id === ai.targetId) || liveP[0];
          const res = execAbility(ai.abilityId, actor, [tgt], logs);
          actor = res.caster;
          for (const t of res.targets) if (!t.isEnemy) party = syncUnit(party, t);
        }
        enemies = syncUnit(enemies, actor);
      }

      // tick DoTs, expire buffs, regen, rotate damage tracking
      for (let i = 0; i < party.length;   i++) { const { unit: u, logs: l } = tickBuffsUnit(party[i]);   logs.push(...l); party[i]   = expireBuffsUnit(u); }
      for (let i = 0; i < enemies.length; i++) { const { unit: u, logs: l } = tickBuffsUnit(enemies[i]); logs.push(...l); enemies[i] = expireBuffsUnit(u); }
      party   = party.map(u => ({ ...tickUnit(u), damageReceivedLastTurn: u.damageReceivedThisTurn, damageReceivedThisTurn: 0 }));
      enemies = enemies.map(u => ({ ...tickUnit(u), damageReceivedLastTurn: u.damageReceivedThisTurn, damageReceivedThisTurn: 0 }));

      if (party.every(u   => !u.alive)) { outcome = "defeat";  logs.push("\n💀 DEFEAT");  }
      if (enemies.every(u => !u.alive)) { outcome = "victory"; logs.push("\n🏆 VICTORY"); }
    }

    if (!outcome) { outcome = "timeout"; logs.push("\n⚠ TIMEOUT"); }
    const kills   = enemies.filter(u => !u.alive);
    const totalXp = kills.reduce((s, u) => s + (u.xpValue || 0), 0);
    return { outcome, turns: turn, logs, kills, totalXp, enemies, party };
  };

  return { run, buildUnit };
})();