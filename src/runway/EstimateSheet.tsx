import { useState } from 'react'
import Sheet, { reportError } from './Sheet'
import Preview from './Preview'
import { Segmented } from './controls'
import { HistoryBars } from './ItemsPage'
import { previewFor } from './sheetPreview'
import { toEngineExpenses, type ForecastResult } from '../lib/forecast'
import { setExpenseOverride, clearExpenseOverride, setExpenseAmountFrom, deleteExpenseAmountVersion } from '../lib/repository'
import { versionForDate } from '../lib/versions'
import { occurrencesOf, scheduleOn } from '../engine/index'
import { parseDate } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { dateLocale } from '../lib/dateFormat'

/**
 * Confirm an estimate (release 7): what it really was this cycle, and, if you
 * choose, the estimate from now on. Replaces the old look's Confirm sheet.
 *
 * Stored as before: this cycle's figure is the cycle's own amount
 * (expense_overrides); "Also the estimate" adds a dated amount from this
 * cycle. The preview shows only once the amount changes.
 */
const short = (d: string) => parseDate(d).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
const HOW: Record<string, string> = { daily: 'daily', weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', annually: 'yearly', once: 'one-off' }

export default function EstimateSheet({ row, rows, cycleIdx, floorCents, accountId, today, money, onClose }: {
  row: any; rows: ForecastResult; cycleIdx: number; floorCents: number; accountId: string; today: string
  money: (c: number) => string; onClose: () => void
}) {
  const toast = useToast()
  const cycle = rows.cycles[cycleIdx]
  const eng = toEngineExpenses([row])[0]
  const occs = occurrencesOf(eng, cycle.startDate, cycle.endDate)
  const usual = occs.reduce((t: number, d: string) => t + (versionForDate(row.expense_amount_versions, d)?.amount_cents ?? 0), 0)
  const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === row.id && o.cycle_start === cycle.startDate) ?? null
  const current = ov ? ov.amount_cents : usual
  const due = !!occs.length && occs[0] <= today
  // The real figures confirmed in earlier cycles, as on the expense's own sheet.
  const history: number[] = (rows.expenseOverrideRows ?? [])
    .filter((o: any) => o.expense_id === row.id && o.cycle_start < cycle.startDate)
    .sort((a: any, b: any) => a.cycle_start.localeCompare(b.cycle_start)).slice(-6).map((o: any) => o.amount_cents)
  const usually = history.length >= 3 ? Math.round(history.reduce((a, b) => a + b, 0) / history.length / 100) * 100 : null
  const last = history.length ? history[history.length - 1] : null
  const s = scheduleOn(eng, cycle.startDate), how = (s.everyN ?? 1) > 1 ? `every ${s.everyN}` : HOW[s.frequency] ?? s.frequency

  const [amt, setAmt] = useState(String(current / 100))
  const [scope, setScope] = useState<'once' | 'always'>('once')
  const [busy, setBusy] = useState(false)
  const cents = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const per = Math.round(cents / Math.max(1, occs.length))
  const always = scope === 'always' && cents !== usual
  const changed = cents !== current || always
  // Confirming saves even an unchanged figure: it marks the estimate as done.
  const saves = due ? cents > 0 : changed

  function withChange(): ForecastResult {
    let r: ForecastResult = { ...rows, expenseOverrideRows: [
      ...(rows.expenseOverrideRows ?? []).filter((o: any) => !(o.expense_id === row.id && o.cycle_start === cycle.startDate)),
      ...(cents === usual && !due && !always ? [] : [{ expense_id: row.id, cycle_start: cycle.startDate, amount_cents: cents }]),
    ] }
    if (always) r = { ...r, expenseRows: r.expenseRows.map((x: any) => x.id !== row.id ? x
      : { ...x, expense_amount_versions: [...(x.expense_amount_versions ?? []), { effective_from: cycle.startDate, amount_cents: per, created_at: '9999' }] }) }
    return r
  }
  const pv = previewFor(rows, floorCents, cycleIdx, changed ? withChange() : null, money)

  const chips: [string, number][] = [[`Estimate ${money(usual)}`, usual]]
  if (usually != null && usually !== usual) chips.push([`Usually ${money(usually)}`, usually])
  if (last != null && last !== usually && last !== usual) chips.push([`Last ${money(last)}`, last])

  async function save() {
    if (!saves || busy) return
    setBusy(true)
    try {
      const start = cycle.startDate
      const prevV = (row.expense_amount_versions ?? []).find((v: any) => v.effective_from === start) ?? null
      if (!due && cents === usual && !always) await clearExpenseOverride(row.id, start)
      else await setExpenseOverride(row.id, accountId, start, cents)
      const written = always ? await setExpenseAmountFrom(row.id, accountId, start, per) : null
      toast(`${row.name}: ${money(cents)} ${due ? 'confirmed' : 'this cycle'}${always ? ', and the estimate from now on' : ''}`, { undo: async () => {
        if (ov) await setExpenseOverride(row.id, accountId, start, ov.amount_cents); else await clearExpenseOverride(row.id, start)
        if (written) { if (prevV) await setExpenseAmountFrom(row.id, accountId, start, prevV.amount_cents); else await deleteExpenseAmountVersion(written.id) }
        notifyDataChanged()
      } })
      notifyDataChanged()
      onClose()
    } catch (e: any) { reportError('That didn’t save.', e) }
    finally { setBusy(false) }
  }

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h">
        <div className="rw-sh-t"><span className="rw-bt-dot" style={{ background: 'var(--rw-t-est)' }} aria-hidden="true" />
          <div><h2 className="rw-sheet-title">{row.name}</h2>
            <div className="rw-sd">Estimate {money(usual)}{occs.length ? ` · ${short(occs[0])}` : ''} · {how}</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <div className="rw-card rw-sl-card">
        <div className="rw-pv-k"><span>{due ? 'What it really was' : 'What it’ll be'}</span>{cents !== usual && <span>estimate {money(usual)}</span>}</div>
        <div className="rw-amt"><span>$</span><input type="number" inputMode="decimal" aria-label={`${row.name}, real amount`}
          value={amt} onChange={e => setAmt(e.target.value)} /></div>
        {chips.length > 1 && <div className="rw-snaps">{chips.map(([l, v]) =>
          <button key={l} type="button" className={cents === v ? 'on' : ''} onClick={() => setAmt(String(v / 100))}>{l}</button>)}</div>}
        {cents !== usual && <div style={{ marginTop: 10 }}><Segmented value={scope} onChange={setScope}
          options={[{ value: 'once', label: 'This cycle' }, { value: 'always', label: 'Also the estimate' }]} /></div>}
        {cents !== usual && <div className="rw-hint" style={{ marginTop: 6 }}>{scope === 'once' ? 'Other cycles keep the estimate.'
          : `${row.name} is estimated at ${money(per)}${occs.length > 1 ? ' each time' : ''} from now on.`}</div>}
      </div>

      {pv.after.length > 0 && <Preview nowCents={pv.now} newCents={pv.after} payDates={pv.payDates} floorCents={floorCents}
        money={money} third={pv.third} tilesFirst />}

      {history.length > 0 && (
        <div className="rw-card">
          <div className="rw-pv-k"><span>Confirmed amounts, last {history.length}</span>
            <span>avg {money(history.reduce((a, b) => a + b, 0) / history.length)}</span></div>
          <HistoryBars values={history} line={usual} lineLabel={`estimate ${money(usual)}`} money={money} />
        </div>
      )}

      <div className="rw-ctas">
        {saves ? <>
          <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || !cents} onClick={save}>
            {due ? `Confirm ${money(cents)}` : `Use ${money(cents)}`}{always ? ' from now on' : ''}</button>
        </> : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}
