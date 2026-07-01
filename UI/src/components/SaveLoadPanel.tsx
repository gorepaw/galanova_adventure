import React, { useState } from 'react'
import type { SaveSlotView } from '../../../Engine/types/viewmodel'

function formatPlaytime(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatTimestamp(ts: string | null | undefined) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function SlotRow({ slot, isActive, loading, onLoad, onOverwrite, onDelete }: any) {
  const [confirming, setConfirming] = useState(false)

  const displayName = slot.saveName || slot.slotId
  const zone = (slot.zone || 'unknown').replace(/_/g, ' ')

  return (
    <div className={`sl-row${isActive ? ' sl-active' : ''}`}>
      <div className="sl-row-info">
        <div className="sl-row-name">
          {displayName}
          {isActive && <span className="sl-active-tag">Active</span>}
        </div>
        <div className="sl-row-meta">
          <span className="sl-meta-zone">{zone}</span>
          <span className="sl-meta-sep">·</span>
          <span className="sl-meta-party">{slot.partySize} members</span>
          <span className="sl-meta-sep">·</span>
          <span className="sl-meta-time">{formatPlaytime(slot.playtime)}</span>
        </div>
        <div className="sl-row-date">{formatTimestamp(slot.timestamp)}</div>
      </div>
      <div className="sl-row-actions">
        {!isActive && (
          <button className="btn btn-sm btn-primary" disabled={loading} onClick={onLoad}>
            Load
          </button>
        )}
        <button className="btn btn-sm btn-secondary" disabled={loading} onClick={onOverwrite}>
          Save
        </button>
        {!isActive && (
          confirming ? (
            <>
              <button className="btn btn-sm btn-danger" disabled={loading} onClick={() => { setConfirming(false); onDelete() }}>
                Confirm
              </button>
              <button className="btn btn-sm btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => setConfirming(true)}>
              Delete
            </button>
          )
        )}
      </div>
    </div>
  )
}

export default function SaveLoadPanel({ slots = [], activeSlotId, loading, onSaveToSlot, onLoadFromSlot, onDeleteSlot, onNewGame }: { slots?: SaveSlotView[]; activeSlotId: string; loading: boolean; onSaveToSlot: (id: string, name: string) => void; onLoadFromSlot: (id: string) => void; onDeleteSlot: (id: string) => void; onNewGame: () => void }) {
  const [newName, setNewName] = useState('')
  const [confirmingNew, setConfirmingNew] = useState(false)

  const handleNewSave = () => {
    const slotId = `slot_${Date.now()}`
    const name = newName.trim() || null
    onSaveToSlot(slotId, name ?? "")
    setNewName('')
  }

  const handleConfirmNewGame = () => {
    setConfirmingNew(false)
    onNewGame()
  }

  return (
    <div className="save-load-panel">
      <div className="sl-new-game">
        <div className="sl-section-label">New Game</div>
        <div className="sl-new-game-row">
          <span className="sl-new-game-desc">Start a fresh adventure. Your current unsaved progress will be lost.</span>
          {confirmingNew ? (
            <div className="sl-new-game-confirm">
              <span className="sl-confirm-warning">Are you sure?</span>
              <button className="btn btn-sm btn-danger" disabled={loading} onClick={handleConfirmNewGame}>Confirm</button>
              <button className="btn btn-sm btn-secondary" onClick={() => setConfirmingNew(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn-danger" disabled={loading} onClick={() => setConfirmingNew(true)}>
              Start New Game
            </button>
          )}
        </div>
      </div>

      <div className="sl-new-save">
        <div className="sl-section-label">New Save</div>
        <div className="sl-new-row">
          <input
            className="sl-name-input"
            type="text"
            placeholder="Optional name…"
            maxLength={40}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleNewSave()}
          />
          <button className="btn btn-primary" disabled={loading} onClick={handleNewSave}>
            Save to New Slot
          </button>
        </div>
      </div>

      <div className="sl-slots">
        <div className="sl-section-label">Save Slots ({slots.length})</div>
        {slots.length === 0 ? (
          <div className="panel-empty">No saves yet.</div>
        ) : (
          slots.map(slot => (
            <SlotRow
              key={slot.slotId}
              slot={slot}
              isActive={slot.slotId === activeSlotId}
              loading={loading}
              onLoad={() => onLoadFromSlot(slot.slotId)}
              onOverwrite={() => onSaveToSlot(slot.slotId, slot.saveName ?? "")}
              onDelete={() => onDeleteSlot(slot.slotId)}
            />
          ))
        )}
      </div>
    </div>
  )
}
