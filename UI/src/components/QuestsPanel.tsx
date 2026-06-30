import React, { useState } from 'react'

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function QuestRow({ questId, state, def }) {
  const [expanded, setExpanded] = useState(true)

  const name = def?.name ?? questId.replace(/_/g, ' ')
  const description = def?.description ?? ''
  const objectives = def?.objectives ?? []
  const rewards = def?.rewards ?? {}

  const rewardParts: string[] = []
  if (rewards.xp)       rewardParts.push(`${rewards.xp} XP`)
  if (rewards.currency) rewardParts.push(`${rewards.currency}c`)
  if (rewards.items?.length) rewardParts.push(`${rewards.items.length} item${rewards.items.length > 1 ? 's' : ''}`)

  return (
    <div className={`quest-row${state.completed ? ' quest-done' : ''}`}>
      <div className="quest-row-header" onClick={() => setExpanded(v => !v)}>
        <span className="quest-toggle">{expanded ? '▾' : '▸'}</span>
        <span className="quest-name">{name}</span>
        {state.completed && <span className="quest-complete-tag">Complete</span>}
        {!state.completed && def?.zoneId && (
          <span className="quest-zone">{def.zoneId.replace(/_/g, ' ')}</span>
        )}
      </div>

      {expanded && (
        <div className="quest-row-body">
          {description && (
            <p className="quest-desc">{description}</p>
          )}
          <div className="quest-objectives">
            {objectives.map(obj => {
              const current = state.objectives?.[obj.id] ?? 0
              const goal = obj.count ?? 1
              const done = current >= goal
              const pct = Math.min(100, Math.round((current / goal) * 100))
              return (
                <div key={obj.id} className={`quest-obj${done ? ' quest-obj-done' : ''}`}>
                  <div className="quest-obj-header">
                    <span className="quest-obj-check">{done ? '☑' : '☐'}</span>
                    <span className="quest-obj-desc">{obj.description ?? obj.id}</span>
                    <span className="quest-obj-count">{current}/{goal}</span>
                  </div>
                  {!done && (
                    <div className="quest-obj-track">
                      <div className="quest-obj-fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {rewardParts.length > 0 && (
            <div className="quest-rewards">
              <span className="quest-rewards-label">Rewards:</span>
              <span className="quest-rewards-val">{rewardParts.join(' · ')}</span>
            </div>
          )}
          {state.assignedAt && (
            <div className="quest-assigned">Accepted {formatDate(state.assignedAt)}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function QuestsPanel({ quests = {}, questCatalog = {} }: any) {
  const entries = Object.entries<any>(quests)
  const active    = entries.filter(([, q]) => !q.completed)
  const completed = entries.filter(([, q]) =>  q.completed)

  if (!entries.length) {
    return <div className="panel-empty">No quests yet. Explore the world to find them.</div>
  }

  return (
    <div className="quests-panel">
      {active.length > 0 && (
        <section className="quest-section">
          <div className="quest-section-label">Active ({active.length})</div>
          {active.map(([id, state]) => (
            <QuestRow key={id} questId={id} state={state} def={questCatalog[id]} />
          ))}
        </section>
      )}
      {completed.length > 0 && (
        <section className="quest-section">
          <div className="quest-section-label">Completed ({completed.length})</div>
          {completed.map(([id, state]) => (
            <QuestRow key={id} questId={id} state={state} def={questCatalog[id]} />
          ))}
        </section>
      )}
    </div>
  )
}
