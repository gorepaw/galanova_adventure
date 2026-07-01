// =============================================================================
// window.gameAPI — typed IPC surface
// Ambient declaration of the bridge preload.ts exposes via
// contextBridge.exposeInMainWorld('gameAPI', …). Keep in sync with preload.ts.
//
// Return types are the engine view-model (Engine/types/viewmodel.ts): the
// "dispatch" methods all funnel through electron-main respond() → RespondResult
// (snapshot + flushed log lines). Catalog/data getters use their own view types.
// =============================================================================

import type {
  RespondResult, SaveSlotView, EntityCatalog, ShopData, CraftingData,
} from '../../Engine/types/viewmodel'

type Slots = { slots: SaveSlotView[] }

export interface GameAPI {
  // ── dispatch (mutate engine state → fresh snapshot + log) ──────────────────
  init(): Promise<RespondResult>;
  runEncounter(): Promise<RespondResult>;
  engageCombat(): Promise<RespondResult>;
  tryFlee(): Promise<RespondResult>;
  selectZone(zoneId: string): Promise<RespondResult>;
  renderBag(): Promise<RespondResult>;
  renderStats(): Promise<RespondResult>;
  renderMap(): Promise<RespondResult>;
  renderShop(): Promise<RespondResult>;
  buyItem(id: string, qty: number, keeperName: string): Promise<RespondResult>;
  sellItem(id: string, qty: number): Promise<RespondResult>;
  renderParty(): Promise<RespondResult>;
  craftItem(recipeId: string): Promise<RespondResult>;
  butcherCorpses(): Promise<RespondResult>;
  equipItem(id: string, iid: string | null): Promise<RespondResult>;
  rezMember(instanceId: string): Promise<RespondResult>;
  allocateStat(instanceId: string, stat: string): Promise<RespondResult>;
  useItem(itemId: string): Promise<RespondResult>;
  back(): Promise<RespondResult>;
  setCombatMode(mode: string): Promise<RespondResult>;
  executePlayerAction(actions: unknown): Promise<RespondResult>;
  swapPartyMember(outId: string, inId: string): Promise<RespondResult>;
  removeFromParty(id: string): Promise<RespondResult>;
  addToParty(id: string): Promise<RespondResult>;
  setPetForCompanion(id: string, petId: string): Promise<RespondResult>;

  // ── catalog / data getters ─────────────────────────────────────────────────
  getItemCatalog(): Promise<Record<string, any>>;
  getBuffCatalog(): Promise<Record<string, any>>;
  getQuestCatalog(): Promise<Record<string, any>>;
  getEntityCatalog(): Promise<EntityCatalog>;
  getShopData(): Promise<ShopData>;
  getCraftingData(): Promise<CraftingData>;
  getRosterData(): Promise<any>;
  getAvailablePets(id: string): Promise<any>;

  // ── save slots ──────────────────────────────────────────────────────────────
  listSaveSlots(): Promise<SaveSlotView[]>;
  saveToSlot(slotId: string, saveName: string): Promise<RespondResult & Slots>;
  loadFromSlot(slotId: string): Promise<RespondResult & Slots>;
  deleteSaveSlot(slotId: string): Promise<{ slots?: SaveSlotView[]; error?: string }>;
}

declare global {
  interface Window {
    gameAPI: GameAPI;
  }
}

export {};
