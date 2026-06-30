// Central hotkey definitions — add one line here to register a new action.
export interface HotkeyDef {
  label: string;
  defaultKey: string;
  category: string;
}

export const HOTKEY_DEFS: Record<string, HotkeyDef> = {
  // ── Tab navigation ───────────────────────────────────────────────────────────
  tab_log:          { label: 'Log',          defaultKey: 'l',  category: 'navigation' },
  tab_quests:       { label: 'Quests',        defaultKey: 'q',  category: 'navigation' },
  tab_combat:       { label: 'Combat',        defaultKey: 'c',  category: 'navigation' },
  tab_bag:          { label: 'Bag',           defaultKey: 'b',  category: 'navigation' },
  tab_zones:        { label: 'Zones',         defaultKey: 'z',  category: 'navigation' },
  tab_shops:        { label: 'Shops',         defaultKey: 's',  category: 'navigation' },
  tab_dungeons:     { label: 'Dungeons',      defaultKey: 'd',  category: 'navigation' },
  tab_character:    { label: 'Character',     defaultKey: 'h',  category: 'navigation' },
  tab_crafting:     { label: 'Craft',         defaultKey: 't',  category: 'navigation' },
  tab_reputation:   { label: 'Reputation',    defaultKey: 'p',  category: 'navigation' },
  tab_skills:       { label: 'Skills',        defaultKey: 'k',  category: 'navigation' },
  tab_professions:  { label: 'Professions',   defaultKey: 'o',  category: 'navigation' },
  tab_guildhall:    { label: 'Guildhall',     defaultKey: 'g',  category: 'navigation' },
  tab_collections:  { label: 'Collections',   defaultKey: 'n',  category: 'navigation' },
  tab_achievements: { label: 'Achievements',  defaultKey: 'a',  category: 'navigation' },
  tab_save_load:    { label: 'Save / Load',   defaultKey: 'v',  category: 'navigation' },
  tab_settings:     { label: 'Settings',      defaultKey: 'm',  category: 'navigation' },
  // ── Combat actions ───────────────────────────────────────────────────────────
  run_encounter:    { label: 'Run Encounter', defaultKey: 'r',  category: 'combat' },
  engage_combat:    { label: 'Engage',        defaultKey: 'e',  category: 'combat' },
  try_flee:         { label: 'Flee',          defaultKey: 'f',  category: 'combat' },
}

export const HOTKEY_CATEGORIES: { id: string; label: string }[] = [
  { id: 'navigation', label: 'Tab Navigation' },
  { id: 'combat',     label: 'Combat Actions' },
]

/** Convert a KeyboardEvent to a canonical key string like "f1", "shift+f1", "r", "ctrl+k". */
export function normalizeKey(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase()
  if (['control', 'alt', 'shift', 'meta'].includes(key)) return null
  const parts: string[] = []
  if (e.ctrlKey)  parts.push('ctrl')
  if (e.altKey)   parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

/** Format a canonical key string for display: "shift+f1" → "Shift+F1", "r" → "R". */
export function formatKeyLabel(key: string | null | undefined): string {
  if (!key) return '—'
  const NAMED: Record<string, string> = { ' ': 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: 'Enter', escape: 'Esc', backspace: 'Bksp', delete: 'Del', tab: 'Tab' }
  return key.split('+').map(part => {
    if (part === 'ctrl')        return 'Ctrl'
    if (part === 'alt')         return 'Alt'
    if (part === 'shift')       return 'Shift'
    if (/^f\d+$/.test(part))   return part.toUpperCase()
    if (NAMED[part])            return NAMED[part]
    if (part.length === 1)      return part.toUpperCase()
    return part
  }).join('+')
}
