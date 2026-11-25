import { useState } from 'react'
import Sheet, { reportError } from './Sheet'
import Preview from './Preview'
import { Segmented, DateChips, TextField } from './controls'
import { previewFor } from './sheetPreview'
import type { ForecastResult } from '../lib/forecast'
import {
  updateExpense, addExpenseAmount, deactivateExpense, reactivateExpense,
  updateIncomeSource, addIncomeAmount, deactivateIncomeSource, reactivateIncomeSource,
} from '../lib/repository'
import { versionForDate } from '../lib/versions'
import { parseDate } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'

/**
 * A one-off, money in or out (release 7): name, amount, date and, for money
 * coming in, whether it's certain. Replaces the old look's one-off sheet.
 *
 * An amount or date change is a new dated amount on the new date (never an
 * edit of the old row), so the history stays and the newest row wins.
 */
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })

export default function OneOffSheet({ row, isIncome, rows, cycleIdx, floorCents, accountId, today, payDates, money, onClose }: {
  row: any; isIncome: boolean; rows: ForecastResult; cycleIdx: number; floorCents: number; accountId: string
  today: string; payDates: string[]; money: (c: number) => string; onClose: () => void
}) {
  const toast = useToast()
  const vKey = isIncome ? 'income_amount_versions' : 'expense_amount_versions'
  const was = { name: row.name as string, date: row.anchor_date as string,
    cents: versionForDate(row[vKey], row.anchor_date)?.amount_cents ?? 0, certain: isIncome ? !row.is_potential : true }
  const [name, setName] = useState(was.name)
  const [amt, setAmt] = useState(String(was.cents / 100))
  const [date, setDate] = useState(was.date)
  const [sure, setSure] = useState<'no' | 'yes'>(was.certain ? 'yes' : 'no')
  const [busy, setBusy] = useState(false)
  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const certain = sure === 'yes'
  const moneyChanged = cents !== was.cents || date !== was.date || certain !== was.certain
  const changed = moneyChanged || name.trim() !== was.name

  function withChange(): ForecastResult {
    const edit = (x: any) => x.id !== row.id ? x : {
      ...x, anchor_date: date, is_potential: isIncome ? !certain : x.is_potential,
      [vKey]: [...(x[vKey] ?? []), { effective_from: date, amount_cents: cents, created_at: '9999' }],
    }
    return isIncome ? { ...rows, incomeRows: rows.incomeRows.map(edit) } : { ...rows, expenseRows: rows.expenseRows.map(edit) }
  }
  const pv = previewFor(rows, floorCents, cycleIdx, moneyChanged && cents ? withChange() : null, money)

  async function save() {
    if (!changed || busy || !name.trim() || !cents) return
    setBusy(true)
    try {
      if (isIncome) {
        await updateIncomeSource(row.id, { name: name.trim(), is_potential: !certain, anchor_date: date })
        if (cents !== was.cents || date !== was.date) await addIncomeAmount(row.id, cents, date)
      } else {
        await updateExpense(row.id, { name: name.trim(), anchor_date: date })
        if (cents !== was.cents || date !== was.date) await addExpenseAmount(row.id, accountId, cents, date)
      }
      toast(`${name.trim()}: saved`, { undo: async () => {
        if (isIncome) {
          await updateIncomeSource(row.id, { name: was.name, is_potential: !was.certain, anchor_date: was.date })
          if (cents !== was.cents || date !== was.date) await addIncomeAmount(row.id, was.cents, was.date)
        } else {
          await updateExpense(row.id, { name: was.name, anchor_date: was.date })
          if (cents !== was.cents || date !== was.date) await addExpenseAmount(row.id, accountId, was.cents, was.date)
        }
        notifyDataChanged()
      } })
      notifyDataChanged()
      onClose()
    } catch (e: any) { reportError('That didn’t save.', e) }
    finally { setBusy(false) }
  }

  async function remove() {
    if (busy) return
    setBusy(true)
    try {
      if (isIncome) await deactivateIncomeSource(row.id); else await deactivateExpense(row.id)
      toast(`${was.name} deleted`, { lasting: true, undo: async () => {
        if (isIncome) await reactivateIncomeSource(row.id); else await reactivateExpense(row.id)
        notifyDataChanged()
      } })
      notifyDataChanged()
      onClose()
    } catch (e: any) { reportError('That wasn’t deleted.', e) }
    finally { setBusy(false) }
  }

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div><h2 className="rw-sheet-title">{was.name}</h2>
        <div className="rw-sd">{isIncome ? 'Money coming in' : 'One-off expense'} · {short(was.date)}</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>

      <div className="rw-card">
        <div className="rw-lab" style={{ marginTop: 0 }}>Name</div>
        <TextField label="Name" value={name} onChange={setName} />
        <div className="rw-lab">Amount</div>
        <div className="rw-amt"><span>$</span><input type="number" inputMode="decimal" aria-label="Amount" value={amt} onChange={e => setAmt(e.target.value)} /></div>
        <div className="rw-lab">Date</div>
        <DateChips value={date} onChange={setDate} today={today} payDates={payDates} label="Date"
          otherMin={was.date < today ? was.date : undefined}
          tagFor={(d, i) => d === was.date ? 'as now' : i === 0 && d === today ? 'today' : 'payday'} />
        {isIncome && <>
          <div className="rw-lab">In the forecast</div>
          <Segmented value={sure} onChange={setSure} options={[{ value: 'no', label: 'Not certain yet' }, { value: 'yes', label: 'Certain' }]} />
          <div className="rw-hint" style={{ marginTop: 6 }}>{certain ? 'Counted on its date.' : 'Left out until it’s certain.'}</div>
        </>}
      </div>

      {pv.after.length > 0 && <Preview nowCents={pv.now} newCents={pv.after} payDates={pv.payDates} floorCents={floorCents}
        money={money} third={pv.third} tilesFirst />}

      <div className="rw-group flush" style={{ marginTop: 10 }}>
        <button type="button" className="rw-row" onClick={remove}>
          <div className="rw-tx"><div className="rw-row-name rw-danger">Delete this one-off</div></div></button>
      </div>

      <div className="rw-ctas">
        {changed ? <>
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || !name.trim() || !cents} onClick={save}>Save</button>
        </> : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}
