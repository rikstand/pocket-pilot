// forecast.ts — one place that turns an account into a projection.
//
// WHY THIS EXISTS
//
// Three pages needed a forecast — Cycle, Wishlist, Settings — and each grew
// its own copy of the same forty lines: fetch the rows, reshape them for the
// engine, call projectCycles. Nothing kept the copies in step, and they drifted
// twice:
//
//   1. Wishlist never loaded the credit card, so it forecast a bigger balance
//      than the Cycle screen. A savings plan could read "comfortable" and
//      breach the floor the moment it was committed.
//   2. Settings had the same omission, so its floor impact panel was measured
//      against money that was not there.
//
// Both were invisible on screen. Each page looked internally consistent; they
// only disagreed with each other. So the fix is not to remember harder — it is
// to have one function, and have every page call it.
//
// If a page needs something extra (lay-bys, budget entries, payment
// confirmations) it fetches that itself. This module owns the FORECAST, not
// everything a page might want.

import {
  getIncomeSources, getExpenses, getCycles, getCreditAccount, getCreditExtraOverrides, getCreditPlanVersions,
  getBudgetSpendEntries, getSavingsGoals, getAllSavingsContributions, getAllSavingsOverrides,
  getAllExpenseOverrides, getCreditCyclePayments, getAllIncomeOverrides, getAcceptedDips,
} from './repository'
import { projectCycles, budgetAmountForCycle, billPrompts, occurrencesOf, scheduleOn } from '../engine/index'
import type { CycleRule, BillPrompt } from '../engine/index'
import type {
  CycleResult, IncomeSource, Expense, CreditAccount, CreditExtraOverride,
  BudgetSpendEntry, ExpenseOverride, SavingsGoal, CreditPayment, IncomeOverride, ScheduleVersion, CreditPlanVersion,
} from '../engine/types'
import { carriedCardBalance, confirmedPaymentsFrom, cycleDaysOf, planModeOf, dueAnchorOf } from './creditSchedule'
import { formatDate, parseDate, addDays } from '../engine/dates'
import { byNewest, latestVersion, versionForDate } from './versions'
import { savedSoFarCents } from './savings'

// Never toISOString() — this app runs at UTC+12 and that has caused real bugs.
function todayStr() { return formatDate(new Date()) }

/**
 * Schedule changes from a date → what the engine expects. Newest written
 * first, so of two saved for the same date the newest wins — the same rule
 * as amounts.
 */
export function toEngineSchedules(rows: any[] | null | undefined): ScheduleVersion[] {
  return [...(rows ?? [])]
    .sort((a: any, b: any) => (a.created_at ?? '') > (b.created_at ?? '') ? -1 : (a.created_at ?? '') < (b.created_at ?? '') ? 1 : 0)
    .map((v: any) => ({
      effectiveFrom: v.effective_from,
      frequency: v.frequency,
      everyN: v.every_n ?? 1,
      anchorDate: v.anchor_date,
    }))
}

/**
 * Income rows → what the engine expects.
 *
 * Uses lib/versions rather than sorting here, so every page picks the same
 * amount. Sorting on effective_from alone loses the created_at tiebreak, which
 * decides between two versions dated the same day.
 */
export function toEngineIncome(rows: any[]): IncomeSource[] {
  return rows.map((src: any) => {
    const latest = latestVersion(src.income_amount_versions)
    // All the dated amounts, newest first, so each pay uses the one in force
    // on its own date — the same as expenses. Before, only the newest was
    // used, for every pay: a raise dated next month applied today, and a
    // "just this cycle" change never showed at all.
    const versions = [...(src.income_amount_versions ?? [])]
      .sort(byNewest)
      .map((v: any) => ({ amountCents: v.amount_cents, effectiveFrom: v.effective_from }))
    return {
      id: src.id,
      name: src.name,
      frequency: src.frequency,
      everyN: src.every_n ?? 1,
      anchorDate: src.anchor_date,
      amountCents: latest?.amount_cents ?? 0,
      amountVersions: versions,
      schedules: toEngineSchedules(src.income_schedule_versions),
      endDate: src.end_date ?? undefined,
      isPotential: src.is_potential ?? false,
      isPrimary: src.is_primary ?? false,
    }
  })
}

/** One-cycle amounts of pay → what the engine expects. */
export function toEngineIncomeOverrides(rows: any[]): IncomeOverride[] {
  return (rows ?? []).map((o: any) => ({
    incomeId: o.income_source_id,
    cycleStart: o.cycle_start,
    amountCents: o.amount_cents,
  }))
}

/** Expense rows → what the engine expects, versions and all. */
export function toEngineExpenses(rows: any[]): Expense[] {
  return rows.map((exp: any) => {
    // Sort the RAW rows (which carry created_at) before mapping into engine
    // shape, so the created_at tiebreak survives. The order handed to the
    // engine stays newest-first.
    const versions = [...(exp.expense_amount_versions ?? [])]
      .sort(byNewest)
      .map((v: any) => ({ amountCents: v.amount_cents, effectiveFrom: v.effective_from }))
    const latest = versions[0]
    return {
      id: exp.id,
      name: exp.name,
      frequency: exp.frequency,
      everyN: exp.every_n ?? 1,
      anchorDate: exp.anchor_date,
      amountCents: latest?.amountCents ?? 0,
      amountVersions: versions,
      mode: exp.mode ?? 'fixed',
      endDate: exp.end_date ?? undefined,
      schedules: toEngineSchedules(exp.expense_schedule_versions),
      // Missed BNPL payments: left out of the forecast (the repayment is its
      // own one-off). An undone miss deletes its row, so it counts again.
      skipDates: (exp.bnpl_missed_payments ?? []).map((m: any) => m.payment_date),
    }
  })
}

/**
 * Credit card row → what the engine expects.
 *
 * The engine ignores a card whose strategy is not committed, but the shape has
 * to be right either way — a missing paymentFrequency makes the whole object
 * fail to typecheck, which is how this was caught the first time.
 */
/** Dated card plans, oldest first. */
export function toEnginePlanVersions(rows: any[]): CreditPlanVersion[] {
  return (rows ?? [])
    .filter((r: any) => r.mode === 'minimum' || r.mode === 'extra' || r.mode === 'spare')
    .map((r: any) => ({ effectiveFrom: r.effective_from, mode: r.mode, extraCents: Number(r.extra_cents ?? 0) }))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
}

/**
 * The card row with the plan in force on a date written into its plan
 * columns, for code that reads those columns (the Credit page's working, the
 * balance carried to the first cycle). The engine reads dated plans itself.
 */
export function cardWithPlanOn(card: any, planRows: any[], date: string): any {
  if (!card) return card
  let best: any = null
  for (const v of planRows ?? []) if (v.effective_from <= date && (!best || v.effective_from > best.effective_from)) best = v
  return best ? { ...card, strategy_mode: best.mode, strategy_extra_cents: best.mode === 'extra' ? Number(best.extra_cents ?? 0) : 0 } : card
}

export function toEngineCredit(
  card: any | null,
  projectFrom?: any | null,
  paymentRows: any[] = [],
  planRows: any[] = []
): CreditAccount | null {
  if (!card) return null
  // The engine runs whole cycles from the start of the first open one, so it
  // needs the card balance AT that start — not the last figure typed in, which
  // may be from an earlier cycle or from partway through this one. Same
  // working as the Credit page, so the two show the same balance.
  // Between the last balance typed and that start, the plan in force at the
  // start is the best guess for what went out.
  const startBalance = projectFrom?.start_date
    ? carriedCardBalance(
        cardWithPlanOn(card, planRows, projectFrom.start_date), projectFrom.start_date,
        cycleDaysOf({ startDate: projectFrom.start_date, endDate: projectFrom.end_date ?? projectFrom.start_date }),
        confirmedPaymentsFrom(paymentRows)
      ).balanceCents
    : (card.current_balance_cents ?? 0)
  return {
    id: card.id,
    name: card.name,
    aprBasisPoints: card.apr_basis_points,
    minPaymentPct: Number(card.min_payment_pct),
    minPaymentFloorCents: card.min_payment_floor_cents,
    assumedSpendCents: card.assumed_spend_cents,
    strategyExtraCents: card.strategy_extra_cents ?? 0,
    strategyCommitted: card.strategy_committed,
    strategyMode: planModeOf(card),
    extraTiming: card.extra_timing === 'due_cycle' ? ('due_cycle' as const) : ('every_cycle' as const),
    planVersions: toEnginePlanVersions(planRows),
    currentBalanceCents: startBalance,
    paymentFrequency: card.payment_frequency ?? 'per_cycle',
    // The due DAY, applying to every month (see dueAnchorOf).
    paymentAnchorDate: dueAnchorOf(card) ?? undefined,
  }
}

/** Payments confirmed WITH an amount. Older rows without one follow the plan. */
export function toEngineCreditPayments(rows: any[]): CreditPayment[] {
  return (rows ?? [])
    .filter((r: any) => r.amount_cents != null)
    .map((r: any) => ({ cycleStart: r.cycle_start, amountCents: r.amount_cents }))
}

/** One-cycle choices. Rows from before the choice column read as a set extra. */
export function toEngineCreditOverrides(rows: any[]): CreditExtraOverride[] {
  return (rows ?? []).map((o: any) => ({
    cycleStart: o.cycle_start,
    extraCents: o.extra_cents ?? 0,
    choice: o.choice === 'spare' ? ('spare' as const) : ('extra' as const),
  }))
}

/** Logged budget spend → what the engine expects. */
export function toEngineBudgetSpend(rows: any[]): BudgetSpendEntry[] {
  return (rows ?? []).map((e: any) => ({
    expenseId: e.expense_id,
    amountCents: e.amount_cents,
    spentDate: e.spent_date,
  }))
}

/** One-cycle amounts (any expense) → what the engine expects. */
export function toEngineExpenseOverrides(rows: any[]): ExpenseOverride[] {
  return (rows ?? []).map((o: any) => ({
    expenseId: o.expense_id,
    cycleStart: o.cycle_start,
    amountCents: o.amount_cents,
  }))
}

/**
 * Savings goal rows → what the engine expects.
 *
 * The important part is savedSoFarCents. A goal's progress is what has actually
 * been CONFIRMED, not what was planned — that is the whole point of deriving
 * savings rather than storing them as an expense. A corrected total (you dipped
 * into it, or put extra in) wins over the confirmations, because it is a
 * statement about reality rather than about the plan.
 */
export function toEngineSavings(
  goalRows: any[],
  contributionRows: any[],
  overrideRows: any[],
  // Needed for pots that save for a bill: which bills, and where the
  // forecast starts. Without it a bill pot starts empty.
  bills?: { expenses: Expense[]; projectFrom: string }
): SavingsGoal[] {
  return (goalRows ?? [])
    .filter((g: any) => g.status === 'active' && g.is_active !== false)
    .map((g: any) => {
      const overrides = (overrideRows ?? [])
        .filter((o: any) => o.savings_goal_id === g.id)
        .map((o: any) => ({ cycleStart: o.cycle_start, amountCents: o.amount_cents }))

      // Each confirmed cycle counts for what went in that cycle: the amount
      // saved with it, else the override, else the standing amount.
      const amountOf = (c: any) => {
        if (c.amount_cents != null) return c.amount_cents
        const ov = overrides.find(o => o.cycleStart === c.cycle_start)
        return ov ? ov.amountCents : g.per_cycle_cents
      }
      const mine = (contributionRows ?? []).filter((c: any) => c.savings_goal_id === g.id)

      if (g.expense_id) {
        // A pot for a bill holds what went in since the bill last came out of
        // it, up to where the forecast starts. The forecast works out each
        // cycle's amount from there, so the goal's own target and amount are
        // not used.
        const exp = bills?.expenses.find(e => e.id === g.expense_id)
        const from = bills?.projectFrom
        let held = 0
        if (exp && from) {
          const before = formatDate(addDays(parseDate(from), -1))
          const back = formatDate(addDays(parseDate(from), -3 * 366))
          const last = occurrencesOf(exp, back, before).pop() ?? ''
          held = mine
            .filter((c: any) => c.cycle_start > last && c.cycle_start < from)
            .reduce((sum: number, c: any) => sum + amountOf(c), 0)
          // A corrected total made since the bill last came out wins.
          if (g.adjusted_total_cents != null && g.adjusted_at && g.adjusted_at.slice(0, 10) > last) {
            held = g.adjusted_total_cents
          }
        }
        return {
          id: g.id, name: g.name, targetCents: 0, perCycleCents: 0,
          startCycleStart: g.start_cycle_start, savedSoFarCents: held, overrides, expenseId: g.expense_id,
        }
      }

      return {
        id: g.id,
        name: g.name,
        targetCents: g.target_cents,
        perCycleCents: g.per_cycle_cents,
        startCycleStart: g.start_cycle_start,
        // One shared sum (lib/savings): a corrected total, plus every cycle
        // confirmed after it.
        savedSoFarCents: savedSoFarCents(g, contributionRows, overrideRows),
        overrides,
      }
    })
}

export interface ForecastResult {
  cycles: CycleResult[]
  /** The raw rows, for pages that need more than the projection. */
  incomeRows: any[]
  expenseRows: any[]
  storedCycles: any[]
  creditCard: any | null
  creditOverrideRows: any[]
  creditPaymentRows: any[]
  /** The card plan from a date (credit_plan_versions). Optional, as below. */
  creditPlanRows?: any[]
  budgetSpendRows: any[]
  expenseOverrideRows: any[]
  /** Optional so callers that build rows by hand still compile. */
  incomeOverrideRows?: any[]
  savingsGoalRows: any[]
  savingsContributionRows: any[]
  savingsOverrideRows: any[]
  /** Paydays the user chose to let dip for a bill. Optional, as above. */
  acceptedDipRows?: any[]
  /** The cycle the projection starts from — the first open one. */
  projectFrom: any | null
}

export interface ForecastOptions {
  numCycles?: number
  /**
   * Leave undefined to use the account's own floor. Settings passes 0 so it can
   * recompute breaches against a candidate floor without re-running the engine
   * on every keystroke — closing balances do not depend on the floor, only the
   * breach flag does.
   */
  safetyFloorCents?: number
}

/**
 * Load an account and project it forward.
 *
 * Every page that shows or reasons about future balances should use this. If
 * two screens ever disagree about a balance again, it will be because one of
 * them stopped calling this function.
 */
export async function loadForecast(
  accountId: string,
  floorCents: number,
  options: ForecastOptions = {}
): Promise<ForecastResult> {
  const numCycles = options.numCycles ?? 27

  const [
    incomeRows, expenseRows, storedCycles, creditCard, budgetSpendRows,
    savingsGoalRows, savingsContributionRows, savingsOverrideRows, expenseOverrideRows,
    incomeOverrideRows, acceptedDipRows,
  ] = await Promise.all([
    getIncomeSources(accountId),
    getExpenses(accountId),
    getCycles(accountId),
    getCreditAccount(accountId),
    getBudgetSpendEntries(accountId),
    getSavingsGoals(accountId),
    getAllSavingsContributions(accountId),
    getAllSavingsOverrides(accountId),
    getAllExpenseOverrides(accountId),
    getAllIncomeOverrides(accountId),
    getAcceptedDips(accountId),
  ])

  // Overrides, confirmed payments and dated plans only exist once a card
  // does, so this is a second round trip rather than part of the batch above.
  const [creditOverrideRows, creditPaymentRows, creditPlanRows] = creditCard
    ? await Promise.all([getCreditExtraOverrides(creditCard.id), getCreditCyclePayments(creditCard.id), getCreditPlanVersions(creditCard.id)])
    : [[], [], []]

  const openCycles  = storedCycles.filter((c: any) => !c.is_closed)
  const projectFrom = openCycles[0] ?? storedCycles[storedCycles.length - 1] ?? null

  const rows = {
    incomeRows, expenseRows, storedCycles, creditCard, creditOverrideRows, creditPaymentRows, creditPlanRows,
    budgetSpendRows, expenseOverrideRows, incomeOverrideRows,
    savingsGoalRows, savingsContributionRows, savingsOverrideRows, acceptedDipRows, projectFrom,
  }
  // A spare plan always keeps the account above its REAL floor, even when
  // the caller asks for breaches against a different one.
  const cycles = projectFromRows(rows, options.safetyFloorCents ?? floorCents, numCycles, floorCents)

  return {
    cycles,
    incomeRows,
    expenseRows,
    storedCycles,
    creditCard,
    creditOverrideRows,
    creditPaymentRows,
    creditPlanRows,
    budgetSpendRows,
    expenseOverrideRows,
    incomeOverrideRows,
    savingsGoalRows,
    savingsContributionRows,
    savingsOverrideRows,
    acceptedDipRows,
    projectFrom,
  }
}


/**
 * The projection from rows already loaded. loadForecast uses it, and so does
 * any "what would this do?" preview: change a copy of the rows, project again,
 * and the preview can never disagree with the real forecast.
 */
export function projectFromRows(
  rows: Omit<ForecastResult, 'cycles'>,
  safetyFloorCents: number,
  numCycles: number,
  // The floor a "whatever's spare" payment keeps the account above. Leave it
  // out and it is safetyFloorCents, which is right for every caller that
  // passes the account's own floor.
  spareFloorCents?: number
): CycleResult[] {
  return projectCycles(engineInputFromRows(rows, safetyFloorCents, numCycles, spareFloorCents))
}

function engineInputFromRows(
  rows: Omit<ForecastResult, 'cycles'>,
  safetyFloorCents: number,
  numCycles: number,
  spareFloorCents?: number
) {
  const expenses = toEngineExpenses(rows.expenseRows)
  const startDate = rows.projectFrom?.start_date ?? todayStr()
  return {
    spareFloorCents: spareFloorCents ?? safetyFloorCents,
    incomeSources: toEngineIncome(rows.incomeRows),
    expenses,
    openingBalanceCents: rows.projectFrom?.opening_balance_cents ?? 0,
    startDate,
    numCycles,
    safetyFloorCents,
    creditAccount: toEngineCredit(rows.creditCard, rows.projectFrom, rows.creditPaymentRows ?? [], rows.creditPlanRows ?? []),
    creditOverrides: toEngineCreditOverrides(rows.creditOverrideRows),
    creditPayments: toEngineCreditPayments(rows.creditPaymentRows ?? []),
    budgetSpend: toEngineBudgetSpend(rows.budgetSpendRows),
    expenseOverrides: toEngineExpenseOverrides(rows.expenseOverrideRows),
    incomeOverrides: toEngineIncomeOverrides(rows.incomeOverrideRows ?? []),
    savingsGoals: toEngineSavings(rows.savingsGoalRows, rows.savingsContributionRows, rows.savingsOverrideRows,
      { expenses, projectFrom: startDate }),
    // The account's first cycle: monthly cycles are counted from it.
    cycleAnchorDate: rows.storedCycles?.[0]?.start_date ?? undefined,
  }
}

/**
 * Bills that take a payday under the floor, and which ways out actually help.
 * Same rows, same input as the forecast, so the two can't disagree.
 */
export function billPromptsFromRows(
  rows: Omit<ForecastResult, 'cycles'>,
  safetyFloorCents: number,
  numCycles: number
): BillPrompt[] {
  const accepted = (rows.acceptedDipRows ?? []).map((r: any) => ({ expenseId: r.expense_id, cycleStart: r.cycle_start }))
  return billPrompts(engineInputFromRows(rows, safetyFloorCents, numCycles), accepted, formatDate(new Date()))
}

/**
 * Preview a budget change without saving it. "once" sets that cycle's budget;
 * "always" starts a new amount from that cycle and drops that cycle's one-off,
 * exactly as saving would. Other cycles' one-offs are kept — they were set on
 * purpose.
 */
export function previewBudgetChange(
  rows: Omit<ForecastResult, 'cycles'>,
  safetyFloorCents: number,
  numCycles: number,
  change: { expenseId: string; cycleStart: string; totalCents: number; perOccurrenceCents: number; scope: 'once' | 'always' }
): CycleResult[] {
  const keepOthers = (rows.expenseOverrideRows ?? []).filter((o: any) =>
    !(o.expense_id === change.expenseId && o.cycle_start === change.cycleStart))
  if (change.scope === 'once') {
    return projectFromRows({
      ...rows,
      expenseOverrideRows: [...keepOthers, {
        expense_id: change.expenseId, cycle_start: change.cycleStart, amount_cents: change.totalCents,
      }],
    }, safetyFloorCents, numCycles)
  }
  const expenseRows = (rows.expenseRows ?? []).map((e: any) => e.id !== change.expenseId ? e : {
    ...e,
    expense_amount_versions: [
      ...(e.expense_amount_versions ?? []).filter((v: any) => v.effective_from !== change.cycleStart),
      { amount_cents: change.perOccurrenceCents, effective_from: change.cycleStart, created_at: new Date().toISOString() },
    ],
  })
  return projectFromRows({ ...rows, expenseRows, expenseOverrideRows: keepOthers }, safetyFloorCents, numCycles)
}

/* ── labelling a cycle ────────────────────────────────────────────────
 * Numbering cycles 1, 2, 3 tells you nothing about when they are. These put
 * the date on the axis instead, and add the year only when the projection
 * runs past December — otherwise "16 Jun" next year looks like "16 Jun" this
 * year, which has already caused one list to appear out of order.
 */

/** Compact tick for a chart axis: "16Jun", or "16Jun 27" in a later year. */
export function cycleTickLabel(startDate: string, baseYear: number): string {
  const d = parseDate(startDate)
  const day = d.getDate()
  const mon = d.toLocaleDateString('en-NZ', { month: 'short' })
  const yr  = d.getFullYear()
  return yr === baseYear
    ? `${day}${mon}`
    : `${day}${mon} ${String(yr).slice(2)}`
}

/** Readable form for prose: "16 Jun", or "16 Jun 2027" in a later year. */
export function cycleDateLabel(startDate: string, baseYear: number): string {
  const d = parseDate(startDate)
  return d.toLocaleDateString('en-NZ', d.getFullYear() === baseYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The year the projection starts in — everything is labelled relative to it. */
export function baseYearOf(cycles: { startDate: string }[]): number {
  return cycles[0] ? parseDate(cycles[0].startDate).getFullYear() : new Date().getFullYear()
}

/* ── is a budget baseline still right? ────────────────────────────────
 *
 * The other half of the same problem. Overspending now shows up in the
 * forecast; this is for the opposite case — a baseline set higher than you
 * ever actually spend, which makes every cycle look tighter than it is and
 * pushes wishlist items out of reach for no real reason.
 *
 * The app does not quietly switch to using averages. A budget is a ceiling,
 * and a forecast built on averages would call things affordable right up until
 * the month you actually spend your limit. Instead it says what it sees and
 * leaves the baseline to you.
 */

export interface BaselineCheck {
  expenseId: string
  name: string
  baselineCents: number      // per cycle, as set
  averageCents: number       // per cycle, as actually spent
  cyclesCounted: number
  overBy: number             // how much higher the baseline is, as a fraction
}

/** Fewer than this and an average is noise, not a pattern. */
const MIN_CYCLES_FOR_ADVICE = 4
/** Ignore small gaps — a baseline should have some headroom in it. */
const MIN_GAP = 0.2

export function baselineChecks(
  expenseRows: any[],
  budgetSpendRows: any[],
  storedCycles: any[],
  // How pay repeats. Optional: without it a budget is counted purely as a
  // daily rate, which differs from the forecast only for a budget that repeats
  // exactly like the pay (a monthly budget on monthly pay) — by a few dollars.
  cycleRule?: CycleRule
): BaselineCheck[] {
  const closed = (storedCycles ?? []).filter((c: any) => c.is_closed)
  if (closed.length < MIN_CYCLES_FOR_ADVICE) return []

  const out: BaselineCheck[] = []

  for (const exp of expenseRows ?? []) {
    if ((exp.mode ?? 'fixed') !== 'budget') continue

    const latest = latestVersion(exp.expense_amount_versions)
    const amountNow = latest?.amount_cents ?? 0
    if (amountNow <= 0) continue

    // The budget as it is set NOW, run over every closed cycle as if it had
    // always been there — the question is whether today's setting fits how you
    // actually spend. Per cycle, using the same daily-rate rule as the
    // forecast, so a monthly budget on fortnightly pay compares like for like.
    const asSetNow = {
      ...toEngineExpenses([exp])[0],
      amountVersions: [],
      amountCents: amountNow,
      anchorDate: '1900-01-01',
      endDate: undefined,
    }

    // Only count cycles that have actually closed — a part-finished cycle
    // would drag the average down and make every budget look generous.
    let total = 0
    let baselineTotal = 0
    let counted = 0
    for (const cyc of closed) {
      baselineTotal += budgetAmountForCycle(asSetNow, cyc.start_date, cyc.end_date, cycleRule)
      const spent = (budgetSpendRows ?? [])
        .filter((e: any) =>
          e.expense_id === exp.id &&
          e.spent_date >= cyc.start_date &&
          e.spent_date <= cyc.end_date)
        .reduce((sum: number, e: any) => sum + e.amount_cents, 0)
      total += spent
      counted++
    }

    if (counted < MIN_CYCLES_FOR_ADVICE) continue

    const average = Math.round(total / counted)
    const baseline = Math.round(baselineTotal / counted)
    if (baseline <= 0) continue
    const gap = (baseline - average) / baseline
    if (gap < MIN_GAP) continue

    out.push({
      expenseId: exp.id,
      name: exp.name,
      baselineCents: baseline,
      averageCents: average,
      cyclesCounted: counted,
      overBy: gap,
    })
  }

  // Biggest gap first — that is the one distorting the forecast most.
  return out.sort((a, b) =>
    (b.baselineCents - b.averageCents) - (a.baselineCents - a.averageCents))
}


/**
 * How pay repeats on a date: the main pay's schedule then (the same pick the
 * engine makes: the flagged pay, else the first certain one). Budgets use it
 * to know whether they line up with the cycle.
 */
export function cycleRuleOn(incomeRows: any[], onDate: string): CycleRule {
  const src = (incomeRows ?? []).find((s: any) => s.is_primary && !s.is_potential)
    ?? (incomeRows ?? []).find((s: any) => !s.is_potential)
  const pay = src ? toEngineIncome([src])[0] : undefined
  const s = pay ? scheduleOn(pay, onDate) : null
  return { frequency: (s?.frequency ?? 'fortnightly') as any, everyN: s?.everyN ?? 1 }
}

/** Each budget running in a cycle and what it allows for that cycle. */
export function budgetsInCycle(rows: Omit<ForecastResult, 'cycles'>, start: string, end: string) {
  const rule = cycleRuleOn(rows.incomeRows, start)
  return (rows.expenseRows ?? [])
    .filter((e: any) => (e.mode ?? 'fixed') === 'budget' && e.frequency !== 'once')
    .filter((e: any) => {
      const from = e.anchor_date > start ? e.anchor_date : start
      const to = e.end_date && e.end_date < end ? e.end_date : end
      return from <= to
    })
    .map((e: any) => {
      const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === e.id && o.cycle_start === start)
      const base = budgetAmountForCycle(toEngineExpenses([e])[0], start, end, rule)
      const unit = versionForDate(e.expense_amount_versions, start)?.amount_cents ?? base
      return {
        id: e.id as string,
        name: e.name as string,
        plannedCents: ov ? ov.amount_cents as number : base,
        // Without this cycle's own amount, and the amount per period as set
        // (a weekly budget on fortnightly pay holds two of them a cycle).
        baseCents: base,
        unitCents: unit as number,
        frequency: e.frequency as string,
        isOverride: !!ov,
      }
    })
}
