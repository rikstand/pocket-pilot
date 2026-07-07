import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import {
  getIncomeSources, getExpenses, getCycles,
  getWishlistItems, addWishlistItem, reorderWishlistItems,
  commitWishlistItem, uncommitWishlistItem, deleteWishlistItem,
} from './lib/repository'
import { useAccount } from './lib/AccountContext'
import { projectCycles } from './engine/index'

function fmt(cents: number, showCents = true) {
  const abs = Math.abs(cents)
  const n = abs / 100
  const str = showCents
    ? n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return (cents < 0 ? '−' : '') + '$' + str
}
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
}
function today() { return new Date().toISOString().split('T')[0] }

function resolveActive(items: any[], cycles: any[], floorCents: number) {
  const reserved = cycles.map(() => 0)
  const results: any[] = []
  let minStart = 0

  for (const item of items) {
    let clearedAt: number | null = null
    for (let i = minStart; i < cycles.length; i++) {
      const available = cycles[i].committedClosingBalanceCents - reserved[i]
      if (available - item.amount_cents >= floorCents) { clearedAt = i; break }
    }
    results.push({ ...item, clearedAt })
    if (clearedAt !== null) {
      for (let i = clearedAt; i < cycles.length; i++) reserved[i] += item.amount_cents
      minStart = clearedAt
    } else {
      minStart = cycles.length
    }
  }
  return results
}

export default function WishlistPage({ userId, accountId }: { userId: string; accountId: string }) {
  const { activeAccount } = useAccount()
  const [items,     setItems]     = useState<any[]>([])
  const [cycles,    setCycles]    = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [addOpen,   setAddOpen]   = useState(false)
  const [addName,   setAddName]   = useState('')
  const [addAmount, setAddAmount] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError,  setAddError]  = useState('')

  const [commitTarget,   setCommitTarget]   = useState<any>(null)
  const [commitSaving,   setCommitSaving]   = useState(false)
  const [uncommitTarget, setUncommitTarget] = useState<any>(null)
  const [uncommitSaving, setUncommitSaving] = useState(false)
  const [boughtTarget,   setBoughtTarget]   = useState<any>(null)
  const [boughtSaving,   setBoughtSaving]   = useState(false)

  const floorCents = activeAccount?.safety_floor_cents ?? 0

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [income, expenses, storedCycles, wishlist] = await Promise.all([
          getIncomeSources(accountId),
          getExpenses(accountId),
          getCycles(accountId),
          getWishlistItems(accountId),
        ])
        setItems(wishlist)

        const engineIncome = income.map((src: any) => {
          const v = (src.income_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
          return { id: src.id, name: src.name, frequency: src.frequency, anchorDate: src.anchor_date, amountCents: v?.amount_cents ?? 0, isPotential: src.is_potential ?? false }
        })
        const engineExpenses = expenses.map((exp: any) => {
          const versions = (exp.expense_amount_versions ?? []).map((v: any) => ({ amountCents: v.amount_cents, effectiveFrom: v.effective_from }))
          const latest = versions.sort((a: any, b: any) => a.effectiveFrom > b.effectiveFrom ? -1 : 1)[0]
          return { id: exp.id, name: exp.name, frequency: exp.frequency, anchorDate: exp.anchor_date, amountCents: latest?.amountCents ?? 0, amountVersions: versions, mode: exp.mode ?? 'fixed', endDate: exp.end_date ?? undefined }
        })

        const openCycles  = storedCycles.filter((c: any) => !c.is_closed)
        const projectFrom = openCycles[0] ?? storedCycles[storedCycles.length - 1]

        const projected = projectCycles({
          incomeSources: engineIncome,
          expenses: engineExpenses,
          openingBalanceCents: projectFrom?.opening_balance_cents ?? 0,
          startDate: projectFrom?.start_date ?? today(),
          numCycles: 6,
          safetyFloorCents: floorCents,
        })
        setCycles(projected)
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [accountId, reloadKey])

  function reload() { setReloadKey(k => k + 1) }

  if (loading) return <div className="scrollarea" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}><p style={{ color:'var(--mut)' }}>Loading…</p></div>
  if (error)   return <div className="scrollarea" style={{ padding:24 }}><p style={{ color:'var(--floor)' }}>{error}</p></div>

  const activeItems    = items.filter(i => i.status === 'active').sort((a, b) => a.rank - b.rank)
  const committedItems = items.filter(i => i.status === 'committed').sort((a, b) => a.rank - b.rank)
  const resolved       = resolveActive(activeItems, cycles, floorCents)

  const committedWithRisk = committedItems.map(item => {
    const cycle = cycles.find(c => c.startDate === item.committed_cycle_start)
    const atRisk = cycle ? cycle.committedClosingBalanceCents < floorCents : false
    const shortfallCents = cycle ? floorCents - cycle.committedClosingBalanceCents : 0
    return { ...item, cycle, atRisk, shortfallCents }
  })

  function openAdd() { setAddName(''); setAddAmount(''); setAddError(''); setAddOpen(true) }
  async function saveAdd() {
    const cents = Math.round(parseFloat(addAmount || '0') * 100)
    if (!addName.trim() || !cents) { setAddError('Name and cost are required.'); return }
    setAddSaving(true); setAddError('')
    try {
      await addWishlistItem(accountId, addName.trim(), cents)
      setAddOpen(false); reload()
    } catch (e: any) { setAddError(e.message) }
    finally { setAddSaving(false) }
  }

  async function moveItem(item: any, dir: -1 | 1) {
    const idx = activeItems.findIndex(i => i.id === item.id)
    const swapIdx = idx + dir
    if (swapIdx < 0 || swapIdx >= activeItems.length) return
    const a = activeItems[idx], b = activeItems[swapIdx]
    try {
      await reorderWishlistItems([{ id: a.id, rank: b.rank }, { id: b.id, rank: a.rank }])
      reload()
    } catch (e: any) { alert('Could not reorder: ' + e.message) }
  }

  async function doMarkBought() {
    if (!boughtTarget) return
    setBoughtSaving(true)
    try {
      await deleteWishlistItem(boughtTarget.id)
      setBoughtTarget(null); reload()
    } catch (e: any) { alert('Could not remove item: ' + e.message) }
    finally { setBoughtSaving(false) }
  }

  function openCommit(resolvedItem: any) {
    if (resolvedItem.clearedAt === null) return
    setCommitTarget(resolvedItem)
  }

  async function doCommit() {
    if (!commitTarget) return
    const cycle = cycles[commitTarget.clearedAt]
    setCommitSaving(true)
    try {
      const { data: exp, error: e1 } = await supabase
        .from('expenses')
        .insert({
          profile_id: userId,
          account_id: accountId,
          name: commitTarget.name,
          frequency: 'once',
          anchor_date: cycle.startDate,
          mode: 'fixed',
        })
        .select().single()
      if (e1) throw e1
      const { error: e2 } = await supabase
        .from('expense_amount_versions')
        .insert({ expense_id: exp.id, amount_cents: commitTarget.amount_cents, effective_from: cycle.startDate })
      if (e2) throw e2
      await commitWishlistItem(commitTarget.id, exp.id, cycle.startDate)
      setCommitTarget(null); reload()
    } catch (e: any) { alert('Could not commit: ' + e.message) }
    finally { setCommitSaving(false) }
  }

  async function doUncommit() {
    if (!uncommitTarget) return
    setUncommitSaving(true)
    try {
      await uncommitWishlistItem(uncommitTarget.id, uncommitTarget.committed_expense_id)
      setUncommitTarget(null); reload()
    } catch (e: any) { alert('Could not uncommit: ' + e.message) }
    finally { setUncommitSaving(false) }
  }

  return (
    <>
      <div className="scrollarea">

        <div style={{ padding:'14px 20px 2px' }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--mut)' }}>Wishlist</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:22, letterSpacing:'-.02em', marginTop:4 }}>What you're saving toward</div>
        </div>

        {committedWithRisk.length > 0 && (
          <>
            <div className="wish-secttl">Committed</div>
            <div className="cards">
              {committedWithRisk.map(item => (
                <div key={item.id} className={`card${item.atRisk ? ' risk' : ''}`}>
                  <div className="ic wish">☆</div>
                  <div className="tx">
                    <div className="nm">
                      {item.name}
                      <span className={`chip ${item.atRisk ? 'risk' : 'committed'}`}>{item.atRisk ? 'at risk' : 'committed ✓'}</span>
                    </div>
                    <div className="dt">
                      {item.atRisk
                        ? <>committed to <b>{fmtDate(item.committed_cycle_start)}</b> — now {fmt(item.shortfallCents, false)} short</>
                        : <>committed to <b>{fmtDate(item.committed_cycle_start)}</b></>}
                    </div>
                    <div className="act-row">
                      <span className="act" style={{ color:'var(--floor)' }} onClick={() => setUncommitTarget(item)}>uncommit</span>
                    </div>
                  </div>
                  <div className="vl">{fmt(item.amount_cents, false)}</div>
                  <div className="check-btn" onClick={() => setBoughtTarget(item)}>✓</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="wish-secttl">Active</div>
        <div className="cards">
          {resolved.length === 0 && (
            <div className="skipnote" style={{ margin:'0 16px' }}>Nothing on your wishlist yet.</div>
          )}
          {resolved.map((item, idx) => {
            const status = item.clearedAt === null ? 'never' : item.clearedAt === 0 ? 'now' : 'soon'
            const label  = item.clearedAt === null ? 'unresolved' : item.clearedAt === 0 ? 'now' : 'soon'
            return (
              <div key={item.id} className="card">
                <div className="reorder-btns">
                  <button disabled={idx === 0} onClick={() => moveItem(item, -1)}>↑</button>
                  <button disabled={idx === resolved.length - 1} onClick={() => moveItem(item, 1)}>↓</button>
                </div>
                <div className="ic wish">☆</div>
                <div className="tx">
                  <div className="nm">{item.name}<span className={`chip ${status}`}>{label}</span></div>
                  <div className="dt">
                    {item.clearedAt === null
                      ? 'beyond your current forecast'
                      : <>clear by <b>{fmtDate(cycles[item.clearedAt].startDate)}</b></>}
                  </div>
                  <div className="act-row">
                    {item.clearedAt !== null && (
                      <span className="act" onClick={() => openCommit(item)}>commit →</span>
                    )}
                  </div>
                </div>
                <div className="vl">{fmt(item.amount_cents, false)}</div>
                <div className="check-btn" onClick={() => setBoughtTarget(item)}>✓</div>
              </div>
            )
          })}
        </div>

        <div style={{ padding:'14px 16px 24px' }}>
          <button className="addbtn" onClick={openAdd}>+ Add wishlist item</button>
        </div>

      </div>

      {/* ── add item ── */}
      {addOpen && (
        <div className="ov" onClick={() => setAddOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setAddOpen(false)}>×</button>
            <div className="grab" />
            <h3>Add wishlist item</h3>
            <p className="sd">Just a name and a cost — nothing here touches your forecast until you commit it.</p>
            <div className="field">
              <label>Item</label>
              <div className="inrow"><input type="text" value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. Weekend trip" /></div>
            </div>
            <div className="field">
              <label>Cost</label>
              <div className="inrow"><span className="pre">$</span><input type="number" inputMode="decimal" value={addAmount} onChange={e => setAddAmount(e.target.value)} placeholder="0" /></div>
            </div>
            {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{addError}</p>}
            <div className="navrow">
              <button onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="pri" onClick={saveAdd} style={{ opacity:addSaving?0.6:1 }}>{addSaving ? 'Saving…' : 'Add to wishlist'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── commit confirm ── */}
      {commitTarget && (
        <div className="ov" onClick={() => setCommitTarget(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setCommitTarget(null)}>×</button>
            <div className="grab" />
            <h3>Commit {commitTarget.name.toLowerCase()}?</h3>
            <p className="sd">
              Adds {fmt(commitTarget.amount_cents, false)} as a real expense to the cycle starting{' '}
              {fmtDate(cycles[commitTarget.clearedAt]?.startDate)}. From then on it's part of your actual forecast, not a projection.
            </p>
            <div className="navrow">
              <button onClick={() => setCommitTarget(null)}>Cancel</button>
              <button className="pri" onClick={doCommit} style={{ opacity:commitSaving?0.6:1 }}>{commitSaving ? 'Committing…' : 'Commit'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── uncommit confirm ── */}
      {uncommitTarget && (
        <div className="ov" onClick={() => setUncommitTarget(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setUncommitTarget(null)}>×</button>
            <div className="grab" />
            <h3>Uncommit {uncommitTarget.name.toLowerCase()}?</h3>
            <p className="sd">
              Removes the {fmt(uncommitTarget.amount_cents, false)} expense from{' '}
              {fmtDate(uncommitTarget.committed_cycle_start)}. The item goes back to active and re-resolves against your current forecast.
            </p>
            <div className="navrow">
              <button onClick={() => setUncommitTarget(null)}>Keep committed</button>
              <button className="pri" style={{ background:'var(--floor)' }} onClick={doUncommit} disabled={uncommitSaving}>{uncommitSaving ? 'Uncommitting…' : 'Uncommit'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── bought confirm ── */}
      {boughtTarget && (
        <div className="ov" onClick={() => setBoughtTarget(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setBoughtTarget(null)}>×</button>
            <div className="grab" />
            <h3>Mark {boughtTarget.name.toLowerCase()} as bought?</h3>
            <p className="sd">
              {boughtTarget.status === 'committed'
                ? <>Removes it from your wishlist. The {fmt(boughtTarget.amount_cents, false)} expense already committed to {fmtDate(boughtTarget.committed_cycle_start)} stays in your forecast — this is just closing out the wishlist entry.</>
                : <>Removes it from your wishlist. Nothing else changes, since it was never committed to a cycle.</>}
            </p>
            <div className="navrow">
              <button onClick={() => setBoughtTarget(null)}>Cancel</button>
              <button className="pri" onClick={doMarkBought} style={{ opacity:boughtSaving?0.6:1 }}>{boughtSaving ? 'Removing…' : 'Mark as bought'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}