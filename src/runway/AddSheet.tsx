import { useEffect, useState } from 'react'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, projectFromRows, billPromptsFromRows, cycleRuleOn, type ForecastResult } from '../lib/forecast'
import { addExpense, addIncomeSource, deactivateExpense, deactivateIncomeSource, createBillPot, deleteSavingsGoal } from '../lib/repository'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import Preview, { previewStats } from './Preview'
import { TextField, Segmented, ScheduleFields, newSchedule, ruleOf, nextDates, type Schedule } from './controls'
import { Mark } from './ItemsPage'

/**
 * Journey 9, part two: one form to add anything that goes out or comes in,
 * once or repeating. Shows what it does to each payday before you save.
 * Language: an "expense", never a "bill" (decided 16 Nov).
 */

type Type = 'fixed' | 'estimate' | 'budget' | 'income'
const TYPE_LINE: Record<Type, string> = {
  fixed: 'Same amount each time',
  estimate: 'Changes with use. You confirm the real amount',
  budget: 'Many spends, one limit',
  income: 'Money coming in',
}
const PLACEHOLDER: Record<Type, string> = {
  fixed: 'e.g. Car registration', estimate: 'e.g. Water', budget: 'e.g. Coffee', income: 'e.g. Tax refund',
}
const PERIOD_WORD: Record<string, string> = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }
const PER_YEAR: Record<string, number> = { daily: 365.25, weekly: 52.18, fortnightly: 26.09, monthly: 12, annually: 1 }
const PREVIEW_PAYS = 12
const todayStr = () => formatDate(new Date())
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })

export default function AddSheet({ accountId, userId, onClose }: { accountId: string; userId: string; onClose: () => void }) {
  const { activeAccount } = useAccount()
  const toast = useToast()
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const t = todayStr()

  const [rows, setRows] = useState<ForecastResult | null>(null)
  const [type, setType] = useState<Type>('fixed')
  const [name, setName] = useState('')
  const [amt, setAmt] = useState('')
  const [period, setPeriod] = useState<'weekly' | 'fortnightly' | 'monthly'>('fortnightly')
  const [sched, setSched] = useState<Schedule>(newSchedule(t))
  const [setAside, setSetAside] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadForecast(accountId, floorCents, { numCycles: PREVIEW_PAYS + 1 }).then(f => {
      setRows(f)
      // Budgets are entered in the period you think in; start with how you're paid.
      const rule = cycleRuleOn(f.incomeRows, t)
      if (rule.frequency === 'weekly' || rule.frequency === 'fortnightly' || rule.frequency === 'monthly') setPeriod(rule.frequency)
    }).catch(() => setRows(null))
  }, [accountId])

  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const payDates = rows ? rows.cycles.slice(1, 4).map(c => c.startDate) : []
  const rule = ruleOf(sched)

  // The new item as a row, so the forecast can include it.
  function newRow(): any {
    if (type === 'income') return {
      id: '__new', name: name || 'New income', frequency: rule.frequency, every_n: rule.everyN, anchor_date: rule.anchorDate,
      end_date: rule.endDate, is_primary: false, is_potential: false, is_active: true,
      income_amount_versions: [{ effective_from: rule.anchorDate, amount_cents: cents }], income_schedule_versions: [],
    }
    const budget = type === 'budget'
    return {
      id: '__new', name: name || 'New expense', mode: budget ? 'budget' : type === 'estimate' ? 'variable' : 'fixed',
      frequency: budget ? period : rule.frequency, every_n: budget ? 1 : rule.everyN,
      anchor_date: budget ? t : rule.anchorDate, end_date: budget ? null : rule.endDate, is_active: true,
      expense_amount_versions: [{ effective_from: budget ? t : rule.anchorDate, amount_cents: cents }],
      expense_schedule_versions: [], bnpl_missed_payments: [],
    }
  }
  const withNew = (): ForecastResult | null => !rows ? null : type === 'income'
    ? { ...rows, incomeRows: [...rows.incomeRows, newRow()] }
    : { ...rows, expenseRows: [...rows.expenseRows, newRow()] }

  const ready = !!rows && cents > 0
  const changed = ready ? withNew()! : null
  const now = rows ? rows.cycles.slice(0, PREVIEW_PAYS).map(c => c.committedClosingBalanceCents) : []
  const after = changed ? projectFromRows(changed, floorCents, PREVIEW_PAYS + 1).slice(0, PREVIEW_PAYS).map(c => c.committedClosingBalanceCents) : []
  const st = after.length ? previewStats(now, after, floorCents) : null
  const paydays = rows ? rows.cycles.slice(0, PREVIEW_PAYS).map(c => shift(c.endDate, 1)) : []

  // Set money aside for it? Only when putting money away would actually keep
  // that payday above the floor: the same test as Journey 4's prompts.
  const prompt = changed && type !== 'income' && type !== 'budget'
    ? billPromptsFromRows(changed, floorCents, PREVIEW_PAYS).find(p => p.expenseId === '__new' && p.setAside)
    : undefined

  const ticks = rows && type !== 'budget' ? nextDates(sched, sched.first, 40).flatMap(d => {
    const i = rows.cycles.findIndex(c => d >= c.startDate && d <= c.endDate)
    if (i < 0 || i >= PREVIEW_PAYS) return []
    const c = rows.cycles[i]
    const len = (parseDate(c.endDate).getTime() - parseDate(c.startDate).getTime()) / 864e5 + 1
    return [i - 1 + ((parseDate(d).getTime() - parseDate(c.startDate).getTime()) / 864e5 + 0.5) / len]
  }) : []

  const paysPerYear = rows ? (PER_YEAR[cycleRuleOn(rows.incomeRows, t).frequency] ?? 26.09) : 26.09
  const perPay = type === 'budget' ? Math.round(cents * (PER_YEAR[period] ?? 26.09) / paysPerYear) : 0

  async function save() {
    if (!ready || !name.trim() || busy) return
    setBusy(true)
    try {
      const nm = name.trim()
      if (type === 'income') {
        const row = await addIncomeSource(accountId, userId, {
          name: nm, frequency: rule.frequency, anchorDate: rule.anchorDate, amountCents: cents,
          isPotential: false, everyN: rule.everyN, endDate: rule.endDate,
        })
        toast(`${nm} added`, { undo: async () => { await deactivateIncomeSource(row.id); notifyDataChanged() } })
      } else {
        const budget = type === 'budget'
        const row = await addExpense(accountId, userId, {
          name: nm, mode: budget ? 'budget' : type === 'estimate' ? 'variable' : 'fixed',
          frequency: budget ? period : rule.frequency, anchorDate: budget ? t : rule.anchorDate,
          amountCents: cents, everyN: budget ? 1 : rule.everyN, endDate: budget ? null : rule.endDate,
        })
        const pot = setAside && prompt ? await createBillPot(accountId, { expense_id: row.id, name: nm, start_cycle_start: rows!.cycles[0].startDate }) : null
        toast(pot ? `${nm} added · setting money aside` : `${nm} added`, { undo: async () => {
          if (pot) await deleteSavingsGoal(pot.id)
          await deactivateExpense(row.id)
          notifyDataChanged()
        } })
      }
      notifyDataChanged()
      onClose()
    } catch (e: any) { alert('Could not add it: ' + e.message) }
    finally { setBusy(false) }
  }

  const once = type !== 'budget' && sched.how === 'once'
  return (
    <>
      <div className="rw-sh-h">
        <div className="rw-sheet-title">Add</div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <Segmented value={type} onChange={v => { setType(v); setSetAside(false) }} options={[
        { value: 'fixed', label: 'Fixed' }, { value: 'estimate', label: 'Estimate' },
        { value: 'budget', label: 'Budget' }, { value: 'income', label: 'Income' }]} />
      <div className="rw-type-line"><Mark kind={type} />{TYPE_LINE[type]}</div>

      <TextField label="Name" value={name} onChange={setName} placeholder={PLACEHOLDER[type]} autoFocus />

      <div className="rw-amtrow">
        <span>{sym}</span>
        <input type="number" inputMode="decimal" placeholder="0" aria-label="Amount" value={amt} onChange={e => setAmt(e.target.value)} />
        {type === 'budget' && <em>a {PERIOD_WORD[period]}</em>}
      </div>

      {type === 'budget' ? (
        <>
          <div style={{ marginTop: 8 }}>
            <Segmented small value={period} onChange={setPeriod} options={[
              { value: 'weekly', label: 'a week' }, { value: 'fortnightly', label: 'a fortnight' }, { value: 'monthly', label: 'a month' }]} />
          </div>
          <div className="rw-hint">{cents
            ? <>About <b>{money(perPay)}</b> each pay. It's spread evenly across every pay, and adjusts on its own if how you're paid changes.</>
            : 'Pick the period you think in. It’s spread evenly across every pay.'}</div>
        </>
      ) : (
        <ScheduleFields value={sched} onChange={setSched} today={t} payDates={payDates} />
      )}

      {!rows ? <div className="rw-empty">Loading your forecast…</div>
        : !cents ? <div className="rw-empty">Enter an amount to see what it does to each payday.</div>
        : <Preview nowCents={now} newCents={after} payDates={paydays} floorCents={floorCents} money={money} ticks={ticks} />}

      {prompt?.setAside && (
        <div className="rw-sug">
          <div>
            <b>Set aside about {money(prompt.setAside.firstCycleCents)} each pay</b>
            <small>{prompt.setAside.cycles} pays until {short(prompt.dueDates[0])}. Spreads it so no payday takes the whole amount.</small>
          </div>
          <button type="button" role="switch" aria-checked={setAside} aria-label="Set money aside for it"
            className={`rw-switch${setAside ? ' on' : ''}`} onClick={() => setSetAside(s => !s)}><i /></button>
        </div>
      )}

      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={!ready || !name.trim() || busy} onClick={save}>
          Add {name.trim() || (type === 'income' ? 'income' : once ? 'one-off' : 'expense')}{st && st.level === 'under' && st.worse ? ' anyway' : ''}
        </button>
      </div>
    </>
  )
}
