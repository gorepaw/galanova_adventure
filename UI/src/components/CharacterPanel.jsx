import React from 'react'
import { formatCurrency as fmtCopper } from '../currency.js'

function Bar({ value, max, className }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="bar-track">
      <div className={`bar-fill ${className}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function xpToNext(level) {
  if (level >= 60) return Infinity
  return Math.floor(400 * Math.pow(level, 1.6))
}

// Skills are stored as { level, xp } (legacy: plain number). Read the level safely.
const skillLevel = (v) => (typeof v === 'number' ? v : (v?.level ?? null))

function MemberCard({ inst, currency, onRez }) {
  if (!inst) return null
  const raw = inst.stats?.raw ?? {}
  const hp = inst.currentHp ?? inst.maxHp ?? 0
  const maxHp = inst.maxHp ?? 1
  const mp = inst.currentMp ?? 0
  const maxMp = inst.maxMp ?? 0
  const classId = inst.classId ?? ''
  const level = inst.level ?? 1
  const xp = inst.xp ?? 0
  const nextXp = xpToNext(level)
  const deathState = inst.deathState ?? 'alive'
  const isDead = deathState !== 'alive'
  const isDowned = deathState === 'downed' && !inst.permadead
  const rezCost = inst.rezCost ?? (500 + level * 200)
  const canAfford = currency >= rezCost

  return (
    <div className={`member-card ${isDead ? 'dead' : ''}`}>
      <div className="member-header">
        <div className="member-avatar">{inst.classId?.[0]?.toUpperCase() ?? '?'}</div>
        <div className="member-info">
          <div className="member-name">
            {inst.name}
            {isDead && <span className="death-tag">{deathState.toUpperCase()}</span>}
          </div>
          <div className="member-class">
            {inst.raceId} {inst.classId} · Lv{level}
          </div>
        </div>
      </div>

      {isDowned && (
        <button
          className={`rez-btn ${canAfford ? '' : 'rez-btn-broke'}`}
          disabled={!canAfford}
          onClick={() => onRez(inst.instanceId)}
        >
          Revive — {fmtCopper(rezCost)}
        </button>
      )}

      <div className="stat-bars">
        <div className="bar-label">
          <span>HP</span>
          <span>{hp}/{maxHp}</span>
        </div>
        <Bar value={hp} max={maxHp} className="hp-bar" />

        {classId === 'warrior' ? (
          <>
            <div className="bar-label">
              <span>Rage</span>
              <span>0/100</span>
            </div>
            <Bar value={0} max={100} className="rage-bar" />
          </>
        ) : maxMp > 0 ? (
          <>
            <div className="bar-label">
              <span>MP</span>
              <span>{mp}/{maxMp}</span>
            </div>
            <Bar value={mp} max={maxMp} className="mp-bar" />
          </>
        ) : null}

        {nextXp !== Infinity ? (
          <>
            <div className="bar-label">
              <span>XP</span>
              <span>{xp}/{nextXp}</span>
            </div>
            <Bar value={xp} max={nextXp} className="xp-bar" />
          </>
        ) : (
          <div className="bar-label"><span>XP</span><span className="gold">MAX</span></div>
        )}
      </div>

      {Object.keys(raw).length > 0 && (
        <div className="member-stats">
          {['str','dex','con','int','spi','wis','spd','cha'].map(k => (
            <span key={k} className="stat-chip">{k.toUpperCase()} {raw[k] ?? 0}</span>
          ))}
        </div>
      )}

      {inst.profession && inst.profession !== 'none' && (
        <div className="member-prof">
          {inst.profession}{skillLevel(inst.skills?.[inst.profession]) != null ? ` (Lv ${skillLevel(inst.skills[inst.profession])})` : ''}
        </div>
      )}
    </div>
  )
}

export default function CharacterPanel({ partyInstances, currency, onRez }) {
  return (
    <div className="char-panel">
      <div className="panel-title">Party</div>
      {partyInstances.length === 0 ? (
        <div className="panel-empty">Loading…</div>
      ) : (
        partyInstances.map(inst => (
          <MemberCard key={inst.instanceId} inst={inst} currency={currency} onRez={onRez} />
        ))
      )}
    </div>
  )
}
