import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, budgetsInCycle } from '../lib/forecast'
import {
  getPayees, findOrCreatePayee,
  addBudgetSpendEntry, updateBudgetSpendEntry, deleteBudgetSpendEntry,
} from '../lib/repository'
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
  budgets: { id: string; name: string; plannedCents: number }[]
  entries: any[]          // this cycle
  allEntries: any[]       // every cycle, for which places go where
  payees: any[]
}

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
        loadForecast(accountId, floorCents, { numCycles: 2 }),
        getPayees(accountId),
      ])
      const c = f.cycles[0]
      if (!c) { setError('No open cycle.'); return }
      const all = f.budgetSpendRows ?? []
      setData({
        start: c.startDate, end: c.endDate, closingCents: c.committedClosingBalanceCents, floorCents,
        budgets: budgetsInCycle(f, c.startDate, c.endDate),
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
                ? <BudgetSheet data={data} budgetId={view.budgetId} onClose={close}
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
function BudgetSheet({ data, budgetId, onClose, onLog, onEdit }: {
  data: Data; budgetId: string; onClose: () => void; onLog: () => void; onEdit: (entry: any) => void
}) {
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

  return (
    <>
      <div className="rw-sh-h">
        <div>
          <div className="rw-sheet-title">{b?.name ?? 'Budget'}</div>
          <div className="rw-sd">{money(spent)} of {fmt(planned, false)} this cycle · {planned - spent >= 0 ? `${money(planned - spent)} left` : `${money(spent - planned)} over`}</div>
        </div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
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
