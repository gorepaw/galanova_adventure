// Shared currency formatting for the UI.
// Money is stored everywhere as a single total-copper integer.
// 1 platinum = 100 gold = 10,000 silver = 1,000,000 copper.

export function splitCurrency(copper) {
  return {
    platinum: Math.floor(copper / 1000000),
    gold:     Math.floor((copper % 1000000) / 10000),
    silver:   Math.floor((copper % 10000) / 100),
    copper:   copper % 100,
  }
}

// Format a copper amount as a coin string (e.g. "1p 2g 3s 4c").
//   empty   — returned for null / undefined / negative input (default '0c')
//   zero    — returned for exactly 0 (default '0c')
//   compact — show only the single largest non-zero unit (e.g. "3g")
export function formatCurrency(copper, opts = {}) {
  const { empty = '0c', zero = '0c', compact = false } = opts
  if (copper == null || copper < 0) return empty
  if (copper === 0) return zero

  const { platinum, gold, silver, copper: c } = splitCurrency(copper)

  if (compact) {
    if (platinum > 0) return `${platinum}p`
    if (gold > 0)     return `${gold}g`
    if (silver > 0)   return `${silver}s`
    return `${c}c`
  }

  const parts = []
  if (platinum > 0) parts.push(`${platinum}p`)
  if (gold > 0)     parts.push(`${gold}g`)
  if (silver > 0)   parts.push(`${silver}s`)
  if (c > 0 || parts.length === 0) parts.push(`${c}c`)
  return parts.join(' ')
}
