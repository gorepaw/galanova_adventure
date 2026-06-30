import React from 'react'

function getTier(val) {
  if (val >= 75) return { label: 'Exalted',  cls: 'rep-exalted'  }
  if (val >= 50) return { label: 'Revered',  cls: 'rep-revered'  }
  if (val >= 25) return { label: 'Honored',  cls: 'rep-honored'  }
  if (val >= 0)  return { label: 'Friendly', cls: 'rep-friendly' }
  return               { label: 'Hostile',  cls: 'rep-hostile'  }
}

function pct(val) {
  // Map each tier bracket to 0-100% within that bracket
  if (val >= 75) return Math.min(100, ((val - 75) / 25) * 100)
  if (val >= 50) return ((val - 50) / 25) * 100
  if (val >= 25) return ((val - 25) / 25) * 100
  if (val >= 0)  return (val / 25) * 100
  return Math.max(0, ((val + 100) / 100) * 100)
}

export default function ReputationPanel({ reputation = {} }) {
  const entries = Object.entries(reputation)

  if (!entries.length) {
    return <div className="panel-empty">No faction reputations yet.</div>
  }

  return (
    <div className="reputation-panel">
      <div className="rep-list">
        {entries.map(([factionId, val]) => {
          const tier = getTier(val)
          return (
            <div key={factionId} className="rep-row">
              <div className="rep-row-header">
                <span className="rep-name">{factionId.replace(/_/g, ' ')}</span>
                <span className={`rep-tier ${tier.cls}`}>{tier.label}</span>
              </div>
              <div className="rep-track">
                <div className={`rep-fill ${tier.cls}`} style={{ width: `${pct(val)}%` }} />
              </div>
              <span className="rep-val">{val}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
