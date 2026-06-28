// =============================================================================
// COMBAT-LOG ENTITY TAGS
// Wrap an entity reference in a log string so the UI resolves it to a display
// name + hover tooltip with ZERO matching cost and zero false positives:
//
//     emit(`   Loot: ${tag('item', itemId)}`)   ->  "   Loot: ⟦item:copper_pouch⟧"
//
// The UI (UI/src/logTokenizer.js) splits on these tags first, then falls back to
// heuristic id/name matching for any still-untagged (legacy) text. Migrate hot
// emit sites to tag() over time; both paths coexist. type ∈ item | ability |
// character | zone | region. Keep the delimiters in sync with the UI parser.
// =============================================================================

"use strict";

const TAG_OPEN  = '⟦'; // ⟦
const TAG_CLOSE = '⟧'; // ⟧

const tag = (type, id) => `${TAG_OPEN}${type}:${id}${TAG_CLOSE}`;

const _exports = { tag, TAG_OPEN, TAG_CLOSE };
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
