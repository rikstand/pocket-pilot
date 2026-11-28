import { useEffect, useMemo, useRef, useState } from 'react'
import { bnplPayments } from '../lib/bnpl'
import SheetGuard from './SheetGuard'
import Sheet, { reportError } from './Sheet'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, type ForecastResult } from '../lib/forecast'
import { savedSoFarCents } from '../lib/savings'
import {
  getWishlistItems, addWishlistItem, deleteWishlistItem, restoreWishlistItem, releaseWishlistItem, relinkWishlistItem,
  commitWishlistBnpl, commitWishlistSaving, uncommitWishlistItem, deleteSavingsGoal,
  replaceBnplPayments, clearBnplFrom, markBnplPaymentMissed, undoBnplMissed,
  setExpenseEndDate, deactivateBnplPlan, reactivateExpense, reactivateLayBy,
} from '../lib/repository'
import { parseDate, formatDate, addDays, addMonths } from '../engine/dates'
import { notifyDataChanged, useDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import Preview, { previewStats } from './Preview'
import { Stepper, Segmented, DateChips, TextField } from './controls'
import { Mark } from './ItemsPage'
import { KeyDone } from './LegendKeys'
import SavingsSheet from './SavingsSheet'
import { underFloor } from '../engine/floor'
import { dateLocale } from '../lib/dateFormat'
import { FitsQ } from './Terms'

/**
 * Plan › Wishlist (Journey 3 and the wishlist comparison, release 5a; mock
 * claude/pp-wishlist-v5.html, signed off 18 Nov).
 *
 *   Wanted      things not planned yet: compare Save up and BNPL, then pick one
 *   Paying off  every BNPL plan with payments ahead, from here or from Cycle:
 *               Change, Pay off early, Missed one, Stop
 *   Saving up   items saved for, through a Savings goal of the same name
 *   Done        plans that have finished, until the item is removed
 *
 * Previews take each payment off "left before each payday" from the cycle
 * it falls in onward, the way the old Wishlist did. Under a "whatever's
 * spare" card plan every payday sits at the floor, so a purchase reads as too
 * soon until the card is cleared (accepted Nov 2026).
 */

const NUM_CYCLES = 27
const todayStr = () => formatDate(new Date())
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
// The year only when it's more than about 11 months away (design system).
const short = (d: string) => {
  const x = parseDate(d), far = (x.getTime() - Date.now()) / 864e5 > 330
  return x.toLocaleDateString(dateLocale(), far ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
}

type Pay = { date: string; cents: number }
type Freq = 'weekly' | 'fortnightly' | 'monthly'

/** Equal payments; the last one takes the rounding (as every BNPL plan does). */
function split(totalCents: number, n: number, first: string, freq: Freq): Pay[] {
  const each = Math.floor(totalCents / n)
  return Array.from({ length: n }, (_, i) => ({
    date: freq === 'monthly' ? formatDate(addMonths(parseDate(first), i)) : shift(first, (freq === 'weekly' ? 7 : 14) * i),
    cents: i < n - 1 ? each : totalCents - each * (n - 1),
  }))
}

function freqOf(row: any, t: string): Freq {
  const v = [...(row.expense_schedule_versions ?? [])].filter((s: any) => s.effective_from <= t)
    .sort((a: any, b: any) => b.effective_from.localeCompare(a.effective_from))[0]
  const f = v?.frequency ?? row.frequency
  return f === 'weekly' || f === 'monthly' ? f : 'fortnightly'
}

/* ── the forecast, and what a list of payments does to it ── */
function useModel(rows: ForecastResult, floorCents: number) {
  return useMemo(() => {
    const cycles = rows.cycles
    const now = cycles.map(c => c.committedClosingBalanceCents)
    const payDates = cycles.map(c => shift(c.endDate, 1))
    const t = todayStr()
    // Which cycle a date falls in: anything before the first open cycle counts there.
    const idx = (d: string) => { const k = cycles.findIndex(c => d <= c.endDate); return k < 0 ? cycles.length : k }
    const len = cycles.length > 1 ? Math.round((parseDate(cycles[cycles.length - 1].startDate).getTime() - parseDate(cycles[cycles.length - 2].startDate).getTime()) / 864e5) : 14
    const startOf = (k: number) => k < cycles.length ? cycles[k].startDate : shift(cycles[cycles.length - 1].startDate, len * (k - cycles.length + 1))
    /** Left before each payday with these payments out (and these back in). */
    const after = (out: { k: number; cents: number }[], back: { k: number; cents: number }[] = []) => {
      const v = now.slice()
      for (const p of out) for (let k = Math.max(0, p.k); k < v.length; k++) v[k] -= p.cents
      for (const p of back) for (let k = Math.max(0, p.k); k < v.length; k++) v[k] += p.cents
      return v
    }
    const dated = (list: Pay[]) => list.map(p => ({ k: idx(p.date), cents: p.cents }))
    /** It fits when no payday it lowers ends up under the floor. */
    const fits = (v: number[]) => v.every((c, k) => !underFloor(c, floorCents) || c >= now[k])
    return { cycles, now, payDates, t, idx, startOf, after, dated, fits }
  }, [rows, floorCents])
}
type Model = ReturnType<typeof useModel>

/* ── the page ── */
export default function WishlistPlan({ accountId, userId }: { accountId: string; userId: string }) {
  const { activeAccount } = useAccount()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const [rows, setRows] = useState<ForecastResult | null>(null)
  const [items, setItems] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<{ kind: 'compare' | 'running' | 'saving' | 'done' | 'add'; id?: string } | null>(null)

  async function load() {
    try {
      const [f, w] = await Promise.all([loadForecast(accountId, floorCents, { numCycles: NUM_CYCLES }), getWishlistItems(accountId)])
      setRows(f); setItems(w); setError('')
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [accountId, floorCents])
  useDataChanged(load)

  if (error) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">{error}</div></div></div>
  if (!rows || !items) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">Loading…</div></div></div>
  return <WishlistBody rows={rows} items={items} accountId={accountId} userId={userId} floorCents={floorCents}
    fmt={fmt} sym={sym} open={open} setOpen={setOpen} />
}

function WishlistBody({ rows, items, accountId, userId, floorCents, fmt, sym, open, setOpen }: {
  rows: ForecastResult; items: any[]; accountId: string; userId: string; floorCents: number
  fmt: (c: number, minor?: boolean) => string; sym: string
  open: { kind: 'compare' | 'running' | 'saving' | 'done' | 'add'; id?: string } | null
  setOpen: (o: { kind: 'compare' | 'running' | 'saving' | 'done' | 'add'; id?: string } | null) => void
}) {
  const toast = useToast()
  const m = useModel(rows, floorCents)
  const t = m.t
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const moneyC = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), Math.abs(c) % 100 !== 0)
  const close = () => setOpen(null)
  const saved = () => { close(); notifyDataChanged() }

  // Every BNPL plan, from here or from Cycle; a wishlist item points at its expense.
  const plans = rows.expenseRows.filter((r: any) => r.lay_by_id && r.is_active !== false)
    .map((r: any) => ({ row: r, item: items.find(i => i.committed_expense_id === r.id) ?? null, ...bnplPayments(r, t) }))
  const paying = plans.filter(p => p.ahead.length > 0)
  const goals = rows.savingsGoalRows ?? []
  const goalOf = (i: any) => goals.find((g: any) => g.id === i.savings_goal_id && g.is_active !== false && g.status !== 'cancelled')
  const wanted = items.filter(i => i.status === 'active')
  const saving = items.filter(i => i.status !== 'active' && goalOf(i))
  const done = items.filter(i => i.status !== 'active' && !goalOf(i) && !paying.some(p => p.item?.id === i.id))
  const lastOf = (i: any) => plans.find(p => p.row.id === i.committed_expense_id)?.all.slice(-1)[0]?.date

  const openItem = items.find(i => i.id === open?.id)
  const openPlan = plans.find(p => p.row.id === open?.id)

  async function removeItem(i: any, msg: string) {
    try {
      await deleteWishlistItem(i.id)
      toast(msg, { lasting: true, undo: async () => { await restoreWishlistItem(i); notifyDataChanged() } })
      saved()
    } catch (e: any) { reportError('That wasn’t removed.', e) }
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head rw-head-row">
        <h1 className="rw-page-title">Wishlist</h1>
        <button type="button" className="rw-addb" onClick={() => setOpen({ kind: 'add' })}>+ Add</button>
      </div>
      <div className="rw-page-head" style={{ paddingTop: 0 }}>
        <div className="rw-sub">Things you’d buy if the money’s there. Compare ways to pay before any of it reaches your forecast.</div>
      </div>

      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Wanted · {wanted.length}</span><span>{money(wanted.reduce((s, i) => s + i.amount_cents, 0))}</span></div>
      <div className="rw-group">
        {wanted.length === 0 && <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">Nothing here. Add something you’d like to buy.</div></div></div>}
        {wanted.map(i => (
          <button key={i.id} type="button" className="rw-row" onClick={() => setOpen({ kind: 'compare', id: i.id })}>
            <WantMark />
            <div className="rw-tx"><div className="rw-row-name">{i.name}</div><div className="rw-sub">Not planned · compare ways to pay</div></div>
            <div className="rw-am">{money(i.amount_cents)}</div><span className="rw-chev">›</span>
          </button>
        ))}
      </div>

      {paying.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Paying off · {paying.length}</span><span>BNPL</span></div>
        <div className="rw-group">
          {paying.map(p => {
            const real = p.all.filter(x => !x.missed), owe = p.ahead.reduce((s, x) => s + x.cents, 0)
            const miss = p.all.some(x => x.missed)
            return (
              <button key={p.row.id} type="button" className="rw-row" onClick={() => setOpen({ kind: 'running', id: p.row.id })}>
                <Mark kind="bnpl" />
                <div className="rw-tx"><div className="rw-row-name">{p.item?.name ?? p.row.name}</div>
                  <div className="rw-sub">{p.paid.length} of {real.length} paid{miss ? ' · one missed' : ''} · next {p.ahead[0].date === t ? 'today' : short(p.ahead[0].date)}, {moneyC(p.ahead[0].cents)}</div>
                  <div className="rw-pb" aria-hidden="true"><i style={{ width: (p.paid.length / Math.max(1, real.length) * 100) + '%' }} /></div></div>
                <div className="rw-am">{moneyC(owe)}<small>left</small></div><span className="rw-chev">›</span>
              </button>
            )
          })}
        </div>
      </>}

      {saving.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Saving up · {saving.length}</span><span>a Savings goal each</span></div>
        <div className="rw-group">
          {saving.map(i => {
            const g = goalOf(i), have = savedSoFarCents(g, rows.savingsContributionRows, rows.savingsOverrideRows)
            return (
              <button key={i.id} type="button" className="rw-row" onClick={() => setOpen({ kind: 'saving', id: i.id })}>
                <span className="rw-savmark" aria-hidden="true" />
                <div className="rw-tx"><div className="rw-row-name">{i.name}</div>
                  <div className="rw-sub">{have >= g.target_cents ? 'Saved · ready when you are' : `${money(have)} of ${money(g.target_cents)} · ${money(g.per_cycle_cents)} a cycle`}</div>
                  <div className="rw-pb" aria-hidden="true"><i style={{ width: Math.min(100, have / Math.max(1, g.target_cents) * 100) + '%' }} /></div></div>
                <div className="rw-am">{money(i.amount_cents)}</div><span className="rw-chev">›</span>
              </button>
            )
          })}
        </div>
      </>}

      {done.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Done · {done.length}</span><span>paid for</span></div>
        <div className="rw-group">
          {done.map(i => {
            const last = lastOf(i)
            return (
              <button key={i.id} type="button" className="rw-row" onClick={() => setOpen({ kind: 'done', id: i.id })}>
                <Mark kind="bnpl" />
                <div className="rw-tx"><div className="rw-row-name">{i.name}</div><div className="rw-sub">{last ? `Paid off ${short(last)}` : 'No plan running'}</div></div>
                <div className="rw-am">{money(i.amount_cents)}</div><span className="rw-chev">›</span>
              </button>
            )
          })}
        </div>
      </>}

      {open?.kind === 'compare' && openItem && <CompareSheet key={openItem.id} item={openItem} m={m} floorCents={floorCents} sym={sym} money={money} moneyC={moneyC}
        accountId={accountId} userId={userId} onClose={close} onSaved={saved}
        onRemove={() => removeItem(openItem, `${openItem.name} removed from your Wishlist`)} />}
      {open?.kind === 'running' && openPlan && <RunningSheet key={openPlan.row.id} plan={openPlan} m={m} floorCents={floorCents} sym={sym} money={money} moneyC={moneyC}
        accountId={accountId} userId={userId} onClose={close} onSaved={saved} />}
      {open?.kind === 'saving' && openItem && goalOf(openItem) && <SheetGuard onClose={close}><SavingsSheet accountId={accountId} goalId={goalOf(openItem).id} rows={rows} wishItem={openItem} onClose={close} /></SheetGuard>}
      {open?.kind === 'done' && openItem && <DoneSheet item={openItem} last={lastOf(openItem)} money={money} onClose={close}
        onRemove={() => removeItem(openItem, `${openItem.name} removed from your Wishlist`)} />}
      {open?.kind === 'add' && <AddWantSheet accountId={accountId} userId={userId} sym={sym} onClose={close} onSaved={saved} />}
    </div>
  )
}

/** A wanted item: an outline star, the Plan tab's shape (signed off 18 Nov). */
function WantMark() {
  return <svg className="rw-mark" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l1.2 2.5 2.8.4-2 2 .5 2.8L5 7.4 2.5 8.7l.5-2.8-2-2 2.8-.4z" fill="none" stroke="var(--rw-muted)" strokeWidth="1.1" strokeLinejoin="round" /></svg>
}

function SheetHead({ mark, title, sub, onClose }: { mark: React.ReactNode; title: string; sub: string; onClose: () => void }) {
  return (
    <div className="rw-sh-h">
      <div className="rw-sh-t">{mark}<div>
        <h2 className="rw-sheet-title">{title}</h2>
        <div className="rw-sd">{sub}</div></div></div>
      <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
    </div>
  )
}

/* ── the comparison: chart and table on top, the chosen way underneath ── */
type Way = 'save' | 'bnpl'
const COL: Record<Way, string> = { save: 'var(--rw-line)', bnpl: 'var(--rw-bnpl)' }
const NAME: Record<Way, string> = { save: 'Save up', bnpl: 'BNPL' }
const WAYS: Way[] = ['save', 'bnpl']

function CompareSheet({ item, m, floorCents, sym, money, moneyC, accountId, userId, onClose, onSaved, onRemove }: {
  item: any; m: Model; floorCents: number; sym: string; money: (c: number) => string; moneyC: (c: number) => string
  accountId: string; userId: string; onClose: () => void; onSaved: () => void; onRemove: () => void
}) {
  const toast = useToast()
  const t = m.t, price = item.amount_cents as number
  const nextPays = m.cycles.slice(1).map(c => c.startDate).filter(d => d > t)
  const [way, setWay] = useState<Way>('bnpl')
  const [busy, setBusy] = useState(false)

  /* BNPL */
  const [n, setN] = useState(4)
  const [fq, setFq] = useState<'weekly' | 'fortnightly'>('fortnightly')
  const [fee, setFee] = useState('')
  const feeC = Math.max(0, Math.round((parseFloat(fee) || 0) * 100))
  const mkB = (d: string) => split(price + feeC, n, d, fq)
  const okB = (d: string) => m.fits(m.after(m.dated(mkB(d))))
  const earlyB = useMemo(() => { for (let i = 0; i <= 364; i++) { const d = shift(t, i); if (okB(d)) return d } return null }, [n, fq, feeC, m])
  const [bPick, setBPick] = useState<string | null>(null)
  const bStart = bPick ?? earlyB ?? t
  const bList = mkB(bStart)

  /* Save up: the same each cycle from the cycle the start falls in; the last one tops it up */
  const mkS = (d: string, per: number) => {
    const k0 = m.idx(d), cnt = Math.max(1, Math.ceil(price / per))
    return Array.from({ length: cnt }, (_, i) => ({ k: k0 + i, cents: i < cnt - 1 ? per : price - per * (cnt - 1) }))
  }
  const fitsS = (d: string, limit = floorCents) => {
    let f: number | null = null
    // $5 steps, and the whole price (all at once) as the last one.
    const steps = [] as number[]
    for (let per = Math.min(1000, price); per < price; per += 500) steps.push(per)
    steps.push(price)
    for (const per of steps) {
      const v = m.after(mkS(d, per)); const ok = limit === floorCents ? m.fits(v) : Math.min(...v) >= limit
      if (ok) f = per; else if (f != null) break
    }
    return f
  }
  // Save up opens on the earliest start where saving at Fits is done by BNPL's last payment.
  const saveDefault = useMemo(() => {
    const end = m.idx(bList[bList.length - 1].date)
    let best: { st: string; per: number; fin: number } | null = null
    for (const st of [t, ...nextPays.slice(0, 12)]) {
      const f = fitsS(st); if (f == null) continue
      const l = mkS(st, f), fin = l[l.length - 1].k
      if (fin <= end) return { st, per: f }
      if (!best || fin < best.fin) best = { st, per: f, fin }
    }
    return best ?? { st: t, per: Math.max(1000, Math.ceil(price / 8 / 500) * 500) }
  }, [])
  const [sStart, setSStart] = useState(saveDefault.st)
  const [per, setPer] = useState(saveDefault.per)
  const sList = mkS(sStart, per)
  const sFit = useMemo(() => fitsS(sStart), [sStart, m])
  const sZero = useMemo(() => fitsS(sStart, 0), [sStart, m])

  const calc = (w: Way) => {
    const v = w === 'bnpl' ? m.after(m.dated(bList)) : m.after(sList)
    const st = previewStats(m.now, v, floorCents)
    const lastK = w === 'bnpl' ? m.idx(bList[bList.length - 1].date) : sList[sList.length - 1].k
    const ownSave = sList[sList.length - 1].k === m.idx(t) ? t : m.startOf(sList[sList.length - 1].k)
    return {
      v, lo: st.lowestCents, li: st.lowestIdx, lv: st.worse ? st.level : 'ok', lastK,
      own: w === 'bnpl' ? bList[0].date : ownSave,
      paid: w === 'bnpl' ? bList[bList.length - 1].date : ownSave,
      cost: w === 'bnpl' ? price + feeC : price,
    }
  }
  const o = { save: calc('save'), bnpl: calc('bnpl') }
  const x = o[way]
  const span = Math.min(m.now.length, Math.max(8, o.save.lastK + 3, o.bnpl.lastK + 3, o.save.li + 2, o.bnpl.li + 2))

  // The earliest date that fits is one of the chips, so it needs no button of its own.
  const bChips = (() => {
    const base = nextPays.slice(0, 3)
    if (earlyB && earlyB > t && !base.includes(earlyB)) return [...base.slice(0, 2), earlyB].sort()
    return base
  })()

  /* the amount slider (the card sheet's) */
  const lo = Math.min(1000, price), hi = Math.max(lo + 500, Math.min(price, Math.ceil(Math.max((sFit ?? 0) + 20000, 40000) / 5000) * 5000))
  const pct = (c: number) => (Math.max(lo, Math.min(hi, c)) - lo) / (hi - lo) * 100
  const sTag = sZero != null && per > sZero ? <span className="n">{money(per - sZero)} past $0 · overdrawn</span>
    : sZero == null ? <span className="n">Any amount takes a payday past $0</span>
    : sFit != null && per > sFit ? <span className="w">{money(per - sFit)} more than fits · into your floor</span>
    : sFit == null ? <span className="w">Even {money(lo)} leaves a payday under your floor</span> : null

  async function commit() {
    if (busy) return
    setBusy(true)
    try {
      if (way === 'bnpl') {
        const made = await commitWishlistBnpl(accountId, userId, { id: item.id, name: item.name },
          { frequency: fq, payments: bList.map(p => ({ date: p.date, amountCents: p.cents })) })
        toast(`${item.name}: ${n} payments from ${bList[0].date === t ? 'today' : short(bList[0].date)}. They’re in your forecast now.`,
          { undo: async () => { await uncommitWishlistItem(item.id, made.expense.id); notifyDataChanged() } })
      } else {
        const k0 = m.idx(sStart)
        const goal = await commitWishlistSaving(accountId, { id: item.id, name: item.name, amountCents: price },
          { perCycleCents: per, cyclesTotal: sList.length, startCycleStart: m.startOf(k0), targetDate: m.startOf(sList[sList.length - 1].k) })
        toast(`${item.name}: saving ${money(per)} a cycle.`,
          { undo: async () => { await deleteSavingsGoal(goal.id); await releaseWishlistItem(item.id); notifyDataChanged() } })
      }
      onSaved()
    } catch (e: any) { reportError('That plan wasn’t saved.', e) }
    finally { setBusy(false) }
  }

  const btn = way === 'bnpl' ? `Add BNPL · from ${bStart === t ? 'today' : short(bStart)}` : `Save ${money(per)} a cycle`

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <SheetHead mark={<WantMark />} title={item.name} sub={`${money(price)} · two ways to pay, compared`} onClose={onClose} />

      <CompareChart lines={{ save: o.save.v, bnpl: o.bnpl.v }} done={{ save: o.save.lastK, bnpl: o.bnpl.lastK }} now={m.now} payDates={m.payDates}
        floorCents={floorCents} way={way} span={span} onPick={setWay} money={money} />
      <div className="rw-card rw-cmp">
        <table>
          <thead><tr><th scope="col"><span className="rw-sr">Compare</span></th>
            {WAYS.map(w => <th key={w} scope="col" className={w === way ? 'on' : ''}>
              <button type="button" aria-pressed={w === way} onClick={() => setWay(w)}><i style={{ background: COL[w] }} />{NAME[w]}</button></th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Yours from</th>{WAYS.map(w => <td key={w} className={w === way ? 'on' : ''} onClick={() => setWay(w)}>{o[w].own === t ? 'Today' : short(o[w].own)}</td>)}</tr>
            <tr><th scope="row">Fully paid</th>{WAYS.map(w => <td key={w} className={w === way ? 'on' : ''} onClick={() => setWay(w)}>{o[w].paid === t ? 'Today' : short(o[w].paid)}</td>)}</tr>
            <tr><th scope="row">Total cost</th>{WAYS.map(w => { const e = o[w].cost - price
              return <td key={w} className={w === way ? 'on' : ''} onClick={() => setWay(w)}>{moneyC(o[w].cost)}{e > 0 && <small>{moneyC(e)} fees</small>}</td> })}</tr>
            <tr><th scope="row">Lowest payday</th>{WAYS.map(w => <td key={w} className={w === way ? 'on' : ''} onClick={() => setWay(w)}>
              <span className={o[w].lv}>{money(o[w].lo)}</span>{o[w].lv !== 'ok' && <small>{o[w].lv === 'under' ? 'overdrawn' : 'into floor'}</small>}</td>)}</tr>
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14 }}>
        <Segmented value={way} onChange={setWay} options={[{ value: 'save', label: 'Save up' }, { value: 'bnpl', label: 'BNPL' }]} />
      </div>

      {way === 'bnpl' ? (
        <div className="rw-card" style={{ marginTop: 8 }}>
          <div className="rw-amt-row rw-between">
            <span className="rw-row-name">Payments</span>
            <Stepper value={n} onChange={v => { setN(v); setBPick(null) }} min={2} max={12} label="Payments" />
          </div>
          <div style={{ marginTop: 10 }}>
            <Segmented small value={fq} onChange={v => { setFq(v); setBPick(null) }} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }]} />
          </div>
          <div className="rw-gain flat"><b>{n} × {moneyC(bList[0].cents)}</b><span>{fq} · {short(bList[0].date)} to {short(bList[bList.length - 1].date)}</span></div>
          <div className="rw-lab">First payment</div>
          <DateChips value={bStart} onChange={setBPick} today={t} payDates={bChips} label="First payment" keep={earlyB}
            tagFor={d => d === earlyB ? 'earliest' : okB(d) ? 'fits' : 'too soon'} />
          {!earlyB && <div className="rw-hint">No start in the next year keeps every payday above your floor. Try more payments.</div>}
          <div className="rw-fld flush">
            <div className="l">Fees, if any<small>Any the provider charges on top</small></div>
            <div className="rw-fld-in">{sym}<input type="number" inputMode="decimal" placeholder="0" aria-label="Fees" value={fee} onChange={e => setFee(e.target.value)} /></div>
          </div>
        </div>
      ) : (
        <div className="rw-card rw-sl-card" style={{ marginTop: 8 }}>
          <div className="rw-pv-k"><span>Set aside each cycle</span></div>
          <div className="rw-amt"><span>{sym}</span>
            <input type="number" inputMode="decimal" aria-label="Set aside each cycle" value={per / 100}
              onChange={e => setPer(Math.max(100, Math.round((parseFloat(e.target.value) || 0) * 100)))} /></div>
          <div className="rw-gain flat"><b>{sList.length} cycle{sList.length > 1 ? 's' : ''}</b><span>yours {o.save.own === t ? 'today' : 'on ' + short(o.save.own)}</span></div>
          {sTag && <div className="rw-sl-tag">{sTag}</div>}
          <div className="rw-sl">
            <div className="sl-rail" />
            {sFit != null && sFit < hi && <div className="sl-zone" style={{ left: pct(sFit) + '%', right: (sZero != null && sZero < hi ? 100 - pct(sZero) : 0) + '%' }} />}
            {sFit == null && <div className="sl-zone" style={{ left: 0, right: (sZero != null && sZero < hi ? 100 - pct(sZero) : 0) + '%' }} />}
            {sZero != null && sZero < hi && <div className="sl-zone neg" style={{ left: pct(sZero) + '%', right: 0 }} />}
            {sZero == null && <div className="sl-zone neg" style={{ left: 0, right: 0 }} />}
            <div className="sl-fill" style={{ width: pct(per) + '%' }} />
            {sFit != null && <div className={`sl-mk${per === sFit ? ' on' : ''}`} style={{ left: pct(sFit) + '%' }} />}
            <input type="range" aria-label="Set aside each cycle" aria-valuetext={`${money(per)} a cycle`} min={lo / 100} max={hi / 100} step={5}
              value={Math.min(hi, Math.max(lo, per)) / 100} onChange={e => setPer(Math.round(+e.target.value * 100))} />
          </div>
          {sFit != null && <div className="rw-snaps"><button type="button" className={per === sFit ? 'on' : ''} onClick={() => setPer(sFit)}>Fits {money(sFit)}</button><FitsQ /></div>}
          <div className="rw-ends">
            <button type="button" onClick={() => setPer(lo)}><b>{money(lo)}</b>smallest</button>
            <button type="button" className="r" onClick={() => setPer(hi)}><b>{money(hi)}</b>{hi >= price ? 'all at once' : 'top of range'}</button>
          </div>
          <div className="rw-lab">First set aside</div>
          <DateChips value={sStart} onChange={setSStart} today={t} payDates={nextPays} label="First set aside"
            tagFor={d => m.fits(m.after(mkS(d, per))) ? 'fits' : 'too soon'} />
        </div>
      )}

      {x.lv === 'under' ? <div className="rw-warn-ban under"><span className="i">!</span><span>You’d be <b>{money(-x.lo)} overdrawn</b> before pay {short(m.payDates[x.li])}.</span></div>
        : x.lv === 'near' ? <div className="rw-warn-ban near"><span>Before pay {short(m.payDates[x.li])} dips <b>{money(floorCents - x.lo)}</b> into your floor. You’d still have {money(x.lo)}.</span></div> : null}

      <div className="rw-group flush" style={{ marginTop: 12 }}>
        <button type="button" className="rw-row" onClick={onRemove} disabled={busy}>
          <div className="rw-tx"><div className="rw-row-name rw-danger">Remove from Wishlist</div><div className="rw-sub">Bought it another way, or changed your mind</div></div>
        </button>
      </div>

      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={busy} onClick={commit}>{busy ? 'Saving…' : <>{btn}{x.lv === 'under' ? ' anyway' : ''}</>}</button>
      </div>
    </Sheet>
  )
}

/* The comparison chart (approved 14 Nov): one line per way, in its type colour. Drag to read. */
function CompareChart({ lines, done, now, payDates, floorCents, way, span, onPick, money }: {
  lines: Record<Way, number[]>; done: Record<Way, number>; now: number[]; payDates: string[]; floorCents: number
  way: Way; span: number; onPick: (w: Way) => void; money: (c: number) => string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const n = Math.max(2, span), W = 300, H = 132, X0 = 8, X1 = W - 8, T = 14, B = H - 20
  const ghost = now.slice(0, n), ls = { save: lines.save.slice(0, n), bnpl: lines.bnpl.slice(0, n) }
  const all = [...ghost, ...ls.save, ...ls.bnpl, floorCents]
  const lowest = Math.min(...all)
  let mx = Math.max(...all), mn = lowest < 0 ? lowest : Math.max(0, lowest - (mx - lowest) * 0.15)
  mx += (mx - mn) * 0.08 || 100
  const X = (i: number) => X0 + i * (X1 - X0) / (n - 1), Y = (c: number) => B - (c - mn) / (mx - mn) * (B - T)
  const pts = (a: number[]) => a.map((c, i) => `${X(i)},${Y(c)}`).join(' ')
  const order: Way[] = way === 'save' ? ['bnpl', 'save'] : ['save', 'bnpl']
  const di = Math.min(n - 1, done[way])
  const axis = [0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1]
  const d = (s: string) => parseDate(s).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
  return (
    <div className="rw-card rw-pv" style={{ marginTop: 10 }}>
      <div className="rw-pv-k"><span>Left before each payday</span></div>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="rw-pv-svg" role="img" aria-label="Left before each payday with each way to pay"
        onPointerMove={e => { const r = ref.current!.getBoundingClientRect(); const xx = (e.clientX - r.left) / r.width * W; setScrub(Math.max(0, Math.min(n - 1, Math.round((xx - X0) / (X1 - X0) * (n - 1))))) }}
        onPointerLeave={() => setScrub(null)} onPointerCancel={() => setScrub(null)}>
        {mn < 0 && <><rect x={X0} y={Y(0)} width={X1 - X0} height={Math.max(0, B - Y(0))} fill="var(--rw-under-floor)" opacity=".07" />
          <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-under-floor)" strokeWidth="1.2" /></>}
        <line x1={X0} x2={X1} y1={Y(floorCents)} y2={Y(floorCents)} stroke="var(--rw-under-floor)" strokeDasharray="3 3" />
        <polyline points={pts(ghost)} fill="none" stroke="var(--rw-ink)" strokeOpacity=".35" strokeWidth="2" strokeLinejoin="round" />
        {order.map(w => <polyline key={w} points={pts(ls[w])} fill="none" stroke={COL[w]} strokeWidth={w === way ? 2.6 : 1.6} opacity={w === way ? 1 : .55}
          strokeLinejoin="round" style={{ cursor: 'pointer' }} onClick={() => onPick(w)} />)}
        {ls[way].map((c, i) => c < floorCents && c < ghost[i] ? <circle key={i} cx={X(i)} cy={Y(c)} r="3.4" fill={c < 0 ? 'var(--rw-under-floor)' : 'var(--rw-near-floor)'} /> : null)}
        {done[way] < n && (() => { const cx = X(di), cy = Y(ls[way][di]); return <g><circle cx={cx} cy={cy} r="6" fill={COL[way]} stroke="var(--rw-surface)" strokeWidth="2" />
          <path d={`M${cx - 2.6} ${cy}l1.8 1.9 3.4-3.6`} fill="none" stroke="var(--rw-surface)" strokeWidth="1.6" strokeLinecap="round" /></g> })()}
        {scrub != null && (() => {
          const sx = X(scrub), left = scrub > (n - 1) / 2
          const label = `${d(payDates[scrub])} · Save up ${money(ls.save[scrub])} · BNPL ${money(ls.bnpl[scrub])}`
          const w = label.length * 5.6 + 10
          return <g pointerEvents="none"><line x1={sx} x2={sx} y1={T} y2={B} stroke="var(--rw-ink)" opacity=".3" />
            <rect x={left ? sx - w - 4 : sx + 4} y={T - 2} width={w} height="15" rx="4" fill="var(--rw-surface)" opacity=".94" />
            <text x={left ? sx - 9 : sx + 9} y={T + 9} fontSize="10" fontWeight="700" fill="var(--rw-ink)" textAnchor={left ? 'end' : 'start'}>{label}</text></g>
        })()}
        {axis.map((i, k) => <text key={k} x={X(i)} y={B + 14} fontSize="8.5" fill="var(--rw-muted)" fontWeight="600"
          textAnchor={k === 0 ? 'start' : k === axis.length - 1 ? 'end' : 'middle'}>{d(payDates[i])}</text>)}
      </svg>
      <div className="rw-legend">
        <span><i className="ln" style={{ borderTopColor: 'var(--rw-ink)', opacity: .35 }} />without it</span>
        <span><KeyDone />fully paid</span>
        <span><i className="fl" />floor</span>
      </div>
    </div>
  )
}

/* ── a BNPL plan that's running: Change, Pay off early, Missed one, Stop ── */
type PlanView = { row: any; item: any | null; all: (Pay & { missed: boolean })[]; paid: Pay[]; ahead: Pay[] }

function RunningSheet({ plan, m, floorCents, sym, money, moneyC, accountId, userId, onClose, onSaved }: {
  plan: PlanView; m: Model; floorCents: number; sym: string; money: (c: number) => string; moneyC: (c: number) => string
  accountId: string; userId: string; onClose: () => void; onSaved: () => void
}) {
  const toast = useToast()
  const t = m.t, row = plan.row, name = plan.item?.name ?? row.name
  const { paid, ahead } = plan
  const owe = ahead.reduce((s, p) => s + p.cents, 0)
  const pf = freqOf(row, t)
  const [mode, setMode] = useState<'change' | 'off' | 'miss'>('change')
  const [busy, setBusy] = useState(false)
  const nextPays = m.cycles.slice(1).map(c => c.startDate).filter(d => d > t)

  /* Change */
  const [leftAmt, setLeftAmt] = useState(String(owe / 100))
  const [nl, setNl] = useState(Math.max(1, ahead.length))
  const [fq, setFq] = useState<Freq>(pf)
  const [next, setNext] = useState(ahead[0]?.date ?? nextPays[0] ?? t)
  /* Pay off early */
  const back = m.dated(ahead)
  const offOk = (d: string) => m.fits(m.after(m.dated([{ date: d, cents: owe }]), back))
  const earlyOff = useMemo(() => { for (let i = 0; i <= 180; i++) { const d = shift(t, i); if (offOk(d)) return d } return null }, [m])
  const [offDay, setOffDay] = useState(earlyOff ?? t)
  /* Missed one */
  const [missed, setMissed] = useState<Pay | null>(null)
  const [missHow, setMissHow] = useState<'date' | 'end'>('date')
  const [missDay, setMissDay] = useState(nextPays[0] ?? t)
  const [fee, setFee] = useState('')
  const feeC = Math.max(0, Math.round((parseFloat(fee) || 0) * 100))
  const lastAhead = ahead[ahead.length - 1]?.date ?? t
  const endDay = pf === 'monthly' ? formatDate(addMonths(parseDate(lastAhead), 1)) : shift(lastAhead, pf === 'weekly' ? 7 : 14)

  let list: Pay[] = ahead, v = m.now, btn = 'No changes', can = false
  if (mode === 'change') {
    const c = Math.max(0, Math.round((parseFloat(leftAmt) || 0) * 100))
    list = c > 0 ? split(c, nl, next, fq) : []
    v = m.after(m.dated(list), back)
    can = list.length > 0 && !(list.length === ahead.length && list.every((p, i) => p.date === ahead[i].date && p.cents === ahead[i].cents))
    btn = can ? 'Save changes' : 'No changes'
  } else if (mode === 'off') {
    list = [{ date: offDay, cents: owe }]
    v = m.after(m.dated(list), back)
    can = owe > 0; btn = `Pay ${moneyC(owe)} ${offDay === t ? 'today' : 'on ' + short(offDay)}`
  } else if (missed) {
    const repay = missHow === 'end' ? endDay : missDay
    // The missed payment comes back into the cycle it was due in (if that one is
    // still open), and the repayment goes out on its date.
    v = m.after(m.dated([{ date: repay, cents: missed.cents + feeC }]), missed.date >= m.cycles[0].startDate ? m.dated([missed]) : [])
    list = [...ahead, { date: repay, cents: missed.cents + feeC }].sort((a, b) => a.date.localeCompare(b.date))
    can = true; btn = `Pay ${moneyC(missed.cents + feeC)} ${missHow === 'end' ? 'after ' + short(lastAhead) : 'on ' + short(repay)}`
  } else btn = paid.length ? 'Pick the missed payment' : 'Nothing to fix'
  const st = previewStats(m.now, v, floorCents)
  const lastNew = list.length ? list[list.length - 1].date : t
  const days = Math.round((parseDate(lastAhead).getTime() - parseDate(lastNew).getTime()) / 864e5)

  const planRef = { expenseId: row.id, layById: row.lay_by_id ?? null }
  async function putBack() {
    const from = [list[0]?.date, ahead[0]?.date].filter(Boolean).sort()[0] as string
    await clearBnplFrom(row.id, from)
    await replaceBnplPayments(accountId, planRef, { frequency: pf, payments: ahead.map(p => ({ date: p.date, amountCents: p.cents })) })
    notifyDataChanged()
  }

  async function save() {
    if (!can || busy) return
    setBusy(true)
    try {
      if (mode === 'change') {
        await replaceBnplPayments(accountId, planRef, { frequency: fq, payments: list.map(p => ({ date: p.date, amountCents: p.cents })) })
        toast(`${name}: ${nl} × ${moneyC(list[0].cents)} from ${short(list[0].date)}`, { undo: putBack })
      } else if (mode === 'off') {
        await replaceBnplPayments(accountId, planRef, { frequency: 'once', payments: [{ date: offDay, amountCents: owe }] })
        toast(`${name}: paying off ${moneyC(owe)} ${offDay === t ? 'today' : 'on ' + short(offDay)}`, { undo: putBack })
      } else if (missed) {
        const repay = missHow === 'end' ? endDay : missDay
        const r = await markBnplPaymentMissed(accountId, userId, { ...planRef, name, paymentDate: missed.date, amountCents: missed.cents, feeCents: feeC, repayDate: repay })
        toast(`${short(missed.date)} payment marked missed · ${moneyC(missed.cents + feeC)} on ${short(repay)}`,
          { undo: async () => { await undoBnplMissed(r.id); notifyDataChanged() } })
      }
      onSaved()
    } catch (e: any) { reportError('That change wasn’t saved.', e) }
    finally { setBusy(false) }
  }

  // Stop: with payments made, the plan ends after its last one (today's stays,
  // as Stop now does for expenses); with none, it's switched off. A wishlist
  // item goes back under Wanted.
  async function stop() {
    if (busy) return
    setBusy(true)
    const item = plan.item, oldEnd = row.end_date ?? null
    try {
      if (paid.length) await setExpenseEndDate(row.id, ahead[0]?.date === t ? t : shift(t, -1))
      else await deactivateBnplPlan(row.id, row.lay_by_id ?? null)
      if (item) await releaseWishlistItem(item.id)
      toast(item ? `${name}: plan stopped. It’s back under Wanted.` : `${name}: plan stopped.`, { lasting: true, undo: async () => {
        if (paid.length) await setExpenseEndDate(row.id, oldEnd)
        else { await reactivateExpense(row.id); if (row.lay_by_id) await reactivateLayBy(row.lay_by_id) }
        if (item) await relinkWishlistItem(item.id, { method: 'layby', expenseId: row.id, start: item.committed_cycle_start ?? ahead[0]?.date ?? t })
        notifyDataChanged()
      } })
      onSaved()
    } catch (e: any) { reportError('That plan wasn’t stopped.', e) }
    finally { setBusy(false) }
  }

  const fqOptions = [{ value: 'weekly' as Freq, label: 'Weekly' }, { value: 'fortnightly' as Freq, label: 'Fortnightly' },
    ...(pf === 'monthly' ? [{ value: 'monthly' as Freq, label: 'Monthly' }] : [])]

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <SheetHead mark={<Mark kind="bnpl" />} title={name} sub={`BNPL · ${paid.length} of ${paid.length + ahead.length} paid · ${moneyC(owe)} left`} onClose={onClose} />
      <Segmented value={mode} onChange={setMode} options={[{ value: 'change', label: 'Change' }, { value: 'off', label: 'Pay off early' }, { value: 'miss', label: 'Missed one' }]} />

      <div className="rw-card" style={{ marginTop: 8 }}>
        {mode === 'change' && <>
          <div className="rw-pv-k"><span>Left to pay</span></div>
          <div className="rw-amt"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="Left to pay" value={leftAmt} onChange={e => setLeftAmt(e.target.value)} /></div>
          <div className="rw-amt-row rw-between" style={{ marginTop: 8 }}>
            <span className="rw-row-name">Payments</span>
            <Stepper value={nl} onChange={setNl} min={1} max={12} label="Payments" />
          </div>
          <div style={{ marginTop: 10 }}><Segmented small value={fq} onChange={setFq} options={fqOptions} /></div>
          {list.length > 0 && <div className="rw-gain flat"><b>{nl} × {moneyC(list[0].cents)}</b><span>{fq} · from {short(list[0].date)}</span></div>}
          <div className="rw-lab">Next payment</div>
          <DateChips value={next} onChange={setNext} today={t} payDates={nextPays} label="Next payment" />
        </>}
        {mode === 'off' && <>
          <div className="rw-gain flat" style={{ marginTop: 0 }}><b>{moneyC(owe)}</b><span>in one go instead of {ahead.length} payment{ahead.length > 1 ? 's' : ''}</span></div>
          <div className="rw-lab">Pay it all on</div>
          <DateChips value={offDay} onChange={setOffDay} today={t} label="Pay it all on"
            payDates={(earlyOff && earlyOff > t && !nextPays.slice(0, 3).includes(earlyOff) ? [...nextPays.slice(0, 2), earlyOff] : nextPays.slice(0, 3)).sort()}
            keep={earlyOff} tagFor={d => d === earlyOff ? 'earliest' : offOk(d) ? 'fits' : 'too soon'} />
        </>}
        {mode === 'miss' && (paid.length === 0
          ? <div className="rw-hint" style={{ marginTop: 0 }}>No payments have come due yet. Once one has, mark it here if it didn’t go out.</div>
          : <>
            <div className="rw-lab" style={{ marginTop: 0 }}>Which one didn’t go out?</div>
            <div className="rw-chips">{paid.map(p => <button key={p.date} type="button" className={missed?.date === p.date ? 'on' : ''} onClick={() => setMissed(p)}>{short(p.date)} · {moneyC(p.cents)}</button>)}</div>
            {missed && <>
              <div style={{ marginTop: 12 }}><Segmented small value={missHow} onChange={setMissHow} options={[{ value: 'date', label: 'I’ll pay it on a date' }, { value: 'end', label: 'Added to the end' }]} /></div>
              {missHow === 'date' && <><div className="rw-lab">Pay it on</div><DateChips value={missDay} onChange={setMissDay} today={t} payDates={nextPays} label="Pay it on" /></>}
              <div className="rw-fld flush">
                <div className="l">Late fee, if any<small>Only what the provider charged you</small></div>
                <div className="rw-fld-in">{sym}<input type="number" inputMode="decimal" placeholder="0" aria-label="Late fee" value={fee} onChange={e => setFee(e.target.value)} /></div>
              </div>
            </>}
          </>)}
      </div>

      <Preview nowCents={m.now} newCents={v} payDates={m.payDates} floorCents={floorCents} money={money}
        third={{ k: 'Paid off', v: list.length ? short(lastNew) : '—', d: days === 0 ? 'as planned' : days > 0 ? `${days} days sooner` : `${-days} days later`, cls: days > 0 ? 'good' : days < 0 ? 'near' : '' }} />

      <div className="rw-group flush" style={{ marginTop: 12 }}>
        <button type="button" className="rw-row" onClick={stop} disabled={busy}>
          <div className="rw-tx"><div className="rw-row-name rw-danger">Stop this plan</div>
            <div className="rw-sub">{paid.length ? `Takes the ${moneyC(owe)} left out of your forecast. Paid ones stay.` : 'Nothing has gone out yet, so it comes out of your forecast.'}</div></div>
        </button>
      </div>

      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={!can || busy} onClick={save}>{busy ? 'Saving…' : <>{btn}{can && st.level === 'under' && st.worse ? ' anyway' : ''}</>}</button>
      </div>
    </Sheet>
  )
}

/* ── a plan that has finished: the item can come off the list ── */
function DoneSheet({ item, last, money, onClose, onRemove }: { item: any; last?: string; money: (c: number) => string; onClose: () => void; onRemove: () => void }) {
  return (
    <Sheet onClose={onClose}>
      <div className="rw-grab" />
      <SheetHead mark={<Mark kind="bnpl" />} title={item.name} sub={`${money(item.amount_cents)} · ${last ? 'paid off ' + short(last) : 'no plan running'}`} onClose={onClose} />
      <div className="rw-group flush">
        <button type="button" className="rw-row" onClick={onRemove}>
          <div className="rw-tx"><div className="rw-row-name">Remove from Wishlist</div><div className="rw-sub">Nothing changes in your forecast.</div></div>
        </button>
      </div>
      <div className="rw-ctas"><button type="button" className="rw-cta" onClick={onClose}>Done</button></div>
    </Sheet>
  )
}

/* ── + Add on this page: a name and a price ── */
function AddWantSheet({ accountId, userId, sym, onClose, onSaved }: { accountId: string; userId: string; sym: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(''), [amt, setAmt] = useState(''), [busy, setBusy] = useState(false)
  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  async function add() {
    if (!name.trim() || !cents || busy) return
    setBusy(true)
    try {
      const row = await addWishlistItem(accountId, userId, name.trim(), cents)
      toast(`${name.trim()} added to your Wishlist`, { undo: async () => { await deleteWishlistItem(row.id); notifyDataChanged() } })
      onSaved()
    } catch (e: any) { reportError('That wasn’t added.', e) }
    finally { setBusy(false) }
  }
  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><h2 className="rw-sheet-title">Add to Wishlist</h2><button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Standing desk" autoFocus />
      <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" placeholder="0" aria-label="Price" value={amt} onChange={e => setAmt(e.target.value)} /></div>
      <div className="rw-hint">Nothing reaches your forecast until you pick how to pay.</div>
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={!name.trim() || !cents || busy} onClick={add}>{busy ? 'Saving…' : `Add ${name.trim() || 'item'}`}</button>
      </div>
    </Sheet>
  )
}
