import skillsData from '../../../Data/skills.json'

const SKILL_DEFS = skillsData.skills || {}
const levelOf = (v) => (typeof v === 'number' ? v : (v?.level ?? 1))

// Abilities a character has unlocked from its skills (mirrors Engine/skills.js
// abilitiesFromSkills). Returns [{ id, level }] where level is the skill-level
// requirement that unlocked it (used for "learned at" display).
export function skillAbilities(inst) {
  const out = []
  const seen = new Set()
  for (const [skillId, raw] of Object.entries(inst?.skills || {})) {
    const def = SKILL_DEFS[skillId]
    if (!def) continue
    const lvl = levelOf(raw)
    for (const a of (def.abilities || [])) {
      const need = a.skillLevel ?? 1
      if (lvl >= need && !seen.has(a.id)) {
        seen.add(a.id)
        out.push({ id: a.id, level: need })
      }
    }
  }
  return out
}
