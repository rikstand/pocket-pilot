import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, budgetsInCycle, cycleRuleOn, previewBudgetChange, toEngineExpenses } from '../lib/forecast'
import type { ForecastResult } from '../lib/forecast'
import {
  getPayees, findOrCreatePayee,
  addBudgetSpendEntry, updateBudgetSpendEntry, deleteBudgetSpendEntry,
  setExpenseOverride, clearExpenseOverride, setExpenseAmountFrom, deleteExpenseAmountVersion,
  archiveExpense, unarchiveExpense, deactivateExpense, reactivateExpense,
} from '../lib/repository'
import { budgetHistory, budgetFlag, type PastCycle, type BudgetFlag } from './budgetHistory'
import Preview, { previewStats } from './Preview'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { LogContext, type LogApi } from './logContext'

/**
 * Journey 5: one sheet to log spend, behind both + buttons, and a budget's
 * spend this cycle. Places (their page, the place sheet and a budget's Places
 * tab) come with Journey 11.
 */

type View =
  | { kind: 'log'; budgetId?: string; fromPlus: boolean; entry?: any; back?: string }
  | { kind: 'budget'; budgetId: string }

interface Data {
  start: string
  end: string
  closingCents: number
  floorCents: number
  budgets: ReturnType<typeof budgetsInCycle>
  entries: any[]          // this cycle
  allEntries: any[]       // every cycle, for which places go where
  payees: any[]
  rows: ForecastResult    // for previews: the same rows the forecast uses
  history: Record<string, PastCycle[]>
  flags: Record<string, BudgetFlag | null>
}

const PERIOD: Record<string, string> = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month', annually: 'year' }

// How far a budget change is previewed: 12 paydays (budget nudge mock).
const PREVIEW_PAYS = 12

const todayStr = () => formatDate(new Date())
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const dayName = (d: string, month = true) => parseDate(d).toLocaleDateString('en-NZ',
  month ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' }).replace(',', '')
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function LogSheetsProvider({ accountId, onAddOther, children }: {
  accountId: string
  // "Add a bill, one-off or income": today's add flow until Journey 9.
  onAddOther: () => void
  children: ReactNode
}) {
  const { activeAccount } = useAccount()
  const [view, setView] = useState<View | null>(null)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const floorCents = activeAccount?.safety_floor_cents ?? 0

  async function load() {
    try {
      const [f, payees] = await Promise.all([
        loadForecast(accountId, floorCents, { numCycles: PREVIEW_PAYS + 1 }),
        getPayees(accountId),
      ])
      const c = f.cycles[0]
      if (!c) { setError('No open cycle.'); return }
      const all = f.budgetSpendRows ?? []
      const budgets = budgetsInCycle(f, c.startDate, c.endDate)
      const closed = (f.storedCycles ?? []).filter((x: any) => x.is_closed)
      const history: Data['history'] = {}, flags: Data['flags'] = {}
      for (const b of budgets) {
        const row = f.expenseRows.find((e: any) => e.id === b.id)
        if (!row) continue
        history[b.id] = budgetHistory(toEngineExpenses([row])[0], closed, all, f.expenseOverrideRows ?? [],
          d => cycleRuleOn(f.incomeRows, d))
        flags[b.id] = budgetFlag(history[b.id], b.baseCents)
      }
      setData({ rows: f, history, flags,
        start: c.startDate, end: c.endDate, closingCents: c.committedClosingBalanceCents, floorCents,
        budgets,
        entries: all.filter((e: any) => e.spent_date >= c.startDate && e.spent_date <= c.endDate),
        allEntries: all, payees: payees ?? [],
      })
      setError('')
    } catch (e: any) { setError(e.message) }
  }

  // Fresh data every time a sheet opens: spend may have changed elsewhere.
  const opening = view !== null
  useEffect(() => { if (opening) load() }, [opening, accountId])

  const api = useMemo<LogApi>(() => ({
    log: (budgetId?: string) => setView({ kind: 'log', budgetId, fromPlus: !budgetId }),
    budget: (budgetId: string) => setView({ kind: 'budget', budgetId }),
  }), [])

  const close = () => setView(null)

  return (
    <LogContext.Provider value={api}>
      {children}
      {view && (
        <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget) close() }}>
          <div className="rw-sheet" role="dialog" aria-modal="true">
            <div className="rw-grab" />
            {error ? <div className="rw-sd">{error}</div>
              : !data ? <div className="rw-sd">Loading…</div>
              : view.kind === 'budget'
                ? <BudgetSheet data={data} budgetId={view.budgetId} onClose={close} accountId={accountId}
                    onChanged={async () => { notifyDataChanged(); close() }}
                    onLog={() => setView({ kind: 'log', budgetId: view.budgetId, fromPlus: false, back: view.budgetId })}
                    onEdit={entry => setView({ kind: 'log', budgetId: entry.expense_id, fromPlus: false, entry, back: view.budgetId })} />
                : <LogSheet key={view.entry?.id ?? 'new'} data={data} accountId={accountId} view={view}
                    onClose={close}
                    onDone={async () => {
                      notifyDataChanged()
                      if (view.back) { await load(); setView({ kind: 'budget', budgetId: view.back }) } else close()
                    }}
                    onAddOther={() => { close(); onAddOther() }}
                    currency={activeAccount?.currency_code} />}
          </div>
        </div>
      )}
    </LogContext.Provider>
  )
}

/* ── a budget's spend this cycle ─────────────────────────────────────── */
function BudgetSheet({ data, budgetId, accountId, onClose, onLog, onEdit, onChanged }: {
  data: Data; budgetId: string; accountId: string; onClose: () => void; onLog: () => void
  onEdit: (entry: any) => void; onChanged: () => void
}) {
  const [tab, setTab] = useState<'spend' | 'change'>('spend')
  const { activeAccount } = useAccount()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), true)
  const b = data.budgets.find(x => x.id === budgetId)
  const mine = data.entries.filter(e => e.expense_id === budgetId)
    .sort((x, y) => y.spent_date.localeCompare(x.spent_date) || (y.created_at ?? '').localeCompare(x.created_at ?? ''))
  const spent = mine.reduce((s, e) => s + e.amount_cents, 0)
  const planned = b?.plannedCents ?? 0
  const t = todayStr()
  const label = (d: string) => d === t ? 'Today' : d === shift(t, -1) ? 'Yesterday' : dayName(d)
  const placeName = (id: string | null) => data.payees.find(p => p.id === id)?.name ?? null

  const days: string[] = []
  for (const e of mine) if (!days.includes(e.spent_date)) days.push(e.spent_date)

  const flag = data.flags[budgetId]
  return (
    <>
      <div className="rw-sh-h">
        <div>
          <div className="rw-sheet-title">{b?.name ?? 'Budget'}</div>
          <div className="rw-sd">{money(spent)} of {fmt(planned, false)} this cycle · {planned - spent >= 0 ? `${money(planned - spent)} left` : `${money(spent - planned)} over`}</div>
        </div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="rw-seg flush">
        <button type="button" className={tab === 'spend' ? 'on' : ''} onClick={() => setTab('spend')}>Spend</button>
        <button type="button" className={tab === 'change' ? 'on' : ''} onClick={() => setTab('change')}>Change</button>
      </div>

      {tab === 'change' && b ? <BudgetChange data={data} budget={b} spentCents={spent} accountId={accountId} onCancel={() => setTab('spend')} onSaved={onChanged} /> : <>
        {flag && (
          <button type="button" className={`rw-flagban ${flag.dir}`} onClick={() => setTab('change')}>
            <span><b>{flag.dir === 'over' ? '↑' : '↓'} Usually {flag.dir} by {fmt(flag.gapCents, false)}</b></span>
            <span className="go">Change ›</span>
          </button>
        )}
        {mine.length === 0 && <div className="rw-sd" style={{ padding: '14px 4px' }}>Nothing logged yet this cycle.</div>}
        {days.map(d => (
          <div key={d}>
            <div className="rw-dayh">{label(d)}</div>
            <div className="rw-group flush">
              {mine.filter(e => e.spent_date === d).map(e => {
                const place = placeName(e.payee_id)
                const legacy = e.label && e.label !== 'Quick add' ? e.label : null
                return (
                  <button key={e.id} type="button" className="rw-row" onClick={() => onEdit(e)}>
                    <div className="rw-tx">
                      <div className="rw-row-name">{place ?? e.note ?? legacy ?? <span className="rw-muted">No place</span>}</div>
                      {place && e.note && <div className="rw-sub">{e.note}</div>}
                    </div>
                    <div className={`rw-am${e.amount_cents < 0 ? ' in' : ''}`}>{money(e.amount_cents)}</div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <div className="rw-ctas"><button type="button" className="rw-cta" onClick={onLog}>+ Log spend</button></div>
      </>}
    </>
  )
}

/* ── change a budget's amount (budget nudge) ─────────────────────────── */
function BudgetChange({ data, budget, spentCents, accountId, onCancel, onSaved }: {
  data: Data; budget: Data['budgets'][number]; spentCents: number; accountId: string
  onCancel: () => void; onSaved: () => void
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const flag = data.flags[budget.id]
  const history = data.history[budget.id] ?? []
  const cycles = data.rows.cycles
  const starts = cycles.slice(0, 4).map((c: any) => c.startDate)

  const [val, setVal] = useState(String(budget.plannedCents / 100))
  const [scope, setScope] = useState<'once' | 'from'>('from')
  const [fromIdx, setFromIdx] = useState(0)
  const [busy, setBusy] = useState(false)

  const valCents = Math.max(0, Math.round((parseFloat(val) || 0) * 100))
  // The field is the whole pay's amount; a budget is stored per its own
  // period, so a weekly budget on fortnightly pay saves half of it.
  const perCents = budget.baseCents > 0 ? Math.round(valCents * budget.unitCents / budget.baseCents) : valCents
  const from = scope === 'once' ? starts[0] : starts[fromIdx]
  const changed = scope === 'once' ? valCents !== budget.plannedCents : valCents !== budget.baseCents || (fromIdx === 0 && budget.isOverride)
  // It can't go under what's already spent, where the change reaches this cycle.
  const belowSpent = (scope === 'once' || fromIdx === 0) && valCents < spentCents

  const now = cycles.slice(0, PREVIEW_PAYS).map((c: any) => c.committedClosingBalanceCents)
  const after = changed && val.trim()
    ? previewBudgetChange(data.rows, data.floorCents, PREVIEW_PAYS + 1, {
        expenseId: budget.id, cycleStart: from, totalCents: valCents, perOccurrenceCents: perCents,
        scope: scope === 'once' ? 'once' : 'always',
      }).slice(0, PREVIEW_PAYS).map(c => c.committedClosingBalanceCents)
    : []
  const payDates = cycles.slice(0, PREVIEW_PAYS).map((c: any) => shift(c.endDate, 1))
  const st = after.length ? previewStats(now, after, data.floorCents) : null
  const when = scope === 'once' ? 'this cycle' : fromIdx === 0 ? 'from this pay' : `from ${dayName(starts[fromIdx], true).replace(/^\w+ /, '')}`

  const avgChip = flag?.averageCents ?? (history.length
    ? Math.round(history.slice(-4).reduce((s, c) => s + c.spentCents, 0) / Math.min(4, history.length) / 500) * 500 : null)
  const mx = Math.max(...history.map(c => c.spentCents), budget.baseCents, 1) * 1.15

  // Anything ever logged to it, in any cycle.
  const everUsed = data.allEntries.some(e => e.expense_id === budget.id)

  async function retire() {
    if (busy) return
    setBusy(true)
    try {
      if (everUsed) {
        await archiveExpense(budget.id, data.end)
        toast(`${budget.name} archived from ${dayName(shift(data.end, 1), false)}`, { undo: async () => { await unarchiveExpense(budget.id); notifyDataChanged() } })
      } else {
        await deactivateExpense(budget.id)
        toast(`${budget.name} deleted`, { undo: async () => { await reactivateExpense(budget.id); notifyDataChanged() } })
      }
      onSaved()
    } catch (err: any) { alert('Could not change the budget: ' + err.message) }
    finally { setBusy(false) }
  }

  async function save() {
    if (!changed || belowSpent || busy) return
    setBusy(true)
    const ovRows = data.rows.expenseOverrideRows ?? []
    const prevOv = ovRows.find((o: any) => o.expense_id === budget.id && o.cycle_start === from) ?? null
    try {
      if (scope === 'once') {
        if (valCents === budget.baseCents) await clearExpenseOverride(budget.id, from)
        else await setExpenseOverride(budget.id, accountId, from, valCents)
        toast(`${budget.name}: ${money(valCents)} this cycle only`, { undo: async () => {
          if (prevOv) await setExpenseOverride(budget.id, accountId, from, prevOv.amount_cents)
          else await clearExpenseOverride(budget.id, from)
          notifyDataChanged()
        } })
      } else {
        const row = data.rows.expenseRows.find((e: any) => e.id === budget.id)
        const prevSameDay = (row?.expense_amount_versions ?? []).find((v: any) => v.effective_from === from) ?? null
        const written = await setExpenseAmountFrom(budget.id, accountId, from, perCents)
        // That cycle now follows the new amount; later one-offs stay.
        if (prevOv) await clearExpenseOverride(budget.id, from)
        toast(`${budget.name}: ${money(valCents)} ${when}`, { undo: async () => {
          if (prevSameDay) await setExpenseAmountFrom(budget.id, accountId, from, prevSameDay.amount_cents)
          else await deleteExpenseAmountVersion(written.id)
          if (prevOv) await setExpenseOverride(budget.id, accountId, from, prevOv.amount_cents)
          notifyDataChanged()
        } })
      }
      onSaved()
    } catch (err: any) { alert('Could not change the budget: ' + err.message) }
    finally { setBusy(false) }
  }

  return (
    <>
      {flag && (
        <div className={`rw-verdict ${flag.dir}`}>
          <div className="big">{flag.dir === 'over' ? '↑' : '↓'} {money(flag.gapCents)}</div>
          <div className="t"><b>Usually {flag.dir} by {money(flag.gapCents)}</b>
            {flag.cycles} of the last 4 closed cycles. Your average is {money(flag.averageCents)}.</div>
        </div>
      )}

      {history.length > 0 && (
        <div className="rw-card rw-pv">
          <div className="rw-pv-k"><span>Spent, last {history.length} pays</span>
            <span className="rw-pv-lg"><i className="lg-under" />under<i className="lg-over" />over</span></div>
          <svg viewBox="0 0 300 96" role="img" aria-label="Spending against the budget, past pays">
            {history.map((c, j) => {
              const bw = 280 / Math.max(6, history.length), x = 10 + j * bw + bw * 0.18, w = bw * 0.64
              const ht = c.spentCents / mx * 72, y = 80 - ht, over = c.spentCents > c.plannedCents
              return <g key={c.start}>
                <rect x={x} y={y} width={w} height={Math.max(ht, 1)} rx="3" fill={over ? 'var(--rw-near-floor)' : 'var(--rw-good)'} opacity={over ? 1 : 0.75} />
                <text x={x + w / 2} y="92" fontSize="9" fill="var(--rw-muted)" textAnchor="middle" fontWeight="650">{money(c.spentCents)}</text>
              </g>
            })}
            <line x1="6" x2="294" y1={80 - budget.baseCents / mx * 72} y2={80 - budget.baseCents / mx * 72} stroke="var(--rw-ink)" strokeDasharray="4 3" strokeOpacity=".6" />
            <text x="294" y={76 - budget.baseCents / mx * 72} fontSize="9" fill="var(--rw-muted)" textAnchor="end" fontWeight="700">budget {money(budget.baseCents)}</text>
          </svg>
        </div>
      )}

      <div className="rw-lab">New amount</div>
      <div className="rw-amtrow"><span>{sym}</span>
        <input type="number" inputMode="decimal" aria-label="New budget amount" value={val} onChange={e => setVal(e.target.value)} />
        <em>each pay</em></div>
      <div className="rw-chips" style={{ marginTop: 8 }}>
        {avgChip != null && <button type="button" className={`${flag ? 'avg ' + flag.dir : ''}${valCents === avgChip ? ' on' : ''}`}
          onClick={() => setVal(String(avgChip / 100))}>Your average {money(avgChip)}</button>}
        <button type="button" className={valCents === budget.baseCents ? 'on' : ''} onClick={() => setVal(String(budget.baseCents / 100))}>Current {money(budget.baseCents)}</button>
      </div>
      {scope === 'from' && Math.abs(perCents - valCents) > 0 && (
        <div className="rw-hint">Saved as {money(perCents)} a {PERIOD[budget.frequency] ?? 'period'}, the way this budget is set.</div>
      )}

      <div className="rw-lab">When</div>
      <div className="rw-seg flush">
        <button type="button" className={scope === 'once' ? 'on' : ''} onClick={() => setScope('once')}>Just this cycle</button>
        <button type="button" className={scope === 'from' ? 'on' : ''} onClick={() => setScope('from')}>From a date</button>
      </div>
      {scope === 'from' && (
        <div className="rw-chips" style={{ marginTop: 8 }}>
          {starts.map((d: string, k: number) => (
            <button key={d} type="button" className={fromIdx === k ? 'on' : ''} onClick={() => setFromIdx(k)}>
              {k === 0 ? 'This pay' : `Pay ${dayName(d).replace(/^\w+ /, '')}`}
            </button>
          ))}
        </div>
      )}

      {!changed || !val.trim()
        ? <div className="rw-empty">Type an amount, or tap a chip, to see what it does to each payday.</div>
        : <Preview nowCents={now} newCents={after} payDates={payDates} floorCents={data.floorCents} money={money} />}

      {belowSpent && <div className="rw-hint">You’ve already spent {money(spentCents)} this cycle, so it can’t go lower than that for this pay.</div>}

      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onCancel}>Cancel</button>
        <button type="button" className="rw-cta" disabled={changed && (belowSpent || busy || !val.trim())} onClick={changed ? save : onCancel}>
          {!changed ? 'Done' : `Use ${money(valCents)} ${when}${st && st.level === 'under' && st.worse ? ' anyway' : ''}`}
        </button>
      </div>

      {/* Archive keeps the spend history; Delete only for a budget nothing was ever logged to. */}
      <div className="rw-group flush" style={{ marginTop: 12 }}>
        <button type="button" className="rw-row" disabled={busy} onClick={retire}>
          <div className="rw-tx">
            <div className="rw-row-name rw-danger">{everUsed ? `Archive ${budget.name}` : `Delete ${budget.name}`}</div>
            <div className="rw-sub">{everUsed
              ? `Stops it from the next pay, ${dayName(shift(data.end, 1), false)}. Spending history stays`
              : 'Nothing was ever logged to it, so nothing is lost'}</div>
          </div>
        </button>
      </div>
    </>
  )
}

/* ── log or edit one entry ───────────────────────────────────────────── */
function LogSheet({ data, accountId, view, onClose, onDone, onAddOther, currency }: {
  data: Data; accountId: string; view: Extract<View, { kind: 'log' }>
  onClose: () => void; onDone: () => void; onAddOther: () => void; currency?: string | null
}) {
  const toast = useToast()
  const fmt = moneyFormatter(currency)
  const sym = currencySymbol(currency)
  const money = (c: number, cents = true) => (c < 0 ? '−' : '') + fmt(Math.abs(c), cents)
  const e = view.entry
  const t = todayStr()
  // The last day you can log to: today, or the cycle's last day once it has ended.
  const last = t <= data.end ? t : data.end
  const yesterday = shift(last, -1)

  // Most used this cycle first.
  const order = useMemo(() => {
    const n: Record<string, number> = {}
    for (const x of data.entries) n[x.expense_id] = (n[x.expense_id] ?? 0) + 1
    return [...data.budgets].sort((a, b) => (n[b.id] ?? 0) - (n[a.id] ?? 0))
  }, [data])

  const [amt, setAmt] = useState(e ? (Math.abs(e.amount_cents) / 100).toFixed(2) : '')
  const [refund, setRefund] = useState(e ? e.amount_cents < 0 : false)
  const [budgetId, setBudgetId] = useState<string>(e?.expense_id ?? view.budgetId ?? order[0]?.id ?? '')
  const [payeeId, setPayeeId] = useState<string | null>(e?.payee_id ?? null)
  const [q, setQ] = useState<string | null>(null)        // searching for a place
  const [newPlace, setNewPlace] = useState<string | null>(null)
  const [date, setDate] = useState<string>(e?.spent_date ?? last)
  const [early, setEarly] = useState(!!e && e.spent_date < yesterday)
  const [noteOn, setNoteOn] = useState(!!e?.note)
  const [note, setNote] = useState<string>(e?.note ?? '')
  const [allB, setAllB] = useState(false)
  const [busy, setBusy] = useState(false)

  const budget = data.budgets.find(b => b.id === budgetId)
  const cents = Math.round((parseFloat(amt) || 0) * 100) * (refund ? -1 : 1)

  // Where each place's spend usually goes, and the places most used per budget.
  const usage = useMemo(() => {
    const byPlace: Record<string, Record<string, number>> = {}
    for (const x of data.allEntries) {
      if (!x.payee_id) continue
      ;(byPlace[x.payee_id] ??= {})[x.expense_id] = ((byPlace[x.payee_id] ?? {})[x.expense_id] ?? 0) + 1
    }
    return byPlace
  }, [data])
  const live = data.payees
  const usualBudget = (pid: string) => {
    const m = usage[pid]; if (!m) return null
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  const tops = live
    .filter(p => (usage[p.id]?.[budgetId] ?? 0) > 0)
    .sort((a, b) => (usage[b.id]?.[budgetId] ?? 0) - (usage[a.id]?.[budgetId] ?? 0))
    .slice(0, 3)
  const picked = payeeId ? live.find(p => p.id === payeeId) : null
  if (picked && !tops.includes(picked)) tops.push(picked)
  const usual = picked ? usualBudget(picked.id) : null
  const usualName = usual && usual !== budgetId ? data.budgets.find(b => b.id === usual)?.name : null

  const shownBudgets = allB ? order : order.slice(0, 4)
  if (budget && !shownBudgets.includes(budget)) shownBudgets.push(budget)

  // What's left in the budget, and what going over does to payday.
  const before = data.entries.filter(x => x.expense_id === budgetId && x.id !== e?.id).reduce((s, x) => s + x.amount_cents, 0)
  const planned = budget?.plannedCents ?? 0
  const after = before + cents
  const left = planned - after
  // The forecast already counts this entry as saved; take it out first.
  const withOld = e && e.expense_id === budgetId ? before + e.amount_cents : before
  const over = (s: number) => Math.max(0, s - planned)
  const baseClose = data.closingCents + (e && e.expense_id === budgetId ? over(withOld) - over(before) : 0)
  const extra = over(after) - over(before)
  const newClose = baseClose - extra
  const level = newClose < 0 ? 'under' : newClose < data.floorCents ? 'near' : 'ok'

  const days: string[] = []
  for (let d = data.start; d <= last; d = shift(d, 1)) days.push(d)

  const placeLabel = () => picked?.name ?? newPlace
  async function resolvePlace(): Promise<string | null> {
    if (payeeId) return payeeId
    if (newPlace?.trim()) return (await findOrCreatePayee(accountId, newPlace))?.id ?? null
    return null
  }

  async function save() {
    if (!cents || !budgetId || busy) return
    setBusy(true)
    try {
      const pid = await resolvePlace()
      const where = placeLabel()
      const words = `${money(cents)}${where ? ' at ' + where : ''} · ${budget?.name ?? ''}${date < yesterday ? ' · ' + dayName(date, false) : ''}`
      if (e) {
        await updateBudgetSpendEntry(e.id, cents, e.label ?? '', { payeeId: pid, note: noteOn ? note : null }, { expenseId: budgetId, spentDate: date })
        toast('Saved · ' + words, { undo: async () => {
          await updateBudgetSpendEntry(e.id, e.amount_cents, e.label ?? '', { payeeId: e.payee_id, note: e.note }, { expenseId: e.expense_id, spentDate: e.spent_date })
          notifyDataChanged()
        } })
      } else {
        const row = await addBudgetSpendEntry(accountId, budgetId, cents, '', date, { payeeId: pid, note: noteOn ? note : null })
        toast(words, { undo: async () => { await deleteBudgetSpendEntry(row.id); notifyDataChanged() } })
      }
      onDone()
    } catch (err: any) { alert('Could not save: ' + err.message) }
    finally { setBusy(false) }
  }

  async function remove() {
    if (!e || busy) return
    setBusy(true)
    try {
      await deleteBudgetSpendEntry(e.id)
      toast('Entry deleted', { undo: async () => {
        await addBudgetSpendEntry(accountId, e.expense_id, e.amount_cents, e.label ?? '', e.spent_date, { payeeId: e.payee_id, note: e.note })
        notifyDataChanged()
      } })
      onDone()
    } catch (err: any) { alert('Could not delete: ' + err.message) }
    finally { setBusy(false) }
  }

  if (!data.budgets.length) return (
    <>
      <div className="rw-sh-h"><div className="rw-sheet-title">Log spend</div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="rw-sd" style={{ padding: '12px 2px' }}>No budgets this cycle. Spend is logged against a budget, such as Groceries.</div>
      <button type="button" className="rw-addo" onClick={onAddOther}>Add a bill, one-off or income ›</button>
    </>
  )

  const matches = q === null ? [] : live
    .filter(p => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5)
  const exact = q !== null && live.some(p => p.name.toLowerCase() === q.trim().toLowerCase())

  return (
    <>
      <div className="rw-sh-h">
        <div>
          <div className="rw-sheet-title">{e ? 'Edit spend' : 'Log spend'}</div>
          <div className="rw-sd">
            {!cents ? <>{money(planned - before)} left in {budget?.name}</>
              : left >= 0 ? <><b>{money(left)}</b> left in {budget?.name} after this</>
              : <><b>{money(-left)}</b> over {budget?.name} after this</>}
          </div>
        </div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <div className="rw-card">
        <div className="rw-amt-row">
          <div className="rw-amt"><span>{sym}</span>
            <input type="number" inputMode="decimal" placeholder="0.00" autoFocus={!e}
              value={amt} onChange={ev => setAmt(ev.target.value)}
              onKeyDown={ev => { if (ev.key === 'Enter') save() }} />
          </div>
          <button type="button" className={`rw-refb${refund ? ' on' : ''}`} onClick={() => setRefund(r => !r)}>
            {refund ? 'Refund ✓' : 'Refund'}
          </button>
        </div>

        <div className="rw-lab">Budget</div>
        <div className="rw-chips">
          {shownBudgets.map(b => (
            <button key={b.id} type="button" className={budgetId === b.id ? 'on' : ''} onClick={() => setBudgetId(b.id)}>{b.name}</button>
          ))}
          {!allB && shownBudgets.length < order.length && (
            <button type="button" className="dash" onClick={() => setAllB(true)}>More…</button>
          )}
        </div>
        {usualName && (
          <div className="rw-hint">{picked?.name} usually goes to {usualName}.{' '}
            <button type="button" onClick={() => setBudgetId(usual!)}>Use that</button></div>
        )}

        <div className="rw-lab">Where</div>
        <div className="rw-chips">
          {tops.map(p => (
            <button key={p.id} type="button" className={payeeId === p.id ? 'on' : ''}
              onClick={() => { setPayeeId(payeeId === p.id ? null : p.id); setNewPlace(null); setQ(null) }}>{p.name}</button>
          ))}
          {newPlace && <button type="button" className="on" onClick={() => setNewPlace(null)}>{newPlace}</button>}
          <button type="button" className={`dash${q !== null ? ' on' : ''}`} onClick={() => setQ(q === null ? '' : null)}>Other…</button>
        </div>
        {q !== null && (
          <>
            <input className="rw-srch" placeholder="Search or add a place" autoFocus autoComplete="off"
              value={q} onChange={ev => setQ(ev.target.value)} />
            <div className="rw-res">
              {matches.map(p => (
                <button key={p.id} type="button" onClick={() => { setPayeeId(p.id); setNewPlace(null); setQ(null) }}>
                  {p.name}<span>{data.budgets.find(b => b.id === usualBudget(p.id))?.name ?? ''}</span>
                </button>
              ))}
              {q.trim() && !exact && (
                <button type="button" onClick={() => {
                  const n = q.trim(); setNewPlace(n.charAt(0).toUpperCase() + n.slice(1)); setPayeeId(null); setQ(null)
                }}>Add “{q.trim()}”<span>new place</span></button>
              )}
            </div>
          </>
        )}

        <div className="rw-lab">When</div>
        <div className="rw-chips">
          {last === t && <button type="button" className={date === t && !early ? 'on' : ''} onClick={() => { setDate(t); setEarly(false) }}>Today</button>}
          {yesterday >= data.start && (
            <button type="button" className={date === yesterday && !early ? 'on' : ''} onClick={() => { setDate(yesterday); setEarly(false) }}>Yesterday</button>
          )}
          {days.length > 2 && (
            <button type="button" className={`dash${early ? ' on' : ''}`}
              onClick={() => { setEarly(true); if (date >= yesterday) setDate(shift(yesterday, -1) >= data.start ? shift(yesterday, -1) : data.start) }}>
              {early ? dayName(date, false) : 'Earlier…'}
            </button>
          )}
        </div>
        {early && (
          <div className="rw-days" role="group" aria-label="Day">
            {days.map(d => (
              <button key={d} type="button" className={date === d ? 'on' : ''}
                onClick={() => { setDate(d); setEarly(d < yesterday) }}>
                <span>{LETTERS[parseDate(d).getDay()]}</span>{parseDate(d).getDate()}
              </button>
            ))}
          </div>
        )}

        {noteOn
          ? <><div className="rw-lab">Note</div>
              <input className="rw-note" placeholder="What was it?" value={note} onChange={ev => setNote(ev.target.value)} /></>
          : <div className="rw-chips" style={{ marginTop: 8 }}>
              <button type="button" className="dash" onClick={() => setNoteOn(true)}>+ Note</button>
            </div>}
      </div>

      {extra > 0 && (
        <div className={`rw-strip ${level}`}>
          <span className="g1">{money(extra)} over</span>
          <span className="g2">left before pay {dayName(shift(data.end, 1), false)}: {money(baseClose, false)} → <b>{money(newClose, false)}</b>
            {level === 'under' ? ', overdrawn' : level === 'near' ? ', into your floor' : ''}</span>
        </div>
      )}

      <div className="rw-ctas">
        {e && <button type="button" className="rw-cta sec" disabled={busy} onClick={remove}>Delete</button>}
        <button type="button" className="rw-cta" disabled={!cents || busy} onClick={save}>
          {e ? 'Save' : !cents ? 'Add' : `${refund ? 'Add refund' : 'Add'} ${money(Math.abs(cents))}`}
        </button>
      </div>
      {!e && view.fromPlus && (
        <button type="button" className="rw-addo" onClick={onAddOther}>Add a bill, one-off or income ›</button>
      )}
    </>
  )
}
