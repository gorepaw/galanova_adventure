import React from 'react'

const RIDING_CAP_LOW  = 75
const RIDING_CAP_HIGH = 150

function RidingBar({ value, cap }) {
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0
  return (
    <div className="skill-bar-track">
      <div className="skill-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function SkillsPanel({ riding = 0, highestPartyLevel = 1 }) {
  const cap = highestPartyLevel >= 40 ? RIDING_CAP_HIGH : RIDING_CAP_LOW

  return (
    <div className="skills-panel">
      <div className="skills-section-label">Account-Wide Skills</div>
      <div className="skill-row">
        <div className="skill-row-header">
          <span className="skill-name">Riding</span>
          <span className="skill-val">{riding} / {cap}</span>
        </div>
        <RidingBar value={riding} cap={cap} />
        <span className="skill-cap-note">
          Cap: {cap} {highestPartyLevel < 40 ? '(reaches 150 at level 40)' : '(max)'}
        </span>
      </div>
    </div>
  )
}
