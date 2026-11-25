import { useEffect, useMemo, useState } from 'react'
import SheetGuard from './SheetGuard'
import Sheet, { reportError } from './Sheet'
import { useAccount } from '../lib/AccountContext'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { loadForecast, projectFromRows, billPromptsFromRows, type ForecastResult } from '../lib/forecast'
import { savedSoFarCents } from '../lib/savings'
import {
  confirmSavingsContribution, unconfirmSavingsContribution, createSavingsGoal, createBillPot, deleteSavingsGoal,
  acceptDip, clearAcceptedDip, setCreditExtraOverride, clearCreditExtraOverride,
} from '../lib/repository'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { notifyDataChanged, useDataChanged } from '../lib/dataEvents'
import { useToast } from './toastContext'
import Preview from './Preview'
import { Segmented, TextField } from './controls'
import SavingsSheet from './SavingsSheet'
import { saveDraft } from '../lib/savingsSave'
import { DateChips } from './controls'
import { makePlanner, perFor, savingsDip, type Draft } from '../lib/savingsPlan'
import { overdrawn } from '../engine/floor'

/**
 * Plan › Savings (Journey 4, release 6; mock claude/pp-savings-6.html,
 * signed off 22 Nov).
 *
 *   Needs you              a goal behind its date (release 6b); a payday
 *                          the goals' set-asides take under the floor
 *                          (release 6b); an expense ahead that takes a
 *                          payday under the floor (the engine's
 *                          billPrompts), with Options
 *   Set aside so far       and this cycle's total, with Mark all set aside
 *   Goals                  saving up
 *   Put away for expenses  pots for an expense
 *
 * The options for an expense are only the ones that change something, as the
 * engine decides: put money away (when that fixes the payday), the card pays
 * less that cycle (when there's an extra to pay less of), or pay it on the
 * day and let that payday dip.
 */

const NUM_CYCLES = 27
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))

export default function SavingsPlan({ accountId }: { accountId: string }) {
  const { activeAccount } = useAccount()
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  const [rows, setRows] = useState<ForecastResult | null>(null)
  const [error, setError] = useState('')
  async function load() {
    try { setRows(await loadForecast(accountId, floorCents, { numCycles: NUM_CYCLES })); setError('') }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [accountId, floorCents])
  useDataChanged(load)
  if (error) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">{error}</div></div></div>
  if (!rows) return <div className="rw-page"><div className="rw-page-head"><div className="rw-sd">Loading…</div></div></div>
  return <Body rows={rows} accountId={accountId} floorCents={floorCents} fmt={moneyFormatter(activeAccount?.currency_code)} sym={currencySymbol(activeAccount?.currency_code)} />
}

function Body({ rows, accountId, floorCents, fmt, sym }: {
  rows: ForecastResult; accountId: string; floorCents: number; fmt: (c: number, minor?: boolean) => string; sym: string
}) {
  const toast = useToast()
  const money = (c: number) => (c < 0 ? '−' : '') + fmt(Math.abs(c), false)
  const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
  const [open, setOpen] = useState<{ kind: 'goal' | 'prompt' | 'add' | 'dip'; id?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const c0 = rows.cycles[0]
  const active = rows.savingsGoalRows.filter((g: any) => g.is_active !== false && (g.status ?? 'active') === 'active')
  const lineOf = (g: any) => c0.savingsLines.find(l => l.goalId === g.id)?.amountCents ?? 0
  const isDone = (g: any) => (rows.savingsContributionRows ?? []).some((x: any) => x.savings_goal_id === g.id && x.cycle_start === c0.startDate)
  const isSkipped = (g: any) => (rows.savingsOverrideRows ?? []).some((o: any) => o.savings_goal_id === g.id && o.cycle_start === c0.startDate && o.amount_cents === 0)
  const have = (g: any) => savedSoFarCents(g, rows.savingsContributionRows, rows.savingsOverrideRows)
  const goals = active.filter((g: any) => !g.expense_id), pots = active.filter((g: any) => g.expense_id)
  const dueNow = active.filter((g: any) => lineOf(g) > 0)
  const todo = dueNow.filter((g: any) => !isDone(g))
  const total = active.reduce((s: number, g: any) => s + have(g), 0)
  const thisCycle = dueNow.reduce((s: number, g: any) => s + lineOf(g), 0)

  // One row per expense: its first payday under the floor.
  const prompts = useMemo(() => {
    const all = billPromptsFromRows(rows, floorCents, NUM_CYCLES)
    return all.filter((p, i) => all.findIndex(q => q.expenseId === p.expenseId) === i)
  }, [rows, floorCents])
  const prompt = prompts.find(p => p.expenseId === open?.id)

  // Each goal's "saved by" as the forecast has it, against its date (release 6b).
  const status = useMemo(() => new Map(goals.map((g: any) => {
    const P = makePlanner(rows, g, accountId, floorCents, 0, have(g))
    const fin = P.finishOf(rows.cycles, g.per_cycle_cents)
    return [g.id, { fin: fin >= 0 ? P.startOf(fin) : null, behind: !!g.target_date && fin > P.kOf(g.target_date) }]
  })), [rows])
  const late = goals.filter((g: any) => status.get(g.id)?.behind)
  // A payday the goals' set-asides take under the floor (a pay drop, a new expense).
  const without = useMemo(() => projectFromRows({ ...rows, savingsGoalRows: rows.savingsGoalRows.filter((g: any) => g.expense_id) }, floorCents, rows.cycles.length), [rows])
  const projected = useMemo(() => projectFromRows(rows, floorCents, rows.cycles.length), [rows])
  const dipK = useMemo(() => goals.length ? savingsDip(projected, without, floorCents) : -1, [projected, without])
  const needs = prompts.length + late.length + (dipK >= 0 ? 1 : 0)

  async function markAll() {
    if (busy || !todo.length) return
    setBusy(true)
    try {
      for (const g of todo) await confirmSavingsContribution(g.id, accountId, c0.startDate, g.expense_id ? lineOf(g) : null)
      toast(`All set aside for this cycle: ${money(todo.reduce((s: number, g: any) => s + lineOf(g), 0))}`, { undo: async () => {
        for (const g of todo) await unconfirmSavingsContribution(g.id, c0.startDate); notifyDataChanged() } })
      notifyDataChanged()
    } catch (e: any) { reportError('That wasn’t saved.', e) }
    finally { setBusy(false) }
  }

  const row = (g: any) => {
    const done = isDone(g), skipped = isSkipped(g), h = have(g), exp = g.expense_id ? rows.expenseRows.find((e: any) => e.id === g.expense_id) : null
    return (
      <button key={g.id} type="button" className="rw-row" onClick={() => setOpen({ kind: 'goal', id: g.id })}>
        <span className="rw-savmark" aria-hidden="true" />
        <div className="rw-tx"><div className="rw-row-name">{g.name ?? exp?.name}</div>
          <div className="rw-sub">{g.expense_id ? `${money(h)} put away${exp ? ` for ${exp.name}` : ''}` : <>{money(h)} of {money(g.target_cents)} · {g.target_date
            ? <>by {short(g.target_date)}{status.get(g.id)?.behind ? <> · <span className="rw-warn">behind</span></> : ''}</>
            : <>no date{status.get(g.id)?.fin ? ` · yours ${short(status.get(g.id)!.fin!)}` : ''}</>}</>}</div>
          {!g.expense_id && <div className="rw-pb" aria-hidden="true"><i style={{ width: Math.min(100, h / Math.max(1, g.target_cents) * 100) + '%' }} /></div>}</div>
        <div className="rw-am">{skipped ? '' : money(lineOf(g))}<small className={done ? 'rw-ok' : ''}>{done ? 'set aside ✓' : skipped ? 'skipped' : lineOf(g) > 0 ? 'this cycle' : 'nothing this cycle'}</small></div>
        <span className="rw-chev">›</span>
      </button>
    )
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head rw-head-row">
        <h1 className="rw-page-title">Savings</h1>
        <button type="button" className="rw-addb" onClick={() => setOpen({ kind: 'add' })}>+ Goal</button>
      </div>

      {needs > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl needs">Needs you<b>{needs}</b><span>coming up</span></div>
        <div className="rw-group">
          {late.map((g: any) => (
            <div key={g.id} className="rw-row needs">
              <button type="button" className="rw-row-main" onClick={() => setOpen({ kind: 'goal', id: g.id })}>
                <span className="rw-savmark" aria-hidden="true" style={{ opacity: .45 }} />
                <div className="rw-tx"><div className="rw-row-name">{g.name} · behind</div>
                  <div className="rw-sub"><span className="rw-warn">Saved by {status.get(g.id)?.fin ? short(status.get(g.id)!.fin!) : 'later'}, not {short(g.target_date)}</span></div></div>
              </button>
              <button type="button" className="rw-mini sec" aria-label={`Options · ${g.name}`} onClick={() => setOpen({ kind: 'goal', id: g.id })}>Options</button>
            </div>
          ))}
          {dipK >= 0 && (() => { const v = projected[dipK].committedClosingBalanceCents; return (
            <div className="rw-row needs">
              <button type="button" className="rw-row-main" onClick={() => setOpen({ kind: 'dip' })}>
                <span className="rw-savmark" aria-hidden="true" style={{ opacity: .45 }} />
                <div className="rw-tx"><div className="rw-row-name">Before pay {short(shift(rows.cycles[dipK].endDate, 1))}</div>
                  <div className="rw-sub"><span className="rw-warn">{overdrawn(v) ? `${money(-v)} overdrawn` : `${money(floorCents - v)} under your floor`} · from savings</span></div></div>
              </button>
              <button type="button" className="rw-mini sec" aria-label="Options · that payday" onClick={() => setOpen({ kind: 'dip' })}>Options</button>
            </div>) })()}
          {prompts.map(p => (
            // Cycle's structure: the row's own button, and Options beside it, never inside it.
            <div key={p.expenseId} className="rw-row needs">
              <button type="button" className="rw-row-main" onClick={() => setOpen({ kind: 'prompt', id: p.expenseId })}>
                <span className="rw-savmark" aria-hidden="true" style={{ opacity: .45 }} />
                <div className="rw-tx"><div className="rw-row-name">{p.name} · {money(p.billCents)}</div>
                  <div className="rw-sub"><span className="rw-warn">{short(p.dueDates[0])} · {p.closingCents < 0 ? `${money(-p.closingCents)} overdrawn` : `${money(p.shortCents)} under your floor`} before pay {short(shift(p.cycleEnd, 1))}</span></div></div>
              </button>
              <button type="button" className="rw-mini sec" aria-label={`Options · ${p.name}`} onClick={() => setOpen({ kind: 'prompt', id: p.expenseId })}>Options</button>
            </div>
          ))}
        </div>
      </>}

      <div className="rw-card" style={{ margin: '4px 16px 0' }}>
        <div className="rw-pv-k"><span>Set aside so far</span></div>
        <div className="rw-big-amt">{money(total)}</div>
        <div className="rw-line"><span>This cycle: <b>{money(thisCycle)}</b> · {dueNow.length - todo.length} of {dueNow.length} done</span>
          {todo.length > 0 && <button type="button" className="rw-mini sec" disabled={busy} onClick={markAll}>Mark all set aside</button>}</div>
      </div>

      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Goals · {goals.length}</span></div>
      <div className="rw-group">
        {goals.length === 0 && <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">Nothing yet. A goal is for saving with nothing to buy, like an emergency fund. Things to buy start on the Wishlist.</div></div></div>}
        {goals.map(row)}
      </div>
      {pots.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Put away for expenses · {pots.length}</span><span>from Expenses</span></div>
        <div className="rw-group">{pots.map(row)}</div>
      </>}

      {open?.kind === 'goal' && open.id && <SheetGuard onClose={() => setOpen(null)}><SavingsSheet accountId={accountId} goalId={open.id} rows={rows} onClose={() => setOpen(null)} /></SheetGuard>}
      {open?.kind === 'prompt' && prompt && <OptionsSheet prompt={prompt} rows={rows} accountId={accountId} floorCents={floorCents} money={money} short={short} onClose={() => setOpen(null)} />}
      {open?.kind === 'add' && <SheetGuard onClose={() => setOpen(null)}><AddGoalSheet accountId={accountId} rows={rows} floorCents={floorCents} sym={sym} money={money} short={short} onClose={() => setOpen(null)} /></SheetGuard>}
      {open?.kind === 'dip' && dipK >= 0 && <SheetGuard onClose={() => setOpen(null)}><DipSheet k={dipK} rows={rows} base={projected} without={without} goals={goals} have={have} accountId={accountId} floorCents={floorCents} money={money} short={short} onClose={() => setOpen(null)} /></SheetGuard>}
    </div>
  )
}

/* ── an expense ahead: only the options that change something ── */
function OptionsSheet({ prompt: p, rows, accountId, floorCents, money, short, onClose }: {
  prompt: ReturnType<typeof billPromptsFromRows>[number]; rows: ForecastResult; accountId: string; floorCents: number
  money: (c: number) => string; short: (d: string) => string; onClose: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const card = rows.creditCard
  const ways = [
    ...(p.setAside ? [{ value: 'away' as const, label: 'Put money away' }] : []),
    ...(p.cardCanReduceCents > 0 && card ? [{ value: 'card' as const, label: 'Card pays less' }] : []),
    { value: 'day' as const, label: 'Pay it on the day' },
  ]
  const [w, setW] = useState<'away' | 'card' | 'day'>(ways[0].value)
  const k = rows.cycles.findIndex(c => c.startDate === p.cycleStart)
  const N = Math.min(rows.cycles.length, k + 5)
  const base = useMemo(() => projectFromRows(rows, floorCents, rows.cycles.length), [rows])
  const pot = useMemo(() => p.setAside ? projectFromRows({ ...rows, savingsGoalRows: [...rows.savingsGoalRows, {
    id: '__pot', account_id: accountId, expense_id: p.expenseId, name: p.name, target_cents: 0, per_cycle_cents: 0, cycles_total: 0,
    start_cycle_start: rows.cycles[0].startDate, status: 'active', is_active: true }] }, floorCents, rows.cycles.length) : null, [rows])
  const extraNow = rows.cycles[k]?.creditExtraCents ?? 0
  const cardLess = Math.min(p.cardCanReduceCents, extraNow)
  const cut = useMemo(() => card && cardLess > 0 ? projectFromRows({ ...rows, creditOverrideRows: [
    ...(rows.creditOverrideRows ?? []).filter((o: any) => o.cycle_start !== p.cycleStart),
    { credit_account_id: card.id, account_id: accountId, cycle_start: p.cycleStart, extra_cents: extraNow - cardLess, choice: 'extra' }] }, floorCents, rows.cycles.length) : null, [rows])
  const interest = (x: typeof base) => x.reduce((s, c) => s + (c.creditInterestCents ?? 0), 0)
  const clearIdx = (x: typeof base) => x.findIndex(c => c.creditOpeningBalanceCents > 0 && c.creditClosingBalanceCents <= 0)
  const chosen = w === 'away' ? pot! : w === 'card' ? cut! : base
  const payDay = short(shift(p.cycleEnd, 1))
  const later = clearIdx(chosen) >= 0 && clearIdx(base) >= 0 ? clearIdx(chosen) - clearIdx(base) : 0
  const more = interest(chosen) - interest(base)
  const firstAway = p.setAside?.firstCycleCents ?? 0

  async function go() {
    if (busy) return
    setBusy(true)
    try {
      if (w === 'away') {
        const g = await createBillPot(accountId, { expense_id: p.expenseId, name: p.name, start_cycle_start: rows.cycles[0].startDate })
        toast(`Putting money away for ${p.name}`, { undo: async () => { await deleteSavingsGoal(g.id); notifyDataChanged() } })
      } else if (w === 'card' && card) {
        const was = (rows.creditOverrideRows ?? []).find((o: any) => o.cycle_start === p.cycleStart)
        await setCreditExtraOverride(card.id, accountId, p.cycleStart, extraNow - cardLess)
        toast(`The card pays ${money(cardLess)} less that cycle`, { undo: async () => {
          was ? await setCreditExtraOverride(card.id, accountId, p.cycleStart, was.extra_cents, was.choice) : await clearCreditExtraOverride(card.id, p.cycleStart); notifyDataChanged() } })
      } else {
        await acceptDip(accountId, p.expenseId, p.cycleStart)
        toast(`${p.name}: paid on the day. ${payDay} stays marked on Forecast.`, { undo: async () => { await clearAcceptedDip(p.expenseId, p.cycleStart); notifyDataChanged() } })
      }
      notifyDataChanged(); onClose()
    } catch (e: any) { reportError('That wasn’t saved.', e) }
    finally { setBusy(false) }
  }

  const left = chosen[k]?.committedClosingBalanceCents ?? 0
  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div className="rw-sh-t"><span className="rw-savmark" aria-hidden="true" /><div>
        <h2 className="rw-sheet-title">{p.name}</h2>
        <div className="rw-sd">{money(p.billCents)} on {short(p.dueDates[0])} · from Expenses</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      {ways.length > 1 && <Segmented value={w} onChange={setW} options={ways} />}
      <div className="rw-result" style={{ padding: '10px 2px 2px' }}>
        {w === 'away' && <><b>About {money(firstAway)} a cycle</b> from now · {payDay} {left >= floorCents ? `stays at ${money(left)}` : `comes to ${money(left)}`}
          {later > 0 && <> · the card gets less each cycle, so it clears {later} pay{later > 1 ? 's' : ''} later: <b>{money(more)} more card interest</b></>}</>}
        {w === 'card' && <><b>{money(cardLess)} less</b> on the card that cycle · {payDay} {left >= floorCents ? `stays at ${money(left)}` : `comes to ${money(left)}`}
          {more > 0 && <> · <b>{money(more)} more card interest</b></>}</>}
        {w === 'day' && (p.closingCents < 0
          ? <><span className="rw-u">{money(-p.closingCents)} overdrawn</span> before pay {payDay}. Nothing changes before then.</>
          : <>{payDay} dips <b>{money(p.shortCents)}</b> into your floor. Nothing changes before then.</>)}
      </div>
      <Preview nowCents={base.slice(0, N).map(c => c.committedClosingBalanceCents)} newCents={chosen.slice(0, N).map(c => c.committedClosingBalanceCents)}
        payDates={base.slice(0, N).map(c => shift(c.endDate, 1))} floorCents={floorCents} money={money} />
      {!p.setAside && <div className="rw-hint">Putting money away isn’t offered: spreading it over the cycles before then wouldn’t keep {payDay} above your floor without taking an earlier payday under it.</div>}
      {p.setAside && !(p.cardCanReduceCents > 0 && card) && card && <div className="rw-hint">Paying the card less that cycle isn’t offered: there’s no extra payment that cycle to pay less of.</div>}
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Not now</button>
        <button type="button" className="rw-cta" disabled={busy} onClick={go}>{busy ? 'Saving…'
          : w === 'away' ? `Put money away` : w === 'card' ? `Pay ${money(cardLess)} less` : `Pay it on the day${p.closingCents < 0 ? ' anyway' : ''}`}</button>
      </div>
    </Sheet>
  )
}

/* ── + Goal: saving with nothing to buy (things to buy start on the Wishlist) ── */
/* ── New goal: the goal sheet's controls (release 6b). It starts next cycle and
 * opens at the earliest "saved by" that fits; every new goal gets a date. ── */
function AddGoalSheet({ accountId, rows, floorCents, sym, money, short, onClose }: {
  accountId: string; rows: ForecastResult; floorCents: number; sym: string; money: (c: number) => string; short: (d: string) => string; onClose: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState(''), [tot, setTot] = useState(''), [busy, setBusy] = useState(false)
  const target = Math.max(0, Math.round((parseFloat(tot) || 0) * 100))
  const start = rows.cycles[1]?.startDate ?? rows.cycles[0].startDate
  const mk = (per: number) => ({ id: '__new', account_id: accountId, name: name || 'New goal', target_cents: target, per_cycle_cents: per,
    cycles_total: 0, start_cycle_start: start, status: 'active', is_active: true })
  const plannerFor = (per: number) => {
    const r = { ...rows, savingsGoalRows: [...rows.savingsGoalRows, mk(per)] }
    return makePlanner(r, mk(per), accountId, floorCents, 0, 0)
  }
  const P = useMemo(() => plannerFor(10000), [rows, target])
  const ref = useMemo(() => projectFromRows(rows, floorCents, rows.cycles.length), [rows])
  const projFor = (per: number) => P.project({ per, skip: false, catchUp: false, restart: null })
  const early = useMemo(() => {
    if (!target) return null
    for (let k = 1; k < P.n + 26; k++) if (P.fits(projFor(perFor(target, 1, k)), ref)) return k
    return null
  }, [P, target])
  const fitPer = early != null ? perFor(target, 1, early) : null
  const [pick, setPick] = useState<number | null>(null)
  const per = pick ?? fitPer ?? perFor(target, 1, 26)
  const proj = useMemo(() => target ? projFor(per) : ref, [P, per])
  const fin = target ? P.finishOf(proj, per) : -1
  const lowAt = P.lowest(proj, ref), lo = lowAt >= 0 ? proj[lowAt].committedClosingBalanceCents : null
  const hi = Math.ceil(Math.max((fitPer ?? 0) * 1.5, per + 5000, 30000) / 5000) * 5000
  const pct = (v: number) => Math.min(100, Math.max(0, v / hi * 100))
  const cardMoves = proj.reduce((s2, x, k) => s2 + Math.abs((x.creditPaymentCents ?? 0) - (ref[k]?.creditPaymentCents ?? 0)), 0) >= 100
  const clNow = P.clearedAt(ref), clNew = P.clearedAt(proj), dC = clNew >= 0 && clNow >= 0 ? clNew - clNow : 0
  const span = Math.min(rows.cycles.length, Math.max(8, fin + 2, cardMoves && clNew >= 0 ? clNew + 2 : 0))
  const third = cardMoves
    ? { k: 'Card cleared', v: clNew >= 0 ? short(P.startOf(clNew + 1)) : 'Later', d: dC ? `${Math.abs(dC)} cycle${Math.abs(dC) > 1 ? 's' : ''} ${dC > 0 ? 'later' : 'sooner'}` : 'no change', cls: dC > 0 ? 'near' : '' }
    : { k: 'Saved by', v: fin >= 0 ? short(P.startOf(fin)) : '—', d: `${Math.max(0, fin)} cycles` }
  async function add() {
    if (!name.trim() || !target || !per || busy) return
    setBusy(true)
    try {
      const g = await createSavingsGoal(accountId, { name: name.trim(), target_cents: target, per_cycle_cents: per, cycles_total: Math.max(1, fin),
        start_cycle_start: start, target_date: fin >= 0 ? P.startOf(fin) : null })
      toast(`${name.trim()}: ${money(per)} a cycle${fin >= 0 ? `, by ${short(P.startOf(fin))}` : ''}`, { undo: async () => { await deleteSavingsGoal(g.id); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { reportError('That goal wasn’t added.', e) }
    finally { setBusy(false) }
  }
  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><h2 className="rw-sheet-title">New goal</h2><button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <TextField label="Name" value={name} onChange={setName} placeholder="Emergency fund" autoFocus />
      <div className="rw-lab">How much in total</div>
      <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" placeholder="0" aria-label="How much in total" value={tot} onChange={e => { setTot(e.target.value); setPick(null) }} /></div>
      {target > 0 && <>
        <div className="rw-card rw-sl-card">
          <div className="rw-pv-k"><span>Each cycle from {short(start)}</span></div>
          <div className="rw-amt"><span>{sym}</span>
            <input type="number" inputMode="decimal" aria-label="Each cycle" value={per / 100} onChange={e => setPick(Math.max(100, Math.round((parseFloat(e.target.value) || 0) * 100)))} /></div>
          <div className="rw-gain"><b>{fin >= 0 ? `Saved by ${short(P.startOf(fin))}` : 'Not within the forecast'}</b><span>{fin >= 0 ? `${fin} cycles` : ''}</span></div>
          {lo != null && <div className="rw-sl-tag">{overdrawn(lo) ? <span className="n">Overdrawn before pay {short(P.startOf(lowAt + 1))}</span> : <span className="w">Into your floor before pay {short(P.startOf(lowAt + 1))}</span>}</div>}
          <div className="rw-sl">
            <div className="sl-rail" />
            {fitPer != null && fitPer < hi && <div className="sl-zone" style={{ left: pct(fitPer) + '%', right: 0 }} />}
            <div className="sl-fill" style={{ width: pct(per) + '%' }} />
            {fitPer != null && <div className={`sl-mk${per === fitPer ? ' on' : ''}`} style={{ left: pct(fitPer) + '%' }} />}
            <input type="range" aria-label="Each cycle" aria-valuetext={`${money(per)} a cycle`} min={5} max={hi / 100} step={5}
              value={Math.min(hi, per) / 100} onChange={e => setPick(Math.round(+e.target.value * 100))} />
          </div>
          <div className="rw-ends">
            <button type="button" onClick={() => setPick(500)}><b>{money(500)}</b>smallest</button>
            <button type="button" className="r" onClick={() => setPick(hi)}><b>{money(hi)}</b>top of range</button>
          </div>
          {fitPer != null && <div className="rw-snaps"><button type="button" className={per === fitPer ? 'on' : ''} onClick={() => setPick(fitPer)}>Fits {money(fitPer)}</button></div>}
          <div className="rw-lab">Saved by</div>
          <DateChips value={fin >= 0 ? P.startOf(fin) : ''} today={P.startOf(1)} min={P.startOf(early ?? 1)} otherMin={P.startOf(1)} label="Saved by"
            payDates={[13, 26].map(x => (early ?? 1) + x).map(P.startOf)}
            tagFor={v => { const k = P.kOf(v); return k === early ? 'earliest' : P.fits(projFor(perFor(target, 1, k)), ref) ? 'fits' : 'too soon' }}
            onChange={v => setPick(perFor(target, 1, Math.max(1, P.kOf(v))))} />
        </div>
        <Preview nowCents={ref.slice(0, span).map(x => x.committedClosingBalanceCents)} newCents={proj.slice(0, span).map(x => x.committedClosingBalanceCents)}
          payDates={Array.from({ length: span }, (_, i) => P.startOf(i + 1))} floorCents={floorCents} money={money}
          title="Before each payday until it’s saved" third={third} done={{ now: null, next: fin >= 1 && fin - 1 < span ? fin - 1 : null }} doneLabel="saved" tilesFirst />
      </>}
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={!name.trim() || !target || busy} onClick={add}>{busy ? 'Saving…' : <>{`Add · ${money(per)} a cycle`}{lo != null && overdrawn(lo) ? ' anyway' : ''}</>}</button>
      </div>
    </Sheet>
  )
}

/* ── A payday the goals' set-asides take under the floor (release 6b). Pick one
 * goal to spread out: its date moves to the first that keeps every such
 * payday above the floor. Only goals that can do it on their own are offered. ── */
function DipSheet({ k, rows, base, without, goals, have, accountId, floorCents, money, short, onClose }: {
  k: number; rows: ForecastResult; base: ForecastResult['cycles']; without: ForecastResult['cycles']; goals: any[]; have: (g: any) => number; accountId: string; floorCents: number
  money: (c: number) => string; short: (d: string) => string; onClose: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const v = base[k].committedClosingBalanceCents
  const opts = useMemo(() => goals.map((g: any) => {
    const P = makePlanner(rows, g, accountId, floorCents, 0, have(g))
    if (!base.slice(0, k + 1).some((_c, j) => P.lineOf(base, j) > 0)) return null
    const d0: Draft = { per: g.per_cycle_cents, skip: false, catchUp: false, restart: null }
    const rem = P.remFrom(d0), fin = P.finishOf(base, g.per_cycle_cents)
    if (rem <= 0) return null
    for (let kD = Math.max(1, fin); kD < P.n + 26; kD++) {
      const d: Draft = { ...d0, per: perFor(rem, 1, kD) }
      const proj = P.project(d)
      if (savingsDip(proj, without, floorCents) < 0) return { g, P, d, proj, date: P.startOf(P.finishOf(proj, d.per)) }
    }
    return { g, P, d: null, proj: null, date: null }
  }).filter(Boolean) as any[], [rows])
  const [sel, setSel] = useState<string | null>(opts.find(o => o.d)?.g.id ?? null)
  const o = opts.find(x => x.g.id === sel)
  async function save() {
    if (!o?.d || busy) return
    setBusy(true)
    try {
      const r = await saveDraft(o.P, o.g, accountId, o.d, o.date)
      toast(`${o.g.name}: ${money(o.d.per)} a cycle, by ${short(o.date)}`, { undo: async () => { await r.undo(); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { reportError('That wasn’t saved.', e) }
    finally { setBusy(false) }
  }
  const span = Math.min(rows.cycles.length, Math.max(8, k + 3))
  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div className="rw-sh-t"><span className="rw-savmark" aria-hidden="true" /><div>
        <h2 className="rw-sheet-title">Before pay {short(shift(rows.cycles[k].endDate, 1))}</h2>
        <div className="rw-sd">{overdrawn(v) ? `${money(-v)} overdrawn` : `${money(floorCents - v)} under your floor`} · from savings</div></div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      {o?.proj && <Preview nowCents={base.slice(0, span).map(x => x.committedClosingBalanceCents)} newCents={o.proj.slice(0, span).map((x: any) => x.committedClosingBalanceCents)}
        payDates={Array.from({ length: span }, (_, i) => shift(rows.cycles[i].endDate, 1))} floorCents={floorCents} money={money} tilesFirst />}
      <div className="rw-result" style={{ padding: '8px 2px 10px' }}>{opts.some(x => x.d) ? 'Spread one goal out to fix it:' : 'No one goal fixes it on its own. Pause or lower one from its sheet.'}</div>
      <div className="rw-group flush" role="radiogroup" aria-label="Goal to spread out">
        {opts.map(x => (
          <button key={x.g.id} type="button" className="rw-row" role="radio" aria-checked={sel === x.g.id} disabled={!x.d} onClick={() => setSel(x.g.id)}>
            <div className="rw-tx"><div className="rw-row-name">{x.g.name}</div>
              <div className="rw-sub">{x.d ? <>{money(x.d.per)} a cycle · by {short(x.date)}</> : 'Not enough on its own'}</div></div>
            <span className={`rw-pick${sel === x.g.id ? ' on' : ''}`} aria-hidden="true">{sel === x.g.id ? '✓' : ''}</span></button>))}
      </div>
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Not now</button>
        <button type="button" className="rw-cta" disabled={!o?.d || busy} onClick={save}>{busy ? 'Saving…' : o?.d ? `Move ${o.g.name} to ${short(o.date)}` : 'Pick a goal'}</button>
      </div>
    </Sheet>
  )
}
