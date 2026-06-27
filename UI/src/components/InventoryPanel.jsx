import React, { useState } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip.jsx'

function formatCurrency(copper) {
  if (!copper) return '0c'
  const g = Math.floor(copper / 10000)
  const s = Math.floor((copper % 10000) / 100)
  const c = copper % 100
  const parts = []
  if (g > 0) parts.push(`${g}g`)
  if (s > 0) parts.push(`${s}s`)
  if (c > 0 || parts.length === 0) parts.push(`${c}c`)
  return parts.join(' ')
}

const USABLE = new Set([
  'minor_health_potion', 'rough_bandage', 'ember_shard',
])

const QUALITY_CLASS = {
  poor: 'q-poor', common: 'q-common', uncommon: 'q-uncommon',
  rare: 'q-rare', epic: 'q-epic', legendary: 'q-legendary',
}

const SLOT_ICON = {
  mainhand: '⚔', offhand: '🛡', head: '⛑', chest: '👕',
  legs: '👖', feet: '👟', hands: '🧤', waist: '🎽',
  back: '🧣', wrist: '📿', neck: '📿', ring: '💍',
  trinket: '🔮', ranged: '🏹',
}

function tipPos(e) {
  const x = e.clientX + 14 + 240 > window.innerWidth ? e.clientX - 254 : e.clientX + 14
  return { x, y: e.clientY - 8 }
}

export default function InventoryPanel({ inventory, currency, isShopZone, itemCatalog, onUse, onSell, onEquip }) {
  const [tip, setTip] = useState(null)

  return (
    <div className="inventory-panel">
      <div className="inv-header">
        <span className="panel-title">Bag</span>
        <span className="inv-currency">{formatCurrency(currency)}</span>
      </div>

      {inventory.length === 0 ? (
        <div className="panel-empty">Bag is empty.</div>
      ) : (
        <div className="inv-list">
          {inventory.map(entry => {
            const isEquipment = entry.itemType === 'weapon' || entry.itemType === 'armor'
            const qualityCls = QUALITY_CLASS[entry.quality] || ''
            const slotIcon = SLOT_ICON[entry.slot] || '📦'
            return (
              <div
                key={entry.itemId}
                className="inv-row"
                onMouseEnter={(e) => setTip({ item: buildTipItem(entry.itemId, itemCatalog), ...tipPos(e) })}
                onMouseMove={(e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev)}
                onMouseLeave={() => setTip(null)}
              >
                <div className="inv-icon">{isEquipment ? slotIcon : '📦'}</div>
                <div className={`inv-name ${qualityCls}`}>{entry.name || entry.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</div>
                <div className="inv-qty">×{entry.qty}</div>
                <div className="inv-actions">
                  {isEquipment && (
                    <button className="btn btn-sm btn-equip" onClick={() => onEquip(entry.itemId)}>
                      Equip
                    </button>
                  )}
                  {USABLE.has(entry.itemId) && (
                    <button className="btn btn-sm btn-use" onClick={() => onUse(entry.itemId)}>
                      Use
                    </button>
                  )}
                  {isShopZone && (
                    <button className="btn btn-sm btn-sell" onClick={() => onSell(entry.itemId)}>
                      Sell
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tip && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}
