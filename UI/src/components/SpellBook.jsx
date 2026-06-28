import React, { useState, useEffect } from 'react'
import abilitiesData from '../../../Data/abilities.json'
import classesData   from '../../../Data/classes.json'
import skillsData    from '../../../Data/skills.json'
import { skillAbilities } from './skillAbilities.js'

const ABILITY_DEFS = abilitiesData.abilities
const CLASS_DEFS   = classesData.classes
const PER_PAGE     = 24

// Pretty labels for scaling sources: combat stats, the 8 attributes, then skills.
const SKILL_NAMES = Object.fromEntries(
  Object.values(skillsData.skills || {}).map(s => [s.id, s.name])
)
const STAT_LABELS = {
  ap: 'AP', rap: 'RAP', sp: 'SP',
  str: 'STR', dex: 'DEX', con: 'CON', int: 'INT',
  spi: 'SPI', wis: 'WIS', spd: 'SPD', cha: 'CHA',
}
const statLabel = k => STAT_LABELS[k] || SKILL_NAMES[k] || k

// Build the human-readable scaling breakdown for one damage/heal effect, e.g.
// "melee weapon + 0.8× AP + 0.5× STR + 1.0× One-Handed Swords + 10".
function fmtEffect(eff) {
  const parts = []
  if (eff.usesWeapon === 'melee')       parts.push('melee weapon')
  else if (eff.usesWeapon === 'ranged') parts.push('ranged weapon')

  const s = eff.scaling
  if (s && typeof s === 'object') {
    for (const [k, c] of Object.entries(s)) parts.push(`${c}× ${statLabel(k)}`)
  } else if (typeof s === 'string') {
    parts.push(`${eff.multiplier ?? 1}× ${statLabel(s)}`)
  }

  const flat = eff.flatBonus ?? eff.flat
  if (flat) parts.push(`${flat}`)
  if (!parts.length) return null
  return { icon: eff.type === 'heal' ? '✚' : '⚔', text: parts.join(' + ') }
}

const RESOURCE_COLORS = {
  rage:   { label: 'Rage',   color: '#ff6644' },
  mana:   { label: 'Mana',   color: '#4a90d9' },
  stamina: { label: 'Stamina', color: '#ffee44' },
  runic:  { label: 'Runic',  color: '#88aaff' },
}

const TAG_STYLE = {
  physical: { bg: 'rgba(200,100,50,0.12)',  border: 'rgba(200,100,50,0.3)',  color: '#d08050' },
  melee:    { bg: 'rgba(200,100,50,0.12)',  border: 'rgba(200,100,50,0.3)',  color: '#d08050' },
  magic:    { bg: 'rgba(74,144,217,0.12)',  border: 'rgba(74,144,217,0.3)',  color: '#4a90d9' },
  ranged:   { bg: 'rgba(30,200,100,0.10)',  border: 'rgba(30,200,100,0.3)',  color: '#50cc80' },
  shout:    { bg: 'rgba(255,180,50,0.10)',  border: 'rgba(255,180,50,0.3)',  color: '#ccaa40' },
  holy:     { bg: 'rgba(255,230,100,0.10)', border: 'rgba(255,230,100,0.3)', color: '#f0d060' },
  shadow:   { bg: 'rgba(155,89,182,0.12)', border: 'rgba(155,89,182,0.3)',  color: '#9b59b6' },
  fire:     { bg: 'rgba(255,80,30,0.12)',   border: 'rgba(255,80,30,0.3)',   color: '#ff6030' },
  frost:    { bg: 'rgba(80,160,220,0.12)',  border: 'rgba(80,160,220,0.3)',  color: '#50a0dc' },
  nature:   { bg: 'rgba(60,200,80,0.10)',   border: 'rgba(60,200,80,0.3)',   color: '#3cc850' },
}

function fmtCost(resourceCost) {
  if (!resourceCost) return null
  return Object.entries(resourceCost)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ key: k, amount: v, ...RESOURCE_COLORS[k] }))
}

function SpellEntry({ def, learnedAt }) {
  const isPassive = !!def.passive
  const costs     = fmtCost(def.resourceCost) || []
  const cooldown  = def.cooldown > 0 ? def.cooldown : null
  const tags      = (def.tags || []).slice(0, 2)
  const scalingLines = (def.effects || [])
    .filter(e => e.type === 'damage' || e.type === 'heal')
    .map(fmtEffect)
    .filter(Boolean)

  return (
    <div className={`spell-entry${isPassive ? ' spell-passive' : ''}`}>
      <div className="spell-header">
        <span className="spell-icon">{isPassive ? '◈' : '✦'}</span>
        <span className="spell-name">{def.name}</span>
        <div className="spell-badges">
          {isPassive && <span className="spell-badge badge-passive">Passive</span>}
          {!isPassive && tags.map(t => {
            const s = TAG_STYLE[t] || {}
            return (
              <span
                key={t}
                className="spell-badge"
                style={{ background: s.bg, borderColor: s.border, color: s.color }}
              >
                {t}
              </span>
            )
          })}
          <span className="spell-badge badge-level">Lv {learnedAt}</span>
        </div>
      </div>

      {!isPassive && (costs.length > 0 || cooldown) && (
        <div className="spell-meta">
          {costs.map((c, i) => (
            <span key={c.key} className="spell-cost" style={{ color: c.color }}>
              {i > 0 && <span className="spell-meta-sep"> · </span>}
              {c.amount} {c.label ?? c.key}
            </span>
          ))}
          {costs.length > 0 && cooldown && <span className="spell-meta-sep"> · </span>}
          {cooldown && <span className="spell-cd">{cooldown}t cd</span>}
        </div>
      )}

      {!isPassive && scalingLines.length > 0 && (
        <div className="spell-scaling">
          {scalingLines.map((l, i) => (
            <span key={i} className="spell-scaling-line">
              <span className="spell-scaling-icon">{l.icon}</span> {l.text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptySlot() {
  return <div className="spell-entry spell-empty" />
}

export default function SpellBook({ inst }) {
  const [page, setPage] = useState(0)

  useEffect(() => { setPage(0) }, [inst?.instanceId ?? inst?.name])

  if (!inst) return null

  const classDef = CLASS_DEFS[inst.classId]
  if (!classDef) return <div className="panel-empty">No ability data for {inst.classId}.</div>

  const charLevel    = inst.level ?? 1
  const unlocked     = skillAbilities(inst)
  const totalPages   = Math.max(1, Math.ceil(unlocked.length / PER_PAGE))
  const currentPage  = Math.min(page, totalPages - 1)
  const pageEntries  = unlocked.slice(currentPage * PER_PAGE, (currentPage + 1) * PER_PAGE)
  const emptySlots   = PER_PAGE - pageEntries.length

  return (
    <div className="spellbook">
      <div className="spellbook-page">
        <div className="spellbook-corner spellbook-corner-tl">✦</div>
        <div className="spellbook-corner spellbook-corner-tr">✦</div>

        <div className="spellbook-title">
          {inst.name}
          <div className="spellbook-subtitle">{classDef.name} · Level {charLevel} · {unlocked.length} abilities</div>
        </div>

        <div className="spell-list">
          {pageEntries.map(entry => {
            const def = ABILITY_DEFS[entry.id]
            return def
              ? <SpellEntry key={entry.id} def={def} learnedAt={entry.level} />
              : <EmptySlot key={entry.id} />
          })}
          {Array.from({ length: emptySlots }).map((_, i) => (
            <EmptySlot key={`empty-${i}`} />
          ))}
        </div>

        <div className="spellbook-corner spellbook-corner-bl">✦</div>
        <div className="spellbook-corner spellbook-corner-br">✦</div>
      </div>

      <div className="spellbook-nav">
        <button
          className="spellbook-nav-btn"
          disabled={currentPage === 0}
          onClick={() => setPage(p => p - 1)}
        >◄</button>
        <span className="spellbook-nav-label">
          {totalPages > 1 ? `${currentPage + 1} / ${totalPages}` : `${unlocked.length} spells`}
        </span>
        <button
          className="spellbook-nav-btn"
          disabled={currentPage === totalPages - 1}
          onClick={() => setPage(p => p + 1)}
        >►</button>
      </div>
    </div>
  )
}
