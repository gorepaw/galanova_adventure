import React from 'react'

export default function AbilityBar({
  gameState, loading, canSkin,
  autoRun, autoEngage, autoFlee,
  bindings = {}, formatKeyLabel = k => k,
  onRunEncounter, onEngage, onFlee, onSkin,
  onToggleAutoRun, onToggleAutoEngage, onToggleAutoFlee,
}) {
  const disabled  = loading
  const isPending = gameState === 'combat_pending'

  const hkRun    = formatKeyLabel(bindings.run_encounter)
  const hkEngage = formatKeyLabel(bindings.engage_combat)
  const hkFlee   = formatKeyLabel(bindings.try_flee)

  return (
    <div className={`ability-bar${isPending ? ' combat-pending' : ''}`}>

      {/* ── Main action area ── */}
      <div className="bar-buttons">
        {isPending ? (
          <>
            <div className="bar-label-center">⚔ Combat Encounter</div>
            <button className="btn btn-danger bar-btn-fill" onClick={onEngage} disabled={disabled}>
              ⚔ Engage {hkEngage && <span className="bar-hk">{hkEngage}</span>}
            </button>
            <button className="btn btn-secondary bar-btn-fill" onClick={onFlee} disabled={disabled}>
              🏃 Flee {hkFlee && <span className="bar-hk">{hkFlee}</span>}
            </button>
          </>
        ) : (
          <>
            <div className="encounter-row">
              <button className="btn btn-primary bar-btn-fill" onClick={onRunEncounter} disabled={disabled}>
                ⚡ Encounter {hkRun && <span className="bar-hk">{hkRun}</span>}
              </button>
              <button
                className={`btn encounter-repeat-btn${autoRun ? ' active' : ''}`}
                onClick={onToggleAutoRun}
                disabled={disabled}
                title={autoRun ? 'Auto-Encounter ON — click to stop' : 'Auto-Encounter OFF — click to enable'}
              >
                Auto-Encounter
              </button>
            </div>
            {canSkin && (
              <>
                <div className="bar-separator" />
                <button className="btn btn-skin bar-btn-fill" onClick={onSkin} disabled={disabled}>
                  🐾 Skin
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Auto-response section ── */}
      <div className="auto-section">
        <div className="auto-btn-row">
          <button
            className={`btn auto-btn${autoEngage ? ' auto-btn-on' : ''}`}
            onClick={onToggleAutoEngage}
            disabled={disabled}
            title={autoEngage ? 'Auto-Engage ON' : 'Auto-Engage OFF'}
          >
            Auto-Engage
          </button>
          <button
            className={`btn auto-btn${autoFlee ? ' auto-btn-on' : ''}`}
            onClick={onToggleAutoFlee}
            disabled={disabled}
            title={autoFlee ? 'Auto-Run ON' : 'Auto-Run OFF'}
          >
            Auto-Run
          </button>
        </div>
      </div>

    </div>
  )
}
