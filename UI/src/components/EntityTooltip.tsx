import React from 'react'

// Hover tooltip for non-item entities referenced in the combat log:
// abilities, characters (party + enemies), zones, and regions.
const TYPE_LABEL: Record<string, string> = { ability: 'Ability', character: 'Character', zone: 'Zone', region: 'Region' }

function costText(resourceCost: Record<string, number> | null | undefined) {
  if (!resourceCost) return null
  const parts = Object.entries(resourceCost).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`)
  return parts.length ? parts.join(' · ') : null
}

export default function EntityTooltip({ entry, x, y }: { entry: any; x: number; y: number }) {
  if (!entry) return null
  const { type, name, data = {} } = entry
  const title = (name || entry.id || '').replace(/_/g, ' ')

  const lines: string[] = []
  if (type === 'ability') {
    lines.push(data.passive ? 'Passive' : 'Active ability')
    const c = costText(data.resourceCost)
    if (c) lines.push(`Cost: ${c}`)
    if (data.cooldown > 0) lines.push(`Cooldown: ${data.cooldown}t`)
    if (data.tags?.length) lines.push(data.tags.join(', '))
  } else if (type === 'character') {
    // Party instances carry classId/raceId/level; mobs carry a creature type.
    if (data.classId) lines.push(`${data.raceId ? data.raceId + ' ' : ''}${data.classId}${data.level ? ` · Lv ${data.level}` : ''}`)
    else if (data.type) lines.push(data.type)
  } else if (type === 'zone') {
    if (data.zoneType) lines.push(data.zoneType)
    if (data.regionId) lines.push(`Region: ${String(data.regionId).replace(/_/g, ' ')}`)
    if (data.minLevel != null) lines.push(`Level ${data.minLevel}${data.maxLevel != null && data.maxLevel !== data.minLevel ? `–${data.maxLevel}` : ''}`)
  }

  const desc = type === 'ability' ? data.description : type === 'zone' ? data.lore : null

  return (
    <div className={`entity-tooltip et-${type}`} style={{ left: x, top: y }}>
      <div className="entity-tooltip-name">{title}</div>
      <div className="entity-tooltip-kind">{TYPE_LABEL[type] || type}</div>
      {lines.map((l, i) => <div key={i} className="entity-tooltip-line">{l}</div>)}
      {desc && <div className="entity-tooltip-desc">"{desc}"</div>}
    </div>
  )
}
