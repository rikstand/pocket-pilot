import type {
  CycleInput, CycleResult, AmountVersion, CreditExtraOverride, BudgetSpendEntry,
  SavingsGoal, SavingsCycleLine,
} from './types'
import { parseDate, formatDate, addDays, addMonths, addYears } from './dates'
import { getOccurrencesInRange } from './recurrence'
import { stepCredit } from './credit'

function getCycleEnd(startDate: string, frequency: string): string {
  const d = parseDate(startDate)
  if (frequency === 'weekly')      return formatDate(addDays(d, 6))
  if (frequency === 'fortnightly') return formatDate(addDays(d, 13))
  if (frequency === 'monthly')     return formatDate(addDays(addMonths(d, 1), -1))
  if (frequency === 'annually')    return formatDate(addDays(addYears(d, 1), -1))
  return formatDate(addDays(d, 13))
}

function nextCycleStart(startDate: string, frequency: string): string {
  const d = parseDate(startDate)
  if (frequency === 'weekly')      return formatDate(addDays(d, 7))
  if (frequency === 'fortnightly') return formatDate(addDays(d, 14))
  if (frequency === 'monthly')     return formatDate(addMonths(d, 1))
  if (frequency === 'annually')    return formatDate(addYears(d, 1))
  return formatDate(addDays(d, 14))
}

// Inclusive day count for a cycle. Both dates come from parseDate(), which
// returns local midnight, so a plain millisecond difference is safe here —
// this is not a toISOString() round-trip.
function cycleDayCount(startDate: string, endDate: string): number {
  const ms = parseDate(endDate).getTime() - parseDate(startDate).getTime()
  return Math.round(ms / 86400000) + 1
}

// Pick the latest amount version whose effectiveFrom <= cycleStart.
// Falls back to amountCents if no versions are available or none apply yet.
function getAmountForCycle(
  versions: AmountVersion[],
  fallback: number,
  cycleStart: string
): number {
  if (!versions || versions.length === 0) return fallback
  const applicable = versions
    .filter(v => v.effectiveFrom <= cycleStart)
    .sort((a, b) => a.effectiveFrom > b.effectiveFrom ? -1 : 1)
  if (applicable.length > 0) return applicable[0].amountCents
  // Fallback: use earliest version if none are effective yet for this cycle
  const earliest = [...versions].sort((a, b) => a.effectiveFrom < b.effectiveFrom ? -1 : 1)[0]
  return earliest?.amountCents ?? fallback
}

// Extra-payment override for a specific cycle, if one exists. Exact match on
// cycle start — same lookup shape as amount versions, but not "latest wins",
// because an override is a one-cycle exception rather than a new default.
function getExtraForCycle(
  overrides: CreditExtraOverride[] | undefined,
  cycleStart: string,
  fallbackExtraCents: number
): number {
  if (!overrides || overrides.length === 0) return fallbackExtraCents
  const hit = overrides.find(o => o.cycleStart === cycleStart)
  return hit ? hit.extraCents : fallbackExtraCents
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
    safetyFloorCents, creditAccount, creditOverrides, budgetSpend, savingsGoals,
  } = input
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
  const cycleFrequency = primary?.frequency ?? 'fortnightly'

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
    const cycleEnd = getCycleEnd(cycleStart, cycleFrequency)

    // ── income ──────────────────────────────────────────────────────
    let committedIncomeCents = 0
    let potentialIncomeCents = 0
    for (const src of incomeSources) {
      const occs  = getOccurrencesInRange(src.anchorDate, src.frequency, cycleStart, cycleEnd)
      const total = occs.length * src.amountCents
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
      const occs       = getOccurrencesInRange(exp.anchorDate, exp.frequency, cycleStart, cycleEnd, exp.endDate)
      const unitCents  = getAmountForCycle(exp.amountVersions, exp.amountCents, cycleStart)
      const total      = occs.length * unitCents
      if      (exp.mode === 'fixed')    fixedExpensesCents    += total
      else if (exp.mode === 'variable') variableExpensesCents += total
      else if (exp.mode === 'budget') {
        // Take the HIGHER of the budget and what was actually spent. Future
        // cycles have nothing logged, so they fall back to the baseline on
        // their own — no special case needed.
        const spent = budgetSpentInCycle(budgetSpend, exp.id, cycleStart, cycleEnd)
        budgetBaselineCents += total
        budgetActualCents   += spent
        budgetExpensesCents += Math.max(total, spent)
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

    if (creditActive && (cardBalance > 0 || creditAccount!.assumedSpendCents > 0)) {
      const days = cycleDayCount(cycleStart, cycleEnd)
      const extraForCycle = getExtraForCycle(
        creditOverrides, cycleStart, creditAccount!.strategyExtraCents
      )
      const line = stepCredit(cardBalance, creditAccount!, extraForCycle, days)

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
      creditClosingBalanceCents,
      committedClosingBalanceCents, potentialClosingBalanceCents,
      safetyFloorCents,
      breachesFloor: committedClosingBalanceCents < safetyFloorCents,
    })

    committedBalance = committedClosingBalanceCents
    cycleStart = nextCycleStart(cycleStart, cycleFrequency)
  }

  return results
}
