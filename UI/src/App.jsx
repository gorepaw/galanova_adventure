import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import CombatLog from './components/CombatLog.jsx'
import CombatView from './components/CombatView.jsx'
import AbilityBar from './components/AbilityBar.jsx'
import DungeonMap from './components/DungeonMap.jsx'
import InventoryPanel from './components/InventoryPanel.jsx'
import CraftingPanel from './components/CraftingPanel.jsx'
import CharacterScreen from './components/CharacterScreen.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import ShopPanel from './components/ShopPanel.jsx'
import ReputationPanel from './components/ReputationPanel.jsx'
import SkillsPanel from './components/SkillsPanel.jsx'
import ProfessionsPanel from './components/ProfessionsPanel.jsx'
import GuildhallPanel from './components/GuildhallPanel.jsx'
import SaveLoadPanel from './components/SaveLoadPanel.jsx'
import QuestsPanel from './components/QuestsPanel.jsx'
import CollectionsPanel from './components/CollectionsPanel.jsx'
import AchievementsPanel from './components/AchievementsPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import useHotkeys from './hooks/useHotkeys.js'
import { normalizeKey, formatKeyLabel } from './hotkeys.js'

const api = window.gameAPI

function formatCurrency(copper) {
  if (!copper) return '0c'
  const g = Math.floor(copper / 10000)
  const s = Math.floor((copper % 10000) / 100)
  const c = copper % 100
  const parts = []
  if (g > 0) parts.push(`${g}g`)
  if (s > 0) parts.push(`${s}s`)
  if (c > 0 || parts.length === 0) parts.push(`${c}c`)
  return parts.join(' ')
}

export default function App() {
  const [gameState, setGameState]         = useState(null)
  const [save, setSave]                   = useState(null)
  const [partyInstances, setPartyInstances] = useState([])
  const [zoneData, setZoneData]           = useState(null)
  const [travelZones, setTravelZones] = useState([])
  const [canButcher, setCanButcher]             = useState(false)
  const [log, setLog]                     = useState([])
  const [activeTab, setActiveTab]         = useState(null)
  const [loading, setLoading]             = useState(false)
  const [combatMode, setCombatMode]       = useState('auto')
  const [manualCombat, setManualCombat]   = useState(null)
  const [craftingRecipes, setCraftingRecipes] = useState([])
  const [shopData, setShopData]           = useState(null)
  const [itemCatalog, setItemCatalog]     = useState({})
  const [buffCatalog, setBuffCatalog]     = useState({})
  const [questCatalog, setQuestCatalog]   = useState({})
  const [entityCatalog, setEntityCatalog] = useState(null)
  const [rosterData, setRosterData]       = useState([])
  const [saveSlots, setSaveSlots]         = useState([])
  const [activeSlotId, setActiveSlotId]   = useState('slot_start')
  const { bindings, keyMap, updateBinding, resetBinding, resetAll } = useHotkeys()
  const [autoRun, setAutoRun]         = useState(false)
  const [autoEngage, setAutoEngage]   = useState(false)
  const [autoFlee, setAutoFlee]       = useState(false)
  const activeTabRef              = useRef(null)
  const prevGameStateRef          = useRef(null)
  const autoRunTimerRef           = useRef(null)
  const combatResponseTimerRef    = useRef(null)
  const justRanAutoEncounterRef   = useRef(false)
  const prevLoadingRef            = useRef(false)

  const applyResult = useCallback((result) => {
    if (result.messages?.length) setLog(prev => [...prev, ...result.messages])
    setGameState(result.state)
    setSave(result.save)
    setPartyInstances(result.partyInstances || [])
    setZoneData(result.zoneData)
    setTravelZones(result.travelZones || [])
    setCanButcher(result.canButcher || false)
    if (result.combatMode !== undefined) setCombatMode(result.combatMode)
    setManualCombat(result.manualCombat ?? null)
    if (result.activeSlotId) setActiveSlotId(result.activeSlotId)
    if (result.slots)        setSaveSlots(result.slots)
  }, [])

  const fetchCraftingData = useCallback(async () => {
    try {
      const result = await api.getCraftingData()
      setCraftingRecipes(result?.recipes || [])
    } catch (err) {
      console.error('[fetchCraftingData]', err)
      setCraftingRecipes([])
    }
  }, [])

  const fetchShopData = useCallback(async () => {
    try {
      const result = await api.getShopData()
      setShopData(result || null)
    } catch (err) {
      console.error('[fetchShopData]', err)
      setShopData(null)
    }
  }, [])

  const dispatch = useCallback(async (apiCall) => {
    setLoading(true)
    try {
      const result = await apiCall()
      applyResult(result)
      if (activeTabRef.current === 'crafting') fetchCraftingData()
    } finally {
      setLoading(false)
    }
  }, [applyResult, fetchCraftingData])

  useEffect(() => {
    dispatch(() => api.init())
    api.getItemCatalog().then(c => setItemCatalog(c || {})).catch(() => {})
    api.getBuffCatalog().then(c => setBuffCatalog(c || {})).catch(() => {})
    api.getQuestCatalog().then(c => setQuestCatalog(c || {})).catch(() => {})
    api.getEntityCatalog?.().then(c => setEntityCatalog(c || {})).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-run: fire a new encounter 1.5 s after the previous one resolves
  useEffect(() => {
    const prev = prevGameStateRef.current
    prevGameStateRef.current = gameState

    if (autoRunTimerRef.current) { clearTimeout(autoRunTimerRef.current); autoRunTimerRef.current = null }

    const shouldFire = autoRun && !loading && gameState === 'home'
      && prev !== null && prev !== 'home'
      && zoneData?.type !== 'shop'

    if (!shouldFire) return

    autoRunTimerRef.current = setTimeout(() => {
      autoRunTimerRef.current = null
      justRanAutoEncounterRef.current = true
      handleAction('runEncounter')
      setActiveTab(null)
      activeTabRef.current = null
    }, 1500)

    return () => { if (autoRunTimerRef.current) { clearTimeout(autoRunTimerRef.current); autoRunTimerRef.current = null } }
  }, [gameState, autoRun]) // eslint-disable-line react-hooks/exhaustive-deps

  // Non-combat encounter auto-repeat: when loading finishes and state is still 'home',
  // the encounter resolved without a state transition (gathering node, etc.) —
  // the state-based effect above won't fire, so we schedule here instead.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = loading
    if (!wasLoading || loading || !justRanAutoEncounterRef.current) return
    // Always clear the flag — either path clears it
    justRanAutoEncounterRef.current = false
    // If state left 'home', it's a combat encounter — state effect handles rescheduling
    if (gameState !== 'home' || !autoRun || zoneData?.type === 'shop') return
    // Non-combat: schedule the next encounter
    autoRunTimerRef.current = setTimeout(() => {
      autoRunTimerRef.current = null
      justRanAutoEncounterRef.current = true
      handleAction('runEncounter')
      setActiveTab(null)
      activeTabRef.current = null
    }, 1500)
    return () => { if (autoRunTimerRef.current) { clearTimeout(autoRunTimerRef.current); autoRunTimerRef.current = null } }
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-Engage / Auto-Run: respond to combat_pending automatically after ~1 s
  useEffect(() => {
    if (combatResponseTimerRef.current) { clearTimeout(combatResponseTimerRef.current); combatResponseTimerRef.current = null }
    if (gameState !== 'combat_pending' || (!autoEngage && !autoFlee)) return
    combatResponseTimerRef.current = setTimeout(() => {
      combatResponseTimerRef.current = null
      if (autoEngage) { handleAction('engageCombat'); setActiveTab(null); activeTabRef.current = null }
      else if (autoFlee) { handleAction('tryFlee'); setActiveTab(null); activeTabRef.current = null }
    }, 1000)
    return () => { if (combatResponseTimerRef.current) { clearTimeout(combatResponseTimerRef.current); combatResponseTimerRef.current = null } }
  }, [gameState, autoEngage, autoFlee]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchRosterData = useCallback(async () => {
    try {
      const result = await api.getRosterData()
      setRosterData(result || [])
    } catch (err) {
      console.error('[fetchRosterData]', err)
      setRosterData([])
    }
  }, [])

  const handleTab = useCallback((tab) => {
    setActiveTab(tab)
    activeTabRef.current = tab
    if (tab === 'crafting') fetchCraftingData()
    if (tab === 'shops')    fetchShopData()
    if (tab === 'guildhall' || tab === 'professions') fetchRosterData()
    if (tab === 'save_load') fetchSaveSlots()
  }, [fetchCraftingData, fetchShopData, fetchRosterData]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = useCallback((action, ...args) => {
    dispatch(() => api[action](...args))
  }, [dispatch])

  const handleToggleAutoEngage = useCallback(() => {
    setAutoEngage(v => { const next = !v; if (next) setAutoFlee(false); return next })
  }, [])

  const handleToggleAutoFlee = useCallback(() => {
    setAutoFlee(v => { const next = !v; if (next) setAutoEngage(false); return next })
  }, [])

  const handleSetCombatMode = useCallback((mode) => {
    dispatch(() => api.setCombatMode(mode))
  }, [dispatch])

  const handleExecuteAction = useCallback((actions) => {
    dispatch(() => api.executePlayerAction(actions))
  }, [dispatch])

  const handleCraft = useCallback(async (recipeId) => {
    await dispatch(() => api.craftItem(recipeId))
    fetchCraftingData()
  }, [dispatch, fetchCraftingData])

  const handleBuy = useCallback(async (itemId, qty, keeperName) => {
    await dispatch(() => api.buyItem(itemId, qty, keeperName))
    fetchShopData()
  }, [dispatch, fetchShopData])

  const handleSell = useCallback(async (itemId, qty) => {
    await dispatch(() => api.sellItem(itemId, qty))
    fetchShopData()
  }, [dispatch, fetchShopData])

  const handleEquip = useCallback((itemId, instanceId) => {
    dispatch(() => api.equipItem(itemId, instanceId ?? null))
  }, [dispatch])

  const handleSwapPartyMember = useCallback(async (outId, inId) => {
    await dispatch(() => api.swapPartyMember(outId, inId))
    fetchRosterData()
  }, [dispatch, fetchRosterData])

  const handleRemoveFromParty = useCallback(async (instanceId) => {
    await dispatch(() => api.removeFromParty(instanceId))
    fetchRosterData()
  }, [dispatch, fetchRosterData])

  const handleAddToParty = useCallback(async (instanceId) => {
    await dispatch(() => api.addToParty(instanceId))
    fetchRosterData()
  }, [dispatch, fetchRosterData])

  const fetchSaveSlots = useCallback(async () => {
    try {
      const slots = await api.listSaveSlots()
      setSaveSlots(slots || [])
    } catch (err) { console.error('[fetchSaveSlots]', err) }
  }, [])

  const handleSaveToSlot = useCallback(async (slotId, saveName) => {
    setLoading(true)
    try {
      const result = await api.saveToSlot(slotId, saveName)
      applyResult(result)
    } finally { setLoading(false) }
  }, [applyResult])

  const handleLoadFromSlot = useCallback(async (slotId) => {
    setLoading(true)
    try {
      const result = await api.loadFromSlot(slotId)
      applyResult(result)
      setLog([])
      if (result.messages?.length) setLog(result.messages)
    } finally { setLoading(false) }
  }, [applyResult])

  const handleDeleteSaveSlot = useCallback(async (slotId) => {
    try {
      const result = await api.deleteSaveSlot(slotId)
      if (result.slots) setSaveSlots(result.slots)
    } catch (err) { console.error('[handleDeleteSaveSlot]', err) }
  }, [])

  const handleNewGame = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.init()
      applyResult(result)
      setLog(result.messages || [])
      setActiveTab('log')
      activeTabRef.current = 'log'
    } finally { setLoading(false) }
  }, [applyResult])

  const handleSelectZone = useCallback((zoneId) => {
    setShopData(null)
    dispatch(() => api.selectZone(zoneId))
    setActiveTab('log')
    activeTabRef.current = 'log'
  }, [dispatch])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Hotkey action map ─────────────────────────────────────────────────────
  const actionMap = useMemo(() => ({
    tab_log:          () => handleTab('log'),
    tab_quests:       () => handleTab('quests'),
    tab_combat:       () => handleTab('combat'),
    tab_bag:          () => handleTab('bag'),
    tab_zones:        () => handleTab('zones'),
    tab_shops:        () => handleTab('shops'),
    tab_dungeons:     () => handleTab('dungeons'),
    tab_character:    () => handleTab('character'),
    tab_crafting:     () => handleTab('crafting'),
    tab_reputation:   () => handleTab('reputation'),
    tab_skills:       () => handleTab('skills'),
    tab_professions:  () => handleTab('professions'),
    tab_guildhall:    () => handleTab('guildhall'),
    tab_collections:  () => handleTab('collections'),
    tab_achievements: () => handleTab('achievements'),
    tab_save_load:    () => handleTab('save_load'),
    tab_settings:     () => handleTab('settings'),
    run_encounter:    () => { handleAction('runEncounter'); setActiveTab(null); activeTabRef.current = null },
    engage_combat:    () => { handleAction('engageCombat'); setActiveTab(null); activeTabRef.current = null },
    try_flee:         () => { handleAction('tryFlee');      setActiveTab(null); activeTabRef.current = null },
  }), [handleTab, handleAction]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (loading) return
      const key = normalizeKey(e)
      if (!key) return
      const actionId = keyMap[key]
      if (!actionId) return
      const fn = actionMap[actionId]
      if (!fn) return
      e.preventDefault()
      fn()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [keyMap, actionMap, loading])

  const isShopZone  = zoneData?.type === 'shop'
  const isDungeon   = zoneData?.type === 'dungeon'
  const CONTENT_TABS = ['log', 'quests', 'bag', 'zones', 'shops', 'dungeons', 'crafting', 'character', 'reputation', 'skills', 'professions', 'guildhall', 'collections', 'achievements', 'save_load', 'settings']
  const zoneName = zoneData?.name ?? save?.currentZone?.replace(/_/g, ' ') ?? '—'
  const highestPartyLevel = partyInstances.reduce((max, inst) => Math.max(max, inst.level || 1), 1)

  const TABS = [
    { id: 'log',          label: 'Log' },
    { id: 'quests',       label: 'Quests' },
    { id: 'combat',       label: 'Combat' },
    { id: 'bag',          label: 'Bag' },
    { id: 'zones',        label: 'Zones' },
    { id: 'shops',        label: 'Shops' },
    { id: 'dungeons',     label: 'Dungeons' },
    { id: 'character',    label: 'Character' },
    { id: 'crafting',     label: 'Craft' },
    { id: 'reputation',   label: 'Reputation' },
    { id: 'skills',       label: 'Skills' },
    { id: 'professions',  label: 'Professions' },
    { id: 'guildhall',    label: 'Guildhall' },
    { id: 'collections',  label: 'Collections' },
    { id: 'achievements', label: 'Achievements' },
    { id: 'save_load',    label: 'Save / Load' },
    { id: 'settings',     label: 'Settings' },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-logo">Galanova Adventure</div>
        {save && (
          <div className="header-meta">
            <span className="header-zone">{zoneName}</span>
            <span className={`header-zone-type type-${zoneData?.type ?? 'combat'}`}>
              {(zoneData?.type ?? '').toUpperCase()}
            </span>
            <span className="header-currency">{formatCurrency(save.currency)}</span>
            <span className={`header-mode mode-${save.mode ?? 'normal'}`}>
              {(save.mode ?? 'normal').toUpperCase()}
            </span>
          </div>
        )}
        {loading && <div className="loading-indicator">●</div>}
      </header>

      <div className="app-body">
        <aside className="right-panel">
          <nav className="tab-bar">
            {TABS.map(t => {
              const hk = formatKeyLabel(bindings[`tab_${t.id}`])
              return (
                <button
                  key={t.id}
                  className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
                  onClick={() => handleTab(t.id)}
                >
                  <span className="tab-btn-label">{t.label}</span>
                  {hk && <span className="tab-hk">{hk}</span>}
                </button>
              )
            })}
          </nav>
          <AbilityBar
            gameState={gameState}
            loading={loading}
            canButcher={canButcher}
            autoRun={autoRun}
            autoEngage={autoEngage}
            autoFlee={autoFlee}
            bindings={bindings}
            formatKeyLabel={formatKeyLabel}
            onRunEncounter={() => { handleAction('runEncounter'); setActiveTab(null); activeTabRef.current = null }}
            onEngage={() => { handleAction('engageCombat'); setActiveTab(null); activeTabRef.current = null }}
            onFlee={() => { handleAction('tryFlee'); setActiveTab(null); activeTabRef.current = null }}
            onButcher={() => { handleAction('butcherCorpses'); setActiveTab(null); activeTabRef.current = null }}
            onToggleAutoRun={() => setAutoRun(v => !v)}
            onToggleAutoEngage={handleToggleAutoEngage}
            onToggleAutoFlee={handleToggleAutoFlee}
          />
        </aside>

        <main className="main-area">
          {!CONTENT_TABS.includes(activeTab) ? (
            <ErrorBoundary key="combat" label="Combat view"><CombatView
              partyInstances={partyInstances}
              gameState={gameState}
              loading={loading}
              combatMode={combatMode}
              manualCombat={manualCombat}
              inventory={save?.inventory ?? []}
              itemCatalog={itemCatalog}
              onEngage={() => { handleAction('engageCombat'); setActiveTab(null); activeTabRef.current = null }}
              onFlee={() => { handleAction('tryFlee'); setActiveTab(null); activeTabRef.current = null }}
              onExecuteAction={handleExecuteAction}
            /></ErrorBoundary>
          ) : (
            <div className="tab-content">
              <ErrorBoundary key={activeTab} label="This panel">
              {activeTab === 'log' && (
                <CombatLog messages={log} itemCatalog={itemCatalog} entityCatalog={entityCatalog} partyInstances={partyInstances} />
              )}
              {activeTab === 'quests' && (
                <QuestsPanel quests={save?.quests ?? {}} questCatalog={questCatalog} />
              )}
              {activeTab === 'bag' && (
                <InventoryPanel
                  inventory={save?.inventory ?? []}
                  currency={save?.currency ?? 0}
                  isShopZone={isShopZone}
                  itemCatalog={itemCatalog}
                  onUse={(id) => handleAction('useItem', id)}
                  onSell={(id) => handleAction('sellItem', id, 1)}
                  onEquip={handleEquip}
                />
              )}
              {activeTab === 'zones' && (
                <DungeonMap
                  currentZone={save?.currentZone}
                  zoneData={zoneData}
                  travelZones={travelZones}
                  onSelectZone={handleSelectZone}
                  filterTypes={['combat']}
                  showCurrent={true}
                />
              )}
              {activeTab === 'shops' && (
                <div className="shops-tab">
                  {isShopZone && shopData ? (
                    <ShopPanel
                      shopData={shopData}
                      currency={save?.currency ?? 0}
                      itemCatalog={itemCatalog}
                      onBuy={handleBuy}
                      onSell={handleSell}
                      loading={loading}
                    />
                  ) : isShopZone ? (
                    <div className="panel-empty">Loading shop…</div>
                  ) : null}
                  <DungeonMap
                    currentZone={save?.currentZone}
                    zoneData={zoneData}
                    travelZones={travelZones}
                    onSelectZone={handleSelectZone}
                    filterTypes={['shop']}
                    showCurrent={isShopZone}
                  />
                </div>
              )}
              {activeTab === 'dungeons' && (
                <DungeonMap
                  currentZone={save?.currentZone}
                  zoneData={zoneData}
                  travelZones={travelZones}
                  onSelectZone={handleSelectZone}
                  filterTypes={['dungeon']}
                  showCurrent={isDungeon}
                />
              )}
              {activeTab === 'crafting' && (
                <CraftingPanel
                  recipes={craftingRecipes}
                  itemCatalog={itemCatalog}
                  onCraft={handleCraft}
                  loading={loading}
                />
              )}
              {activeTab === 'character' && (
                <CharacterScreen partyInstances={partyInstances} itemCatalog={itemCatalog} buffCatalog={buffCatalog} inventory={save?.inventory ?? []} onEquip={handleEquip} currency={save?.currency ?? 0} onRez={(instanceId) => handleAction('rezMember', instanceId)} onAllocate={(instanceId, stat) => handleAction('allocateStat', instanceId, stat)} />
              )}
              {activeTab === 'reputation' && (
                <ReputationPanel reputation={save?.reputation ?? {}} />
              )}
              {activeTab === 'skills' && (
                <SkillsPanel partyInstances={partyInstances} />
              )}
              {activeTab === 'professions' && (
                <ProfessionsPanel companions={rosterData} />
              )}
              {activeTab === 'guildhall' && (
                <GuildhallPanel
                  roster={rosterData}
                  onSwap={handleSwapPartyMember}
                  onBench={handleRemoveFromParty}
                  onRecruit={handleAddToParty}
                  loading={loading}
                  gameState={gameState}
                />
              )}
              {activeTab === 'collections' && (
                <CollectionsPanel
                  collections={save?.collections ?? {}}
                  itemCatalog={itemCatalog}
                />
              )}
              {activeTab === 'achievements' && (
                <AchievementsPanel
                  achievements={save?.achievements ?? {}}
                  collections={save?.collections ?? {}}
                />
              )}
              {activeTab === 'save_load' && (
                <SaveLoadPanel
                  slots={saveSlots}
                  activeSlotId={activeSlotId}
                  loading={loading}
                  onSaveToSlot={handleSaveToSlot}
                  onLoadFromSlot={handleLoadFromSlot}
                  onDeleteSlot={handleDeleteSaveSlot}
                  onNewGame={handleNewGame}
                />
              )}
              {activeTab === 'settings' && (
                <SettingsPanel
                  combatMode={combatMode}
                  onSetCombatMode={handleSetCombatMode}
                  loading={loading}
                  gameState={gameState}
                  bindings={bindings}
                  keyMap={keyMap}
                  onUpdateBinding={updateBinding}
                  onResetBinding={resetBinding}
                  onResetAll={resetAll}
                />
              )}
              </ErrorBoundary>
            </div>
          )}
        </main>

        <aside className="log-column">
          <CombatLog messages={log} itemCatalog={itemCatalog} entityCatalog={entityCatalog} partyInstances={partyInstances} />
        </aside>
      </div>
    </div>
  )
}
