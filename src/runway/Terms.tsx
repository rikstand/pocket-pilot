import { createContext, useContext, useState, type ReactNode } from 'react'
import Sheet from './Sheet'
import { dateLocale } from '../lib/dateFormat'
import { parseDate } from '../engine/dates'

/**
 * Tap a word for one sentence (UX fix 18, rule C10 "underlined word", approved
 * 27 Nov). The app's own terms carry a dotted underline; a tap opens a small
 * sheet with one sentence in your own figures, a link to How this works and Close.
 * Fits is a chip (a tap picks it), so it gets the ? beside the chip row instead.
 */
export type TermKey = 'floor' | 'spare' | 'fits' | 'left'
export interface Figures {
  money?: (c: number) => string
  floorCents?: number
  spareCents?: number
  leftCents?: number
  payDate?: string
  spareCard?: boolean      // the card plan takes whatever's spare
}

const NAME: Record<TermKey, string> = { floor: 'Floor', spare: 'Spare', fits: 'Fits', left: 'Left before pay' }

function sentence(k: TermKey, f: Figures): ReactNode {
  const m = f.money ?? ((c: number) => `$${Math.round(c / 100)}`)
  const on = f.payDate ? ` on ${parseDate(f.payDate).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}` : ''
  if (k === 'floor') return <>The least you want left before any payday. Every warning is measured against it.{f.floorCents != null && <> Yours is <b>{m(f.floorCents)}</b>.</>}</>
  if (k === 'spare') return <>What’s left above your floor before pay{f.spareCents != null ? <>: <b>{m(Math.max(0, f.spareCents))}</b> this cycle.</> : '.'}
    {f.spareCard && <> Your card plan pays whatever’s spare, so it stays at $0 until the card is cleared.</>}</>
  if (k === 'left') return <>What your account should hold just before your next pay{on}, after everything due this cycle{f.leftCents != null ? <>: <b>{m(f.leftCents)}</b>.</> : '.'}</>
  return <>The most you can pay or put away this cycle while every payday ahead stays at or above your floor.</>
}

interface Api { open: (k: TermKey, f?: Figures) => void }
const Ctx = createContext<Api>({ open: () => {} })

/** Around the app's pages: draws the term sheet and sends "More" to How this works. */
export function TermsProvider({ onHelp, children }: { onHelp: (k: TermKey) => void; children: ReactNode }) {
  const [open, setOpen] = useState<{ k: TermKey; f: Figures } | null>(null)
  const close = () => setOpen(null)
  return (
    <Ctx.Provider value={{ open: (k, f = {}) => setOpen({ k, f }) }}>
      {children}
      {open && (
        <Sheet onClose={close}>
          <div className="rw-grab" />
          <div className="rw-sh-h">
            <h2 className="rw-sheet-title">{NAME[open.k]}</h2>
            <button type="button" className="rw-x" aria-label="Close" onClick={close}>×</button>
          </div>
          <p className="rw-term-p">{sentence(open.k, open.f)}</p>
          <button type="button" className="rw-lnk" onClick={() => { const k = open.k; close(); onHelp(k) }}>More in How this works</button>
          <div className="rw-ctas"><button type="button" className="rw-cta" onClick={close}>Close</button></div>
        </Sheet>
      )}
    </Ctx.Provider>
  )
}

/** One of the app's words, with a dotted underline. */
export function Term({ k, f, children }: { k: TermKey; f?: Figures; children: ReactNode }) {
  const { open } = useContext(Ctx)
  return <button type="button" className="rw-term" onClick={e => { e.stopPropagation(); open(k, f) }}>{children}</button>
}

/** "spare before pay" / "into your floor before pay": the term inside, underlined. */
export function termWords(s: string, f?: Figures): ReactNode {
  const m = s.match(/^(.*?)\b(spare|floor)\b(.*)$/)
  if (!m) return s
  return <>{m[1]}<Term k={m[2] as TermKey} f={f}>{m[2]}</Term>{m[3]}</>
}

/** The ? beside a chip row that offers Fits. */
export function FitsQ() {
  const { open } = useContext(Ctx)
  return <button type="button" className="rw-qm rw-fits-q" aria-label="What Fits means" onClick={() => open('fits')}>?</button>
}
