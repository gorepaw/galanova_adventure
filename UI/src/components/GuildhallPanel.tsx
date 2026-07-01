import React, { useState } from 'react'

function CompanionCard({ companion, selected, onClick, badge }: any) {
  const isDead = (companion.deathState ?? 'alive') !== 'alive'
  return (
    <div
      className={`gh-card${selected ? ' gh-selected' : ''}${isDead ? ' gh-dead' : ''}`}
      onClick={onClick}
    >
      <div className="gh-card-avatar">{companion.classId?.[0]?.toUpperCase() ?? '?'}</div>
      <div className="gh-card-info">
        <span className="gh-card-name">{companion.name}</span>
        <span className="gh-card-class">{companion.raceId} {companion.classId} Lv{companion.level ?? 1}</span>
        {companion.profession && companion.profession !== 'none' && (
          <span className="gh-card-prof">{companion.profession.replace(/_/g, ' ')}</span>
        )}
        {isDead && <span className="gh-dead-tag">{companion.deathState?.toUpperCase()}</span>}
      </div>
      {badge && <div className="gh-badge">{badge}</div>}
    </div>
  )
}

export default function GuildhallPanel({ roster = [], onSwap, onBench, onRecruit, loading, gameState }: any) {
  const [selectedPartyId,  setSelectedPartyId]  = useState<any>(null)
  const [selectedRosterId, setSelectedRosterId] = useState<any>(null)

  const partyMembers  = roster.filter((c: any) => c.inParty)
  const rosterMembers = roster.filter((c: any) => !c.inParty)

  const inCombat = gameState === 'in_combat' || gameState === 'combat_pending'

  const handleSwap = () => {
    if (!selectedPartyId || !selectedRosterId || inCombat || loading) return
    onSwap(selectedPartyId, selectedRosterId)
    setSelectedPartyId(null)
    setSelectedRosterId(null)
  }

  const handleBench = () => {
    if (!selectedPartyId || inCombat || loading) return
    onBench(selectedPartyId)
    setSelectedPartyId(null)
  }

  const handleRecruit = () => {
    if (!selectedRosterId || inCombat || loading) return
    onRecruit(selectedRosterId)
    setSelectedRosterId(null)
  }

  const canSwap    = selectedPartyId && selectedRosterId && !inCombat && !loading
  const canBench   = selectedPartyId && !inCombat && !loading
  const canRecruit = selectedRosterId && !inCombat && !loading

  const selectedPartyName  = partyMembers.find((c: any) => c.instanceId === selectedPartyId)?.name
  const selectedRosterName = rosterMembers.find((c: any) => c.instanceId === selectedRosterId)?.name

  return (
    <div className="guildhall-panel">
      {inCombat && (
        <div className="gh-notice">Cannot swap members during combat.</div>
      )}

      <div className="gh-section-label">
        Party <span className="gh-count">({partyMembers.length})</span>
        {partyMembers.length > 5 && (
          <span className="gh-xp-penalty">
            {' '}— XP ×{Math.max(0, Math.round((1 - (partyMembers.length - 5) * 0.2) * 100))}%
          </span>
        )}
      </div>
      <div className="gh-list">
        {partyMembers.map((c: any) => (
          <CompanionCard
            key={c.instanceId}
            companion={c}
            selected={selectedPartyId === c.instanceId}
            badge="In Party"
            onClick={() => setSelectedPartyId(
              selectedPartyId === c.instanceId ? null : c.instanceId
            )}
          />
        ))}
        {partyMembers.length === 0 && (
          <div className="panel-empty">Party is empty.</div>
        )}
      </div>

      <div className="gh-swap-row">
        <button
          className="btn btn-primary gh-swap-btn"
          disabled={!canSwap}
          onClick={handleSwap}
        >
          ⇅ Swap
        </button>
        <button
          className="btn btn-secondary gh-bench-btn"
          disabled={!canBench}
          onClick={handleBench}
        >
          → Bench
        </button>
        <span className="gh-swap-hint">
          {selectedPartyName && selectedRosterName
            ? `${selectedPartyName} ↔ ${selectedRosterName}`
            : selectedPartyName
              ? `Bench ${selectedPartyName} or select a guildhall member to swap.`
              : 'Select a party member.'}
        </span>
      </div>

      <div className="gh-section-label">
        Guildhall <span className="gh-count">({rosterMembers.length})</span>
      </div>
      <div className="gh-list">
        {rosterMembers.map((c: any) => (
          <CompanionCard
            key={c.instanceId}
            companion={c}
            selected={selectedRosterId === c.instanceId}
            onClick={() => setSelectedRosterId(
              selectedRosterId === c.instanceId ? null : c.instanceId
            )}
          />
        ))}
        {rosterMembers.length === 0 && (
          <div className="panel-empty">No companions in the guildhall yet.</div>
        )}
      </div>

      {selectedRosterId && (
        <div className="gh-swap-row">
          <button
            className="btn btn-primary gh-recruit-btn"
            disabled={!canRecruit}
            onClick={handleRecruit}
          >
            ← Recruit
          </button>
          <span className="gh-swap-hint">
            {selectedRosterName
              ? `Add ${selectedRosterName} to the party.`
              : ''}
          </span>
        </div>
      )}
    </div>
  )
}
