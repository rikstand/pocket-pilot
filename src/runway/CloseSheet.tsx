import { useState } from 'react'
import Sheet, { reportError } from './Sheet'
import { parseDate } from '../engine/dates'
import { dateLocale } from '../lib/dateFormat'

/**
 * Closing the cycle (Journey 8): what the estimates came to, your balance
 * now, whether pay is already in it, then actual against forecast. One close,
 * one database call, the same as before: only the screens are new.
 *
 * Estimates already confirmed during the cycle aren't asked again; if all
 * are, that step is skipped.
 */
export interface CloseEstimate { id: string; name: string; estimatedCents: number; confirmed: boolean }

interface Props {
  start: string
  end: string
  payName: string
  payDate: string
  scheduledPayCents: number
  forecastCents: number                         // what the app forecast this cycle closes at
  estimates: CloseEstimate[]
  budgets: { name: string; plannedCents: number; spentCents: number }[]
  notSetAside: { name: string; amountCents: number }[]
  currencySymbol: string
  money: (cents: number) => string
  onCancel: () => void
  onSubmit: (close: { closingCents: number; enteredCents: number; payIn: boolean; actuals: { expense_id: string; actual_amount_cents: number }[] }) => Promise<void>
}

const day = (d: string) => parseDate(d).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
const signed = (c: number, money: (c: number) => string) => Math.round(c / 100) === 0 ? money(0) : (c > 0 ? '+' : '') + money(c)

export default function CloseSheet(p: Props) {
  const toAsk = p.estimates.filter(e => !e.confirmed)
  const first = toAsk.length ? 0 : 1
  const [step, setStep] = useState(first)
  const [actuals, setActuals] = useState<Record<string, string>>(
    () => Object.fromEntries(p.estimates.map(e => [e.id, String(e.estimatedCents / 100)])))
  const [bal, setBal] = useState('')
  const [landed, setLanded] = useState<'yes' | 'no' | null>(null)
  const [payAmt, setPayAmt] = useState(String(p.scheduledPayCents / 100))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const cents = (s: string) => Math.round((parseFloat(s) || 0) * 100)
  const balEntered = bal.trim() !== '' && !isNaN(parseFloat(bal))
  const real = cents(bal)
  const payHeld = landed === 'yes' ? cents(payAmt) : 0
  const opening = real - payHeld                      // the closing balance, and next cycle's opening
  const diff = opening - p.forecastCents

  // What explains the difference, from real records. Positive = better than forecast.
  const rows: { name: string; sub: string; v: number }[] = []
  for (const e of toAsk) {
    const a = cents(actuals[e.id] ?? '')
    if (a !== e.estimatedCents) rows.push({ name: e.name, sub: `estimate ${p.money(e.estimatedCents)}`, v: e.estimatedCents - a })
  }
  for (const b of p.budgets) {
    const left = b.plannedCents - b.spentCents
    if (left > 0) rows.push({ name: b.name, sub: `budget ${p.money(b.plannedCents)}`, v: left })
  }
  for (const s of p.notSetAside) rows.push({ name: s.name, sub: 'not set aside', v: s.amountCents })
  const explained = rows.reduce((s, r) => s + r.v, 0)
  rows.sort((a, b) => b.v - a.v)
  rows.push({ name: 'Not logged', sub: 'what nothing above explains', v: diff - explained })
  const mx = Math.max(...rows.map(r => Math.abs(r.v)), 1)

  // About one pay more than forecast, with "not yet" picked: most likely it's in there.
  const looksLikePay = landed === 'no' && p.scheduledPayCents > 0 && Math.abs(diff - p.scheduledPayCents) < p.scheduledPayCents * 0.25

  const steps = [0, 1, 2, 3].filter(s => s >= first)
  const canNext = step === 0 || (step === 1 && balEntered) || (step === 2 && landed !== null)

  async function submit() {
    if (busy || looksLikePay) return
    setBusy(true)
    try {
      await p.onSubmit({
        closingCents: opening,
        enteredCents: real,
        payIn: landed === 'yes',
        // $0 is a real answer ("it didn't come this cycle") and is saved. A
        // field left blank is not an answer: it stays unconfirmed, and can be
        // corrected later in Past cycles.
        actuals: p.estimates.flatMap(e => {
          if (e.confirmed) return [{ expense_id: e.id, actual_amount_cents: Math.max(0, e.estimatedCents) }]
          const typed = (actuals[e.id] ?? '').trim()
          if (typed === '' || isNaN(parseFloat(typed))) return []
          return [{ expense_id: e.id, actual_amount_cents: Math.max(0, cents(typed)) }]
        }),
      })
      setDone(true)
    } catch (e: any) {
      reportError('The cycle didn’t close, so nothing was changed.', e)
    } finally { setBusy(false) }
  }

  return (
    <Sheet onClose={p.onCancel} busy={busy}>
        <div className="rw-grab" />
        {done ? (
          <>
            <div className="rw-done">
              <div className="ck">✓</div>
              <h2 className="rw-sheet-title">Cycle closed</h2>
              <div className="rw-sd">Next cycle opens at {p.money(opening)} · forecast saved</div>
            </div>
            <div className="rw-ctas"><button type="button" className="rw-cta" onClick={p.onCancel}>Done</button></div>
          </>
        ) : <>
          <div className="rw-steps">{steps.map(s => <i key={s} className={s <= step ? 'on' : ''} />)}</div>

          {step === 0 && <>
            <div className="rw-sh-h"><h2 className="rw-sheet-title">What did the estimates cost?</h2>
              <button type="button" className="rw-x" aria-label="Close" onClick={p.onCancel}>×</button></div>
            {p.estimates.filter(e => e.confirmed).length > 0 && (
              <div className="rw-sd">{p.estimates.filter(e => e.confirmed).map(e => e.name).join(', ')} already confirmed.</div>
            )}
            {toAsk.map(e => (
              <div key={e.id} className="rw-fld">
                <span className="l">{e.name}<small>estimated {p.money(e.estimatedCents)}</small></span>
                <span className="rw-fld-in">{p.currencySymbol}<input type="number" inputMode="decimal" aria-label={`${e.name}, real amount`}
                  value={actuals[e.id] ?? ''} onChange={ev => setActuals(a => ({ ...a, [e.id]: ev.target.value }))} /></span>
              </div>
            ))}
            <div className="rw-hint">Budgets aren't asked about: your real balance is the check.</div>
          </>}

          {step === 1 && <>
            <div className="rw-sh-h"><div><h2 className="rw-sheet-title">Your balance right now</h2>
              <div className="rw-sd">From your banking app</div></div>
              <button type="button" className="rw-x" aria-label="Close" onClick={p.onCancel}>×</button></div>
            <div className="rw-big"><span>{p.currencySymbol}</span>
              <input type="number" inputMode="decimal" placeholder="0" autoFocus aria-label="Balance right now" value={bal} onChange={e => setBal(e.target.value)} /></div>
            <div className="rw-hint" style={{ textAlign: 'center' }}>Forecast before pay: {p.money(p.forecastCents)}</div>
          </>}

          {step === 2 && <>
            <div className="rw-sh-h"><div><h2 className="rw-sheet-title">Is {p.payName} in that balance?</h2>
              <div className="rw-sd">{p.scheduledPayCents > 0 ? `${p.money(p.scheduledPayCents)} · ` : ''}due {day(p.payDate)}</div></div>
              <button type="button" className="rw-x" aria-label="Close" onClick={p.onCancel}>×</button></div>
            <div className="rw-seg flush" role="radiogroup">
              <button type="button" role="radio" aria-checked={landed === 'yes'} className={landed === 'yes' ? 'on' : ''} onClick={() => setLanded('yes')}>Yes, it's in</button>
              <button type="button" role="radio" aria-checked={landed === 'no'} className={landed === 'no' ? 'on' : ''} onClick={() => setLanded('no')}>Not yet</button>
            </div>
            <div className="rw-tiles two">
              <div className={`rw-tile${landed === 'yes' ? ' sel' : ''}`}><div className="k">If it's in</div>
                <div className="v">{p.money(real - cents(payAmt))}</div><div className="d">next cycle opens · held back for {day(p.payDate)}</div></div>
              <div className={`rw-tile${landed === 'no' ? ' sel' : ''}`}><div className="k">If not yet</div>
                <div className="v">{p.money(real)}</div><div className="d">next cycle opens · added when it lands</div></div>
            </div>
            {landed === 'yes' && <>
              <div className="rw-lab">Amount that landed</div>
              <div className="rw-amtrow"><span>{p.currencySymbol}</span>
                <input type="number" inputMode="decimal" aria-label="Amount that landed" value={payAmt} onChange={e => setPayAmt(e.target.value)} /></div>
              <div className="rw-hint">Your usual pay. Change it if the deposit was different.</div>
            </>}
          </>}

          {step === 3 && <>
            <div className="rw-sh-h"><h2 className="rw-sheet-title">Actual vs forecast</h2>
              <button type="button" className="rw-x" aria-label="Close" onClick={p.onCancel}>×</button></div>
            <div className="rw-tiles">
              <div className="rw-tile"><div className="k">Forecast</div><div className="v">{p.money(p.forecastCents)}</div><div className="d">before pay</div></div>
              <div className="rw-tile"><div className="k">Actual</div><div className="v">{p.money(opening)}</div><div className="d">next cycle opens</div></div>
              <div className="rw-tile"><div className="k">Difference</div>
                <div className={`v ${diff >= 0 ? 'good' : 'near'}`}>{signed(diff, p.money)}</div><div className="d">{diff >= 0 ? 'better' : 'worse'}</div></div>
            </div>
            {looksLikePay ? (
              <div className="rw-warn-ban near rw-col">
                <span><b>That's about one {p.payName} more than forecast.</b> If it's already in your balance, it would be counted twice.</span>
                <button type="button" className="rw-cta" onClick={() => setLanded('yes')}>{p.payName} is in the balance</button>
              </div>
            ) : (
              <div className="rw-card">
                {rows.map(r => (
                  <div key={r.name} className="rw-dvr">
                    <span className="dn">{r.name}<small>{r.sub}</small></span>
                    <span className="db"><i style={{ [r.v >= 0 ? 'left' : 'right']: '50%', width: Math.abs(r.v) / mx * 48 + '%',
                      background: r.v >= 0 ? 'var(--rw-good)' : 'var(--rw-near-floor)' } as any} /></span>
                    <span className={`dvv ${r.v >= 0 ? 'good' : 'near'}`}>{signed(r.v, p.money)}</span>
                  </div>
                ))}
              </div>
            )}
          </>}

          {step === 3 && <div className="rw-note"><b className="rw-ink">Closing is final.</b> You can still fix the balance afterwards in Past cycles.</div>}
          <div className="rw-ctas">
            {step > first && <button type="button" className="rw-cta sec" disabled={busy} onClick={() => setStep(s => s - 1)}>Back</button>}
            {step < 3
              ? <button type="button" className="rw-cta" disabled={!canNext} onClick={() => setStep(s => s + 1)}>Next</button>
              : <button type="button" className="rw-cta" disabled={busy || looksLikePay} onClick={submit}>{busy ? 'Closing…' : 'Close cycle'}</button>}
          </div>
        </>}
    </Sheet>
  )
}
