import React, { useEffect, useRef } from 'react'

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

export default function CombatLog({ messages }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="combat-log">
      {messages.length === 0 ? (
        <div className="log-empty-state">Waiting for adventure…</div>
      ) : (
        messages.map((line, i) => (
          <div key={i} className={`log-line ${classifyLine(line)}`}>
            {line || ' '}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}
