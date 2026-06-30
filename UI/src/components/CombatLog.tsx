import React, { useEffect, useRef, useState, useMemo } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip'
import EntityTooltip from './EntityTooltip'
import { buildMatcher, tokenizeLine } from '../logTokenizer'

function classifyLine(line) {
  if (!line) return 'log-empty'
  const t = line.trim()
  if (t.startsWith('──') || t.startsWith('─')) return 'log-divider'
  if (t.startsWith('HOME') || t.startsWith('Welcome')) return 'log-header'
  if (t.startsWith('ERROR') || t.startsWith('✗')) return 'log-error'
  if (t.startsWith('✓') || t.includes('saved') || t.includes('Saved')) return 'log-success'
  if (t.includes('VICTORY') || t.includes('joined the party')) return 'log-victory'
  if (t.includes('DEFEAT') || t.includes('WIPE') || t.includes('DEAD') || t.includes('💀')) return 'log-defeat'
  if (t.startsWith('XP gained') || t.startsWith('Currency') || t.startsWith('Loot') || t.includes('Level UP')) return 'log-reward'
  if (t.includes('damage') || t.includes('hit') || t.includes('miss') || t.includes('crit')) return 'log-combat'
  if (t.includes('🐾') || t.includes('🏪') || t.includes('⚡') || t.includes('🤝')) return 'log-event'
  return 'log-default'
}

const spaces = (s) => s.replace(/_/g, ' ')

function buildEntries(itemCatalog, entityCatalog, partyInstances) {
  const entries: any[] = []
  const ec = entityCatalog || {}
  for (const [id, def] of Object.entries<any>(itemCatalog || {})) {
    if (id.startsWith('_')) continue
    entries.push({ type: 'item', id, name: def?.name || id, data: def })
  }
  for (const [id, def] of Object.entries<any>(ec.abilities || {})) entries.push({ type: 'ability',   id, name: def.name, data: def })
  for (const [id, def] of Object.entries<any>(ec.zones || {}))     entries.push({ type: 'zone',      id, name: def.name, data: def })
  for (const [id, def] of Object.entries<any>(ec.regions || {}))   entries.push({ type: 'region',    id, name: def.name, data: def })
  for (const [id, def] of Object.entries<any>(ec.mobs || {}))      entries.push({ type: 'character', id, name: def.name, data: def })
  for (const inst of (partyInstances || [])) entries.push({ type: 'character', id: inst.instanceId, name: inst.name, data: inst })
  return entries
}

export default function CombatLog({ messages, itemCatalog = {}, entityCatalog = null, partyInstances = [] }: any) {
  const bottomRef = useRef<any>(null)
  const [tip, setTip] = useState<any>(null)

  // Party names rarely change, but partyInstances is a fresh array every snapshot.
  // Key the (potentially large) matcher on a stable signature so the trie is only
  // rebuilt when the catalogs load or the roster/names actually change.
  const partyKey = (partyInstances || []).map(p => `${p.instanceId}:${p.name}`).join('|')
  const matcher = useMemo(
    () => buildMatcher(buildEntries(itemCatalog, entityCatalog, partyInstances)),
    [itemCatalog, entityCatalog, partyKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const onTip = (entry: any, e?: any) => {
    if (!entry) { setTip(null); return }
    const x = e.clientX + 14 + 260 > window.innerWidth ? e.clientX - 274 : e.clientX + 14
    setTip({ entry, x, y: e.clientY - 8 })
  }

  const renderParts = (line) =>
    tokenizeLine(line, matcher).map((part, i) => {
      if (part.kind === 'text') return spaces(part.text)
      const { entry } = part
      return (
        <span
          key={i}
          className={`log-entity log-entity-${entry.type}`}
          onMouseEnter={(e) => onTip(entry, e)}
          onMouseMove={(e) => onTip(entry, e)}
          onMouseLeave={() => onTip(null)}
        >
          {spaces(entry.name || part.raw).toUpperCase()}
        </span>
      )
    })

  return (
    <div className="combat-log">
      {messages.length === 0 ? (
        <div className="log-empty-state">Waiting for adventure…</div>
      ) : (
        messages.map((line, i) => (
          <div key={i} className={`log-line ${classifyLine(line)}`}>
            {renderParts(line)}
          </div>
        ))
      )}
      <div ref={bottomRef} />
      {tip && (tip.entry.type === 'item'
        ? <ItemTooltip item={buildTipItem(tip.entry.id, itemCatalog)} x={tip.x} y={tip.y} />
        : <EntityTooltip entry={tip.entry} x={tip.x} y={tip.y} />
      )}
    </div>
  )
}
