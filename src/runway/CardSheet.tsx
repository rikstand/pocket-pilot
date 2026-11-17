import { useMemo, useRef, useState, type ReactNode } from 'react'
import Sheet, { reportError } from './Sheet'
import { projectFromRows, type ForecastResult } from '../lib/forecast'
import {
  setCreditExtraOverride, clearCreditExtraOverride, confirmCreditPayment, unconfirmCreditPayment, addCreditSnapshot, deleteCreditSnapshot,
} from '../lib/repository'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import Preview, { previewStats } from './Preview'

/**
 * Journey 1: the card payment for one cycle. The amount, a slider from the
 * minimum to what this cycle has spare, with Plan and Fits as chips under it,
 * and the payday line until the card is cleared. Every figure is the real
 * forecast with this cycle's choice swapped in, so the preview can't disagree
 * with what saving does.
 *
 *   Plan  = what your plan pays this cycle (saving it clears any one-off)
 *   Fits  = the most you can pay this cycle with every payday ahead at or
 *           above your floor; under the plan when a later payday dips
 *   spare = everything this cycle has above the floor; saved as "spare", so
 *           it follows your budgets if they change
 *
 * Later cycles always follow the plan. The plan itself is Plan › Credit.
 */

export type CardMode = 'pay' | 'confirm' | 'paid' | 'balance'

interface Props {
  mode: CardMode
  rows: ForecastResult
  cycleStart: string
  card: any
  accountId: string
  floorCents: number
  today: string
  dueDate: string | null
  paidCents: number | null          // confirmed amount, when paid
  predictedTodayCents: number | null // what the card should owe today; null outside the current cycle
  sym: string
  money: (cents: number) => string
  onPlan?: () => void               // to Plan › Credit
  onClose: () => void
}

const HORIZON = 80                   // cycles projected, enough to see most cards cleared
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const monYr = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })
const day = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric' }).replace(',', '')
const nextDay = (d: string) => formatDate(addDays(parseDate(d), 1))
const dollars = (c: number) => Math.round(c / 100)

export default function CardSheet(p: Props) {
  const toast = useToast()
  const [mode, setMode] = useState<CardMode>(p.mode)
  const [busy, setBusy] = useState(false)
  const { money } = p
  const name = p.card?.name ?? 'Card'

  /* ── the forecast with one row for this cycle swapped in ── */
  const others = (p.rows.creditOverrideRows ?? []).filter((o: any) => o.cycle_start !== p.cycleStart)
  const base = useMemo(() => projectFromRows({ ...p.rows, creditOverrideRows: others }, p.floorCents, HORIZON), [p.rows, p.cycleStart])
  const k0 = base.findIndex(c => c.startDate === p.cycleStart)
  const here = k0 >= 0 ? base[k0] : null
  const current = p.rows.cycles.find(c => c.startDate === p.cycleStart) ?? here
  const minC = here?.creditMinimumCents ?? 0
  const planC = here?.creditPaymentCents ?? 0
  const owedBefore = here ? here.creditClosingBalanceCents + planC : 0
  const project = (row: any | null) => row
    ? projectFromRows({ ...p.rows, creditOverrideRows: [...others, row] }, p.floorCents, HORIZON)
    : base
  const spareRow = { cycle_start: p.cycleStart, extra_cents: 0, choice: 'spare' }
  const spareRun = useMemo(() => project(spareRow), [base])
  const spareC = Math.min(owedBefore, k0 >= 0 ? spareRun[k0].creditPaymentCents : 0)
  const lo = Math.floor(minC / 100) * 100
  const hi = Math.max(planC, spareC, lo + 100)

  // The row a payment of `c` saves as: none for the plan, spare at the spare end.
  function rowFor(c: number): any | null {
    if (Math.abs(c - planC) < 100) return null
    if (spareC > planC && Math.abs(c - spareC) < 100) return spareRow
    return { cycle_start: p.cycleStart, extra_cents: Math.max(0, c - minC), choice: 'extra' }
  }
  const cleared = (run: typeof base) => run.findIndex((c, i) => i >= k0 && (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)
  const interest = (run: typeof base) => run.slice(Math.max(0, k0)).reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)
  const planClear = cleared(base), spareClear = cleared(spareRun)
  // Paydays shown: until the later of the two clears, plus two; a year if neither does.
  const span = Math.min(base.length - k0, Math.max(planClear < 0 ? 26 : planClear - k0 + 3, spareClear < 0 ? 0 : spareClear - k0 + 3, 6))
  const closes = (run: typeof base) => run.slice(k0, k0 + span).map(c => c.committedClosingBalanceCents)
  const lowest = (c: number) => Math.min(...closes(project(rowFor(c))))

  // Fits and the $0 line: the most this cycle can pay with every payday shown
  // at or above the floor (or $0). Paying more now never helps a later payday.
  const limits = useMemo(() => {
    if (k0 < 0) return { fits: null as number | null, zero: null as number | null }
    const search = (bar: number) => {
      if (lowest(lo) < bar) return null
      let a = lo, b = hi
      if (lowest(b) >= bar) return b
      while (b - a > 100) { const m = Math.round((a + b) / 200) * 100; if (lowest(m) >= bar) a = m; else b = m }
      return a
    }
    return { fits: search(p.floorCents), zero: search(0) }
  }, [base])

  const startC = current?.creditPaymentCents ?? planC
  const [amt, setAmt] = useState(String(dollars(startC)))
  const typed = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const payC = typed
  const tooLow = payC < minC - 50
  const run = useMemo(() => project(rowFor(Math.max(payC, minC))), [payC, base])
  const nowCloses = closes(base)
  const newCloses = closes(run)
  const payDates = base.slice(k0, k0 + span).map(c => nextDay(c.endDate))
  const st = previewStats(nowCloses, newCloses, p.floorCents)
  const runClear = cleared(run)
  const dInterest = Math.round((interest(base) - interest(run)) / 100) * 100
  const sooner = planClear < 0 || runClear < 0 ? 0 : planClear - runClear
  const isPlan = Math.abs(payC - planC) < 100
  const unchanged = Math.abs(payC - startC) < 100
  const fits = limits.fits, zero = limits.zero

  const pct = (c: number) => Math.max(0, Math.min(100, (c - lo) / (hi - lo) * 100))
  const marks = [{ k: 'Plan', v: planC }, ...(fits != null && Math.abs(fits - planC) >= 100 ? [{ k: 'Fits', v: fits }] : [])]
    .sort((a, b) => a.v - b.v)
  const setPay = (c: number) => setAmt(String(dollars(c)))

  const tag = tooLow ? <span className="w">Under the {money(minC)} minimum</span>
    : st.level === 'under' && zero != null ? <span className="n">{money(payC - zero)} past $0 · overdrawn</span>
    : st.level === 'under' ? <span className="n">A payday goes below $0</span>
    : fits == null ? <span className="w">Even the minimum leaves a payday under your floor</span>
    : payC > fits + 50 ? <span className="w">{money(payC - fits)} more than fits · into your floor</span>
    : null

  // The interest bar: saving is good news; more interest is a cost, not a warning.
  const planLow = Math.min(...nowCloses)
  const keepsAbove = dInterest < 0 && planLow < p.floorCents && st.lowestCents >= p.floorCents
  const gain = dInterest >= 100
    ? <div className="rw-gain"><b>Saves {money(dInterest)}</b><span>interest, vs your plan</span></div>
    : dInterest <= -100
      ? <div className="rw-gain flat"><b>{money(-dInterest)}</b><span>more interest than your plan{keepsAbove
          ? <>, but keeps <b>{short(payDates[nowCloses.indexOf(planLow)])}</b> above your floor</> : null}</span></div>
      : <div className="rw-gain flat"><b>{money(interest(base))}</b><span>interest left on your plan</span></div>

  async function savePay() {
    if (busy || tooLow) return
    if (unchanged) { p.onClose(); return }
    setBusy(true)
    const before = (p.rows.creditOverrideRows ?? []).find((o: any) => o.cycle_start === p.cycleStart) ?? null
    const row = rowFor(payC)
    try {
      if (row) await setCreditExtraOverride(p.card.id, p.accountId, p.cycleStart, row.extra_cents, row.choice)
      else await clearCreditExtraOverride(p.card.id, p.cycleStart)
      toast(row ? `This cycle: ${money(payC)}. Later cycles follow your plan.` : 'Back to your plan', {
        undo: async () => {
          if (before) await setCreditExtraOverride(p.card.id, p.accountId, p.cycleStart, before.extra_cents, before.choice ?? 'extra')
          else await clearCreditExtraOverride(p.card.id, p.cycleStart)
          notifyDataChanged()
        },
      })
      notifyDataChanged(); p.onClose()
    } catch (e: any) { reportError('That didn’t save.', e) }
    finally { setBusy(false) }
  }

  /* ── confirm what went out ── */
  const [cf, setCf] = useState(String(dollars(startC)))
  const cfC = Math.max(0, Math.round((parseFloat(cf) || 0) * 100))
  const cfRun = useMemo(() => mode !== 'confirm' ? base : projectFromRows({
    ...p.rows,
    creditPaymentRows: [...(p.rows.creditPaymentRows ?? []).filter((x: any) => x.cycle_start !== p.cycleStart),
      { cycle_start: p.cycleStart, amount_cents: cfC, confirmed_at: new Date().toISOString() }],
  }, p.floorCents, HORIZON), [mode, cfC, base])
  const shownNow = closes(project(rowFor(startC)))
  async function saveConfirm() {
    if (busy) return
    setBusy(true)
    try {
      await confirmCreditPayment(p.card.id, p.accountId, p.cycleStart, cfC)
      toast(`${name}: paid ${money(cfC)}. Later cycles re-plan.`, {
        undo: async () => { await unconfirmCreditPayment(p.card.id, p.cycleStart); notifyDataChanged() },
      })
      notifyDataChanged(); p.onClose()
    } catch (e: any) { reportError('The payment wasn’t confirmed.', e) }
    finally { setBusy(false) }
  }
  async function undoPaid() {
    if (busy) return
    setBusy(true)
    try {
      await unconfirmCreditPayment(p.card.id, p.cycleStart)
      toast('Payment unconfirmed')
      notifyDataChanged(); p.onClose()
    } catch (e: any) { reportError('That wasn’t undone.', e) }
    finally { setBusy(false) }
  }

  /* ── update the balance ── */
  const [bal, setBal] = useState(p.predictedTodayCents != null ? String(dollars(p.predictedTodayCents)) : '')
  const balC = Math.max(0, Math.round((parseFloat(bal) || 0) * 100))
  const balRef = useRef<HTMLInputElement>(null)
  // Shown with thousands separators as it is typed, so a slipped digit is seen.
  const balShown = (() => {
    if (!bal) return ''
    const [whole, cents] = bal.split('.')
    return (whole ? Number(whole).toLocaleString('en-NZ') : '0') + (cents != null ? '.' + cents : '')
  })()
  const typeBal = (v: string) => {
    const clean = v.replace(/[^0-9.]/g, '')
    const dot = clean.indexOf('.')
    setBal(dot < 0 ? clean : clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '').slice(0, 2))
  }
  // A typing guard, not advice: more than 20% and at least $100 from the
  // balance the forecast expected today, so the sheet asks before saving.
  const balGap = p.predictedTodayCents != null ? balC - p.predictedTodayCents : 0
  const balFar = p.predictedTodayCents != null && !!bal.trim()
    && Math.abs(balGap) >= 10000 && Math.abs(balGap) > p.predictedTodayCents * 0.2
  // The forecast as it would run with this balance saved: the latest balance
  // is what the card reads, so this is exactly what saving does.
  const balRun = useMemo(() => mode !== 'balance' || !bal.trim() ? base : projectFromRows({
    ...p.rows, creditOverrideRows: p.rows.creditOverrideRows ?? [],
    creditCard: { ...p.rows.creditCard, current_balance_cents: balC, balance_as_of: p.today, balance_recorded_at: new Date().toISOString(), balance_source: 'manual' },
  }, p.floorCents, HORIZON), [mode, balC, base])
  const clearLabel = (run: typeof base) => { const i = cleared(run); return i >= 0 ? monYr(nextDay(run[i].endDate)) : 'Later' }
  const fromBase = useMemo(() => mode === 'balance' ? projectFromRows(p.rows, p.floorCents, HORIZON) : base, [mode, p.rows])
  async function saveBalance() {
    if (busy || !bal.trim()) return
    setBusy(true)
    try {
      const saved = await addCreditSnapshot(p.card.id, p.accountId, balC, p.today, 'manual', p.predictedTodayCents ?? undefined)
      toast(`${name} balance set to ${money(balC)}`, {
        undo: async () => { await deleteCreditSnapshot(saved.id); notifyDataChanged() },
      })
      notifyDataChanged(); p.onClose()
    } catch (e: any) { reportError('The balance didn’t save.', e) }
    finally { setBusy(false) }
  }

  const planWords = (() => {
    const m = p.card?.strategy_mode, x = p.card?.strategy_extra_cents ?? 0
    if (!p.card?.strategy_committed) return 'No plan set'
    return m === 'spare' ? 'Whatever’s spare' : m === 'minimum' || !x ? 'Minimum only' : `Min + ${money(x)} a cycle`
  })()
  const cycleEnd = here?.endDate ?? p.cycleStart
  const head = (title: string, sub: ReactNode) => (
    <div className="rw-sh-h"><div><h2 className="rw-sheet-title">{title}</h2><div className="rw-sd">{sub}</div></div>
      <button type="button" className="rw-x" aria-label="Close" onClick={p.onClose}>×</button></div>
  )

  if (k0 < 0 || !here) return null

  return (
    <Sheet onClose={p.onClose} busy={busy}>
        <div className="rw-grab" />

        {mode === 'pay' && <>
          {head(name, <>This cycle · {short(p.cycleStart)} – {short(cycleEnd)}{p.dueDate ? <> · due <b>{day(p.dueDate)}</b></> : null}</>)}
          <div className="rw-card rw-sl-card">
            <div className="rw-pv-k"><span>Pay this cycle</span>{!isPlan && <span>plan {money(planC)}</span>}</div>
            <div className="rw-amt"><span>{p.sym}</span>
              <input type="number" inputMode="decimal" aria-label="Pay this cycle" value={amt} onChange={e => setAmt(e.target.value)} /></div>
            {gain}
            {tag && <div className="rw-sl-tag">{tag}</div>}
            <div className="rw-sl">
              <div className="sl-rail" />
              {fits != null && fits < hi && <div className="sl-zone" style={{ left: pct(fits) + '%', right: (zero != null && zero < hi ? 100 - pct(zero) : 0) + '%' }} />}
              {fits == null && <div className="sl-zone" style={{ left: 0, right: (zero != null && zero < hi ? 100 - pct(zero) : 0) + '%' }} />}
              {zero != null && zero < hi && <div className="sl-zone neg" style={{ left: pct(zero) + '%', right: 0 }} />}
              {zero == null && <div className="sl-zone neg" style={{ left: 0, right: 0 }} />}
              <div className="sl-fill" style={{ width: pct(Math.min(hi, Math.max(lo, payC))) + '%' }} />
              {marks.map(m => <div key={m.k} className={`sl-mk${Math.abs(payC - m.v) < 100 ? ' on' : ''}`} style={{ left: pct(m.v) + '%' }} />)}
              <input type="range" aria-label="Pay this cycle" aria-valuetext={`${money(Math.min(hi, Math.max(lo, payC)))} this cycle`} min={lo / 100} max={hi / 100} step={1}
                value={dollars(Math.min(hi, Math.max(lo, payC)))} onChange={e => setAmt(e.target.value)} />
            </div>
            <div className="rw-snaps">
              {marks.map(m => <button key={m.k} type="button" className={Math.abs(payC - m.v) < 100 ? 'on' : ''} onClick={() => setPay(m.v)}>{m.k} {money(m.v)}</button>)}
            </div>
            <div className="rw-ends">
              <button type="button" onClick={() => setPay(minC)}><b>{money(minC)}</b>minimum</button>
              <button type="button" className="r" onClick={() => setPay(spareC)}><b>{money(spareC)}</b>spare this cycle</button>
            </div>
          </div>

          <Preview nowCents={nowCloses} newCents={newCloses} payDates={payDates} floorCents={p.floorCents} money={money}
            title="Before each payday until it’s cleared"
            done={{ now: planClear >= 0 && planClear - k0 < span ? planClear - k0 : null, next: runClear >= 0 && runClear - k0 < span ? runClear - k0 : null }}
            third={{ k: 'Card cleared', v: runClear >= 0 ? monYr(nextDay(run[runClear].endDate)) : 'Later',
              d: sooner > 0 ? `${sooner} cycle${sooner > 1 ? 's' : ''} sooner` : sooner < 0 ? `${-sooner} cycle${sooner < -1 ? 's' : ''} later` : 'on plan',
              cls: sooner > 0 ? 'good' : sooner < 0 ? 'near' : '' }} tilesFirst />

          {/* Update card balance and Change my plan live on Plan › Credit only,
              so the answer to this payment stays in view (agreed 17 Nov 2026). */}
          {((p.dueDate ?? cycleEnd) <= p.today || p.predictedTodayCents != null) && (
            <div className="rw-group flush" style={{ marginTop: 10 }}>
              <button type="button" className="rw-row" onClick={() => setMode('confirm')}>
                <div className="rw-tx"><div className="rw-row-name">I’ve paid it</div><div className="rw-sub">Early counts</div></div><span className="rw-chev">›</span></button>
            </div>
          )}

          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={p.onClose}>Cancel</button>
            <button type="button" className="rw-cta" disabled={busy || tooLow} onClick={savePay}>
              {unchanged ? (isPlan ? 'Keep my plan' : `Keep ${money(payC)}`)
                : `Pay ${money(payC)}${st.level === 'under' ? ' anyway' : dInterest >= 100 ? ` · save ${money(dInterest)}` : ' this cycle'}`}
            </button>
          </div>
        </>}

        {mode === 'confirm' && <>
          {head('Did it go out?', <>{name}{p.dueDate ? ` · due ${day(p.dueDate)}` : ''}</>)}
          <div className="rw-big"><span>{p.sym}</span>
            <input type="number" inputMode="decimal" aria-label="Amount that went out" value={cf} onChange={e => setCf(e.target.value)} /></div>
          <div className="rw-hint" style={{ textAlign: 'center' }}>
            {Math.abs(cfC - startC) < 100 ? 'Matches what you chose.'
              : <>Planned <b>{money(startC)}</b> · {money(Math.abs(cfC - startC))} {cfC > startC ? 'more' : 'less'}. Later paydays re-plan.</>}
          </div>
          {Math.abs(cfC - startC) >= 100 && (
            <Preview nowCents={shownNow} newCents={closes(cfRun)} payDates={payDates} floorCents={p.floorCents} money={money}
              title="Before each payday until it’s cleared"
              done={{ now: null, next: (() => { const i = cleared(cfRun); return i >= 0 && i - k0 < span ? i - k0 : null })() }} />
          )}
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={() => (p.mode === 'confirm' ? p.onClose() : setMode('pay'))}>{p.mode === 'confirm' ? 'Cancel' : 'Back'}</button>
            <button type="button" className="rw-cta" disabled={busy} onClick={saveConfirm}>Confirm {money(cfC)}</button>
          </div>
        </>}

        {mode === 'paid' && <>
          {head(name, <>Paid <b>{money(p.paidCents ?? 0)}</b> this cycle · {money(Math.max(0, current?.creditClosingBalanceCents ?? 0))} left on the card</>)}
          <div className="rw-note">Later cycles follow your plan from what's left.</div>
          <div className="rw-group flush" style={{ marginTop: 10 }}>
            {p.predictedTodayCents != null && (
              <button type="button" className="rw-row" onClick={() => setMode('balance')}>
                <div className="rw-tx"><div className="rw-row-name">Update card balance</div><div className="rw-sub">What your banking app shows now</div></div><span className="rw-chev">›</span></button>
            )}
            {p.onPlan && (
              <button type="button" className="rw-row" onClick={() => { p.onClose(); p.onPlan!() }}>
                <div className="rw-tx"><div className="rw-row-name">Change my plan</div><div className="rw-sub">{planWords}</div></div><span className="rw-chev">›</span></button>
            )}
          </div>
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" disabled={busy} onClick={undoPaid}>Undo payment</button>
            <button type="button" className="rw-cta" onClick={p.onClose}>Done</button>
          </div>
        </>}

        {mode === 'balance' && <>
          {head('Update card balance', 'Whatever your banking app shows now. Do it as often as you like.')}
          <div className="rw-big"><span>{p.sym}</span>
            <input ref={balRef} type="text" inputMode="decimal" aria-label="Card balance now" value={balShown} onChange={e => typeBal(e.target.value)} /></div>
          {balFar && p.predictedTodayCents != null ? (
            <div className="rw-warn-ban near" role="alert">
              <span><b>{money(Math.abs(balGap))} {balGap > 0 ? 'more' : 'less'} than expected.</b> We expected {money(p.predictedTodayCents)} today. Is {money(balC)} right?</span>
            </div>
          ) : p.predictedTodayCents != null && (
            <div className="rw-hint" style={{ textAlign: 'center' }}>
              We expected <b>{money(p.predictedTodayCents)}</b> today.{' '}
              {Math.abs(balC - p.predictedTodayCents) < 100 ? 'That matches.'
                : balC > p.predictedTodayCents ? `${money(balC - p.predictedTodayCents)} more owing.` : `${money(p.predictedTodayCents - balC)} less owing.`}
              {' '}The plan re-runs from today.
            </div>
          )}
          {p.card?.strategy_committed && bal.trim() && (
            <div className="rw-tiles two">
              <div className="rw-tile"><div className="k">Card cleared</div><div className="v">{clearLabel(balRun)}</div><div className="d">was {clearLabel(fromBase)}</div></div>
              <div className="rw-tile"><div className="k">Interest</div><div className="v">{money(interest(balRun))}</div><div className="d">was {money(interest(fromBase))}</div></div>
            </div>
          )}
          <div className="rw-ctas">
            {balFar
              ? <button type="button" className="rw-cta sec" disabled={busy} onClick={() => { balRef.current?.focus(); balRef.current?.select() }}>Change it</button>
              : <button type="button" className="rw-cta sec" onClick={() => (p.mode === 'balance' ? p.onClose() : setMode(p.mode))}>{p.mode === 'balance' ? 'Cancel' : 'Back'}</button>}
            <button type="button" className="rw-cta" disabled={busy || !bal.trim()} onClick={saveBalance}>{busy ? 'Saving…' : balFar ? `Yes, save ${money(balC)}` : 'Save balance'}</button>
          </div>
        </>}
    </Sheet>
  )
}
