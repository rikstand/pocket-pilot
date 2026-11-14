import type {
  CycleInput, CycleResult, AmountVersion, CreditExtraOverride, BudgetSpendEntry,
  ExpenseOverride, SavingsGoal, SavingsCycleLine, Expense, Frequency, IncomeOverride,
} from './types'
import { parseDate, formatDate, addDays, daysBetween } from './dates'
import { getOccurrencesInRange, nthOccurrence, stepOf } from './recurrence'
import { stepCredit } from './credit'

/** How the pay cycle repeats: the primary income's frequency and every-N. */
export interface CycleRule {
  frequency: Frequency
  everyN?: number
}

// A pay that only comes once can't set a rhythm, so cycles fall back to a
// fortnight — the same fallback as before.
function cycleRuleOf(rule: CycleRule): { frequency: Frequency; everyN: number } {
  return rule.frequency === 'once'
    ? { frequency: 'fortnightly', everyN: 1 }
    : { frequency: rule.frequency, everyN: Math.max(1, Math.floor(rule.everyN ?? 1)) }
}

/**
 * The start of the i-th cycle counted from firstStart (i = 0 is firstStart).
 * Worked out from firstStart every time, so monthly cycles that start on the
 * 31st come back to the 31st after a short month instead of drifting.
 */
export function cycleStartAt(firstStart: string, rule: CycleRule, i: number): string {
  const r = cycleRuleOf(rule)
  return formatDate(nthOccurrence(parseDate(firstStart), r.frequency, r.everyN, i))
}

/** The last day of the i-th cycle: the day before the next one starts. */
export function cycleEndAt(firstStart: string, rule: CycleRule, i: number): string {
  return formatDate(addDays(parseDate(cycleStartAt(firstStart, rule, i + 1)), -1))
}

/**
 * Where `start` sits on the chain of cycles beginning at `anchor`, or null if
 * it isn't on it (the pay frequency changed since the chain began).
 */
export function cycleIndexOf(anchor: string, rule: CycleRule, start: string): number | null {
  if (start < anchor) return null
  const r = cycleRuleOf(rule)
  const step = stepOf(r.frequency, r.everyN)!
  const a = parseDate(anchor), s = parseDate(start)
  let k = 'days' in step
    ? Math.floor(daysBetween(a, s) / step.days)
    : Math.max(0, Math.floor(((s.getFullYear() - a.getFullYear()) * 12 + s.getMonth() - a.getMonth()) / step.months) - 1)
  for (let tries = 0; tries < 3; tries++, k++) {
    const at = cycleStartAt(anchor, rule, k)
    if (at === start) return k
    if (at > start) return null
  }
  return null
}

/**
 * The cycle after the one starting `currentStart`: its start and its last day.
 * Counted along the chain from `anchor` when currentStart is on it, so a cycle
 * that started on 28 Feb is followed by one starting on the 31st again.
 * Closing a cycle and setting up an account both use this, so the dates they
 * save always match the forecast's.
 */
export function nextCycleDates(
  currentStart: string, rule: CycleRule, anchor?: string
): { start: string; end: string } {
  const k = anchor ? cycleIndexOf(anchor, rule, currentStart) : null
  return k != null
    ? { start: cycleStartAt(anchor!, rule, k + 1), end: cycleEndAt(anchor!, rule, k + 1) }
    : { start: cycleStartAt(currentStart, rule, 1), end: cycleEndAt(currentStart, rule, 1) }
}

// Inclusive day count for a cycle. Both dates come from parseDate(), which
// returns local midnight, so a plain millisecond difference is safe here —
// this is not a toISOString() round-trip.
function cycleDayCount(startDate: string, endDate: string): number {
  return daysBetween(parseDate(startDate), parseDate(endDate)) + 1
}

// ── budgets as a daily rate ─────────────────────────────────────────
// A budget is a rate, not a bill: "$320 a fortnight" means about $22.86 a day
// for as long as it runs. Counting it as payments on dates made a monthly
// budget land whole in some fortnights and not at all in others, and made
// every budget depend on which day it happened to be anchored on.
//
// A year has 365.25 days, so a month is 30.4375 of them.
const DAYS_PER_MONTH = 365.25 / 12

/** How many days one period of a schedule covers, on average. Null for 'once'. */
export function periodDays(frequency: Frequency, everyN = 1): number | null {
  const step = stepOf(frequency, everyN)
  if (!step) return null
  return 'days' in step ? step.days : step.months * DAYS_PER_MONTH
}

function sameStep(a: CycleRule, b: CycleRule): boolean {
  const x = stepOf(a.frequency, a.everyN ?? 1)
  const y = stepOf(b.frequency, b.everyN ?? 1)
  if (!x || !y) return false
  if ('days' in x && 'days' in y) return x.days === y.days
  if ('months' in x && 'months' in y) return x.months === y.months
  return false
}

/**
 * What a budget takes from one cycle: its amount for the days it runs in that
 * cycle. Starts on its anchor date and stops on its end date, so a budget added
 * with a week of the cycle left takes half a fortnight's worth.
 *
 * When the budget repeats exactly like the cycle (a monthly budget on monthly
 * pay), a full cycle is the full amount — otherwise a $600 monthly budget would
 * read $552 in February and $611 in March. A one-off budget ('once') is the
 * whole amount on its date.
 */
export function budgetAmountForCycle(
  exp: Expense,
  cycleStart: string,
  cycleEnd: string,
  cycleRule?: CycleRule
): number {
  if (exp.frequency === 'once') {
    return getOccurrencesInRange(exp.anchorDate, 'once', cycleStart, cycleEnd, exp.endDate)
      .reduce((sum, d) => sum + getAmountOn(exp.amountVersions, exp.amountCents, d), 0)
  }
  const from = exp.anchorDate > cycleStart ? exp.anchorDate : cycleStart
  const to   = exp.endDate && exp.endDate < cycleEnd ? exp.endDate : cycleEnd
  if (to < from) return 0
  const activeDays = cycleDayCount(from, to)
  const amount = getAmountOn(exp.amountVersions, exp.amountCents, from)
  if (cycleRule && sameStep(exp, cycleRule)) {
    return Math.round(amount * activeDays / cycleDayCount(cycleStart, cycleEnd))
  }
  return Math.round(amount * activeDays / (periodDays(exp.frequency, exp.everyN) ?? activeDays))
}

// The amount in force on one payment's date: the latest version whose
// effectiveFrom <= that date. Falls back to the earliest version when none
// applies yet, and to amountCents when there are no versions at all.
//
// Looked up per payment, not once per cycle at the cycle start. The cycle-start
// lookup ignored any amount dated after the start: an edited one-off dated
// mid-cycle kept its original amount, and a BNPL plan paying mid-cycle lost
// its last payment's rounding top-up. For amounts that change on a cycle start
// (every "from now on" edit) the result is the same as before.
//
// Ties on the same date go to the newest written. forecast.ts hands versions
// over newest-first (lib/versions byNewest), and Array.sort is stable, so a
// comparator that returns 0 on equal dates keeps that order.
function getAmountOn(
  versions: AmountVersion[],
  fallback: number,
  onDate: string
): number {
  if (!versions || versions.length === 0) return fallback
  const byDateDesc = (a: AmountVersion, b: AmountVersion) =>
    a.effectiveFrom === b.effectiveFrom ? 0 : (a.effectiveFrom > b.effectiveFrom ? -1 : 1)
  const applicable = versions.filter(v => v.effectiveFrom <= onDate).sort(byDateDesc)
  if (applicable.length > 0) return applicable[0].amountCents
  const earliest = [...versions].sort(byDateDesc)[versions.length - 1]
  return earliest?.amountCents ?? fallback
}

// The user's own choice for one cycle, if they made one. Exact match on cycle
// start — an override is a one-cycle exception, not a new default.
function overrideForCycle(
  overrides: CreditExtraOverride[] | undefined,
  cycleStart: string
): CreditExtraOverride | null {
  if (!overrides || overrides.length === 0) return null
  return overrides.find(o => o.cycleStart === cycleStart) ?? null
}

/**
 * What was actually spent against one budget inside a cycle.
 *
 * A budget is a ceiling, and the projection assumes you spend all of it. But
 * going OVER has to count — you cannot unspend money. Before this, overspending
 * was invisible: the closing balance kept subtracting the baseline no matter
 * what was logged, and every later cycle inherited the wrong opening balance.
 */
function budgetSpentInCycle(
  spend: BudgetSpendEntry[] | undefined,
  expenseId: string,
  cycleStart: string,
  cycleEnd: string
): number {
  if (!spend || spend.length === 0) return 0
  let total = 0
  for (const e of spend) {
    if (e.expenseId !== expenseId) continue
    if (e.spentDate < cycleStart || e.spentDate > cycleEnd) continue
    total += e.amountCents
  }
  return total
}

/** A one-cycle amount of pay, if one was set for this income in this cycle. */
function incomeOverrideFor(
  overrides: IncomeOverride[] | undefined,
  incomeId: string,
  cycleStart: string
): number | null {
  if (!overrides || overrides.length === 0) return null
  const hit = overrides.find(o => o.incomeId === incomeId && o.cycleStart === cycleStart)
  return hit ? hit.amountCents : null
}

/** A one-cycle amount, if one was set for this expense in this cycle. */
function expenseOverrideFor(
  overrides: ExpenseOverride[] | undefined,
  expenseId: string,
  cycleStart: string
): number | null {
  if (!overrides || overrides.length === 0) return null
  const hit = overrides.find(o => o.expenseId === expenseId && o.cycleStart === cycleStart)
  return hit ? hit.amountCents : null
}

/**
 * What one savings goal takes from one cycle.
 *
 * Returns 0 once the target is met — a goal stops on its own rather than
 * running forever and having to be cancelled. `alreadyPlanned` is what earlier
 * cycles in THIS run have already set aside, so the last cycle only takes what
 * is actually still needed instead of overshooting.
 */
function savingsForCycle(
  goal: SavingsGoal,
  cycleStart: string,
  alreadyPlannedCents: number
): SavingsCycleLine | null {
  if (cycleStart < goal.startCycleStart) return null

  const remaining = goal.targetCents - goal.savedSoFarCents - alreadyPlannedCents
  if (remaining <= 0) return null

  const override = goal.overrides?.find(o => o.cycleStart === cycleStart)
  const wanted = override ? override.amountCents : goal.perCycleCents
  const amount = Math.max(0, Math.min(wanted, remaining))
  if (amount <= 0) return null

  return {
    goalId: goal.id,
    name: goal.name,
    amountCents: amount,
    targetCents: goal.targetCents,
    remainingAfterCents: remaining - amount,
    isOverride: !!override,
  }
}

export function projectCycles(input: CycleInput): CycleResult[] {
  const {
    incomeSources, expenses, openingBalanceCents, startDate, numCycles,
    safetyFloorCents, creditAccount, creditOverrides, creditPayments, budgetSpend, expenseOverrides, savingsGoals,
    incomeOverrides,
  } = input
  const spareFloorCents = input.spareFloorCents ?? safetyFloorCents
  const results: CycleResult[] = []

  // FIX: previously `incomeSources.find(s => !s.isPotential) ?? incomeSources[0]`,
  // which picks whichever non-potential source happens to come back first from
  // the query — not necessarily the account's actual primary income. On any
  // account with more than one non-potential income source, this silently used
  // the wrong one to size cycles (e.g. a fortnightly side income overriding a
  // monthly salary). Now explicitly prefers the flagged primary source, falling
  // back to the old behaviour only if nothing is flagged.
  const primary = incomeSources.find(s => s.isPrimary && !s.isPotential)
    ?? incomeSources.find(s => !s.isPotential)
    ?? incomeSources[0]
  const cycleRule: CycleRule = { frequency: primary?.frequency ?? 'fortnightly', everyN: primary?.everyN ?? 1 }

  // Count cycles along the account's own chain when this projection starts on
  // it, so monthly cycles keep their day of the month. Otherwise start fresh
  // from startDate, exactly as before.
  const onChain = input.cycleAnchorDate ? cycleIndexOf(input.cycleAnchorDate, cycleRule, startDate) : null
  const chainAnchor = onChain != null ? input.cycleAnchorDate! : startDate
  const chainOffset = onChain ?? 0

  // A card only reaches the forecast once its strategy is committed. Before
  // that the Credit page is a simulator and nothing here changes.
  //
  // WORTH CONFIRMING: this also means an uncommitted card leaves the minimum
  // payment out of the forecast, even though a minimum is contractually due.
  // That overstates available money for anyone who adds a card and never
  // commits a strategy.
  const creditActive = !!creditAccount && creditAccount.strategyCommitted

  let cycleStart       = startDate
  let committedBalance = openingBalanceCents
  let cardBalance      = creditActive ? creditAccount!.currentBalanceCents : 0

  // Running total per goal across this projection, so a goal knows when it has
  // been fully planned for and stops taking money.
  const plannedByGoal: Record<string, number> = {}

  for (let i = 0; i < numCycles; i++) {
    const cycleEnd = cycleEndAt(chainAnchor, cycleRule, chainOffset + i)

    // ── income ──────────────────────────────────────────────────────
    let committedIncomeCents = 0
    let potentialIncomeCents = 0
    for (const src of incomeSources) {
      const occs  = getOccurrencesInRange(src.anchorDate, src.frequency, cycleStart, cycleEnd, undefined, src.everyN ?? 1)
      // Each pay at the amount in force on its own date; a one-cycle amount
      // replaces the lot, but only in a cycle the pay actually falls in.
      const usual = occs.reduce((sum, d) => sum + getAmountOn(src.amountVersions ?? [], src.amountCents, d), 0)
      const ov    = occs.length > 0 ? incomeOverrideFor(incomeOverrides, src.id, cycleStart) : null
      const total = ov ?? usual
      if (src.isPotential) potentialIncomeCents += total
      else committedIncomeCents += total
    }

    // ── expenses — cycle-aware amount selection ──────────────────────
    let fixedExpensesCents    = 0
    let variableExpensesCents = 0
    let budgetExpensesCents   = 0
    let budgetBaselineCents   = 0
    let budgetActualCents     = 0
    for (const exp of expenses) {
      let usual: number
      let fallsInCycle: boolean
      if (exp.mode === 'budget') {
        // A budget is a daily rate over the days it runs in this cycle.
        usual        = budgetAmountForCycle(exp, cycleStart, cycleEnd, cycleRule)
        const from   = exp.anchorDate > cycleStart ? exp.anchorDate : cycleStart
        const to     = exp.endDate && exp.endDate < cycleEnd ? exp.endDate : cycleEnd
        fallsInCycle = exp.frequency === 'once'
          ? getOccurrencesInRange(exp.anchorDate, 'once', cycleStart, cycleEnd, exp.endDate).length > 0
          : from <= to
      } else {
        const occs   = getOccurrencesInRange(exp.anchorDate, exp.frequency, cycleStart, cycleEnd, exp.endDate, exp.everyN ?? 1)
        // Each payment at the amount in force on its own date.
        usual        = occs.reduce((sum, d) => sum + getAmountOn(exp.amountVersions, exp.amountCents, d), 0)
        fallsInCycle = occs.length > 0
      }
      // A one-cycle amount replaces the usual one for this cycle only, for any
      // kind of expense. It only applies where the expense actually falls in
      // the cycle.
      const override   = fallsInCycle ? expenseOverrideFor(expenseOverrides, exp.id, cycleStart) : null
      const total      = override ?? usual
      if      (exp.mode === 'fixed')    fixedExpensesCents    += total
      else if (exp.mode === 'variable') variableExpensesCents += total
      else if (exp.mode === 'budget') {
        const planned  = total
        // Take the HIGHER of the budget and what was actually spent. Future
        // cycles have nothing logged, so they fall back to the budget on their
        // own — no special case needed.
        const spent = budgetSpentInCycle(budgetSpend, exp.id, cycleStart, cycleEnd)
        budgetBaselineCents += planned
        budgetActualCents   += spent
        budgetExpensesCents += Math.max(planned, spent)
      }
    }

    // ── savings — DERIVED, like credit, never a stored expense ───────
    let savingsTotalCents = 0
    const savingsLines: SavingsCycleLine[] = []
    for (const goal of savingsGoals ?? []) {
      const line = savingsForCycle(goal, cycleStart, plannedByGoal[goal.id] ?? 0)
      if (!line) continue
      savingsLines.push(line)
      savingsTotalCents += line.amountCents
      plannedByGoal[goal.id] = (plannedByGoal[goal.id] ?? 0) + line.amountCents
    }

    // ── credit — DERIVED, never a stored amount ──────────────────────
    // Order within the cycle is spend -> interest -> payment. The minimum is
    // recomputed from the running balance every cycle, which is why it falls
    // over time and why the line disappears on its own at payoff.
    let creditOpeningBalanceCents = 0
    let creditAssumedSpendCents   = 0
    let creditInterestCents       = 0
    let creditMinimumCents        = 0
    let creditExtraCents          = 0
    let creditPaymentCents        = 0
    let creditClosingBalanceCents = 0
    let creditSpareCents          = 0

    if (creditActive && (cardBalance > 0 || creditAccount!.assumedSpendCents > 0)) {
      const card = creditAccount!
      const days = cycleDayCount(cycleStart, cycleEnd)

      // A monthly card has one bill a month: the minimum falls due only in
      // the cycle holding the due date. This used to charge the full monthly
      // minimum in EVERY cycle — twice a month on a fortnightly pay cycle.
      // Same rule as the Credit page (lib/creditSchedule buildMinimumDueSchedule).
      const isMonthly = card.paymentFrequency === 'monthly' && !!card.paymentAnchorDate
      const minimumIsDue = !isMonthly
        || getOccurrencesInRange(card.paymentAnchorDate!, 'monthly', cycleStart, cycleEnd).length > 0

      // What this cycle has above the floor before the card takes anything:
      // income in, and every bill, budget, BNPL payment and savings goal out.
      // Savings come first on purpose — a goal the user set is a decision too.
      const beforeCardCents = committedBalance + committedIncomeCents
        - fixedExpensesCents - variableExpensesCents - budgetExpensesCents
        - savingsTotalCents
      creditSpareCents = Math.max(0, beforeCardCents - spareFloorCents)

      // The extra for this cycle. A choice made for this cycle wins; otherwise
      // the plan decides, at the timing the user picked in card settings.
      const ov = overrideForCycle(creditOverrides, cycleStart)
      const planExtraApplies = !isMonthly || card.extraTiming !== 'due_cycle' || minimumIsDue
      const useSpare = ov
        ? ov.choice === 'spare'
        : (card.strategyMode ?? 'extra') === 'spare' && planExtraApplies
      let extraForCycle: number
      if (useSpare) {
        // Minimum first, then whatever is left above the floor. If the spare is
        // less than the minimum, the minimum still goes out and this cycle
        // closes under the floor — the card agreement is not optional.
        const minOnly = stepCredit(cardBalance, card, 0, days, minimumIsDue)
        extraForCycle = Math.max(0, creditSpareCents - minOnly.minimumCents)
      } else if (ov) {
        extraForCycle = ov.extraCents
      } else if ((card.strategyMode ?? 'extra') === 'extra' && planExtraApplies) {
        extraForCycle = card.strategyExtraCents
      } else {
        extraForCycle = 0
      }

      // A payment confirmed with an amount is what actually went out.
      const confirmed = creditPayments?.find(p => p.cycleStart === cycleStart)
      const line = stepCredit(
        cardBalance, card, extraForCycle, days, minimumIsDue,
        confirmed ? confirmed.amountCents : null
      )

      creditOpeningBalanceCents = line.openingBalanceCents
      creditAssumedSpendCents   = line.assumedSpendCents
      creditInterestCents       = line.interestCents
      creditMinimumCents        = line.minimumCents
      creditExtraCents          = line.extraCents
      creditPaymentCents        = line.paymentCents
      creditClosingBalanceCents = line.closingBalanceCents

      cardBalance = line.closingBalanceCents
    }

    // ── balances ─────────────────────────────────────────────────────
    // Card payments are real money leaving the account, so they reduce the
    // closing balance exactly like a fixed expense. Only the payment does —
    // the card BALANCE is a debt stock and deliberately stays off this flow.
    const committedClosingBalanceCents =
      committedBalance + committedIncomeCents
      - fixedExpensesCents - variableExpensesCents - budgetExpensesCents
      - savingsTotalCents
      - creditPaymentCents

    const potentialClosingBalanceCents =
      committedClosingBalanceCents + potentialIncomeCents

    results.push({
      startDate: cycleStart, endDate: cycleEnd,
      openingBalanceCents: committedBalance,
      committedIncomeCents, potentialIncomeCents,
      fixedExpensesCents, variableExpensesCents, budgetExpensesCents,
      budgetBaselineCents, budgetActualCents,
      savingsTotalCents, savingsLines,
      creditOpeningBalanceCents, creditAssumedSpendCents, creditInterestCents,
      creditMinimumCents, creditExtraCents, creditPaymentCents,
      creditClosingBalanceCents, creditSpareCents,
      committedClosingBalanceCents, potentialClosingBalanceCents,
      safetyFloorCents,
      breachesFloor: committedClosingBalanceCents < safetyFloorCents,
    })

    committedBalance = committedClosingBalanceCents
    cycleStart = cycleStartAt(chainAnchor, cycleRule, chainOffset + i + 1)
  }

  return results
}
