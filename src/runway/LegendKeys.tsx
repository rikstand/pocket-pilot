/**
 * The small round keys used in chart legends: drawn, not typed, so the glyph
 * always sits in the middle whatever styles the legend's spans carry.
 */
export function KeyUnder({ level = 'near' }: { level?: 'near' | 'under' }) {
  return (
    <svg className="rw-key" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="5.5" fill={level === 'under' ? 'var(--rw-under-floor)' : 'var(--rw-near-floor)'} />
      <path d="M5.5 2.6v3.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="5.5" cy="8.1" r=".9" fill="#fff" />
    </svg>
  )
}

/** The tick for "done" (card cleared): the same mint as the line it sits on. */
export function KeyDone() {
  return (
    <svg className="rw-key" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="5.5" fill="var(--rw-line)" />
      <path d="M3 5.6l1.7 1.8 3.3-3.5" fill="none" stroke="var(--rw-surface)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** "When it lands" / "plan changes": the dashed upright line drawn on the chart. */
export function KeyLands() {
  return (
    <svg className="rw-key" width="7" height="12" viewBox="0 0 7 12" aria-hidden="true">
      <line x1="3.5" x2="3.5" y1="0.5" y2="11.5" stroke="var(--rw-ink)" strokeWidth="1.4" strokeDasharray="2 2" opacity=".6" />
    </svg>
  )
}
