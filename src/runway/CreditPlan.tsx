import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, projectFromRows, cardWithPlanOn, type ForecastResult } from '../lib/forecast'
import {
  getCreditSnapshots, createCreditAccount, updateCreditAccount, commitCreditStrategy, uncommitCreditStrategy,
  setCreditPlanFrom, deleteCreditPlanVersion,
} from '../lib/repository'
import { predictedBalanceOn, confirmedPaymentsFrom, cycleDaysOf, planModeOf } from '../lib/creditSchedule'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged, useDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { Segmented, DateChips, TextField } from './controls'
import Preview from './Preview'
import CardSheet, { type CardMode } from './CardSheet'
import { KeyDone, KeyLands } from './LegendKeys'

/**
 * Journey 2: Plan › Credit in the new look. What's owing, when it's cleared,
 * what the plan saves, and the card's balance line you can drag. The plan
 * changes "Just this cycle" (the Journey 1 sheet) or "From a date": from this
 * cycle it becomes the card's plan; from a later cycle it's a dated plan
 * (credit_plan_versions), listed under "Plan changes ahead" until its date.
 * Every figure is the real forecast with the change swapped in.
 */

type Mode = 'minimum' | 'extra' | 'spare'
const HORIZON = 80
const t0 = () => formatDate(new Date())
const nextDay = (d: string) => formatDate(addDays(parseDate(d), 1))
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const day = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
const monYr = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })
const monShort = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'short' })
const ord = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th')
const dollars = (c: number) => Math.round(c / 100)

interface Loaded { rows: ForecastResult; snaps: any[] }

export default function CreditPlan({ accountId }: { accountId: string }) {
  const { activeAccount } = useAccount()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const toast = useToast()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState<null | { kind: 'plan' } | { kind: 'ahead'; v: any } | { kind: 'details' } | { kind: 'card'; mode: CardMode }>(null)

  async function load() {
    try {
      const rows = await loadForecast(accountId, floorCents, { numCycles: HORIZON })
      const snaps = rows.creditCard ? await getCreditSnapshots(rows.creditCard.id) : []
      setData({ rows, snaps: snaps ?? [] }); setError('')
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [accountId])
  useDataChanged(load)

  if (error) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">{error}</div></div></div>
  if (!data) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">Loading…</div></div></div>

  const { rows, snaps } = data
  const card = rows.creditCard
  if (!card) return <AddCard accountId={accountId} sym={sym} onAdded={load} />

  const today = t0()
  const cycles = rows.cycles
  const k0 = Math.max(0, cycles.findIndex(c => c.startDate <= today && c.endDate >= today))
  const cur = cycles[k0]
  const committed = !!card.strategy_committed
  const planRows: any[] = rows.creditPlanRows ?? []
  const inForce = cardWithPlanOn(card, planRows, cur.startDate)
  const ahead = planRows.filter(v => v.effective_from > cur.startDate)
  const days = cycleDaysOf(cur)
  const paidRow = (rows.creditPaymentRows ?? []).find((x: any) => x.cycle_start === cur.startDate && x.amount_cents != null)
  const owingToday = committed
    ? predictedBalanceOn(card, cur.creditOpeningBalanceCents ?? 0, cur.startDate, days, today, cur.creditPaymentCents ?? 0,
        confirmedPaymentsFrom(rows.creditPaymentRows ?? []))
    : (card.current_balance_cents ?? 0)
  const lastSnap = snaps[0]

  const cleared = (run: typeof cycles) => run.findIndex((c, i) => i >= k0 && (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)
  const interest = (run: typeof cycles) => run.slice(k0).reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)
  const clearIdx = committed ? cleared(cycles) : -1
  const debtFree = !committed ? 'No plan yet' : clearIdx >= 0 ? monYr(nextDay(cycles[clearIdx].endDate)) : 'Not cleared'
  const minRun = committed ? projectFromRows({
    ...rows, creditCard: { ...card, strategy_mode: 'minimum', strategy_extra_cents: 0, strategy_committed: true },
    creditPlanRows: [], creditOverrideRows: [],
  }, floorCents, HORIZON) : cycles
  const saved = committed ? interest(minRun) - interest(cycles) : 0

  const planWords = (m: Mode, x: number) => m === 'spare' ? 'Whatever’s spare' : m === 'minimum' || !x ? 'Minimum only' : `Min + ${money(x)} a cycle`
  const nowWords = committed ? planWords(planModeOf(inForce), inForce.strategy_extra_cents ?? 0) : 'Not set · only the minimum is in your forecast'
  const nextChange = ahead[0]
  const isMonthly = (card.payment_frequency ?? 'per_cycle') === 'monthly' && !!card.payment_anchor_date
  const dueDay = card.payment_anchor_date ? parseDate(card.payment_anchor_date).getDate() : null

  return (
    <div className="rw-page">
      <div className="rw-page-head">
        <div className="rw-page-title">Credit</div>
        <div className="rw-sd">{card.name}</div>
      </div>

      <div className="rw-cp-hero">
        <div>
          <div className="k">Owing</div>
          <div className="rw-cp-bal">{money(owingToday)}</div>
          <div className="s">{lastSnap ? <>Updated <b>{short(lastSnap.as_of_date)}</b></> : 'Not updated yet'}</div>
        </div>
        <div className="r"><div className="k">Debt free</div><div className="v">{debtFree}</div></div>
      </div>

      {committed && (
        <div style={{ margin: '10px 12px 0' }}>
          {saved >= 100
            ? <div className="rw-gain"><b>Saves {money(saved)}</b><span>interest, vs paying the minimum</span></div>
            : <div className="rw-gain flat"><b>{money(interest(cycles))}</b><span>interest on your plan</span></div>}
        </div>
      )}

      <CardChart rows={rows} k0={k0} snaps={snaps} committed={committed} ahead={ahead} money={money} />

      <div className="rw-dl"><span className="rw-dl-k">Paying it off</span></div>
      <div className="rw-group">
        <button type="button" className="rw-row" onClick={() => setSheet({ kind: 'plan' })}>
          <span className="rw-cardmark" />
          <div className="rw-tx"><div className="rw-row-name">Your plan</div>
            <div className="rw-sub">{nowWords}{nextChange ? ` · then ${planWords(nextChange.mode, Number(nextChange.extra_cents ?? 0)).toLowerCase()} from ${short(nextChange.effective_from)}` : ''}</div></div>
          {committed && <div className="rw-am">{money(interest(cycles))}<small>interest</small></div>}
          <span className="rw-chev">›</span>
        </button>
        {committed && (
          <button type="button" className="rw-row" onClick={() => setSheet({ kind: 'card', mode: paidRow ? 'paid' : 'pay' })}>
            <span className="rw-cp-cal" />
            <div className="rw-tx"><div className="rw-row-name">This cycle</div>
              <div className="rw-sub">{paidRow ? `Paid ${money(paidRow.amount_cents)}` : `${short(cur.startDate)} – ${short(cur.endDate)}`}
                {(rows.creditOverrideRows ?? []).some((o: any) => o.cycle_start === cur.startDate) && !paidRow ? ' · your amount' : ''}</div></div>
            <div className="rw-am">{money(paidRow ? paidRow.amount_cents : cur.creditPaymentCents ?? 0)}</div>
            <span className="rw-chev">›</span>
          </button>
        )}
        <button type="button" className="rw-row" onClick={() => setSheet({ kind: 'card', mode: 'balance' })}>
          <span className="rw-cp-cal" />
          <div className="rw-tx"><div className="rw-row-name">Update card balance</div>
            <div className="rw-sub">What your banking app shows now{lastSnap ? ` · last ${short(lastSnap.as_of_date)}` : ''}</div></div>
          <span className="rw-chev">›</span>
        </button>
        <button type="button" className="rw-row" onClick={() => setSheet({ kind: 'details' })}>
          <span className="rw-cp-gear" />
          <div className="rw-tx"><div className="rw-row-name">Card details</div>
            <div className="rw-sub">{(card.apr_basis_points / 100).toFixed(2).replace(/\.?0+$/, '')}% · {Number(card.min_payment_pct)}% min · {isMonthly && dueDay ? `monthly, due the ${ord(dueDay)}` : 'every cycle'}</div></div>
          <span className="rw-chev">›</span>
        </button>
      </div>

      {ahead.length > 0 && <>
        <div className="rw-dl"><span className="rw-dl-k">Plan changes ahead</span></div>
        <div className="rw-group">
          {ahead.map(v => (
            <button key={v.id} type="button" className="rw-row" onClick={() => setSheet({ kind: 'ahead', v })}>
              <div className="rw-tx"><div className="rw-row-name">From {day(v.effective_from)}</div>
                <div className="rw-sub">{planWords(v.mode, Number(v.extra_cents ?? 0))}</div></div>
              <span className="rw-chev">›</span>
            </button>
          ))}
        </div>
      </>}
      <div style={{ height: 16 }} />

      {sheet?.kind === 'plan' && (
        <PlanSheet rows={rows} k0={k0} card={card} accountId={accountId} floorCents={floorCents} money={money} sym={sym}
          onThisCycle={() => setSheet({ kind: 'card', mode: paidRow ? 'paid' : 'pay' })} onClose={() => setSheet(null)} toast={toast} />
      )}
      {sheet?.kind === 'ahead' && (
        <AheadSheet v={sheet.v} rows={rows} k0={k0} floorCents={floorCents} money={money} accountId={accountId} card={card}
          planWords={planWords} onClose={() => setSheet(null)} toast={toast} />
      )}
      {sheet?.kind === 'details' && (
        <DetailsSheet card={card} rows={rows} k0={k0} floorCents={floorCents} money={money} sym={sym} onClose={() => setSheet(null)} toast={toast} />
      )}
      {sheet?.kind === 'card' && (
        <CardSheet mode={sheet.mode} rows={rows} cycleStart={cur.startDate} card={inForce} accountId={accountId}
          floorCents={floorCents} today={today} dueDate={null} paidCents={paidRow?.amount_cents ?? null}
          predictedTodayCents={owingToday} sym={sym} money={money}
          onPlan={() => setSheet({ kind: 'plan' })} onClose={() => setSheet(null)} />
      )}
    </div>
  )
}

/* ── the card's balance: your updates, then the plan until it's cleared ── */
function CardChart({ rows, k0, snaps, committed, ahead, money }: {
  rows: ForecastResult; k0: number; snaps: any[]; committed: boolean; ahead: any[]; money: (c: number) => string
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  type P = { d: string; bal: number; past?: boolean; pay?: number; due?: boolean; k?: number }
  const pts: P[] = [...snaps].slice(0, 5).reverse().map(s => ({ d: s.as_of_date, bal: s.balance_cents, past: true }))
  let clearedAt = -1
  if (committed) {
    for (let k = k0; k < rows.cycles.length && pts.length < 40; k++) {
      const c = rows.cycles[k]
      pts.push({ d: nextDay(c.endDate), bal: Math.max(0, c.creditClosingBalanceCents ?? 0), pay: c.creditPaymentCents ?? 0, due: (c.creditMinimumCents ?? 0) > 0, k })
      if ((c.creditClosingBalanceCents ?? 0) <= 0) { clearedAt = pts.length - 1; break }
    }
  }
  const n = pts.length
  if (n < 2) return null
  const np = pts.filter(p => p.past).length
  const W = 340, H = 130, X0 = 14, X1 = W - 14, T = 12, B = H - 20
  const max = Math.max(...pts.map(p => p.bal), 1) * 1.08
  const X = (i: number) => X0 + i * (X1 - X0) / (n - 1)
  const Y = (v: number) => B - v / max * (B - T)
  const firstFut = Math.max(0, np - 1)
  const fut = pts.slice(firstFut).map((p, j) => `${X(j + firstFut)},${Y(p.bal)}`).join(' ')
  const past = pts.slice(0, np).map((p, j) => `${X(j)},${Y(p.bal)}`).join(' ')
  const si = scrub ?? Math.min(n - 1, np)
  const sp = pts[si]
  const labels: { i: number; t: string }[] = []
  pts.forEach((p, i) => { const m = monShort(p.d); if (!labels.length || labels[labels.length - 1].t !== m) labels.push({ i, t: m }) })
  const gap = labels.length > 1 ? (X(labels[labels.length - 1].i) - X(labels[0].i)) / (labels.length - 1) : 99
  const step = Math.max(1, Math.ceil(28 / gap))
  const changeIdx = ahead.map(v => pts.findIndex(p => p.k != null && rows.cycles[p.k].startDate === v.effective_from)).filter(i => i >= 0)

  return (
    <div className="rw-fc-chart">
      <div className="rw-fc-ct"><span>What’s left on the card</span></div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="rw-fc-svg" role="img" aria-label="The card balance, your updates then the plan"
        onPointerMove={e => {
          const r = svgRef.current!.getBoundingClientRect()
          setScrub(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width * W - X0) / (X1 - X0) * (n - 1)))))
        }} onPointerLeave={() => setScrub(null)}>
        <line x1={X0} x2={X1} y1={B} y2={B} stroke="var(--rw-hairline)" />
        {fut && np < n && <polygon points={`${fut} ${X(n - 1)},${B} ${X(firstFut)},${B}`} fill="var(--rw-line)" opacity=".08" />}
        {np > 1 && <polyline points={past} fill="none" stroke="var(--rw-ink)" strokeWidth="2.4" strokeLinejoin="round" />}
        {np < n && <polyline points={fut} fill="none" stroke="var(--rw-line)" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />}
        {changeIdx.map(i => <line key={i} x1={X(i)} x2={X(i)} y1={T} y2={B} stroke="var(--rw-ink)" strokeDasharray="2 3" opacity=".4" />)}
        {pts.map((p, i) => p.past
          ? <circle key={i} cx={X(i)} cy={Y(p.bal)} r="3.4" fill="var(--rw-ink)" stroke="var(--rw-surface)" strokeWidth="1.5" />
          : i !== clearedAt && n <= 30 && <circle key={i} cx={X(i)} cy={Y(p.bal)} r="2.6" fill={p.due ? 'var(--rw-line)' : 'var(--rw-surface)'} stroke="var(--rw-line)" strokeWidth="1.4" />)}
        {clearedAt >= 0 && (() => { const cx = X(clearedAt), cy = Y(0)
          return <g><circle cx={cx} cy={cy} r="6" fill="var(--rw-line)" stroke="var(--rw-surface)" strokeWidth="2" />
            <path d={`M${cx - 2.6} ${cy}l1.8 1.9 3.4-3.6`} fill="none" stroke="var(--rw-surface)" strokeWidth="1.6" strokeLinecap="round" /></g> })()}
        {labels.filter((_, j) => j % step === 0).map(l => <text key={l.i} x={X(l.i)} y={B + 14} fontSize="9" textAnchor="middle" fill="var(--rw-muted)" fontWeight="600">{l.t}</text>)}
        <line x1={X(si)} x2={X(si)} y1={T} y2={B} stroke="var(--rw-ink)" opacity=".25" pointerEvents="none" />
        <circle cx={X(si)} cy={Y(sp.bal)} r="5" fill="none" stroke="var(--rw-ink)" strokeWidth="1.5" pointerEvents="none" />
      </svg>
      <div className="rw-cp-scrub">
        {sp.past ? <><b>{money(sp.bal)}</b><span>{short(sp.d)} · you updated it</span></>
          : sp.bal <= 0 ? <><b>Cleared</b><span>{short(sp.d)} · last payment {money(sp.pay ?? 0)}</span></>
          : <><b>{money(sp.bal)} left</b><span>{short(sp.d)} · pays {money(sp.pay ?? 0)}</span><em className={sp.due ? 'on' : ''}>{sp.due ? 'min due' : 'extra only'}</em></>}
      </div>
      <div className="rw-legend">
        <span><i className="ln" style={{ borderTopColor: 'var(--rw-ink)' }} />your updates</span>
        <span><i className="ln" />your plan</span>
        {clearedAt >= 0 && <span><KeyDone />cleared</span>}
        {changeIdx.length > 0 && <span><KeyLands />plan changes</span>}
      </div>
    </div>
  )
}

/* ── your plan: just this cycle, or from a date ─────────────────────── */
function PlanSheet({ rows, k0, card, accountId, floorCents, money, sym, onThisCycle, onClose, toast }: {
  rows: ForecastResult; k0: number; card: any; accountId: string; floorCents: number; money: (c: number) => string; sym: string
  onThisCycle: () => void; onClose: () => void; toast: ReturnType<typeof useToast>
}) {
  const today = t0()
  const cycles = rows.cycles
  const cur = cycles[k0]
  const committed = !!card.strategy_committed
  const planRows: any[] = rows.creditPlanRows ?? []
  const [scope, setScope] = useState<'one' | 'from'>('from')
  const [pick, setPick] = useState(today)
  // The cycle a picked date falls in: a plan always starts with a whole cycle.
  const kStart = Math.max(k0, cycles.findIndex(c => c.startDate <= pick && c.endDate >= pick))
  const start = cycles[kStart]?.startDate ?? cur.startDate
  const fromNow = start === cur.startDate
  const was = cardWithPlanOn(card, planRows, start)
  const wasMode: Mode = committed ? planModeOf(was) : 'minimum'
  const wasExtra = wasMode === 'extra' ? (was.strategy_extra_cents ?? 0) : 0
  const [spare, setSpare] = useState(wasMode === 'spare')
  const [amt, setAmt] = useState(String(dollars(was.strategy_extra_cents ?? 0)))
  const [busy, setBusy] = useState(false)
  const extra = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const mode: Mode = spare ? 'spare' : extra > 0 ? 'extra' : 'minimum'

  const rowsWith = (m: Mode, x: number) => fromNow
    ? { ...rows, creditCard: { ...card, strategy_mode: m, strategy_extra_cents: m === 'spare' ? (card.strategy_extra_cents ?? 0) : x, strategy_committed: true },
        creditPlanRows: planRows.filter(v => v.effective_from > cur.startDate) }
    : { ...rows, creditPlanRows: [...planRows.filter(v => v.effective_from !== start), { effective_from: start, mode: m, extra_cents: m === 'extra' ? x : 0 }] }
  const runOf = (m: Mode, x: number) => projectFromRows(rowsWith(m, x), floorCents, HORIZON)
  const base = cycles
  const cleared = (run: typeof cycles) => run.findIndex((c, i) => i >= k0 && (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)
  const interest = (run: typeof cycles) => run.slice(k0).reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)

  const limits = useMemo(() => {
    const spareRun = runOf('spare', 0)
    const sc = spareRun[kStart]
    const spareExtra = sc ? Math.max(0, (sc.creditPaymentCents ?? 0) - (sc.creditMinimumCents ?? 0)) : 0
    const max = Math.ceil(Math.max(spareExtra, wasExtra + 5000, 10000) / 5000) * 5000
    const spanFor = (run: typeof cycles) => { const c = cleared(run); return Math.min(run.length - k0, Math.max(c < 0 ? 26 : c - k0 + 3, 6)) }
    const okAt = (x: number) => { const r = runOf(x > 0 ? 'extra' : 'minimum', x); return Math.min(...r.slice(k0, k0 + spanFor(r)).map(c => c.committedClosingBalanceCents)) >= floorCents }
    let fits: number | null = null
    if (okAt(0)) {
      let a = 0, b = max
      if (okAt(b)) fits = b
      else { while (b - a > 500) { const m = Math.round((a + b) / 1000) * 500; if (okAt(m)) a = m; else b = m } fits = a }
    }
    return { max, fits }
  }, [start, rows])

  const run = useMemo(() => runOf(mode, extra), [mode, extra, start, rows])
  const baseClear = committed ? cleared(base) : -1
  const runClear = cleared(run)
  const span = Math.min(base.length - k0, Math.max(baseClear < 0 ? 26 : baseClear - k0 + 3, runClear < 0 ? 0 : runClear - k0 + 3, 6))
  const nowCloses = base.slice(k0, k0 + span).map(c => c.committedClosingBalanceCents)
  const newCloses = run.slice(k0, k0 + span).map(c => c.committedClosingBalanceCents)
  const payDates = base.slice(k0, k0 + span).map(c => nextDay(c.endDate))
  const dInt = Math.round(((committed ? interest(base) : interest(run)) - interest(run)) / 100) * 100
  const sooner = baseClear < 0 || runClear < 0 ? 0 : baseClear - runClear
  const unchanged = committed && mode === wasMode && (mode !== 'extra' || Math.abs(extra - wasExtra) < 100)
  const { max, fits } = limits
  const pct = (c: number) => Math.max(0, Math.min(100, c / max * 100))
  const chips = [
    ...(committed && wasMode === 'extra' ? [{ k: 'Plan', v: wasExtra }] : []),
    ...(fits != null && (wasMode !== 'extra' || Math.abs(fits - wasExtra) >= 500) ? [{ k: 'Fits', v: fits }] : []),
  ].sort((a, b) => a.v - b.v)

  async function save() {
    if (busy) return
    if (unchanged) { onClose(); return }
    setBusy(true)
    try {
      if (fromNow) {
        const before = { committed, mode: planModeOf(card), extra: card.strategy_extra_cents ?? 0 }
        const folded = planRows.filter(v => v.effective_from <= cur.startDate)
        await commitCreditStrategy(card.id, mode, mode === 'spare' ? (card.strategy_extra_cents ?? 0) : extra)
        for (const v of folded) await deleteCreditPlanVersion(v.id)
        toast(`Plan set: ${mode === 'spare' ? 'whatever’s spare' : mode === 'minimum' ? 'minimum only' : `min + ${money(extra)} a cycle`}. Starts this cycle.`, {
          undo: async () => {
            if (before.committed) await commitCreditStrategy(card.id, before.mode, before.extra)
            else await uncommitCreditStrategy(card.id)
            for (const v of folded) await setCreditPlanFrom(card.id, accountId, v.effective_from, v.mode, Number(v.extra_cents ?? 0))
            notifyDataChanged()
          },
        })
      } else {
        const prev = planRows.find(v => v.effective_from === start)
        const row = await setCreditPlanFrom(card.id, accountId, start, mode, extra)
        toast(`From ${short(start)}: ${mode === 'spare' ? 'whatever’s spare' : mode === 'minimum' ? 'minimum only' : `min + ${money(extra)} a cycle`}.`, {
          undo: async () => {
            if (prev) await setCreditPlanFrom(card.id, accountId, prev.effective_from, prev.mode, Number(prev.extra_cents ?? 0))
            else await deleteCreditPlanVersion(row.id)
            notifyDataChanged()
          },
        })
      }
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not save the plan: ' + e.message) }
    finally { setBusy(false) }
  }
  async function stopPlan() {
    if (busy) return
    setBusy(true)
    try {
      await uncommitCreditStrategy(card.id)
      toast('Plan stopped. The card is left out of your forecast.', {
        undo: async () => { await commitCreditStrategy(card.id, planModeOf(card), card.strategy_extra_cents ?? 0); notifyDataChanged() },
      })
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not stop the plan: ' + e.message) }
    finally { setBusy(false) }
  }

  const pays = cycles.slice(k0 + 1, k0 + 4).map(c => c.startDate)
  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">{card.name} · your plan</div>
          <div className="rw-sd">{committed ? `Now: ${planModeOf(was) === 'spare' ? 'whatever’s spare' : planModeOf(was) === 'minimum' ? 'minimum only' : `min + ${money(wasExtra)} a cycle`}` : 'No plan yet: the card is left out of your forecast'}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>

        <div style={{ marginTop: 10 }}>
          <Segmented value={scope} onChange={v => { if (v === 'one') { onThisCycle(); return } setScope(v) }}
            options={[{ value: 'one', label: 'Just this cycle', disabled: !committed }, { value: 'from', label: 'From a date' }]} />
        </div>

        <div className="rw-card rw-sl-card">
          <div className="rw-pv-k"><span>Extra each cycle</span>{!unchanged && committed && <span>now {wasMode === 'spare' ? 'all spare' : money(wasExtra)}</span>}</div>
          {spare
            ? <div className="rw-amt"><span className="rw-cp-all">All spare</span><em>{money(Math.max(0, (run[kStart]?.creditPaymentCents ?? 0)))} in that cycle</em></div>
            : <div className="rw-amt"><span>{sym}</span>
                <input type="number" inputMode="decimal" aria-label="Extra each cycle" value={amt} onChange={e => setAmt(e.target.value)} /><em>+ minimum</em></div>}
          {dInt >= 100 ? <div className="rw-gain"><b>Saves {money(dInt)}</b><span>interest, vs {committed ? 'your plan now' : 'no plan'}</span></div>
            : dInt <= -100 ? <div className="rw-gain flat"><b>{money(-dInt)}</b><span>more interest than your plan now</span></div>
            : <div className="rw-gain flat"><b>{money(interest(run))}</b><span>interest on this plan</span></div>}
          {!spare && fits != null && extra > fits + 400 && <div className="rw-sl-tag"><span className="w">{money(extra - fits)} more than fits · a payday dips into your floor</span></div>}
          {!spare && fits == null && <div className="rw-sl-tag"><span className="w">Even the minimum leaves a payday under your floor</span></div>}
          <div className={`rw-sl${spare ? ' dim' : ''}`}>
            <div className="sl-rail" />
            {fits != null && fits < max && <div className="sl-zone" style={{ left: pct(fits) + '%', right: 0 }} />}
            {fits == null && <div className="sl-zone" style={{ left: 0, right: 0 }} />}
            <div className="sl-fill" style={{ width: (spare ? 100 : pct(extra)) + '%' }} />
            {chips.map(c => <div key={c.k} className={`sl-mk${!spare && Math.abs(extra - c.v) < 100 ? ' on' : ''}`} style={{ left: pct(c.v) + '%' }} />)}
            <input type="range" aria-label="Extra each cycle" min={0} max={max / 100} step={5}
              value={spare ? max / 100 : Math.min(max, extra) / 100} onChange={e => { setSpare(false); setAmt(e.target.value) }} />
          </div>
          <div className="rw-snaps">
            {chips.map(c => <button key={c.k} type="button" className={!spare && Math.abs(extra - c.v) < 100 ? 'on' : ''}
              onClick={() => { setSpare(false); setAmt(String(dollars(c.v))) }}>{c.k} {money(c.v)}</button>)}
            <button type="button" className={spare ? 'on' : ''} onClick={() => setSpare(true)}>All spare</button>
          </div>
          <div className="rw-ends">
            <button type="button" onClick={() => { setSpare(false); setAmt('0') }}><b>{money(0)}</b>minimum only</button>
            <button type="button" className="r" onClick={() => { setSpare(false); setAmt(String(dollars(max))) }}><b>{money(max)}</b>a cycle</button>
          </div>
        </div>

        <div className="rw-lab">Starts</div>
        <DateChips value={pick} onChange={setPick} today={today} payDates={committed ? pays : []} label="Plan starts"
          tagFor={(_d, i) => (i === 0 ? 'this cycle' : 'payday')} />
        {!committed && !fromNow && <div className="rw-note">Set a plan from this cycle first. A later start needs a plan to change from.</div>}
        {!fromNow && committed && <div className="rw-hint">Until {short(start)} your plan stays as it is. Listed under Plan changes ahead.</div>}

        <Preview nowCents={nowCloses} newCents={newCloses} payDates={payDates} floorCents={floorCents} money={money}
          title="Before each payday until it’s cleared" ticks={fromNow ? [] : [kStart - k0]}
          done={{ now: baseClear >= 0 && baseClear - k0 < span ? baseClear - k0 : null, next: runClear >= 0 && runClear - k0 < span ? runClear - k0 : null }}
          third={{ k: 'Card cleared', v: runClear >= 0 ? monYr(nextDay(run[runClear].endDate)) : 'Later',
            d: !committed ? 'with this plan' : sooner > 0 ? `${sooner} cycle${sooner > 1 ? 's' : ''} sooner` : sooner < 0 ? `${-sooner} cycle${sooner < -1 ? 's' : ''} later` : 'no change',
            cls: sooner > 0 ? 'good' : sooner < 0 ? 'near' : '' }} />

        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || (!committed && !fromNow)} onClick={save}>
            {unchanged ? 'Keep my plan' : fromNow ? `Set as my plan${dInt >= 100 && committed ? ` · save ${money(dInt)}` : ''}` : `Set from ${short(start)}`}
          </button>
        </div>
        {committed && fromNow && (
          <button type="button" className="rw-lnk" disabled={busy} onClick={stopPlan}>Stop using a plan</button>
        )}
      </div>
    </div>
  )
}

/* ── a dated change: what it does, and removing it ──────────────────── */
function AheadSheet({ v, rows, k0, floorCents, money, accountId, card, planWords, onClose, toast }: {
  v: any; rows: ForecastResult; k0: number; floorCents: number; money: (c: number) => string; accountId: string; card: any
  planWords: (m: Mode, x: number) => string; onClose: () => void; toast: ReturnType<typeof useToast>
}) {
  const [busy, setBusy] = useState(false)
  const without = useMemo(() => projectFromRows({ ...rows, creditPlanRows: (rows.creditPlanRows ?? []).filter((x: any) => x.id !== v.id) }, floorCents, HORIZON), [rows, v])
  const cleared = (run: typeof rows.cycles) => run.findIndex((c, i) => i >= k0 && (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)
  const interest = (run: typeof rows.cycles) => run.slice(k0).reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)
  const cw = cleared(rows.cycles), co = cleared(without)
  const label = (run: typeof rows.cycles, i: number) => i >= 0 ? monYr(nextDay(run[i].endDate)) : 'Later'
  async function remove() {
    if (busy) return
    setBusy(true)
    try {
      await deleteCreditPlanVersion(v.id)
      toast(`Change from ${short(v.effective_from)} removed`, {
        undo: async () => { await setCreditPlanFrom(card.id, accountId, v.effective_from, v.mode, Number(v.extra_cents ?? 0)); notifyDataChanged() },
      })
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not remove it: ' + e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">From {day(v.effective_from)}</div>
          <div className="rw-sd">{planWords(v.mode, Number(v.extra_cents ?? 0))}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="rw-tiles two">
          <div className="rw-tile"><div className="k">Debt free</div><div className="v">{label(rows.cycles, cw)}</div><div className="d">without it {label(without, co)}</div></div>
          <div className="rw-tile"><div className="k">Interest</div><div className="v">{money(interest(rows.cycles))}</div><div className="d">without it {money(interest(without))}</div></div>
        </div>
        <div className="rw-note">Removing it keeps your plan as it is now, past {short(v.effective_from)} too.</div>
        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Close</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={remove}>Remove change</button>
        </div>
      </div>
    </div>
  )
}

/* ── card details: every term the card has ──────────────────────────── */
function DetailsSheet({ card, rows, k0, floorCents, money, sym, onClose, toast }: {
  card: any; rows: ForecastResult; k0: number; floorCents: number; money: (c: number) => string; sym: string; onClose: () => void
  toast: ReturnType<typeof useToast>
}) {
  const [name, setName] = useState(card.name ?? '')
  const [apr, setApr] = useState(String(card.apr_basis_points / 100))
  const [minPct, setMinPct] = useState(String(Number(card.min_payment_pct)))
  const [spend, setSpend] = useState(String((card.assumed_spend_cents ?? 0) / 100))
  const [freq, setFreq] = useState<'monthly' | 'per_cycle'>(card.payment_frequency === 'monthly' ? 'monthly' : 'per_cycle')
  const [due, setDue] = useState(card.payment_anchor_date ? String(parseDate(card.payment_anchor_date).getDate()) : '15')
  const [timing, setTiming] = useState<'every_cycle' | 'due_cycle'>(card.extra_timing === 'due_cycle' ? 'due_cycle' : 'every_cycle')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const aprBps = Math.round((parseFloat(apr) || 0) * 100)
  const minP = parseFloat(minPct) || 0
  const spendC = Math.max(0, Math.round((parseFloat(spend) || 0) * 100))
  const dueDay = Math.min(28, Math.max(1, parseInt(due || '1', 10) || 1))
  const now = new Date()
  const anchor = freq === 'monthly' ? formatDate(new Date(now.getFullYear(), now.getMonth(), dueDay)) : null
  const fields = {
    name: name.trim(), apr_basis_points: aprBps, min_payment_pct: minP, assumed_spend_cents: spendC,
    payment_frequency: freq, payment_anchor_date: anchor, extra_timing: freq === 'monthly' ? timing : ('every_cycle' as const),
  }
  const run = useMemo(() => projectFromRows({ ...rows, creditCard: { ...card, ...fields } }, floorCents, HORIZON),
    [aprBps, minP, spendC, freq, anchor, timing, rows])
  const cleared = (r: typeof rows.cycles) => r.findIndex((c, i) => i >= k0 && (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)
  const interest = (r: typeof rows.cycles) => r.slice(k0).reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)
  const label = (r: typeof rows.cycles) => { const i = cleared(r); return i >= 0 ? monYr(nextDay(r[i].endDate)) : 'Later' }
  async function save() {
    if (!fields.name) { setErr('Give the card a name.'); return }
    if (!aprBps || minP <= 0) { setErr('Rate and minimum payment are needed.'); return }
    setBusy(true); setErr('')
    const before = { name: card.name, apr_basis_points: card.apr_basis_points, min_payment_pct: Number(card.min_payment_pct),
      assumed_spend_cents: card.assumed_spend_cents, payment_frequency: card.payment_frequency ?? 'per_cycle',
      payment_anchor_date: card.payment_anchor_date ?? null, extra_timing: card.extra_timing ?? 'every_cycle' }
    try {
      await updateCreditAccount(card.id, fields)
      toast('Card details saved', { undo: async () => { await updateCreditAccount(card.id, before); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">Card details</div><div className="rw-sd">{card.name}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="rw-lab">Name</div>
        <TextField value={name} onChange={setName} label="Card name" />
        <div className="rw-lab">How you pay it</div>
        <Segmented value={freq} onChange={setFreq} options={[{ value: 'monthly', label: 'Monthly, due date' }, { value: 'per_cycle', label: 'Every cycle' }]} />
        <div className="rw-cp-f2">
          <div><div className="rw-lab">Interest rate</div>
            <div className="rw-amtrow"><input type="number" inputMode="decimal" step="0.1" aria-label="Interest rate" value={apr} onChange={e => setApr(e.target.value)} /><em>% a year</em></div></div>
          <div><div className="rw-lab">Minimum</div>
            <div className="rw-amtrow"><input type="number" inputMode="decimal" step="0.5" aria-label="Minimum payment" value={minPct} onChange={e => setMinPct(e.target.value)} /><em>% of balance</em></div></div>
          {freq === 'monthly' && <div><div className="rw-lab">Due day</div>
            <div className="rw-amtrow"><input type="number" inputMode="numeric" aria-label="Due day" value={due} onChange={e => setDue(e.target.value)} /><em>each month</em></div></div>}
          <div><div className="rw-lab">New spending</div>
            <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="New spending on the card each cycle" value={spend} onChange={e => setSpend(e.target.value)} /><em>a cycle</em></div></div>
        </div>
        {freq === 'monthly' && <>
          <div className="rw-lab">The extra goes out</div>
          <Segmented value={timing} onChange={setTiming} options={[{ value: 'every_cycle', label: 'With every pay' }, { value: 'due_cycle', label: 'In the due cycle' }]} />
        </>}
        <div className="rw-hint">New spending: what you expect to put on the card each cycle. $0 only if you've stopped using it.</div>
        {card.strategy_committed && (
          <div className="rw-tiles two">
            <div className="rw-tile"><div className="k">Debt free</div><div className="v">{label(run)}</div><div className="d">was {label(rows.cycles)}</div></div>
            <div className="rw-tile"><div className="k">Interest</div><div className="v">{money(interest(run))}</div><div className="d">was {money(interest(rows.cycles))}</div></div>
          </div>
        )}
        {err && <div className="rw-note" style={{ color: 'var(--rw-under-floor)' }}>{err}</div>}
        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}

/* ── no card yet ─────────────────────────────────────────────────────── */
function AddCard({ accountId, sym, onAdded }: { accountId: string; sym: string; onAdded: () => void }) {
  const [name, setName] = useState('Credit card')
  const [bal, setBal] = useState('')
  const [apr, setApr] = useState('21.9')
  const [minPct, setMinPct] = useState('3')
  const [spend, setSpend] = useState('0')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function add() {
    const aprBps = Math.round((parseFloat(apr) || 0) * 100), minP = parseFloat(minPct) || 0
    if (!name.trim()) { setErr('Give the card a name.'); return }
    if (!aprBps || minP <= 0) { setErr('Rate and minimum payment are needed.'); return }
    setBusy(true); setErr('')
    try {
      await createCreditAccount(accountId, {
        name: name.trim(), apr_basis_points: aprBps, min_payment_pct: minP, min_payment_floor_cents: 1000,
        assumed_spend_cents: Math.max(0, Math.round((parseFloat(spend) || 0) * 100)),
      }, Math.max(0, Math.round((parseFloat(bal) || 0) * 100)), t0())
      notifyDataChanged(); onAdded()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="rw-page">
      <div className="rw-page-head"><div className="rw-page-title">Credit</div>
        <div className="rw-sd">Add a card and its minimum, interest and payoff go into your forecast once you set a plan.</div></div>
      <div className="rw-card rw-inset">
        <div className="rw-lab" style={{ marginTop: 0 }}>Name</div>
        <TextField value={name} onChange={setName} label="Card name" />
        <div className="rw-lab">Balance owing now</div>
        <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" placeholder="0" aria-label="Balance owing now" value={bal} onChange={e => setBal(e.target.value)} /></div>
        <div className="rw-cp-f2">
          <div><div className="rw-lab">Interest rate</div>
            <div className="rw-amtrow"><input type="number" inputMode="decimal" aria-label="Interest rate" value={apr} onChange={e => setApr(e.target.value)} /><em>% a year</em></div></div>
          <div><div className="rw-lab">Minimum</div>
            <div className="rw-amtrow"><input type="number" inputMode="decimal" aria-label="Minimum payment" value={minPct} onChange={e => setMinPct(e.target.value)} /><em>% of balance</em></div></div>
        </div>
        <div className="rw-lab">New spending</div>
        <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="New spending each cycle" value={spend} onChange={e => setSpend(e.target.value)} /><em>a cycle</em></div>
        <div className="rw-hint">What you expect to put on the card each cycle. $0 only if you've stopped using it.</div>
        {err && <div className="rw-note" style={{ color: 'var(--rw-under-floor)' }}>{err}</div>}
      </div>
      <div className="rw-ctas" style={{ margin: '12px 12px 0' }}>
        <button type="button" className="rw-cta" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add card'}</button>
      </div>
    </div>
  )
}
