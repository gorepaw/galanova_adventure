import React, { useState, useEffect } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip.jsx'
import SpellBook from './SpellBook.jsx'

// Derived stats, gear totals, and the skill view-model are computed by the engine
// (Engine/charsheet.js) and arrive on inst.sheet — this component only renders them.

// Non-mana resources and how their (placeholder) full pools display on the sheet.
const RESOURCE_META = {
  rage:         { label: 'Rage',         display: '0 / 100' },
  stamina:      { label: 'Stamina',      display: '100 / 100' },
  combo_points: { label: 'Combo Points', display: '0 / 5' },
}

const SLOT_LABEL = {
  head: 'Head', neck: 'Neck', shoulders: 'Shoulders', back: 'Back',
  chest: 'Chest', shirt: 'Shirt', tabard: 'Tabard', waist: 'Waist',
  wrist: 'Wrist', hands: 'Hands', feet: 'Feet', legs: 'Legs',
  ring: 'Ring', trinket: 'Trinket',
  mainhand: 'Main Hand', offhand: 'Off Hand', ranged: 'Ranged', ammo: 'Ammo',
}

const DISPLAY_SLOTS = [
  'head', 'neck', 'shoulders', 'back', 'chest', 'shirt', 'tabard', 'waist',
  'wrist', 'hands', 'feet', 'legs', 'ring', 'trinket',
  'mainhand', 'offhand', 'ranged', 'ammo',
]


function pct(n, digits = 2) { return `${n.toFixed(digits)}%` }

function fmtCopper(copper) {
  const g = Math.floor(copper / 10000)
  const s = Math.floor((copper % 10000) / 100)
  const c = copper % 100
  const parts = []
  if (g > 0) parts.push(`${g}g`)
  if (s > 0) parts.push(`${s}s`)
  if (c > 0 || parts.length === 0) parts.push(`${c}c`)
  return parts.join(' ')
}

function tipPos(e) {
  const x = e.clientX + 14 + 240 > window.innerWidth ? e.clientX - 254 : e.clientX + 14
  return { x, y: e.clientY - 8 }
}

function fmtModifier(key, val) {
  const sign = v => v > 0 ? `+${v}` : `${v}`
  const pp   = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`
  switch (key) {
    case 'attackPower':           return `${sign(val)} AP`
    case 'rangedAttackPower':     return `${sign(val)} Ranged AP`
    case 'spellPower':            return `${sign(val)} SP`
    case 'armor':                 return `${sign(val)} Armor`
    case 'flatDamage':            return `${sign(val)} Weapon Dmg`
    case 'maxHpBonus':            return `${sign(val)} Max HP`
    case 'dodgeChance':           return `${pp(val)} Dodge`
    case 'critChanceMelee':       return `${pp(val)} Melee Crit`
    case 'critChanceSpell':       return `${pp(val)} Spell Crit`
    case 'bonusRageOnHit':        return `+${val} Rage on Hit`
    case 'hitChancePenalty':      return `${pp(-val)} Hit`
    case 'damageDoneMultiplier':  return `${pp(val - 1)} Damage Done`
    case 'damageTakenMultiplier': return val < 1 ? `${pp(1 - val)} less Dmg Taken` : `${pp(val - 1)} more Dmg Taken`
    case 'healingMultiplier':     return `${pp(val - 1)} Healing`
    case 'str':                   return `${sign(val)} STR`
    case 'dex':                   return `${sign(val)} DEX`
    case 'con':                   return `${sign(val)} CON`
    case 'int':                   return `${sign(val)} INT`
    case 'spi':                   return `${sign(val)} SPI`
    case 'wis':                   return `${sign(val)} WIS`
    case 'spd':                   return `${sign(val)} SPD`
    case 'cha':                   return `${sign(val)} CHA`
    case 'pyroResistance':        return `${sign(val)} Pyro Res`
    case 'cryoResistance':        return `${sign(val)} Cryo Res`
    case 'natureResistance':      return `${sign(val)} Nature Res`
    case 'chaosResistance':       return `${sign(val)} Chaos Res`
    case 'orderResistance':       return `${sign(val)} Order Res`
    case 'bioResistance':         return `${sign(val)} Bio Res`
    case 'energyResistance':      return `${sign(val)} Energy Res`
    case 'psychicResistance':     return `${sign(val)} Psychic Res`
    case 'guaranteedMeleeCrit':   return val ? 'Next Attack Crits' : null
    case 'retaliation':           return val ? 'Retaliates on Attack' : null
    case 'reflectNextSpell':      return val ? 'Reflect Next Spell' : null
    case 'intervene':             return val ? 'Intercepts Next Hit' : null
    case 'reducedFleeChance':     return val ? 'Flee Chance Reduced' : null
    default:                      return null
  }
}

function buffEffectLines(def) {
  const lines = []
  for (const [k, v] of Object.entries(def.ccFlags || {})) {
    if (v) lines.push(k.charAt(0).toUpperCase() + k.slice(1))
  }
  for (const [k, v] of Object.entries(def.modifiers || {})) {
    const s = fmtModifier(k, v)
    if (s) lines.push(s)
  }
  if (def.tickDamage) {
    const t = def.tickDamage
    const type = t.damageType ? `${t.damageType[0].toUpperCase() + t.damageType.slice(1)} ` : ''
    lines.push(`${type}DoT: ${t.flat}+ /turn`)
  }
  if (def.tickHeal)        lines.push(`HoT: ${def.tickHeal.flat}+ HP/turn`)
  if (def.absorbShield)    lines.push(`Absorbs ${def.absorbShield} dmg`)
  if (def.maxHpBonus)      lines.push(`+${def.maxHpBonus} Max HP`)
  if (def.isStealth)       lines.push('Stealthed')
  if (def.isFaded)         lines.push('Faded')
  if (def.doubleAction)    lines.push('Double Action')
  if (def.invulnerable)    lines.push('Invulnerable')
  if (def.negatesNextFear) lines.push('Ward vs. Fear')
  if (def.fleeBonus)       lines.push(`+${Math.round(def.fleeBonus * 100)}% Flee`)
  if (def.tickRage)        lines.push(`+${def.tickRage} Rage/turn`)
  if (def.onHitRetaliation) lines.push('Retaliates on hit')
  if (def.procOnHit)       lines.push('Procs on hit')
  if (def.healingTakenBonus) lines.push(`+${Math.round(def.healingTakenBonus * 100)}% Healing Taken`)
  if (def.isWeaponBuff)    lines.push('Weapon enchant')
  if (def.isSeal)          lines.push('Seal')
  if (def.isBlessing)      lines.push('Blessing')
  if (def.isAspect)        lines.push('Aspect')
  return lines
}

function EffectRow({ entry, buffCatalog }) {
  const id  = typeof entry === 'string' ? entry : entry.id
  const dur = typeof entry === 'object'  ? entry.remainingDuration : undefined
  const def = buffCatalog[id] || { name: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), modifiers: {}, ccFlags: {} }
  const isDebuff = !!(def.isDebuff || Object.values(def.ccFlags || {}).some(Boolean) || def.tickDamage)
  const effects  = buffEffectLines(def)
  const durLabel = dur == null ? (def.duration === 'infinite' ? '∞' : '?') : dur === 99 ? '∞' : `${dur}t`
  const stacksLabel = entry.stacks > 1 ? ` ×${entry.stacks}` : ''

  return (
    <div className={`effect-row ${isDebuff ? 'effect-debuff' : 'effect-buff'}`}>
      <div className="effect-header">
        <span className="effect-name">{def.name}{stacksLabel}</span>
        <span className="effect-dur">{durLabel}</span>
      </div>
      {effects.length > 0 && (
        <div className="effect-lines">
          {effects.map((line, i) => <span key={i} className="effect-line">{line}</span>)}
        </div>
      )}
    </div>
  )
}

// ── Small building blocks ────────────────────────────────────────────────────

function CsSection({ label, children }) {
  return (
    <div className="cs-section">
      <div className="cs-section-label">{label}</div>
      {children}
    </div>
  )
}

function CsRow({ label, value, highlight }) {
  return (
    <div className="cs-stat-row">
      <span className="cs-stat-label">{label}</span>
      <span className={`cs-stat-value${highlight ? ' cs-stat-hi' : ''}`}>{value}</span>
    </div>
  )
}

// ── Main sheet ────────────────────────────────────────────────────────────────

function CharacterSheet({ inst, itemCatalog, buffCatalog, inventory = [], onEquip, currency = 0, onRez, onAllocate }) {
  const [tip, setTip]         = useState(null)
  const [openSlot, setOpenSlot] = useState(null)

  useEffect(() => {
    if (!openSlot) return
    const handler = () => setOpenSlot(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [openSlot])

  if (!inst) return null

  // Display view-model computed by the engine (Engine/charsheet.js).
  const sheet      = inst.sheet ?? {}
  const tot        = sheet.totals ?? {}
  const gb         = sheet.gearBonuses ?? {}
  const d          = sheet.derived ?? {}
  const resist     = d.resistances ?? {}
  const skillsView = sheet.skills ?? {}
  const skillMax   = sheet.skillMaxLevel ?? 99
  const classResources = sheet.resources ?? []
  const hasMana    = classResources.includes('mana')
  const isCaster   = hasMana

  const deathState = inst.deathState ?? 'alive'
  const isDead     = deathState !== 'alive'
  const isDowned   = deathState === 'downed' && !inst.permadead
  const rezCost    = inst.rezCost ?? (500 + (inst.level ?? 1) * 200)
  const canAfford  = currency >= rezCost
  const gear       = inst.gear || {}
  const activeBuffs = inst.activeBuffs || []
  const unspent    = inst.unspentStatPoints || 0

  const buffs = activeBuffs.filter(e => {
    const id = typeof e === 'string' ? e : e.id
    const def = buffCatalog[id] || {}
    return !(def.isDebuff || Object.values(def.ccFlags || {}).some(Boolean) || def.tickDamage)
  })
  const debuffs = activeBuffs.filter(e => {
    const id = typeof e === 'string' ? e : e.id
    const def = buffCatalog[id] || {}
    return !!(def.isDebuff || Object.values(def.ccFlags || {}).some(Boolean) || def.tickDamage)
  })

  // Mainhand weapon info (presentation straight from the item catalog)
  const mhItem = gear.mainhand ? itemCatalog[gear.mainhand] : null
  const hasDmg = mhItem?.minDamage != null && mhItem?.maxDamage != null

  const getSlotItems = (slot) => (inventory || []).filter(e => e.slot === slot && e.qty > 0)

  return (
    <div className={`char-sheet ${isDead ? 'char-sheet-dead' : ''}`}>
      <div className="char-sheet-bio">
        <span className="char-sheet-name">
          {inst.name}
          {isDead && <span className="death-tag">{deathState.toUpperCase()}</span>}
        </span>
        <span className="char-sheet-class">{inst.raceId} {inst.classId} · Lv{inst.level ?? 1}</span>
      </div>

      {isDowned && (
        <button
          className={`rez-btn ${canAfford ? '' : 'rez-btn-broke'}`}
          disabled={!canAfford}
          onClick={() => onRez?.(inst.instanceId)}
        >
          Revive — {fmtCopper(rezCost)}
        </button>
      )}

      <div className="char-sheet-body">
        <div className="char-sheet-left">

          {/* ── Attributes ── */}
          <CsSection label="Attributes">
            {unspent > 0 && (
              <div className="cs-alloc-banner">
                {unspent} stat point{unspent === 1 ? '' : 's'} to allocate
              </div>
            )}
            <div className="cs-attrs">
              {[['str','STR'],['dex','DEX'],['con','CON'],['int','INT'],['spi','SPI'],['wis','WIS'],['spd','SPD'],['cha','CHA']].map(([k, label]) => (
                <div key={k} className="cs-attr">
                  <span className="cs-attr-key">{label}</span>
                  <span className="cs-attr-val">{tot[k]}</span>
                  {gb[k] > 0 && <span className="cs-attr-bonus">+{gb[k]}</span>}
                  {unspent > 0 && onAllocate && (
                    <button
                      className="cs-alloc-btn"
                      title={`Spend 1 point on ${label}`}
                      onClick={() => onAllocate(inst.instanceId, k)}
                    >+</button>
                  )}
                </div>
              ))}
            </div>
          </CsSection>

          {/* ── Resources ── */}
          <CsSection label="Resources">
            <CsRow label="Health" value={`${inst.currentHp ?? d.maxHp} / ${d.maxHp}`} />
            {classResources.map(r => r === 'mana'
              ? <CsRow key={r} label="Mana" value={`${inst.currentMp ?? d.maxMp} / ${d.maxMp}`} />
              : <CsRow key={r} label={RESOURCE_META[r]?.label || r} value={RESOURCE_META[r]?.display || ''} />
            )}
          </CsSection>

          {/* ── Offense ── */}
          <CsSection label="Offense">
            {hasDmg && (
              <CsRow
                label="Weapon Dmg"
                value={`${mhItem.minDamage}–${mhItem.maxDamage}${mhItem.weaponSpeed != null ? `  (${mhItem.weaponSpeed.toFixed(1)} spd)` : ''}`}
              />
            )}
            <CsRow label="Attack Power"  value={d.attackPower} />
            <CsRow label="Melee Crit"    value={pct(d.meleeCrit)} highlight={d.meleeCrit >= 10} />
            <CsRow label="Ranged AP"     value={d.rangedAP} />
            {(isCaster || d.spellPower > 0) && <>
              <CsRow label="Spell Power" value={d.spellPower} />
              <CsRow label="Spell Crit"  value={pct(d.spellCrit)} highlight={d.spellCrit >= 10} />
            </>}
          </CsSection>

          {/* ── Defense ── */}
          <CsSection label="Defense">
            <CsRow label="Armor"       value={d.armor} />
            <CsRow label="Mitigation"  value={pct(d.mitPct, 1)} highlight={d.mitPct >= 30} />
            <CsRow label="Dodge"       value={pct(d.dodge)} />
          </CsSection>

          {/* ── Regeneration ── */}
          {hasMana && (
            <CsSection label="Regeneration">
              <CsRow label="Mana Regen" value={`${d.manaRegen} / turn`} />
            </CsSection>
          )}

          {/* ── Resistances ── */}
          <CsSection label="Resistances">
            <div className="cs-res-grid">
              {[['Pyro', resist.pyro],['Cryo', resist.cryo],['Nature', resist.nature],['Chaos', resist.chaos],['Order', resist.order],['Bio', resist.bio],['Energy', resist.energy],['Psychic', resist.psychic]].map(([label, val]) => (
                <div key={label} className={`cs-res-cell${val > 0 ? ' cs-res-on' : ''}`}>
                  <span className="cs-res-label">{label}</span>
                  <span className="cs-res-val">{val}</span>
                </div>
              ))}
            </div>
          </CsSection>

          {/* ── Effects ── */}
          {activeBuffs.length > 0 && (
            <CsSection label="Effects">
              <div className="effect-list">
                {buffs.map((e, i)   => <EffectRow key={`b${i}`} entry={e} buffCatalog={buffCatalog} />)}
                {debuffs.map((e, i) => <EffectRow key={`d${i}`} entry={e} buffCatalog={buffCatalog} />)}
              </div>
            </CsSection>
          )}

          {/* ── Skills ── */}
          {Object.keys(skillsView).length > 0 && (
            <CsSection label="Skills">
              <div className="char-skills">
                {Object.entries(skillsView).map(([k, sk]) => {
                  const name   = sk.name || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  const lvlPct = Math.min(100, (sk.level / skillMax) * 100)
                  const xpPct  = sk.atMax ? 100 : Math.min(100, (sk.xp / sk.xpToNext) * 100)
                  return (
                    <div key={k} className="cs-skill">
                      <div className="cs-skill-head">
                        <span className="cs-skill-name">{name}</span>
                        <span className="cs-skill-lv">Lv {sk.level}</span>
                      </div>
                      <div className="cs-skill-bar">
                        <div className="cs-skill-track">
                          <div className="cs-skill-fill cs-skill-level" style={{ width: `${lvlPct}%` }} />
                        </div>
                        <span className="cs-skill-bar-label">{sk.level} / {skillMax}</span>
                      </div>
                      <div className="cs-skill-bar">
                        <div className="cs-skill-track">
                          <div className="cs-skill-fill cs-skill-xp" style={{ width: `${xpPct}%` }} />
                        </div>
                        <span className="cs-skill-bar-label">{sk.atMax ? 'MAX' : `${sk.xp} / ${sk.xpToNext} xp`}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CsSection>
          )}

          {/* ── Profession ── */}
          {inst.profession && inst.profession !== 'none' && (
            <CsSection label="Profession">
              <div className="member-prof">
                {inst.profession.replace(/\b\w/g, c => c.toUpperCase())}
                {skillsView[inst.profession] ? ` (Lv ${skillsView[inst.profession].level})` : ''}
              </div>
            </CsSection>
          )}

        </div>

        {/* ── Equipment ── */}
        <div className="char-sheet-right">
          <div className="char-section-label">Equipment</div>
          <div className="gear-slots">
            {DISPLAY_SLOTS.map(slot => {
              const itemId    = gear[slot]
              const isOpen    = openSlot === slot
              const slotItems = isOpen ? getSlotItems(slot) : null

              return (
                <div
                  key={slot}
                  className={`gear-row ${itemId ? 'gear-filled' : 'gear-empty'}${isOpen ? ' gear-row-open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTip(null)
                    setOpenSlot(s => s === slot ? null : slot)
                  }}
                  onMouseEnter={itemId && !isOpen ? (e) => setTip({ item: buildTipItem(itemId, itemCatalog), ...tipPos(e) }) : undefined}
                  onMouseMove={itemId && !isOpen  ? (e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev) : undefined}
                  onMouseLeave={itemId ? () => setTip(null) : undefined}
                >
                  <span className="gear-slot-label">{SLOT_LABEL[slot]}</span>
                  <span className="gear-item-name">
                    {itemId
                      ? (itemCatalog[itemId]?.name || itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
                      : '—'}
                  </span>
                  {isOpen && (
                    <div className="equip-popup" onClick={e => e.stopPropagation()}>
                      {slotItems.length === 0
                        ? <div className="equip-popup-empty">Nothing to equip</div>
                        : slotItems.map(e => {
                            const def     = itemCatalog[e.itemId]
                            const name    = def?.name || e.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                            const quality = (e.quality || def?.quality || 'common').toLowerCase()
                            return (
                              <button
                                key={e.itemId}
                                className={`equip-popup-item q-${quality}`}
                                onClick={() => { onEquip?.(e.itemId, inst.instanceId); setOpenSlot(null) }}
                              >
                                <span className="equip-popup-name">{name}</span>
                                {e.qty > 1 && <span className="equip-popup-qty">×{e.qty}</span>}
                              </button>
                            )
                          })
                      }
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {tip && !openSlot && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}

const PET_CLASSES = new Set(['hunter', 'warlock'])

const PET_ROLE_LABEL = {
  dps: 'DPS', tank: 'Tank', caster: 'Caster', ranged_dps: 'Ranged', utility: 'Utility',
}

function PetSelector({ inst }) {
  const [petData, setPetData] = useState(null)

  useEffect(() => {
    if (!inst?.instanceId) return
    window.gameAPI.getAvailablePets(inst.instanceId).then(setPetData)
  }, [inst?.instanceId])

  const handleSelect = async (petId) => {
    const next = petData?.activePetId === petId ? null : petId
    await window.gameAPI.setPetForCompanion(inst.instanceId, next)
    const updated = await window.gameAPI.getAvailablePets(inst.instanceId)
    setPetData(updated)
  }

  if (!petData) return <div className="panel-empty">Loading pets…</div>

  const { activePetId, pets } = petData

  return (
    <div className="pet-selector">
      <div className="cs-section-label">Combat Pet</div>
      <div className="pet-hint">
        {activePetId
          ? `Active: ${pets.find(p => p.id === activePetId)?.name ?? activePetId}. Click to deselect or switch.`
          : 'Select a pet to summon it into your next combat.'}
      </div>
      <div className="pet-list">
        {pets.map(p => {
          const isActive  = p.id === activePetId
          const isLocked  = !p.unlocked
          return (
            <div
              key={p.id}
              className={`pet-card${isActive ? ' pet-active' : ''}${isLocked ? ' pet-locked' : ''}`}
              onClick={() => !isLocked && handleSelect(p.id)}
            >
              <div className="pet-card-header">
                <span className="pet-card-name">{p.name}</span>
                <span className="pet-card-role">{PET_ROLE_LABEL[p.role] ?? p.role}</span>
                {isActive && <span className="pet-card-badge">Active</span>}
              </div>
              <div className="pet-card-type">{p.type} · {p.aiProfile}</div>
              {isLocked
                ? <div className="pet-card-locked">Requires Level {p.unlockLevel}</div>
                : <div className="pet-card-desc">{p.description}</div>
              }
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function CharacterScreen({ partyInstances, itemCatalog, buffCatalog, inventory = [], onEquip, currency = 0, onRez, onAllocate }) {
  const [index, setIndex] = useState(0)
  const [view,  setView]  = useState('sheet')

  if (!partyInstances || partyInstances.length === 0) {
    return <div className="character-screen"><div className="panel-empty">No party members.</div></div>
  }

  const clampedIndex = Math.min(index, partyInstances.length - 1)
  const inst  = partyInstances[clampedIndex]
  const total = partyInstances.length
  const hasPets = PET_CLASSES.has(inst?.classId)

  return (
    <div className="character-screen">
      <div className="char-nav">
        <button className="char-nav-btn" disabled={clampedIndex === 0} onClick={() => setIndex(i => Math.max(0, i - 1))}>{'‹'}</button>
        <span className="char-nav-label">{inst.name} <span className="char-nav-count">({clampedIndex + 1} / {total})</span></span>
        <button className="char-nav-btn" disabled={clampedIndex === total - 1} onClick={() => setIndex(i => Math.min(total - 1, i + 1))}>{'›'}</button>
      </div>

      <div className="char-view-toggle">
        <button className={`char-view-btn${view === 'sheet'  ? ' active' : ''}`} onClick={() => setView('sheet')}>Stats</button>
        <button className={`char-view-btn${view === 'spells' ? ' active' : ''}`} onClick={() => setView('spells')}>Spellbook</button>
        {hasPets && (
          <button className={`char-view-btn${view === 'pet' ? ' active' : ''}`} onClick={() => setView('pet')}>Pet</button>
        )}
      </div>

      {view === 'sheet'  && <CharacterSheet inst={inst} itemCatalog={itemCatalog} buffCatalog={buffCatalog} inventory={inventory} onEquip={onEquip} currency={currency} onRez={onRez} onAllocate={onAllocate} />}
      {view === 'spells' && <SpellBook key={clampedIndex} inst={inst} />}
      {view === 'pet'    && <PetSelector key={inst.instanceId} inst={inst} />}
    </div>
  )
}
