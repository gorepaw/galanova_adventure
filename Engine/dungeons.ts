// =============================================================================
// DUNGEON SYSTEM — Galanova
//
// Extends the zone schema, encounter generator, and save schema to support
// linear dungeon zones with boss encounters, lore text beats, and player-
// chosen forks.
//
// DEPENDENCIES:
//   datalayer.ts    — Modifiers
//   encounters.ts   — EncounterGenerator (patched below)
//   gameplayloop.js — RewardEngine (ambient global; patched after it loads)
//
// INTEGRATION NOTES:
//   1. Call patchEncounterGenerator() once at boot, after encounter.js loads.
//      This replaces EncounterGenerator.generate with the dungeon-aware version.
//   2. In your UI layer, check zone.isDungeon to gate shop/crafting buttons.
//   3. DungeonManager.enter(zoneId, save) — MUST be called in the travel/zone-
//      change handler when the destination zone has isDungeon:true.  Returns
//      { save } with dungeonProgress initialised.  Do NOT rely on the encounter
//      generator to auto-enter; the generator reads dungeonProgress but does not
//      write it back to the outer save variable.
//   4. DungeonManager.advance(save, Loader) — call after each encounter resolves.
//      Returns { save, fork } where fork is non-null when the player must
//      choose a branch.  Loader is required — omitting it silently no-ops.
//   5. DungeonManager.exit(save) — call when the player leaves voluntarily.
//      Clears dungeonProgress without resetting queue (progress persists until
//      explicit wipe or completion).
//   6. DungeonManager.wipe(save) — call on normal-mode dungeon wipe.
//      Preserves dungeonProgress (player retries from same room).
//
// =============================================================================

import { Modifiers } from "./datalayer.js";
import { EncounterGenerator } from "./encounters.js";
// gameplayloop is checked under its own relaxed tsconfig, so its exports are
// pulled in via require() to keep it out of the strict program that checks this file.
const { RewardEngine } = require("./gameplayloop.js");

type LoaderLike = { load: (path: string, schema: string) => { ok: boolean; data: any; errors?: string[] } };


// =============================================================================
// SCHEMA EXTENSIONS
// These extend the existing SCHEMAS object from data_layer.js.
// Merge into SCHEMAS after data_layer.js loads.
// =============================================================================

export const DUNGEON_SCHEMA_PATCHES = {

  // ── zone additions ────────────────────────────────────────────────────────
  // Adds isDungeon to the existing zone schema.
  // All other zone fields are unchanged.
  zone_patch: {
    isDungeon: { type: "boolean" },
    // forcedOnly and forcedEncounterQueue already exist in the zone schema.
    // isDungeon is the UI gate flag — forcedOnly is the encounter gate flag.
    // A dungeon zone should set both.
  },

  // ── dungeon encounter queue entry ─────────────────────────────────────────
  // Each entry in zone.forcedEncounterQueue conforms to this shape.
  // Validated at dungeon-enter time, not in the main item schema.
  dungeonQueueEntry: {
    $id: "dungeonQueueEntry",
    type: "object",
    required: ["type"],
    properties: {
      type: {
        type: "string",
        enum: ["combat", "boss", "text", "trap"],
      },

      // ── trap ──────────────────────────────────────────────────────────────
      // References a trap template (Data/traps.json → templates/traps/<id>).
      // Resolution (detection rolls, dungeoneering XP, effect) is shared with
      // world traps via TrapSystem.resolve in the gameplay loop.
      trapId: { type: "string" },

      // ── combat ────────────────────────────────────────────────────────────
      // Explicit enemy list instead of pool rolling.
      // Each entry: { enemyId, count? }  count defaults to 1.
      enemyIds: {
        type: "array",
        items: {
          type: "object",
          required: ["enemyId"],
          properties: {
            enemyId: { type: "string" },
            count:   { type: "integer", minimum: 1 },
          },
        },
      },

      // ── boss (superset of combat) ─────────────────────────────────────────
      // Uses the same CombatBridge.run() path — all boss extras are metadata.
      introDialogue: {
        type: "array",
        items: { type: "string" },
      },
      // midDialogue: { triggerHpPct, lines[] } — fires once when boss HP drops
      // below triggerHpPct.  UI layer is responsible for checking and firing.
      midDialogue: {
        type: "object",
        properties: {
          triggerHpPct: { type: "number", minimum: 0, maximum: 1 },
          lines:        { type: "array", items: { type: "string" } },
          fired:        { type: "boolean" },
        },
      },
      outroDialogue: {
        type: "array",
        items: { type: "string" },
      },
      // guaranteedLoot: items dropped regardless of RNG, after combat loot roll.
      guaranteedLoot: {
        type: "array",
        items: {
          type: "object",
          required: ["itemId", "qty"],
          properties: {
            itemId: { type: "string" },
            qty:    { type: "integer", minimum: 1 },
          },
        },
      },
      // questFlags: set on save.flags after boss dies.
      questFlags: {
        type: "array",
        items: { type: "string" },
      },

      // ── text ──────────────────────────────────────────────────────────────
      // Pure flavour / lore beat.  No combat, no rewards.
      lines: {
        type: "array",
        items: { type: "string" },
      },
      // Optional: speaker name shown before the line block.
      speaker: { type: "string" },

      // ── fork (any type) ───────────────────────────────────────────────────
      // nextEncounters: if present and non-empty, the player chooses which
      // branch to follow after this encounter resolves.
      // Each entry is a zoneId string pointing to another dungeon zone, OR
      // the string "continue" which means "stay on this queue".
      //
      // When the player chooses:
      //   - "continue" → advance queueIndex normally on the current zone
      //   - zoneId     → DungeonManager.enter(zoneId, save) to start a wing
      //
      // The UI layer calls DungeonManager.chooseFork(save, choice) to record
      // the decision and return an updated save.
      nextEncounters: {
        type: "array",
        items: { type: "string" },
      },
      forkLabels: {
        type: "array",
        items: { type: "string" },
        // parallel to nextEncounters — human-readable label per branch
      },
    },
    additionalProperties: true,
  },

  // ── save.flags.dungeonProgress ────────────────────────────────────────────
  dungeonProgress: {
    $id: "dungeonProgress",
    type: "object",
    required: ["zoneId", "queueIndex"],
    properties: {
      zoneId:     { type: "string" },
      queueIndex: { type: "integer", minimum: 0 },
      // pendingFork: set when the current encounter has nextEncounters and the
      // player has not yet chosen.  The UI reads this to show the fork UI.
      pendingFork: {
        oneOf: [
          {
            type: "object",
            required: ["choices"],
            properties: {
              choices: { type: "array", items: { type: "string" } },
              labels:  { type: "array", items: { type: "string" } },
            },
          },
          { type: "null" },
        ],
      },
    },
    additionalProperties: false,
  },
};


// =============================================================================
// DUNGEON MANAGER
// Manages dungeon entry, progress advancement, fork resolution, and exit.
// All methods are pure — they return a new save rather than mutating in place.
// =============================================================================

export const DungeonManager = (() => {

  // ── enter ─────────────────────────────────────────────────────────────────
  // Sets dungeonProgress to the start of the queue.
  // Always resets queueIndex to 0 on entry (fresh run).
  // Preserves any in-progress run if already inside this dungeon
  // (re-entering the same zone mid-run does not reset progress).
  const enter = (zoneId: string, save: any): { save: any } => {
    const existing = save.flags?.dungeonProgress;
    if (existing && existing.zoneId === zoneId) {
      // already in this dungeon — don't reset
      return { save };
    }
    const progress = { zoneId, queueIndex: 0, pendingFork: null };
    return {
      save: Modifiers.setFlag(save, "dungeonProgress", progress),
    };
  };

  // ── getCurrentEncounter ───────────────────────────────────────────────────
  // Returns the queue entry at the current queueIndex, or null if done.
  const getCurrentEncounter = (save: any, Loader: LoaderLike): any => {
    const prog = save.flags?.dungeonProgress;
    if (!prog) return null;
    const zr = Loader.load(`templates/zones/${prog.zoneId}`, "zone");
    if (!zr.ok) return null;
    const queue = zr.data.forcedEncounterQueue || [];
    if (prog.queueIndex >= queue.length) return null;
    return queue[prog.queueIndex];
  };

  // ── advance ───────────────────────────────────────────────────────────────
  // Called after an encounter resolves (combat over, text read, etc.).
  // If the current entry has nextEncounters, sets pendingFork and returns
  // { save, fork: { choices, labels } }.
  // Otherwise advances queueIndex.
  // Returns { save, fork: null | { choices, labels }, complete: bool }.
  const advance = (save: any, Loader: LoaderLike): { save: any; fork: any; complete: boolean } => {
    const prog = save.flags?.dungeonProgress;
    if (!prog) return { save, fork: null, complete: false };

    const zr = Loader.load(`templates/zones/${prog.zoneId}`, "zone");
    if (!zr.ok) return { save, fork: null, complete: false };
    const queue = zr.data.forcedEncounterQueue || [];
    const entry = queue[prog.queueIndex];

    // check for fork
    if (entry?.nextEncounters?.length) {
      const fork = {
        choices: entry.nextEncounters,
        labels:  entry.forkLabels || entry.nextEncounters,
      };
      const newProg = { ...prog, pendingFork: fork };
      return {
        save: Modifiers.setFlag(save, "dungeonProgress", newProg),
        fork,
        complete: false,
      };
    }

    // advance normally
    const nextIndex = prog.queueIndex + 1;
    const complete  = nextIndex >= queue.length;
    const newProg   = { ...prog, queueIndex: nextIndex, pendingFork: null };
    let s = Modifiers.setFlag(save, "dungeonProgress", newProg);

    if (complete) {
      // dungeon finished — clear progress
      s = Modifiers.clearFlag(s, "dungeonProgress");
    }

    return { save: s, fork: null, complete };
  };

  // ── chooseFork ────────────────────────────────────────────────────────────
  // Records the player's fork choice.
  // choice: one of the strings from pendingFork.choices.
  //   "continue" → advance queueIndex on current zone
  //   zoneId     → enter that dungeon zone (resets queueIndex to 0 for that wing)
  // Returns { save, enteredZone: string | null }.
  const chooseFork = (choice: string, save: any): { save: any; enteredZone: string | null } => {
    const prog = save.flags?.dungeonProgress;
    if (!prog?.pendingFork) return { save, enteredZone: null };

    if (choice === "continue") {
      const newProg = { ...prog, queueIndex: prog.queueIndex + 1, pendingFork: null };
      return {
        save: Modifiers.setFlag(save, "dungeonProgress", newProg),
        enteredZone: null,
      };
    }

    // branch into a new wing zone
    const newProg = { zoneId: choice, queueIndex: 0, pendingFork: null };
    return {
      save: Modifiers.setFlag(
        { ...save, currentZone: choice },
        "dungeonProgress",
        newProg,
      ),
      enteredZone: choice,
    };
  };

  // ── exit ──────────────────────────────────────────────────────────────────
  // Voluntary exit — clears progress (player will restart from 0 next time).
  const exit = (save: any, returnZoneId?: string): { save: any } => ({
    save: {
      ...Modifiers.clearFlag(save, "dungeonProgress"),
      currentZone: returnZoneId || save.currentZone,
    },
  });

  // ── wipe ──────────────────────────────────────────────────────────────────
  // Dungeon wipe in normal mode.
  // Progress is PRESERVED so the party can retry from the same room.
  // Currency penalty is applied by DeathHandler.handleWipe — this just
  // ensures progress is not accidentally cleared.
  const wipe = (save: any): { save: any } => {
    // dungeonProgress is already in save.flags — DeathHandler.handleWipe
    // calls Modifiers.clearFlag("trackingBoost") but leaves dungeonProgress.
    // Nothing extra needed here; this is a no-op hook for future extension.
    return { save };
  };

  // ── isComplete ────────────────────────────────────────────────────────────
  const isComplete = (save: any, Loader: LoaderLike): boolean => {
    const prog = save.flags?.dungeonProgress;
    if (!prog) return false;
    const zr = Loader.load(`templates/zones/${prog.zoneId}`, "zone");
    if (!zr.ok) return false;
    const queue = zr.data.forcedEncounterQueue || [];
    return prog.queueIndex >= queue.length;
  };

  return {
    enter,
    getCurrentEncounter,
    advance,
    chooseFork,
    exit,
    wipe,
    isComplete,
  };
})();


// =============================================================================
// ENCOUNTER BUILDER
// Turns a dungeonQueueEntry into a fully resolved encounter packet that
// CombatBridge.run() and the existing reward pipeline can consume.
// =============================================================================

export const DungeonEncounterBuilder = (() => {

  // Expands an enemyIds spec into a flat array of loaded enemy templates,
  // each with a unique instanceId stamped on.
  const buildEnemyList = (enemyIds: any[], Loader: LoaderLike): any[] => {
    const enemies = [];
    for (const spec of (enemyIds || [])) {
      const count = spec.count || 1;
      for (let i = 0; i < count; i++) {
        const er = Loader.load(`templates/enemies/${spec.enemyId}`, "enemy");
        if (!er.ok) {
          console.warn(`DungeonEncounterBuilder: unknown enemy "${spec.enemyId}"`);
          continue;
        }
        enemies.push({
          ...er.data,
          ...(spec.level != null ? { level: spec.level } : {}),
          instanceId: `${spec.enemyId}_${i}_${Date.now()}`,
        });
      }
    }
    return enemies;
  };

  // Builds a combat encounter packet from a "combat" or "boss" queue entry.
  const buildCombatEncounter = (entry: any, zoneId: string, Loader: LoaderLike) => ({
    ok:               true,
    zoneId,
    encounterType:    entry.type,   // "combat" or "boss"
    enemies:          buildEnemyList(entry.enemyIds, Loader),
    gatheringNodes:   [],
    companionRecruit: null,
    // boss extras — passed through for the UI layer to render
    introDialogue:    entry.introDialogue    || [],
    midDialogue:      entry.midDialogue      || null,
    outroDialogue:    entry.outroDialogue    || [],
    guaranteedLoot:   entry.guaranteedLoot   || [],
    questFlags:       entry.questFlags       || [],
    isBoss:           entry.type === "boss",
  });

  // Builds a trap encounter packet from a "trap" queue entry. Loads the trap
  // template so the shared TrapSystem resolver (gameplay loop) can run it.
  const buildTrapEncounter = (entry: any, zoneId: string, Loader: LoaderLike) => {
    const tr = Loader.load(`templates/traps/${entry.trapId}`, "trap");
    return {
      ok:               true,
      zoneId,
      encounterType:    "trap",
      trap:             tr.ok ? tr.data : null,
      enemies:          [],
      gatheringNodes:   [],
      companionRecruit: null,
    };
  };

  // Builds a text encounter packet.
  const buildTextEncounter = (entry: any, zoneId: string) => ({
    ok:               true,
    zoneId,
    encounterType:    "text",
    enemies:          [],
    gatheringNodes:   [],
    companionRecruit: null,
    lines:            entry.lines   || [],
    speaker:          entry.speaker || null,
  });

  // Resolves any queue entry to an encounter packet.
  const build = (entry: any, zoneId: string, Loader: LoaderLike): any => {
    if (!entry) return { ok: false, errors: ["No queue entry"] };
    if (entry.type === "combat" || entry.type === "boss")
      return buildCombatEncounter(entry, zoneId, Loader);
    if (entry.type === "text")
      return buildTextEncounter(entry, zoneId);
    if (entry.type === "trap")
      return buildTrapEncounter(entry, zoneId, Loader);
    return { ok: false, errors: [`Unknown dungeon encounter type: "${entry.type}"`] };
  };

  return { build, buildEnemyList };
})();


// =============================================================================
// ENCOUNTER GENERATOR PATCH
// Wraps the existing EncounterGenerator.generate to handle dungeon zones.
// Call patchEncounterGenerator() once after encounter.js loads.
// =============================================================================

export const patchEncounterGenerator = (): void => {
  const _original = EncounterGenerator.generate;

  EncounterGenerator.generate = (zoneId: string, save: any, Loader: LoaderLike, _depth = 0) => {
    // load zone to check isDungeon
    const zr = Loader.load(`templates/zones/${zoneId}`, "zone");
    if (!zr.ok) return _original(zoneId, save, Loader, _depth);
    const zone = zr.data;

    if (!zone.isDungeon) {
      // normal zone — delegate to original generator
      return _original(zoneId, save, Loader, _depth);
    }

    // ── dungeon zone ──────────────────────────────────────────────────────
    const prog = save.flags?.dungeonProgress;

    // if dungeonProgress is missing the zone was entered without calling
    // DungeonManager.enter() — this is a UI integration error; fail loudly.
    if (!prog || prog.zoneId !== zoneId) {
      console.error(`patchEncounterGenerator: no dungeonProgress for "${zoneId}". Call DungeonManager.enter() on travel.`);
      return { ok: false, errors: [`dungeonProgress missing for zone "${zoneId}" — call DungeonManager.enter() on travel`] };
    }

    // pendingFork means the player needs to choose before we can proceed
    if (save.flags?.dungeonProgress?.pendingFork) {
      return {
        ok:            true,
        zoneId,
        encounterType: "fork",
        fork:          save.flags.dungeonProgress.pendingFork,
        enemies:       [],
        gatheringNodes: [],
      };
    }

    const entry = DungeonManager.getCurrentEncounter(save, Loader);
    if (!entry) {
      // queue exhausted — dungeon complete
      return {
        ok:            true,
        zoneId,
        encounterType: "dungeon_complete",
        enemies:       [],
        gatheringNodes: [],
      };
    }

    return DungeonEncounterBuilder.build(entry, zoneId, Loader);
  };
};


// =============================================================================
// REWARD ENGINE PATCH
// Handles guaranteedLoot and questFlags for boss encounters.
// Call patchRewardEngine() once after game_loop.js loads.
// =============================================================================

export const patchRewardEngine = (): void => {
  const _originalApply: any = RewardEngine.apply;

  RewardEngine.apply = (combatResult: any, encounter: any, save: any) => {
    // run base reward logic first
    let { save: s, summary } = _originalApply(combatResult, encounter, save);

    if (combatResult.outcome !== "victory") return { save: s, summary };

    // ── guaranteed loot (boss) ────────────────────────────────────────────
    for (const drop of (encounter.guaranteedLoot || [])) {
      s = Modifiers.addToInventory(s, drop.itemId, drop.qty);
      summary.loot.push({ ...drop, source: "guaranteed" });
    }

    // ── quest flags (boss) ────────────────────────────────────────────────
    for (const flag of (encounter.questFlags || [])) {
      s = Modifiers.setFlag(s, flag, true);
    }

    return { save: s, summary };
  };
};


// =============================================================================
// HOME SCREEN PATCH
// Extends the existing HomeScreen.createSession to handle the new encounter
// types: "boss", "text", "fork", "dungeon_complete".
// Also gates shop/crafting in isDungeon zones.
//
// Call patchHomeScreen() after game_loop.js loads.
// The patch adds runEncounterDungeonExtras() which the UI calls after
// CombatBridge.run() for boss encounters (dialogue, progress advance).
// =============================================================================

export const DungeonUI = (() => {

  // Returns true if the current zone is a dungeon.
  const isInDungeon = (save: any, Loader: LoaderLike): boolean => {
    const zr = Loader.load(`templates/zones/${save.currentZone}`, "zone");
    return zr.ok && !!zr.data.isDungeon;
  };

  // Builds the lines to emit for a "text" encounter.
  const renderTextEncounter = (encounter: any): string[] => {
    const lines = [];
    lines.push(`\n📜 ${encounter.speaker ? encounter.speaker + ":" : "You read:"}`);
    for (const l of (encounter.lines || [])) lines.push(`  "${l}"`);
    return lines;
  };

  // Builds the lines to emit for a "fork" encounter.
  const renderForkEncounter = (encounter: any): string[] => {
    const lines = [];
    lines.push(`\n⚔ The path forks ahead.`);
    const { choices, labels } = encounter.fork;
    choices.forEach((c: string, i: number) => lines.push(`  [${i + 1}] ${labels[i] || c}`));
    lines.push(`\n  Type 'fork <number>' to choose.`);
    return lines;
  };

  // Builds intro dialogue lines for a boss encounter.
  const renderBossIntro = (encounter: any): string[] => {
    const lines = [];
    if (encounter.introDialogue?.length) {
      lines.push(`\n💀 Boss encounter!`);
      for (const l of encounter.introDialogue) lines.push(`  "${l}"`);
    }
    return lines;
  };

  // Builds outro dialogue lines after a boss is defeated.
  const renderBossOutro = (encounter: any): string[] => {
    const lines = [];
    if (encounter.outroDialogue?.length) {
      for (const l of encounter.outroDialogue) lines.push(`  "${l}"`);
    }
    return lines;
  };

  // Builds dungeon complete lines.
  const renderDungeonComplete = (zoneId: string, Loader: LoaderLike): string[] => {
    const zr = Loader.load(`templates/zones/${zoneId}`, "zone");
    const name = zr.ok ? zr.data.name : zoneId;
    return [`\n🏆 ${name} cleared!`];
  };

  return {
    isInDungeon,
    renderTextEncounter,
    renderForkEncounter,
    renderBossIntro,
    renderBossOutro,
    renderDungeonComplete,
  };
})();


// =============================================================================
// EXAMPLE DUNGEON ZONE
// Paste into your seed function or DataStore.write calls to test.
// =============================================================================

// TEMPLATE example — neutral placeholder showing the forced-encounter dungeon
// shape. Replace enemy/loot ids and dialogue with Galanova content.
export const EXAMPLE_DUNGEON_ZONE = {
  id:              "template_dungeon",
  name:            "Template Dungeon",
  _version:        1,
  isDungeon:       true,
  forcedOnly:      true,
  encounterTableId:"enc_colonial_sewers",  // fallback, never used when forcedOnly:true
  minPartyLevel:   1,
  maxPartyLevel:   5,
  ambientBuffs:    [],
  shopInventory:   [],             // no shop — isDungeon gates this in UI
  sellMultiplier:  0.25,
  tags:            ["dungeon","template"],
  lore:            "TEMPLATE — placeholder dungeon. Replace with Galanova content.",

  forcedEncounterQueue: [
    // ── room 1 — flavour beat ────────────────────────────────────────────
    {
      type:    "text",
      speaker: "Narrator",
      lines: [
        "TEMPLATE — placeholder intro text.",
      ],
    },

    // ── room 2 — standard combat ─────────────────────────────────────────
    {
      type:     "combat",
      enemyIds: [
        { enemyId: "tunnel_roach", count: 2 },
      ],
    },

    // ── room 3 — fork ────────────────────────────────────────────────────
    {
      type:     "combat",
      enemyIds: [{ enemyId: "tunnel_roach", count: 3 }],
      nextEncounters: ["template_wing_a", "template_wing_b"],
      forkLabels:     ["Left passage", "Right passage"],
    },
  ],
};

export const EXAMPLE_WING_A = {
  id:              "template_wing_a",
  name:            "Left Passage",
  _version:        1,
  isDungeon:       true,
  forcedOnly:      true,
  encounterTableId:"enc_colonial_sewers",
  minPartyLevel:   1,
  maxPartyLevel:   5,
  ambientBuffs:    [],
  shopInventory:   [],
  sellMultiplier:  0.25,
  tags:            ["dungeon","template"],
  lore:            "TEMPLATE — placeholder dungeon wing.",

  forcedEncounterQueue: [
    {
      type:     "combat",
      enemyIds: [{ enemyId: "tunnel_roach", count: 2 }],
    },
    {
      type:           "boss",
      enemyIds:       [{ enemyId: "tunnel_roach" }],
      introDialogue:  [
        "TEMPLATE — placeholder boss intro.",
      ],
      midDialogue: {
        triggerHpPct: 0.4,
        lines: ["TEMPLATE — placeholder boss mid-fight line."],
        fired: false,
      },
      outroDialogue: [
        "TEMPLATE — placeholder boss outro.",
      ],
      guaranteedLoot: [
        { itemId: "basic_utility_knife", qty: 1 },
      ],
      questFlags: ["template_boss_slain"],
    },
  ],
};


// =============================================================================
// SELF-TEST
// =============================================================================

interface TestResult { ok: boolean; label: string; }
type TestRun = { passed: number; failed: number; total: number; results: TestResult[] };

export const runDungeonTests = (DataStore: any, Loader: LoaderLike): TestRun => {
  const results: TestResult[] = []; let p = 0, f = 0;
  const assert = (label: string, cond: unknown) => { cond ? p++ : f++; results.push({ ok: !!cond, label }); };

  // seed minimal dungeon zone
  DataStore.write("templates/zones/test_dungeon", {
    id: "test_dungeon", name: "Test Dungeon", _version: 1,
    isDungeon: true, forcedOnly: true,
    encounterTableId: "enc_colonial_sewers",
    minPartyLevel: 1, maxPartyLevel: 10,
    ambientBuffs: [], shopInventory: [],
    sellMultiplier: 0.25, tags: ["dungeon"], lore: "A test dungeon.",
    forcedEncounterQueue: [
      { type: "text",   lines: ["Hello, dungeon."], speaker: "Narrator" },
      { type: "combat", enemyIds: [{ enemyId: "tunnel_roach", count: 1 }] },
      {
        type: "combat", enemyIds: [{ enemyId: "tunnel_roach", count: 1 }],
        nextEncounters: ["wing_left", "wing_right"],
        forkLabels: ["Left", "Right"],
      },
    ],
  });

  DataStore.write("templates/zones/wing_left", {
    id: "wing_left", name: "Left Wing", _version: 1,
    isDungeon: true, forcedOnly: true,
    encounterTableId: "enc_colonial_sewers",
    minPartyLevel: 1, maxPartyLevel: 10,
    ambientBuffs: [], shopInventory: [],
    sellMultiplier: 0.25, tags: ["dungeon"], lore: "",
    forcedEncounterQueue: [
      { type: "text", lines: ["You took the left path."] },
    ],
  });

  const baseSave = {
    saveId: "test", _version: 1, timestamp: new Date().toISOString(),
    mode: "normal", currentZone: "colonial_sewers",
    party: [{ instanceId: "player_main", templateId: "template_companion" }],
    quests: {}, inventory: [], currency: 0,
    reputation: {}, talentSchools: {}, flags: {}, playtime: 0, shopStocks: {},
  };

  // ── DungeonManager.enter ─────────────────────────────────────────────────
  const { save: s1 } = DungeonManager.enter("test_dungeon", baseSave);
  assert("enter: sets dungeonProgress",           !!s1.flags?.dungeonProgress);
  assert("enter: zoneId correct",                 s1.flags.dungeonProgress.zoneId === "test_dungeon");
  assert("enter: queueIndex = 0",                 s1.flags.dungeonProgress.queueIndex === 0);
  assert("enter: pendingFork = null",             s1.flags.dungeonProgress.pendingFork === null);

  // re-entry does not reset
  const { save: s1b } = DungeonManager.enter("test_dungeon",
    Modifiers.setFlag(s1, "dungeonProgress", { ...s1.flags.dungeonProgress, queueIndex: 1 })
  );
  assert("enter: re-entry preserves queueIndex",  s1b.flags.dungeonProgress.queueIndex === 1);

  // ── getCurrentEncounter ───────────────────────────────────────────────────
  const entry0 = DungeonManager.getCurrentEncounter(s1, Loader);
  assert("getCurrentEncounter: returns entry 0",  entry0?.type === "text");

  // ── advance — text → combat ──────────────────────────────────────────────
  const { save: s2, fork: f2, complete: c2 } = DungeonManager.advance(s1, Loader);
  assert("advance: increments queueIndex",        s2.flags.dungeonProgress.queueIndex === 1);
  assert("advance: no fork on text entry",        f2 === null);
  assert("advance: not complete",                 !c2);

  // ── advance — combat (no fork) ────────────────────────────────────────────
  const { save: s3, fork: f3, complete: c3 } = DungeonManager.advance(s2, Loader);
  assert("advance: increments to 2",              s3.flags.dungeonProgress.queueIndex === 2);
  assert("advance: no fork",                      f3 === null);
  assert("advance: not complete",                 !c3);

  // ── advance — fork encounter ──────────────────────────────────────────────
  const { save: s4, fork: f4, complete: c4 } = DungeonManager.advance(s3, Loader);
  assert("advance: sets pendingFork",             !!f4);
  assert("advance: fork has 2 choices",           f4?.choices?.length === 2);
  assert("advance: fork labels present",          f4?.labels?.[0] === "Left");
  assert("advance: not complete on fork",         !c4);
  assert("advance: save has pendingFork",         !!s4.flags.dungeonProgress.pendingFork);

  // ── chooseFork — branch into wing ────────────────────────────────────────
  const { save: s5, enteredZone } = DungeonManager.chooseFork("wing_left", s4);
  assert("chooseFork: clears pendingFork",        !s5.flags.dungeonProgress.pendingFork);
  assert("chooseFork: sets zoneId to wing",       s5.flags.dungeonProgress.zoneId === "wing_left");
  assert("chooseFork: queueIndex reset to 0",     s5.flags.dungeonProgress.queueIndex === 0);
  assert("chooseFork: currentZone updated",       s5.currentZone === "wing_left");
  assert("chooseFork: enteredZone returned",      enteredZone === "wing_left");

  // ── chooseFork — continue ────────────────────────────────────────────────
  const { save: s5c } = DungeonManager.chooseFork("continue", s4);
  assert("chooseFork continue: clears pendingFork", !s5c.flags.dungeonProgress.pendingFork);
  assert("chooseFork continue: advances index",     s5c.flags.dungeonProgress.queueIndex === 3);

  // ── wing advance → complete ───────────────────────────────────────────────
  const { save: s6, complete: c6 } = DungeonManager.advance(s5, Loader);
  assert("advance in wing: complete after last entry", c6);
  assert("advance in wing: clears dungeonProgress",   !s6.flags?.dungeonProgress);

  // ── DungeonEncounterBuilder ───────────────────────────────────────────────
  const textEntry   = { type: "text",   lines: ["Test."], speaker: "Test" };
  const combatEntry = { type: "combat", enemyIds: [{ enemyId: "tunnel_roach", count: 1 }] };
  const bossEntry   = {
    type: "boss", enemyIds: [{ enemyId: "tunnel_roach" }],
    introDialogue: ["Roar!"], outroDialogue: ["Dead."],
    guaranteedLoot: [{ itemId: "basic_utility_knife", qty: 1 }],
    questFlags: ["boss_slain"],
  };

  const textEnc   = DungeonEncounterBuilder.build(textEntry,   "test_dungeon", Loader);
  const combatEnc = DungeonEncounterBuilder.build(combatEntry, "test_dungeon", Loader);
  const bossEnc   = DungeonEncounterBuilder.build(bossEntry,   "test_dungeon", Loader);

  assert("builder: text encounterType",           textEnc.encounterType   === "text");
  assert("builder: text lines present",           textEnc.lines?.length   > 0);
  assert("builder: combat encounterType",         combatEnc.encounterType === "combat");
  assert("builder: combat has enemies",           combatEnc.enemies?.length > 0);
  assert("builder: boss encounterType",           bossEnc.encounterType   === "boss");
  assert("builder: boss isBoss flag",             bossEnc.isBoss          === true);
  assert("builder: boss introDialogue present",   bossEnc.introDialogue?.length > 0);
  assert("builder: boss guaranteedLoot present",  bossEnc.guaranteedLoot?.length > 0);

  // ── trap encounter entry ──────────────────────────────────────────────────
  const trapEntry = { type: "trap", trapId: "template_spike_trap" };
  const trapEnc   = DungeonEncounterBuilder.build(trapEntry, "test_dungeon", Loader);
  assert("builder: trap encounterType",           trapEnc.encounterType === "trap");
  assert("builder: trap template loaded",         trapEnc.trap?.id === "template_spike_trap");

  // ── exit ──────────────────────────────────────────────────────────────────
  const { save: sExit } = DungeonManager.exit(s2, "colonial_sewers");
  assert("exit: clears dungeonProgress",   !sExit.flags?.dungeonProgress);
  assert("exit: restores returnZone",      sExit.currentZone === "colonial_sewers");

  // ── isDungeon gate ────────────────────────────────────────────────────────
  assert("DungeonUI: isDungeon true for dungeon zone",  DungeonUI.isInDungeon({ ...baseSave, currentZone: "test_dungeon" }, Loader));
  assert("DungeonUI: isDungeon false for normal zone",  !DungeonUI.isInDungeon({ ...baseSave, currentZone: "colonial_sewers" }, Loader));

  // cleanup
  DataStore.remove("templates/zones/test_dungeon");
  DataStore.remove("templates/zones/wing_left");

  return { passed: p, failed: f, total: p + f, results };
};

export const reportDungeonTests = (r: TestRun): string => {
  const lines = [
    `\n${"=".repeat(60)}`,
    `DUNGEON TESTS: ${r.passed}/${r.total} passed`,
    "=".repeat(60),
    ...r.results.map(x => `  ${x.ok ? "✓" : "✗"} ${x.label}`),
    r.failed > 0 ? `\n  ${r.failed} FAILED` : `\n  All tests passed.`,
    "=".repeat(60),
  ];
  return lines.join("\n");
};
