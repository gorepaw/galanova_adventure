import React, { useEffect, useRef, useState } from 'react'
import SpeakerSilhouette, { SilhouetteKey } from './SpeakerSilhouette'
import type { SceneNodeVM } from '../../../Engine/types/viewmodel'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const HINT_LABEL: Record<string, string> = {
  bag: 'Bag', shops: 'Shop', skills: 'Skills', character: 'Character',
  quests: 'Quests', crafting: 'Craft', zones: 'Zones',
}

/**
 * The Commune overlay — a forced modal that dims/blurs the app and plays a story
 * scene one node at a time (typewriter, click/key to advance). Two channels:
 * `personal_log` (internal monologue) and `commune` (incoming signal).
 * See Docs/GALANOVA.md "Storyline Quests & the Commune system".
 */
export default function CommWindow({
  scene,
  loading,
  onAdvance,
  onChoose,
}: {
  scene: SceneNodeVM
  loading: boolean
  onAdvance: () => void
  onChoose: (choiceIndex: number) => void
}) {
  const text = scene.text || ''
  const reduce = prefersReducedMotion()
  const [shown, setShown] = useState(reduce ? text.length : 0)
  const [typed, setTyped] = useState(reduce)
  const hasChoices = scene.choices.length > 0

  // Restart the typewriter whenever the node changes.
  useEffect(() => {
    if (reduce) { setShown(text.length); setTyped(true); return }
    setShown(0); setTyped(false)
  }, [scene.dialogueId, scene.nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reveal one character at a time.
  useEffect(() => {
    if (typed) return
    if (shown >= text.length) { setTyped(true); return }
    const t = setTimeout(() => setShown(s => s + 1), 18)
    return () => clearTimeout(t)
  }, [shown, typed, text])

  const primary = () => {
    if (loading) return
    if (!typed) { setShown(text.length); setTyped(true); return } // fast-forward
    if (!hasChoices) onAdvance()
  }

  // Keyboard: space/enter advances or fast-forwards; number keys pick a choice.
  const primaryRef = useRef(primary)
  primaryRef.current = primary
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (hasChoices && typed) {
        const n = parseInt(e.key, 10)
        if (n >= 1 && n <= scene.choices.length) { e.preventDefault(); if (!loading) onChoose(n - 1); return }
        if (e.key === 'Enter') { e.preventDefault(); if (!loading) onChoose(0); return }
        return
      }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); primaryRef.current() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [scene, typed, hasChoices, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  const sp = scene.speaker
  const accent = sp?.accent || 'var(--blue)'
  const channelLabel = scene.channel === 'commune' ? 'Incoming Commune' : 'Personal Log'
  const hintLabel = scene.hint ? (HINT_LABEL[scene.hint] || scene.hint) : null

  return (
    <div className="commune-overlay" role="dialog" aria-modal="true" aria-label={`${channelLabel}: ${sp?.name ?? ''}`}>
      <div className="commune-backdrop" onClick={primary} />
      <div className={`commune-card channel-${scene.channel}`} style={{ ['--accent' as any]: accent }}>
        <div className="commune-scanline" aria-hidden="true" />
        {sp?.rune && <span className="commune-rune">{sp.rune}</span>}

        <div className="commune-portrait">
          <SpeakerSilhouette
            species={(sp?.silhouette as SilhouetteKey) || 'sephir_greyskin'}
            accent={accent}
            size={92}
          />
        </div>

        <div className="commune-main">
          <div className="commune-who">{sp?.name ?? 'Unknown'}</div>
          <div className="commune-channel">{channelLabel}</div>

          <div className="commune-body" onClick={primary}>
            {text.slice(0, shown)}
            {!typed && <span className="commune-caret">▌</span>}
          </div>

          {typed && hintLabel && (
            <div className="commune-hint">▸ Afterward, open <b>{hintLabel}</b></div>
          )}

          <div className="commune-actions">
            {!typed ? (
              <button className="commune-continue is-skip" onClick={primary} disabled={loading}>skip ▸</button>
            ) : hasChoices ? (
              scene.choices.map(c => (
                <button
                  key={c.index}
                  className="commune-choice"
                  onClick={() => !loading && onChoose(c.index)}
                  disabled={loading}
                >
                  <span className="commune-choice-key">{c.index + 1}</span>
                  {c.label}
                </button>
              ))
            ) : (
              <button className="commune-continue" onClick={primary} disabled={loading}>
                {scene.isLast ? 'close ▸' : 'continue ▸'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
