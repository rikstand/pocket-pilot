import { useEffect, useState } from 'react'
import Sheet, { reportError } from './Sheet'
import type { Page } from '../AppShell'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import {
  loadForecast, projectFromRows, budgetsInCycle, cycleRuleOn,
  toEngineExpenses, toEngineIncome, type ForecastResult,
} from '../lib/forecast'
import {
  setExpenseAmountFrom, deleteExpenseAmountVersion, setIncomeAmountFrom, deleteIncomeAmountVersion,
  setExpenseOverride, clearExpenseOverride, setIncomeOverride, clearIncomeOverride,
  setExpenseEndDate, setIncomeEndDate, deactivateExpense, deactivateIncomeSource,
  reactivateExpense, reactivateIncomeSource, archiveExpense, unarchiveExpense,
  setExpenseScheduleFrom, setIncomeScheduleFrom, deleteExpenseScheduleVersion, deleteIncomeScheduleVersion,
} from '../lib/repository'
import { ScheduleFields, ruleOf, DateChips, Segmented, type Schedule, type How, type Unit } from './controls'
import { versionForDate, byOldest } from '../lib/versions'
import { occurrencesOf, scheduleOn } from '../engine/index'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged, useDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { useLog } from './logContext'
import Preview, { previewStats } from './Preview'

/**
 * Journey 9, part one: Expenses & income. Everything that repeats, with what
 * it comes to each pay, and a sheet to change an amount, stop it or delete
 * it. Adding and "Change how often" come next (feat/refresh-add), and
 * changing how often you're paid after that (feat/refresh-pay).
 */

const PREVIEW_PAYS = 12
const todayStr = () => formatDate(new Date())
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const far = () => shift(todayStr(), 2 * 366)
const dayName = (d: string) => {
  const x = parseDate(d), soon = (x.getTime() - Date.now()) / 864e5 < 330
  return x.toLocaleDateString('en-NZ', soon ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '')
}
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const ord = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }

// How many times a year something on this schedule happens.
const PER_YEAR: Record<string, number> = { daily: 365.25, weekly: 52.18, fortnightly: 26.09, monthly: 12, annually: 1, once: 0 }
const perYear = (r: any) => (PER_YEAR[r.frequency] ?? 0) / Math.max(1, r.every_n ?? 1)
const PERIOD: Record<string, string> = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month', annually: 'year' }
// The schedule in force on a date, in the row's own field names. A "Change
// how often" from a date is a dated row, so the item's own fields keep the
// schedule it started with (code review, 18 Nov 2026).
const schedNow = (r: any, isIncome: boolean, on: string) => {
  const s = scheduleOn((isIncome ? toEngineIncome([r]) : toEngineExpenses([r]))[0] as any, on)
  return { frequency: s.frequency, every_n: s.everyN ?? 1, anchor_date: s.anchorDate }
}

type Kind = 'income' | 'fixed' | 'estimate' | 'budget' | 'bnpl'
const kindOf = (r: any, isIncome: boolean): Kind =>
  isIncome ? 'income' : r.lay_by_id ? 'bnpl' : r.mode === 'budget' ? 'budget' : r.mode === 'variable' ? 'estimate' : 'fixed'
const KIND_NAME: Record<Kind, string> = { income: 'Income', fixed: 'Fixed', estimate: 'Estimate', budget: 'Budget', bnpl: 'BNPL' }

export function Mark({ kind }: { kind: Kind }) {
  const box = { className: 'rw-mark', viewBox: '0 0 10 10', 'aria-hidden': true }
  switch (kind) {
    case 'fixed':    return <svg {...box}><circle cx="5" cy="5" r="4" fill="var(--rw-muted)" /></svg>
    case 'estimate': return <svg {...box}><circle cx="5" cy="5" r="3.6" fill="none" stroke="var(--rw-muted)" strokeWidth="1.4" strokeDasharray="2 1.6" /></svg>
    case 'budget':   return <svg {...box}><rect x="0.5" y="3" width="9" height="4" rx="2" fill="none" stroke="var(--rw-muted)" strokeWidth="1.3" /><rect x="0.5" y="3" width="5" height="4" rx="2" fill="var(--rw-muted)" /></svg>
    case 'income':   return <svg {...box}><path d="M5 9V1M1.5 4.5L5 1l3.5 3.5" fill="none" stroke="var(--rw-good)" strokeWidth="1.6" /></svg>
    case 'bnpl':     return <svg {...box}><circle cx="5" cy="5" r="3.8" fill="none" stroke="var(--rw-bnpl)" strokeWidth="1.4" /><path d="M5 1.2A3.8 3.8 0 0 1 5 8.8Z" fill="var(--rw-bnpl)" /></svg>
  }
}

export interface Item {
  id: string
  row: any
  isIncome: boolean
  kind: Kind
  name: string
  amountCents: number       // per payment now (a budget: per pay)
  perPayCents: number
  next: string[]            // the next payments, from today
}

/** One item for the sheet, built the same way the page builds them. Not for budgets. */
export function itemFor(rows: ForecastResult, r: any, isIncome: boolean): Item {
  const t = todayStr()
  const rule = cycleRuleOn(rows.incomeRows, t)
  const paysPerYear = (PER_YEAR[rule.frequency] ?? 26.09) / Math.max(1, rule.everyN ?? 1)
  const kind = kindOf(r, isIncome)
  const eng = isIncome ? toEngineIncome([r])[0] : toEngineExpenses([r])[0]
  const amount = versionForDate(isIncome ? r.income_amount_versions : r.expense_amount_versions, t)?.amount_cents ?? r.amount_cents ?? 0
  return {
    id: r.id, row: r, isIncome, kind, name: r.name, amountCents: amount,
    perPayCents: Math.round(amount * perYear(schedNow(r, isIncome, t)) / paysPerYear),
    next: occurrencesOf(eng, t, far()).slice(0, 12),
  }
}

export default function ItemsPage({ accountId, onNavigate }: { accountId: string; onNavigate: (p: Page) => void }) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const logSheets = useLog()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const [rows, setRows] = useState<ForecastResult | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Item | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  async function load() {
    try { setRows(await loadForecast(accountId, floorCents, { numCycles: PREVIEW_PAYS + 1 })); setError('') }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [accountId, floorCents])
  useDataChanged(load)

  if (error) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">{error}</div></div></div>
  if (!rows) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">Loading…</div></div></div>

  const t = todayStr()
  const cycle = rows.cycles[0]
  const rule = cycleRuleOn(rows.incomeRows, t)
  const paysPerYear = (PER_YEAR[rule.frequency] ?? 26.09) / Math.max(1, rule.everyN ?? 1)
  // "Each fortnightly pay": from how you're paid, never assumed.
  const payWord = (rule.everyN ?? 1) === 1 && ['daily', 'weekly', 'fortnightly', 'monthly'].includes(rule.frequency) ? rule.frequency + ' ' : ''
  const budgets = cycle ? budgetsInCycle(rows, cycle.startDate, cycle.endDate) : []

  const ended = (r: any) => r.end_date && r.end_date < t
  const toItem = (r: any, isIncome: boolean): Item => {
    const kind = kindOf(r, isIncome)
    const eng = isIncome ? toEngineIncome([r])[0] : toEngineExpenses([r])[0]
    const versions = isIncome ? r.income_amount_versions : r.expense_amount_versions
    const amount = kind === 'budget'
      ? (budgets.find(b => b.id === r.id)?.baseCents ?? 0)
      : versionForDate(versions, t)?.amount_cents ?? r.amount_cents ?? 0
    return {
      id: r.id, row: r, isIncome, kind, name: r.name,
      amountCents: amount,
      perPayCents: kind === 'budget' ? amount : Math.round(amount * perYear(schedNow(r, isIncome, t)) / paysPerYear),
      next: kind === 'budget' ? [] : occurrencesOf(eng, t, far()).slice(0, 12),
    }
  }

  const income = rows.incomeRows.filter((r: any) => r.frequency !== 'once' && !r.is_potential && !ended(r)).map(r => toItem(r, true))
  const live = rows.expenseRows.filter((r: any) => r.frequency !== 'once' && !r.archived_at && !ended(r))
  const items = live.map(r => toItem(r, false))
  const fixed = items.filter(i => i.kind === 'fixed')
  const estimates = items.filter(i => i.kind === 'estimate')
  const budgetItems = items.filter(i => i.kind === 'budget')
  const bnpl = items.filter(i => i.kind === 'bnpl' && i.next.length > 0)
  const archived = rows.expenseRows.filter((r: any) => r.archived_at)

  const sum = (l: Item[]) => l.reduce((s, i) => s + i.perPayCents, 0)
  const pay = sum(income)
  const tot = { fixed: sum(fixed), est: sum(estimates), bud: sum(budgetItems) }
  const out = tot.fixed + tot.est + tot.bud
  const left = pay - out
  const scale = Math.max(pay, out, 1)

  function schedText(i: Item) {
    const r = { ...i.row, ...schedNow(i.row, i.isIncome, t) }
    if (i.kind === 'budget') return `${money(i.amountCents)} a pay`
    const n = Math.max(1, r.every_n ?? 1)
    const first = parseDate(r.anchor_date)
    const wd = first.toLocaleDateString('en-NZ', { weekday: 'short' })
    let s: string
    if (r.frequency === 'weekly' && n === 1) s = `Weekly · ${wd}`
    else if (r.frequency === 'fortnightly' && n === 1) s = `Fortnightly · ${wd}`
    else if (r.frequency === 'monthly' && n === 1) s = `Monthly · ${ord(first.getDate())}`
    else if (r.frequency === 'monthly' && n === 3) s = 'Quarterly'
    else if (r.frequency === 'annually' && n === 1) s = 'Yearly'
    else s = `Every ${n} ${PERIOD[r.frequency] ?? r.frequency}s`
    const tail = !(['weekly', 'fortnightly'].includes(r.frequency) && n === 1) && !(r.frequency === 'monthly' && n === 1)
    if (tail && i.next[0]) s += ` · next ${short(i.next[0])}`
    if (r.end_date) s += ` · last ${short(r.end_date)}`
    if (i.isIncome && r.is_primary) s += ' · main income'
    return s
  }

  function row(i: Item) {
    const differs = i.kind !== 'budget' && Math.abs(i.perPayCents - i.amountCents) >= 100
    const openIt = i.kind === 'budget' ? () => logSheets?.budget(i.id)
      : i.kind === 'bnpl' ? () => onNavigate('wishlist')
      : () => setOpen(i)
    let sub = schedText(i)
    if (i.kind === 'bnpl') {
      const vs = [...(i.row.expense_amount_versions ?? [])].sort(byOldest)
      const done = vs.filter((v: any) => v.effective_from < t).length
      sub = `${Math.min(done + 1, vs.length)} of ${vs.length} · last payment ${short(vs[vs.length - 1]?.effective_from ?? t)}`
    }
    return (
      <button key={i.id} type="button" className="rw-row" onClick={openIt}>
        <Mark kind={i.kind} />
        <div className="rw-tx"><div className="rw-row-name">{i.name}</div><div className="rw-sub">{sub}</div></div>
        <div className={`rw-am${i.isIncome ? ' in' : ''}`}>
          {i.isIncome ? '+' : ''}{i.kind === 'estimate' ? '~' : ''}{money(i.kind === 'bnpl' ? (i.next[0] ? amountOn(i.row, i.next[0]) : i.amountCents) : i.amountCents)}
          {i.kind === 'budget' ? null : differs ? <small>≈ {money(i.perPayCents)} a pay</small> : null}
        </div>
        {i.kind === 'bnpl' && <span className="rw-chev">›</span>}
      </button>
    )
  }

  const section = (label: string, list: Item[], isIn = false) => list.length === 0 ? null : (
    <>
      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">{label} · {list.length}</span><span>{isIn ? '+' : ''}{money(sum(list))} a pay</span></div>
      <div className="rw-group">{[...list].sort((a, b) => a.name.localeCompare(b.name)).map(row)}</div>
    </>
  )

  async function restore(r: any) {
    const prevEnd = r.end_date
    try {
      await unarchiveExpense(r.id)
      toast(`${r.name} restored`, { undo: async () => { await archiveExpense(r.id, prevEnd ?? t); notifyDataChanged() } })
      notifyDataChanged()
    } catch (e: any) { reportError('That wasn’t restored.', e) }
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head rw-head-row">
        <h1 className="rw-page-title">Expenses &amp; income</h1>
        {logSheets && <button type="button" className="rw-addb" onClick={() => logSheets.add()}>+ Add</button>}
      </div>
      <div className="rw-page-head" style={{ paddingTop: 0 }}>
        <div className="rw-sub">Everything that repeats. One-offs live in their cycle.</div>
      </div>

      <div className="rw-sum">
        <div className="rw-sum-k"><span>Each {payWord}pay, on average</span><b>{money(pay)}</b></div>
        <div className="rw-sbar" aria-hidden="true">
          <i className="fix" style={{ width: tot.fixed / scale * 100 + '%' }} />
          <i className="est" style={{ width: tot.est / scale * 100 + '%' }} />
          <i className="bud" style={{ width: tot.bud / scale * 100 + '%' }} />
          {left > 0 && <i className="lf" style={{ width: left / scale * 100 + '%' }} />}
          <b style={{ left: pay / scale * 100 + '%' }} />
        </div>
        <div className="rw-kg">
          <span><em className="fix" />Fixed<b>{money(tot.fixed)}</b></span>
          <span><em className="est" />Estimates<b>{money(tot.est)}</b></span>
          <span><em className="bud" />Budgets<b>{money(tot.bud)}</b></span>
          <span><em className="lf" />{left >= 0 ? 'Not planned' : 'Over'}<b>{money(Math.abs(left))}</b></span>
        </div>
      </div>

      {section('Income', income, true)}
      {section('Fixed', fixed)}
      {section('Estimates', estimates)}
      {section('Budgets', budgetItems)}

      {archived.length > 0 && (
        <div className="rw-group" style={{ marginTop: 6 }}>
          <button type="button" className="rw-row" onClick={() => setShowArchived(s => !s)}>
            <div className="rw-tx"><div className="rw-sub">{archived.length} archived budget{archived.length > 1 ? 's' : ''}</div></div>
            <span className={`rw-chev${showArchived ? ' open' : ''}`}>›</span>
          </button>
          {showArchived && archived.map((r: any) => (
            <div key={r.id} className="rw-row done static">
              <Mark kind="budget" />
              <div className="rw-tx"><div className="rw-row-name">{r.name}</div><div className="rw-sub">History kept</div></div>
              <button type="button" className="rw-mini sec" onClick={() => restore(r)}>Restore</button>
            </div>
          ))}
        </div>
      )}

      {bnpl.length > 0 && (
        <>
          <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">BNPL · {bnpl.length}</span><span>managed in Plan</span></div>
          <div className="rw-group">{bnpl.map(row)}</div>
        </>
      )}

      {open && (
        <ItemSheet item={open} rows={rows} floorCents={floorCents} accountId={accountId}
          onClose={() => setOpen(null)} onSaved={() => { setOpen(null); notifyDataChanged() }} />
      )}
    </div>
  )
}

function amountOn(row: any, date: string) {
  return versionForDate(row.expense_amount_versions, date)?.amount_cents ?? row.amount_cents ?? 0
}

/* ── the item sheet: change the amount, stop it, or delete it ──────── */
type Mode = 'amount' | 'stop' | 'delete' | 'sched' | 'pay' | 'ahead'

export function ItemSheet({ item, rows, floorCents, accountId, onClose, onSaved, cycleIdx = 0, fromCycle = false }: {
  item: Item; rows: ForecastResult; floorCents: number; accountId: string
  onClose: () => void; onSaved: () => void
  // Which of rows.cycles "Just this cycle" means, and where the preview
  // starts (Journey 6: opened from the Cycle screen or a future cycle).
  cycleIdx?: number
  fromCycle?: boolean          // opened from a cycle: starts on "Just this cycle"
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const t = todayStr()
  const r = item.row
  const cycle = rows.cycles[cycleIdx] ?? rows.cycles[0]
  const isPrimary = item.isIncome && r.is_primary

  const eng = item.isIncome ? toEngineIncome([r])[0] : toEngineExpenses([r])[0]
  const inThisCycle = cycle ? occurrencesOf(eng, cycle.startDate, cycle.endDate) : []
  // What one payment comes to in that cycle now: its own amount if it has one.
  const ownOv = cycle ? (item.isIncome
    ? (rows.incomeOverrideRows ?? []).find((o: any) => o.income_source_id === r.id && o.cycle_start === cycle.startDate)
    : (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === cycle.startDate)) : null
  const cycleNow = inThisCycle.length
    ? (ownOv ? Math.round(ownOv.amount_cents / inThisCycle.length) : amountAt(r, item.isIncome, inThisCycle[0]))
    : item.amountCents
  // What "the usual" is once this cycle is over: the next payment after it.
  const afterCycle = cycle ? occurrencesOf(eng, shift(cycle.endDate, 1), far())[0] : undefined
  const thenBack = afterCycle ? ` Then back to ${money(amountAt(r, item.isIncome, afterCycle))}.` : ''
  // "From a date" starts at the cycle you came from, never before today.
  const fromDates = cycle && cycle.startDate > t ? occurrencesOf(eng, cycle.startDate, far()).slice(0, 12) : item.next
  // Nothing has gone out (or come in) yet: deleting it loses nothing.
  const hasPast = r.anchor_date < t

  const [mode, setMode] = useState<Mode>('amount')
  const [scope, setScope] = useState<'one' | 'from'>(fromCycle && inThisCycle.length ? 'one' : 'from')
  const [amt, setAmt] = useState(String((fromCycle && inThisCycle.length ? cycleNow : item.amountCents) / 100))
  const [more, setMore] = useState(false)
  const [from, setFrom] = useState(fromDates[0] ?? t)
  // A payment due today has most likely gone out already: "now" keeps it.
  const dueToday = item.next[0] === t
  const stopChoices = dueToday ? item.next.slice(1, 4) : item.next.slice(0, 3)
  const [stopAt, setStopAt] = useState<string>(dueToday ? 'now' : item.next[0] ?? 'now')
  const stopEnd = stopAt === 'now' ? (dueToday ? t : shift(t, -1)) : stopAt
  // Changes already saved for later: dated amounts, dated schedules, and
  // amounts set for one future cycle. Each can be looked at and removed.
  type Ahead = { key: string; kind: 'amount' | 'sched' | 'cycle'; date: string; v: any; title: string; words: string }
  const [pick, setPick] = useState<Ahead | null>(null)
  const [busy, setBusy] = useState(false)
  const [sched, setSched] = useState<Schedule>(() => scheduleFromRow({ ...r, ...schedNow(r, item.isIncome, t) }, item.next[0] ?? t))
  const [schedFrom, setSchedFrom] = useState(item.next[0] ?? t)
  const nextPays = rows.cycles.slice(1, 4).map(c => c.startDate)

  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const opts = more ? fromDates.slice(0, 12) : fromDates.slice(0, 3)

  // The forecast as it is, and with this change: the same rows with one edit.
  function withChange(): ForecastResult {
    const vKey = item.isIncome ? 'income_amount_versions' : 'expense_amount_versions'
    const editRow = (fn: (x: any) => any | null) => item.isIncome
      ? { ...rows, incomeRows: rows.incomeRows.map(x => x.id === r.id ? fn(x) : x).filter(Boolean) }
      : { ...rows, expenseRows: rows.expenseRows.map(x => x.id === r.id ? fn(x) : x).filter(Boolean) }
    if (mode === 'delete') return editRow(() => null)
    if (mode === 'sched') {
      const sKey = item.isIncome ? 'income_schedule_versions' : 'expense_schedule_versions'
      const rule = ruleOf(sched)
      return editRow(x => ({ ...x, [sKey]: [...(x[sKey] ?? []),
        { effective_from: schedFrom, frequency: rule.frequency, every_n: rule.everyN, anchor_date: sched.first, created_at: '9999' }] }))
    }
    if (mode === 'stop') return editRow(x => ({ ...x, end_date: stopEnd }))
    if (mode === 'ahead' && pick) {
      if (pick.kind === 'amount') return editRow(x => ({ ...x, [vKey]: (x[vKey] ?? []).filter((v: any) => v.id !== pick.v.id) }))
      if (pick.kind === 'sched') {
        const sKey = item.isIncome ? 'income_schedule_versions' : 'expense_schedule_versions'
        return editRow(x => ({ ...x, [sKey]: (x[sKey] ?? []).filter((v: any) => v.id !== pick.v.id) }))
      }
      return item.isIncome
        ? { ...rows, incomeOverrideRows: (rows.incomeOverrideRows ?? []).filter((o: any) => !(o.income_source_id === r.id && o.cycle_start === pick.date)) }
        : { ...rows, expenseOverrideRows: (rows.expenseOverrideRows ?? []).filter((o: any) => !(o.expense_id === r.id && o.cycle_start === pick.date)) }
    }
    if (scope === 'from') return editRow(x => ({ ...x, [vKey]: [...(x[vKey] ?? []), { effective_from: from, amount_cents: cents, created_at: '9999' }] }))
    const total = cents * inThisCycle.length
    return item.isIncome
      ? { ...rows, incomeOverrideRows: [...(rows.incomeOverrideRows ?? []).filter((o: any) => !(o.income_source_id === r.id && o.cycle_start === cycle.startDate)),
          { income_source_id: r.id, cycle_start: cycle.startDate, amount_cents: total }] }
      : { ...rows, expenseOverrideRows: [...(rows.expenseOverrideRows ?? []).filter((o: any) => !(o.expense_id === r.id && o.cycle_start === cycle.startDate)),
          { expense_id: r.id, cycle_start: cycle.startDate, amount_cents: total }] }
  }

  const changed = mode !== 'amount' || (scope === 'one' ? cents !== cycleNow && inThisCycle.length > 0 : cents !== amountAt(r, item.isIncome, from))
  // The preview starts at the cycle the sheet was opened from.
  const k0 = rows.cycles.indexOf(cycle) >= 0 ? rows.cycles.indexOf(cycle) : 0
  const span = k0 + PREVIEW_PAYS
  const base = k0 + PREVIEW_PAYS <= rows.cycles.length ? rows.cycles : projectFromRows(rows, floorCents, span + 1)
  const now = base.slice(k0, span).map(c => c.committedClosingBalanceCents)
  const after = changed && amt.trim() ? projectFromRows(withChange(), floorCents, span + 1).slice(k0, span).map(c => c.committedClosingBalanceCents) : []
  const payDates = base.slice(k0, span).map(c => shift(c.endDate, 1))
  const st = after.length ? previewStats(now, after, floorCents) : null
  const anyway = st && st.level === 'under' && st.worse ? ' anyway' : ''

  // Where each payment lands, as a position between paydays on the preview.
  const tickDates = mode === 'sched'
    ? occurrencesOf({ ...eng, schedules: [{ effectiveFrom: schedFrom, frequency: ruleOf(sched).frequency, everyN: ruleOf(sched).everyN, anchorDate: sched.first }, ...(eng.schedules ?? [])] } as any, schedFrom, far())
    : mode === 'amount' ? (scope === 'one' ? inThisCycle : fromDates.filter(d => d >= from)) : []
  const ticks = tickDates.length
    ? tickDates.flatMap(d => {
        const i = base.findIndex(c => d >= c.startDate && d <= c.endDate) - k0
        if (i < 0 || i >= PREVIEW_PAYS) return []
        const c = base[i + k0]
        const len = (parseDate(c.endDate).getTime() - parseDate(c.startDate).getTime()) / 864e5 + 1
        const f = ((parseDate(d).getTime() - parseDate(c.startDate).getTime()) / 864e5 + 0.5) / len
        return [i - 1 + f]
      })
    : []

  // Estimates: the real bills confirmed in past cycles.
  const history = item.kind === 'estimate'
    ? (rows.expenseOverrideRows ?? []).filter((o: any) => o.expense_id === r.id && cycle && o.cycle_start < cycle.startDate)
        .sort((a: any, b: any) => a.cycle_start.localeCompare(b.cycle_start)).slice(-6)
    : []

  const vRows: any[] = (item.isIncome ? r.income_amount_versions : r.expense_amount_versions) ?? []
  const firstVersion = [...vRows].sort(byOldest)[0]
  const sRows: any[] = (item.isIncome ? r.income_schedule_versions : r.expense_schedule_versions) ?? []
  const oRows: any[] = item.isIncome
    ? (rows.incomeOverrideRows ?? []).filter((o: any) => o.income_source_id === r.id)
    : (rows.expenseOverrideRows ?? []).filter((o: any) => o.expense_id === r.id)
  const howWords = (v: any) => (v.every_n ?? 1) > 1 ? `Every ${v.every_n} ${PERIOD[v.frequency] ?? v.frequency}s`
    : ({ daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', annually: 'Yearly' } as Record<string, string>)[v.frequency] ?? v.frequency
  const ahead: Ahead[] = [
    ...vRows.filter(v => v.effective_from > t && v !== firstVersion).map(v => ({ key: 'a' + v.id, kind: 'amount' as const, date: v.effective_from, v,
      title: `From ${dayName(v.effective_from)}`, words: `${money(v.amount_cents)} each` })),
    ...sRows.filter(v => v.effective_from > t).map(v => ({ key: 's' + v.id, kind: 'sched' as const, date: v.effective_from, v,
      title: `From ${dayName(v.effective_from)}`, words: howWords(v) })),
    ...oRows.filter(o => o.cycle_start > t).map(o => ({ key: 'o' + o.cycle_start, kind: 'cycle' as const, date: o.cycle_start, v: o,
      title: `The ${short(o.cycle_start)} cycle only`, words: `${money(o.amount_cents)} for that cycle` })),
  ].sort((a, b) => a.date.localeCompare(b.date))

  // A cycle's amount without its one-cycle change: each payment at its own amount.
  function usualFor(start: string) {
    const c = rows.cycles.find(x => x.startDate === start)
    const ds = c ? occurrencesOf(eng, c.startDate, c.endDate) : []
    return ds.reduce((s, d) => s + amountAt(r, item.isIncome, d), 0)
  }

  async function removeAhead() {
    if (!pick || busy) return
    setBusy(true)
    const p = pick
    try {
      if (p.kind === 'amount') {
        if (item.isIncome) await deleteIncomeAmountVersion(p.v.id); else await deleteExpenseAmountVersion(p.v.id)
      } else if (p.kind === 'sched') {
        if (item.isIncome) await deleteIncomeScheduleVersion(p.v.id); else await deleteExpenseScheduleVersion(p.v.id)
      } else if (item.isIncome) await clearIncomeOverride(r.id, p.date); else await clearExpenseOverride(r.id, p.date)
      toast(`${r.name}: change ${p.kind === 'cycle' ? 'for the ' + short(p.date) + ' cycle' : 'from ' + short(p.date)} removed`, {
        undo: async () => {
          if (p.kind === 'amount') {
            if (item.isIncome) await setIncomeAmountFrom(r.id, p.date, p.v.amount_cents); else await setExpenseAmountFrom(r.id, accountId, p.date, p.v.amount_cents)
          } else if (p.kind === 'sched') {
            const back = { effectiveFrom: p.date, frequency: p.v.frequency, everyN: p.v.every_n ?? 1, anchorDate: p.v.anchor_date }
            if (item.isIncome) await setIncomeScheduleFrom(r.id, accountId, back); else await setExpenseScheduleFrom(r.id, accountId, back)
          } else if (item.isIncome) await setIncomeOverride(r.id, accountId, p.date, p.v.amount_cents)
          else await setExpenseOverride(r.id, accountId, p.date, p.v.amount_cents)
          notifyDataChanged()
        },
        lasting: true,
      })
      onSaved()
    } catch (e: any) { reportError('That wasn’t removed.', e) }
    finally { setBusy(false) }
  }

  async function saveAmount() {
    if (!changed || busy) return
    setBusy(true)
    try {
      if (scope === 'from') {
        const vKey = item.isIncome ? 'income_amount_versions' : 'expense_amount_versions'
        const prev = (r[vKey] ?? []).find((v: any) => v.effective_from === from) ?? null
        const written = item.isIncome ? await setIncomeAmountFrom(r.id, from, cents) : await setExpenseAmountFrom(r.id, accountId, from, cents)
        toast(`${r.name}: ${money(cents)} from ${short(from)}`, { undo: async () => {
          if (prev) { if (item.isIncome) await setIncomeAmountFrom(r.id, from, prev.amount_cents); else await setExpenseAmountFrom(r.id, accountId, from, prev.amount_cents) }
          else if (item.isIncome) await deleteIncomeAmountVersion(written.id); else await deleteExpenseAmountVersion(written.id)
          notifyDataChanged()
        } })
      } else {
        const start = cycle.startDate
        const total = cents * inThisCycle.length
        const prevOv = item.isIncome
          ? (rows.incomeOverrideRows ?? []).find((o: any) => o.income_source_id === r.id && o.cycle_start === start)
          : (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === start)
        const usual = inThisCycle.reduce((s, d) => s + amountAt(r, item.isIncome, d), 0)
        if (item.isIncome) { if (total === usual) await clearIncomeOverride(r.id, start); else await setIncomeOverride(r.id, accountId, start, total) }
        else { if (total === usual) await clearExpenseOverride(r.id, start); else await setExpenseOverride(r.id, accountId, start, total) }
        toast(`${r.name}: ${money(cents)} this cycle only`, { undo: async () => {
          if (item.isIncome) { if (prevOv) await setIncomeOverride(r.id, accountId, start, prevOv.amount_cents); else await clearIncomeOverride(r.id, start) }
          else { if (prevOv) await setExpenseOverride(r.id, accountId, start, prevOv.amount_cents); else await clearExpenseOverride(r.id, start) }
          notifyDataChanged()
        } })
      }
      onSaved()
    } catch (e: any) { reportError('That didn’t save.', e) }
    finally { setBusy(false) }
  }

  async function saveSched() {
    setBusy(true)
    const rule = ruleOf(sched)
    const sKey = item.isIncome ? 'income_schedule_versions' : 'expense_schedule_versions'
    const prev = (r[sKey] ?? []).find((v: any) => v.effective_from === schedFrom) ?? null
    const change = { effectiveFrom: schedFrom, frequency: rule.frequency, everyN: rule.everyN, anchorDate: sched.first }
    try {
      const written = item.isIncome ? await setIncomeScheduleFrom(r.id, accountId, change) : await setExpenseScheduleFrom(r.id, accountId, change)
      toast(`${r.name}: new schedule from ${short(schedFrom)}`, { undo: async () => {
        if (prev) {
          const back = { effectiveFrom: schedFrom, frequency: prev.frequency, everyN: prev.every_n ?? 1, anchorDate: prev.anchor_date }
          if (item.isIncome) await setIncomeScheduleFrom(r.id, accountId, back); else await setExpenseScheduleFrom(r.id, accountId, back)
        } else if (item.isIncome) await deleteIncomeScheduleVersion(written.id); else await deleteExpenseScheduleVersion(written.id)
        notifyDataChanged()
      } })
      onSaved()
    } catch (e: any) { reportError('That didn’t change.', e) }
    finally { setBusy(false) }
  }

  async function saveStop() {
    setBusy(true)
    const prevEnd = r.end_date ?? null
    const end = stopEnd
    try {
      if (item.isIncome) await setIncomeEndDate(r.id, end); else await setExpenseEndDate(r.id, end)
      toast(stopAt === 'now' ? `${r.name} stopped` : `${r.name} stops after ${short(end)}`, { undo: async () => {
        if (item.isIncome) await setIncomeEndDate(r.id, prevEnd); else await setExpenseEndDate(r.id, prevEnd)
        notifyDataChanged()
      }, lasting: true })
      onSaved()
    } catch (e: any) { reportError('That wasn’t stopped.', e) }
    finally { setBusy(false) }
  }

  async function saveDelete() {
    setBusy(true)
    try {
      if (item.isIncome) await deactivateIncomeSource(r.id); else await deactivateExpense(r.id)
      toast(`${r.name} deleted`, { undo: async () => {
        if (item.isIncome) await reactivateIncomeSource(r.id); else await reactivateExpense(r.id)
        notifyDataChanged()
      }, lasting: true })
      onSaved()
    } catch (e: any) { reportError('That wasn’t deleted.', e) }
    finally { setBusy(false) }
  }

  const preview = after.length > 0 && (
    <>
      <Preview nowCents={now} newCents={after} payDates={payDates} floorCents={floorCents} money={money} ticks={ticks} />
    </>
  )

  return (
    <Sheet onClose={onClose} busy={busy}>
        <div className="rw-grab" />
        <div className="rw-sh-h">
          <div className="rw-sh-t">
            <Mark kind={item.kind} />
            <div>
              <h2 className="rw-sheet-title">{r.name}</h2>
              <div className="rw-sd">{KIND_NAME[item.kind]}{isPrimary ? ' · main income' : ''}</div>
            </div>
          </div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {mode === 'amount' && <>
          <div className="rw-card">
            <div className="rw-lab" style={{ marginTop: 0 }}>{scope === 'one' ? `${short(cycle.startDate)} – ${short(cycle.endDate)} cycle` : item.kind === 'estimate' ? 'Usual estimate' : 'Amount'}</div>
            <div className="rw-amt-row"><div className="rw-amt"><span>{sym}</span>
              <input type="number" inputMode="decimal" aria-label="Amount" value={amt} onChange={e => setAmt(e.target.value)} />
            </div></div>
            <div className="rw-seg flush">
              <button type="button" className={scope === 'one' ? 'on' : ''} disabled={inThisCycle.length === 0}
                onClick={() => setScope('one')}>Just this cycle</button>
              <button type="button" className={scope === 'from' ? 'on' : ''} onClick={() => setScope('from')}>From a date</button>
            </div>
            {scope === 'from' ? (
              <div className="rw-chips" style={{ marginTop: 8 }}>
                {opts.map(d => <button key={d} type="button" className={from === d ? 'on' : ''} onClick={() => setFrom(d)}>{dayName(d)}</button>)}
                {!more && fromDates.length > 3 && <button type="button" className="dash" onClick={() => setMore(true)}>More dates</button>}
              </div>
            ) : (
              <div className="rw-hint">
                {inThisCycle.length === 1 ? `Only the ${short(inThisCycle[0])} payment.${thenBack}`
                  : `Each of this cycle's ${inThisCycle.length} payments.${thenBack}`}
              </div>
            )}
            {inThisCycle.length === 0 && <div className="rw-hint">Nothing due this cycle, so a change starts from a date.</div>}
          </div>

          {preview}

          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={onClose}>Close</button>
            <button type="button" className="rw-cta" disabled={changed && (busy || !amt.trim())} onClick={changed ? saveAmount : onClose}>
              {!changed ? 'Done' : `Use ${money(cents)} ${scope === 'one' ? 'this cycle' : 'from ' + short(from)}${anyway}`}
            </button>
          </div>

          {history.length > 0 && (
            <div className="rw-card">
              <div className="rw-pv-k"><span>Confirmed amounts, last {history.length}</span>
                <span>avg {money(history.reduce((s: number, o: any) => s + o.amount_cents, 0) / history.length)}</span></div>
              <HistoryBars values={history.map((o: any) => o.amount_cents)} line={item.amountCents} lineLabel={`estimate ${money(item.amountCents)}`} money={money} />
            </div>
          )}

          {ahead.length > 0 && <>
            <div role="heading" aria-level={2} className="rw-lab">Changes ahead</div>
            <div className="rw-group flush">
              {ahead.map(a => (
                <button key={a.key} type="button" className="rw-row" onClick={() => { setPick(a); setMode('ahead') }}>
                  <div className="rw-tx"><div className="rw-row-name">{a.title}</div><div className="rw-sub">{a.words}</div></div>
                  <span className="rw-chev">›</span>
                </button>
              ))}
            </div>
          </>}
          {isPrimary && (
            <div className="rw-group flush" style={{ marginTop: 12 }}>
              <button type="button" className="rw-row" onClick={() => setMode('pay')}>
                <div className="rw-tx">
                  <div className="rw-row-name">Change how often or payday</div>
                  <div className="rw-sub">Changes the length of your cycles</div>
                </div>
                <span className="rw-chev">›</span>
              </button>
            </div>
          )}

          {!isPrimary && (
            <div className="rw-group flush" style={{ marginTop: 12 }}>
              <button type="button" className="rw-row" onClick={() => setMode('sched')}>
                <div className="rw-tx">
                  <div className="rw-row-name">Change how often</div>
                  <div className="rw-sub">From a date. Earlier payments stay as they were</div>
                </div>
                <span className="rw-chev">›</span>
              </button>
              <button type="button" className="rw-row" onClick={() => setMode(hasPast ? 'stop' : 'delete')}>
                <div className="rw-tx">
                  <div className="rw-row-name rw-danger">{hasPast ? `Stop ${r.name}` : `Delete ${r.name}`}</div>
                  <div className="rw-sub">{hasPast ? 'Pick the last payment. History stays' : 'Nothing has gone out yet, so nothing is lost'}</div>
                </div>
                <span className="rw-chev">›</span>
              </button>
            </div>
          )}
        </>}

        {mode === 'sched' && <>
          <div className="rw-note">Payments before the date you pick keep their old schedule, so your history stays as it was.</div>
          <div className="rw-lab">Change from</div>
          <div className="rw-chips">
            {item.next.slice(0, 3).map(d => (
              <button key={d} type="button" className={schedFrom === d ? 'on' : ''}
                onClick={() => { setSchedFrom(d); if (sched.first < d) setSched({ ...sched, first: d }) }}>{dayName(d)}</button>
            ))}
          </div>
          <ScheduleFields value={sched} onChange={setSched} today={t} payDates={nextPays} min={schedFrom}
            firstLabel="First payment on the new schedule" repeatOnly />
          {preview}
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={() => setMode('amount')}>Back</button>
            <button type="button" className="rw-cta" disabled={busy} onClick={saveSched}>Change from {short(schedFrom)}{anyway}</button>
          </div>
        </>}

        {mode === 'pay' && <PayChange row={r} rows={rows} floorCents={floorCents} accountId={accountId}
          onBack={() => setMode('amount')} onSaved={onSaved} />}

        {mode === 'ahead' && pick && <>
          <div className="rw-card"><div className="rw-row-name">{pick.title}</div><div className="rw-sub">{pick.words}</div></div>
          <div className="rw-note">{pick.kind === 'cycle'
            ? `Removing it puts the ${short(pick.date)} cycle back to ${money(usualFor(pick.date))}.`
            : `Removing it keeps ${r.name} as it is before ${short(pick.date)}, after that date too.`}</div>
          {preview}
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={() => { setPick(null); setMode('amount') }}>Back</button>
            <button type="button" className="rw-cta" disabled={busy} onClick={removeAhead}>Remove change{anyway}</button>
          </div>
        </>}
        {mode === 'stop' && <>
          <div className="rw-note">Payments that already went out stay in your history. Nothing before the date you pick changes.</div>
          <div className="rw-lab">Last payment</div>
          <div className="rw-chips">
            <button type="button" className={stopAt === 'now' ? 'on' : ''} onClick={() => setStopAt('now')}>{dueToday ? 'After today’s payment' : 'None. Stop now'}</button>
            {stopChoices.map(d => <button key={d} type="button" className={stopAt === d ? 'on' : ''} onClick={() => setStopAt(d)}>{dayName(d)}</button>)}
          </div>
          {preview}
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={() => setMode('amount')}>Back</button>
            <button type="button" className="rw-cta" disabled={busy} onClick={saveStop}>
              {stopAt === 'now' ? (dueToday ? 'Stop after today' : 'Stop now') : `Stop after ${short(stopAt)}`}{anyway}
            </button>
          </div>
        </>}

        {mode === 'delete' && <>
          <div className="rw-note">Nothing has gone out for {r.name} yet, so deleting it loses nothing.</div>
          {preview}
          <div className="rw-ctas">
            <button type="button" className="rw-cta sec" onClick={() => setMode('amount')}>Back</button>
            <button type="button" className="rw-cta dang" disabled={busy} onClick={saveDelete}>Delete {r.name}</button>
          </div>
        </>}
    </Sheet>
  )
}

function amountAt(r: any, isIncome: boolean, date: string) {
  return versionForDate(isIncome ? r.income_amount_versions : r.expense_amount_versions, date)?.amount_cents ?? r.amount_cents ?? 0
}

export function HistoryBars({ values, line, lineLabel, money }: {
  values: number[]; line: number; lineLabel: string; money: (c: number) => string
}) {
  const mx = Math.max(...values, line, 1) * 1.15
  const bw = 280 / Math.max(6, values.length)
  const ly = 80 - line / mx * 72
  return (
    <svg viewBox="0 0 300 96" role="img" aria-label={lineLabel}>
      {values.map((v, j) => {
        const x = 10 + j * bw + bw * 0.18, w = bw * 0.64, ht = v / mx * 72
        return <g key={j}>
          <rect x={x} y={80 - ht} width={w} height={Math.max(ht, 1)} rx="3" fill={v > line ? 'var(--rw-near-floor)' : 'var(--rw-ink)'} opacity={v > line ? 1 : 0.8} />
          <text x={x + w / 2} y="92" fontSize="9" fill="var(--rw-muted)" textAnchor="middle" fontWeight="650">{money(v)}</text>
        </g>
      })}
      <line x1="6" x2="294" y1={ly} y2={ly} stroke="var(--rw-ink)" strokeDasharray="4 3" strokeOpacity=".6" />
      <text x="294" y={ly - 4} fontSize="9" fill="var(--rw-muted)" textAnchor="end" fontWeight="700">{lineLabel}</text>
    </svg>
  )
}

/** The form's starting point: the item's schedule as it is now. */
function scheduleFromRow(r: any, first: string): Schedule {
  const n = Math.max(1, r.every_n ?? 1)
  const simple: Record<string, How> = { weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', annually: 'annually' }
  const how: How = n === 1 && simple[r.frequency] ? simple[r.frequency] : 'custom'
  const unit: Unit = r.frequency === 'fortnightly' ? 'weekly' : (['daily', 'weekly', 'monthly', 'annually'].includes(r.frequency) ? r.frequency : 'monthly')
  return { how, n: r.frequency === 'fortnightly' ? n * 2 : n, unit, first, ends: 'never', endDate: first, count: 4 }
}

/* ── how often you're paid: changes the length of your cycles ─────────
 * Takes effect from the next payday at the earliest, so the cycle you're in
 * stays as it is. Budgets re-spread on their own: they're a rate. */
type PayFreq = 'weekly' | 'fortnightly' | 'monthly'
const FREQ_NAME: Record<PayFreq, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' }

function PayChange({ row: r, rows, floorCents, accountId, onBack, onSaved }: {
  row: any; rows: ForecastResult; floorCents: number; accountId: string; onBack: () => void; onSaved: () => void
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const cur = rows.cycles[0]
  const P = shift(cur.endDate, 1)                     // the next payday
  const eng = toEngineIncome([r])[0]
  const now = scheduleOn(eng, P)
  const nowFreq = (['weekly', 'fortnightly', 'monthly'].includes(now.frequency) ? now.frequency : 'fortnightly') as PayFreq
  const nowAmount = amountAt(r, true, P)
  const perYear = (f: PayFreq) => PER_YEAR[f]

  const [freq, setFreq] = useState<PayFreq>(nowFreq)
  const [first, setFirst] = useState(P)
  const suggested = (f: PayFreq) => Math.round(nowAmount * perYear(nowFreq) / perYear(f) / 100) * 100
  const [amt, setAmt] = useState(String(nowAmount / 100))
  const [busy, setBusy] = useState(false)
  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))

  function pick(f: PayFreq) { setFreq(f); setAmt(String(suggested(f) / 100)) }

  // Nothing to change: same schedule, a payday it already lands on, same pay.
  const samePayday = freq === nowFreq && occurrencesOf(eng, first, first).length > 0
  const changed = !(samePayday && cents === nowAmount)

  const changedRows: ForecastResult = { ...rows, incomeRows: rows.incomeRows.map(x => x.id !== r.id ? x : {
    ...x,
    income_schedule_versions: [...(x.income_schedule_versions ?? []), { effective_from: first, frequency: freq, every_n: 1, anchor_date: first, created_at: '9999' }],
    income_amount_versions: [...(x.income_amount_versions ?? []), { effective_from: first, amount_cents: cents, created_at: '9999' }],
  }) }
  const proj = projectFromRows(changedRows, floorCents, PREVIEW_PAYS + 1).slice(0, PREVIEW_PAYS + 1)
  const lowIdx = proj.reduce((m, c, i) => c.committedClosingBalanceCents < proj[m].committedClosingBalanceCents ? i : m, 0)
  const low = proj[lowIdx]?.committedClosingBalanceCents ?? 0
  const level = low < 0 ? 'under' : low < floorCents ? 'near' : 'ok'

  const budgets = budgetsInCycle(rows, cur.startDate, cur.endDate)
  const budgetsNow = budgets.reduce((s, b) => s + b.baseCents, 0)
  const budgetsNew = Math.round(budgetsNow * perYear(nowFreq) / perYear(freq))

  // The cycles as they'd run: this one stays, any bridge, then the new length.
  const strip = proj.slice(1, 6).map(c => ({ start: c.startDate, end: c.endDate,
    days: (parseDate(c.endDate).getTime() - parseDate(c.startDate).getTime()) / 864e5 + 1 }))
  const curDays = (parseDate(cur.endDate).getTime() - parseDate(cur.startDate).getTime()) / 864e5 + 1

  async function save() {
    if (!changed || busy) return
    setBusy(true)
    const prevSched = (r.income_schedule_versions ?? []).find((v: any) => v.effective_from === first) ?? null
    const prevAmt = (r.income_amount_versions ?? []).find((v: any) => v.effective_from === first) ?? null
    try {
      const s = await setIncomeScheduleFrom(r.id, accountId, { effectiveFrom: first, frequency: freq, everyN: 1, anchorDate: first })
      const a = cents !== amountAt(r, true, first) ? await setIncomeAmountFrom(r.id, first, cents) : null
      toast(`Paid ${freq} from ${short(first)}`, { undo: async () => {
        if (prevSched) await setIncomeScheduleFrom(r.id, accountId, { effectiveFrom: first, frequency: prevSched.frequency, everyN: prevSched.every_n ?? 1, anchorDate: prevSched.anchor_date })
        else await deleteIncomeScheduleVersion(s.id)
        if (a) { if (prevAmt) await setIncomeAmountFrom(r.id, first, prevAmt.amount_cents); else await deleteIncomeAmountVersion(a.id) }
        notifyDataChanged()
      } })
      onSaved()
    } catch (e: any) { reportError('Your pay didn’t change.', e) }
    finally { setBusy(false) }
  }

  return (
    <>
      <button type="button" className="rw-back" onClick={onBack}>‹ {r.name}</button>
      <div className="rw-sd">Your cycles follow your main pay, so budgets and expenses re-spread on their own.</div>

      <div className="rw-lab">How often you're paid</div>
      <Segmented value={freq} onChange={pick} options={(['weekly', 'fortnightly', 'monthly'] as PayFreq[]).map(f => ({
        value: f, label: FREQ_NAME[f] + (f === nowFreq ? ' · now' : '') }))} />

      <div className="rw-lab">First payday on the new schedule</div>
      <DateChips value={first} onChange={setFirst} today={P} min={P} label="First payday on the new schedule"
        payDates={[shift(P, 7), shift(P, 14)]}
        tagFor={(_d, i) => i === 0 ? 'next payday' : i === 1 ? '+1 week' : '+2 weeks'} />

      <div className="rw-lab">Each pay</div>
      <div className="rw-amtrow"><span>{sym}</span>
        <input type="number" inputMode="decimal" aria-label="Each pay" value={amt} onChange={e => setAmt(e.target.value)} /></div>
      {freq !== nowFreq && <div className="rw-hint">About {money(suggested(freq))} for the same yearly pay.</div>}

      <div className="rw-lab">Your cycles</div>
      <div className="rw-cst">
        <div className="now" style={{ flex: curDays }}><b>{short(cur.startDate)} – {short(cur.endDate)}</b>this cycle stays</div>
        {strip.map((c, i) => (
          <div key={c.start} className={i === 0 && first > P ? 'gap' : 'nw'} style={{ flex: c.days }}>
            <b>{short(c.start)}</b>{i === 0 && first > P ? `${c.days} days · bridge` : c.start === first ? freq : ''}
          </div>
        ))}
      </div>

      <div className="rw-tiles">
        <div className="rw-tile"><div className="k">Each pay</div><div className="v">{money(cents)}</div><div className="d">was {money(nowAmount)}</div></div>
        <div className="rw-tile"><div className="k">Budgets each pay</div><div className="v">{money(budgetsNew)}</div><div className="d">was {money(budgetsNow)}</div></div>
        <div className={`rw-tile${level === 'under' ? ' out' : ''}`}><div className="k">{level === 'under' ? 'Overdrawn' : 'Lowest'}</div>
          <div className={`v ${level}`}>{money(low)}</div><div className="d">before pay {short(shift(proj[lowIdx]?.endDate ?? cur.endDate, 1))}</div></div>
      </div>
      {level !== 'ok' && (level === 'under'
        ? <div className="rw-warn-ban under"><span className="i">!</span><span>On {freq} pay you’d be <b>{money(-low)} overdrawn</b> before pay {short(shift(proj[lowIdx].endDate, 1))}. Forecast shows which expenses bunch up.</span></div>
        : <div className="rw-warn-ban near"><span>On {freq} pay, before pay {short(shift(proj[lowIdx].endDate, 1))} dips <b>{money(floorCents - low)}</b> into your floor. Forecast shows which expenses bunch up.</span></div>)}

      <div className="rw-note">Takes effect when you close this cycle on {short(cur.endDate)}. Nothing before then changes.</div>
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onBack}>Back</button>
        <button type="button" className="rw-cta" disabled={changed && busy} onClick={changed ? save : onBack}>
          {!changed ? 'Done' : freq === nowFreq ? `Move payday to ${short(first)}` : `Switch to ${freq}`}
        </button>
      </div>
    </>
  )
}
