// =============================================================================
// window.gameAPI — typed IPC surface
// Ambient declaration of the bridge preload.ts exposes via
// contextBridge.exposeInMainWorld('gameAPI', …). Keep in sync with preload.ts.
//
// Return types are Promise<any> for now (the IPC payloads are the engine's
// loosely-typed snapshot objects). Tighten these to real shapes once the
// engine's view-model types stabilise.
// =============================================================================

export interface GameAPI {
  init(): Promise<any>;
  runEncounter(): Promise<any>;
  engageCombat(): Promise<any>;
  tryFlee(): Promise<any>;
  selectZone(zoneId: string): Promise<any>;
  renderBag(): Promise<any>;
  renderStats(): Promise<any>;
  renderMap(): Promise<any>;
  renderShop(): Promise<any>;
  getShopData(): Promise<any>;
  buyItem(id: string, qty: number, keeperName: string): Promise<any>;
  sellItem(id: string, qty: number): Promise<any>;
  renderParty(): Promise<any>;
  getCraftingData(): Promise<any>;
  craftItem(recipeId: string): Promise<any>;
  butcherCorpses(): Promise<any>;
  equipItem(id: string, iid: string): Promise<any>;
  rezMember(instanceId: string): Promise<any>;
  allocateStat(instanceId: string, stat: string): Promise<any>;
  useItem(itemId: string): Promise<any>;
  back(): Promise<any>;
  getItemCatalog(): Promise<any>;
  getBuffCatalog(): Promise<any>;
  getQuestCatalog(): Promise<any>;
  getEntityCatalog(): Promise<any>;
  setCombatMode(mode: string): Promise<any>;
  executePlayerAction(actions: unknown): Promise<any>;
  getRosterData(): Promise<any>;
  swapPartyMember(outId: string, inId: string): Promise<any>;
  removeFromParty(id: string): Promise<any>;
  addToParty(id: string): Promise<any>;
  setPetForCompanion(id: string, petId: string): Promise<any>;
  getAvailablePets(id: string): Promise<any>;
  listSaveSlots(): Promise<any>;
  saveToSlot(slotId: string, saveName: string): Promise<any>;
  loadFromSlot(slotId: string): Promise<any>;
  deleteSaveSlot(slotId: string): Promise<any>;
}

declare global {
  interface Window {
    gameAPI: GameAPI;
  }
}

export {};
