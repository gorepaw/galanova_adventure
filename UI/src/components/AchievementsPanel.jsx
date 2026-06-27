import React from 'react'
import achievementsData from '../../../Data/achievements.json'

const DEFS = Object.values(achievementsData.achievements || {})

function formatCurrency(copper) {
  if (!copper) return null
  const g = Math.floor(copper / 10000)
  const s = Math.floor((copper % 10000) / 100)
  const c = copper % 100
  return [g && `${g}g`, s && `${s}s`, (c || (!g && !s)) && `${c}c`].filter(Boolean).join(' ')
}

function RewardLine({ rewards }) {
  const parts = []
  if (rewards.xp)       parts.push(`+${rewards.xp} XP`)
  if (rewards.currency) parts.push(`+${formatCurrency(rewards.currency)}`)
  if (rewards.items)    rewards.items.forEach(r => parts.push(`+${r.qty}x ${r.itemId}`))
  if (!parts.length)    return null
  return <div className="ach-rewards">{parts.join('  ·  ')}</div>
}

function progressFor(def, collections) {
  if (def.criteria?.type === 'unique_items_collected') {
    return {
      current: Object.keys(collections?.items || {}).length,
      total: def.criteria.threshold,
    }
  }
  return null
}

export default function AchievementsPanel({ achievements = {}, collections = {} }) {
  const unlocked = DEFS.filter(d => achievements[d.id])
  const locked   = DEFS.filter(d => !achievements[d.id])

  const renderCard = (def) => {
    const isUnlocked = !!achievements[def.id]
    const progress   = progressFor(def, collections)
    const pct        = progress ? Math.min(100, (progress.current / progress.total) * 100) : 0
    const unlockedAt = achievements[def.id]?.unlockedAt

    return (
      <div key={def.id} className={`ach-card${isUnlocked ? ' ach-unlocked' : ''}`}>
        <div className="ach-card-header">
          <span className="ach-name">{def.name}</span>
          {isUnlocked && (
            <span className="ach-done-tag">✓</span>
          )}
        </div>
        <div className="ach-desc">{def.description}</div>
        {!isUnlocked && progress && (
          <div className="ach-progress">
            <div className="ach-track">
              <div className="ach-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="ach-progress-label">{progress.current} / {progress.total}</span>
          </div>
        )}
        {isUnlocked && unlockedAt && (
          <div className="ach-date">
            Unlocked {new Date(unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        )}
        <RewardLine rewards={def.rewards || {}} />
      </div>
    )
  }

  return (
    <div className="achievements-panel">
      {unlocked.length > 0 && (
        <div className="ach-section">
          <div className="ach-section-label">Unlocked ({unlocked.length})</div>
          {unlocked.map(renderCard)}
        </div>
      )}
      <div className="ach-section">
        <div className="ach-section-label">
          {locked.length > 0 ? `In Progress / Locked (${locked.length})` : 'All achievements unlocked!'}
        </div>
        {locked.map(renderCard)}
      </div>
    </div>
  )
}
