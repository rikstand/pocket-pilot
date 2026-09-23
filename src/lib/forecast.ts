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
  getIncomeSources, getExpenses, getCycles, getCreditAccount, getCreditExtraOverrides,
  getBudgetSpendEntries, getSavingsGoals, getAllSavingsContributions, getAllSavingsOverrides,
} from './repository'
import { projectCycles } from '../engine/index'
import type {
  CycleResult, IncomeSource, Expense, CreditAccount, CreditExtraOverride,
  BudgetSpendEntry, SavingsGoal,
} from '../engine/types'
import { formatDate, parseDate } from '../engine/dates'
import { byNewest, latestVersion } from './versions'

// Never toISOString() — this app runs at UTC+12 and that has caused real bugs.
function todayStr() { return formatDate(new Date()) }

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
    return {
      id: src.id,
      name: src.name,
      frequency: src.frequency,
      anchorDate: src.anchor_date,
      amountCents: latest?.amount_cents ?? 0,
      isPotential: src.is_potential ?? false,
      isPrimary: src.is_primary ?? false,
    }
  })
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
      anchorDate: exp.anchor_date,
      amountCents: latest?.amountCents ?? 0,
      amountVersions: versions,
      mode: exp.mode ?? 'fixed',
      endDate: exp.end_date ?? undefined,
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
export function toEngineCredit(card: any | null): CreditAccount | null {
  if (!card) return null
  return {
    id: card.id,
    name: card.name,
    aprBasisPoints: card.apr_basis_points,
    minPaymentPct: Number(card.min_payment_pct),
    minPaymentFloorCents: card.min_payment_floor_cents,
    assumedSpendCents: card.assumed_spend_cents,
    strategyExtraCents: card.strategy_extra_cents,
    strategyCommitted: card.strategy_committed,
    currentBalanceCents: card.current_balance_cents ?? 0,
    paymentFrequency: card.payment_frequency ?? 'per_cycle',
    paymentAnchorDate: card.payment_anchor_date ?? undefined,
  }
}

export function toEngineCreditOverrides(rows: any[]): CreditExtraOverride[] {
  return (rows ?? []).map((o: any) => ({
    cycleStart: o.cycle_start,
    extraCents: o.extra_cents,
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
  overrideRows: any[]
): SavingsGoal[] {
  return (goalRows ?? [])
    .filter((g: any) => g.status === 'active' && g.is_active !== false)
    .map((g: any) => {
      const overrides = (overrideRows ?? [])
        .filter((o: any) => o.savings_goal_id === g.id)
        .map((o: any) => ({ cycleStart: o.cycle_start, amountCents: o.amount_cents }))

      // Each confirmed cycle counts for whatever that cycle's amount was —
      // the override if there was one, otherwise the standing amount.
      const confirmed = (contributionRows ?? [])
        .filter((c: any) => c.savings_goal_id === g.id)
        .reduce((sum: number, c: any) => {
          const ov = overrides.find(o => o.cycleStart === c.cycle_start)
          return sum + (ov ? ov.amountCents : g.per_cycle_cents)
        }, 0)

      return {
        id: g.id,
        name: g.name,
        targetCents: g.target_cents,
        perCycleCents: g.per_cycle_cents,
        startCycleStart: g.start_cycle_start,
        savedSoFarCents: g.adjusted_total_cents ?? confirmed,
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
  budgetSpendRows: any[]
  savingsGoalRows: any[]
  savingsContributionRows: any[]
  savingsOverrideRows: any[]
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
    savingsGoalRows, savingsContributionRows, savingsOverrideRows,
  ] = await Promise.all([
    getIncomeSources(accountId),
    getExpenses(accountId),
    getCycles(accountId),
    getCreditAccount(accountId),
    getBudgetSpendEntries(accountId),
    getSavingsGoals(accountId),
    getAllSavingsContributions(accountId),
    getAllSavingsOverrides(accountId),
  ])

  // Overrides only exist once a card does, so this is a second round trip
  // rather than part of the batch above.
  const creditOverrideRows = creditCard
    ? await getCreditExtraOverrides(creditCard.id)
    : []

  const openCycles  = storedCycles.filter((c: any) => !c.is_closed)
  const projectFrom = openCycles[0] ?? storedCycles[storedCycles.length - 1] ?? null

  const cycles = projectCycles({
    incomeSources: toEngineIncome(incomeRows),
    expenses: toEngineExpenses(expenseRows),
    openingBalanceCents: projectFrom?.opening_balance_cents ?? 0,
    startDate: projectFrom?.start_date ?? todayStr(),
    numCycles,
    safetyFloorCents: options.safetyFloorCents ?? floorCents,
    creditAccount: toEngineCredit(creditCard),
    creditOverrides: toEngineCreditOverrides(creditOverrideRows),
    budgetSpend: toEngineBudgetSpend(budgetSpendRows),
    savingsGoals: toEngineSavings(savingsGoalRows, savingsContributionRows, savingsOverrideRows),
  })

  return {
    cycles,
    incomeRows,
    expenseRows,
    storedCycles,
    creditCard,
    creditOverrideRows,
    budgetSpendRows,
    savingsGoalRows,
    savingsContributionRows,
    savingsOverrideRows,
    projectFrom,
  }
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
  storedCycles: any[]
): BaselineCheck[] {
  const closed = (storedCycles ?? []).filter((c: any) => c.is_closed)
  if (closed.length < MIN_CYCLES_FOR_ADVICE) return []

  const out: BaselineCheck[] = []

  for (const exp of expenseRows ?? []) {
    if ((exp.mode ?? 'fixed') !== 'budget') continue

    const latest = latestVersion(exp.expense_amount_versions)
    const baseline = latest?.amount_cents ?? 0
    if (baseline <= 0) continue

    // Only count cycles that have actually closed — a part-finished cycle
    // would drag the average down and make every budget look generous.
    let total = 0
    let counted = 0
    for (const cyc of closed) {
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
