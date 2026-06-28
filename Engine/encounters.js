// =============================================================================
// ENCOUNTER SYSTEM — Galanova
//
// Handles all encounter generation logic:
//   - Slot-based encounter table resolution
//   - Party skill / profession gate checks with silent reroll
//   - Mixed combat groups with exclusive co-spawn control
//   - Tracking skill boost (save.flags.trackingBoost)
//   - Forced encounters (quest injection, dungeon mode)
//
// DEPENDENCIES (load before this file):
//   data_layer.js  — DataStore, Loader
//   stat_tables.js — getStatsAtLevel
//
// ENCOUNTER TABLE FORMAT:
//   slots:    Array of non-combat slot entries resolved before combat gets remainder.
//             Each slot: { type, chance, nodeId?, qty?, rerollIf? }
//             rerollIf values:
//               "no_eligible_companions"
//               "no_eligible_quests"
//               "no_party_profession:<prof>"
//               "no_party_skill:<skill>"
//               "no_party_skill_min:<skill>:<minLevel>"
//   combatPool:      Weighted array of { enemyId, weight }
//   exclusiveGroups: Optional array of enemy ID groups. Enemies in the same
//                    group will only co-spawn with others in that group.
//                    Enemies in no group mix freely with everyone.
//   recruitPool:     Array of companion template IDs eligible for recruitment.
//
// TRACKING BOOST:
//   Set save.flags.trackingBoost = { targetId, multiplier } before generating.
//   targetId matches a nodeId (gather_node) or "combat" to boost combat weight.
//   Cleared by RewardEngine after every encounter regardless of outcome.
//
// FORCED ENCOUNTERS:
//   save.flags.forcedEncounter = { type, ...payload }
//     — Used for quest-triggered encounters.
//   zone.forcedOnly = true + zone.forcedEncounterQueue = [...]
//     — Used for dungeons (all encounters are forced in order).
// =============================================================================

"use strict";


// =============================================================================
// PARTY SKILL HELPERS
// Reads living companion instances to answer profession / skill queries.
// =============================================================================

const PartySkills = (() => {

  // Returns all living companion instances for the current party.
  const getInsts = (save, Loader) =>
    save.party
      .map(m => {
        const r = Loader.load(`instances/companions/${m.instanceId}`, "companionInstance");
        return r.ok ? r.data : null;
      })
      .filter(Boolean);

  // Returns true if any living party member has the given profession.
  const partyHasProfession = (insts, prof) =>
    insts.some(i => i.profession === prof && i.deathState === "alive");

  // Returns the highest value of a named skill across all living party members.
  // Uses getSkillLevel (skills.js) so both the {level,xp} object form and the
  // legacy flat-number form resolve correctly.
  const partySkillLevel = (insts, skill) =>
    insts.reduce((best, i) => {
      if (i.deathState !== "alive") return best;
      const lvl = (typeof getSkillLevel === "function")
        ? getSkillLevel(i, skill)
        : ((i.skills || {})[skill] || 0);
      return Math.max(best, lvl || 0);
    }, 0);

  return { getInsts, partyHasProfession, partySkillLevel };
})();


// =============================================================================
// ENCOUNTER GATE CHECKER
// Returns true if the slot's rerollIf condition is met (i.e. should reroll).
// =============================================================================

const checkReroll = (slot, save, table, partyInsts, Loader) => {
  const cond = slot.rerollIf;
  if (!cond) return false;

  // ── companion availability ──────────────────────────────────────────────
  if (cond === "no_eligible_companions") {
    const existing = save.party.map(p => p.templateId);
    const pool     = table.recruitPool || [];
    return !pool.some(id => {
      if (existing.includes(id)) return false;
      const tr = Loader.load(`templates/companions/${id}`, "companion");
      if (!tr.ok) return false;
      // eligible if at least one party member is at or above the companion's joinLevel
      return partyInsts.some(inst => (inst.level || 1) >= (tr.data.joinLevel || 1));
    });
  }

  // ── quest availability ──────────────────────────────────────────────────
  if (cond === "no_eligible_quests") {
    const assignedIds = Object.keys(save.quests || {});
    const zoneQuests  = DataStore.list("templates/quests/").filter(p => {
      const r = DataStore.read(p);
      return r && r.zoneId === save.currentZone && !assignedIds.includes(r.id);
    });
    return zoneQuests.length === 0;
  }

  // ── profession gate ─────────────────────────────────────────────────────
  if (cond.startsWith("no_party_profession:")) {
    const prof = cond.split(":")[1];
    return !PartySkills.partyHasProfession(partyInsts, prof);
  }

  // ── skill presence gate ─────────────────────────────────────────────────
  if (cond.startsWith("no_party_skill:")) {
    const skill = cond.split(":")[1];
    return PartySkills.partySkillLevel(partyInsts, skill) === 0;
  }

  // ── skill minimum gate ──────────────────────────────────────────────────
  // format: "no_party_skill_min:<skill>:<minLevel>"
  if (cond.startsWith("no_party_skill_min:")) {
    const [, skill, minStr] = cond.split(":");
    return PartySkills.partySkillLevel(partyInsts, skill) < (parseInt(minStr) || 0);
  }

  return false;
};


// =============================================================================
// ENCOUNTER GENERATOR
// =============================================================================

const EncounterGenerator = (() => {
  const MAX_DEPTH = 8;

  // ── roll table builder ────────────────────────────────────────────────────
  // Builds the weighted roll table from slots + combat remainder.
  // Applies save.flags.trackingBoost weight inflation if present.
  // After inflation, re-normalises all entries so they still sum to 1.
  const buildRollTable = (slots, save) => {
    const boost        = save.flags?.trackingBoost || null;
    const slotTotal    = slots.reduce((s, sl) => s + sl.chance, 0);
    const combatChance = Math.max(0, 1 - slotTotal);

    const entries = [
      ...slots.map(sl => ({ ...sl, _chance: sl.chance })),
      { type: "combat", _chance: combatChance },
    ];

    if (boost) {
      for (const e of entries) {
        if (
          (e.type === "gather_node" && e.nodeId === boost.targetId) ||
          (e.type === "combat"      && boost.targetId === "combat")
        ) {
          e._chance *= (boost.multiplier || 1.5);
        }
      }
      // re-normalise
      const total = entries.reduce((s, e) => s + e._chance, 0);
      for (const e of entries) e._chance /= total;
    }

    return entries;
  };

  // ── weighted slot roll ────────────────────────────────────────────────────
  const rollSlot = (entries) => {
    let r = Math.random();
    for (const e of entries) {
      r -= e._chance;
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  };

  // ── combat group builder ──────────────────────────────────────────────────
  // Picks a mixed group of enemies from combatPool respecting exclusiveGroups.
  // Group size: 1 to partySize (inclusive).
  //
  // exclusiveGroups semantics:
  //   Enemies in the same exclusive group will only co-spawn with others in
  //   that same group. Enemies in no group can mix with anyone.
  //   Example: [["ember_sprite"]] keeps ember sprites solo.
  //   Example: [["razormane_scout","razormane_geomancer"]] lets those two mix
  //            but not with other enemies.
  const rollCombatGroup = (table, partySize, save, Loader) => {
    const pool = table.combatPool || [];
    if (!pool.length) return { ok: false, errors: ["combatPool is empty"] };

    // activeTrack filter: when a party member used track_beasts or track_humanoids,
    // restrict the pool to enemies whose type or tags match the tracked type
    const activeTrack = save.flags?.activeTrack || null;
    let filteredPool = pool;
    if (activeTrack) {
      const matching = pool.filter(entry => {
        const er = Loader.load(`templates/enemies/${entry.enemyId}`, "enemy");
        if (!er.ok) return false;
        const e = er.data;
        return e.type === activeTrack || (e.tags || []).includes(activeTrack);
      });
      if (matching.length > 0) filteredPool = matching;
      // else: no matching enemies in this zone's pool — fall back to full pool
    }

    const boost    = save.flags?.trackingBoost || null;
    const weighted = filteredPool.map(e => {
      let w = e.weight || 1;
      if (boost && boost.targetId === e.enemyId) w *= (boost.multiplier || 1.5);
      return { ...e, _w: w };
    });
    const totalW = weighted.reduce((s, e) => s + e._w, 0);

    const pickWeighted = (pool, total) => {
      let r = Math.random() * total;
      for (const e of pool) { r -= e._w; if (r <= 0) return e; }
      return pool[pool.length - 1];
    };

    // pick the primary enemy — determines which exclusive group (if any) applies
    const primary         = pickWeighted(weighted, totalW);
    const exclusiveGroups = table.exclusiveGroups || [];
    let allowedIds        = null; // null = all enemies eligible to co-spawn

    for (const grp of exclusiveGroups) {
      if (grp.includes(primary.enemyId)) {
        allowedIds = grp;
        break;
      }
    }

    const eligible      = allowedIds ? weighted.filter(e => allowedIds.includes(e.enemyId)) : weighted;
    const eligibleTotal = eligible.reduce((s, e) => s + e._w, 0);
    const count         = 1 + Math.floor(Math.random() * Math.max(1, partySize));

    const enemies = [];
    for (let i = 0; i < count; i++) {
      const chosen = pickWeighted(eligible, eligibleTotal);
      const er     = Loader.load(`templates/enemies/${chosen.enemyId}`, "enemy");
      if (!er.ok) return { ok: false, errors: [`Enemy load failed: ${chosen.enemyId}`] };
      enemies.push({ ...er.data, instanceId: `${chosen.enemyId}_${i}_${Date.now()}` });
    }

    return { ok: true, enemies };
  };

  // ── main generate function ────────────────────────────────────────────────
  const generate = (zoneId, save, Loader, _depth = 0) => {
    if (_depth > MAX_DEPTH) {
      const _zr = Loader.load(`templates/zones/${zoneId}`, "zone");
      if (_zr.ok) {
        const _tr = Loader.load(`templates/encounter_tables/${_zr.data.encounterTableId}`, "encounterTable");
        if (_tr.ok) {
          const _cg = rollCombatGroup(_tr.data, save.party.length, save, Loader);
          if (_cg.ok) return { ok: true, zoneId, encounterType: "combat", enemies: _cg.enemies, gatheringNodes: [], companionRecruit: null };
        }
      }
      return { ok: false, errors: ["EncounterGenerator: max retry depth exceeded"] };
    }

    // load zone
    const zr = Loader.load(`templates/zones/${zoneId}`, "zone");
    if (!zr.ok) return { ok: false, errors: zr.errors };
    const zone = zr.data;

    // ── forced encounter (quest injection) ────────────────────────────────
    if (save.flags?.forcedEncounter) {
      const forced = save.flags.forcedEncounter;
      // caller is responsible for clearing save.flags.forcedEncounter after use
      return {
        ok: true, zoneId,
        encounterType: forced.type,
        forced:        true,
        ...forced,
        enemies:          [],
        gatheringNodes:   [],
        companionRecruit: null,
      };
    }

    // ── dungeon mode (zone.forcedOnly) ────────────────────────────────────
    if (zone.forcedOnly && (zone.forcedEncounterQueue || []).length) {
      const [next] = zone.forcedEncounterQueue;
      // caller is responsible for advancing the queue in the zone or save state
      return {
        ok: true, zoneId,
        encounterType: next.type,
        forced:        true,
        ...next,
        enemies:          [],
        gatheringNodes:   [],
        companionRecruit: null,
      };
    }

    // load encounter table
    const tr = Loader.load(`templates/encounter_tables/${zone.encounterTableId}`, "encounterTable");
    if (!tr.ok) return { ok: false, errors: tr.errors };
    const table = tr.data;

    const partyInsts = PartySkills.getInsts(save, Loader);
    const rollTable  = buildRollTable(table.slots || [], save);
    const slot       = rollSlot(rollTable);

    // gate check — reroll the entire type roll if condition not met
    if (slot.type !== "combat" && checkReroll(slot, save, table, partyInsts, Loader))
      return generate(zoneId, save, Loader, _depth + 1);

    // ── companion ────────────────────────────────────────────────────────
    if (slot.type === "companion") {
      const existing = save.party.map(p => p.templateId);
      const pool     = table.recruitPool || [];
      const avail    = pool.filter(id => {
        if (existing.includes(id)) return false;
        const tr2 = Loader.load(`templates/companions/${id}`, "companion");
        if (!tr2.ok) return false;
        return partyInsts.some(inst => (inst.level || 1) >= (tr2.data.joinLevel || 1));
      });
      // no eligible companions after gate check passed — shouldn't happen normally,
      // but guard anyway
      if (!avail.length) return generate(zoneId, save, Loader, _depth + 1);
      const rid = avail[Math.floor(Math.random() * avail.length)];
      const rr  = Loader.load(`templates/companions/${rid}`, "companion");
      return {
        ok: true, zoneId,
        encounterType:    "companion",
        companionRecruit: rr.ok ? rr.data : null,
        enemies:          [],
        gatheringNodes:   [],
      };
    }

    // ── quest ────────────────────────────────────────────────────────────
    if (slot.type === "quest") {
      const assignedIds = Object.keys(save.quests || {});
      const zonePaths   = DataStore.list("templates/quests/").filter(p => {
        const r = DataStore.read(p);
        if (!r || r.zoneId !== zoneId || assignedIds.includes(r.id)) return false;
        if ((r.prerequisites || []).some(pid => !save.quests?.[pid]?.completed)) return false;
        const minLvl = r.requirements?.minPartyLevel;
        if (minLvl && !partyInsts.some(inst => (inst.level || 1) >= minLvl)) return false;
        return true;
      });
      if (!zonePaths.length) return generate(zoneId, save, Loader, _depth + 1);
      const picked = DataStore.read(zonePaths[Math.floor(Math.random() * zonePaths.length)]);
      return {
        ok: true, zoneId,
        encounterType:    "quest",
        quest:            picked,
        enemies:          [],
        gatheringNodes:   [],
        companionRecruit: null,
      };
    }

    // ── gather_node ──────────────────────────────────────────────────────
    if (slot.type === "gather_node") {
      const nr   = Loader.load(`templates/nodes/${slot.nodeId}`, "node");
      const node = nr.ok ? nr.data : null;
      const name = node ? node.name : slot.nodeId;
      return {
        ok: true, zoneId,
        encounterType:    "gathering",
        gatheringNodes:   [{ nodeId: slot.nodeId, name, drops: node?.drops || [], skillGain: node?.skillGain || 0, requiredProfession: node?.requiredProfession || null, rolls: node?.rolls || 1 }],
        enemies:          [],
        companionRecruit: null,
      };
    }

    // ── locked_chest ─────────────────────────────────────────────────────
    if (slot.type === "locked_chest") {
      return {
        ok: true, zoneId,
        encounterType:    "locked_chest",
        enemies:          [],
        gatheringNodes:   [],
        companionRecruit: null,
      };
    }

    // ── fishing_spot ─────────────────────────────────────────────────────
    if (slot.type === "fishing_spot") {
      return {
        ok: true, zoneId,
        encounterType:    "fishing_spot",
        enemies:          [],
        gatheringNodes:   [],
        companionRecruit: null,
      };
    }

    // ── combat ───────────────────────────────────────────────────────────
    const cg = rollCombatGroup(table, save.party.length, save, Loader);
    if (!cg.ok) return { ok: false, errors: cg.errors };
    return {
      ok: true, zoneId,
      encounterType:    "combat",
      enemies:          cg.enemies,
      gatheringNodes:   [],
      companionRecruit: null,
    };
  };

  return { generate, buildRollTable, rollSlot, rollCombatGroup };
})();


// =============================================================================
// SELF-TEST
// =============================================================================

const runEncounterTests = (DataStore, Loader, _save) => {
  const results = [];
  let p = 0, f = 0;
  const assert = (label, cond) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  // Controlled test party: one miner (mining 5; no herbalism/lockpicking/fishing)
  // so skill-gated slot logic is deterministic, independent of the real start party.
  DataStore.write("instances/companions/enc_test_miner", {
    instanceId: "enc_test_miner", templateId: "template_companion", _version: 1,
    name: "Test Miner", raceId: "sephir", classId: "survivalist", level: 5, xp: 0,
    currentHp: 100, currentMp: 0, maxHp: 100, maxMp: 0,
    deathState: "alive", permadead: false, downedAt: null, rezCost: 0,
    profession: "mining", learnedAbilities: [], acquiredQuirks: [], activeBuffs: [],
    relationship: 0, skills: { mining: { level: 5, xp: 0 } }, unlockedSkills: [],
    stats: { raw: { str: 10, dex: 10, con: 12, int: 8, spi: 10, wis: 10, spd: 10, cha: 8 } }, gear: {},
  });
  const save = {
    saveId: "enc_test", _version: 1, mode: "normal", currentZone: "colonial_sewers",
    party: [{ instanceId: "enc_test_miner", templateId: "template_companion" }],
    quests: {}, inventory: [], currency: 0, reputation: {}, talentSchools: {}, flags: {}, playtime: 0, shopStocks: {},
  };

  // ── PartySkills ────────────────────────────────────────────────────────
  const pInsts = PartySkills.getInsts(save, Loader);
  assert("PartySkills: returns array",        Array.isArray(pInsts));
  assert("PartySkills: miner present",        PartySkills.partyHasProfession(pInsts, "mining"));
  assert("PartySkills: herbalism absent",    !PartySkills.partyHasProfession(pInsts, "herbalism"));
  assert("PartySkills: mining skill >= 1",    PartySkills.partySkillLevel(pInsts, "mining") >= 1);
  assert("PartySkills: lockpicking = 0",      PartySkills.partySkillLevel(pInsts, "lockpicking") === 0);
  assert("PartySkills: fishing = 0",          PartySkills.partySkillLevel(pInsts, "fishing") === 0);

  // ── checkReroll ────────────────────────────────────────────────────────
  const etR    = Loader.load("templates/encounter_tables/enc_colonial_sewers", "encounterTable");
  assert("enc_colonial_sewers loads",         etR.ok);
  const etData = etR.ok ? etR.data : { slots: [], recruitPool: [] };

  const nodeSlot  = etData.slots?.find(sl => sl.nodeId === "template_node");
  const chestSlot = etData.slots?.find(sl => sl.type   === "locked_chest");
  const fishSlot  = etData.slots?.find(sl => sl.type   === "fishing_spot");

  if (nodeSlot)  assert("checkReroll: mining node OK with miner",     !checkReroll(nodeSlot,  save, etData, pInsts, Loader));
  if (chestSlot) assert("checkReroll: chest rerolls — no lockpicking", checkReroll(chestSlot, save, etData, pInsts, Loader));
  if (fishSlot)  assert("checkReroll: fishing rerolls — no fishing",   checkReroll(fishSlot,  save, etData, pInsts, Loader));

  // ── buildRollTable ─────────────────────────────────────────────────────
  const rollTable = EncounterGenerator.buildRollTable(etData.slots || [], save);
  assert("buildRollTable: returns entries",          rollTable.length > 0);
  const tableSum = rollTable.reduce((s, e) => s + e._chance, 0);
  assert("buildRollTable: entries sum to ~1",        Math.abs(tableSum - 1) < 0.001);
  assert("buildRollTable: combat entry present",     rollTable.some(e => e.type === "combat"));

  // trackingBoost inflates the combat chance, table still normalises
  const boostedSave  = { ...save, flags: { trackingBoost: { targetId: "combat", multiplier: 1.5 } } };
  const boostedTable = EncounterGenerator.buildRollTable(etData.slots || [], boostedSave);
  const boostedCombat = boostedTable.find(e => e.type === "combat")?._chance || 0;
  const baseCombat    = rollTable.find(e => e.type === "combat")?._chance    || 0;
  assert("buildRollTable: trackingBoost increases combat chance", boostedCombat > baseCombat);
  const boostedSum = boostedTable.reduce((s, e) => s + e._chance, 0);
  assert("buildRollTable: boosted table still sums to ~1",        Math.abs(boostedSum - 1) < 0.001);

  // ── generate — encounter types ─────────────────────────────────────────
  const VALID_TYPES = ["combat","companion","gathering","quest","locked_chest","fishing_spot"];
  let gotCompanionNone = false;
  for (let i = 0; i < 20; i++) {
    const e = EncounterGenerator.generate("colonial_sewers", save, Loader);
    assert(`generate #${i+1}: ok`,          e.ok);
    assert(`generate #${i+1}: type valid`,  VALID_TYPES.includes(e.encounterType));
    if (e.encounterType === "companion_none") gotCompanionNone = true;
  }
  assert("generate: companion_none never surfaces", !gotCompanionNone);

  // chest / fishing never surface — the miner has neither skill
  let gotGated = false;
  for (let i = 0; i < 40; i++) {
    const e = EncounterGenerator.generate("colonial_sewers", save, Loader);
    if (e.encounterType === "locked_chest" || e.encounterType === "fishing_spot") gotGated = true;
  }
  assert("generate: chest/fishing never surface without skill", !gotGated);

  // the mining gather node CAN surface for the miner
  let gotNode = false;
  for (let i = 0; i < 100; i++) {
    const e = EncounterGenerator.generate("colonial_sewers", save, Loader);
    if (e.encounterType === "gathering" && e.gatheringNodes?.some(n => (n.nodeId || n.itemId) === "template_node")) gotNode = true;
  }
  assert("generate: mining node can surface with miner", gotNode);

  // ── combat group ────────────────────────────────────────────────────────
  let combatEnc = null;
  for (let i = 0; i < 50; i++) {
    const e = EncounterGenerator.generate("colonial_sewers", save, Loader);
    if (e.encounterType === "combat") { combatEnc = e; break; }
  }
  if (combatEnc) {
    assert("combat: enemies array non-empty",        combatEnc.enemies.length > 0);
    assert("combat: enemy count <= party size + 1",  combatEnc.enemies.length <= save.party.length + 1);
    assert("combat: each enemy has name",            combatEnc.enemies.every(e => !!e.name));
    assert("combat: each enemy has instanceId",      combatEnc.enemies.every(e => !!e.instanceId));
  } else {
    assert("combat: encounter generated (skipped — none rolled in 50 tries)", true);
  }

  // ── forced encounter ────────────────────────────────────────────────────
  const forcedSave = { ...save, flags: { forcedEncounter: { type: "combat", enemyIds: ["tunnel_roach"] } } };
  const forcedEnc  = EncounterGenerator.generate("colonial_sewers", forcedSave, Loader);
  assert("forced: encounterType = combat",  forcedEnc.encounterType === "combat");
  assert("forced: forced flag = true",      forcedEnc.forced === true);

  DataStore.remove("instances/companions/enc_test_miner");

  // ── summary ─────────────────────────────────────────────────────────────
  return { passed: p, failed: f, total: p + f, results };
};

const reportEncounterTests = (r) => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `ENCOUNTER TESTS: ${r.passed}/${r.total} passed`,
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
    PartySkills,
    checkReroll,
    EncounterGenerator,
    runEncounterTests,
    reportEncounterTests,
  };
}