import React, { useState, useEffect, useRef } from 'react'
import abilitiesData from '../../../Data/abilities.json'
import classesData   from '../../../Data/classes.json'
import { skillAbilities } from './skillAbilities'

const ABILITY_DEFS = abilitiesData.abilities
const CLASS_DEFS   = classesData.classes

const PAGE_SIZE  = 12
const SLOT_KEYS  = ['1','2','3','4','5','6','7','8','9','0','-','=']
const SLOT_KEY_MAP = Object.fromEntries(SLOT_KEYS.map((k, i) => [k, i]))

// Ability targeting types that need a player-chosen friendly target
const NEEDS_FRIENDLY_TARGET = new Set(['single_ally', 'single_ally_dead'])

function pct(val, max) {
  return max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0
}

// ── Compact party card ───────────────────────────────────────────────────────

function CombatMemberCard({ inst, selected, isFriendlyTarget, showFriendlyTarget, queuedLabel, isCasting, onSetFriendlyTarget, onClick }) {
  const hp     = inst.currentHp ?? inst.maxHp ?? 0
  const maxHp  = inst.maxHp ?? 1
  const mp     = inst.currentMp ?? 0
  const maxMp  = inst.maxMp ?? 0
  const isDead = (inst.deathState ?? 'alive') !== 'alive'

  return (
    <div
      className={`combat-member-card${selected ? ' cmc-selected' : ''}${isDead ? ' dead' : ''}${isFriendlyTarget ? ' cmc-friendly-target' : ''}`}
      onClick={onClick}
    >
      <div className="cmc-header">
        <div className="cmc-avatar">{inst.classId?.[0]?.toUpperCase() ?? '?'}</div>
        <div className="cmc-info">
          <span className="cmc-name">
            {inst.name}
            {isDead && <span className="death-tag">{inst.deathState?.toUpperCase()}</span>}
          </span>
          <span className="cmc-class">{inst.classId} Lv{inst.level ?? 1}</span>
        </div>
        {showFriendlyTarget && !isDead && (
          <button
            className={`cmc-target-btn${isFriendlyTarget ? ' cmc-target-btn-on' : ''}`}
            title={isFriendlyTarget ? 'Friendly target for heals/buffs' : 'Set as friendly target'}
            onClick={e => { e.stopPropagation(); onSetFriendlyTarget?.() }}
          >♥</button>
        )}
      </div>
      {queuedLabel && <div className={`cmc-queued${isCasting ? ' cmc-casting' : ''}`}>{queuedLabel}</div>}

      <div className="cmc-bars">
        <div className="cmc-bar-row">
          <span className="cmc-bar-label">HP</span>
          <div className="bar-track cmc-track">
            <div className="bar-fill hp-bar" style={{ width: `${pct(hp, maxHp)}%` }} />
          </div>
          <span className="cmc-bar-val">{hp}/{maxHp}</span>
        </div>

        {(CLASS_DEFS[inst.classId]?.resources || []).map(res => {
          const meta = {
            mana:         { label: 'MP',    cls: 'mp-bar',      cur: mp,                       max: maxMp },
            rage:         { label: 'Rage',  cls: 'rage-bar',    cur: inst.currentRage ?? 0,    max: inst.maxRage ?? 100 },
            stamina:      { label: 'Stam',  cls: 'stamina-bar', cur: inst.currentStamina ?? 0, max: inst.maxStamina ?? 100 },
            combo_points: { label: 'Combo', cls: 'combo-bar',   cur: inst.currentCombo ?? 0,   max: inst.maxCombo ?? 5 },
          }[res]
          if (!meta || meta.max <= 0) return null
          return (
            <div key={res} className="cmc-bar-row">
              <span className="cmc-bar-label">{meta.label}</span>
              <div className="bar-track cmc-track">
                <div className={`bar-fill ${meta.cls}`} style={{ width: `${pct(meta.cur, meta.max)}%` }} />
              </div>
              <span className="cmc-bar-val">{meta.cur}/{meta.max}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Ability button ───────────────────────────────────────────────────────────

function CombatAbilityBtn({ def, learnedAt, hotkey, disabled, queued, casting, onUse }) {
  const costs = Object.entries<any>(def.resourceCost || {}).filter(([, v]) => v > 0)
  const hasCd = (def.cooldown ?? 0) > 0
  const title = casting ? `Cancel cast → ${def.name}` : (def.description ?? '')

  return (
    <button className={`cab${queued ? ' cab-queued' : ''}${casting ? ' cab-casting' : ''}`} disabled={disabled} title={title} onClick={onUse}>
      <div className="cab-header">
        <span className="cab-name">{def.name}</span>
        <div className="cab-header-right">
          {hotkey && <span className="cab-hotkey">{hotkey}</span>}
          <span className="cab-level">Lv{learnedAt}</span>
        </div>
      </div>
      {(costs.length > 0 || hasCd) && (
        <div className="cab-meta">
          {costs.map(([k, v]) => (
            <span key={k} className={`cab-cost cab-cost-${k}`}>{v} {k}</span>
          ))}
          {costs.length > 0 && hasCd && <span className="cab-sep">·</span>}
          {hasCd && <span className="cab-cd">{def.cooldown}t</span>}
        </div>
      )}
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function CombatView({
  partyInstances, gameState, loading,
  combatMode, manualCombat,
  inventory, itemCatalog,
  onEngage, onFlee, onExecuteAction,
}) {
  const [selectedIdx, setSelectedIdx]         = useState(0)
  const [selectedTargetIdx, setSelectedTargetIdx] = useState(0)
  const [friendlyTargetIdx, setFriendlyTargetIdx] = useState(0)
  const [pendingActions, setPendingActions]   = useState<Record<string, any>>({})
  const [abilityPage, setAbilityPage]         = useState(0)

  // Reset pending queue when combat state changes
  useEffect(() => { setPendingActions({}) }, [gameState])
  // Reset page when character selection changes
  useEffect(() => { setAbilityPage(0) }, [selectedIdx])

  const isPending     = gameState === 'combat_pending'
  const isInCombat    = gameState === 'in_combat'
  const isStreamlined = combatMode === 'streamlined'
  const isFullManual  = combatMode === 'full_manual'
  const isManualMode  = isStreamlined || isFullManual
  const disabled      = loading

  const selectedInst       = partyInstances[Math.min(selectedIdx, partyInstances.length - 1)]
  const selectedManualUnit = manualCombat?.partyUnits?.find(u => u.id === selectedInst?.instanceId)
  const friendlyInst       = partyInstances[Math.min(friendlyTargetIdx, partyInstances.length - 1)]

  const memberAbilities = (() => {
    if (!selectedInst) return []
    // Abilities come from the character's skills (Galanova model), not class level.
    return skillAbilities(selectedInst)
      .map(e => ({ entry: e, def: ABILITY_DEFS[e.id] }))
      .filter(({ def }) => {
        if (!def || def.passive) return false
        if (def.tags?.includes('ranged') && selectedManualUnit && !selectedManualUnit.rangedReady) return false
        return true
      })
  })()

  const totalPages   = Math.max(1, Math.ceil(memberAbilities.length / PAGE_SIZE))
  const currentPage  = Math.min(abilityPage, totalPages - 1)
  const pageAbilities = memberAbilities.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  const liveEnemies  = manualCombat?.enemyUnits?.filter(e => e.alive) || []
  const targetEnemy  = liveEnemies[Math.min(selectedTargetIdx, liveEnemies.length - 1)]

  const handleUseAbility = (abilityId) => {
    if (!isInCombat || !isManualMode || !selectedManualUnit || !selectedManualUnit.alive) return
    const def = ABILITY_DEFS[abilityId]
    const useFriendly = NEEDS_FRIENDLY_TARGET.has(def?.targeting)
    const targetId = useFriendly ? friendlyInst?.instanceId : targetEnemy?.id
    if (!targetId) return
    if (isStreamlined) {
      onExecuteAction([{ actorId: selectedManualUnit.id, abilityId, targetId }])
    } else {
      setPendingActions(prev => ({ ...prev, [selectedManualUnit.id]: { abilityId, targetId } }))
    }
  }

  const handleUseItem = (itemId) => {
    if (!isInCombat || !isManualMode || !selectedManualUnit || !selectedManualUnit.alive) return
    const action = { actorId: selectedManualUnit.id, type: 'use_item', itemId }
    if (isStreamlined) {
      onExecuteAction([action])
    } else {
      setPendingActions(prev => ({ ...prev, [selectedManualUnit.id]: action }))
    }
  }

  const handleConfirmTurn = () => {
    if (!isInCombat || !isFullManual || disabled) return
    const actions = Object.entries(pendingActions).map(([actorId, a]) => ({ actorId, ...a }))
    setPendingActions({})
    onExecuteAction(actions)
  }

  // ── Keyboard handler (slot keys + page nav) ──────────────────────────────
  // Use a ref so the single registered listener always reads current values.
  const kbRef = useRef<any>(null)
  kbRef.current = { pageAbilities, currentPage, totalPages, handleUseAbility }

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      const { pageAbilities, currentPage, totalPages, handleUseAbility } = kbRef.current

      if (e.key === 'ArrowLeft') {
        if (currentPage > 0) { e.preventDefault(); setAbilityPage(p => p - 1) }
        return
      }
      if (e.key === 'ArrowRight') {
        if (currentPage < totalPages - 1) { e.preventDefault(); setAbilityPage(p => p + 1) }
        return
      }
      const slotIdx = SLOT_KEY_MAP[e.key]
      if (slotIdx == null) return
      const ability = pageAbilities[slotIdx]
      if (!ability) return
      e.preventDefault()
      handleUseAbility(ability.entry.id)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const enemyUnits       = manualCombat?.enemyUnits || []
  const showRealEnemies  = isInCombat && enemyUnits.length > 0
  const livePartyUnits     = manualCombat?.partyUnits?.filter(u => u.alive) || []
  const liveNonPetUnits    = livePartyUnits.filter(u => !u.isPet)
  const allActionsQueued   = isFullManual && liveNonPetUnits.length > 0 &&
    liveNonPetUnits.every(u => pendingActions[u.id] || (u.castQueue?.length > 0))
  const petUnits           = manualCombat?.partyUnits?.filter(u => u.isPet) || []

  // True when the selected character has a pending cast and hasn't been overridden yet
  const selectedIsCasting = !!(
    selectedManualUnit?.castQueue?.length > 0 && !pendingActions[selectedManualUnit?.id]
  )

  return (
    <div className="combat-view">

      {/* ── Enemy area ── */}
      <div className="combat-enemies">
        <div className="combat-section-label">
          {isPending ? '⚠ Encounter Approaching' : isInCombat ? `Enemies — Turn ${manualCombat?.turn ?? '?'}` : 'Enemies'}
        </div>
        {isPending ? (
          <div className="combat-enemy-placeholder">
            {isManualMode ? 'Select abilities below, then act or confirm.' : 'Autobattle — combat resolves automatically.'}
          </div>
        ) : showRealEnemies ? (
          <div className="combat-enemy-row">
            {enemyUnits.map((enemy, i) => (
              <div
                key={enemy.id}
                className={`combat-enemy-slot${!enemy.alive ? ' dead' : ''}${isManualMode && selectedTargetIdx === i ? ' ces-targeted' : ''}`}
                onClick={() => isManualMode && enemy.alive && setSelectedTargetIdx(i)}
              >
                <span className="ces-name">{enemy.name}{!enemy.alive ? ' ✕' : ''}</span>
                <div className="bar-track ces-track">
                  <div className="bar-fill hp-bar" style={{ width: `${pct(enemy.hp, enemy.maxHp)}%` }} />
                </div>
                <span className="ces-val">{enemy.hp}/{enemy.maxHp}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="combat-enemy-placeholder">No encounter in progress.</div>
        )}
      </div>

      {/* ── Party row ── */}
      <div className="combat-party">
        <div className="combat-section-label">Party — select to view abilities</div>
        <div className="combat-party-cards">
          {partyInstances.map((inst, i) => {
            const liveUnit = manualCombat?.partyUnits?.find(u => u.id === inst.instanceId)
            const liveInst = liveUnit ? {
              ...inst,
              currentHp:     liveUnit.hp,
              maxHp:         liveUnit.maxHp,
              currentMp:     liveUnit.resources?.mana?.current ?? inst.currentMp,
              currentRage:   liveUnit.resources?.rage?.current ?? 0,
              maxRage:       liveUnit.resources?.rage?.max ?? 100,
              currentStamina: liveUnit.resources?.stamina?.current ?? 0,
              maxStamina:     liveUnit.resources?.stamina?.max ?? 100,
              currentCombo:   liveUnit.resources?.combo_points?.current ?? 0,
              maxCombo:       liveUnit.resources?.combo_points?.max ?? 5,
            } : inst
            const queued = liveUnit ? pendingActions[liveUnit.id] : null
            const castEntry = liveUnit?.castQueue?.[0]
            const queuedLabel = queued
              ? (queued.cancel
                  ? 'Cancelling cast…'
                  : queued.type === 'use_item'
                    ? (itemCatalog?.[queued.itemId]?.name || queued.itemId)
                    : (ABILITY_DEFS[queued.abilityId]?.name ?? null))
              : castEntry
                ? `Casting: ${ABILITY_DEFS[castEntry.abilityId]?.name ?? castEntry.abilityId}`
                : null
            const isCasting = !queued && !!castEntry
            return (
              <CombatMemberCard
                key={inst.instanceId}
                inst={liveInst}
                selected={selectedIdx === i}
                isFriendlyTarget={isInCombat && isManualMode && friendlyTargetIdx === i}
                showFriendlyTarget={isInCombat && isManualMode}
                queuedLabel={queuedLabel}
                isCasting={isCasting}
                onSetFriendlyTarget={() => setFriendlyTargetIdx(i)}
                onClick={() => setSelectedIdx(i)}
              />
            )
          })}
          {petUnits.map(pet => (
            <div key={pet.id} className={`combat-pet-card${!pet.alive ? ' dead' : ''}`}>
              <div className="cmc-header">
                <div className="cmc-avatar cmc-avatar-pet">{pet.name?.[0] ?? 'P'}</div>
                <div className="cmc-info">
                  <span className="cmc-name">
                    {pet.name}
                    {!pet.alive && <span className="death-tag">FALLEN</span>}
                  </span>
                  <span className="cmc-class pet-type-label">{pet.classId} · Pet</span>
                </div>
              </div>
              <div className="cmc-queued cmc-casting">AI</div>
              <div className="cmc-bars">
                <div className="cmc-bar-row">
                  <span className="cmc-bar-label">HP</span>
                  <div className="bar-track cmc-track">
                    <div className="bar-fill hp-bar" style={{ width: `${pct(pet.hp, pet.maxHp)}%` }} />
                  </div>
                  <span className="cmc-bar-val">{pet.hp}/{pet.maxHp}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Abilities / actions ── */}
      <div className="combat-abilities">
        {isPending ? (
          <div className="combat-engage-area">
            <span className="combat-engage-label">⚔ Choose your action</span>
            <div className="combat-engage-btns">
              <button className="btn btn-danger" onClick={onEngage} disabled={disabled}>⚔ Engage</button>
              <button className="btn btn-secondary" onClick={onFlee} disabled={disabled}>Run</button>
            </div>
          </div>
        ) : (
          <>
            {isFullManual && isInCombat && (
              <div className="combat-queue-bar">
                <span className="combat-queue-label">
                  {liveNonPetUnits.filter(u => pendingActions[u.id] || u.castQueue?.length > 0).length}/{liveNonPetUnits.length} queued
                </span>
                {selectedIsCasting && (
                  <button
                    className="btn btn-secondary combat-cancel-cast-btn"
                    onClick={() => setPendingActions(prev => ({
                      ...prev,
                      [selectedManualUnit.id]: { cancel: true },
                    }))}
                    disabled={disabled}
                  >
                    Cancel Cast
                  </button>
                )}
                <button
                  className="btn btn-danger combat-confirm-btn"
                  onClick={handleConfirmTurn}
                  disabled={disabled || !allActionsQueued}
                >
                  Confirm Turn
                </button>
              </div>
            )}

            {/* Page nav — always visible when more than one page */}
            {totalPages > 1 && (
              <div className="combat-ability-pager">
                <button
                  className="cab-page-btn"
                  disabled={currentPage === 0}
                  onClick={() => setAbilityPage(p => p - 1)}
                >◄</button>
                <span className="cab-page-label">
                  {selectedInst?.name} · Page {currentPage + 1} / {totalPages}
                </span>
                <button
                  className="cab-page-btn"
                  disabled={currentPage === totalPages - 1}
                  onClick={() => setAbilityPage(p => p + 1)}
                >►</button>
              </div>
            )}

            <div className="combat-ability-grid">
              {pageAbilities.map(({ entry, def }, i) => {
                const isQueued = isFullManual && selectedManualUnit &&
                  pendingActions[selectedManualUnit.id]?.abilityId === entry.id
                return (
                  <CombatAbilityBtn
                    key={entry.id}
                    def={def}
                    learnedAt={entry.level}
                    hotkey={SLOT_KEYS[i]}
                    queued={isQueued}
                    casting={selectedIsCasting && !isQueued}
                    disabled={disabled || !isInCombat || !isManualMode}
                    onUse={() => handleUseAbility(entry.id)}
                  />
                )
              })}
              {pageAbilities.length === 0 && (
                <div className="combat-no-abilities">No active abilities unlocked.</div>
              )}
            </div>

            {(() => {
              const usable = (inventory || []).filter(e => {
                const def = itemCatalog?.[e.itemId]
                return def?.onUse && !def.onUse.outOfCombatOnly && e.qty > 0
              })
              if (!usable.length || !isInCombat || !isManualMode) return null
              return (
                <div className="combat-item-row">
                  {usable.map(e => {
                    const def = itemCatalog[e.itemId]
                    const isQueued = isFullManual && selectedManualUnit &&
                      pendingActions[selectedManualUnit.id]?.type === 'use_item' &&
                      pendingActions[selectedManualUnit.id]?.itemId === e.itemId
                    return (
                      <button
                        key={e.itemId}
                        className={`btn cab combat-item-btn${isQueued ? ' cab-queued' : ''}`}
                        disabled={disabled || !selectedManualUnit}
                        title={def?.description ?? def?.name ?? e.itemId}
                        onClick={() => handleUseItem(e.itemId)}
                      >
                        <span className="cab-name">{def?.name || e.itemId}</span>
                        <span className="cab-level">×{e.qty}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })()}
          </>
        )}
      </div>

    </div>
  )
}
