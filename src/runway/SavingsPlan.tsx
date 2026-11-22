import { useEffect, useMemo, useState } from 'react'
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

/**
 * Plan › Savings (Journey 4, release 6; mock claude/pp-savings-6.html,
 * signed off 22 Nov).
 *
 *   Needs you              an expense ahead that takes a payday under the
 *                          floor (the engine's billPrompts), with Options
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
  const [open, setOpen] = useState<{ kind: 'goal' | 'prompt' | 'add'; id?: string } | null>(null)
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
          <div className="rw-sub">{g.expense_id ? `${money(h)} put away${exp ? ` for ${exp.name}` : ''}` : `${money(h)} of ${money(g.target_cents)}`}</div>
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

      {prompts.length > 0 && <>
        <div role="heading" aria-level={2} className="rw-dl needs">Needs you<b>{prompts.length}</b><span>coming up</span></div>
        <div className="rw-group">
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

      {open?.kind === 'goal' && open.id && <SavingsSheet accountId={accountId} goalId={open.id} rows={rows} onClose={() => setOpen(null)} />}
      {open?.kind === 'prompt' && prompt && <OptionsSheet prompt={prompt} rows={rows} accountId={accountId} floorCents={floorCents} money={money} short={short} onClose={() => setOpen(null)} />}
      {open?.kind === 'add' && <AddGoalSheet accountId={accountId} startCycle={c0.startDate} sym={sym} money={money} onClose={() => setOpen(null)} />}
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
function AddGoalSheet({ accountId, startCycle, sym, money, onClose }: { accountId: string; startCycle: string; sym: string; money: (c: number) => string; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(''), [target, setTarget] = useState(''), [per, setPer] = useState(''), [busy, setBusy] = useState(false)
  const t = Math.round((parseFloat(target) || 0) * 100), p = Math.round((parseFloat(per) || 0) * 100)
  const n = t > 0 && p > 0 ? Math.ceil(t / p) : 0
  async function add() {
    if (!name.trim() || !t || !p || busy) return
    setBusy(true)
    try {
      const g = await createSavingsGoal(accountId, { name: name.trim(), target_cents: t, per_cycle_cents: p, cycles_total: n, start_cycle_start: startCycle })
      toast(`${name.trim()}: saving ${money(p)} a cycle`, { undo: async () => { await deleteSavingsGoal(g.id); notifyDataChanged() } })
      notifyDataChanged(); onClose()
    } catch (e: any) { reportError('That goal wasn’t added.', e) }
    finally { setBusy(false) }
  }
  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><h2 className="rw-sheet-title">New goal</h2><button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Emergency fund" autoFocus />
      <div className="rw-lab">How much in total</div>
      <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" placeholder="0" aria-label="How much in total" value={target} onChange={e => setTarget(e.target.value)} /></div>
      <div className="rw-lab">Set aside each cycle</div>
      <div className="rw-amtrow"><span>{sym}</span><input type="number" inputMode="decimal" placeholder="0" aria-label="Set aside each cycle" value={per} onChange={e => setPer(e.target.value)} /></div>
      {n > 0 && <div className="rw-hint">{n} cycle{n > 1 ? 's' : ''}, starting this one.</div>}
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={!name.trim() || !t || !p || busy} onClick={add}>{busy ? 'Saving…' : `Add ${name.trim() || 'goal'}`}</button>
      </div>
    </Sheet>
  )
}
