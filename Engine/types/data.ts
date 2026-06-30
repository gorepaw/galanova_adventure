// =============================================================================
// DATA TYPES — Galanova
// Hand-written TypeScript interfaces derived from the datalayer SCHEMAS
// (Engine/datalayer.ts). These describe the validated shape of Data/*.json so
// both the engine and (eventually) data authoring get compile-time checking.
//
// Schemas marked OPEN (additionalProperties: true) carry an index signature so
// fields still under design don't error; LOCKED schemas are exact.
// =============================================================================

// ── Shared scalar unions ─────────────────────────────────────────────────────

export type StatKey = "str" | "dex" | "con" | "int" | "spi" | "wis" | "spd" | "cha";

export type DamageType =
  | "physical" | "pyro" | "cryo" | "nature" | "chaos" | "order" | "bio" | "energy" | "psychic";

export type ArmorTier = "clothing" | "light" | "medium" | "heavy";

export type ResourceType = "mana" | "rage" | "stamina" | "combo_points";

export type Quality = "poor" | "common" | "uncommon" | "rare" | "epic" | "legendary";

export type ItemType =
  | "weapon" | "armor" | "trinket" | "consumable" | "quest" | "material" | "recipe" | "held";

export type Slot =
  | "mainhand" | "offhand" | "head" | "chest" | "legs" | "feet" | "hands" | "back"
  | "neck" | "ring" | "trinket" | "none" | "waist" | "shoulders" | "wrist" | "tabard"
  | "ranged" | "ammo" | "relic";

export type WeaponType =
  | "sword_1h" | "sword_2h" | "axe_1h" | "axe_2h" | "mace_1h" | "mace_2h" | "dagger"
  | "fist" | "staff" | "polearm" | "wand" | "bow" | "crossbow" | "gun" | "thrown";

export type Targeting =
  | "self" | "single_enemy" | "single_ally" | "all_enemies" | "all_allies"
  | "random_enemy" | "random_ally" | "lowest_hp_enemy" | "lowest_hp_ally";

export type EffectKind =
  | "damage" | "heal" | "buff" | "debuff" | "resource" | "cc" | "stat_mod" | "proc";

export type EffectTrigger = "always" | "on_hit" | "on_crit_heal" | "on_being_hit";

export type EnemyType =
  | "humanoid" | "beast" | "undead" | "elemental" | "demon" | "dragon"
  | "giant" | "mechanical" | "aberration";

export type DeathState = "alive" | "downed" | "dead";

export type SaveMode = "normal" | "ironman" | "hardcore";

export type QuirkType = "positive" | "negative" | "neutral";

// `scaling` is either a single-stat string (an attribute, "ap"/"sp"/"rap", or a
// skill id) or an object map of stat -> coefficient.
export type Scaling = string | Record<string, number>;

// ── Stats & costs ────────────────────────────────────────────────────────────

export type StatBlock = Partial<Record<StatKey, number>> & {
  str: number; dex: number; con: number; int: number; spi: number;
};

export interface ResourceCost {
  mana?: number;
  rage?: number;
  stamina?: number;
  combo_points?: number;
}

export interface TickEntry {
  damageType?: DamageType;
  flat?: number;
  scaling?: Scaling;
  multiplier?: number;
}

export interface EffectEntry {
  type: EffectKind;
  damageType?: DamageType;
  scaling?: Scaling;
  multiplier?: number;
  usesWeapon?: "melee" | "ranged" | "none";
  flatBonus?: number;
  comboMultiplier?: number;
  buffId?: string;
  chance?: number;
  gains?: Record<string, number>;
  stat?: string;
  source?: string;
  flat?: number;
  trigger?: EffectTrigger;
  [key: string]: unknown;
}

// ── Versioned base ───────────────────────────────────────────────────────────

interface Versioned {
  _version?: number;
}

// ── Ability (OPEN) ───────────────────────────────────────────────────────────

export interface Ability extends Versioned {
  id: string;
  name: string;
  targeting: Targeting;
  effects: EffectEntry[];
  resourceCost?: ResourceCost;
  cooldown?: number;
  castTime?: number;
  threatModifier?: number;
  requiresComboPoints?: boolean;
  passive?: boolean;
  trigger?: EffectTrigger;
  tags?: string[];
  description?: string;
  [key: string]: unknown;
}

// ── Buff / debuff (LOCKED) ───────────────────────────────────────────────────

export interface Buff extends Versioned {
  id: string;
  name: string;
  duration: number | "infinite";
  modifiers?: Record<string, number>;
  ccFlags?: Record<string, unknown>;
  tickDamage?: TickEntry;
  tickHeal?: TickEntry;
  stacks?: boolean;
  maxStacks?: number;
  charges?: number;
  tags?: string[];
  description?: string;
}

// ── Class (OPEN) ─────────────────────────────────────────────────────────────

export interface ClassDef extends Versioned {
  id: string;
  name: string;
  armorTier: ArmorTier;
  coreStats: StatKey[];
  guaranteedLevelUp: Partial<Record<StatKey, number>>;
  resources: ResourceType[];
  primaryResource?: ResourceType;
  skills?: string[];
  startingBaseline: Partial<Record<StatKey, number>>;
  passiveHooks?: string[];
  startingAbilities?: string[];
  description?: string;
  [key: string]: unknown;
}

// ── Companion template (OPEN) ────────────────────────────────────────────────

export interface Companion extends Versioned {
  id: string;
  name: string;
  raceId: string;
  classId: string;
  profession?: string;
  joinLevel?: number;
  unlockZone?: string;
  unlockQuest?: string | null;
  unlockRepFaction?: string | null;
  unlockRepRequired?: number | null;
  baseStats?: Partial<StatBlock>;
  startingSkills?: Record<string, SkillEntry | number>;
  statOverrides?: Partial<StatBlock>;
  abilities?: string[];
  traits?: string[];
  quirks?: string[];
  gear?: Gear;
  joinDialogue?: string[];
  aiProfile?: string;
  lore?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ── Companion instance (OPEN) ────────────────────────────────────────────────

export type Gear = Partial<Record<Slot, string | null>>;

export interface CompanionInstance extends Versioned {
  instanceId: string;
  templateId: string;
  name?: string;
  raceId?: string | null;
  classId?: string;
  profession?: string;
  xp?: number;
  level?: number;
  currentHp?: number;
  currentMp?: number;
  maxHp?: number;
  maxMp?: number;
  deathState?: DeathState;
  permadead?: boolean;
  downedAt?: string | null;
  rezCost?: number;
  learnedAbilities?: string[];
  acquiredQuirks?: string[];
  activeBuffs?: unknown[];
  relationship?: number;
  skills?: Skills;
  unlockedSkills?: string[];
  gear?: Gear;
  customName?: string;
  stats?: { raw?: Partial<StatBlock> };
  unspentStatPoints?: number;
  [key: string]: unknown;
}

// ── Enemy (OPEN) ─────────────────────────────────────────────────────────────

export interface Enemy extends Versioned {
  id: string;
  name: string;
  baseStats: Partial<StatBlock>;
  aiProfile: string;
  abilities: string[];
  type?: EnemyType;
  loot?: unknown[];
  xpValue?: number;
  currencyDrop?: Record<string, unknown> | null;
  tags?: string[];
  description?: string;
  [key: string]: unknown;
}

// ── Item (LOCKED) ────────────────────────────────────────────────────────────

export interface ItemStatBonuses extends Partial<Record<StatKey, number>> {
  attackPower?: number;
  spellPower?: number;
  armor?: number;
  meleeCrit?: number;
  spellCrit?: number;
}

export interface Item extends Versioned {
  id: string;
  name: string;
  type: ItemType;
  slot: Slot;
  itemLevel?: number | null;
  minDamage?: number | null;
  maxDamage?: number | null;
  weaponSpeed?: number | null;
  weaponType?: WeaponType | null;
  statBonuses?: ItemStatBonuses;
  onUse?: Record<string, unknown> | null;
  allowedClasses?: string[];
  reqLevel?: number | null;
  unlockRepFaction?: string | null;
  unlockRepRequired?: number | null;
  value?: number;
  quality?: Quality;
  tags?: string[];
  description?: string;
}

// ── Zone (OPEN) ──────────────────────────────────────────────────────────────

export interface Zone extends Versioned {
  id: string;
  name: string;
  encounterTableId: string;
  minPartyLevel?: number;
  maxPartyLevel?: number;
  ambientBuffs?: string[];
  shopInventory?: unknown[];
  sellMultiplier?: number;
  tags?: string[];
  lore?: string;
  forcedOnly?: boolean;
  forcedEncounterQueue?: unknown[];
  [key: string]: unknown;
}

// ── Quest (OPEN) ─────────────────────────────────────────────────────────────

export interface Quest extends Versioned {
  id: string;
  name: string;
  objectives: Record<string, unknown>[];
  rewards: Record<string, unknown>;
  description?: string;
  prerequisites?: string[];
  zoneId?: string;
  autoAssign?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

// ── Encounter table (OPEN) ───────────────────────────────────────────────────

export interface CombatPoolEntry {
  enemyId: string;
  weight: number;
}

export interface EncounterTable extends Versioned {
  id: string;
  slots: Record<string, unknown>[];
  combatPool: CombatPoolEntry[];
  exclusiveGroups?: string[][];
  recruitPool?: string[];
  [key: string]: unknown;
}

// ── Trait / quirk ────────────────────────────────────────────────────────────

export interface Trait extends Versioned {
  id: string;
  name: string;
  effects: Record<string, unknown>[];
  tags?: string[];
  description?: string;
}

export interface Quirk extends Versioned {
  id: string;
  name: string;
  type: QuirkType;
  effects?: Record<string, unknown>[];
  tags?: string[];
  description?: string;
}

// ── Gathering node (OPEN) ────────────────────────────────────────────────────

export interface GatherNode extends Versioned {
  id: string;
  name: string;
  drops: Record<string, unknown>[];
  requiredProfession?: string | null;
  minSkillLevel?: number;
  skillGain?: number;
  rolls?: number;
  tags?: string[];
  [key: string]: unknown;
}

// ── Trap (OPEN) ──────────────────────────────────────────────────────────────

export interface Trap extends Versioned {
  id: string;
  name: string;
  xp?: number;
  detectText?: string;
  triggerText?: string;
  effect?: Record<string, unknown>;
  tags?: string[];
  [key: string]: unknown;
}

// ── Recipe (OPEN) ────────────────────────────────────────────────────────────

export interface Recipe extends Versioned {
  id: string;
  name: string;
  inputs: { itemId: string; qty: number }[];
  output: Record<string, unknown>;
  requiredProfession?: string | null;
  minSkillLevel?: number;
  skillGain?: number;
  skillGainTiers?: Record<string, unknown>[];
  tags?: string[];
  description?: string;
  [key: string]: unknown;
}

// ── Save file (OPEN) ─────────────────────────────────────────────────────────

export interface Save extends Versioned {
  saveId: string;
  _version: number;
  timestamp: string;
  party: Record<string, unknown>[];
  quests: Record<string, unknown>;
  inventory: { itemId: string; qty: number }[];
  mode?: SaveMode;
  currentZone?: string;
  currency?: number;
  reputation?: Record<string, number>;
  talentSchools?: Record<string, number>;
  flags?: Record<string, unknown>;
  playtime?: number;
  shopStocks?: Record<string, unknown>;
  riding?: number;
  mounts?: string[];
  [key: string]: unknown;
}

// ── Skills ───────────────────────────────────────────────────────────────────

export interface SkillEntry {
  level: number;
  xp: number;
}

// On an instance a skill value is { level, xp } or a legacy plain number (level).
export type Skills = Record<string, SkillEntry | number>;

export interface SkillAbilityRef {
  id: string;
  skillLevel?: number;
}

export interface SkillDef {
  id: string;
  name: string;
  category?: string;
  type?: string;
  weaponTypes?: string[];
  abilities?: SkillAbilityRef[];
  [key: string]: unknown;
}

// ── Data file wrappers (top-level shape of each Data/*.json) ──────────────────

export interface SkillsData {
  skills: Record<string, SkillDef>;
  maxLevel?: number;
  [key: string]: unknown;
}

export interface ClassesData {
  classes: Record<string, ClassDef>;
  maxLevel?: number;
  xpTable?: number[];
  [key: string]: unknown;
}

export interface RaceDef {
  id?: string;
  name?: string;
  statMod?: Partial<Record<StatKey, number>>;
  [key: string]: unknown;
}

export interface RacesData {
  races: Record<string, RaceDef>;
  [key: string]: unknown;
}
