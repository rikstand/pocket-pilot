import { useEffect, useState, type ReactNode } from 'react'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, cycleRuleOn, toEngineExpenses, toEngineIncome, type ForecastResult } from '../lib/forecast'
import { getCycleActuals, addCycleActual, deleteCycleActual, addBudgetSpendEntry, deleteBudgetSpendEntry, getPayees, fixLastClose } from '../lib/repository'
import { versionForDate } from '../lib/versions'
import { occurrencesOf } from '../engine/index'
import { budgetAmountForCycle } from '../engine/engine'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged, useDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { Mark } from './ItemsPage'
import { Segmented } from './controls'

/**
 * Journey 10, part one: past cycles. ‹ steps back through every closed cycle.
 * Each shows what happened and, where a forecast was saved at close, how it
 * compared. Records can be corrected (an estimate's real amount, a spend you
 * missed); the closing balance never moves here, because it was real.
 * Only the most recent close can be fixed (Fix this close): it moves the
 * next cycle's opening, so every payday after. Catching up is feat/refresh-catchup.
 */

const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const dayName = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface Data { rows: ForecastResult; actuals: any[]; payees: any[] }

export default function PastCycles({ accountId, onBackToNow }: { accountId: string; onBackToNow: () => void }) {
  const { activeAccount } = useAccount()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [idx, setIdx] = useState<number | null>(null)
  const [tab, setTab] = useState<'what' | 'avf'>('what')
  const [sheet, setSheet] = useState<{ kind: 'est'; item: any } | { kind: 'bud'; budget: any } | { kind: 'fix' } | null>(null)

  async function load() {
    try {
      const [rows, actuals, payees] = await Promise.all([
        loadForecast(accountId, floorCents, { numCycles: 1 }), getCycleActuals(accountId), getPayees(accountId),
      ])
      setData({ rows, actuals: actuals ?? [], payees: payees ?? [] }); setError('')
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [accountId])
  useDataChanged(load)

  if (error) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">{error}</div></div></div>
  if (!data) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">Loading…</div></div></div>

  const closed = (data.rows.storedCycles ?? []).filter((c: any) => c.is_closed)
  if (!closed.length) return (
    <div className="rw-page">
      <div className="rw-page-head"><div className="rw-sd">No closed cycles yet. Each one shows up here once you close it.</div></div>
      <div className="rw-group" style={{ marginTop: 12 }}><button type="button" className="rw-row" onClick={onBackToNow}>
        <div className="rw-tx"><div className="rw-row-name">Back to this cycle</div></div></button></div>
    </div>
  )
  const i = idx ?? closed.length - 1
  const c = closed[i]
  const view = describe(c, data, floorCents)
  const hasForecast = c.projected_close_cents != null
  const vsForecast = hasForecast ? c.closing_balance_cents - Number(c.projected_close_cents) : null
  const isLatest = i === closed.length - 1
  const stored = data.rows.storedCycles ?? []
  const next = stored.find((x: any) => x.start_date > c.start_date) ?? null

  return (
    <div className="rw-page">
      <div className="rw-cnav">
        <button type="button" className="rw-cnav-b" aria-label="Earlier cycle" disabled={i === 0} onClick={() => setIdx(i - 1)}>‹</button>
        <div className="rw-cnav-t"><b>{short(c.start_date)} – {short(c.end_date)}</b><span>Closed</span></div>
        <button type="button" className="rw-cnav-b" aria-label="Later cycle"
          onClick={() => (i === closed.length - 1 ? onBackToNow() : setIdx(i + 1))}>›</button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 6 }}>
        <button type="button" className="rw-today" onClick={onBackToNow}>Back to this cycle</button>
      </div>

      <div className="rw-hero-card">
        <div className="rw-trio">
          <div><span>opened</span><b>{money(c.opening_balance_cents)}</b></div>
          <div><span>closed</span><b>{money(c.closing_balance_cents ?? 0)}</b></div>
          <div><span>vs forecast</span><b className={vsForecast == null ? 'none' : vsForecast >= 0 ? 'good' : 'near'}>
            {vsForecast == null ? '—' : (vsForecast > 0 ? '+' : '') + money(vsForecast)}</b></div>
        </div>
        {c.fixed_from_cents != null && c.fixed_at && (
          <div className="rw-ob">Fixed {short(String(c.fixed_at).slice(0, 10))}: was {money(Number(c.fixed_from_cents))}</div>
        )}
      </div>

      <div style={{ margin: '12px 12px 0' }}>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'what', label: 'What happened' }, { value: 'avf', label: 'Actual vs forecast' }]} />
      </div>

      {tab === 'avf' ? (
        !hasForecast
          ? <div className="rw-card rw-inset rw-sd">No forecast was saved for this cycle. Cycles closed before forecasts were saved show what happened only.</div>
          : <>
              <div className="rw-card rw-inset">
                {avfRows(view, vsForecast!, money).map(r => (
                  <div key={r.name} className="rw-dvr">
                    <span className="dn">{r.name}<small>{r.sub}</small></span>
                    <span className="db"><i style={{ [r.v >= 0 ? 'left' : 'right']: '50%', width: r.w + '%',
                      background: r.v >= 0 ? 'var(--rw-good)' : 'var(--rw-near-floor)' } as any} /></span>
                    <span className={`dvv ${r.v >= 0 ? 'good' : 'near'}`}>{Math.round(r.v / 100) === 0 ? money(0) : (r.v > 0 ? '+' : '') + money(r.v)}</span>
                  </div>
                ))}
              </div>
              <div className="rw-hint" style={{ padding: '0 16px' }}>Green: better than forecast. Amber: worse. Correct a figure in What happened and these move; the closing balance doesn't.</div>
            </>
      ) : <>
        {group('Money in', view.income.map(x => (
          <div key={x.key} className="rw-row static"><Mark kind="income" />
            <div className="rw-tx"><div className="rw-row-name">{x.name}</div><div className="rw-sub">{dayName(x.date)}</div></div>
            <div className="rw-am in">+{money(x.cents)}</div></div>)))}
        {group('Went out', [
          ...view.fixed.map(x => (
            <div key={x.key} className="rw-row static"><Mark kind={x.bnpl ? 'bnpl' : 'fixed'} />
              <div className="rw-tx"><div className="rw-row-name">{x.name}</div><div className="rw-sub">{dayName(x.date)}</div></div>
              <div className="rw-am">{money(x.cents)}</div></div>)),
          ...(view.card ? [<div key="card" className="rw-row static"><span className="rw-cardmark" />
            <div className="rw-tx"><div className="rw-row-name">{view.card.name}</div><div className="rw-sub">Card payment</div></div>
            <div className="rw-am">{money(view.card.cents)}<small>paid ✓</small></div></div>] : []),
        ])}
        {group('Estimates', view.estimates.map(x => (
          <button key={x.id} type="button" className="rw-row" onClick={() => setSheet({ kind: 'est', item: x })}><Mark kind="estimate" />
            <div className="rw-tx"><div className="rw-row-name">{x.name}</div><div className="rw-sub">{x.dates.map(dayName).join(', ')}</div></div>
            <div className="rw-am">{x.actual != null ? money(x.actual) : <span className="rw-muted">~{money(x.estimate)}</span>}
              <small>{x.actual != null ? `est ${money(x.estimate)}` : 'not confirmed'}</small></div></button>)))}
        {group('Savings', view.savings.map(x => (
          <div key={x.key} className="rw-row static"><span className="rw-savmark" />
            <div className="rw-tx"><div className="rw-row-name">{x.name}</div></div>
            <span className="rw-pill good">Set aside ✓ {money(x.cents)}</span></div>)))}
        {view.budgets.length > 0 && <>
          <div className="rw-dl"><span className="rw-dl-k">Budgets</span>
            <span>{money(view.budgets.reduce((s, b) => s + b.spent, 0))} of {money(view.budgets.reduce((s, b) => s + b.planned, 0))}</span></div>
          <div className="rw-group">{view.budgets.map(b => (
            <button key={b.id} type="button" className="rw-row" onClick={() => setSheet({ kind: 'bud', budget: b })}>
              <Mark kind="budget" />
              <div className="rw-tx"><div className="rw-row-name">{b.name}</div>
                <div className="rw-pb"><i className={b.spent > b.planned ? 'ahead' : ''} style={{ width: Math.min(100, b.planned ? b.spent / b.planned * 100 : 0) + '%' }} /></div></div>
              <div className="rw-am">{money(b.spent)}<small>of {money(b.planned)}</small></div>
            </button>))}
          </div>
        </>}
      </>}

      <div className="rw-group" style={{ marginTop: 14 }}>
        {isLatest && next
          ? <button type="button" className="rw-row" onClick={() => setSheet({ kind: 'fix' })}>
              <div className="rw-tx"><div className="rw-row-name">Fix this close</div><div className="rw-sub">Wrong balance, or wrong answer about pay</div></div>
              <span className="rw-chev">›</span></button>
          : <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">Only the most recent close can be fixed. Older ones don't change today's balance.</div></div></div>}
      </div>

      {sheet?.kind === 'fix' && next && <FixClose cycle={c} next={next} rows={data.rows} accountId={accountId} money={money} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'est' && <EstimateFix cycle={c} item={sheet.item} accountId={accountId} money={money}
        closing={c.closing_balance_cents} hasForecast={hasForecast} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'bud' && <MissedSpend cycle={c} budget={sheet.budget} accountId={accountId} money={money}
        closing={c.closing_balance_cents} hasForecast={hasForecast} payees={data.payees} onClose={() => setSheet(null)} />}
    </div>
  )
}

function group(label: string, rows: ReactNode[]) {
  if (!rows.length) return null
  return <><div className="rw-dl"><span className="rw-dl-k">{label}</span></div><div className="rw-group">{rows}</div></>
}

/* What happened in one closed cycle, from the saved rows. */
function describe(c: any, data: Data, _floor: number) {
  const { rows, actuals } = data
  const s = c.start_date, e = c.end_date
  const spread = (total: number, n: number, k: number) => { const each = Math.floor(total / n); return k === n - 1 ? total - each * (n - 1) : each }

  const income = rows.incomeRows.filter((r: any) => !r.is_potential).flatMap((r: any) => {
    const occs = occurrencesOf(toEngineIncome([r])[0], s, e)
    const ov = (rows.incomeOverrideRows ?? []).find((o: any) => o.income_source_id === r.id && o.cycle_start === s)
    return occs.map((d: string, k: number) => ({ key: `${r.id}-${d}`, name: r.name, date: d,
      cents: ov ? spread(ov.amount_cents, occs.length, k) : versionForDate(r.income_amount_versions, d)?.amount_cents ?? 0 }))
  })

  const fixed: any[] = [], estimates: any[] = []
  for (const r of rows.expenseRows) {
    if ((r.mode ?? 'fixed') === 'budget') continue
    const occs = occurrencesOf(toEngineExpenses([r])[0], s, e)
    if (!occs.length) continue
    const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === s)
    const usual = occs.reduce((t: number, d: string) => t + (versionForDate(r.expense_amount_versions, d)?.amount_cents ?? 0), 0)
    if (r.mode === 'variable') {
      const saved = actuals.filter(a => a.cycle_id === c.id && a.expense_id === r.id).pop()
      estimates.push({ id: r.id, name: r.name, dates: occs, estimate: ov ? ov.amount_cents : usual,
        actual: saved ? saved.actual_amount_cents : null, savedRow: saved ?? null })
    } else {
      occs.forEach((d: string, k: number) => fixed.push({ key: `${r.id}-${d}`, name: r.name, date: d, bnpl: !!r.lay_by_id,
        cents: ov ? spread(ov.amount_cents, occs.length, k) : versionForDate(r.expense_amount_versions, d)?.amount_cents ?? 0 }))
    }
  }
  fixed.sort((a, b) => a.date.localeCompare(b.date))

  const paid = (rows.creditPaymentRows ?? []).find((p: any) => p.cycle_start === s)
  const card = paid && rows.creditCard ? { name: rows.creditCard.name ?? 'Card', cents: paid.amount_cents ?? 0 } : null

  const savings = (rows.savingsContributionRows ?? []).filter((x: any) => x.cycle_start === s).map((x: any) => {
    const g = (rows.savingsGoalRows ?? []).find((g: any) => g.id === x.savings_goal_id)
    const ov = (rows.savingsOverrideRows ?? []).find((o: any) => o.savings_goal_id === x.savings_goal_id && o.cycle_start === s)
    return { key: x.id, name: g?.name ?? 'Savings', cents: x.amount_cents ?? ov?.amount_cents ?? g?.per_cycle_cents ?? 0 }
  })

  const rule = cycleRuleOn(rows.incomeRows, s)
  const budgets = rows.expenseRows.filter((r: any) => r.mode === 'budget').map((r: any) => {
    const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === s)
    const planned = ov ? ov.amount_cents : budgetAmountForCycle(toEngineExpenses([r])[0], s, e, rule)
    const entries = (rows.budgetSpendRows ?? []).filter((x: any) => x.expense_id === r.id && x.spent_date >= s && x.spent_date <= e)
    return { id: r.id, name: r.name, planned, entries, spent: entries.reduce((t: number, x: any) => t + x.amount_cents, 0) }
  }).filter((b: any) => b.planned > 0 || b.spent !== 0)

  return { income, fixed, card, estimates, savings, budgets }
}

/* What explains the difference from forecast, from the records. Positive = better. */
function avfRows(v: ReturnType<typeof describe>, diff: number, money: (c: number) => string) {
  const rows: { name: string; sub: string; v: number }[] = []
  for (const e of v.estimates) if (e.actual != null && e.actual !== e.estimate) rows.push({ name: e.name, sub: `estimate ${money(e.estimate)}`, v: e.estimate - e.actual })
  for (const b of v.budgets) if (b.planned - b.spent > 0) rows.push({ name: b.name, sub: `budget ${money(b.planned)}`, v: b.planned - b.spent })
  const explained = rows.reduce((s, r) => s + r.v, 0)
  rows.sort((a, b) => b.v - a.v)
  rows.push({ name: 'Not logged', sub: 'what nothing above explains', v: diff - explained })
  const mx = Math.max(...rows.map(r => Math.abs(r.v)), 1)
  return rows.map(r => ({ ...r, w: Math.abs(r.v) / mx * 48 }))
}

/* ── an estimate's real amount, corrected after the close ─────────── */
function EstimateFix({ cycle, item, accountId, money, closing, hasForecast, onClose }: {
  cycle: any; item: any; accountId: string; money: (c: number) => string; closing: number; hasForecast: boolean; onClose: () => void
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const sym = currencySymbol(activeAccount?.currency_code)
  const [val, setVal] = useState(String((item.actual ?? item.estimate) / 100))
  const [busy, setBusy] = useState(false)
  const cents = Math.max(0, Math.round((parseFloat(val) || 0) * 100))
  const was = item.actual ?? item.estimate

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      const row = await addCycleActual(cycle.id, accountId, item.id, cents)
      toast(`${item.name}: ${money(cents)} saved to history`, { undo: async () => { await deleteCycleActual(row.id); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not save: ' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">{item.name} · real amount</div>
          <div className="rw-sd">{item.dates.map(dayName).join(', ')} · estimate {money(item.estimate)}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="rw-big"><span>{sym}</span>
          <input type="number" inputMode="decimal" aria-label="Real amount" value={val} onChange={e => setVal(e.target.value)} /></div>
        <div className="rw-note">
          {hasForecast && cents !== was ? <>Actual vs forecast: {item.name} moves by {money(Math.abs(cents - was))}, and Not logged moves the other way. </> : null}
          Your closing balance stays <b>{money(closing)}</b>. It was real.
        </div>
        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || cents === was} onClick={save}>Save real amount</button>
        </div>
      </div>
    </div>
  )
}

/* ── a budget in a closed cycle: its spend, and a spend you missed ─── */
function MissedSpend({ cycle, budget, accountId, money, closing, hasForecast, payees, onClose }: {
  cycle: any; budget: any; accountId: string; money: (c: number) => string; closing: number; hasForecast: boolean; payees: any[]; onClose: () => void
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const [amt, setAmt] = useState('')
  const [date, setDate] = useState(cycle.end_date)
  const [busy, setBusy] = useState(false)
  const cents = Math.round((parseFloat(amt) || 0) * 100)
  const days: string[] = []
  for (let d = cycle.start_date; d <= cycle.end_date; d = shift(d, 1)) days.push(d)
  const place = (id: string | null) => payees.find(p => p.id === id)?.name ?? null
  const entries = [...budget.entries].sort((a: any, b: any) => b.spent_date.localeCompare(a.spent_date))

  async function save() {
    if (!cents || busy) return
    setBusy(true)
    try {
      const row = await addBudgetSpendEntry(accountId, budget.id, cents, '', date, {})
      toast(`${budget.name}: ${money(cents)} added to ${dayName(date)}`, { undo: async () => { await deleteBudgetSpendEntry(row.id); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not add it: ' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">{budget.name}</div>
          <div className="rw-sd">{money(budget.spent)} of {money(budget.planned)} · {short(cycle.start_date)} – {short(cycle.end_date)}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
        {entries.length > 0 && (
          <div className="rw-group flush" style={{ marginTop: 10 }}>
            {entries.map((x: any) => (
              <div key={x.id} className="rw-row static">
                <div className="rw-tx"><div className="rw-row-name">{place(x.payee_id) ?? x.note ?? 'Spend'}</div><div className="rw-sub">{dayName(x.spent_date)}</div></div>
                <div className={`rw-am${x.amount_cents < 0 ? ' in' : ''}`}>{(x.amount_cents < 0 ? '−' : '') + fmt(Math.abs(x.amount_cents), true)}</div>
              </div>))}
          </div>
        )}
        <div className="rw-lab">Add a spend you missed</div>
        <div className="rw-amtrow"><span>{sym}</span>
          <input type="number" inputMode="decimal" placeholder="0" aria-label="Amount" value={amt} onChange={e => setAmt(e.target.value)} /></div>
        <div className="rw-days" role="group" aria-label="Day">
          {days.map(d => (
            <button key={d} type="button" className={date === d ? 'on' : ''} onClick={() => setDate(d)}>
              <span>{LETTERS[parseDate(d).getDay()]}</span>{parseDate(d).getDate()}
            </button>))}
        </div>
        <div className="rw-note">Only days in that cycle. {hasForecast && cents ? <>Not logged drops by {money(cents)}. </> : null}Your closing balance stays <b>{money(closing)}</b>.</div>
        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Close</button>
          <button type="button" className="rw-cta" disabled={!cents || busy} onClick={save}>Add to the {short(cycle.start_date)} cycle</button>
        </div>
      </div>
    </div>
  )
}

/* ── fix the most recent close: its balance and the next cycle's opening, together ── */
function FixClose({ cycle, next, rows, accountId, money, onClose }: {
  cycle: any; next: any; rows: ForecastResult; accountId: string; money: (c: number) => string; onClose: () => void
}) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const sym = currencySymbol(activeAccount?.currency_code)
  const payDate = shift(cycle.end_date, 1)
  const pay = rows.incomeRows.find((r: any) => r.is_primary && !r.is_potential)
  const payName = pay?.name ?? 'Pay'
  const payOv = pay ? (rows.incomeOverrideRows ?? []).find((o: any) => o.income_source_id === pay.id && o.cycle_start === payDate) : null
  const scheduled = pay ? (payOv?.amount_cents ?? versionForDate(pay.income_amount_versions, payDate)?.amount_cents ?? 0) : 0

  const oldClose = Number(cycle.closing_balance_cents ?? 0)
  const oldEntered = cycle.entered_balance_cents != null ? Number(cycle.entered_balance_cents) : null
  const oldPayIn: boolean | null = cycle.pay_in_balance ?? null
  const cents = (x: string) => Math.round((parseFloat(x) || 0) * 100)
  const [bal, setBal] = useState(String((oldEntered ?? oldClose) / 100))
  const [landed, setLanded] = useState<'yes' | 'no'>(oldPayIn ? 'yes' : 'no')
  const [payAmt, setPayAmt] = useState(String((oldEntered != null && oldPayIn ? oldEntered - oldClose : scheduled) / 100))
  const [busy, setBusy] = useState(false)

  const real = cents(bal)
  const newClose = real - (landed === 'yes' ? cents(payAmt) : 0)
  const delta = newClose - oldClose
  const changed = Math.round(delta) !== 0
  const looksLikePay = landed === 'no' && scheduled > 0 && Math.abs(delta - scheduled) < scheduled * 0.25
  const signed = (v: number) => Math.round(v / 100) === 0 ? money(0) : (v > 0 ? '+' : '') + money(v)

  async function save() {
    if (busy || !changed || looksLikePay) return
    setBusy(true)
    try {
      const moved = await fixLastClose(accountId, cycle.id, newClose, real, landed === 'yes')
      toast(`Close fixed. Every payday after moves ${signed(moved)}`, {
        undo: async () => { await fixLastClose(accountId, cycle.id, oldClose, oldEntered, oldPayIn); notifyDataChanged() },
      })
      notifyDataChanged(); onClose()
    } catch (e: any) { alert('Could not fix the close, so nothing was changed.\n\n' + e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="rw-sheet" role="dialog" aria-modal="true">
        <div className="rw-grab" />
        <div className="rw-sh-h"><div><div className="rw-sheet-title">Fix the {short(cycle.end_date)} close</div>
          <div className="rw-sd">Closed {money(oldClose)}{oldEntered != null
            ? <> · you entered {money(oldEntered)}, {payName} {oldPayIn ? 'in it' : 'not in it'}</> : null}</div></div>
          <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>

        <div className="rw-lab">Balance you checked that day</div>
        <div className="rw-big"><span>{sym}</span>
          <input type="number" inputMode="decimal" aria-label="Balance you checked" value={bal} onChange={e => setBal(e.target.value)} /></div>

        <div className="rw-lab">Was {payName} in that balance?</div>
        <div className="rw-seg flush" role="radiogroup">
          <button type="button" role="radio" aria-checked={landed === 'yes'} className={landed === 'yes' ? 'on' : ''} onClick={() => setLanded('yes')}>Yes, it was in</button>
          <button type="button" role="radio" aria-checked={landed === 'no'} className={landed === 'no' ? 'on' : ''} onClick={() => setLanded('no')}>No, not yet</button>
        </div>
        {landed === 'yes' && <>
          <div className="rw-lab">Amount that landed</div>
          <div className="rw-amtrow"><span>{sym}</span>
            <input type="number" inputMode="decimal" aria-label="Amount that landed" value={payAmt} onChange={e => setPayAmt(e.target.value)} /></div>
        </>}

        <div className="rw-tiles">
          <div className="rw-tile"><div className="k">Closed at</div><div className="v">{money(newClose)}</div><div className="d">was {money(oldClose)}</div></div>
          <div className="rw-tile"><div className="k">{short(next.start_date)} opens</div>
            <div className="v">{money(Number(next.opening_balance_cents) + delta)}</div><div className="d">was {money(Number(next.opening_balance_cents))}</div></div>
          <div className="rw-tile"><div className="k">Every payday after</div>
            <div className={`v ${delta >= 0 ? 'good' : 'near'}`}>{signed(delta)}</div><div className="d">{changed ? `from ${short(next.start_date)}` : 'no change'}</div></div>
        </div>

        {looksLikePay && (
          <div className="rw-warn-ban near rw-col">
            <span><b>That's about one {payName} more than before.</b> If pay was already in the balance, the opening would count it twice.</span>
            <button type="button" className="rw-cta" onClick={() => setLanded('yes')}>{payName} was in the balance</button>
          </div>
        )}

        <div className="rw-ctas">
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || !changed || looksLikePay} onClick={save}>Save the fix</button>
        </div>
      </div>
    </div>
  )
}
