import React, { useState, useEffect } from 'react'
import ItemTooltip, { buildTipItem } from './ItemTooltip.jsx'
import { formatCurrency as baseFormatCurrency } from '../currency.js'

// Missing prices render as an em dash; 0 still shows "0c".
const formatCurrency = (copper) => baseFormatCurrency(copper, { empty: '—' })

const QUALITY_CLASS = {
  poor: 'q-poor', common: 'q-common', uncommon: 'q-uncommon',
  rare: 'q-rare', epic: 'q-epic', legendary: 'q-legendary',
}

const SLOT_LABEL = {
  mainhand: 'Main Hand', offhand: 'Off Hand', ranged: 'Ranged',
  head: 'Head', chest: 'Chest', legs: 'Legs', feet: 'Feet',
  hands: 'Hands', waist: 'Waist', wrist: 'Wrist', back: 'Back',
  neck: 'Neck', ring: 'Ring', trinket: 'Trinket', ammo: 'Ammo',
  shoulders: 'Shoulders', none: '—',
}

const WEAPON_LABEL = {
  sword_1h: 'One-Handed Sword', sword_2h: 'Two-Handed Sword',
  axe_1h: 'One-Handed Axe', axe_2h: 'Two-Handed Axe',
  mace_1h: 'One-Handed Mace', mace_2h: 'Two-Handed Mace',
  dagger: 'Dagger', fist: 'Fist Weapon', staff: 'Staff',
  polearm: 'Polearm', wand: 'Wand', bow: 'Bow',
  crossbow: 'Crossbow', gun: 'Gun', thrown: 'Thrown',
}

function StatLine({ statBonuses }) {
  if (!statBonuses) return null
  const entries = Object.entries(statBonuses).filter(([, v]) => v !== 0)
  if (!entries.length) return null
  return (
    <div className="shop-item-stats">
      {entries.map(([k, v]) => (
        <span key={k} className="shop-stat-chip">+{v} {k}</span>
      ))}
    </div>
  )
}

function tipPos(e) {
  const x = e.clientX + 14 + 240 > window.innerWidth ? e.clientX - 254 : e.clientX + 14
  return { x, y: e.clientY - 8 }
}

function BuyRow({ entry, currency, itemCatalog, onBuy, loading }) {
  const [tip, setTip] = useState(null)
  const canAfford = currency >= entry.buyPrice
  const qualityCls = QUALITY_CLASS[entry.quality] || ''

  return (
    <div
      className={`shop-row ${!canAfford ? 'shop-row-poor' : ''}`}
      onMouseEnter={(e) => setTip({
        item: buildTipItem(entry.itemId, itemCatalog, { name: entry.name }),
        ...tipPos(e),
      })}
      onMouseMove={(e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev)}
      onMouseLeave={() => setTip(null)}
    >
      <div className="shop-row-main">
        <div className="shop-item-header">
          <span className={`shop-item-name ${qualityCls}`}>{entry.name}</span>
          {entry.itemLevel && (
            <span className="shop-item-ilvl">ilvl {entry.itemLevel}</span>
          )}
          {entry.reqLevel && (
            <span className="shop-item-req">Req {entry.reqLevel}</span>
          )}
        </div>
        <div className="shop-item-meta">
          {entry.slot && entry.slot !== 'none' && (
            <span className="shop-meta-tag">{SLOT_LABEL[entry.slot] || entry.slot}</span>
          )}
          {entry.weaponType && (
            <span className="shop-meta-tag">{WEAPON_LABEL[entry.weaponType] || entry.weaponType}</span>
          )}
          {entry.itemType === 'armor' && !entry.weaponType && entry.slot !== 'none' && (
            <span className="shop-meta-tag">{entry.tags?.includes('shield') ? 'Shield' : entry.tags?.includes('mail') ? 'Mail' : 'Armor'}</span>
          )}
          {entry.description && (
            <span className="shop-item-desc">{entry.description}</span>
          )}
        </div>
        <StatLine statBonuses={entry.statBonuses} />
      </div>
      <div className="shop-row-right">
        <div className={`shop-price ${canAfford ? 'shop-price-ok' : 'shop-price-poor'}`}>
          {formatCurrency(entry.buyPrice)}
        </div>
        {entry.stock !== -1 && (
          <div className="shop-stock">[{entry.stock}]</div>
        )}
        <button
          className="btn btn-sm btn-buy"
          onClick={() => onBuy(entry.itemId, 1)}
          disabled={loading || !canAfford || entry.stock === 0}
        >
          {entry.quantity > 1 ? `Buy ×${entry.quantity}` : 'Buy'}
        </button>
      </div>
      {tip && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}

function SellRow({ entry, itemCatalog, onSell, loading }) {
  const [tip, setTip] = useState(null)
  const qualityCls = QUALITY_CLASS[entry.quality] || ''

  return (
    <div
      className="shop-row"
      onMouseEnter={(e) => setTip({
        item: buildTipItem(entry.itemId, itemCatalog, { sellValue: entry.sellValue, value: undefined }),
        ...tipPos(e),
      })}
      onMouseMove={(e) => setTip(prev => prev ? { ...prev, ...tipPos(e) } : prev)}
      onMouseLeave={() => setTip(null)}
    >
      <div className="shop-row-main">
        <div className="shop-item-header">
          <span className={`shop-item-name ${qualityCls}`}>{entry.name}</span>
          <span className="shop-item-qty">×{entry.qty}</span>
        </div>
      </div>
      <div className="shop-row-right">
        <div className="shop-price shop-price-ok">{formatCurrency(entry.sellValue)}</div>
        <button
          className="btn btn-sm btn-sell"
          onClick={() => onSell(entry.itemId, 1)}
          disabled={loading}
        >
          Sell
        </button>
      </div>
      {tip && <ItemTooltip item={tip.item} x={tip.x} y={tip.y} />}
    </div>
  )
}

export default function ShopPanel({ shopData, currency, itemCatalog, onBuy, onSell, loading }) {
  const [tab, setTab] = useState('buy')
  const keeperNames = Object.keys(shopData?.shopkeepers || {})
  const [selectedKeeper, setSelectedKeeper] = useState(keeperNames[0] ?? null)

  useEffect(() => {
    const names = Object.keys(shopData?.shopkeepers || {})
    setSelectedKeeper(names[0] ?? null)
    setTab('buy')
  }, [shopData])

  if (!shopData) {
    return <div className="shop-panel"><div className="panel-empty">No shop data.</div></div>
  }

  const { zoneName, minLevel, maxLevel, sellMultiplier, shopkeepers = {}, sellList = [] } = shopData
  const inventory = selectedKeeper ? (shopkeepers[selectedKeeper]?.inventory ?? []) : []
  const handleBuy = (itemId, qty) => onBuy(itemId, qty, selectedKeeper)

  return (
    <div className="shop-panel">
      <div className="shop-header">
        <div className="shop-header-left">
          <span className="panel-title">{zoneName}</span>
          {minLevel != null && maxLevel != null && (
            <span className="zone-level">Lv {minLevel}–{maxLevel}</span>
          )}
        </div>
        <div className="shop-header-right">
          <span className="shop-sell-rate">Sell: {Math.round(sellMultiplier * 100)}%</span>
          <span className="inv-currency">{formatCurrency(currency)}</span>
        </div>
      </div>

      {keeperNames.length > 1 && (
        <div className="shop-tabs shop-keeper-tabs">
          {keeperNames.map(name => (
            <button
              key={name}
              className={`shop-tab-btn ${name === selectedKeeper ? 'active' : ''}`}
              onClick={() => setSelectedKeeper(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="shop-tabs">
        <button
          className={`shop-tab-btn ${tab === 'buy' ? 'active' : ''}`}
          onClick={() => setTab('buy')}
        >
          Buy
        </button>
        <button
          className={`shop-tab-btn ${tab === 'sell' ? 'active' : ''}`}
          onClick={() => setTab('sell')}
        >
          Sell
        </button>
      </div>

      <div className="shop-list">
        {tab === 'buy' && (
          !selectedKeeper || inventory.length === 0
            ? <div className="panel-empty">Nothing for sale.</div>
            : inventory.map(entry => (
                <BuyRow
                  key={entry.itemId}
                  entry={entry}
                  currency={currency}
                  itemCatalog={itemCatalog}
                  onBuy={handleBuy}
                  loading={loading}
                />
              ))
        )}

        {tab === 'sell' && (
          !sellList?.length
            ? <div className="panel-empty">Nothing to sell.</div>
            : sellList.map(entry => (
                <SellRow
                  key={entry.itemId}
                  entry={entry}
                  itemCatalog={itemCatalog}
                  onSell={onSell}
                  loading={loading}
                />
              ))
        )}
      </div>
    </div>
  )
}
