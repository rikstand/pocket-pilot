import type {
  CycleInput, CycleResult, AmountVersion, CreditExtraOverride, BudgetSpendEntry,
  ExpenseOverride, SavingsGoal, SavingsCycleLine, Expense, Frequency, IncomeOverride,
  CreditAccount, CreditPlanVersion,
} from './types'
import { parseDate, formatDate, addDays, daysBetween } from './dates'
import { getOccurrencesInRange, nthOccurrence, stepOf, occurrencesOf, scheduleOn, scheduleSegments, changesInOrder } from './recurrence'
import type { Scheduled, Schedule } from './recurrence'
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
  // A budget changed to a different period from a date (weekly to monthly,
  // say) counts each stretch of the cycle at the period in force then.
  let total = 0
  for (const seg of scheduleSegments(exp, from, to)) {
    const days   = cycleDayCount(seg.from, seg.to)
    const amount = getAmountOn(exp.amountVersions, exp.amountCents, seg.from)
    total += cycleRule && sameStep(seg.schedule, cycleRule)
      ? amount * days / cycleDayCount(cycleStart, cycleEnd)
      : amount * days / (periodDays(seg.schedule.frequency, seg.schedule.everyN) ?? days)
  }
  return Math.round(total)
}

// ── the run of cycles ───────────────────────────────────────────────
function ruleOf(s?: Schedule): CycleRule {
  return { frequency: s?.frequency ?? 'fortnightly', everyN: s?.everyN ?? 1 }
}

/**
 * `count` cycles from startDate: each one's start and last day.
 *
 * Cycles follow the main pay. Counted along the account's own chain (from
 * cycleAnchorDate, its first cycle) so monthly cycles keep their day of the
 * month. When the pay's schedule changes from a date, the cycle running then
 * ends the day before, and new cycles follow the new schedule from that date.
 *
 * The forecast, closing a cycle and setting up an account all use this, so
 * the dates they show and save can never disagree.
 */
export function cycleRun(
  startDate: string,
  primary: Scheduled | undefined,
  count: number,
  cycleAnchorDate?: string
): { start: string; end: string }[] {
  const changes = primary ? changesInOrder(primary.schedules) : []
  let rule = ruleOf(primary ? scheduleOn(primary, startDate) : undefined)
  // The chain in force at the start: from the latest pay change on or before
  // it, or else from the account's first cycle.
  const lastChange = changes.filter(v => v.effectiveFrom <= startDate).pop()
  const tryAnchor = lastChange ? lastChange.effectiveFrom : cycleAnchorDate
  const onChain = tryAnchor ? cycleIndexOf(tryAnchor, rule, startDate) : null
  let anchor = onChain != null ? tryAnchor! : startDate
  let k = onChain ?? 0

  const out: { start: string; end: string }[] = []
  let start = startDate
  for (let i = 0; i < count; i++) {
    let next = cycleStartAt(anchor, rule, k + 1)
    const change = changes.find(v => v.effectiveFrom > start && v.effectiveFrom <= next)
    if (change) {
      next = change.effectiveFrom
      anchor = next; k = 0; rule = ruleOf(change)
    } else {
      k++
    }
    out.push({ start, end: formatDate(addDays(parseDate(next), -1)) })
    start = next
  }
  return out
}

/** The cycle after the one starting currentStart, following the main pay. */
export function nextCycleFor(
  currentStart: string, primary: Scheduled | undefined, cycleAnchorDate?: string
): { start: string; end: string } {
  const run = cycleRun(currentStart, primary, 2, cycleAnchorDate)
  return run[1]
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

/**
 * The card plan in force for a cycle: the newest dated version starting on or
 * before it, else the card's own plan. Exported so screens describe the plan
 * the same way the forecast uses it.
 */
export function creditPlanOn(card: CreditAccount, cycleStart: string): { mode: 'minimum' | 'extra' | 'spare'; extraCents: number } {
  // No plan chosen yet: the minimum still goes out. It is due under the card
  // agreement whether or not a plan has been picked.
  if (!card.strategyCommitted) return { mode: 'minimum', extraCents: 0 }
  let best: CreditPlanVersion | null = null
  for (const v of card.planVersions ?? []) {
    if (v.effectiveFrom <= cycleStart && (!best || v.effectiveFrom > best.effectiveFrom)) best = v
  }
  if (best) return { mode: best.mode, extraCents: best.mode === 'extra' ? best.extraCents : 0 }
  return { mode: card.strategyMode ?? 'extra', extraCents: card.strategyExtraCents }
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
  // Every cycle's dates, up front: they follow the main pay, including any
  // change to its schedule from a date (cycleRun).
  const run = cycleRun(startDate, primary, numCycles, input.cycleAnchorDate)

  // What a bill pot sets aside in cycle i: the next payment, less what's in
  // the pot, spread over the cycles left until it (that cycle included),
  // rounded up to the dollar. A one-cycle amount the user set wins. Nothing
  // once the bill has stopped.
  function billPotForCycle(g: SavingsGoal, exp: Expense, i: number, held: number): SavingsCycleLine | null {
    const start = run[i].start
    if (start < g.startCycleStart) return null
    const lookTo = formatDate(addDays(parseDate(start), 3 * 366))
    const next = occurrencesOf(exp, start, lookTo)[0]
    if (!next) return null
    const due = getAmountOn(exp.amountVersions, exp.amountCents, next)
    const need = Math.max(0, due - held)
    let cyclesLeft = 0
    for (let j = i; j < run.length && run[j].start <= next; j++) cyclesLeft++
    const last = run[run.length - 1]
    if (next > last.end) {
      const len = cycleDayCount(last.start, last.end)
      cyclesLeft += Math.ceil(daysBetween(parseDate(last.end), parseDate(next)) / len)
    }
    const ov = g.overrides?.find(o => o.cycleStart === start)
    const per = ov ? ov.amountCents : Math.ceil(need / Math.max(1, cyclesLeft) / 100) * 100
    const amount = Math.max(0, Math.min(per, ov ? per : need))
    if (amount <= 0) return null
    return {
      goalId: g.id, name: g.name, amountCents: amount, targetCents: due,
      remainingAfterCents: Math.max(0, need - amount), isOverride: !!ov, expenseId: exp.id,
    }
  }

  // A card is in the forecast as soon as it exists. Until a plan is committed
  // it pays the minimum only (creditPlanOn): the minimum is due under the card
  // agreement, so leaving it out made the account look better off than it was
  // for anyone who added a card and hadn't picked a plan yet (17 Nov 2026).
  const creditActive = !!creditAccount

  let cycleStart       = startDate
  let committedBalance = openingBalanceCents
  let cardBalance      = creditActive ? creditAccount!.currentBalanceCents : 0

  // Running total per goal across this projection, so a goal knows when it has
  // been fully planned for and stops taking money.
  const plannedByGoal: Record<string, number> = {}

  // Bill pots: what's in each pot right now, and which bill each one pays.
  const billPots = (savingsGoals ?? []).filter(g => g.expenseId && expenses.some(e => e.id === g.expenseId))
  const plainGoals = (savingsGoals ?? []).filter(g => !billPots.includes(g))
  const potHeld: Record<string, number> = {}
  const potFor: Record<string, SavingsGoal> = {}
  for (const g of billPots) { potHeld[g.id] = Math.max(0, g.savedSoFarCents); potFor[g.expenseId!] = g }

  for (let i = 0; i < numCycles; i++) {
    const cycleEnd = run[i].end
    // How pay repeats in this cycle — a budget that repeats the same way is
    // its full amount per cycle.
    const cycleRule = ruleOf(primary ? scheduleOn(primary, cycleStart) : undefined)

    // ── income ──────────────────────────────────────────────────────
    let committedIncomeCents = 0
    let potentialIncomeCents = 0
    for (const src of incomeSources) {
      // Follows any schedule change and stops at the pay's end date.
      const occs  = occurrencesOf(src, cycleStart, cycleEnd)
      // Each pay at the amount in force on its own date; a one-cycle amount
      // replaces the lot, but only in a cycle the pay actually falls in.
      const usual = occs.reduce((sum, d) => sum + getAmountOn(src.amountVersions ?? [], src.amountCents, d), 0)
      const ov    = occs.length > 0 ? incomeOverrideFor(incomeOverrides, src.id, cycleStart) : null
      const total = ov ?? usual
      if (src.isPotential) potentialIncomeCents += total
      else committedIncomeCents += total
    }

    // ── bill pots: set aside towards each bill's next payment ────────
    // Before the bills themselves, so a pot can pay a bill that falls due in
    // the same cycle it sets the last amount aside.
    let savingsTotalCents = 0
    const savingsLines: SavingsCycleLine[] = []
    for (const g of billPots) {
      const line = billPotForCycle(g, expenses.find(e => e.id === g.expenseId)!, i, potHeld[g.id])
      if (!line) continue
      savingsLines.push(line)
      savingsTotalCents += line.amountCents
      potHeld[g.id] += line.amountCents
    }
    let savingsPaidBillsCents = 0

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
        const occs   = occurrencesOf(exp, cycleStart, cycleEnd)
        // Each payment at the amount in force on its own date.
        usual        = occs.reduce((sum, d) => sum + getAmountOn(exp.amountVersions, exp.amountCents, d), 0)
        fallsInCycle = occs.length > 0
      }
      // A one-cycle amount replaces the usual one for this cycle only, for any
      // kind of expense. It only applies where the expense actually falls in
      // the cycle.
      const override   = fallsInCycle ? expenseOverrideFor(expenseOverrides, exp.id, cycleStart) : null
      let total        = override ?? usual
      // A bill with a pot is paid from the pot first; the account only covers
      // what the pot is short.
      const pot = exp.mode !== 'budget' ? potFor[exp.id] : undefined
      if (pot && total > 0) {
        const cover = Math.min(potHeld[pot.id], total)
        potHeld[pot.id] -= cover
        total -= cover
        savingsPaidBillsCents += cover
      }
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
    for (const goal of plainGoals) {
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
      // the plan in force for this cycle decides, at the timing the user
      // picked in card settings.
      const ov = overrideForCycle(creditOverrides, cycleStart)
      const plan = creditPlanOn(card, cycleStart)
      const planExtraApplies = !isMonthly || card.extraTiming !== 'due_cycle' || minimumIsDue
      const useSpare = ov
        ? ov.choice === 'spare'
        : plan.mode === 'spare' && planExtraApplies
      let extraForCycle: number
      if (useSpare) {
        // Minimum first, then whatever is left above the floor. If the spare is
        // less than the minimum, the minimum still goes out and this cycle
        // closes under the floor — the card agreement is not optional.
        const minOnly = stepCredit(cardBalance, card, 0, days, minimumIsDue)
        extraForCycle = Math.max(0, creditSpareCents - minOnly.minimumCents)
      } else if (ov) {
        extraForCycle = ov.extraCents
      } else if (plan.mode === 'extra' && planExtraApplies) {
        extraForCycle = plan.extraCents
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
      savingsTotalCents, savingsLines, savingsPaidBillsCents,
      creditOpeningBalanceCents, creditAssumedSpendCents, creditInterestCents,
      creditMinimumCents, creditExtraCents, creditPaymentCents,
      creditClosingBalanceCents, creditSpareCents,
      committedClosingBalanceCents, potentialClosingBalanceCents,
      safetyFloorCents,
      breachesFloor: committedClosingBalanceCents < safetyFloorCents,
    })

    committedBalance = committedClosingBalanceCents
    cycleStart = run[i + 1]?.start ?? formatDate(addDays(parseDate(cycleEnd), 1))
  }

  return results
}

// ── prompts to set money aside for a bill (Journey 4) ───────────────
// Setting money aside is never the default. A bill only prompts when the
// forecast says it takes a payday under the floor, and each way out is only
// offered if it actually changes that payday — the same rule for every user
// and every bill, with no list of bill types:
//
//   1. Is this bill the reason? Without it, that payday would stay at or
//      above the floor. (A payday that dips anyway isn't fixed by one bill.)
//   2. Would putting money away help? The forecast is re-run with a pot for
//      the bill. Offered only if that payday comes back to the floor and no
//      payday before it that was fine drops under instead.
//
// Money set aside leaves the account early, so on its own it moves a dip
// rather than removing it. It helps when something would otherwise take the
// spare money in between — a card plan that takes whatever's spare, say. The
// test finds that out from the forecast instead of assuming it.

export interface BillPrompt {
  expenseId: string
  name: string
  dueDates: string[]          // the bill's dates in that cycle
  billCents: number           // what it takes from that cycle
  cycleStart: string
  cycleEnd: string
  closingCents: number        // that payday as forecast
  shortCents: number          // how far under the floor
  // Put money away: offered only when it fixes that payday (test 2).
  setAside: { firstCycleCents: number; cycles: number } | null
  // Card pays less that cycle: how much less it could pay, up to the
  // shortfall. 0 = not an option (no card plan with an extra that cycle).
  cardCanReduceCents: number
}

export function billPrompts(
  input: CycleInput,
  // Paydays the user already chose to let dip for a bill. Not asked again.
  accepted: { expenseId: string; cycleStart: string }[] = []
): BillPrompt[] {
  const floor = input.safetyFloorCents
  const base = projectCycles(input)
  const hasPot = new Set((input.savingsGoals ?? []).map(g => g.expenseId).filter(Boolean) as string[])
  const out: BillPrompt[] = []
  const everyCycleMemo: Record<string, boolean> = {}
  const everyCycle = (exp: Expense) =>
    (everyCycleMemo[exp.id] ??= base.every(b => occurrencesOf(exp, b.startDate, b.endDate).length > 0))

  base.forEach((c, i) => {
    if (c.committedClosingBalanceCents >= floor) return
    for (const exp of input.expenses) {
      if (exp.mode === 'budget' || hasPot.has(exp.id)) continue
      if (accepted.some(a => a.expenseId === exp.id && a.cycleStart === c.startDate)) continue
      const dates = occurrencesOf(exp, c.startDate, c.endDate)
      if (dates.length === 0) continue
      // A bill in every cycle can't be what makes one payday the low one, and
      // a pot for it would set aside and pay the same amount each cycle —
      // nothing changes, so it isn't asked about.
      if (everyCycle(exp)) continue
      const ov = expenseOverrideFor(input.expenseOverrides, exp.id, c.startDate)
      const billCents = ov ?? dates.reduce((s, d) => s + getAmountOn(exp.amountVersions, exp.amountCents, d), 0)
      if (billCents <= 0) continue

      // 1. Is this bill the reason?
      if (c.committedClosingBalanceCents + billCents < floor) continue

      // 2. Would a pot for it fix this payday without breaking an earlier one?
      const trial: SavingsGoal = {
        id: '__trial', name: exp.name, targetCents: billCents, perCycleCents: 0,
        startCycleStart: input.startDate, savedSoFarCents: 0, overrides: [], expenseId: exp.id,
      }
      const tried = projectCycles({ ...input, savingsGoals: [...(input.savingsGoals ?? []), trial] })
      let fixes = tried[i].committedClosingBalanceCents >= floor
      for (let j = 0; j < i && fixes; j++) {
        if (base[j].committedClosingBalanceCents >= floor && tried[j].committedClosingBalanceCents < floor) fixes = false
      }
      const lines = tried.slice(0, i + 1).map(t => t.savingsLines.find(l => l.goalId === '__trial')?.amountCents ?? 0)

      const short = floor - c.committedClosingBalanceCents
      out.push({
        expenseId: exp.id, name: exp.name, dueDates: dates, billCents,
        cycleStart: c.startDate, cycleEnd: c.endDate,
        closingCents: c.committedClosingBalanceCents, shortCents: short,
        setAside: fixes ? { firstCycleCents: lines.find(a => a > 0) ?? 0, cycles: lines.filter(a => a > 0).length } : null,
        cardCanReduceCents: Math.min(c.creditExtraCents, short),
      })
    }
  })
  return out
}
