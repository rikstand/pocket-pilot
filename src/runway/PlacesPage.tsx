import { useEffect, useMemo, useState } from 'react'
import { useAccount } from '../lib/AccountContext'
import { getAllPayees, setPayeeArchived } from '../lib/repository'
import { loadForecast, budgetsInCycle } from '../lib/forecast'
import { moneyFormatter } from '../lib/money'
import { useDataChanged, notifyDataChanged } from '../lib/dataEvents'
import Sheet, { reportError } from './Sheet'
import SheetGuard from './SheetGuard'
import { TextField } from './controls'
import { useToast } from './toastContext'
import { LoadingMark } from './Welcome'
import PlaceSheet, { type Budget } from './PlaceSheet'
import { closedWindows, placeStats, type Window } from './places'

/** More › Places (Journey 11, release 8b): every place across all budgets, then Archived. */
export interface PlacesData { payees: any[]; entries: any[]; closed: Window[]; current: Window; budgets: Budget[] }

export async function loadPlaces(accountId: string, floorCents: number): Promise<PlacesData> {
  const [f, payees] = await Promise.all([loadForecast(accountId, floorCents, { numCycles: 1 }), getAllPayees(accountId)])
  const c = f.cycles[0]
  const current = c ? { start: c.startDate, end: c.endDate } : { start: '9999-12-31', end: '9999-12-31' }
  return {
    payees: payees ?? [],
    entries: f.budgetSpendRows ?? [],
    closed: closedWindows(f.storedCycles ?? []),
    current,
    budgets: c ? budgetsInCycle(f, c.startDate, c.endDate).map(b => ({ id: b.id, name: b.name })) : [],
  }
}

export default function PlacesPage() {
  const { activeAccount: a } = useAccount()
  const toast = useToast()
  const [data, setData] = useState<PlacesData | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const fmt = moneyFormatter(a?.currency_code)
  const money = (c: number) => fmt(c, false), cents = (c: number) => fmt(c, true)

  async function load() {
    if (!a) return
    try { setData(await loadPlaces(a.id, a.safety_floor_cents)) } catch (e) { reportError('Places didn’t load.', e) }
  }
  useEffect(() => { load() }, [a?.id])
  useDataChanged(load)

  const rows = useMemo(() => {
    if (!data) return []
    const term = q.trim().toLowerCase()
    return data.payees.filter(p => !p.archived && (!term || p.name.toLowerCase().includes(term)))
      .map(p => ({ p, s: placeStats(p.id, data.entries, data.closed, data.current) }))
      .sort((x, y) => y.s.soFar - x.s.soFar || (y.s.usual ?? 0) - (x.s.usual ?? 0) || x.p.name.localeCompare(y.p.name))
  }, [data, q])

  if (!a) return null
  if (!data) return <LoadingMark />
  const archived = data.payees.filter(p => p.archived)
  const budgetName = (id: string | null) => data.budgets.find(b => b.id === id)?.name ?? 'No usual budget'
  const place = data.payees.find(p => p.id === open)

  async function restore(p: any) {
    try { await setPayeeArchived(p.id, false); notifyDataChanged(); toast(`${p.name} restored`) }
    catch (e) { reportError('That wasn’t restored.', e) }
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head"><h1 className="rw-page-title">Places</h1></div>
      <p className="rw-page-sub">Every place, across all budgets.</p>
      {data.payees.length > 0 && <div className="rw-pl-search"><TextField label="Search places" value={q} onChange={setQ} placeholder="Search places" /></div>}
      {data.payees.length === 0
        ? <div className="rw-empty">No places yet. Add one when you log spend.</div>
        : <>
          <div className="rw-section rw-pl-cols"><span>This cycle so far</span><span>Usual a cycle</span></div>
          <div className="rw-group">
            {rows.map(({ p, s }) => (
              <button key={p.id} type="button" className="rw-row" onClick={() => setOpen(p.id)}>
                <div className="rw-tx"><div className="rw-row-name">{p.name}</div>
                  <div className="rw-sub">{budgetName(p.default_expense_id)} · {s.soFar ? `${cents(s.soFar)} so far` : 'none yet'}</div></div>
                <div className="rw-am rw-pl-usual">{s.usual ? money(s.usual) : '–'}</div>
              </button>
            ))}
            {rows.length === 0 && <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">No place matches “{q.trim()}”.</div></div></div>}
          </div>
        </>}
      {archived.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-section">Archived</div>
        <div className="rw-group">
          {archived.map(p => (
            <div key={p.id} className="rw-row static">
              <button type="button" className="rw-tx rw-pl-open" onClick={() => setOpen(p.id)}>
                <div className="rw-row-name rw-muted">{p.name}</div><div className="rw-sub">Hidden when logging · history kept</div>
              </button>
              <button type="button" className="rw-mini" onClick={() => restore(p)}>Restore</button>
            </div>
          ))}
        </div>
      </>}
      {place && (
        <SheetGuard onClose={() => setOpen(null)}>
          <Sheet onClose={() => setOpen(null)}>
            <div className="rw-grab" />
            <PlaceSheet key={place.id} payee={place} payees={data.payees} budgets={data.budgets}
              stats={placeStats(place.id, data.entries, data.closed, data.current)}
              money={money} cents={cents} onClose={() => setOpen(null)} onChanged={() => notifyDataChanged()} />
          </Sheet>
        </SheetGuard>
      )}
    </div>
  )
}
