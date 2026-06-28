const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const isDev = !app.isPackaged

// Load an engine module and merge its exports into global scope.
// Mirrors Testing/run_tests.js bootstrap so engine files that check
// `typeof DataStore === "undefined"` can find each other at top level.
function loadGlobal(modulePath) {
  const exports = require(modulePath)
  if (exports && typeof exports === 'object') Object.assign(global, exports)
}

// Load recipe definitions directly from disk — bypasses in-memory DataStore
// so getCraftingData works even if seed timing is off.
let _recipeTemplates = []
function loadRecipeTemplates() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'Data/crafting.json'), 'utf8'))
    _recipeTemplates = Object.values(raw.recipes || {})
  } catch (e) {
    console.error('[loadRecipeTemplates] failed:', e.message)
    _recipeTemplates = []
  }
}

let _itemTemplates = {}
function loadItemTemplates() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'Data/items.json'), 'utf8').replace(/^﻿/, ''))
    _itemTemplates = raw.items || {}
    // Merge in random-suffix variants so the bag UI's itemType/slot/quality
    // enrichment (below) also recognizes "<item>__<suffix>" ids.
    for (const variant of ItemSuffixes.generateAllVariants(_itemTemplates)) {
      _itemTemplates[variant.id] = variant
    }
  } catch (e) {
    console.error('[loadItemTemplates] failed:', e.message)
    _itemTemplates = {}
  }
}

let _questTemplates = {}
function loadQuestTemplates() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'Data/quests.json'), 'utf8').replace(/^﻿/, ''))
    _questTemplates = raw.realQuests || {}
  } catch (e) {
    console.error('[loadQuestTemplates] failed:', e.message)
    _questTemplates = {}
  }
}

let session = null
let _activeSlotId = 'slot_start'

// ── Save persistence ──────────────────────────────────────────────────────────

function getSavesDir() {
  const dir = path.join(app.getPath('userData'), 'kalimdor_saves')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function loadSavesFromDisk() {
  const dir = getSavesDir()
  try {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        if (raw && raw.saveId) {
          const { _companions, ...saveData } = raw
          DataStore.write(`saves/save_${raw.saveId}`, saveData)
          if (_companions && typeof _companions === 'object') {
            // Cache companions per-slot for mid-session loads
            DataStore.write(`saves/companions_${raw.saveId}`, _companions)
            // Restore individual instances into working DataStore
            for (const [iid, inst] of Object.entries(_companions)) {
              DataStore.write(`instances/companions/${iid}`, inst)
            }
          }
        }
      } catch (e) { console.error('[loadSaves] bad file', file, e.message) }
    }
  } catch (e) { console.error('[loadSaves] dir error:', e.message) }
}

function writeSaveToDisk(slotId) {
  const raw = DataStore.read(`saves/save_${slotId}`)
  if (!raw) return
  // Bundle companion instances so they survive app restarts
  const companions = {}
  for (const m of [...(raw.party || []), ...(raw.roster || [])]) {
    if (!m.instanceId) continue
    const inst = DataStore.read(`instances/companions/${m.instanceId}`)
    if (inst) companions[m.instanceId] = inst
  }
  // Cache per-slot in DataStore for mid-session slot switches
  DataStore.write(`saves/companions_${slotId}`, companions)
  fs.writeFileSync(
    path.join(getSavesDir(), `${slotId}.json`),
    JSON.stringify({ ...raw, _companions: companions }, null, 2),
    'utf8'
  )
}

function deleteSaveFromDisk(slotId) {
  const p = path.join(getSavesDir(), `${slotId}.json`)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

function listSaveSlots() {
  return SaveManager.listSlots()
    .map(slot => ({
      ...slot,
      saveName: DataStore.read(`saves/save_${slot.slotId}`)?.saveName || null,
      isActive: slot.slotId === _activeSlotId,
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
}

function initEngine() {
  loadGlobal(path.join(__dirname, 'Engine/datalayer.js'))
  loadGlobal(path.join(__dirname, 'Engine/itemsuffixes.js'))
  loadGlobal(path.join(__dirname, 'Engine/leveltables.js'))
  loadGlobal(path.join(__dirname, 'Engine/skills.js'))
  loadGlobal(path.join(__dirname, 'Engine/companions.js'))
  loadGlobal(path.join(__dirname, 'Engine/encounters.js'))
  loadGlobal(path.join(__dirname, 'Engine/gameplayloop.js'))
  // Seed the real game data (zones, enemies, items, the starting character/save).
  // Self-tests do NOT run on launch — they are gated behind GALANOVA_RUN_TESTS.
  SyntheticGameData.seed()
  loadRecipeTemplates()
  loadItemTemplates()
  loadQuestTemplates()
}

function getSnapshot() {
  if (!session) {
    return { state: null, save: null, partyInstances: [], zoneData: null, travelZones: [], canButcher: false }
  }
  const save = session.getSave()

  const partyInstances = (save?.party || []).map(m => {
    const r = Loader.load(`instances/companions/${m.instanceId}`, 'companionInstance')
    return r.ok ? r.data : { instanceId: m.instanceId, name: m.instanceId }
  })

  const highestLevel = partyInstances.reduce((max, inst) => Math.max(max, inst.level || 1), 1)

  let zoneData = null
  let travelZones = []
  if (save?.currentZone) {
    const zr = Loader.load(`templates/zones/${save.currentZone}`, 'zone')
    const currentRegion = zr.ok ? zr.data.regionId : null
    if (zr.ok) {
      const z = zr.data
      zoneData = {
        id: z.id,
        name: z.name,
        type: z.zoneType,
        region: z.regionId,
        minLevel: z.minPartyLevel,
        maxLevel: z.maxPartyLevel,
        shopInventory: z.shopInventory || [],
        lore: z.lore || '',
      }
    }

    const allZoneKeys = DataStore.list('templates/zones/')
    travelZones = allZoneKeys
      .map(key => { const r = Loader.load(key, 'zone'); return r.ok ? r.data : null })
      .filter(z => z && z.id !== save.currentZone && highestLevel >= (z.minPartyLevel || 1))
      .sort((a, b) => (a.minPartyLevel || 0) - (b.minPartyLevel || 0) || a.name.localeCompare(b.name))
      .map(z => {
        const sameRegion = z.regionId === currentRegion
        const travelCost = sameRegion ? 0 : Math.max(100, (z.minPartyLevel || 1) * 10)
        return { id: z.id, name: z.name, type: z.zoneType, minLevel: z.minPartyLevel, maxLevel: z.maxPartyLevel, region: z.regionId, travelCost }
      })
  }

  return {
    state: session.getCurrentState(),
    save: save ? {
      currentZone: save.currentZone,
      currency: save.currency,
      mode: save.mode,
      party: save.party,
      inventory: (save.inventory || []).map(e => {
        const tpl = _itemTemplates[e.itemId]
        return tpl ? { ...e, itemType: tpl.type, slot: tpl.slot, quality: tpl.quality } : e
      }),
      quests: save.quests || {},
      flags: save.flags || {},
      riding: save.riding,
      mounts: save.mounts || [],
      reputation: save.reputation || {},
      talentSchools: save.talentSchools || {},
      roster: save.roster || [],
      collections: save.collections || { kills: {}, items: {} },
      achievements: save.achievements || {},
    } : null,
    partyInstances,
    zoneData,
    travelZones,
    canButcher: !!(save?.flags?.pendingButchery?.length),
    combatMode: session?.getCombatMode?.() ?? 'auto',
    manualCombat: session?.getManualCombatState?.() ?? null,
    activeSlotId: _activeSlotId,
  }
}

function respond() {
  const messages = session ? session.flush() : []
  // Persist the active slot to disk whenever the engine auto-saves
  if (session && messages.some(m => m.includes('Auto-saved'))) {
    writeSaveToDisk(_activeSlotId)
  }
  return { messages, ...getSnapshot() }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('game:init', () => {
  // Wipe any persisted slot_start save so we load a truly fresh game
  deleteSaveFromDisk('slot_start')
  DataStore.remove('saves/save_slot_start')
  DataStore.remove('saves/companions_slot_start')
  SyntheticGameData.seed()

  session = HomeScreen.createSession()
  _activeSlotId = 'slot_start'
  session.init(_activeSlotId)
  writeSaveToDisk(_activeSlotId)
  return respond()
})

ipcMain.handle('game:runEncounter',        () => { session.runEncounter();        return respond() })
ipcMain.handle('game:engageCombat',        () => { session.engageCombat();        return respond() })
ipcMain.handle('game:tryFlee',             () => { session.tryFlee();             return respond() })
ipcMain.handle('game:setCombatMode', (_, mode)    => { session.setCombatMode(mode);    return respond() })
ipcMain.handle('game:executePlayerAction', (_, actions) => { session.executePlayerAction(actions); return respond() })
ipcMain.handle('game:selectZone',  (_, z)    => { session.selectZone(z);   return respond() })
ipcMain.handle('game:renderBag',      () => { session.renderBag();      return respond() })
ipcMain.handle('game:renderStats',    () => { session.renderStats();    return respond() })
ipcMain.handle('game:renderMap',      () => { session.renderMap();      return respond() })
ipcMain.handle('game:renderShop',     () => { session.renderShop();     return respond() })
ipcMain.handle('game:buyItem',  (_, id, qty, keeperName) => { session.buyItem(id, qty, keeperName);  return respond() })
ipcMain.handle('game:sellItem', (_, id, qty) => { session.sellItem(id, qty); return respond() })
ipcMain.handle('game:renderParty',    () => { session.renderParty();    return respond() })
ipcMain.handle('game:renderCrafting', () => { session.renderCrafting(); return respond() })
ipcMain.handle('game:craftItem', (_, id)     => { session.craftItem(id);     return respond() })
ipcMain.handle('game:butcherCorpses',    () => { session.butcherCorpses();    return respond() })
ipcMain.handle('game:equipItem', (_, itemId, instanceId) => { session.equipItem(itemId, instanceId); return respond() })
ipcMain.handle('game:rezMember', (_, instanceId)        => { session.rezMember(instanceId);        return respond() })
ipcMain.handle('game:allocateStat', (_, instanceId, stat) => { session.allocateStat(instanceId, stat); return respond() })
ipcMain.handle('game:useItem',   (_, id)     => { session.useItem(id);       return respond() })
ipcMain.handle('game:back',           () => { session.back();           return respond() })
ipcMain.handle('game:getRosterData',  () => session.getRosterData())
ipcMain.handle('game:swapPartyMember', (_, outId, inId) => { session.swapPartyMember(outId, inId); return respond() })
ipcMain.handle('game:removeFromParty', (_, id)          => { session.removeFromParty(id);          return respond() })
ipcMain.handle('game:addToParty',      (_, id)          => { session.addToParty(id);               return respond() })
ipcMain.handle('game:setPetForCompanion', (_, id, petId) => { session.setPetForCompanion(id, petId); return respond() })
ipcMain.handle('game:getAvailablePets',   (_, id)        => session.getAvailablePets(id))

ipcMain.handle('game:listSaveSlots', () => listSaveSlots())

ipcMain.handle('game:saveToSlot', (_, slotId, saveName) => {
  session.manualSave(slotId)
  // Attach optional display name to the persisted record
  const raw = DataStore.read(`saves/save_${slotId}`)
  if (raw) {
    const named = saveName ? { ...raw, saveName } : raw
    DataStore.write(`saves/save_${slotId}`, named)
  }
  writeSaveToDisk(slotId)
  _activeSlotId = slotId
  return { slots: listSaveSlots(), ...respond() }
})

ipcMain.handle('game:loadFromSlot', (_, slotId) => {
  const ok = session.manualLoad(slotId)
  if (ok) {
    _activeSlotId = slotId
    // Restore companion instances for this slot before anything reads them
    const companions = DataStore.read(`saves/companions_${slotId}`) || {}
    for (const [iid, inst] of Object.entries(companions)) {
      DataStore.write(`instances/companions/${iid}`, inst)
    }
    writeSaveToDisk(slotId)
  }
  return { slots: listSaveSlots(), ...respond() }
})

ipcMain.handle('game:deleteSaveSlot', (_, slotId) => {
  if (slotId === _activeSlotId) return { error: 'Cannot delete the active save slot.' }
  DataStore.remove(`saves/save_${slotId}`)
  deleteSaveFromDisk(slotId)
  return { slots: listSaveSlots() }
})

ipcMain.handle('game:getItemCatalog', () => {
  return Object.fromEntries(
    Object.entries(_itemTemplates).filter(([k]) => !k.startsWith('_comment'))
  )
})

ipcMain.handle('game:getQuestCatalog', () => {
  return _questTemplates
})

ipcMain.handle('game:getBuffCatalog', () => {
  try {
    const raw = require('./Data/abilities.json')
    return raw.buffs || {}
  } catch (e) {
    return {}
  }
})

ipcMain.handle('game:getShopData', () => {
  if (!session) return { zoneName: '', sellMultiplier: 0.25, shopkeepers: {}, sellList: [] }
  try {
    return session.getShopData()
  } catch (err) {
    console.error('[getShopData] error:', err)
    return { zoneName: '', sellMultiplier: 0.25, shopkeepers: {}, sellList: [] }
  }
})

ipcMain.handle('game:getCraftingData', () => {
  try {
    if (!session) {
      console.log('[getCraftingData] session not initialised yet')
      return { recipes: [] }
    }

    const save = session.getSave()
    const inventory = save?.inventory || []

    // Build profession → { skill, crafterName } from live companion instances.
    // Read raw from DataStore to avoid Loader validation issues; fall back to
    // Loader if DataStore isn't global yet.
    const profMap = {}
    for (const m of (save?.party || [])) {
      let inst = null
      try {
        if (typeof DataStore !== 'undefined') {
          inst = DataStore.read(`instances/companions/${m.instanceId}`)
        }
        if (!inst) {
          const r = Loader.load(`instances/companions/${m.instanceId}`, 'companionInstance')
          if (r.ok) inst = r.data
        }
      } catch (_) { /* engine not ready */ }

      if (!inst) continue
      if (!inst.profession || inst.profession === 'none') continue
      const skill = inst.skills?.[inst.profession] || 0
      if (!profMap[inst.profession] || skill > profMap[inst.profession].skill) {
        profMap[inst.profession] = { skill, crafterName: inst.name }
      }
    }

    console.log('[getCraftingData] profMap:', JSON.stringify(profMap),
      '| recipes available:', _recipeTemplates.length,
      '| inventory size:', inventory.length)

    const recipes = _recipeTemplates
      .map(rec => {
        let skillOk = true
        let crafterName = null
        if (rec.requiredProfession) {
          const entry = profMap[rec.requiredProfession]
          if (!entry || entry.skill < (rec.minSkillLevel || 0)) {
            skillOk = false
          } else {
            crafterName = entry.crafterName
          }
        }

        const inputs = (rec.inputs || []).map(({ itemId, qty }) => {
          const entry = inventory.find(e => e.itemId === itemId)
          return { itemId, qty, have: entry?.qty ?? 0 }
        })
        const matsOk = inputs.every(i => i.have >= i.qty)

        return {
          id: rec.id,
          name: rec.name,
          requiredProfession: rec.requiredProfession || null,
          minSkillLevel: rec.minSkillLevel || 0,
          inputs,
          output: rec.output,
          skillOk,
          matsOk,
          crafterName,
        }
      })
      .filter(r => r.skillOk)

    console.log('[getCraftingData] returning', recipes.length, 'skill-unlocked recipes')
    return { recipes }
  } catch (err) {
    console.error('[getCraftingData] error:', err)
    return { recipes: [] }
  }
})

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setMenuBarVisibility(false)

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  initEngine()
  loadSavesFromDisk()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
