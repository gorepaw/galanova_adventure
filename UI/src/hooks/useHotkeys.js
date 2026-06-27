import { useState, useMemo, useCallback } from 'react'
import { HOTKEY_DEFS } from '../hotkeys.js'

const LS_KEY = 'kalimdor_hotkeys'

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {} }
  catch { return {} }
}

function persist(overrides) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)) } catch {}
}

export default function useHotkeys() {
  const [overrides, setOverrides] = useState(loadOverrides)

  // Effective bindings: actionId → key (defaults merged with user overrides)
  const bindings = useMemo(() =>
    Object.fromEntries(
      Object.entries(HOTKEY_DEFS).map(([id, def]) => [id, overrides[id] ?? def.defaultKey])
    ),
    [overrides]
  )

  // Reversed map: key → actionId (for O(1) lookup in the keydown handler)
  const keyMap = useMemo(() => {
    const map = {}
    for (const [id, key] of Object.entries(bindings)) {
      if (key) map[key] = id
    }
    return map
  }, [bindings])

  const updateBinding = useCallback((actionId, key) => {
    setOverrides(prev => {
      const next = { ...prev, [actionId]: key }
      persist(next)
      return next
    })
  }, [])

  const resetBinding = useCallback((actionId) => {
    setOverrides(prev => {
      const next = { ...prev }
      delete next[actionId]
      persist(next)
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    setOverrides({})
    persist({})
  }, [])

  return { bindings, keyMap, updateBinding, resetBinding, resetAll }
}
