// =============================================================================
// COMBAT RUNTIME TYPES — Galanova
// The in-memory shapes the combat core (gameplayloop.ts) builds and mutates:
// the per-fight Unit, the live buff/debuff instances applied to it, the scaling
// override bundle, and the reward summary accumulated on victory. These are
// RUNTIME objects (not the JSON data templates in ./data.ts) — buildUnit turns a
// party/enemy template into a Unit, then the turn loop mutates it in place.
//
// Both Unit and BuffInstance carry an index signature: the combat loop attaches
// a number of transient, ability-specific fields (mana pools, per-turn flags,
// proc bookkeeping) that aren't worth enumerating and would only invite churn.
// The stable, load-bearing fields are typed; the dynamic tail stays `any`.
// =============================================================================

import type { DerivedStats } from "../charsheet.js";
import type { EffectEntry, Scaling } from "./data.js";

// Derived stats as combat reads them, plus the ad-hoc keys always-on passives
// and shapeshift forms poke in by name (applyAlwaysPassives indexes d[stat]).
export type CombatDerived = DerivedStats & { [key: string]: number };

export interface UnitStats {
  raw: Record<string, number>;
  derived: CombatDerived;
  totals?: Record<string, number>;
}

// A buff/debuff instance sitting on a Unit — a snapshot of the Buff def (see
// applyBuff) plus live per-fight state (duration ticking down, stacks, charges).
export interface BuffInstance {
  id: string;
  sourceId?: string | null;
  duration: number | "infinite";
  casterScaling?: CasterSnapshot | null;
  modifiers?: Record<string, number>;
  ccFlags?: Record<string, unknown>;
  tickDamage?: TickLike | null;
  tickHeal?: TickLike | null;
  absorbShield?: number;
  charges?: number;
  isDebuff?: boolean;
  isWeaponBuff?: boolean;
  isFaded?: boolean;
  [key: string]: any;
}

export interface TickLike {
  damageType?: string;
  flat?: number;
  scaling?: Scaling;
  multiplier?: number;
  [key: string]: unknown;
}

// The crowd-control flag block every Unit carries.
export interface CcState {
  stunned: boolean;
  silenced: boolean;
  disarmed: boolean;
  rooted: boolean;
  feared: boolean;
  [key: string]: boolean;
}

// A combat unit: a party member, companion, pet, or enemy, built by buildUnit /
// buildPetUnit and mutated in place across the turn loop.
export interface Unit {
  id: string;
  name: string;
  classId: string;
  raceId: string;
  level: number;
  hp: number;
  maxHp: number;
  type?: string | null;
  xpValue?: number;
  loot?: any[];
  butcheryLoot?: any[];
  butcheryXp?: number;
  killReputation?: any[];
  currencyDrop?: any;
  stats: UnitStats;
  skills: Record<string, any>;
  gear: Record<string, any>;
  resources: Record<string, any>;
  cooldowns: Record<string, number>;
  castQueue: any[];
  buffs: BuffInstance[];
  debuffs: BuffInstance[];
  ccState: CcState;
  spd: number;
  abilities: string[];
  tags: string[];
  shieldEquipped: boolean;
  rangedReady: boolean;
  damageReceivedThisTurn: number;
  damageReceivedLastTurn: number;
  isEnemy: boolean;
  alive: boolean;
  threatTable: Record<string, number>;
  isPet?: boolean;
  ownerId?: string;
  aiProfile?: string;
  [key: string]: any;
}

// The scaling-override bundle threaded through damage/heal math: buff-adjusted
// attack/spell/ranged power the effect scales off of.
export interface Ov {
  ap: number;
  sp: number;
  rap: number;
}

// A minimal attacker-like snapshot captured when a DoT/HoT is applied, so its
// ticks scale off whoever cast it rather than the victim it sits on.
export interface CasterSnapshot {
  src: { stats: { totals?: Record<string, number>; raw?: Record<string, number> }; skills: Record<string, any> };
  ov: Ov;
}

// An effect entry as combat consumes it (ability effects, buff tick payloads).
// Structurally the JSON EffectEntry; aliased so combat call sites read clearly.
export type CombatEffect = EffectEntry;

// The reward bundle RewardEngine accumulates over an encounter's kills.
export interface RewardSummary {
  xp: number;
  currency: number;
  loot: any[];
  questProgress: any[];
  skillXp: Record<string, number>;
  levelUps: any[];
  xpMult?: number;
  reputation?: any[];
  butcherableKills?: any[];
  [key: string]: any;
}
