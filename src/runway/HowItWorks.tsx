import { useEffect, useState, type ReactNode } from 'react'
import { HowViz } from './HowViz'

/**
 * More › How this works (UX fix 18, mock pp-release8-mockB): the app's words in
 * a sentence or two each, as rows that open in place. Each answer opens with a
 * short explainer that plays once; "Play again" restarts it.
 */
export const HOW: { k: string; t: string; body: ReactNode }[] = [
  { k: 'cycle', t: 'Cycles and paydays', body: <>A cycle runs from one payday to the day before the next. Everything due in it comes out of that pay.</> },
  { k: 'left', t: 'Left before pay', body: <>What your account should hold just before your next pay lands, after everything due this cycle. It’s the number every chart in the app draws.</> },
  { k: 'floor', t: 'Your floor', body: <>The least you want left before any payday. Every warning is measured against it: amber means a payday under it, red means under $0. Change it in Settings.</> },
  { k: 'spare', t: 'Spare', body: <>What’s left above your floor before pay. On the “whatever’s spare” card plan it goes to the card, so it shows $0 until the card is cleared.</> },
  { k: 'fits', t: 'Fits', body: <>The most you can pay or put away this cycle while every payday ahead stays at or above your floor. You’ll see it on the card, savings and wishlist.</> },
  { k: 'types', t: 'Fixed, estimates and budgets', body: <>Fixed amounts are the same each time. Estimates are your best guess until you confirm the real figure. Budgets are spending you log as you go, like groceries.</> },
  { k: 'close', t: 'Closing a cycle', body: <>On the last day you enter your real balance. The app saves what happened and starts the next cycle from that balance.</> },
]

export default function HowItWorks({ openKey }: { openKey?: string | null }) {
  const [open, setOpen] = useState<string | null>(openKey ?? null)
  const [replay, setReplay] = useState(0)
  useEffect(() => { if (openKey) setOpen(openKey) }, [openKey])
  return (
    <div className="rw-page">
      <div className="rw-page-head"><h1 className="rw-page-title">How this works</h1></div>
      <p className="rw-page-sub">The words the app uses, in a sentence or two each.</p>
      <div className="rw-group" style={{ marginTop: 12 }}>
        {HOW.map(h => (
          <div key={h.k}>
            <button type="button" className="rw-row" aria-expanded={open === h.k} onClick={() => setOpen(open === h.k ? null : h.k)}>
              <div className="rw-tx"><div className="rw-row-name">{h.t}</div></div>
              <span className={`rw-chev rw-turn${open === h.k ? ' on' : ''}`}>›</span>
            </button>
            {open === h.k && <>
              <div className="rw-hv-box"><HowViz key={`${h.k}${replay}`} k={h.k} /></div>
              <div className="rw-how-body">{h.body}
                <button type="button" className="rw-lnk rw-how-again" onClick={() => setReplay(replay + 1)}>Play again</button></div>
            </>}
          </div>
        ))}
      </div>
    </div>
  )
}
