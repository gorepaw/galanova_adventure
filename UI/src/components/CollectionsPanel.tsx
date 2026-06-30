import React, { useState } from 'react'
import mobsData from '../../../Data/mobs.json'

const MOB_NAMES = Object.fromEntries(
  Object.entries(mobsData.mobs || {}).map(([id, m]) => [id, m.name || id])
)

export default function CollectionsPanel({ collections = {}, itemCatalog = {} }) {
  const [tab, setTab] = useState('kills')

  const kills = collections.kills || {}
  const items = collections.items || {}

  const killEntries = Object.entries(kills)
    .map(([id, count]) => ({ id, name: MOB_NAMES[id] || id.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count)

  const itemEntries = Object.entries(items)
    .map(([id, count]) => ({ id, name: itemCatalog[id]?.name || id.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="collections-panel">
      <div className="col-tabs">
        <button className={`col-tab-btn${tab === 'kills' ? ' active' : ''}`} onClick={() => setTab('kills')}>
          Kills <span className="col-count">({killEntries.length})</span>
        </button>
        <button className={`col-tab-btn${tab === 'items' ? ' active' : ''}`} onClick={() => setTab('items')}>
          Items <span className="col-count">({itemEntries.length})</span>
        </button>
      </div>

      <div className="col-list">
        {tab === 'kills' && (
          killEntries.length === 0
            ? <div className="panel-empty">No kills recorded yet.</div>
            : killEntries.map(({ id, name, count }) => (
                <div key={id} className="col-row">
                  <span className="col-row-name">{name}</span>
                  <span className="col-row-count">×{count.toLocaleString()}</span>
                </div>
              ))
        )}
        {tab === 'items' && (
          itemEntries.length === 0
            ? <div className="panel-empty">No items collected yet.</div>
            : itemEntries.map(({ id, name, count }) => (
                <div key={id} className="col-row">
                  <span className="col-row-name">{name}</span>
                  <span className="col-row-count">×{count.toLocaleString()}</span>
                </div>
              ))
        )}
      </div>
    </div>
  )
}
