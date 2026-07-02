// =============================================================================
// IPC VIEW-MODEL TYPES — Galanova
// The shape of the snapshot electron-main's getSnapshot()/respond() send to the
// renderer over `window.gameAPI`. This is the contract between the engine and
// the UI: electron-main is annotated with these (so the engine is verified to
// produce them) and UI/src/gameAPI.d.ts consumes them (so components get real
// prop types). Fields the engine genuinely passes through untyped stay `any`.
// =============================================================================

import type { ResourceType } from "./data.js";

// ── Character sheet (display view-model produced by charsheet.ts) ────────────
export interface SheetDerived {
  maxHp: number;
  maxMp: number;
  attackPower: number;
  rangedAP: number;
  spellPower: number;
  armor: number;
  mitPct: number;
  meleeCrit: number;
  spellCrit: number;
  dodge: number;
  manaRegen: number;
  resistances: Record<string, number>;
}

export interface SheetSkill {
  level: number;
  xp: number;
  xpToNext: number | null;
  atMax: boolean;
  name: string | null;
}

export interface CharacterSheet {
  totals: Record<string, number>;
  gearBonuses: Record<string, number>;
  derived: SheetDerived;
  skills: Record<string, SheetSkill>;
  resources: ResourceType[];
  skillMaxLevel: number;
}

// One inventory row, enriched by electron-main with item-template metadata.
export interface InventoryItemView {
  itemId: string;
  qty: number;
  itemType?: string;
  slot?: string;
  quality?: string;
  [key: string]: any;
}

// The save fields the renderer is allowed to see (a curated subset of the full
// engine save — see electron-main getSnapshot).
export interface SaveView {
  currentZone: string;
  currency: number;
  mode: string;
  party: { instanceId: string; templateId: string }[];
  inventory: InventoryItemView[];
  quests: Record<string, any>;
  flags: Record<string, any>;
  riding: number;
  mounts: string[];
  reputation: Record<string, number>;
  talentSchools: Record<string, number>;
  roster: any[];
  collections: { kills: Record<string, number>; items: Record<string, number> };
  achievements: Record<string, any>;
}

export interface ZoneView {
  id: string;
  name: string;
  type: string | null;
  region: string | null;
  minLevel: number | undefined;
  maxLevel: number | undefined;
  shopInventory: any[];
  lore: string;
}

export interface TravelZoneView {
  id: string;
  name: string;
  type: string | null;
  minLevel: number | undefined;
  maxLevel: number | undefined;
  region: string | null;
  travelCost: number;
}

// A party member instance plus its precomputed display sheet. The instance
// fields are passed through from the engine (dynamic), so an index signature
// keeps them available while `sheet` is fully typed.
export interface PartyInstanceView {
  instanceId: string;
  sheet: CharacterSheet;
  [key: string]: any;
}

// ── Commune / dialogue overlay (storyline scenes) ────────────────────────────
export interface SceneChoiceVM {
  index: number;
  label: string;
}

// The resolved current dialogue node the renderer draws in the Commune overlay.
export interface SceneNodeVM {
  dialogueId: string;
  channel: string;                 // "personal_log" | "commune"
  nodeId: string;
  speaker: {
    id: string; name: string;
    accent?: string; silhouette?: string; rune?: string;
  } | null;
  text: string;
  hint: string | null;             // a UI tab to name/pulse (e.g. "bag", "shops")
  choices: SceneChoiceVM[];        // empty → advance with a single "continue"
  isLast: boolean;
}

// The full snapshot returned by getSnapshot().
export interface GameSnapshot {
  state: any;
  save: SaveView | null;
  partyInstances: PartyInstanceView[];
  zoneData: ZoneView | null;
  travelZones: TravelZoneView[];
  canButcher: boolean;
  combatMode: string;
  manualCombat: any | null;
  pendingScene: SceneNodeVM | null;
  activeSlotId: string;
}

// respond() = a snapshot plus the freshly flushed log lines.
export interface RespondResult extends GameSnapshot {
  messages: string[];
}

// One save-slot row from listSaveSlots().
export interface SaveSlotView {
  slotId: string;
  timestamp: string;
  saveName: string | null;
  isActive: boolean;
  [key: string]: any;
}

// game:getEntityCatalog — clean id→meta maps for combat-log entity tooltips.
export interface EntityCatalog {
  abilities: Record<string, any>;
  zones: Record<string, any>;
  regions: Record<string, any>;
  mobs: Record<string, any>;
}

// game:getShopData.
export interface ShopData {
  zoneName: string;
  sellMultiplier: number;
  shopkeepers: Record<string, any>;
  sellList: any[];
  [key: string]: any;
}

// game:getCraftingData.
export interface CraftingData {
  recipes: any[];
}
