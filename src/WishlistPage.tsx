import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import {
  createSavingsGoal, setWishlistPaymentMethod,
  getSavingsGoals, getAllSavingsContributions, updateSavingsGoal, releaseWishlistItem,
  getWishlistItems, addWishlistItem,
  commitWishlistItem, uncommitWishlistItem, deleteWishlistItem,
} from './lib/repository'
import { loadForecast, cycleTickLabel, cycleDateLabel, baseYearOf } from './lib/forecast'
import { useAccount } from './lib/AccountContext'
import { moneyFormatter, currencySymbol } from './lib/money'
import { parseDate, formatDate } from './engine/dates'

// Show the year once a date is far enough out that day-and-month alone could
// be mistaken for a nearer one. "16 Sep" a year away looked earlier than
// "17 Sep" next week, which made an ordered list appear out of order.
function fmtDate(d: string) {
  const date = parseDate(d)
  const monthsAway = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)
  return date.toLocaleDateString('en-NZ', monthsAway > 10
    ? { day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' })
}
/** Local calendar date. toISOString() returns UTC — a day behind until noon NZ,
 *  which would have started the whole projection a cycle-boundary early. */
function today() { return formatDate(new Date()) }


/* ── planning a run of payments ──────────────────────────────────────
 * Shared by both options: spread a cost over n cycles starting at a given
 * one, and see what that does to the account cycle by cycle.
 */
function planPayments(totalCents: number, n: number, startAt: number) {
  const per = Math.floor(totalCents / n / 100) * 100
  const last = totalCents - per * (n - 1)
  const pays: number[] = []
  for (let k = 0; k < n; k++) pays[startAt + k] = (k === n - 1 ? last : per)
  return { pays, perCents: per, lastCents: last }
}

/* Closing balances chain, so a payment every cycle draws down the same
 * account repeatedly. Cycle 5 carries five payments, not one — which is why a
 * later cycle can break rather than the first. */
function balancesAfter(closings: number[], pays: number[]) {
  const out: number[] = []
  let cumulative = 0
  for (let i = 0; i < closings.length; i++) {
    cumulative += (pays[i] ?? 0)
    out.push(closings[i] - cumulative)
  }
  return out
}

/* Fewest cycles to spread over that keeps every cycle above the floor.
 * The app knows the forecast, so it can suggest what would work rather than
 * only reporting what does not. */
function fewestCyclesThatFit(
  closings: number[], totalCents: number, floorCents: number, from: number, max = 26
): number | null {
  for (let n = from; n <= max; n++) {
    const b = balancesAfter(closings, planPayments(totalCents, n, 0).pays)
    if (Math.min(...b) >= floorCents) return n
  }
  return null
}

/* Earliest start that keeps every cycle above the floor — waiting past a big
 * bill can turn a breach into comfort without changing the payments. */
function earliestStartThatFits(
  closings: number[], totalCents: number, n: number, floorCents: number, max = 8
): number | null {
  for (let s = 0; s <= max; s++) {
    const b = balancesAfter(closings, planPayments(totalCents, n, s).pays)
    if (Math.min(...b) >= floorCents) return s
  }
  return null
}

/* The cycle length is already implied by the projection, so read it from
 * there rather than expecting the account to carry a frequency column.
 * Anything unrecognised falls back to fortnightly, which is the engine's own
 * default. */
function cycleFrequencyFrom(cycles: any[]): 'weekly' | 'fortnightly' | 'monthly' | 'annually' {
  const first = cycles[0]
  if (!first?.startDate || !first?.endDate) return 'fortnightly'
  const days = Math.round(
    (parseDate(first.endDate).getTime() - parseDate(first.startDate).getTime()) / 86400000
  ) + 1
  if (days <= 7)   return 'weekly'
  if (days <= 15)  return 'fortnightly'
  if (days <= 31)  return 'monthly'
  return 'annually'
}

/* ── how reachable is each item on its own ───────────────────────────
 *
 * Replaces resolveActive(). That walked the list in rank order and reserved
 * money for each item against the ones below it, so the list answered "if I
 * bought all of these in order, when would each arrive". Nobody asked that
 * question, and it meant moving an item up the list changed whether it looked
 * possible.
 *
 * Each item is now judged on its own: if you set money aside for THIS one,
 * how long would it take? Anything already committed is a real expense in the
 * forecast, so it is accounted for either way.
 */

export type Reach = 'comfortable' | 'achievable' | 'stretch' | 'unreachable'

export interface ItemPlan {
  cycles: number | null      // shortest plan that stays above the floor
  perCycleCents: number
  finishIndex: number | null
  tightestCents: number
  reach: Reach
}

const MAX_PLAN_CYCLES = 26      // about a year of fortnights
const COMFORT_BUFFER_CENTS = 10000   // $100 of room above the floor

/**
 * The plan to show for this item.
 *
 * Shortest that fits, but "fits" means fits COMFORTABLY — with about $100 of
 * room above the floor. Picking the shortest plan that merely scrapes the floor
 * produced a nonsense ordering: a $1,500 item read as "a stretch" because two
 * big payments left $90 spare, while an $8,000 item read as "achievable"
 * because it was spread over 19 easy ones. Spreading the cheaper item over
 * three cycles instead of two makes it comfortable, and that is the plan worth
 * showing.
 *
 * If nothing comfortable fits inside a year, fall back to the shortest plan
 * that at least stays above the floor, and call it a stretch.
 */
export function planFor(item: any, cycles: any[], floorCents: number): ItemPlan {
  const closings = cycles.map(c => c.committedClosingBalanceCents)
  const cost = item.amount_cents
  const limit = Math.min(MAX_PLAN_CYCLES, Math.max(closings.length, 1))


  let fallback: ItemPlan | null = null

  for (let n = 1; n <= limit; n++) {
    const plan = planPayments(cost, n, 0)
    const bank = balancesAfter(closings, plan.pays)
    const tightest = bank.length ? Math.min(...bank) : 0

    // The floor is the floor. Judging items against "where things already are"
    // instead was tried and does not hold up: payments accumulate, so ANY plan
    // lowers the already-lowest cycle, and every item came back unreachable
    // anyway. The dip is real and worth saying — once, at the top of the page —
    // rather than being smuggled into each item's verdict.
    if (tightest < floorCents) continue

    const result: ItemPlan = {
      cycles: n,
      perCycleCents: plan.perCents,
      finishIndex: n - 1,
      tightestCents: tightest,
      reach: reachFor(n, tightest, floorCents),
    }

    // Comfortable room — this is the plan to show.
    if (tightest - floorCents >= COMFORT_BUFFER_CENTS) return result

    // Fits, but only just. Keep it in case nothing better turns up.
    if (!fallback) fallback = result
  }

  if (fallback) return fallback

  return {
    cycles: null,
    perCycleCents: Math.floor(cost / MAX_PLAN_CYCLES / 100) * 100,
    finishIndex: null,
    tightestCents: 0,
    reach: 'unreachable',
  }
}

/* Under 3 months comfortable, 3–9 achievable, 9–12 a stretch. A plan that only
 * scrapes the floor is a stretch however quick it is — finishing fast on fumes
 * is not comfortable. */
function reachFor(cycles: number, tightestCents: number, floorCents: number): Reach {
  const thin = tightestCents - floorCents < COMFORT_BUFFER_CENTS
  if (thin) return 'stretch'
  if (cycles <= 6)  return 'comfortable'
  if (cycles <= 19) return 'achievable'
  return 'stretch'
}

export const REACH_LABEL: Record<Reach, string> = {
  comfortable: 'comfortable',
  achievable:  'achievable',
  stretch:     'a stretch',
  unreachable: 'out of reach',
}

export const REACH_CHIP: Record<Reach, string> = {
  comfortable: 'reach-ok',
  achievable:  'reach-mid',
  stretch:     'reach-far',
  unreachable: 'reach-no',
}

export default function WishlistPage({ userId, accountId }: { userId: string; accountId: string }) {
  const { activeAccount } = useAccount()

  // Amounts follow the account's currency — see lib/money.ts
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const [items,     setItems]     = useState<any[]>([])
  const [goals,     setGoals]     = useState<any[]>([])
  const [contribs,  setContribs]  = useState<any[]>([])
  const [cycles,    setCycles]    = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [addOpen,   setAddOpen]   = useState(false)
  const [addName,   setAddName]   = useState('')
  const [addAmount, setAddAmount] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError,  setAddError]  = useState('')

  // how-to-pay sheet
  const [payTarget, setPayTarget] = useState<any>(null)
  const [payMode,   setPayMode]   = useState<'savings' | 'layby'>('savings')
  const [saveN,     setSaveN]     = useState(8)
  const [lbN,       setLbN]       = useState(4)
  const [lbStart,   setLbStart]   = useState(0)
  const [paySaving, setPaySaving] = useState(false)

  const [uncommitTarget, setUncommitTarget] = useState<any>(null)
  const [uncommitSaving, setUncommitSaving] = useState(false)
  const [boughtTarget,   setBoughtTarget]   = useState<any>(null)
  const [boughtSaving,   setBoughtSaving]   = useState(false)

  const floorCents = activeAccount?.safety_floor_cents ?? 0

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [wishlist, forecast, goalRows, contribRows] = await Promise.all([
          getWishlistItems(accountId),
          loadForecast(accountId, floorCents),
          getSavingsGoals(accountId),
          getAllSavingsContributions(accountId),
        ])
        setItems(wishlist)
        setGoals(goalRows ?? [])
        setContribs(contribRows ?? [])
        setCycles(forecast.cycles)
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
  const resolved       = activeItems.map(item => ({ ...item, plan: planFor(item, cycles, floorCents) }))

  // Said once here rather than repeated on every item. A forecast that already
  // dips is worth knowing about, but it is not a fact about your wishlist.
  const closingsAll  = cycles.map(c => c.committedClosingBalanceCents)
  const baseTightest = closingsAll.length ? Math.min(...closingsAll) : 0
  const baseDipIndex = closingsAll.indexOf(baseTightest)
  const forecastDips = baseTightest < floorCents

  /* A savings item has no expense and no committed cycle — its amount is
   * derived from the goal each cycle. Showing progress here is more use than
   * a date, and it is also what stops a second goal being started. */
  function goalFor(item: any) {
    if (!item.savings_goal_id) return null
    return goals.find((g: any) => g.id === item.savings_goal_id && g.status === 'active') ?? null
  }
  function savedFor(goal: any) {
    if (!goal) return 0
    if (goal.adjusted_total_cents != null) return goal.adjusted_total_cents
    return contribs.filter((c: any) => c.savings_goal_id === goal.id).length * goal.per_cycle_cents
  }

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
      await addWishlistItem(accountId,userId, addName.trim(), cents)
      setAddOpen(false); reload()
    } catch (e: any) { setAddError(e.message) }
    finally { setAddSaving(false) }
  }

  async function doMarkBought() {
    if (!boughtTarget) return
    const boughtGoal = goalFor(boughtTarget)
    setBoughtSaving(true)
    try {
      // Close the goal first, or the engine keeps setting money aside for
      // something already bought.
      if (boughtGoal) await updateSavingsGoal(boughtGoal.id, { status: 'completed' })
      await deleteWishlistItem(boughtTarget.id)
      setBoughtTarget(null); reload()
    } catch (e: any) { alert('Could not remove item: ' + e.message) }
    finally { setBoughtSaving(false) }
  }

  /* ── how to pay ─────────────────────────────────────────────────── */
  const closings = cycles.map(c => c.committedClosingBalanceCents)
  const cycleFrequency = cycleFrequencyFrom(cycles)
  const baseYear = baseYearOf(cycles)

  function openPay(item: any) {
    setPayTarget(item)
    setPayMode('savings')
    // Open on a plan that actually works, rather than one that warns.
    const fit = fewestCyclesThatFit(closings, item.amount_cents, floorCents, 2)
    setSaveN(fit ?? 8)
    setLbN(4)
    setLbStart(earliestStartThatFits(closings, item.amount_cents, 4, floorCents) ?? 0)
  }

  async function doStartSaving() {
    if (!payTarget) return
    const plan = planPayments(payTarget.amount_cents, saveN, 0)
    setPaySaving(true)
    try {
      // No expense row. The amount for each cycle is derived from the goal, the
      // same way a credit payment is derived from the balance.
      //
      // It used to create a recurring expense, which meant the forecast took
      // the money whether or not you actually set it aside — skip a cycle and
      // your real balance was higher than the app believed, while the progress
      // bar counted a contribution that never happened. Deriving it keeps the
      // forecast and the progress honest about the same thing, and the goal
      // stops on its own when the target is reached.
      const goal = await createSavingsGoal(accountId, {
        name: payTarget.name,
        target_cents: payTarget.amount_cents,
        per_cycle_cents: plan.perCents,
        cycles_total: saveN,
        start_cycle_start: cycles[0]?.startDate ?? today(),
        wishlist_item_id: payTarget.id,
      })

      await setWishlistPaymentMethod(payTarget.id, 'savings', goal.id)
      setPayTarget(null); reload()
    } catch (e: any) { alert('Could not start saving: ' + e.message) }
    finally { setPaySaving(false) }
  }

  async function doStartLayby() {
    if (!payTarget) return
    const plan = planPayments(payTarget.amount_cents, lbN, lbStart)
    const startDate = cycles[lbStart]?.startDate ?? today()
    const endDate   = cycles[Math.min(lbStart + lbN - 1, cycles.length - 1)]?.startDate ?? null
    setPaySaving(true)
    try {
      const { data: exp, error: e1 } = await supabase
        .from('expenses')
        .insert({
          profile_id: userId,
          account_id: accountId,
          name: payTarget.name + ' (lay-by)',
          frequency: cycleFrequency,
          anchor_date: startDate,
          mode: 'fixed',
          end_date: endDate,
        })
        .select().single()
      if (e1) throw e1

      const { error: e2 } = await supabase
        .from('expense_amount_versions')
        .insert({ expense_id: exp.id, amount_cents: plan.perCents, effective_from: startDate })
      if (e2) throw e2

      await commitWishlistItem(payTarget.id, exp.id, startDate)
      await setWishlistPaymentMethod(payTarget.id, 'layby', null)
      setPayTarget(null); reload()
    } catch (e: any) { alert('Could not start lay-by: ' + e.message) }
    finally { setPaySaving(false) }
  }

  // NOTE: the old single-payment commit is reachable again by calling
  // setCommitTarget(item). Left in place deliberately — see the note to Rick
  // about whether "buy outright" should be offered alongside the two plans.

  async function doUncommit() {
    if (!uncommitTarget) return
    setUncommitSaving(true)
    try {
      const goal = goalFor(uncommitTarget)
      if (goal) {
        // A savings goal has no expense to delete — cancel the goal, which
        // stops the engine taking anything further, and put the item back.
        await updateSavingsGoal(goal.id, { status: 'cancelled' })
        await releaseWishlistItem(uncommitTarget.id)
      } else {
        await uncommitWishlistItem(uncommitTarget.id, uncommitTarget.committed_expense_id)
      }
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
          <div className="wish-basis">
            Based on saving up. Lay-by or credit can be faster — tap an item to compare.
          </div>
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
                      {goalFor(item)
                        ? <span className="chip reach-ok">saving</span>
                        : <span className={`chip ${item.atRisk ? 'risk' : 'committed'}`}>{item.atRisk ? 'at risk' : 'committed ✓'}</span>}
                    </div>
                    <div className="dt">
                      {(() => {
                        const goal = goalFor(item)
                        if (goal) {
                          const saved = savedFor(goal)
                          const left = Math.max(0, goal.target_cents - saved)
                          return <>
                            <b>{fmt(saved, false)}</b> of {fmt(goal.target_cents, false)} set aside ·
                            {' '}{fmt(goal.per_cycle_cents, false)} a cycle · {fmt(left, false)} to go
                          </>
                        }
                        // Lay-by and older commitments still have a real cycle date.
                        if (!item.committed_cycle_start) return <>committed</>
                        return item.atRisk
                          ? <>committed to <b>{fmtDate(item.committed_cycle_start)}</b> — now {fmt(item.shortfallCents, false)} short</>
                          : <>committed to <b>{fmtDate(item.committed_cycle_start)}</b></>
                      })()}
                    </div>
                    <div className="act-row">
                      {goalFor(item) && (() => {
                        const goal = goalFor(item)!
                        const saved = savedFor(goal)
                        const pct = goal.target_cents > 0
                          ? Math.min(100, Math.round((saved / goal.target_cents) * 100)) : 0
                        return (
                          <div className="exp-prog" style={{ flex: 1, marginTop: 0 }}>
                            <div className="fill" style={{ width: pct + '%', background: 'var(--pos)' }} />
                          </div>
                        )
                      })()}
                      <button className="act" type="button" style={{ color:'var(--floor)' }}
                        onClick={() => setUncommitTarget(item)}>
                        {goalFor(item) ? 'stop saving' : 'uncommit'}
                      </button>
                    </div>
                  </div>
                  <div className="vl">{fmt(item.amount_cents, false)}</div>
                  <div className="check-btn" onClick={() => setBoughtTarget(item)}>✓</div>
                </div>
              ))}
            </div>
          </>
        )}

        {forecastDips && (
          <div className="wish-dip">
            <b>Your forecast already dips below your floor</b> around{' '}
            {cycles[baseDipIndex] ? fmtDate(cycles[baseDipIndex].startDate) : 'later this year'},
            closing at {fmt(baseTightest, false)} against a {fmt(floorCents, false)} floor —
            before anything on this list. Until that changes, everything here will read as out
            of reach, because any amount set aside makes that cycle lower still.
          </div>
        )}

        <div className="wish-secttl">Active</div>
        <div className="cards">
          {resolved.length === 0 && (
            <div className="skipnote" style={{ margin:'0 16px' }}>Nothing on your wishlist yet.</div>
          )}
          {resolved.map(item => {
            const p = item.plan as ItemPlan
            const finish = p.finishIndex !== null ? cycles[p.finishIndex] : null
            const thinCents = p.tightestCents - floorCents
            return (
              <div key={item.id} className="card">
                <div className="ic wish">☆</div>
                <div className="tx">
                  <div className="nm">
                    {item.name}
                    <span className={`chip ${REACH_CHIP[p.reach]}`}>{REACH_LABEL[p.reach]}</span>
                  </div>
                  <div className="dt">
                    {p.cycles === null
                      ? (forecastDips
                          ? <>Even spread across a year, this would take your tightest cycle lower
                              still. Worth sorting the dip above first.</>
                          : <>Even spread across a year, setting aside enough would drop you under
                              your {fmt(floorCents, false)} floor. Nothing to change yet — it will
                              move as your forecast does.</>)
                      : <>
                          <b>{p.cycles} {p.cycles === 1 ? 'cycle' : 'cycles'}</b> of setting aside{' '}
                          {fmt(p.perCycleCents, false)}
                          {finish && <> · done by {fmtDate(finish.startDate)}</>}
                          {p.reach === 'stretch' && thinCents < 10000 && (
                            <> · the tightest cycle leaves only {fmt(thinCents, false)} spare</>
                          )}
                        </>}
                  </div>
                  <div className="act-row">
                    {/* Always available. It used to be hidden unless you could buy the
                        item outright in a single cycle, which is not a route we offer. */}
                    <span className="act" onClick={() => openPay(item)}>how to pay →</span>
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
              <div className="inrow"><span className="pre">{sym}</span><input type="number" inputMode="decimal" value={addAmount} onChange={e => setAddAmount(e.target.value)} placeholder="0" /></div>
            </div>
            {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{addError}</p>}
            <div className="navrow">
              <button onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="pri" onClick={saveAdd} style={{ opacity:addSaving?0.6:1 }}>{addSaving ? 'Saving…' : 'Add to wishlist'}</button>
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
            <h3>{goalFor(uncommitTarget) ? 'Stop saving for' : 'Uncommit'} {uncommitTarget.name}?</h3>
            <p className="sd">
              {goalFor(uncommitTarget)
                ? <>Stops setting money aside from the next cycle. What you have already saved
                    stays recorded, and the item goes back to your list.</>
                : uncommitTarget.committed_cycle_start
                  ? <>Removes the {fmt(uncommitTarget.amount_cents, false)} expense from{' '}
                      {fmtDate(uncommitTarget.committed_cycle_start)}. The item goes back to active
                      and is judged against your current forecast again.</>
                  : <>Removes this commitment. The item goes back to your list.</>}
            </p>
            <div className="navrow">
              <button onClick={() => setUncommitTarget(null)}>
                {goalFor(uncommitTarget) ? 'Keep saving' : 'Keep committed'}
              </button>
              <button className="pri" style={{ background:'var(--floor)' }} onClick={doUncommit} disabled={uncommitSaving}>
                {uncommitSaving ? 'Working…' : goalFor(uncommitTarget) ? 'Stop saving' : 'Uncommit'}
              </button>
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
            <h3>Mark {boughtTarget.name} as bought?</h3>
            <p className="sd">
              {boughtTarget.status === 'committed'
                ? (goalFor(boughtTarget)
                    ? <>Closes the savings goal and removes it from your wishlist. The money already
                        left your spendable balance as you saved it, so nothing in the forecast
                        changes — that is what the savings were for.</>
                    : boughtTarget.committed_cycle_start
                      ? <>Removes it from your wishlist. The {fmt(boughtTarget.amount_cents, false)} expense
                          already committed to {fmtDate(boughtTarget.committed_cycle_start)} stays in your
                          forecast — this is just closing out the wishlist entry.</>
                      : <>Removes it from your wishlist. Anything already committed stays in your forecast.</>)
                : <>Removes it from your wishlist. Nothing else changes, since it was never committed to a cycle.</>}
            </p>
            <div className="navrow">
              <button onClick={() => setBoughtTarget(null)}>Cancel</button>
              <button className="pri" onClick={doMarkBought} style={{ opacity:boughtSaving?0.6:1 }}>{boughtSaving ? 'Removing…' : 'Mark as bought'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── how to pay ── */}
      {payTarget && (() => {
        const cost = payTarget.amount_cents

        const savePlan = planPayments(cost, saveN, 0)
        const saveBank = balancesAfter(closings, savePlan.pays)
        const saveLow  = saveBank.length ? Math.min(...saveBank) : 0
        const saveLowAt = saveBank.indexOf(saveLow)
        const saveFit  = fewestCyclesThatFit(closings, cost, floorCents, saveN + 1)

        const lbPlan = planPayments(cost, lbN, lbStart)
        const lbBank = balancesAfter(closings, lbPlan.pays)
        const lbLow  = lbBank.length ? Math.min(...lbBank) : 0
        const lbLowAt = lbBank.indexOf(lbLow)
        const lbFit  = earliestStartThatFits(closings, cost, lbN, floorCents)

        const isSave = payMode === 'savings'
        const plan   = isSave ? savePlan : lbPlan
        const bank   = isSave ? saveBank : lbBank
        const low    = isSave ? saveLow : lbLow
        const lowAt  = isSave ? saveLowAt : lbLowAt
        const endIdx = isSave ? saveN - 1 : lbStart + lbN - 1
        // Show the cycles this plan touches, not a fixed dozen — a plan over
        // 10 cycles was previously drawn as 12 bars with the last two blank.
        const barCount = Math.max(6, Math.min(endIdx + 2, 14))
        const shown    = bank.slice(0, barCount)
        const top      = Math.max(...shown, floorCents * 1.4, 1)

        return (
          <div className="ov" onClick={e => { if (e.target === e.currentTarget) setPayTarget(null) }}>
            <div className="sheet">
              <button className="xbtn" onClick={() => setPayTarget(null)}>×</button>
              <div className="grab" />
              <h3>How to pay for {payTarget.name}</h3>
              <p className="sd">
                This costs {fmt(cost, false)}. Both options spread it across cycles and take it out
                of your spendable balance, so the forecast tells the truth about what is left.
              </p>

              <div className="pay-seg">
                <button className={isSave ? 'on sv' : ''} onClick={() => setPayMode('savings')}>
                  Save up<small>set aside, money stays yours</small>
                </button>
                <button className={!isSave ? 'on lb' : ''} onClick={() => setPayMode('layby')}>
                  Lay-by<small>store holds it for you</small>
                </button>
              </div>

              <div className="pay-hero">
                <div className="ph-k">{isSave ? 'Saved up by' : 'Paid off by'}</div>
                <div className="ph-v">
                  {cycles[endIdx] ? fmtDate(cycles[endIdx].startDate) : 'beyond your forecast'}
                </div>
                <div className="ph-s">
                  <b>{fmt(plan.perCents, false)}</b> a cycle
                  {isSave ? <> for {saveN} cycles</> : <> for {lbN} payments{lbStart > 0 && <>, from {fmtDate(cycles[lbStart]?.startDate ?? '')}</>}</>}
                </div>
              </div>

              <div className="pay-controls">
                {isSave ? (
                  <div className="pc">
                    <label>Save over</label>
                    <div className="stepper">
                      <button disabled={saveN <= 2} onClick={() => setSaveN(saveN - 1)}>−</button>
                      <div className="v">{saveN} <small>cycles</small></div>
                      <button disabled={saveN >= 26} onClick={() => setSaveN(saveN + 1)}>+</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="pc">
                      <label>Start</label>
                      <div className="stepper">
                        <button disabled={lbStart <= 0} onClick={() => setLbStart(lbStart - 1)}>−</button>
                        <div className="v">{lbStart === 0 ? 'now' : '+' + lbStart}</div>
                        <button disabled={lbStart >= 8} onClick={() => setLbStart(lbStart + 1)}>+</button>
                      </div>
                    </div>
                    <div className="pc">
                      <label>Payments</label>
                      <div className="stepper">
                        <button disabled={lbN <= 2} onClick={() => setLbN(lbN - 1)}>−</button>
                        <div className="v">{lbN}</div>
                        <button disabled={lbN >= 26} onClick={() => setLbN(lbN + 1)}>+</button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* what it does to each cycle */}
              <div className="pay-bars-k">
                <span>Your account, each cycle</span>
                <span>lowest {fmt(low, false)}</span>
              </div>
              <div className="pay-bars">
                {floorCents > 0 && (
                  <div className="pay-floor" style={{ bottom: (18 + (floorCents / top) * 52) + 'px' }}>
                    <span>floor {fmt(floorCents, false)}</span>
                  </div>
                )}
                {shown.map((v, i) => (
                  <div key={i}
                    className={`pay-bar${v < 0 ? ' breach' : v < floorCents ? ' low' : ''}`}
                    style={{ height: Math.max((Math.max(v, 0) / top) * 52, 3) + 'px' }}>
                    <span className="pb-x">{cycles[i] ? cycleTickLabel(cycles[i].startDate, baseYear) : ''}</span>
                  </div>
                ))}
              </div>

              {/* a suggestion only when it actually fixes something */}
              {low < floorCents && isSave && saveFit !== null && (
                <div className="pay-suggest">
                  <span className="ps-x">
                    Stretching to <b>{saveFit} cycles</b> drops it to{' '}
                    {fmt(planPayments(cost, saveFit, 0).perCents, false)} a cycle and clears your floor.
                  </span>
                  <button onClick={() => setSaveN(saveFit)}>use it</button>
                </div>
              )}
              {low < floorCents && !isSave && lbFit !== null && lbFit > lbStart && (
                <div className="pay-suggest">
                  <span className="ps-x">
                    Starting <b>{fmtDate(cycles[lbFit]?.startDate ?? '')}</b> instead clears your
                    floor, and still finishes {fmtDate(cycles[lbFit + lbN - 1]?.startDate ?? '')}.
                  </span>
                  <button onClick={() => setLbStart(lbFit)}>use it</button>
                </div>
              )}

              <div className={`pay-note${low < 0 ? ' bad' : low < floorCents ? ' warn' : ''}`}>
                {low < 0
                  ? <>The cycle starting <b>{cycles[lowAt] ? cycleDateLabel(cycles[lowAt].startDate, baseYear) : '—'}</b> would go <b>{fmt(-low, false)} overdrawn</b>.</>
                  : low < floorCents
                    ? <>The cycle starting <b>{cycles[lowAt] ? cycleDateLabel(cycles[lowAt].startDate, baseYear) : '—'}</b> drops to <b>{fmt(low, false)}</b>, under your {fmt(floorCents, false)} floor. You can still go ahead, but it will be tight.</>
                    : <>Comfortable — the tightest cycle still leaves <b>{fmt(low, false)}</b>, and there is no interest either way.</>}
              </div>

              <p className="pay-what">
                {isSave
                  ? <>Adds <b>{fmt(savePlan.perCents, false)}</b> to each of your next {saveN} cycles.</>
                  : <>Adds <b>{lbN} payments</b> of {fmt(lbPlan.perCents, false)}{lbStart > 0 && <>, starting {fmtDate(cycles[lbStart]?.startDate ?? '')}</>}.</>}
              </p>

              <div className="navrow">
                <button onClick={() => setPayTarget(null)}>Cancel</button>
                <button className="pri"
                  style={{ background: isSave ? 'var(--pos)' : 'var(--event)' }}
                  onClick={isSave ? doStartSaving : doStartLayby}
                  disabled={paySaving}>
                  {paySaving ? 'Saving…' : isSave ? 'Start saving' : 'Start lay-by'}
                </button>
              </div>

            </div>
          </div>
        )
      })()}
    </>
  )
}