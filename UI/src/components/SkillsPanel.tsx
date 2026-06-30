import React, { useState } from 'react'
import skillsData from '../../../Data/skills.json'

const SKILL_DEFS = skillsData.skills || {}
const SKILL_MAX  = skillsData.maxLevel || 99
// Mirror Engine/skills.js SKILL_XP_TABLE: 50 * L * (L+1)
const skillXpToNext = (level) => (level >= SKILL_MAX ? Infinity : 50 * level * (level + 1))

const norm = (v) => (typeof v === 'number') ? { level: v, xp: 0 } : { level: v?.level ?? 1, xp: v?.xp ?? 0 }

const TYPE_LABEL = { weapon: 'Weapon', magic: 'Magic', profession: 'Profession', utility: 'Utility' }

function SkillRow({ id, entry }) {
  const def = SKILL_DEFS[id] || { name: id, type: 'misc' }
  const { level, xp } = norm(entry)
  const next = skillXpToNext(level)
  const pct  = next === Infinity ? 100 : Math.min(100, (xp / next) * 100)
  return (
    <div className="skill-row">
      <div className="skill-row-header">
        <span className="skill-name">{def.name}{def.type ? <span className="skill-type"> · {TYPE_LABEL[def.type] || def.type}</span> : null}</span>
        <span className="skill-val">Lv {level}{level >= SKILL_MAX ? ' (max)' : ` · ${xp}/${next}`}</span>
      </div>
      <div className="skill-bar-track"><div className="skill-bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

export default function SkillsPanel({ partyInstances = [] }: any) {
  const [index, setIndex] = useState(0)

  if (!partyInstances.length) {
    return <div className="skills-panel"><div className="panel-empty">No party members.</div></div>
  }

  const clamped = Math.min(index, partyInstances.length - 1)
  const inst    = partyInstances[clamped]
  const skills  = inst.skills || {}
  const ids     = Object.keys(skills)
  const cat     = (id) => SKILL_DEFS[id]?.category || 'combat'
  const byName  = (a, b) => (SKILL_DEFS[a]?.name || a).localeCompare(SKILL_DEFS[b]?.name || b)
  const combat     = ids.filter(id => cat(id) === 'combat').sort(byName)
  const nonCombat  = ids.filter(id => cat(id) === 'non_combat').sort(byName)

  return (
    <div className="skills-panel">
      <div className="char-nav">
        <button className="char-nav-btn" disabled={clamped === 0} onClick={() => setIndex(i => Math.max(0, i - 1))}>{'‹'}</button>
        <span className="char-nav-label">{inst.name} <span className="char-nav-count">({clamped + 1} / {partyInstances.length})</span></span>
        <button className="char-nav-btn" disabled={clamped === partyInstances.length - 1} onClick={() => setIndex(i => Math.min(partyInstances.length - 1, i + 1))}>{'›'}</button>
      </div>

      {ids.length === 0 && <div className="panel-empty">No skills yet.</div>}

      {combat.length > 0 && <>
        <div className="skills-section-label">Combat</div>
        {combat.map(id => <SkillRow key={id} id={id} entry={skills[id]} />)}
      </>}

      {nonCombat.length > 0 && <>
        <div className="skills-section-label">Non-Combat</div>
        {nonCombat.map(id => <SkillRow key={id} id={id} entry={skills[id]} />)}
      </>}
    </div>
  )
}
