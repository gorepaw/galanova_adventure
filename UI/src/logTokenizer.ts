// Combat-log entity recognition, built to scale to thousands of entities.
//
// Two layers, in priority order:
//   1. Engine tags  — ⟦type:id⟧ sentinels emitted by the engine (Engine/logtags.ts).
//      Resolved by direct id lookup: O(1), exact, no false positives.
//   2. Heuristic match (untagged / legacy lines):
//        • ids   → hash-map lookup on single underscore tokens (O(1) per token)
//        • names → a word-trie walked left-to-right, greedy-longest match
//      Both are independent of catalog size — no mega-regex.
//
// Keep the tag delimiters in sync with Engine/logtags.ts.

export interface LogEntity {
  type?: string;
  id?: string;
  name?: string;
  data?: any;
  [key: string]: any;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  entry: LogEntity | null;
}

export interface LogMatcher {
  idMap: Map<string, LogEntity>;
  trie: TrieNode;
}

export type LogPart =
  | { kind: 'text'; text: string }
  | { kind: 'entity'; entry: LogEntity; raw: string };

const TAG_RE = /⟦([a-z]+):([a-z0-9_]+)⟧/gi

// Lowercase a word and strip edge punctuation, keeping internal _ and ' so ids
// ("copper_coin_pouch") and possessives ("champion's") survive intact.
const normWord = (w: string): string =>
  w.toLowerCase().replace(/^[^a-z0-9_']+/, '').replace(/[^a-z0-9_']+$/, '')

// entries: [{ type, id, name, data }]
export function buildMatcher(entries: LogEntity[] | null | undefined): LogMatcher {
  const idMap = new Map<string, LogEntity>()
  const trie: TrieNode = { children: new Map(), entry: null }

  for (const e of entries || []) {
    if (e.id) {
      const k = String(e.id).toLowerCase()
      if (!idMap.has(k)) idMap.set(k, e)
    }
    if (e.name) {
      const words = String(e.name).split(/\s+/).map(normWord).filter(Boolean)
      if (words.length) {
        let node = trie
        for (const w of words) {
          let next = node.children.get(w)
          if (!next) { next = { children: new Map(), entry: null }; node.children.set(w, next) }
          node = next
        }
        if (!node.entry) node.entry = e // first writer wins; longer phrases sit deeper
      }
    }
  }
  return { idMap, trie }
}

function resolveTag(type: string, id: string, matcher: LogMatcher): LogEntity {
  return matcher.idMap.get(id.toLowerCase()) || { type, id, name: id, data: {} }
}

interface Word { core: string; coreStart: number; coreEnd: number }

// Match a plain (tag-free) text segment, pushing {kind:'text'|'entity'} parts.
function matchSegment(text: string, matcher: LogMatcher, out: LogPart[]): void {
  const { idMap, trie } = matcher

  // Tokenize into words, recording the offsets of each word's punctuation-trimmed core.
  const words: Word[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw   = m[0]
    const lead  = (raw.match(/^[^a-zA-Z0-9_']*/) || [''])[0].length
    const trail = (raw.match(/[^a-zA-Z0-9_']*$/) || [''])[0].length
    const coreStart = m.index + lead
    const coreEnd   = m.index + raw.length - trail
    if (coreEnd <= coreStart) continue // pure punctuation / emoji
    words.push({ core: text.slice(coreStart, coreEnd).toLowerCase(), coreStart, coreEnd })
  }

  let cursor = 0, i = 0
  const flushText = (until: number) => { if (until > cursor) out.push({ kind: 'text', text: text.slice(cursor, until) }) }

  while (i < words.length) {
    const w = words[i]

    // Greedy-longest name match via the trie.
    const start = trie.children.get(w.core)
    let entry: LogEntity | null = null, end = i
    if (start) {
      if (start.entry) { entry = start.entry; end = i }
      let node: TrieNode = start
      let j = i + 1
      while (j < words.length) {
        const nx = node.children.get(words[j].core)
        if (!nx) break
        node = nx
        if (node.entry) { entry = node.entry; end = j }
        j++
      }
    }

    if (entry) {
      flushText(words[i].coreStart)
      out.push({ kind: 'entity', entry, raw: text.slice(words[i].coreStart, words[end].coreEnd) })
      cursor = words[end].coreEnd
      i = end + 1
      continue
    }

    // Single-token id match.
    const idEntry = idMap.get(w.core)
    if (idEntry) {
      flushText(w.coreStart)
      out.push({ kind: 'entity', entry: idEntry, raw: text.slice(w.coreStart, w.coreEnd) })
      cursor = w.coreEnd
    }
    i++
  }
  flushText(text.length)
}

// Split a log line into renderable parts: {kind:'text', text} | {kind:'entity', entry, raw}.
export function tokenizeLine(line: string | null | undefined, matcher?: LogMatcher | null): LogPart[] {
  if (!line) return [{ kind: 'text', text: ' ' }]
  if (!matcher) return [{ kind: 'text', text: line }]

  const out: LogPart[] = []
  let last = 0, m: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(line))) {
    if (m.index > last) matchSegment(line.slice(last, m.index), matcher, out)
    out.push({ kind: 'entity', entry: resolveTag(m[1], m[2], matcher), raw: m[2] })
    last = m.index + m[0].length
  }
  if (last < line.length) matchSegment(line.slice(last), matcher, out)
  return out
}
