import React, { useState, useEffect } from 'react'
import { HOTKEY_DEFS, HOTKEY_CATEGORIES, normalizeKey, formatKeyLabel } from '../hotkeys'

export default function SettingsPanel({
  combatMode, onSetCombatMode, loading, gameState,
  bindings, keyMap, onUpdateBinding, onResetBinding, onResetAll,
}: any) {
  const [capturing, setCapturing] = useState<any>(null)   // actionId currently being rebound
  const [conflict,  setConflict]  = useState<any>(null)   // { key, conflictId }

  // Capture mode: listen at the capture phase so we can preventDefault and
  // stopPropagation before the main App hotkey listener sees the key.
  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setCapturing(null); setConflict(null); return }
      const key = normalizeKey(e)
      if (!key) return
      const conflictId = keyMap[key]
      if (conflictId && conflictId !== capturing) {
        setConflict({ key, conflictId })
        return
      }
      onUpdateBinding(capturing, key)
      setCapturing(null)
      setConflict(null)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [capturing, keyMap, onUpdateBinding])

  const startCapture = (actionId: string) => { setConflict(null); setCapturing(actionId) }

  return (
    <div className="settings-panel">

      {/* ── Combat mode ───────────────────────────────────────────────────────── */}
      <div className="settings-section-label">Combat</div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-title">Combat Mode</span>
          <span className="settings-row-desc">
            {combatMode === 'auto'
              ? 'Autobattle resolves each encounter automatically.'
              : combatMode === 'streamlined'
              ? 'Streamlined: pick one ability per turn, party acts on their own.'
              : 'Full Manual: you direct every party member each turn.'}
          </span>
        </div>
        <div className="settings-mode-group" aria-disabled={loading || gameState === 'in_combat'}>
          {[
            { id: 'auto',        label: 'Auto' },
            { id: 'streamlined', label: 'Streamlined' },
            { id: 'full_manual', label: 'Full Manual' },
          ].map(m => (
            <button
              key={m.id}
              className={`settings-mode-btn${combatMode === m.id ? ' active' : ''}`}
              onClick={() => onSetCombatMode(m.id)}
              disabled={loading || gameState === 'in_combat'}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Keybindings ───────────────────────────────────────────────────────── */}
      <div className="settings-section-label hk-section-header">
        Keybindings
        <button className="hk-reset-all" onClick={onResetAll}>Reset All</button>
      </div>

      {conflict && (
        <div className="hk-conflict">
          <span>
            <b>{formatKeyLabel(conflict.key)}</b> is already bound to <b>{HOTKEY_DEFS[conflict.conflictId]?.label}</b>.
          </span>
          <div className="hk-conflict-btns">
            <button className="hk-btn" onClick={() => {
              onResetBinding(conflict.conflictId)
              onUpdateBinding(capturing, conflict.key)
              setCapturing(null)
              setConflict(null)
            }}>Override</button>
            <button className="hk-btn" onClick={() => { setConflict(null); setCapturing(null) }}>Cancel</button>
          </div>
        </div>
      )}

      {HOTKEY_CATEGORIES.map(cat => {
        const entries = Object.entries(HOTKEY_DEFS).filter(([, def]) => def.category === cat.id)
        return (
          <div key={cat.id} className="hk-category">
            <div className="hk-category-label">{cat.label}</div>
            <div className="hk-table">
              {entries.map(([actionId, def]) => {
                const key       = bindings[actionId]
                const isDefault = key === def.defaultKey
                const isActive  = capturing === actionId

                return (
                  <div key={actionId} className={`hk-row${isActive ? ' hk-capturing' : ''}`}>
                    <span className="hk-label">{def.label}</span>
                    <div className="hk-controls">
                      {isActive ? (
                        <span className="hk-capture-hint">Press a key… (Esc to cancel)</span>
                      ) : (
                        <>
                          <kbd className="hk-key">{formatKeyLabel(key)}</kbd>
                          <button className="hk-btn" onClick={() => startCapture(actionId)}>Edit</button>
                          {!isDefault && (
                            <button className="hk-btn hk-btn-dim" title="Reset to default" onClick={() => onResetBinding(actionId)}>↺</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
