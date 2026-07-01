import React from 'react'
import { formatCurrency } from '../currency'
import type { TravelZoneView } from '../../../Engine/types/viewmodel'

const TYPE_LABEL: Record<string, string> = { combat: 'Combat', shop: 'Shop', dungeon: 'Dungeon', unknown: '?' }
const TYPE_CLASS: Record<string, string> = { combat: 'zone-combat', shop: 'zone-shop', dungeon: 'zone-dungeon', unknown: '' }

// Travel cost shows only the largest coin unit; free/unknown travel renders nothing.
const fmtCost = (copper: number | null | undefined) => formatCurrency(copper, { compact: true, empty: null, zero: null })

function regionLabel(r: string | null | undefined) {
  if (!r) return 'Unknown'
  return r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function ZoneBtn({ zone, onSelectZone }: { zone: any; onSelectZone: (id: string) => void }) {
  const cost = fmtCost(zone.travelCost ?? 0)
  return (
    <button
      className={`zone-card zone-btn ${TYPE_CLASS[zone.type] ?? ''}`}
      onClick={() => onSelectZone(zone.id)}
    >
      <div className="zone-name">{zone.name}</div>
      <div className="zone-meta">
        <span className="zone-type-tag">{TYPE_LABEL[zone.type] ?? zone.type}</span>
        <span className="zone-level">Lv {zone.minLevel}–{zone.maxLevel}</span>
        {cost && <span className="zone-travel-cost">✦ {cost}</span>}
      </div>
    </button>
  )
}

export default function DungeonMap({
  currentZone, zoneData, travelZones,
  onSelectZone,
  filterTypes = null,
  showCurrent = true,
}: { currentZone?: string; zoneData?: any; travelZones?: TravelZoneView[]; onSelectZone: (id: string) => void; filterTypes?: string[] | null; showCurrent?: boolean }) {
  const allZones = filterTypes
    ? (travelZones || []).filter(z => filterTypes.includes(z.type ?? ''))
    : (travelZones || [])

  // Split: same-region (free) vs cross-region (grouped by region)
  const nearby = allZones.filter(z => (z.travelCost ?? 0) === 0)
  const crossRegion = allZones.filter(z => (z.travelCost ?? 0) > 0)

  // Group cross-region zones by their region
  const regionGroups: Record<string, any[]> = {}
  for (const z of crossRegion) {
    const key = z.region || 'unknown'
    if (!regionGroups[key]) regionGroups[key] = []
    regionGroups[key].push(z)
  }
  const regionEntries = Object.entries(regionGroups).sort(([, a], [, b]) =>
    (a[0]?.minLevel ?? 0) - (b[0]?.minLevel ?? 0)
  )

  return (
    <div className="dungeon-map">
      {zoneData && showCurrent ? (
        <div className="map-current">
          <div className="map-section-label">Current Location</div>
          <div className={`zone-card current-zone ${TYPE_CLASS[zoneData.type] ?? ''}`}>
            <div className="zone-name">{zoneData.name}</div>
            <div className="zone-meta">
              <span className="zone-type-tag">{TYPE_LABEL[zoneData.type] ?? zoneData.type}</span>
              <span className="zone-level">Lv {zoneData.minLevel}–{zoneData.maxLevel}</span>
              <span className="zone-region">{regionLabel(zoneData.region)}</span>
            </div>
            {zoneData.lore && <div className="zone-lore">{zoneData.lore}</div>}
          </div>
        </div>
      ) : !zoneData ? (
        <div className="panel-empty">No zone data loaded.</div>
      ) : null}

      {nearby.length > 0 && (
        <div className="map-exits">
          <div className="map-section-label">{regionLabel(zoneData?.region)} — Free</div>
          <div className="zone-list">
            {nearby.map(zone => <ZoneBtn key={zone.id} zone={zone} onSelectZone={onSelectZone} />)}
          </div>
        </div>
      )}

      {regionEntries.map(([regionKey, zones]) => (
        <div key={regionKey} className="map-exits map-exits-region">
          <div className="map-section-label map-region-header">
            {regionLabel(regionKey)}
            <span className="map-region-cost-hint">✦ Travel fee</span>
          </div>
          <div className="zone-list">
            {zones.map((zone: any) => <ZoneBtn key={zone.id} zone={zone} onSelectZone={onSelectZone} />)}
          </div>
        </div>
      ))}

      {allZones.length === 0 && zoneData && (
        <div className="panel-empty">No locations available.</div>
      )}
    </div>
  )
}
