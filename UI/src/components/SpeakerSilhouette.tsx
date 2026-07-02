import React, { useId } from 'react'

/**
 * Placeholder speaker portrait — a stylized SVG silhouette per species, used by the
 * Commune / dialogue overlay until real portrait art exists (see Docs/GALANOVA.md
 * "Storyline Quests & the Commune system").
 *
 * Sephir: tall, gently narrow head carrying six eyes in three vertical pairs; skin
 * greys with colonial distance ("greyskin"). Accent color drives the eye-glow.
 */
export type SilhouetteKey = 'sephir' | 'sephir_greyskin'

export default function SpeakerSilhouette({
  species = 'sephir_greyskin',
  accent = '#6aa9e0',
  size = 96,
}: {
  species?: SilhouetteKey
  accent?: string
  size?: number
}) {
  const uid = useId().replace(/:/g, '')
  // Greyskin colonists read as a desaturated, cooler blue than core Sephir.
  const skinTop = species === 'sephir_greyskin' ? '#3a4152' : '#2f3a58'
  const skinBot = species === 'sephir_greyskin' ? '#20242e' : '#1c223a'

  // Six eyes: two columns (three rows each), set high on the tall head so there's
  // room below for a nose/mouth.
  const eyes = [
    [41, 26], [59, 26],
    [41, 36], [59, 36],
    [41, 46], [59, 46],
  ]

  return (
    <svg
      className="speaker-silhouette"
      width={size}
      height={size * 1.3}
      viewBox="0 0 100 130"
      role="img"
      aria-label="Sephir speaker portrait"
    >
      <defs>
        <linearGradient id={`skin-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skinTop} />
          <stop offset="1" stopColor={skinBot} />
        </linearGradient>
        <filter id={`glow-${uid}`} x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* shoulders */}
      <path
        d="M14 130 C14 104 32 90 50 90 C68 90 86 104 86 130 Z"
        fill={`url(#skin-${uid})`}
        stroke="#c8a951" strokeOpacity="0.35" strokeWidth="1"
      />
      {/* neck */}
      <path d="M43 76 h14 v16 h-14 Z" fill={`url(#skin-${uid})`} />
      {/* tall, gently narrow head with a soft chin */}
      <path
        d="M50 4 C64 4 70 15 70 34 C70 56 66 74 50 80 C34 74 30 56 30 34 C30 15 36 4 50 4 Z"
        fill={`url(#skin-${uid})`}
        stroke="#c8a951" strokeOpacity="0.45" strokeWidth="1"
      />
      {/* rim-light down one side of the head */}
      <path
        d="M50 4 C64 4 70 15 70 34 C70 52 66 68 55 77"
        fill="none" stroke={accent} strokeOpacity="0.22" strokeWidth="1.4" strokeLinecap="round"
      />

      {/* six eyes — three vertical pairs of horizontal almonds, glowing in the accent color */}
      <g filter={`url(#glow-${uid})`}>
        {eyes.map(([cx, cy], i) => (
          <ellipse key={i} cx={cx} cy={cy} rx="4.4" ry="2.4" fill={accent} />
        ))}
      </g>
      {/* faint bright cores */}
      <g>
        {eyes.map(([cx, cy], i) => (
          <ellipse key={i} cx={cx} cy={cy} rx="1.9" ry="1.1" fill="#eaf4ff" fillOpacity="0.85" />
        ))}
      </g>
    </svg>
  )
}
