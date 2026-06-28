// =============================================================================
// JSON DATA LAYER — Galanova
// Modular, versioned, validated, patchable, mergeable.
// =============================================================================

"use strict";

const _mobsData = require('../Data/mobs.json');
const _questsData        = require('../Data/quests.json');
const _encounterTablesData = require('../Data/encounters.json');
const _trapsData         = require('../Data/traps.json');

// =============================================================================
// SCHEMAS
// =============================================================================

// Per-tick magnitude for a DoT/HoT (buff.tickDamage / buff.tickHeal). Mirrors the
// scaling shape used by effectEntry: `scaling` is either a single-stat string or
// an object map of stat -> coefficient. damageType only applies to tickDamage.
const TICK_ENTRY = {
  type: "object",
  properties: {
    damageType: { type: "string", enum: ["physical","pyro","cryo","nature","chaos","order","bio","energy","psychic"] },
    flat:       { type: "number" },
    scaling:    { oneOf: [ { type: "string" }, { type: "object", additionalProperties: { type: "number" } } ] },
    multiplier: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

const SCHEMAS = {

  // --- schema stability legend ---
  // LOCKED   — additionalProperties: false. Schema is stable.
  // OPEN     — additionalProperties: true.  Schema is still being designed.
  //
  // Current status:
  //   LOCKED:  resourceCost, statBlock, effectEntry, buff, item
  //   OPEN:    ability, class, companion, companionInstance, enemy,
  //            zone, quest, encounterTable, trait, quirk, trap, save

  resourceCost: {
    type: "object",
    properties: {
      mana:         { type: "number", minimum: 0 },
      rage:         { type: "number", minimum: 0 },
      stamina:      { type: "number", minimum: 0 },
      combo_points: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },

  statBlock: {
    type: "object",
    // wis/spd are optional for now — per-race/class values are assigned later
    // when the roster is rebuilt under stat-point allocation.
    required: ["str","dex","con","int","spi"],
    properties: {
      str: { type: "number", minimum: 0 },
      dex: { type: "number", minimum: 0 },
      con: { type: "number", minimum: 0 },
      int: { type: "number", minimum: 0 },
      spi: { type: "number", minimum: 0 },
      wis: { type: "number", minimum: 0 },
      spd: { type: "number", minimum: 0 },
      cha: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },

  effectEntry: {
    type: "object",
    required: ["type"],
    properties: {
      type:            { type: "string", enum: ["damage","heal","buff","debuff","resource","cc","stat_mod","proc"] },
      // damage / heal
      damageType:      { type: "string", enum: ["physical","pyro","cryo","nature","chaos","order","bio","energy","psychic"] },
      // scaling: legacy single-stat string ("ap","sp","rap", an attribute, or a
      // skill id) OR an object map of stat -> coefficient, e.g. { ap: 1.0, str: 0.5 }.
      scaling:         { oneOf: [ { type: "string" }, { type: "object", additionalProperties: { type: "number" } } ] },
      multiplier:      { type: "number", minimum: 0 },
      // usesWeapon: adds rolled weapon damage (roll / weaponSpeed) from the melee
      // slots (mainhand + 50% offhand) or the ranged slot, on top of scaling.
      usesWeapon:      { type: "string", enum: ["melee","ranged","none"] },
      flatBonus:       { type: "number" },
      comboMultiplier: { type: "number", minimum: 0 },
      // buff / debuff / proc
      buffId:          { type: "string" },
      chance:          { type: "number", minimum: 0, maximum: 1 },
      // resource
      gains:           { type: "object" },
      // stat_mod — always-on stat conversion (passive abilities, trigger:"always")
      // e.g. { type:"stat_mod", stat:"spellPower", source:"spi", multiplier:0.25 }
      // stat:       derived stat to add to (spellPower, attackPower, armor, etc.)
      // source:     raw stat to convert from (str, agi, sta, int, spi)
      // multiplier: fraction of source added to stat
      // flat:       flat amount added directly to stat (no source needed)
      stat:            { type: "string" },
      source:          { type: "string" },
      flat:            { type: "number" },
      // proc — conditional effect fired by passive trigger
      // e.g. { type:"proc", trigger:"on_crit_heal", buffId:"inspiration_buff", chance:1.0 }
      trigger:         { type: "string", enum: ["always","on_hit","on_crit_heal","on_being_hit"] },
    },
  },

  // --- ability --- OPEN
  ability: {
    $id: "ability",
    type: "object",
    required: ["id","name","targeting","effects"],
    properties: {
      id:                  { type: "string", pattern: "^[a-z0-9_]+$" },
      name:                { type: "string", minLength: 1 },
      _version:            { type: "integer", minimum: 1 },
      resourceCost:        { type: "object" },
      cooldown:            { type: "integer", minimum: 0 },
      castTime:            { type: "integer", minimum: 0 },
      targeting:           { type: "string", enum: ["self","single_enemy","single_ally","all_enemies","all_allies","random_enemy","random_ally","lowest_hp_enemy","lowest_hp_ally"] },
      threatModifier:      { type: "number", minimum: 0 },
      requiresComboPoints: { type: "boolean" },
      passive:             { type: "boolean" },
      trigger:             { type: "string", enum: ["always","on_hit","on_crit_heal","on_being_hit"] },
      tags:                { type: "array", items: { type: "string" } },
      description:         { type: "string" },
      effects:             { type: "array", items: { type: "object" }, minItems: 1 },
    },
    additionalProperties: true, // OPEN
  },

  // --- buff/debuff --- LOCKED
  buff: {
    $id: "buff",
    type: "object",
    required: ["id","name","duration"],
    properties: {
      id:          { type: "string", pattern: "^[a-z0-9_]+$" },
      name:        { type: "string", minLength: 1 },
      _version:    { type: "integer", minimum: 1 },
      duration:    { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["infinite"] }] },
      modifiers:   { type: "object" },
      ccFlags:     { type: "object" },
      tickDamage:  TICK_ENTRY,
      tickHeal:    TICK_ENTRY,
      stacks:      { type: "boolean" },
      maxStacks:   { type: "integer", minimum: 1 },
      charges:     { type: "integer", minimum: 1 },
      tags:        { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    additionalProperties: false,
  },

  // --- class --- OPEN
  // Galanova class model: armor tier, 1–3 core stats, a guaranteed per-level stat
  // allocation, a flexible resource list (mix-and-match), a skill list, and a
  // generated starting baseline (the level-1 stat block, before player allocation).
  class: {
    $id: "class",
    type: "object",
    required: ["id","name","armorTier","coreStats","guaranteedLevelUp","resources","startingBaseline"],
    properties: {
      id:                { type: "string", pattern: "^[a-z0-9_]+$" },
      name:              { type: "string", minLength: 1 },
      _version:          { type: "integer", minimum: 1 },
      armorTier:         { type: "string", enum: ["clothing","light","medium","heavy"] },
      coreStats:         { type: "array", items: { type: "string", enum: ["str","dex","con","int","spi","wis","spd","cha"] }, minItems: 1, maxItems: 3 },
      guaranteedLevelUp: { type: "object" }, // stat -> points auto-allocated per level (sums 1–3)
      resources:         { type: "array", items: { type: "string", enum: ["mana","rage","stamina","combo_points"] }, minItems: 1 },
      primaryResource:   { type: "string" },
      skills:            { type: "array", items: { type: "string" } },
      startingBaseline:  { type: "object" }, // statBlock-shaped level-1 stats
      passiveHooks:      { type: "array", items: { type: "string" } },
      startingAbilities: { type: "array", items: { type: "string" } },
      description:       { type: "string" },
    },
    additionalProperties: true, // OPEN
  },

  // --- companion template --- OPEN
  companion: {
    $id: "companion",
    type: "object",
    required: ["id","name","raceId","classId"],
    properties: {
      id:                  { type: "string", pattern: "^[a-z0-9_]+$" },
      name:                { type: "string", minLength: 1 },
      _version:            { type: "integer", minimum: 1 },
      raceId:              { type: "string" },
      classId:             { type: "string" },
      profession:          { type: "string" },
      joinLevel:           { type: "integer", minimum: 1 },
      unlockZone:          { type: "string" },
      unlockQuest:         { type: ["string","null"] },
      unlockRepFaction:    { type: ["string","null"] },
      unlockRepRequired:   { type: ["number","null"] },
      baseStats:           { type: "object" },
      startingSkills:      { type: "object" },
      statOverrides:       { type: "object" },
      abilities:           { type: "array", items: { type: "string" } },
      traits:              { type: "array", items: { type: "string" } },
      quirks:              { type: "array", items: { type: "string" } },
      gear:                { type: "object" },
      joinDialogue:        { type: "array", items: { type: "string" } },
      aiProfile:           { type: "string" },
      lore:                { type: "string" },
      tags:                { type: "array", items: { type: "string" } },
    },
    additionalProperties: true, // OPEN
  },

  // --- companion instance --- OPEN
  companionInstance: {
    $id: "companionInstance",
    type: "object",
    required: ["instanceId","templateId"],
    properties: {
      instanceId:       { type: "string" },
      templateId:       { type: "string" },
      _version:         { type: "integer", minimum: 1 },
      name:             { type: "string" },
      raceId:           { type: ["string", "null"] }, // races decoupled — may be null
      classId:          { type: "string" },
      profession:       { type: "string" },
      xp:               { type: "number", minimum: 0 },
      level:            { type: "integer", minimum: 1 },
      currentHp:        { type: "number", minimum: 0 },
      currentMp:        { type: "number", minimum: 0 },
      maxHp:            { type: "number", minimum: 0 },
      maxMp:            { type: "number", minimum: 0 },
      deathState:       { type: "string", enum: ["alive","downed","dead"] },
      permadead:        { type: "boolean" },
      downedAt:         { type: ["string","null"] },
      rezCost:          { type: "number", minimum: 0 },
      learnedAbilities: { type: "array", items: { type: "string" } },
      acquiredQuirks:   { type: "array", items: { type: "string" } },
      activeBuffs:      { type: "array" },
      relationship:     { type: "integer", minimum: -100, maximum: 100 },
      skills:           { type: "object" },
      gear:             { type: "object" },
      customName:       { type: "string" },
      stats:            { type: "object" }, // { raw: statBlock } — current allocated stats
      unspentStatPoints:{ type: "integer", minimum: 0 }, // free points awaiting allocation
    },
    additionalProperties: true, // OPEN
  },

  // --- enemy --- OPEN
  enemy: {
    $id: "enemy",
    type: "object",
    required: ["id","name","baseStats","aiProfile","abilities"],
    properties: {
      id:            { type: "string", pattern: "^[a-z0-9_]+$" },
      name:          { type: "string", minLength: 1 },
      _version:      { type: "integer", minimum: 1 },
      type:          { type: "string", enum: ["humanoid","beast","undead","elemental","demon","dragon","giant","mechanical","aberration"] },
      baseStats:     { type: "object" },
      abilities:     { type: "array", items: { type: "string" } },
      aiProfile:     { type: "string" },
      loot:          { type: "array" },
      xpValue:       { type: "number", minimum: 0 },
      // currencyDrop is null for non-humanoid/demon enemies
      currencyDrop:  { oneOf: [{ type: "object" }, { type: "null" }] },
      tags:          { type: "array", items: { type: "string" } },
      description:   { type: "string" },
    },
    additionalProperties: true, // OPEN
  },

  // --- item --- LOCKED
  item: {
    $id: "item",
    type: "object",
    required: ["id","name","type","slot"],
    properties: {
      id:          { type: "string", pattern: "^[a-z0-9_]+$" },
      name:        { type: "string", minLength: 1 },
      _version:    { type: "integer", minimum: 1 },
      type:        { type: "string", enum: ["weapon","armor","trinket","consumable","quest","material","recipe","held"] },
      slot:        { type: "string", enum: ["mainhand","offhand","head","chest","legs","feet","hands","back","neck","ring","trinket","none","waist","shoulders","wrist","tabard","ranged","ammo","relic"] },
      itemLevel:   { oneOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      minDamage:   { oneOf: [{ type: "number",  minimum: 0 }, { type: "null" }] },
      maxDamage:   { oneOf: [{ type: "number",  minimum: 0 }, { type: "null" }] },
      weaponSpeed: { oneOf: [{ type: "number",  minimum: 0 }, { type: "null" }] },
      weaponType:  { oneOf: [{ type: "string",  enum: ["sword_1h","sword_2h","axe_1h","axe_2h","mace_1h","mace_2h","dagger","fist","staff","polearm","wand","bow","crossbow","gun","thrown"] }, { type: "null" }] },
      statBonuses: {
        type: "object",
        properties: {
          str:         { type: "number" },
          dex:         { type: "number" },
          con:         { type: "number" },
          int:         { type: "number" },
          spi:         { type: "number" },
          wis:         { type: "number" },
          spd:         { type: "number" },
          cha:         { type: "number" },
          attackPower: { type: "number" },
          spellPower:  { type: "number" },
          armor:       { type: "number" },
          meleeCrit:   { type: "number" },
          spellCrit:   { type: "number" },
        },
        additionalProperties: false,
      },
      onUse:              { oneOf: [{ type: "object" }, { type: "null" }] },
      allowedClasses:     { type: "array", items: { type: "string" } },
      reqLevel:           { oneOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      unlockRepFaction:   { type: ["string","null"] },
      unlockRepRequired:  { type: ["number","null"] },
      value:              { type: "number",  minimum: 0 },
      quality:            { type: "string",  enum: ["poor","common","uncommon","rare","epic","legendary"] },
      tags:               { type: "array",   items: { type: "string" } },
      description:        { type: "string" },
    },
    additionalProperties: false,
  },

  // --- zone --- OPEN
  zone: {
    $id: "zone",
    type: "object",
    required: ["id","name","encounterTableId"],
    properties: {
      id:                   { type: "string",  pattern: "^[a-z0-9_]+$" },
      name:                 { type: "string",  minLength: 1 },
      _version:             { type: "integer", minimum: 1 },
      encounterTableId:     { type: "string" },
      minPartyLevel:        { type: "integer", minimum: 1 },
      maxPartyLevel:        { type: "integer", minimum: 1 },
      ambientBuffs:         { type: "array",   items: { type: "string" } },

      shopInventory:        { type: "array" },
      sellMultiplier:       { type: "number",  minimum: 0 },
      tags:                 { type: "array",   items: { type: "string" } },
      lore:                 { type: "string" },
      forcedOnly:           { type: "boolean" },
      forcedEncounterQueue: { type: "array" },
    },
    additionalProperties: true, // OPEN
  },

  // --- quest --- OPEN
  quest: {
    $id: "quest",
    type: "object",
    required: ["id","name","objectives","rewards"],
    properties: {
      id:            { type: "string",  pattern: "^[a-z0-9_]+$" },
      name:          { type: "string",  minLength: 1 },
      _version:      { type: "integer", minimum: 1 },
      description:   { type: "string" },
      objectives:    { type: "array",   items: { type: "object" }, minItems: 1 },
      rewards:       { type: "object" },
      prerequisites: { type: "array",   items: { type: "string" } },
      zoneId:        { type: "string" },
      autoAssign:    { type: "boolean" },
      tags:          { type: "array",   items: { type: "string" } },
    },
    additionalProperties: true, // OPEN
  },

  // --- encounter table --- OPEN
  encounterTable: {
    $id: "encounterTable",
    type: "object",
    required: ["id","slots","combatPool"],
    properties: {
      id:       { type: "string",  pattern: "^[a-z0-9_]+$" },
      _version: { type: "integer", minimum: 1 },
      slots: {
        type: "array",
        items: { type: "object" },
      },
      combatPool: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["enemyId","weight"],
          properties: {
            enemyId: { type: "string" },
            weight:  { type: "number", minimum: 0 },
          },
        },
      },
      exclusiveGroups: {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      recruitPool: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: true, // OPEN
  },

  // --- trait ---
  trait: {
    $id: "trait",
    type: "object",
    required: ["id","name","effects"],
    properties: {
      id:          { type: "string", pattern: "^[a-z0-9_]+$" },
      name:        { type: "string", minLength: 1 },
      _version:    { type: "integer", minimum: 1 },
      effects:     { type: "array", items: { type: "object" }, minItems: 1 },
      tags:        { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    additionalProperties: false,
  },

  // --- quirk ---
  quirk: {
    $id: "quirk",
    type: "object",
    required: ["id","name","type"],
    properties: {
      id:          { type: "string", pattern: "^[a-z0-9_]+$" },
      name:        { type: "string", minLength: 1 },
      _version:    { type: "integer", minimum: 1 },
      type:        { type: "string", enum: ["positive","negative","neutral"] },
      effects:     { type: "array", items: { type: "object" } },
      tags:        { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    additionalProperties: false,
  },

  // --- gathering node --- OPEN
  node: {
    $id: "node",
    type: "object",
    required: ["id","name","drops"],
    properties: {
      id:                 { type: "string", pattern: "^[a-z0-9_]+$" },
      name:               { type: "string", minLength: 1 },
      _version:           { type: "integer", minimum: 1 },
      requiredProfession: { type: ["string","null"] },
      minSkillLevel:      { type: "integer", minimum: 0 },
      skillGain:          { type: "integer", minimum: 0 },
      rolls:              { type: "integer", minimum: 1 },
      drops:              { type: "array", items: { type: "object" }, minItems: 1 },
      tags:               { type: "array", items: { type: "string" } },
    },
    additionalProperties: true, // OPEN
  },

  // --- trap --- OPEN
  // Dungeoneering trap definition. See Data/traps.json for the field contract.
  trap: {
    $id: "trap",
    type: "object",
    required: ["id","name"],
    properties: {
      id:          { type: "string", pattern: "^[a-z0-9_]+$" },
      name:        { type: "string", minLength: 1 },
      _version:    { type: "integer", minimum: 1 },
      xp:          { type: "number",  minimum: 0 },
      detectText:  { type: "string" },
      triggerText: { type: "string" },
      effect:      { type: "object" },
      tags:        { type: "array", items: { type: "string" } },
    },
    additionalProperties: true, // OPEN
  },

  // --- recipe --- OPEN
  recipe: {
    $id: "recipe",
    type: "object",
    required: ["id","name","inputs","output"],
    properties: {
      id:                 { type: "string", pattern: "^[a-z0-9_]+$" },
      name:               { type: "string", minLength: 1 },
      _version:           { type: "integer", minimum: 1 },
      requiredProfession: { type: ["string", "null"] },
      minSkillLevel:      { type: "integer", minimum: 0 },
      skillGain:          { type: "integer", minimum: 0 },
      skillGainTiers:     { type: "array", items: { type: "object" } },
      inputs:             { type: "array", items: { type: "object" }, minItems: 1 },
      output:             { type: "object" },
      tags:               { type: "array", items: { type: "string" } },
      description:        { type: "string" },
    },
    additionalProperties: true, // OPEN
  },

  // --- save file --- OPEN
  save: {
    $id: "save",
    type: "object",
    required: ["saveId","_version","timestamp","party","quests","inventory"],
    properties: {
      saveId:        { type: "string" },
      _version:      { type: "integer", minimum: 1 },
      timestamp:     { type: "string" },
      mode:          { type: "string", enum: ["normal","ironman","hardcore"] },
      currentZone:   { type: "string" },
      party:         { type: "array",  items: { type: "object" } },
      quests:        { type: "object" },
      inventory:     { type: "array" },
      currency:      { type: "number", minimum: 0 },
      reputation:    { type: "object" },
      talentSchools: { type: "object" },
      flags:         { type: "object" },
      playtime:      { type: "number", minimum: 0 },
      shopStocks:    { type: "object" },
      riding:        { type: "number", minimum: 0 },
      mounts:        { type: "array",  items: { type: "string" } },
    },
    additionalProperties: true, // OPEN
  },

};


// =============================================================================
// VALIDATOR
// =============================================================================

const Validator = (() => {

  const typeCheck = (value, type) => {
    if (type === "integer") return Number.isInteger(value);
    if (type === "number")  return typeof value === "number" && !isNaN(value);
    if (type === "string")  return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    if (type === "array")   return Array.isArray(value);
    if (type === "object")  return typeof value === "object" && value !== null && !Array.isArray(value);
    if (type === "null")    return value === null;
    return false;
  };

  const validate = (data, schema, path = "") => {
    const errors = [];

    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some(t => typeCheck(data, t))) {
        errors.push(`${path || "root"}: expected type ${schema.type}, got ${Array.isArray(data) ? "array" : typeof data}`);
        return errors;
      }
    }

    if (schema.oneOf) {
      const valid = schema.oneOf.some(s => validate(data, s, path).length === 0);
      if (!valid) errors.push(`${path || "root"}: failed oneOf constraint`);
    }

    if (typeof data === "string") {
      if (schema.minLength !== undefined && data.length < schema.minLength)
        errors.push(`${path}: string too short (min ${schema.minLength})`);
      if (schema.pattern && !new RegExp(schema.pattern).test(data))
        errors.push(`${path}: string does not match pattern ${schema.pattern}`);
      if (schema.enum && !schema.enum.includes(data))
        errors.push(`${path}: value "${data}" not in enum [${schema.enum.join(", ")}]`);
    }

    if (typeof data === "number") {
      if (schema.minimum !== undefined && data < schema.minimum)
        errors.push(`${path}: ${data} below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && data > schema.maximum)
        errors.push(`${path}: ${data} above maximum ${schema.maximum}`);
    }

    if (typeCheck(data, "object")) {
      if (schema.required) {
        for (const field of schema.required)
          if (!(field in data)) errors.push(`${path}.${field}: required field missing`);
      }
      if (schema.properties) {
        for (const [key, subSchema] of Object.entries(schema.properties))
          if (key in data) errors.push(...validate(data[key], subSchema, `${path}.${key}`));
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(data))
          if (!(key in schema.properties))
            errors.push(`${path}.${key}: additional property not allowed`);
      }
    }

    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems)
        errors.push(`${path}: array too short (min ${schema.minItems})`);
      if (schema.items)
        data.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }

    return errors;
  };

  const validateNamed = (data, schemaName) => {
    const schema = SCHEMAS[schemaName];
    if (!schema) return { valid: false, errors: [`No schema found: ${schemaName}`] };
    const errors = validate(data, schema);
    return { valid: errors.length === 0, errors };
  };

  return { validate, validateNamed };
})();


// =============================================================================
// DATA STORE
// =============================================================================

const DataStore = (() => {
  const _fs = new Map();

  const write  = (path, data) => _fs.set(path, JSON.parse(JSON.stringify(data)));
  const read   = (path) => _fs.has(path) ? JSON.parse(JSON.stringify(_fs.get(path))) : null;
  const exists = (path) => _fs.has(path);
  const list   = (prefix) => [..._fs.keys()].filter(k => k.startsWith(prefix));
  const remove = (path) => _fs.delete(path);
  const dump   = () => Object.fromEntries(_fs);

  return { write, read, exists, list, remove, dump };
})();


// =============================================================================
// LOADER
// =============================================================================

const Loader = (() => {

  const DEFAULTS = {
    ability: {
      _version: 1, resourceCost: {}, cooldown: 0, castTime: 0,
      threatModifier: 1.0, requiresComboPoints: false, passive: false, tags: [], effects: [],
    },
    buff: {
      _version: 1, modifiers: {}, ccFlags: {}, stacks: false, tags: [],
    },
    class: {
      _version: 1, skills: [], passiveHooks: [], startingAbilities: [], description: "",
    },
    companion: {
      _version: 1, statOverrides: {}, abilities: [], traits: [], quirks: [],
      tags: [], joinDialogue: [], startingSkills: {},
      unlockQuest: null, unlockRepFaction: null, unlockRepRequired: null,
    },
    companionInstance: {
      _version: 1, xp: 0, level: 1, unspentStatPoints: 0,
      deathState: "alive", permadead: false, downedAt: null, rezCost: 0,
      learnedAbilities: [], acquiredQuirks: [], activeBuffs: [],
      relationship: 0, skills: {},
      gear: {
        head: null, neck: null, shoulders: null, back: null, chest: null,
        waist: null, tabard: null, wrist: null, hands: null, feet: null,
        legs: null, ring: null, trinket: null, mainhand: null, offhand: null,
        ranged: null, ammo: null, relic: null,
      },
    },
    enemy: {
      _version: 1, type: "humanoid", loot: [], xpValue: 0, tags: [],
      currencyDrop: null,
    },
    item: {
      _version: 1,
      statBonuses: {}, onUse: null,
      itemLevel: null,
      minDamage: null, maxDamage: null, weaponType: null,
      allowedClasses: [],
      unlockRepFaction: null, unlockRepRequired: null,
      value: 0, quality: "common", tags: [],
    },
    zone: {
      _version: 1, minPartyLevel: 1, maxPartyLevel: 60,
      ambientBuffs: [], tags: [],
      forcedOnly: false, forcedEncounterQueue: [],
    },
    quest: {
      _version: 1, prerequisites: [], tags: [], autoAssign: false,
    },
    encounterTable: {
      _version: 1, exclusiveGroups: [], recruitPool: [],
    },
    trait: {
      _version: 1, tags: [],
    },
    quirk: {
      _version: 1, effects: [], tags: [],
    },
  };

  const applyDefaults = (data, type) => ({ ...(DEFAULTS[type] || {}), ...data });

  const load = (path, schemaName) => {
    const raw = DataStore.read(path);
    if (raw === null)
      return { ok: false, data: null, errors: [`File not found: ${path}`] };

    const withDefaults = applyDefaults(raw, schemaName);
    const { valid, errors } = Validator.validateNamed(withDefaults, schemaName);
    if (!valid)
      return { ok: false, data: null, errors: [`Validation failed for ${path}:`, ...errors] };

    return { ok: true, data: withDefaults, errors: [] };
  };

  const loadAll = (prefix, schemaName) => {
    const paths = DataStore.list(prefix);
    const results = { ok: true, items: [], errors: [] };
    for (const path of paths) {
      const result = load(path, schemaName);
      if (result.ok) results.items.push(result.data);
      else { results.ok = false; results.errors.push(...result.errors); }
    }
    return results;
  };

  return { load, loadAll, applyDefaults };
})();


// =============================================================================
// SAVER
// =============================================================================

const Saver = (() => {

  const CURRENT_VERSION = 1;

  const save = (path, data, schemaName) => {
    const { valid, errors } = Validator.validateNamed(data, schemaName);
    if (!valid)
      return { ok: false, errors: [`Pre-save validation failed for ${path}:`, ...errors] };

    if (DataStore.exists(path))
      DataStore.write(`${path}.backup`, DataStore.read(path));

    DataStore.write(path, {
      ...data,
      _version: data._version || CURRENT_VERSION,
      _savedAt: new Date().toISOString(),
    });

    return { ok: true, errors: [] };
  };

  const saveSave = (saveData) => save(`saves/save_${saveData.saveId}`, saveData, "save");

  const updateManifest = (saveId, meta = {}) => {
    const manifestPath = "saves/manifest";
    const manifest = DataStore.read(manifestPath) || { saves: [] };
    const existing = manifest.saves.findIndex(s => s.saveId === saveId);
    const entry = { saveId, updatedAt: new Date().toISOString(), ...meta };
    if (existing >= 0) manifest.saves[existing] = entry;
    else manifest.saves.push(entry);
    DataStore.write(manifestPath, manifest);
  };

  return { save, saveSave, updateManifest, CURRENT_VERSION };
})();


// =============================================================================
// PATCHER
// =============================================================================

const Patcher = (() => {

  const _patches = [];

  const registerPatch = (patch) => {
    if (!patch.fromVersion || !patch.toVersion || !patch.ops)
      throw new Error(`Invalid patch: missing fromVersion, toVersion, or ops`);
    _patches.push(patch);
    _patches.sort((a, b) => a.fromVersion - b.fromVersion);
  };

  const applyOp = (data, op) => {
    const d = JSON.parse(JSON.stringify(data));

    switch (op._op) {
      case "set": {
        const keys = op.path.split(".");
        let target = d;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!(keys[i] in target)) target[keys[i]] = {};
          target = target[keys[i]];
        }
        target[keys[keys.length - 1]] = op.value;
        break;
      }
      case "delete": {
        const keys = op.path.split(".");
        let target = d;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!(keys[i] in target)) return d;
          target = target[keys[i]];
        }
        delete target[keys[keys.length - 1]];
        break;
      }
      case "rename": {
        const keys = op.path.split(".");
        let target = d;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!(keys[i] in target)) return d;
          target = target[keys[i]];
        }
        const oldKey = keys[keys.length - 1];
        if (oldKey in target) {
          target[op.to] = target[oldKey];
          delete target[oldKey];
        }
        break;
      }
      case "merge": {
        Object.assign(d, op.value);
        break;
      }
      case "append": {
        const keys = op.path.split(".");
        let target = d;
        for (const k of keys) {
          if (!(k in target)) target[k] = [];
          target = target[k];
        }
        if (Array.isArray(target))
          target.push(...(Array.isArray(op.value) ? op.value : [op.value]));
        break;
      }
      default:
        throw new Error(`Unknown patch op: ${op._op}`);
    }

    return d;
  };

  const applyPatch = (data, patch) => {
    if (data._version !== patch.fromVersion)
      return { ok: false, data, errors: [`Version mismatch: data is v${data._version}, patch expects v${patch.fromVersion}`] };

    let d = data;
    for (const op of patch.ops) {
      try { d = applyOp(d, op); }
      catch (e) { return { ok: false, data, errors: [`Patch op failed (${op._op}): ${e.message}`] }; }
    }
    d._version = patch.toVersion;
    return { ok: true, data: d, errors: [] };
  };

  const migrate = (data, targetVersion) => {
    let d = data;
    const errors = [];
    while (d._version < targetVersion) {
      const patch = _patches.find(p => p.fromVersion === d._version);
      if (!patch) {
        errors.push(`No patch found to migrate from v${d._version}`);
        return { ok: false, data: d, errors };
      }
      const result = applyPatch(d, patch);
      if (!result.ok) return result;
      d = result.data;
    }
    return { ok: true, data: d, errors: [] };
  };

  return { registerPatch, applyPatch, migrate, applyOp };
})();


// =============================================================================
// MERGER
// =============================================================================

const Merger = (() => {

  const deepMerge = (base, override, opts = {}) => {
    const result = JSON.parse(JSON.stringify(base));
    for (const [key, val] of Object.entries(override)) {
      if (val === null) {
        delete result[key];
      } else if (Array.isArray(val) || Array.isArray(result[key])) {
        result[key] = JSON.parse(JSON.stringify(val));
      } else if (typeof val === "object" && typeof result[key] === "object" && !Array.isArray(val)) {
        result[key] = deepMerge(result[key] || {}, val, opts);
      } else {
        result[key] = val;
      }
    }
    return result;
  };

  const detectConflicts = (a, b) => {
    const conflicts = [];
    for (const key of Object.keys(b)) {
      if (key in a && a[key] !== null && b[key] !== null) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
          conflicts.push({ field: key, baseValue: a[key], overrideValue: b[key] });
      }
    }
    return conflicts;
  };

  const resolveCompanion = (template, instance) => {
    const conflicts = detectConflicts(template, instance);
    const resolved  = deepMerge(template, instance);
    return { resolved, conflicts };
  };

  const mergeSaves = (left, right, priority = "newest") => {
    const conflicts = detectConflicts(left, right);
    let winner, loser;
    if (priority === "newest") {
      winner = new Date(left.timestamp) >= new Date(right.timestamp) ? left : right;
      loser  = winner === left ? right : left;
    } else if (priority === "left") {
      winner = left; loser = right;
    } else {
      winner = right; loser = left;
    }
    return { merged: deepMerge(loser, winner), conflicts };
  };

  return { deepMerge, detectConflicts, resolveCompanion, mergeSaves };
})();


// =============================================================================
// MODIFIER UTILITIES
// =============================================================================

const Modifiers = (() => {

  const addReputation = (save, factionId, amount) => {
    const rep = { ...(save.reputation || {}) };
    rep[factionId] = Math.max(-100, Math.min(100, (rep[factionId] || 0) + amount));
    return { ...save, reputation: rep };
  };

  const advanceTalent = (save, schoolId, amount = 1) => {
    const talents = { ...(save.talentSchools || {}) };
    talents[schoolId] = (talents[schoolId] || 0) + amount;
    return { ...save, talentSchools: talents };
  };

  const learnAbility = (instance, abilityId) => {
    if ((instance.learnedAbilities || []).includes(abilityId)) return instance;
    return { ...instance, learnedAbilities: [...(instance.learnedAbilities || []), abilityId] };
  };

  const addQuirk = (instance, quirkId) => {
    if ((instance.acquiredQuirks || []).includes(quirkId)) return instance;
    return { ...instance, acquiredQuirks: [...(instance.acquiredQuirks || []), quirkId] };
  };

  const completeObjective = (save, questId, objectiveId) => {
    const quests = { ...(save.quests || {}) };
    if (!quests[questId]) quests[questId] = { objectives: {}, completed: false };
    quests[questId].objectives[objectiveId] = true;
    return { ...save, quests };
  };

  const completeQuest = (save, questId) => {
    const quests = { ...(save.quests || {}) };
    if (!quests[questId]) quests[questId] = { objectives: {}, completed: false };
    quests[questId].completed = true;
    quests[questId].completedAt = new Date().toISOString();
    return { ...save, quests };
  };

  const addToInventory = (save, itemId, qty = 1) => {
    const inv = [...(save.inventory || [])];
    const idx = inv.findIndex(e => e.itemId === itemId);
    if (idx >= 0) inv[idx] = { ...inv[idx], qty: inv[idx].qty + qty };
    else inv.push({ itemId, qty });
    return { ...save, inventory: inv };
  };

  const setFlag = (save, flagKey, value = true) =>
    ({ ...save, flags: { ...(save.flags || {}), [flagKey]: value } });

  const clearFlag = (save, flagKey) => {
    const f = { ...(save.flags || {}) };
    delete f[flagKey];
    return { ...save, flags: f };
  };

  return {
    addReputation, advanceTalent, learnAbility, addQuirk,
    completeObjective, completeQuest, addToInventory,
    setFlag, clearFlag,
  };
})();


// =============================================================================
// SYNTHETIC DATASET
// =============================================================================

const SyntheticData = (() => {

  const seed = () => {

    DataStore.write("templates/abilities/ability_alpha", {
      id: "ability_alpha", name: "Alpha Strike", _version: 1,
      resourceCost: { rage: 10 }, cooldown: 0, castTime: 0,
      targeting: "single_enemy", threatModifier: 1.0,
      effects: [{ type: "damage", damageType: "physical", scaling: "ap", multiplier: 1.1 }],
      tags: ["physical","melee"], description: "A basic physical strike.",
    });

    DataStore.write("templates/abilities/ability_beta", {
      id: "ability_beta", name: "Beta Bolt", _version: 1,
      resourceCost: { mana: 15 }, cooldown: 2, castTime: 1,
      targeting: "single_enemy", threatModifier: 1.0,
      effects: [{ type: "damage", damageType: "pyro", scaling: "sp", multiplier: 1.2, flatBonus: 10 }],
      tags: ["pyro","spell"], description: "A basic pyro bolt.",
    });

    DataStore.write("templates/abilities/ability_gamma", {
      id: "ability_gamma", name: "Gamma Guard", _version: 1,
      resourceCost: {}, cooldown: 6, castTime: 0,
      targeting: "self", threatModifier: 0,
      effects: [{ type: "buff", buffId: "buff_shield_alpha" }],
      tags: ["defensive"], description: "Apply a damage absorbing shield.",
    });

    // example passive ability
    DataStore.write("templates/abilities/ability_passive_test", {
      id: "ability_passive_test", name: "Passive Test", _version: 1,
      passive: true, trigger: "always",
      resourceCost: {}, cooldown: 0, castTime: 0,
      targeting: "self",
      effects: [{ type: "stat_mod", stat: "spellPower", source: "spi", multiplier: 0.25 }],
      tags: ["passive"], description: "Test passive: 25% spi → spellPower.",
    });

    DataStore.write("templates/buffs/buff_shield_alpha", {
      id: "buff_shield_alpha", name: "Shield Alpha", _version: 1,
      duration: 3, modifiers: { damageTakenMultiplier: 0.7 },
      ccFlags: {}, stacks: false,
      tags: ["defensive"], description: "Reduces damage taken.",
    });

    DataStore.write("templates/buffs/buff_dot_alpha", {
      id: "buff_dot_alpha", name: "Burning Alpha", _version: 1,
      duration: 4,
      tickDamage: { damageType: "pyro", flat: 5, scaling: "sp", multiplier: 0.05 },
      modifiers: {}, ccFlags: {}, stacks: true, maxStacks: 3,
      tags: ["pyro","dot"], description: "Deals pyro damage each turn.",
    });

    DataStore.write("templates/classes/class_alpha", {
      id: "class_alpha", name: "Alpha Class", _version: 1,
      baseHp: 50, baseMana: 0,
      resources: ["stamina"], primaryResource: "stamina",
      statContribution: { str: 2, dex: 1, con: 2, int: -1, spi: -1 },
      passiveHooks: ["rage_on_hit"],
      startingAbilities: ["ability_alpha"],
      description: "A synthetic class for testing.",
    });

    DataStore.write("templates/classes/class_beta", {
      id: "class_beta", name: "Beta Class", _version: 1,
      baseHp: 20, baseMana: 80,
      resources: ["mana"], primaryResource: "mana",
      statContribution: { str: -1, dex: 0, con: -1, int: 3, spi: 2 },
      passiveHooks: [],
      startingAbilities: ["ability_beta"],
      description: "A synthetic class for testing.",
    });

    DataStore.write("templates/companions/companion_unit_01", {
      id: "companion_unit_01", name: "Unit-01", _version: 1,
      raceId: "sephir", classId: "class_alpha",
      statOverrides: { str: 20, dex: 18, con: 20, int: 10, spi: 12 },
      abilities: ["ability_alpha","ability_gamma"],
      traits: ["trait_stubborn"], quirks: [],
      aiProfile: "aggressive",
      lore: "A synthetic companion for testing.",
      tags: ["test"],
    });

    DataStore.write("templates/companions/companion_unit_02", {
      id: "companion_unit_02", name: "Unit-02", _version: 1,
      raceId: "sephir", classId: "class_beta",
      statOverrides: { str: 12, dex: 15, con: 14, int: 22, spi: 18 },
      abilities: ["ability_beta"],
      traits: [], quirks: ["quirk_nervous"],
      aiProfile: "aggressive",
      lore: "A synthetic mage companion for testing.",
      tags: ["test"],
    });

    DataStore.write("instances/companions/instance_unit_01", {
      instanceId: "instance_unit_01", templateId: "companion_unit_01",
      _version: 1, xp: 0, level: 1,
      currentHp: 260, currentMp: 0, maxHp: 260, maxMp: 0,
      deathState: "alive", permadead: false, downedAt: null, rezCost: 0,
      learnedAbilities: [], acquiredQuirks: [],
      activeBuffs: [], relationship: 10,
      skills: {},
    });

    for (const [id, mob] of Object.entries(_mobsData.mobs))
      DataStore.write(`templates/enemies/${id}`, mob);

    for (const [id, trap] of Object.entries(_trapsData.traps || {}))
      DataStore.write(`templates/traps/${id}`, trap);

    DataStore.write("templates/items/item_test_sword", {
      id: "item_test_sword", name: "Test Sword", _version: 1,
      type: "weapon", slot: "mainhand",
      statBonuses: { attackPower: 20 },
      value: 10,
      quality: "common", tags: ["test","weapon"],
      description: "A synthetic weapon for testing.",
    });

    DataStore.write("templates/items/item_test_scrap", {
      id: "item_test_scrap", name: "Test Scrap", _version: 1,
      type: "material", slot: "none",
      statBonuses: {},
      value: 1,
      quality: "poor", tags: ["test","material"],
      description: "Worthless test scrap.",
    });

    DataStore.write("templates/traits/trait_stubborn", {
      id: "trait_stubborn", name: "Stubborn", _version: 1,
      effects: [{ type: "resist_cc", value: 0.1 }],
      tags: ["personality"],
      description: "Resists CC effects 10% more often.",
    });

    DataStore.write("templates/quirks/quirk_nervous", {
      id: "quirk_nervous", name: "Nervous", _version: 1,
      type: "negative",
      effects: [{ type: "stat_mod", stat: "critChanceMelee", value: -0.01 }],
      tags: ["personality"],
      description: "Slightly reduced crit chance under pressure.",
    });

    DataStore.write("templates/zones/zone_test_plains", {
      id: "zone_test_plains", name: "Test Plains", _version: 1,
      encounterTableId: "encounter_test_plains",
      minPartyLevel: 1, maxPartyLevel: 10,
      ambientBuffs: [], tags: ["test","outdoor"],
      lore: "Featureless synthetic plains for testing.",
    });

    for (const [id, table] of Object.entries(_encounterTablesData.encounterTables))
      DataStore.write(`templates/encounter_tables/${id}`, table);

    // seedCompanions is defined in companions.js (loaded after this module).
    // Guard so the auto-run at module load time doesn't throw; the explicit
    // SyntheticGameData.seed() call in electron-main.js fires after all modules
    // are loaded and will hit the real path.
    if (typeof seedCompanions !== "undefined") seedCompanions(DataStore);

    for (const [id, quest] of Object.entries({ ...(_questsData.realQuests || {}), ...(_questsData.testQuests || {}) }))
      DataStore.write(`templates/quests/${id}`, quest);

    DataStore.write("saves/save_slot_01", {
      saveId: "slot_01", _version: 1,
      timestamp: new Date().toISOString(),
      mode: "normal",
      currentZone: "zone_test_plains",
      party: [{ instanceId: "instance_unit_01", templateId: "companion_unit_01" }],
      quests: {
        quest_test_01: { objectives: { obj_kill_grunts: 0 }, completed: false },
      },
      inventory: [{ itemId: "item_test_sword", qty: 1 }],
      currency: 0,
      reputation: { faction_test: 0 },
      talentSchools: { school_fire: 0 },
      flags: { tutorial_complete: false },
      playtime: 0,
      shopStocks: {},
      riding: 1,
      mounts: [],
    });

    Patcher.registerPatch({
      fromVersion: 1, toVersion: 2,
      _description: "Add 'flavor' field to abilities",
      ops: [
        { _op: "merge", path: "", value: { flavor: "" } },
      ],
    });

  };

  return { seed };
})();


// =============================================================================
// TEST SUITE
// =============================================================================

const TestSuite = (() => {

  let passed = 0, failed = 0;
  const results = [];

  const assert = (label, condition, detail = "") => {
    condition ? passed++ : failed++;
    results.push({ ok: !!condition, label, detail });
  };

  const run = () => {
    passed = 0; failed = 0; results.length = 0;

    // VALIDATOR
    assert("Validator: valid ability passes",
      Validator.validateNamed({ id: "test_ability", name: "Test", targeting: "self", effects: [{ type: "buff" }] }, "ability").valid);
    assert("Validator: missing required field fails",
      !Validator.validateNamed({ id: "test_ability" }, "ability").valid);
    assert("Validator: bad enum value fails",
      !Validator.validateNamed({ id: "test_ability", name: "Test", targeting: "invalid_target", effects: [{ type: "buff" }] }, "ability").valid);
    assert("Validator: pattern check fails on bad id",
      !Validator.validateNamed({ id: "Bad ID!", name: "Test", targeting: "self", effects: [{ type: "buff" }] }, "ability").valid);
    assert("Validator: number minimum enforced",
      !Validator.validateNamed({ id: "test", name: "Test", targeting: "self", effects: [{ type: "buff" }], cooldown: -1 }, "ability").valid);

    // passive ability validates correctly
    assert("Validator: passive ability passes",
      Validator.validateNamed({ id: "test_passive", name: "Passive", targeting: "self", passive: true, trigger: "always", effects: [{ type: "stat_mod", stat: "spellPower", source: "spi", multiplier: 0.25 }] }, "ability").valid);

    // LOADER
    const loadAbility = Loader.load("templates/abilities/ability_alpha", "ability");
    assert("Loader: loads valid ability", loadAbility.ok);
    assert("Loader: defaults applied (tags array)", Array.isArray(loadAbility.data?.tags));
    assert("Loader: correct id", loadAbility.data?.id === "ability_alpha");
    assert("Loader: missing file returns error", !Loader.load("templates/abilities/nonexistent", "ability").ok);
    const loadAll = Loader.loadAll("templates/abilities/", "ability");
    assert("Loader: loadAll returns abilities", loadAll.items.length >= 3);
    assert("Loader: loadAll ok flag", loadAll.ok);
    assert("Loader: loads valid companion", Loader.load("templates/companions/companion_unit_01", "companion").ok);
    assert("Loader: loads valid enemy", Loader.load("templates/enemies/enemy_test_grunt", "enemy").ok);

    // enemy with null currencyDrop validates
    assert("Validator: enemy null currencyDrop passes",
      Loader.load("templates/enemies/enemy_test_grunt", "enemy").ok);

    const ciLoad = Loader.load("instances/companions/instance_unit_01", "companionInstance");
    assert("Loader: loads companionInstance", ciLoad.ok);
    assert("Loader: companionInstance has gear object", typeof ciLoad.data?.gear === "object");
    assert("Loader: companionInstance has skills object", typeof ciLoad.data?.skills === "object");

    // SAVER
    const testSaveData = { saveId: "test_save_01", _version: 1, timestamp: new Date().toISOString(), mode: "normal", currentZone: "zone_test_plains", party: [], quests: {}, inventory: [], currency: 0, reputation: {}, talentSchools: {}, flags: {}, playtime: 0, shopStocks: {} };
    assert("Saver: saves valid save file", Saver.saveSave(testSaveData).ok);
    assert("Saver: file exists after save", DataStore.exists("saves/save_test_save_01"));
    Saver.saveSave(testSaveData);
    assert("Saver: re-save creates backup", DataStore.exists("saves/save_test_save_01.backup"));
    assert("Saver: invalid data rejected pre-save", !Saver.saveSave({ saveId: "bad" }).ok);

    // PATCHER
    const pt = { id: "test_patch", name: "Before", _version: 1, oldField: "yes" };
    assert("Patcher: set op", Patcher.applyOp(pt, { _op: "set", path: "name", value: "After" }).name === "After");
    assert("Patcher: delete op", !("oldField" in Patcher.applyOp(pt, { _op: "delete", path: "oldField" })));
    const ren = Patcher.applyOp(pt, { _op: "rename", path: "oldField", to: "newField" });
    assert("Patcher: rename op", "newField" in ren && !("oldField" in ren));
    assert("Patcher: merge op", Patcher.applyOp(pt, { _op: "merge", path: "", value: { extra: "added" } }).extra === "added");
    const appR = Patcher.applyOp({ list: ["a"] }, { _op: "append", path: "list", value: "b" });
    assert("Patcher: append op", appR.list.length === 2 && appR.list[1] === "b");
    const migR = Patcher.migrate({ id: "migrate_test", _version: 1 }, 2);
    assert("Patcher: migrate advances version", migR.ok && migR.data._version === 2);
    assert("Patcher: migrate applies op", "flavor" in migR.data);
    assert("Patcher: missing patch returns error", !Patcher.migrate({ id: "bad", _version: 99 }, 100).ok);

    // MERGER
    const base = { a: 1, b: { x: 10, y: 20 }, c: [1,2,3] };
    const over = { b: { x: 99 }, c: [4,5], d: "new" };
    const merged = Merger.deepMerge(base, over);
    assert("Merger: overrides nested scalar", merged.b.x === 99);
    assert("Merger: preserves unaffected nested field", merged.b.y === 20);
    assert("Merger: replaces array", JSON.stringify(merged.c) === JSON.stringify([4,5]));
    assert("Merger: adds new field", merged.d === "new");
    assert("Merger: preserves base field", merged.a === 1);
    assert("Merger: null deletes field", !("a" in Merger.deepMerge(base, { a: null })));
    const { resolved } = Merger.resolveCompanion(Loader.load("templates/companions/companion_unit_01","companion").data, ciLoad.data);
    assert("Merger: resolveCompanion produces object", !!resolved);
    const saveA = { saveId: "x", _version: 1, timestamp: "2024-01-01T00:00:00Z", party: [], quests: {}, inventory: [], playtime: 10 };
    const saveB = { saveId: "x", _version: 1, timestamp: "2024-06-01T00:00:00Z", party: [], quests: {}, inventory: [], playtime: 20 };
    assert("Merger: mergeSaves picks newest", Merger.mergeSaves(saveA, saveB, "newest").merged.playtime === 20);
    assert("Merger: mergeSaves left priority", Merger.mergeSaves(saveA, saveB, "left").merged.playtime === 10);
    const c2 = Merger.detectConflicts({ hp: 100, name: "same" }, { hp: 200, name: "same" });
    assert("Merger: detectConflicts finds conflict", c2.length === 1 && c2[0].field === "hp");

    // MODIFIERS
    const save0 = { saveId: "s", _version: 1, timestamp: "", party: [], quests: {}, inventory: [], reputation: {}, talentSchools: {}, flags: {}, playtime: 0 };
    const save1 = Modifiers.addReputation(save0, "faction_test", 25);
    assert("Modifiers: addReputation sets value", save1.reputation.faction_test === 25);
    assert("Modifiers: addReputation caps at 100", Modifiers.addReputation(save1, "faction_test", 90).reputation.faction_test === 100);
    assert("Modifiers: advanceTalent accumulates", Modifiers.advanceTalent(save0, "school_fire", 3).talentSchools.school_fire === 3);
    const inst0 = { instanceId: "x", templateId: "y", learnedAbilities: [], acquiredQuirks: [] };
    const inst3 = Modifiers.learnAbility(inst0, "ability_alpha");
    assert("Modifiers: learnAbility adds ability", inst3.learnedAbilities.includes("ability_alpha"));
    assert("Modifiers: learnAbility no duplicates", Modifiers.learnAbility(inst3, "ability_alpha").learnedAbilities.length === 1);
    assert("Modifiers: addQuirk adds quirk", Modifiers.addQuirk(inst0, "quirk_nervous").acquiredQuirks.includes("quirk_nervous"));
    const save4 = Modifiers.completeObjective(save0, "quest_test_01", "obj_kill_grunts");
    assert("Modifiers: completeObjective marks objective", save4.quests.quest_test_01.objectives.obj_kill_grunts === true);
    assert("Modifiers: completeQuest marks complete", Modifiers.completeQuest(save4, "quest_test_01").quests.quest_test_01.completed === true);
    const save6 = Modifiers.addToInventory(save0, "item_test_scrap", 5);
    assert("Modifiers: addToInventory adds item", save6.inventory[0].qty === 5);
    assert("Modifiers: addToInventory stacks qty", Modifiers.addToInventory(save6, "item_test_scrap", 3).inventory[0].qty === 8);
    assert("Modifiers: setFlag sets flag", Modifiers.setFlag(save0, "tutorial_complete", true).flags.tutorial_complete === true);
    const flagged = Modifiers.setFlag(save0, "trackingBoost", { targetId: "x" });
    assert("Modifiers: clearFlag removes flag", !("trackingBoost" in Modifiers.clearFlag(flagged, "trackingBoost").flags));

    // ENCOUNTER TABLE
    const etResult = Loader.load("templates/encounter_tables/encounter_test_plains", "encounterTable");
    assert("Loader: loads encounter table", etResult.ok);
    assert("Encounter table has combatPool", Array.isArray(etResult.data?.combatPool));
    assert("Encounter table combatPool has 2 entries", etResult.data?.combatPool.length === 2);
    assert("Encounter table has slots array", Array.isArray(etResult.data?.slots));
    assert("Encounter table has exclusiveGroups", Array.isArray(etResult.data?.exclusiveGroups));
    assert("Encounter table has recruitPool", Array.isArray(etResult.data?.recruitPool));

    // ZONE & QUEST
    const zoneResult = Loader.load("templates/zones/zone_test_plains", "zone");
    assert("Loader: loads zone", zoneResult.ok);
    assert("Zone has forcedOnly default", zoneResult.data?.forcedOnly === false);
    assert("Zone has forcedEncounterQueue default", Array.isArray(zoneResult.data?.forcedEncounterQueue));
    assert("Loader: loads quest", Loader.load("templates/quests/quest_test_01", "quest").ok);

    return { passed, failed, total: passed + failed, results };
  };

  const report = (runResults) => {
    const lines = [
      `\n${"=".repeat(60)}`,
      `DATA LAYER TEST RESULTS: ${runResults.passed}/${runResults.total} passed`,
      "=".repeat(60),
      ...runResults.results.map(r => `  ${r.ok ? "✓" : "✗"} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`),
      runResults.failed > 0 ? `\n  ${runResults.failed} test(s) FAILED` : `\n  All tests passed.`,
      "=".repeat(60),
    ];
    return lines.join("\n");
  };

  return { run, report };
})();


// =============================================================================
// BOOTSTRAP
// =============================================================================

// seed() is the app's data bootstrap (encounter tables, templates) — always runs.
// The self-test only runs under the harness (Testing/run_tests.js sets the flag).
SyntheticData.seed();
if (typeof process !== "undefined" && process.env.GALANOVA_RUN_TESTS) {
  const results = TestSuite.run();
  console.log(TestSuite.report(results));
}

if (typeof module !== "undefined") {
  module.exports = {
    SCHEMAS, Validator, DataStore, Loader, Saver,
    Patcher, Merger, Modifiers, SyntheticData, TestSuite,
  };
}