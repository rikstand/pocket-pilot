import { useEffect, useMemo, useState } from 'react'
import Sheet, { reportError } from './Sheet'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, projectFromRows, type ForecastResult } from '../lib/forecast'
import { savedSoFarCents } from '../lib/savings'
import {
  confirmSavingsContribution, unconfirmSavingsContribution, setSavingsOverride, clearSavingsOverride,
  updateSavingsGoal, releaseWishlistItem, relinkWishlistItem, deleteWishlistItem, restoreWishlistItem,
} from '../lib/repository'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { Segmented, DateChips } from './controls'

/**
 * One goal, or money put away for an expense (release 6; mock
 * claude/pp-savings-6.html, signed off 22 Nov). Cycle, Plan › Savings and the
 * Wishlist all open this sheet.
 *
 * One state decides what is open and the single pair of buttons at the bottom:
 *   main    this cycle as it stands       [Skip] [Set aside $X]   ([Close] once done)
 *   skip    what skipping does            [Back] [Skip this cycle]
 *   amount  a different amount            [Cancel] [Save $X]
 *   fix     the amount actually saved     [Cancel] [Save $X]
 * Opening one part closes the other, so there is never more than one pair.
 *
 * Skipping stores this cycle's amount as $0, so the forecast stops taking it.
 * "Finish a cycle later" leaves every later cycle as it was; "Catch up next
 * cycle" also stores next cycle's amount plus this one (decided 22 Nov).
 * What a skip does is read off the forecast, not assumed: on a "whatever's
 * spare" card plan the money goes to the card that pay, otherwise it stays in
 * the account.
 */

const NUM_CYCLES = 27
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const todayStr = () => formatDate(new Date())

export default function SavingsSheet({ accountId, goalId, cycleStart, rows: given, wishItem, onClose }: {
  accountId: string
  goalId: string
  /** The cycle the sheet is about. Leave out for the current one. */
  cycleStart?: string
  rows?: ForecastResult | null
  /** The wishlist item this goal saves for, if any (adds "I've bought it"). */
  wishItem?: any
  onClose: () => void
}) {
  const { activeAccount } = useAccount()
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const [loaded, setLoaded] = useState<ForecastResult | null>(null)
  useEffect(() => {
    if (given) return
    loadForecast(accountId, floorCents, { numCycles: NUM_CYCLES }).then(setLoaded).catch(e => reportError('Your savings didn’t load.', e))
  }, [accountId, floorCents, given])
  const rows = given ?? loaded
  const goal = rows?.savingsGoalRows.find((g: any) => g.id === goalId)
  if (!rows || !goal) return <Sheet onClose={onClose}><div className="rw-grab" /><div className="rw-sd" style={{ padding: 16 }}>Loading…</div></Sheet>
  return <Body accountId={accountId} goal={goal} rows={rows} cycleStart={cycleStart} wishItem={wishItem} floorCents={floorCents} onClose={onClose}
    fmt={moneyFormatter(activeAccount?.currency_code)} sym={currencySymbol(activeAccount?.currency_code)} />
}

function Body({ accountId, goal, rows, cycleStart, wishItem, floorCents, onClose, fmt, sym }: {
  accountId: string; goal: any; rows: ForecastResult; cycleStart?: string; wishItem?: any; floorCents: number; onClose: () => void
  fmt: (c: number, minor?: boolean) => string; sym: string
}) {
  const toast = useToast()
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
  const t = todayStr()
  const [mode, setMode] = useState<'main' | 'skip' | 'amount' | 'fix'>('main')
  const [how, setHow] = useState<'later' | 'catch'>('later')
  const [openHist, setOpenHist] = useState(false)
  const [busy, setBusy] = useState(false)

  const cycles = rows.cycles
  const k0 = Math.max(0, cycleStart ? cycles.findIndex(c => c.startDate === cycleStart) : 0)
  const c = cycles[k0], next = cycles[k0 + 1]
  const isPot = !!goal.expense_id
  const potExpense = isPot ? rows.expenseRows.find((e: any) => e.id === goal.expense_id) : null
  const name = goal.name ?? potExpense?.name ?? 'Savings'
  const ovOf = (start?: string) => start ? (rows.savingsOverrideRows ?? []).find((o: any) => o.savings_goal_id === goal.id && o.cycle_start === start) : undefined
  const lineOf = (k: number) => cycles[k]?.savingsLines.find(l => l.goalId === goal.id)?.amountCents ?? 0
  const ov = ovOf(c.startDate), nextOv = ovOf(next?.startDate)
  const contribution = (rows.savingsContributionRows ?? []).find((x: any) => x.savings_goal_id === goal.id && x.cycle_start === c.startDate)
  const state: 'done' | 'skipped' | 'todo' = contribution ? 'done' : ov && ov.amount_cents === 0 ? 'skipped' : 'todo'
  const amount = state === 'skipped' ? (isPot ? 0 : goal.per_cycle_cents) : lineOf(k0)
  const have = savedSoFarCents(goal, rows.savingsContributionRows, rows.savingsOverrideRows)
  const target = isPot ? (lineOf(k0) + have) : goal.target_cents
  const reached = !isPot && have >= goal.target_cents

  /* the forecast with a change, for what a skip or a new amount does */
  const len = cycles.length > 1 ? Math.round((parseDate(cycles[1].startDate).getTime() - parseDate(cycles[0].startDate).getTime()) / 864e5) : 14
  const startOf = (k: number) => k < cycles.length ? cycles[k].startDate : shift(cycles[cycles.length - 1].startDate, len * (k - cycles.length + 1))
  const project = (ovRows: any[], goalPatch?: any) => projectFromRows({
    ...rows, savingsOverrideRows: ovRows,
    savingsGoalRows: goalPatch ? rows.savingsGoalRows.map((g: any) => g.id === goal.id ? { ...g, ...goalPatch } : g) : rows.savingsGoalRows,
  }, floorCents, cycles.length)
  const base = useMemo(() => project(rows.savingsOverrideRows ?? []), [rows])
  const finishOf = (proj: typeof cycles, per = goal.per_cycle_cents) => {
    let last = -1
    proj.forEach((p, k) => { if (p.savingsLines.some(l => l.goalId === goal.id && l.amountCents > 0)) last = k })
    if (isPot) return last
    // Past the horizon: the cycles still needed at the goal's amount.
    const planned = proj.reduce((s, p) => s + (p.savingsLines.find(l => l.goalId === goal.id)?.amountCents ?? 0), 0)
    const left = goal.target_cents - have - planned
    return left > 0 && per > 0 ? proj.length - 1 + Math.ceil(left / per) : last
  }
  const withOv = (list: { start: string; cents: number }[]) => {
    const keep = (rows.savingsOverrideRows ?? []).filter((o: any) => !(o.savings_goal_id === goal.id && list.some(l => l.start === o.cycle_start)))
    return [...keep, ...list.map(l => ({ savings_goal_id: goal.id, account_id: accountId, cycle_start: l.start, amount_cents: l.cents }))]
  }
  const finish = finishOf(base)
  const ownTxt = (k: number) => k < 0 ? '—' : k === 0 && k0 === 0 ? 'this cycle' : short(startOf(k))
  const interest = (p: typeof cycles) => p.reduce((s, x) => s + (x.creditInterestCents ?? 0), 0)

  // What skipping does, read off the forecast.
  const skipLater = useMemo(() => next ? project(withOv([{ start: c.startDate, cents: 0 }])) : null, [rows, k0])
  const catchUp = useMemo(() => next ? project(withOv([{ start: c.startDate, cents: 0 }, { start: next.startDate, cents: lineOf(k0 + 1) + amount }])) : null, [rows, k0])
  const toCard = skipLater ? skipLater[k0].creditPaymentCents - base[k0].creditPaymentCents : 0
  const goesToCard = toCard > amount / 2
  const lessInterest = skipLater ? interest(base) - interest(skipLater) : 0
  const nextLeft = catchUp && next ? catchUp[k0 + 1].committedClosingBalanceCents : 0
  const nextLv = nextLeft < 0 ? 'under' : nextLeft < floorCents ? 'near' : 'ok'
  const cardLess = catchUp && next ? base[k0 + 1].creditPaymentCents - catchUp[k0 + 1].creditPaymentCents : 0
  const cardOnlyMin = catchUp && next && cardLess > 0 && catchUp[k0 + 1].creditExtraCents <= 0

  /* a new amount: just this cycle, or from a date */
  const [amt, setAmt] = useState(String(goal.per_cycle_cents / 100))
  const [scope, setScope] = useState<'once' | 'from'>('from')
  const [from, setFrom] = useState(c.startDate <= t ? t : c.startDate)
  const newPer = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const fromK = Math.max(k0, cycles.findIndex(x => x.endDate >= from))
  const amountPlan = () => {
    if (scope === 'once') return { goalPatch: undefined, list: [{ start: c.startDate, cents: newPer }] }
    // From a date: the goal's amount changes, and the cycles before that date
    // keep the old amount as one-cycle amounts (unless they already have one).
    const list: { start: string; cents: number }[] = []
    for (let k = k0; k < fromK; k++) if (!ovOf(cycles[k].startDate)) list.push({ start: cycles[k].startDate, cents: goal.per_cycle_cents })
    return { goalPatch: { per_cycle_cents: newPer }, list }
  }
  const amountFinish = useMemo(() => {
    if (!newPer || isPot) return null
    const pl = amountPlan()
    const ovRows = pl.goalPatch ? withOv(pl.list).filter((o: any) => !(o.savings_goal_id === goal.id && o.cycle_start === cycles[fromK].startDate)) : withOv(pl.list)
    return finishOf(project(ovRows, pl.goalPatch), pl.goalPatch ? newPer : goal.per_cycle_cents)
  }, [newPer, scope, fromK, rows])

  /* correcting the total */
  const [fixAmt, setFixAmt] = useState(String(have / 100))
  const fixCents = Math.max(0, Math.round((parseFloat(fixAmt) || 0) * 100))

  /* history: each cycle since the goal started, up to this one */
  const past = (rows.storedCycles ?? []).map((s: any) => s.start_date as string)
    .filter(s => s >= goal.start_cycle_start && s < c.startDate).sort().slice(-12)
  const didSet = (s: string) => (rows.savingsContributionRows ?? []).some((x: any) => x.savings_goal_id === goal.id && x.cycle_start === s)
  const missed = past.filter(s => !didSet(s)).length

  async function act(fn: () => Promise<void>, fail: string) {
    if (busy) return
    setBusy(true)
    try { await fn(); notifyDataChanged(); onClose() }
    catch (e: any) { reportError(fail, e) }
    finally { setBusy(false) }
  }
  const putBack = async (list: { start: string; was: any }[]) => {
    for (const x of list) x.was ? await setSavingsOverride(goal.id, accountId, x.start, x.was.amount_cents) : await clearSavingsOverride(goal.id, x.start)
    notifyDataChanged()
  }

  const setAside = () => act(async () => {
    await confirmSavingsContribution(goal.id, accountId, c.startDate, isPot ? amount : null)
    toast(`${name}: ${money(amount)} set aside`, { undo: async () => { await unconfirmSavingsContribution(goal.id, c.startDate); notifyDataChanged() } })
  }, 'That wasn’t saved.')
  const unsetAside = () => act(async () => {
    await unconfirmSavingsContribution(goal.id, c.startDate)
    toast(`${name}: back to not set aside`, { undo: async () => { await confirmSavingsContribution(goal.id, accountId, c.startDate, contribution?.amount_cents ?? null); notifyDataChanged() } })
  }, 'That wasn’t saved.')
  const skip = () => act(async () => {
    await setSavingsOverride(goal.id, accountId, c.startDate, 0)
    const undo: { start: string; was: any }[] = [{ start: c.startDate, was: ov }]
    if (how === 'catch' && next) {
      await setSavingsOverride(goal.id, accountId, next.startDate, lineOf(k0 + 1) + amount)
      undo.push({ start: next.startDate, was: nextOv })
    }
    toast(how === 'catch' ? `${name}: skipped, ${money(lineOf(k0 + 1) + amount)} next cycle` : `${name}: skipped this cycle${isPot ? '' : `, yours ${ownTxt(finishOf(skipLater!))}`}`,
      { undo: () => putBack(undo) })
  }, 'That wasn’t saved.')
  // Undo a skip from the sheet: this cycle's $0 goes, and a catch-up stored
  // for next cycle (this amount on top of its own) goes with it.
  const unskip = () => act(async () => {
    const undo: { start: string; was: any }[] = [{ start: c.startDate, was: ov }]
    await clearSavingsOverride(goal.id, c.startDate)
    if (next && nextOv && !isPot && nextOv.amount_cents === goal.per_cycle_cents * 2) {
      await clearSavingsOverride(goal.id, next.startDate); undo.push({ start: next.startDate, was: nextOv })
    }
    toast(`${name}: back to not set aside`, { undo: () => putBack(undo) })
  }, 'That wasn’t saved.')
  const saveAmount = () => act(async () => {
    const pl = amountPlan(), oldPer = goal.per_cycle_cents
    const undo: { start: string; was: any }[] = []
    if (pl.goalPatch) {
      await updateSavingsGoal(goal.id, { per_cycle_cents: newPer })
      const at = cycles[fromK].startDate, wasAt = ovOf(at)
      if (wasAt) { await clearSavingsOverride(goal.id, at); undo.push({ start: at, was: wasAt }) }
    }
    for (const l of pl.list) { undo.push({ start: l.start, was: ovOf(l.start) }); l.cents === goal.per_cycle_cents && !pl.goalPatch ? await clearSavingsOverride(goal.id, l.start) : await setSavingsOverride(goal.id, accountId, l.start, l.cents) }
    toast(scope === 'once' ? `${name}: ${money(newPer)} this cycle` : `${name}: ${money(newPer)} a cycle from ${fromK === k0 ? 'this cycle' : short(cycles[fromK].startDate)}`,
      { undo: async () => { if (pl.goalPatch) await updateSavingsGoal(goal.id, { per_cycle_cents: oldPer }); await putBack(undo) } })
  }, 'That amount wasn’t saved.')
  const saveFix = () => act(async () => {
    const was = { adjusted_total_cents: goal.adjusted_total_cents ?? null, adjusted_at: goal.adjusted_at ?? null }
    // A correction is a statement about reality, so it wins over the ticks.
    await updateSavingsGoal(goal.id, { adjusted_total_cents: fixCents, adjusted_at: new Date().toISOString() })
    toast(`${name}: saved so far is now ${money(fixCents)}`, { undo: async () => { await updateSavingsGoal(goal.id, was); notifyDataChanged() } })
  }, 'That wasn’t saved.')
  const stop = () => act(async () => {
    await updateSavingsGoal(goal.id, { status: 'cancelled' })
    if (wishItem) await releaseWishlistItem(wishItem.id)
    toast(`${name}: stopped. What’s saved stays recorded.`, { lasting: true, undo: async () => {
      await updateSavingsGoal(goal.id, { status: goal.status ?? 'active' })
      if (wishItem) await relinkWishlistItem(wishItem.id, { method: 'savings', goalId: goal.id })
      notifyDataChanged() } })
  }, 'That wasn’t stopped.')
  const finishGoal = () => act(async () => {
    await updateSavingsGoal(goal.id, { status: 'completed' })
    if (wishItem) await deleteWishlistItem(wishItem.id)
    toast(wishItem ? `${name}: bought. The goal is closed.` : `${name}: done. The goal is closed.`, { lasting: true, undo: async () => {
      await updateSavingsGoal(goal.id, { status: goal.status ?? 'active' })
      if (wishItem) await restoreWishlistItem(wishItem)
      notifyDataChanged() } })
  }, 'That wasn’t saved.')
  const flip = (s: string) => act(async () => {
    const was = didSet(s)
    was ? await unconfirmSavingsContribution(goal.id, s) : await confirmSavingsContribution(goal.id, accountId, s)
    toast(`${short(s)}: ${was ? 'marked as missed' : 'marked as set aside'}`, { undo: async () => {
      was ? await confirmSavingsContribution(goal.id, accountId, s) : await unconfirmSavingsContribution(goal.id, s); notifyDataChanged() } })
  }, 'That wasn’t saved.')

  const toggle = (m: 'amount' | 'fix') => setMode(x => x === m ? 'main' : m)
  const cycleLabel = `${short(c.startDate)} – ${short(c.endDate)}`

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div className="rw-sh-t"><span className="rw-savmark" aria-hidden="true" /><div>
        <h2 className="rw-sheet-title">{name}</h2>
        <div className="rw-sd">{isPot ? `Put away for ${potExpense?.name ?? 'an expense'}` : `Saving up · ${money(goal.per_cycle_cents)} a cycle`}</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>

      <div className="rw-card">
        <div className="rw-pv-k"><span>{k0 === 0 ? 'This cycle' : 'That cycle'} · {cycleLabel}</span></div>
        <div className="rw-big-amt">{money(amount)}</div>
        {state === 'done' && <div className="rw-line"><span className="rw-ok">Set aside ✓</span><button type="button" className="rw-mini sec" disabled={busy} onClick={unsetAside}>Undo</button></div>}
        {state === 'skipped' && <div className="rw-line"><span>Skipped {k0 === 0 ? 'this' : 'that'} cycle.</span><button type="button" className="rw-mini sec" disabled={busy} onClick={unskip}>Undo</button></div>}
        {state === 'todo' && mode !== 'skip' && <div className="rw-sub">{reached ? 'Fully saved.' : 'Not set aside yet.'}</div>}
        {state === 'todo' && mode === 'skip' && <>
          {next && <div style={{ margin: '4px 0 10px' }}><Segmented small value={how} onChange={setHow}
            options={[{ value: 'later', label: isPot ? 'Spread it later' : 'Finish a cycle later' }, { value: 'catch', label: 'Catch up next cycle' }]} /></div>}
          {how === 'later' || !next
            ? <div className="rw-result">{goesToCard
                ? <>Your plan sends the {money(amount)} to your card this pay. {lessInterest >= 100 && <>The card clears a little sooner: about <b>{money(lessInterest)} less interest</b>. </>}</>
                : <>The {money(amount)} stays in your account. </>}
                {!isPot && skipLater && <>Yours <b>{ownTxt(finishOf(skipLater))}</b> instead of {ownTxt(finish)}.</>}
                {isPot && <>The rest is spread over the cycles left before it’s due.</>}</div>
            : <>
              <div className="rw-result">Next cycle: <b>{money(lineOf(k0 + 1) + amount)}</b>. {!isPot && <>Still yours {ownTxt(finish)}. </>}
                {cardOnlyMin ? <>The card gets only its {money(catchUp![k0 + 1].creditPaymentCents)} minimum that pay.</>
                  : cardLess > 0 ? <>The card gets {money(cardLess)} less that pay.</>
                  : <>Your {short(shift(next.endDate, 1))} payday stays at {money(nextLeft)}, as long as the {money(amount)} is still in your account.</>}</div>
              {nextLv === 'near' && <div className="rw-warn-ban near"><span>Before pay {short(shift(next.endDate, 1))} you’d dip <b>{money(floorCents - nextLeft)}</b> into your floor. You’d still have {money(nextLeft)}.</span></div>}
              {nextLv === 'under' && <div className="rw-warn-ban under"><span className="i">!</span><span>You’d be <b>{money(-nextLeft)} overdrawn</b> before pay {short(shift(next.endDate, 1))}.</span></div>}
            </>}
        </>}
      </div>

      <div className="rw-group flush" style={{ marginTop: 8 }}>
        <button type="button" className="rw-row" aria-expanded={openHist} onClick={() => setOpenHist(v => !v)}>
          <div className="rw-tx"><div className="rw-row-name">Savings progress</div>
            <div className="rw-sub">{money(have)}{isPot ? ' put away' : ` of ${money(goal.target_cents)}`}{!isPot && finish >= 0 && ` · yours ${ownTxt(finish)}`}{missed ? ` · ${missed} missed` : ''}</div>
            {!isPot && <div className="rw-pb" aria-hidden="true"><i style={{ width: Math.min(100, have / Math.max(1, target) * 100) + '%' }} /></div>}</div>
          <span className={`rw-chev rw-turn${openHist ? ' on' : ''}`}>›</span></button>
        {openHist && <div className="rw-open">
          {past.length === 0 ? <div className="rw-sub">No earlier cycles yet.</div> : <>
            <div className="rw-cdots">
              {past.map(s => <button key={s} type="button" className={`rw-cdot ${didSet(s) ? 'ok' : 'miss'}`} disabled={busy} onClick={() => flip(s)}
                aria-label={`${short(s)}: ${didSet(s) ? 'set aside' : 'missed'}. Tap to change.`}><i>{didSet(s) ? '✓' : '–'}</i>{short(s)}</button>)}
              <span className={`rw-cdot now${state === 'done' ? ' ok' : ''}`}><i>{state === 'done' ? '✓' : ''}</i>now</span>
            </div>
            <div className="rw-sub" style={{ marginTop: 8 }}>✓ set aside · – missed. Tap a past cycle to correct it.</div>
          </>}
        </div>}
        {!isPot && <>
          <button type="button" className="rw-row" aria-expanded={mode === 'amount'} onClick={() => toggle('amount')}>
            <div className="rw-tx"><div className="rw-row-name">Change the amount</div><div className="rw-sub">Just this cycle, or from a date</div></div>
            <span className={`rw-chev rw-turn${mode === 'amount' ? ' on' : ''}`}>›</span></button>
          {mode === 'amount' && <div className="rw-open">
            <div className="rw-amt"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="Amount each cycle" value={amt} onChange={e => setAmt(e.target.value)} /></div>
            <Segmented small value={scope} onChange={setScope} options={[{ value: 'once', label: k0 === 0 ? 'Just this cycle' : 'Just that cycle' }, { value: 'from', label: 'From a date' }]} />
            {scope === 'from' && <div style={{ marginTop: 10 }}><DateChips value={from} onChange={setFrom} today={t} label="From"
              payDates={cycles.slice(k0 + 1).map(x => x.startDate).filter(d => d > t)} /></div>}
            {amountFinish != null && <div className="rw-result" style={{ paddingTop: 10 }}>{newPer === 0 ? 'Paused: nothing set aside until you change it again.' : <>Yours <b>{ownTxt(amountFinish)}</b>{amountFinish !== finish ? ` instead of ${ownTxt(finish)}` : ''}.</>}</div>}
          </div>}
        </>}
        <button type="button" className="rw-row" aria-expanded={mode === 'fix'} onClick={() => toggle('fix')}>
          <div className="rw-tx"><div className="rw-row-name">Correct the amount saved</div><div className="rw-sub">If your account shows a different total</div></div>
          <span className={`rw-chev rw-turn${mode === 'fix' ? ' on' : ''}`}>›</span></button>
        {mode === 'fix' && <div className="rw-open">
          <div className="rw-amt"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="Amount saved so far" value={fixAmt} onChange={e => setFixAmt(e.target.value)} /></div>
          <div className="rw-hint" style={{ marginTop: 0 }}>What’s really put away for this today. Ticks from now on add to it.</div>
        </div>}
        {(reached || wishItem) && <button type="button" className="rw-row" disabled={busy} onClick={finishGoal}>
          <div className="rw-tx"><div className="rw-row-name">{wishItem ? 'I’ve bought it' : 'Mark as done'}</div><div className="rw-sub">Closes the goal. The money already left your balance as you saved it.</div></div></button>}
        <button type="button" className="rw-row" disabled={busy} onClick={stop}>
          <div className="rw-tx"><div className="rw-row-name rw-danger">{isPot ? 'Stop putting money away' : 'Stop saving'}</div><div className="rw-sub">What’s saved stays recorded</div></div></button>
      </div>

      <div className="rw-ctas">
        {mode === 'amount' ? <>
          <button type="button" className="rw-cta sec" onClick={() => setMode('main')}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || (scope === 'from' && newPer === goal.per_cycle_cents && fromK === k0)} onClick={saveAmount}>{busy ? 'Saving…' : `Save ${money(newPer)}`}</button>
        </> : mode === 'fix' ? <>
          <button type="button" className="rw-cta sec" onClick={() => setMode('main')}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || fixCents === have} onClick={saveFix}>{busy ? 'Saving…' : `Save ${money(fixCents)}`}</button>
        </> : mode === 'skip' ? <>
          <button type="button" className="rw-cta sec" onClick={() => setMode('main')}>Back</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={skip}>{busy ? 'Saving…' : <>Skip {k0 === 0 ? 'this' : 'that'} cycle{how === 'catch' && nextLv === 'under' ? ' anyway' : ''}</>}</button>
        </> : state === 'todo' && amount > 0 ? <>
          <button type="button" className="rw-cta sec" onClick={() => setMode('skip')}>Skip</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={setAside}>{busy ? 'Saving…' : `Set aside ${money(amount)}`}</button>
        </> : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}
