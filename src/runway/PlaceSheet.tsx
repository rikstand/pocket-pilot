import { useState } from 'react'
import { updatePayee, mergePayee, unmergePayee, setPayeeArchived, deletePayeeIfUnused } from '../lib/repository'
import { reportError } from './Sheet'
import { TextField } from './controls'
import { useToast } from './toastContext'
import { HistoryBars } from './ItemsPage'
import type { PlaceStats } from './places'

/**
 * One place (Journey 11, mock pp-release8-mockB): its last 6 cycles, so far /
 * usual / per visit, its name and usual budget, then merge, archive or restore,
 * and delete (only when nothing was ever spent there). The content of a sheet:
 * the Places page and a budget's Places tab each put it in their own.
 */
export interface Budget { id: string; name: string }

export default function PlaceSheet({ payee, payees, budgets, stats, money, cents, backTo, onBack, onClose, onChanged }: {
  payee: any
  payees: any[]                    // every place in use, for Merge
  budgets: Budget[]
  stats: PlaceStats
  money: (c: number) => string     // whole dollars
  cents: (c: number) => string     // with cents, as spend is shown
  backTo?: string                  // the budget this was opened from
  onBack?: () => void
  onClose: () => void
  onChanged: () => void            // reload the list behind
}) {
  const toast = useToast()
  const [name, setName] = useState<string>(payee.name)
  const [usual, setUsual] = useState<string | null>(payee.default_expense_id ?? null)
  const [merging, setMerging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nameErr, setNameErr] = useState('')
  const usualName = budgets.find(b => b.id === payee.default_expense_id)?.name
  const changed = (!!name.trim() && name.trim() !== payee.name) || usual !== (payee.default_expense_id ?? null)
  const total = stats.hist.reduce((s, v) => s + v, 0)

  async function act(f: () => Promise<void>, fail: string) {
    setBusy(true)
    try { await f() } catch (e: any) {
      // A name already in use isn't a failed save: say so by the name, where it can be fixed.
      if (e?.code === '23505') setNameErr(`There’s already a place called ${name.trim()}. Merge into it instead.`)
      else reportError(fail, e)
    } finally { setBusy(false) }
  }
  const save = () => act(async () => {
    await updatePayee(payee.id, { name: name.trim(), default_expense_id: usual })
    onChanged(); onClose(); toast(`${name.trim()} saved`)
  }, 'That didn’t save.')
  const merge = (into: any) => act(async () => {
    const moved = await mergePayee(payee.id, into.id)
    onChanged(); onClose()
    toast(`${payee.name} merged into ${into.name}`, { lasting: true, undo: async () => { await unmergePayee(payee.id, moved); onChanged() } })
  }, 'That didn’t merge.')
  const archive = () => act(async () => {
    const on = !payee.archived
    await setPayeeArchived(payee.id, on)
    onChanged(); onClose()
    if (on) toast(`${payee.name} archived`, { lasting: true, undo: async () => { await setPayeeArchived(payee.id, false); onChanged() } })
    else toast(`${payee.name} restored`)
  }, payee.archived ? 'That wasn’t restored.' : 'That wasn’t archived.')
  const remove = () => act(async () => {
    const gone = await deletePayeeIfUnused(payee.id)
    if (!gone) { reportError('Something was spent there after all, so it can’t be deleted. Archive it instead.', null); return }
    onChanged(); onClose(); toast(`${payee.name} deleted`)
  }, 'That wasn’t deleted.')

  const head = (
    <div className="rw-sh-h">
      <div>
        {backTo && <button type="button" className="rw-back rw-pl-back" onClick={onBack}>‹ {backTo}</button>}
        <h2 className="rw-sheet-title">{payee.name}</h2>
        <div className="rw-sd">{usualName ? `Usually ${usualName}` : 'No usual budget'}{payee.archived ? ' · archived' : ''}</div>
      </div>
      <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
    </div>
  )

  if (merging) {
    const sameFirst = (x: any) => x.default_expense_id === payee.default_expense_id ? 0 : 1
    const others = payees.filter(x => x.id !== payee.id && !x.archived)
      .sort((a, b) => sameFirst(a) - sameFirst(b) || a.name.localeCompare(b.name))
    return <>
      {head}
      <div className="rw-lab">Merge {payee.name} into</div>
      <div className="rw-hint rw-pl-hint0">Its spend moves across and {payee.name} is archived.</div>
      <div className="rw-group flush">
        {others.map(x => (
          <button key={x.id} type="button" className="rw-row" disabled={busy} onClick={() => merge(x)}>
            <div className="rw-tx"><div className="rw-row-name">{x.name}</div>
              <div className="rw-sub">{budgets.find(b => b.id === x.default_expense_id)?.name ?? 'No usual budget'}</div></div>
            <span className="rw-chev">›</span>
          </button>
        ))}
      </div>
      <div className="rw-ctas"><button type="button" className="rw-cta sec rw-pl-wide" onClick={() => setMerging(false)}>Back</button></div>
    </>
  }

  return <>
    {head}
    {total > 0 ? <>
      <div className="rw-card rw-pl-chart">
        <div className="rw-pv-k"><span>Last {stats.hist.length} cycles here</span></div>
        <HistoryBars values={stats.hist} line={stats.usual ?? 0} lineLabel={`usual ${money(stats.usual ?? 0)}`} money={money} />
      </div>
      <div className="rw-tiles">
        <div className="rw-tile"><div className="k">So far</div><div className="v">{cents(stats.soFar)}</div><div className="d">this cycle</div></div>
        <div className="rw-tile"><div className="k">Usual</div><div className="v">{money(stats.usual ?? 0)}</div><div className="d">a cycle</div></div>
        <div className="rw-tile"><div className="k">Per visit</div><div className="v">{money(stats.perVisit ?? 0)}</div>
          <div className="d">{fmtVisits(stats.visits)} a cycle</div></div>
      </div>
    </> : <div className="rw-card rw-sd">{stats.soFar ? `${cents(stats.soFar)} so far this cycle. No earlier cycles yet.` : 'No spend here yet.'}</div>}

    <div className="rw-card">
      <div className="rw-lab rw-lab-0">Name</div>
      <TextField label="Name" value={name} onChange={v => { setName(v); setNameErr('') }} />
      {nameErr && <div className="rw-pl-err" role="alert">{nameErr}</div>}
      <div className="rw-lab">Usual budget</div>
      <div className="rw-chips">
        {budgets.map(b => <button key={b.id} type="button" className={usual === b.id ? 'on' : ''} onClick={() => setUsual(usual === b.id ? null : b.id)}>{b.name}</button>)}
      </div>
      <div className="rw-hint">Shown first when you log to that budget.</div>
    </div>

    <div className="rw-group flush rw-pl-acts">
      <button type="button" className="rw-row" disabled={busy} onClick={() => setMerging(true)}>
        <div className="rw-tx"><div className="rw-row-name">Merge into another place</div><div className="rw-sub">For duplicates, like a misspelling</div></div>
        <span className="rw-chev">›</span>
      </button>
      <button type="button" className="rw-row" disabled={busy} onClick={archive}>
        <div className="rw-tx"><div className="rw-row-name">{payee.archived ? 'Restore' : 'Archive'}</div>
          <div className="rw-sub">{payee.archived ? 'Back in the list when logging' : 'Hidden when logging · history kept'}</div></div>
      </button>
      {stats.ever
        ? <div className="rw-row static"><div className="rw-tx"><div className="rw-row-name rw-muted">Delete</div><div className="rw-sub">Has spend, so merge or archive instead</div></div></div>
        : <button type="button" className="rw-row" disabled={busy} onClick={remove}>
            <div className="rw-tx"><div className="rw-row-name rw-danger">Delete</div><div className="rw-sub">Nothing was ever spent here</div></div>
          </button>}
    </div>

    <div className="rw-ctas">
      {changed
        ? <><button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
            <button type="button" className="rw-cta" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>
        : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
    </div>
  </>
}

function fmtVisits(v: number[]) {
  const a = v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0
  const r = Math.round(a * 10) / 10
  return `${String(r).replace(/\.0$/, '')} visit${r === 1 ? '' : 's'}`
}
