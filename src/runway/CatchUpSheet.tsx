import { useState } from 'react'
import Sheet, { reportError } from './Sheet'
import { parseDate } from '../engine/dates'

/**
 * Journey 10: catch up on cycles that ended without being closed.
 * One balance is enough. The earlier missed cycles close on their forecast;
 * the last one closes on a real figure, either worked back from today's
 * balance or typed in for its end date. All of them close in one go, or none.
 */

export interface MissedCycle { start: string; end: string; forecastCents: number }
export interface SoFarLine { name: string; date: string; cents: number }   // cents positive

interface Props {
  missed: MissedCycle[]                 // oldest first
  current: { start: string; end: string; openingCents: number; closingCents: number }
  today: string
  payName: string
  ins: SoFarLine[]                      // money in this cycle up to today
  outs: SoFarLine[]                     // money out this cycle up to today
  spentCents: number                    // budget spending logged this cycle
  floorCents: number
  currencySymbol: string
  money: (cents: number) => string
  onCancel: () => void
  onSubmit: (c: { lastCloseCents: number; enteredCents: number | null; payIn: boolean | null }) => Promise<void>
}

const day = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })

export default function CatchUpSheet(p: Props) {
  const [step, setStep] = useState(0)
  const [now, setNow] = useState('')
  const [known, setKnown] = useState(false)
  const [on, setOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const n = p.missed.length
  const last = p.missed[n - 1]
  const cents = (s: string) => Math.round((parseFloat(s) || 0) * 100)
  const filled = (s: string) => s.trim() !== '' && !isNaN(parseFloat(s))
  const inCents = p.ins.reduce((t, x) => t + x.cents, 0)
  const outCents = p.outs.reduce((t, x) => t + x.cents, 0)
  const workedBack = cents(now) - inCents + outCents + p.spentCents
  const lastClose = known ? cents(on) : workedBack
  const diff = lastClose - last.forecastCents
  const leftBeforePay = p.current.closingCents + diff
  const signed = (v: number) => Math.round(v / 100) === 0 ? p.money(0) : (v > 0 ? '+' : '') + p.money(v)
  // About one pay below forecast when working back: most likely that pay hadn't landed yet.
  const payAtStart = p.ins.filter(x => x.date === p.current.start).reduce((t, x) => t + x.cents, 0)
  const looksLikeNoPay = !known && payAtStart > 0 && Math.abs(diff + payAtStart) < payAtStart * 0.25
  const names = (xs: SoFarLine[]) => [...new Set(xs.map(x => x.name))].join(', ')

  const canNext = step === 0 ? filled(now) || known : step === 1 ? (known ? filled(on) : true) : true

  async function submit() {
    if (busy) return
    setBusy(true)
    try {
      await p.onSubmit({ lastCloseCents: lastClose, enteredCents: known ? lastClose : null, payIn: known ? false : null })
      setDone(true)
    } catch (e: any) {
      reportError('The catch-up didn’t run, so nothing was changed.', e)
    } finally { setBusy(false) }
  }

  const head = (title: string, sub?: string) => (
    <div className="rw-sh-h"><div><h2 className="rw-sheet-title">{title}</h2>{sub && <div className="rw-sd">{sub}</div>}</div>
      <button type="button" className="rw-x" aria-label="Close" onClick={p.onCancel}>×</button></div>
  )

  return (
    <Sheet onClose={p.onCancel} busy={busy}>
        <div className="rw-grab" />
        {done ? (
          <>
            <div className="rw-done">
              <div className="ck">✓</div>
              <h2 className="rw-sheet-title">{n === 1 ? '1 cycle closed' : `${n} cycles closed`}</h2>
              <div className="rw-sd">This cycle opens at {p.money(lastClose)}</div>
            </div>
            <div className="rw-ctas"><button type="button" className="rw-cta" onClick={p.onCancel}>Done</button></div>
          </>
        ) : <>
          <div className="rw-steps">{[0, 1, 2].map(s => <i key={s} className={s <= step ? 'on' : ''} />)}</div>

          {step === 0 && <>
            {head('Your balance right now', `From your banking app, ${day(p.today)}`)}
            <div className="rw-big"><span>{p.currencySymbol}</span>
              <input type="number" inputMode="decimal" placeholder="0" autoFocus aria-label="Balance right now"
                value={now} onChange={e => { setNow(e.target.value); setKnown(false) }} /></div>
            <div className="rw-note">
              {n === 1 ? '1 cycle wasn’t closed. ' : `${n} cycles weren’t closed. `}
              One balance is enough: we work back from it{n > 1 ? ', and the earlier missed cycles close on their forecast' : ''}.
            </div>
            <button type="button" className="rw-lnk" onClick={() => { setKnown(true); if (!filled(on)) setOn(String(last.forecastCents / 100)); setStep(1) }}>
              I know my balance on {day(last.end)} instead</button>
          </>}

          {step === 1 && (known ? <>
            {head(`Balance on ${day(last.end)}`, `Before ${p.payName} landed on ${short(p.current.start)}`)}
            <div className="rw-big"><span>{p.currencySymbol}</span>
              <input type="number" inputMode="decimal" placeholder="0" aria-label={`Balance on ${day(last.end)}`}
                value={on} onChange={e => setOn(e.target.value)} /></div>
            <div className="rw-hint" style={{ textAlign: 'center' }}>Forecast before pay: {p.money(last.forecastCents)}</div>
          </> : <>
            {head(`Working back to ${day(last.end)}`, 'Using this cycle’s items and the spending you’ve logged')}
            <div className="rw-card rw-wfc">
              <div className="rw-wf"><span>Right now</span><b>{p.money(cents(now))}</b></div>
              {inCents > 0 && <div className="rw-wf"><span>Came in since {short(p.current.start)}<small>{names(p.ins)}</small></span><b>−{p.money(inCents)}</b></div>}
              {outCents > 0 && <div className="rw-wf"><span>Went out since<small>{names(p.outs)}</small></span><b>+{p.money(outCents)}</b></div>}
              {p.spentCents !== 0 && <div className="rw-wf"><span>Spending logged since</span><b>{p.spentCents > 0 ? '+' : '−'}{p.money(Math.abs(p.spentCents))}</b></div>}
              <div className="rw-wf tot"><span>Closed {short(last.end)}</span><b>{p.money(workedBack)}</b></div>
            </div>
            {looksLikeNoPay
              ? <div className="rw-warn-ban near"><span><b>That's about one {p.payName} below forecast.</b> If it hadn't landed by now, go back and use "I know my balance on {short(last.end)}" instead.</span></div>
              : <div className="rw-note">Spending you haven't logged this cycle makes this less exact. You can fix the close afterwards.</div>}
          </>)}

          {step === 2 && <>
            {head(n === 1 ? 'Close 1 cycle' : `Close ${n} cycles`, 'Estimates you didn’t confirm stay unconfirmed. Correct them later in Past cycles.')}
            <div className="rw-group flush" style={{ marginTop: 10 }}>
              {p.missed.map(m => {
                const isLast = m === last
                return (
                  <div key={m.start} className="rw-row static">
                    <div className="rw-tx"><div className="rw-row-name">{short(m.start)} – {short(m.end)}</div>
                      <div className="rw-sub">{isLast ? `Closes on your balance · ${signed(diff)} vs forecast` : 'Closes on its forecast'}</div></div>
                    <div className="rw-am">{p.money(isLast ? lastClose : m.forecastCents)}<small>{isLast ? 'real' : 'forecast'}</small></div>
                  </div>)
              })}
            </div>
            <div className="rw-tiles">
              <div className="rw-tile"><div className="k">This cycle opens</div><div className="v">{p.money(lastClose)}</div><div className="d">was {p.money(p.current.openingCents)}</div></div>
              <div className="rw-tile"><div className="k">Left before pay</div>
                <div className={`v ${leftBeforePay < 0 ? 'under' : leftBeforePay < p.floorCents ? 'near' : ''}`}>{p.money(leftBeforePay)}</div>
                <div className="d">{short(p.current.end)}</div></div>
              <div className="rw-tile"><div className="k">Every payday after</div>
                <div className={`v ${diff >= 0 ? 'good' : 'near'}`}>{signed(diff)}</div><div className="d">vs forecast</div></div>
            </div>
            <div className="rw-hint">Closing can't be undone. If the balance was wrong, use Fix this close in Past cycles.</div>
          </>}

          <div className="rw-ctas">
            {step > 0 && <button type="button" className="rw-cta sec" disabled={busy}
              onClick={() => { const s = step - 1; setStep(s); if (s === 0) setKnown(false) }}>Back</button>}
            {step < 2
              ? <button type="button" className="rw-cta" disabled={!canNext} onClick={() => setStep(s => s + 1)}>Next</button>
              : <button type="button" className="rw-cta" disabled={busy} onClick={submit}>{busy ? 'Closing…' : n === 1 ? 'Close 1 cycle' : `Close ${n} cycles`}</button>}
          </div>
        </>}
    </Sheet>
  )
}
