import { useEffect, useMemo, useState } from 'react'
import Sheet, { reportError } from './Sheet'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, projectFromRows, toEngineExpenses, type ForecastResult } from '../lib/forecast'
import { occurrencesOf } from '../engine/recurrence'
import { addDays, formatDate } from '../engine/dates'
import { savedSoFarCents } from '../lib/savings'
import {
  confirmSavingsContribution, unconfirmSavingsContribution, setSavingsOverride, clearSavingsOverride,
  updateSavingsGoal, releaseWishlistItem, relinkWishlistItem, deleteWishlistItem, restoreWishlistItem,
} from '../lib/repository'
import { parseDate } from '../engine/dates'
import { notifyDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import { DateChips } from './controls'
import Preview from './Preview'
import { overdrawn } from '../engine/floor'
import { makePlanner, perFor, type Draft } from '../lib/savingsPlan'
import { saveDraft } from '../lib/savingsSave'

/**
 * One goal, or money put away for an expense. Cycle, Plan › Savings and the
 * Wishlist all open this sheet. Release 6b (mock pp-savings-by-date-6b 3.1,
 * signed off 24 Nov 2026) lays it out like the card sheet: the amount and a
 * slider ($0 pauses), the "saved by" date row, the tiles and the chart (✓ where
 * the goal is saved), then the rows. The amount and the date drive each other.
 *
 *
 * One pair of buttons, from one state:
 *   nothing changed      [Close]
 *   the plan changed     [Cancel] [Save · $X a cycle] / [Skip …] / [Pause until …]
 *   behind its date      [Not now] [Move to <date>]
 *   correcting the total [Cancel] [Save $X]
 * This cycle's Set aside and Skip sit on the "This cycle" row, where the card
 * sheet has "I've paid it". A skip is part of the plan: spreading the gap
 * keeps the date when that fits, else the goal finishes later; "Catch up next
 * cycle" is a chip. Money put away for an expense has no amount or date of its
 * own (the expense sets them), so it shows only the rows, and a skip there is
 * spread over the cycles left (release 6).
 */

const NUM_CYCLES = 27

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
  const [busy, setBusy] = useState(false)
  const [openHist, setOpenHist] = useState(false)
  const [fixing, setFixing] = useState(false)

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
  const l0 = lineOf(k0)
  const have = savedSoFarCents(goal, rows.savingsContributionRows, rows.savingsOverrideRows)
  const reached = !isPot && have >= goal.target_cents
  const that = k0 === 0 ? 'This' : 'That'

  /* ── the plan: one draft drives the amount, the date, the tiles and the chart ── */
  const P = useMemo(() => makePlanner(rows, goal, accountId, floorCents, k0, have), [rows, k0])
  const base0: Draft = { per: goal.per_cycle_cents, skip: false, catchUp: false, restart: null }
  const [d, setD] = useState<Draft>(base0)
  const [dated, setDated] = useState(!!goal.target_date)
  // "Now" is run the same way as every change, so the two compare like for like.
  const base = useMemo(() => isPot ? cycles : P.project(base0), [P])
  const proj = useMemo(() => isPot ? base : P.project(d), [P, d.per, d.skip, d.catchUp, d.restart])
  const fin = isPot ? -1 : P.finishOf(proj, d.per)
  const baseFin = isPot ? -1 : P.finishOf(base, goal.per_cycle_cents)
  const kD = goal.target_date ? P.kOf(goal.target_date) : -1
  const from = P.fromOf(d)
  const rem = useMemo(() => isPot ? 0 : P.remFrom(d), [P, d.skip, d.restart])
  // The earliest "saved by" that fits from here, and the amount that gets there.
  const early = useMemo(() => {
    if (isPot || rem <= 0) return null
    for (let k = from; k < P.n + 26; k++) if (P.fits(P.project({ ...d, catchUp: false, per: perFor(rem, from, k) }), base)) return k
    return null
  }, [P, rem, from])
  const fitPer = early != null ? perFor(rem, from, early) : null
  const keep = kD >= from ? perFor(rem, from, kD) : null
  const behind = !isPot && kD >= 0 && baseFin > kD
  const moved = !isPot && !!goal.target_date && fin > kD
  const changed = d.per !== goal.per_cycle_cents || d.skip || d.catchUp || d.restart != null || (dated && !goal.target_date)
  const dirty = changed || (moved && behind)
  const lowAt = P.lowest(proj, base)
  const lo = lowAt >= 0 ? proj[lowAt].committedClosingBalanceCents : null
  const hi = Math.ceil(Math.max(goal.per_cycle_cents * 2, (keep ?? 0) + 5000, (fitPer ?? 0) + 5000, 30000) / 5000) * 5000
  const pct = (v: number) => Math.min(100, Math.max(0, v / hi * 100))
  const setPer = (v: number) => setD(v <= 0 ? { ...d, restart: k0 + 2 + (P.done && !d.skip ? 1 : 0), per: goal.per_cycle_cents, catchUp: false } : { ...d, per: v, catchUp: false })
  const snaps: { k: string; v: number }[] = [{ k: 'As now', v: goal.per_cycle_cents }]
  if (keep != null && keep !== goal.per_cycle_cents) snaps.push({ k: `Keeps ${short(goal.target_date)}`, v: keep })
  if (fitPer != null && fitPer !== keep && fitPer !== goal.per_cycle_cents) snaps.push({ k: 'Fits', v: fitPer })

  /* the chart: where the change lands — the card, if it moves; else your paydays and the date */
  const cardMoves = !isPot && proj.reduce((s2, x, k) => s2 + Math.abs((x.creditPaymentCents ?? 0) - (base[k]?.creditPaymentCents ?? 0)), 0) >= 100
  const clNow = P.clearedAt(base), clNew = P.clearedAt(proj)
  const span = Math.min(cycles.length - k0, Math.max(8, fin - k0 + 2, baseFin - k0 + 2, cardMoves && clNew >= 0 ? clNew - k0 + 2 : 0))
  const closes = (p: typeof cycles) => p.slice(k0, k0 + span).map(x => x.committedClosingBalanceCents)
  const payDates = Array.from({ length: span }, (_, i) => P.startOf(k0 + i + 1))
  const at = (k: number) => k > k0 && k - k0 - 1 < span ? k - k0 - 1 : null
  const dC = clNew >= 0 && clNow >= 0 ? clNew - clNow : 0
  const third = cardMoves
    ? { k: 'Card cleared', v: clNew >= 0 ? short(P.startOf(clNew + 1)) : 'Later', d: dC ? `${Math.abs(dC)} cycle${Math.abs(dC) > 1 ? 's' : ''} ${dC > 0 ? 'later' : 'sooner'}` : 'no change', cls: dC > 0 ? 'near' : dC < 0 ? 'good' : '' }
    : { k: 'Saved by', v: fin >= 0 ? short(P.startOf(fin)) : '—', d: kD >= 0 ? (fin > kD ? `after ${short(goal.target_date)}` : 'on time') : 'at this amount', cls: kD >= 0 && fin > kD ? 'near' : '' }

  /* history: each cycle since the goal started, up to this one */
  const past = (rows.storedCycles ?? []).map((s: any) => s.start_date as string)
    .filter(s => s >= goal.start_cycle_start && s < c.startDate).sort().slice(-12)
  const didSet = (s: string) => (rows.savingsContributionRows ?? []).some((x: any) => x.savings_goal_id === goal.id && x.cycle_start === s)
  const missed = past.filter(s => !didSet(s)).length
  const [fixAmt, setFixAmt] = useState(String(have / 100))
  const fixCents = Math.max(0, Math.round((parseFloat(fixAmt) || 0) * 100))

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
    // Money for an expense is set aside at the slider's amount; that amount is
    // stored for the cycle too, so the rest spreads over the cycles left.
    const amt = isPot ? now : l0, was = ovOf(c.startDate)
    if (isPot && now !== l0) await setSavingsOverride(goal.id, accountId, c.startDate, now)
    await confirmSavingsContribution(goal.id, accountId, c.startDate, isPot ? amt : null)
    toast(`${name}: ${money(amt)} set aside`, { undo: async () => {
      await unconfirmSavingsContribution(goal.id, c.startDate)
      if (isPot && now !== l0) await putBack([{ start: c.startDate, was }])
      notifyDataChanged() } })
  }, 'That wasn’t saved.')
  const unsetAside = () => act(async () => {
    await unconfirmSavingsContribution(goal.id, c.startDate)
    toast(`${name}: not set aside`, { undo: async () => { await confirmSavingsContribution(goal.id, accountId, c.startDate, contribution?.amount_cents ?? null); notifyDataChanged() } })
  }, 'That wasn’t saved.')
  // Undo a stored skip: this cycle's $0 goes, and a catch-up stored for next cycle goes with it.
  const unskip = () => act(async () => {
    const undo: { start: string; was: any }[] = [{ start: c.startDate, was: ov }]
    await clearSavingsOverride(goal.id, c.startDate)
    if (next && nextOv && !isPot && nextOv.amount_cents === goal.per_cycle_cents * 2) {
      await clearSavingsOverride(goal.id, next.startDate); undo.push({ start: next.startDate, was: nextOv })
    }
    toast(`${name}: not set aside`, { undo: () => putBack(undo) })
  }, 'That wasn’t saved.')
  /** Save the draft: the one-cycle amounts, the standing amount and the date. */
  const savePlan = () => act(async () => {
    const r = await saveDraft(P, goal, accountId, d, (dated || !!goal.target_date) && fin >= 0 ? P.startOf(fin) : undefined)
    const msg = d.restart != null ? `${name}: paused until ${short(P.startOf(d.restart))}`
      : d.skip ? `${name}: skipped ${that.toLowerCase()} cycle${d.catchUp ? `, ${money(l0 + d.per)} next cycle` : ''}`
      : `${name}: ${money(d.per)} a cycle${r.date ? `, by ${short(r.date)}` : ''}`
    toast(msg, { undo: async () => { await r.undo(); notifyDataChanged() } })
  }, 'That wasn’t saved.')
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
  const flip = (s2: string) => act(async () => {
    const was = didSet(s2)
    was ? await unconfirmSavingsContribution(goal.id, s2) : await confirmSavingsContribution(goal.id, accountId, s2)
    toast(`${short(s2)}: ${was ? 'marked as missed' : 'marked as set aside'}`, { undo: async () => {
      was ? await confirmSavingsContribution(goal.id, accountId, s2) : await unconfirmSavingsContribution(goal.id, s2); notifyDataChanged() } })
  }, 'That wasn’t saved.')
  // Skip in the draft: keep the date when spreading the gap fits, else finish later (agreed 24 Nov 2026).
  const skipDraft = () => {
    const sk: Draft = { ...d, skip: true }
    if (kD >= k0 + 1) {
      const sp = perFor(P.remFrom(sk), k0 + 1, kD)
      if (P.fits(P.project({ ...sk, per: sp }), base)) { setD({ ...sk, per: sp }); return }
    }
    setD(sk)
  }

  /* ── money put away for an expense: this cycle's amount, like the card's "Pay this cycle" (24 Nov 2026).
   * The expense fixes the total and the due date; the forecast spreads whatever
   * this cycle doesn't put away over the cycles left until it's due. ── */
  const potExp = useMemo(() => isPot ? toEngineExpenses(rows.expenseRows).find(e => e.id === goal.expense_id) : undefined, [rows])
  const due = useMemo(() => potExp ? occurrencesOf(potExp, c.startDate, formatDate(addDays(parseDate(c.startDate), 3 * 366)))[0] ?? null : null, [potExp])
  const kDue = due ? P.kOf(due) : -1
  const potLines = (p2: typeof cycles) => p2.slice(k0, kDue >= k0 ? kDue + 1 : k0 + 1).map((_x, i) => P.lineOf(p2, k0 + i))
  const potNeed = isPot ? potLines(cycles).reduce((a, b) => a + b, 0) : 0
  const dueCents = isPot ? (cycles.slice(k0).flatMap(x => x.savingsLines).find(l => l.goalId === goal.id)?.targetCents ?? 0) : 0
  const potRows = (cents: number) => ({ ...rows, savingsOverrideRows: [
    ...(rows.savingsOverrideRows ?? []).filter((o: any) => !(o.savings_goal_id === goal.id && o.cycle_start === c.startDate)),
    { savings_goal_id: goal.id, account_id: accountId, cycle_start: c.startDate, amount_cents: cents }] })
  const potProject = (cents: number) => projectFromRows(potRows(cents), floorCents, cycles.length)
  const [now, setNow] = useState(l0)
  const potBase = useMemo(() => isPot ? projectFromRows(rows, floorCents, cycles.length) : cycles, [rows])
  const potProj = useMemo(() => isPot && now !== l0 ? potProject(now) : potBase, [now, potBase])
  const potFits = useMemo(() => {
    if (!isPot || potNeed <= 0) return null
    const ok = (v: number) => P.fits(potProject(v), potBase)
    if (ok(potNeed)) return potNeed
    let lo2 = 0, hi2 = potNeed
    while (hi2 - lo2 > 500) { const mid = Math.round((lo2 + hi2) / 2 / 500) * 500; if (ok(mid)) lo2 = mid; else hi2 = mid }
    return lo2
  }, [potBase, potNeed])
  const potLeft = isPot ? potLines(potProj).reduce((a, b) => a + b, 0) : 0
  const potShort = Math.max(0, potNeed - potLeft)
  const potLowAt = isPot ? P.lowest(potProj, potBase) : -1
  const potLo = potLowAt >= 0 ? potProj[potLowAt].committedClosingBalanceCents : null
  const potSpan = Math.min(cycles.length - k0, Math.max(8, kDue - k0 + 2))
  const potReady = (() => { let last = -1; potLines(potProj).forEach((a, i) => { if (a > 0) last = k0 + i }); return last })()
  const potReadyNow = (() => { let last = -1; potLines(potBase).forEach((a, i) => { if (a > 0) last = k0 + i }); return last })()
  const potPct = (v: number) => Math.min(100, Math.max(0, v / Math.max(1, potNeed) * 100))
  const savePot = () => act(async () => {
    const was = ovOf(c.startDate)
    await setSavingsOverride(goal.id, accountId, c.startDate, now)
    toast(now === 0 ? `${name}: skipped ${that.toLowerCase()} cycle` : `${name}: ${money(now)} ${that.toLowerCase()} cycle`, { undo: () => putBack([{ start: c.startDate, was }]) })
  }, 'That wasn’t saved.')

  const head = isPot ? (due ? `${money(dueCents)} due ${short(due)} · ${money(have)} put away` : `Put away for ${potExpense?.name ?? 'an expense'}`)
    : <>{money(have)} of {money(goal.target_cents)} · {goal.target_date ? <>by {short(goal.target_date)}{behind ? <> · <span className="rw-warn">behind</span></> : ''}</> : 'no date'}</>
  const cta = d.restart != null ? `Pause until ${short(P.startOf(d.restart))}`
    : d.skip ? (d.catchUp ? `Skip · ${money(l0 + d.per)} next cycle` : d.per !== goal.per_cycle_cents ? `Skip · ${money(d.per)} a cycle` : `Skip ${that.toLowerCase()} cycle`)
    : d.per !== goal.per_cycle_cents ? `Save · ${money(d.per)} a cycle`
    : fin < 0 ? 'Save'
    : changed ? `Save · by ${short(P.startOf(fin))}`
    : `Move to ${short(P.startOf(fin))}`

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div className="rw-sh-t"><span className="rw-savmark" aria-hidden="true" /><div>
        <h2 className="rw-sheet-title">{name}</h2>
        <div className="rw-sd">{head}</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>

      {!isPot && !reached && <div className="rw-card rw-sl-card">
        <div className="rw-pv-k"><span>Each cycle from {short(P.startOf(k0 + 1))}</span>{d.per !== goal.per_cycle_cents && d.restart == null && <span>plan {money(goal.per_cycle_cents)}</span>}</div>
        {d.restart == null ? <>
          <div className="rw-amt"><span>{sym}</span>
            <input type="number" inputMode="decimal" aria-label="Each cycle" value={d.per / 100}
              onChange={e => setD({ ...d, per: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)), catchUp: false })} /></div>
          <div className={`rw-gain${kD >= 0 && fin > kD ? ' flat' : ''}`}><b>{fin >= 0 ? `Saved by ${short(P.startOf(fin))}` : 'Not saved yet'}</b>
            <span>{kD >= 0 ? (fin > kD ? `after your ${short(goal.target_date)} date` : `your date is ${short(goal.target_date)}`) : fin >= 0 ? `${fin - k0} cycles` : ''}</span></div>
          {lo != null && <div className="rw-sl-tag">{overdrawn(lo) ? <span className="n">Overdrawn before pay {short(P.startOf(lowAt + 1))}</span> : <span className="w">Into your floor before pay {short(P.startOf(lowAt + 1))}</span>}</div>}
          <div className="rw-sl">
            <div className="sl-rail" />
            {fitPer != null && fitPer < hi && <div className="sl-zone" style={{ left: pct(fitPer) + '%', right: 0 }} />}
            <div className="sl-fill" style={{ width: pct(d.per) + '%' }} />
            {snaps.map(m => <div key={m.k} className={`sl-mk${d.per === m.v ? ' on' : ''}`} style={{ left: pct(m.v) + '%' }} />)}
            <input type="range" aria-label="Each cycle" aria-valuetext={`${money(d.per)} a cycle`} min={0} max={hi / 100} step={5}
              value={Math.min(hi, d.per) / 100} onChange={e => setPer(Math.round(+e.target.value * 100))} />
          </div>
          <div className="rw-ends">
            <button type="button" onClick={() => setPer(0)}><b>{money(0)}</b>pause</button>
            <button type="button" className="r" onClick={() => setPer(hi)}><b>{money(hi)}</b>top of range</button>
          </div>
          <div className="rw-snaps">
            {snaps.map(m => <button key={m.k} type="button" className={d.per === m.v && !d.catchUp ? 'on' : ''} onClick={() => setD({ ...d, per: m.v, catchUp: false })}>{m.k} {money(m.v)}</button>)}
            {d.skip && next && <button type="button" className={d.catchUp ? 'on' : ''} onClick={() => setD({ ...d, per: goal.per_cycle_cents, catchUp: true })}>Catch up next cycle</button>}
          </div>
          <div className="rw-lab">Saved by</div>
          <DateChips value={fin >= 0 ? P.startOf(fin) : ''} today={P.startOf(from)} min={P.startOf(early ?? from)} otherMin={P.startOf(from)} label="Saved by"
            payDates={[kD, early != null ? early + 13 : from + 13, early != null ? early + 26 : from + 26].filter(k => k > (early ?? from)).map(P.startOf).sort()}
            tagFor={v => { const k = P.kOf(v); return k === kD ? 'your date' : k === early ? 'earliest' : P.fits(P.project({ ...d, catchUp: false, per: perFor(rem, from, k) }), base) ? 'fits' : 'too soon' }}
            onChange={v => { setDated(true); setD({ ...d, catchUp: false, per: perFor(rem, from, Math.max(from, P.kOf(v))) }) }} />
        </> : <>
          <div className="rw-gain flat"><b>Paused</b><span>then {money(d.per)} a cycle · saved by <b>{fin >= 0 ? short(P.startOf(fin)) : '—'}</b></span></div>
          <div className="rw-lab">Start again</div>
          <DateChips value={P.startOf(d.restart)} today={P.startOf(k0 + 2)} payDates={[k0 + 3, k0 + 4, k0 + 6].map(P.startOf)} label="Start again"
            tagFor={v => { const n2 = P.kOf(v) - (P.done && !d.skip ? k0 + 1 : k0); return `${n2} cycle${n2 > 1 ? 's' : ''}` }}
            onChange={v => setD({ ...d, restart: Math.max(k0 + 2, P.kOf(v)) })} />
          <div className="rw-snaps">
            <button type="button" className={d.per === goal.per_cycle_cents ? 'on' : ''} onClick={() => setD({ ...d, per: goal.per_cycle_cents })}>Then {money(goal.per_cycle_cents)}</button>
            {kD >= d.restart && (() => { const v = perFor(rem, d.restart, kD); return <button type="button" className={d.per === v ? 'on' : ''} onClick={() => setD({ ...d, per: v })}>Keeps {short(goal.target_date)} {money(v)}</button> })()}
            <button type="button" onClick={() => setD({ ...d, restart: null, per: goal.per_cycle_cents })}>Don’t pause</button>
          </div>
        </>}
      </div>}

      {isPot && state === 'todo' && potNeed > 0 && <>
        <div className="rw-card rw-sl-card">
          <div className="rw-pv-k"><span>Put away {that.toLowerCase()} cycle</span>{now !== l0 && <span>planned {money(l0)}</span>}</div>
          <div className="rw-amt"><span>{sym}</span>
            <input type="number" inputMode="decimal" aria-label={`Put away ${that.toLowerCase()} cycle`} value={now / 100}
              onChange={e => setNow(Math.min(potNeed, Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100))))} /></div>
          <div className={`rw-gain${potShort > 0 ? ' flat' : ''}`}><b>{potShort > 0 ? `${money(potShort)} short` : `Ready by ${due ? short(due) : 'the due date'}`}</b>
            <span>{now === 0 ? 'skipped · the rest spreads over the cycles left' : now !== l0 ? 'the rest spreads over the cycles left' : `${money(potNeed)} still to put away`}</span></div>
          {potLo != null && <div className="rw-sl-tag">{overdrawn(potLo) ? <span className="n">Overdrawn before pay {short(P.startOf(potLowAt + 1))}</span> : <span className="w">Into your floor before pay {short(P.startOf(potLowAt + 1))}</span>}</div>}
          <div className="rw-sl">
            <div className="sl-rail" />
            {potFits != null && potFits < potNeed && <div className="sl-zone" style={{ left: potPct(potFits) + '%', right: 0 }} />}
            <div className="sl-fill" style={{ width: potPct(now) + '%' }} />
            <div className={`sl-mk${now === l0 ? ' on' : ''}`} style={{ left: potPct(l0) + '%' }} />
            <input type="range" aria-label={`Put away ${that.toLowerCase()} cycle`} aria-valuetext={money(now)} min={0} max={potNeed / 100} step={5}
              value={now / 100} onChange={e => setNow(Math.min(potNeed, Math.round(+e.target.value * 100)))} />
          </div>
          <div className="rw-ends">
            <button type="button" onClick={() => setNow(0)}><b>{money(0)}</b>skip</button>
            <button type="button" className="r" onClick={() => setNow(potNeed)}><b>{money(potNeed)}</b>all of it</button>
          </div>
          <div className="rw-snaps">
            <button type="button" className={now === l0 ? 'on' : ''} onClick={() => setNow(l0)}>Planned {money(l0)}</button>
            {potFits != null && potFits !== l0 && potFits !== potNeed && <button type="button" className={now === potFits ? 'on' : ''} onClick={() => setNow(potFits)}>Fits {money(potFits)}</button>}
            {potNeed !== l0 && <button type="button" className={now === potNeed ? 'on' : ''} onClick={() => setNow(potNeed)}>All of it {money(potNeed)}</button>}
          </div>
        </div>
        <Preview nowCents={potBase.slice(k0, k0 + potSpan).map(x => x.committedClosingBalanceCents)} newCents={potProj.slice(k0, k0 + potSpan).map(x => x.committedClosingBalanceCents)}
          payDates={Array.from({ length: potSpan }, (_, i) => P.startOf(k0 + i + 1))} floorCents={floorCents} money={money}
          title={`Before each payday until it’s due`} done={{ now: at(potReadyNow), next: at(potReady) }} doneLabel="ready"
          third={{ k: 'Due', v: due ? short(due) : '—', d: potShort > 0 ? `${money(potShort)} short` : 'ready in time', cls: potShort > 0 ? 'near' : 'good' }} tilesFirst />
      </>}
      {!isPot && !reached && <Preview nowCents={closes(base)} newCents={closes(proj)} payDates={payDates} floorCents={floorCents} money={money}
        title="Before each payday until it’s saved" third={third} done={{ now: at(baseFin), next: at(fin) }} doneLabel="saved" tilesFirst />}

      <div className="rw-group flush" style={{ marginTop: 10 }}>
        <div className="rw-row static">
          <div className="rw-tx"><div className="rw-row-name">{that} cycle · {money(state === 'skipped' || d.skip ? 0 : isPot && state === 'todo' ? now : l0)}</div>
            <div className="rw-sub">{state === 'done' ? <span className="rw-ok">Set aside ✓</span>
              : state === 'skipped' || d.skip ? (proj[k0] && base[k0] && proj[k0].creditPaymentCents > base[k0].creditPaymentCents + 50 ? `Skipped · the ${money(l0)} goes to your card` : 'Skipped')
              : reached ? 'Fully saved' : 'Not set aside yet'}</div></div>
          {state === 'done' ? <button type="button" className="rw-mini sec" disabled={busy} onClick={unsetAside}>Undo</button>
            : state === 'skipped' ? <button type="button" className="rw-mini sec" disabled={busy} onClick={unskip}>Undo</button>
            : d.skip ? <button type="button" className="rw-mini sec" onClick={() => setD(base0)}>Undo</button>
            : l0 > 0 && <span className="rw-pair">
                <button type="button" className="rw-mini sec" disabled={busy || d.restart != null} onClick={isPot ? () => setNow(0) : skipDraft}>Skip</button>
                <button type="button" className="rw-mini" disabled={busy} onClick={setAside}>Set aside</button></span>}
        </div>
        <button type="button" className="rw-row" aria-expanded={openHist} onClick={() => setOpenHist(v => !v)}>
          <div className="rw-tx"><div className="rw-row-name">Savings progress</div>
            <div className="rw-sub">{money(have)}{isPot ? ' put away' : ` of ${money(goal.target_cents)}`}{missed ? ` · ${missed} missed` : ''}</div>
            {!isPot && <div className="rw-pb" aria-hidden="true"><i style={{ width: Math.min(100, have / Math.max(1, goal.target_cents) * 100) + '%' }} /></div>}</div>
          <span className={`rw-chev rw-turn${openHist ? ' on' : ''}`}>›</span></button>
        {openHist && <div className="rw-open">
          {past.length === 0 ? <div className="rw-sub">No earlier cycles yet.</div> : <>
            <div className="rw-cdots">
              {past.map(s2 => <button key={s2} type="button" className={`rw-cdot ${didSet(s2) ? 'ok' : 'miss'}`} disabled={busy} onClick={() => flip(s2)}
                aria-label={`${short(s2)}: ${didSet(s2) ? 'set aside' : 'missed'}. Tap to change.`}><i>{didSet(s2) ? '✓' : '–'}</i>{short(s2)}</button>)}
              <span className={`rw-cdot now${state === 'done' ? ' ok' : ''}`}><i>{state === 'done' ? '✓' : ''}</i>now</span>
            </div>
            <div className="rw-sub" style={{ marginTop: 8 }}>✓ set aside · – missed. Tap a past cycle to correct it.</div>
          </>}
          {!fixing ? <button type="button" className="rw-lnk" style={{ marginTop: 10 }} onClick={() => { setFixing(true); setD(base0) }}>Correct the amount saved</button> : <>
            <div className="rw-lab">Saved so far</div>
            <div className="rw-amt"><span>{sym}</span><input type="number" inputMode="decimal" aria-label="Amount saved so far" value={fixAmt} onChange={e => setFixAmt(e.target.value)} /></div>
            <div className="rw-hint" style={{ marginTop: 0 }}>What’s really put away for this today. Ticks from now on add to it.</div>
          </>}
        </div>}
        {(reached || wishItem) && <button type="button" className="rw-row" disabled={busy} onClick={finishGoal}>
          <div className="rw-tx"><div className="rw-row-name">{wishItem ? 'I’ve bought it' : 'Mark as done'}</div><div className="rw-sub">Closes the goal. The money already left your balance as you saved it.</div></div></button>}
        <button type="button" className="rw-row" disabled={busy} onClick={stop}>
          <div className="rw-tx"><div className="rw-row-name rw-danger">{isPot ? 'Stop putting money away' : 'Stop saving'}</div><div className="rw-sub">What’s saved stays recorded</div></div></button>
      </div>

      <div className="rw-ctas">
        {fixing ? <>
          <button type="button" className="rw-cta sec" onClick={() => setFixing(false)}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy || fixCents === have} onClick={saveFix}>{busy ? 'Saving…' : `Save ${money(fixCents)}`}</button>
        </> : isPot && state === 'todo' && now !== l0 ? <>
          <button type="button" className="rw-cta sec" onClick={() => setNow(l0)}>Cancel</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={savePot}>{busy ? 'Saving…' : <>{now === 0 ? `Skip ${that.toLowerCase()} cycle` : `Put away ${money(now)} ${that.toLowerCase()} cycle`}{potLo != null && overdrawn(potLo) ? ' anyway' : ''}</>}</button>
        </> : dirty && !isPot ? <>
          <button type="button" className="rw-cta sec" onClick={() => changed ? (setD(base0), setDated(!!goal.target_date)) : onClose()}>{changed ? 'Cancel' : 'Not now'}</button>
          <button type="button" className="rw-cta" disabled={busy} onClick={savePlan}>{busy ? 'Saving…' : <>{cta}{lo != null && overdrawn(lo) ? ' anyway' : ''}</>}</button>
        </> : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}

