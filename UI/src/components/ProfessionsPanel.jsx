import React from 'react'

export default function ProfessionsPanel({ companions = [] }) {
  const withProfession = companions.filter(c => c.profession && c.profession !== 'none')

  if (!withProfession.length) {
    return <div className="panel-empty">No companions with professions yet.</div>
  }

  return (
    <div className="professions-panel">
      <div className="prof-list">
        {withProfession.map(c => {
          const profId   = c.profession
          const skillVal = c.skills?.[profId] ?? 0
          return (
            <div key={c.instanceId} className={`prof-row${c.inParty ? ' prof-in-party' : ''}`}>
              <div className="prof-row-main">
                <span className="prof-companion-name">{c.name}</span>
                {c.inParty && <span className="prof-party-badge">Party</span>}
              </div>
              <div className="prof-row-sub">
                <span className="prof-name">{profId.replace(/_/g, ' ')}</span>
                <span className="prof-skill-val">{skillVal}</span>
              </div>
              <div className="prof-bar-track">
                <div className="prof-bar-fill" style={{ width: `${Math.min(100, skillVal)}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
