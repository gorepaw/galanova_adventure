import React from 'react'

const QUALITY_CLASS = {
  poor: 'q-poor', common: 'q-common', uncommon: 'q-uncommon',
  rare: 'q-rare', epic: 'q-epic', legendary: 'q-legendary',
}

const SLOT_LABEL = {
  mainhand: 'Main Hand', offhand: 'Off Hand', ranged: 'Ranged',
  head: 'Head', chest: 'Chest', legs: 'Legs', feet: 'Feet',
  hands: 'Hands', waist: 'Waist', wrist: 'Wrist', back: 'Back',
  neck: 'Neck', ring: 'Ring', trinket: 'Trinket', ammo: 'Ammo',
  shoulders: 'Shoulders',
}

const WEAPON_LABEL = {
  sword_1h: 'One-Handed Sword', sword_2h: 'Two-Handed Sword',
  axe_1h: 'One-Handed Axe', axe_2h: 'Two-Handed Axe',
  mace_1h: 'One-Handed Mace', mace_2h: 'Two-Handed Mace',
  dagger: 'Dagger', fist: 'Fist Weapon', staff: 'Staff',
  polearm: 'Polearm', wand: 'Wand', bow: 'Bow',
  crossbow: 'Crossbow', gun: 'Gun', thrown: 'Thrown',
}

function formatCopper(copper) {
  if (copper == null || copper < 0) return null
  if (copper === 0) return '0c'
  const g = Math.floor(copper / 10000)
  const s = Math.floor((copper % 10000) / 100)
  const c = copper % 100
  const parts = []
  if (g > 0) parts.push(`${g}g`)
  if (s > 0) parts.push(`${s}s`)
  if (c > 0 || parts.length === 0) parts.push(`${c}c`)
  return parts.join(' ')
}

function describeOnUse(onUse) {
  if (!onUse) return null
  const parts = []
  if (onUse.type === 'heal') {
    const healAmt = onUse.percent ? `${Math.round(onUse.percent * 100)}% of` : onUse.minFlat != null ? `${onUse.minFlat}–${onUse.maxFlat}` : (onUse.flat ?? '?')
    parts.push(`Restores ${healAmt} health`)
  } else if (onUse.type === 'mana') {
    const manaAmt = onUse.percent ? `${Math.round(onUse.percent * 100)}% of` : onUse.minFlat != null ? `${onUse.minFlat}–${onUse.maxFlat}` : (onUse.flat ?? '?')
    parts.push(`Restores ${manaAmt} mana`)
  } else if (onUse.type === 'buff') {
    parts.push(`Applies ${onUse.buffId ?? 'a buff'}`)
  } else if (onUse.type === 'weapon_buff') {
    parts.push('Enchants weapon temporarily')
  }
  if (onUse.target === 'party') parts.push('(Party)')
  if (onUse.outOfCombatOnly) parts.push('(Out of Combat)')
  return parts.length ? parts.join(' ') : null
}

export function buildTipItem(itemId, catalog, overrides = {}) {
  const tpl = (catalog && catalog[itemId]) || {}
  const statBonuses = tpl.statBonuses && Object.keys(tpl.statBonuses).length > 0
    ? tpl.statBonuses : undefined
  return {
    name: tpl.name || itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    quality: tpl.quality,
    itemType: tpl.type,
    slot: tpl.slot,
    weaponType: tpl.weaponType,
    itemLevel: tpl.itemLevel,
    reqLevel: tpl.reqLevel,
    minDamage: tpl.minDamage,
    maxDamage: tpl.maxDamage,
    weaponSpeed: tpl.weaponSpeed,
    statBonuses,
    tags: tpl.tags,
    description: tpl.description,
    onUse: tpl.onUse,
    value: tpl.value,
    ...overrides,
  }
}

export default function ItemTooltip({ item, x, y }) {
  if (!item) return null

  const qualityCls = QUALITY_CLASS[item.quality] || 'q-common'
  const statEntries = item.statBonuses
    ? Object.entries(item.statBonuses).filter(([, v]) => v !== 0)
    : []
  const onUseText = describeOnUse(item.onUse)
  const sellCopper = item.sellValue ?? item.value
  const sellText = sellCopper != null ? formatCopper(sellCopper) : null

  const typeLabel = item.weaponType
    ? (WEAPON_LABEL[item.weaponType] || item.weaponType)
    : item.itemType === 'armor'
      ? (item.tags?.includes('shield') ? 'Shield'
        : item.tags?.includes('mail') ? 'Mail' : 'Armor')
      : item.itemType === 'consumable' ? 'Consumable'
      : item.itemType === 'material' ? 'Crafting Material'
      : null

  const hasTypeRow = (item.slot && item.slot !== 'none') || typeLabel

  return (
    <div className="item-tooltip" style={{ left: x, top: y }}>
      <div className={`tooltip-name ${qualityCls}`}>{item.name}</div>

      {(item.itemLevel || item.reqLevel) && (
        <div className="tooltip-meta-row">
          {item.itemLevel && <span>Item Level {item.itemLevel}</span>}
          {item.reqLevel && <span className="tooltip-req">Req. Level {item.reqLevel}</span>}
        </div>
      )}

      {hasTypeRow && (
        <div className="tooltip-type-row">
          {item.slot && item.slot !== 'none' && (
            <span>{SLOT_LABEL[item.slot] || item.slot}</span>
          )}
          {typeLabel && <span>{typeLabel}</span>}
        </div>
      )}

      {item.minDamage != null && item.maxDamage != null && (
        <div className="tooltip-damage">
          {item.minDamage}–{item.maxDamage} Damage
          {item.weaponSpeed != null && (
            <span className="tooltip-speed"> · {item.weaponSpeed.toFixed(1)} spd</span>
          )}
        </div>
      )}

      {statEntries.length > 0 && (
        <div className="tooltip-stats">
          {statEntries.map(([k, v]) => (
            <div key={k} className="tooltip-stat">+{v} {k}</div>
          ))}
        </div>
      )}

      {item.description && (
        <div className="tooltip-desc">"{item.description}"</div>
      )}

      {onUseText && (
        <div className="tooltip-use">Use: {onUseText}</div>
      )}

      {item.note && (
        <div className="tooltip-note">{item.note}</div>
      )}

      {sellText != null && (
        <div className="tooltip-sell">Sell: {sellText}</div>
      )}
    </div>
  )
}
