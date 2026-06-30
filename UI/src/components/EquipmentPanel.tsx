import React, { useState } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip'

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

function tipPos(e) {
  const x = e.clientX + 14 + 240 > window.innerWidth ? e.clientX - 254 : e.clientX + 14
  return { x, y: e.clientY - 8 }
}

function GearSheet({ inst, itemCatalog }) {
  if (!inst) return null
  const gear = inst.gear || {}
  const [tip, setTip] = useState<any>(null)

  return (
    <div className="gear-sheet">
      <div className="gear-header">
        <span className="gear-name">{inst.name}</span>
        <span className="gear-class">{inst.raceId} {inst.classId} Lv{inst.level ?? 1}</span>
      </div>
      <div className="gear-slots">
        {DISPLAY_SLOTS.map(slot => {
          const itemId = gear[slot]
          return (
            <div
              key={slot}
              className={`gear-row ${itemId ? 'gear-filled' : 'gear-empty'}`}
              onMouseEnter={itemId ? (e) => setTip({ item: buildTipItem(itemId, itemCatalog), ...tipPos(e) }) : undefined}
              onMouseMove={itemId ? (e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev) : undefined}
              onMouseLeave={itemId ? () => setTip(null) : undefined}
            >
              <span className="gear-slot-label">{SLOT_LABEL[slot]}</span>
              <span className="gear-item-name">{itemId ? (itemCatalog[itemId]?.name || itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) : '—'}</span>
            </div>
          )
        })}
      </div>
      {tip && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}

export default function EquipmentPanel({ partyInstances, itemCatalog }) {
  if (!partyInstances || partyInstances.length === 0) {
    return <div className="equipment-panel"><div className="panel-empty">No party members.</div></div>
  }

  return (
    <div className="equipment-panel">
      {partyInstances.map(inst => (
        <GearSheet key={inst.instanceId} inst={inst} itemCatalog={itemCatalog} />
      ))}
    </div>
  )
}
