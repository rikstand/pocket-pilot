// creditSchedule.ts — the bits of credit maths that need to know about dates.
//
// credit.ts is deliberately date-free so it can be tested on its own. This
// file bridges it to real calendar dates, and is shared by the Credit page and
// the Cycle screen so the two never disagree about which cycles carry a
// minimum payment.

import type { CreditAccountModel, CreditCycleLine } from '../engine/credit'
import {
  stepCredit, projectBalanceForward, elapsedCyclesBetween,
  firstFloorBreach, maxAffordableExtraCents,
} from '../engine/credit'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { getOccurrencesInRange } from '../engine/recurrence'

/** Shape the database row into what the maths needs. */
export function creditModelFrom(card: any): CreditAccountModel {
  return {
    aprBasisPoints:       card.apr_basis_points,
    minPaymentPct:        Number(card.min_payment_pct),
    minPaymentFloorCents: card.min_payment_floor_cents,
    assumedSpendCents:    card.assumed_spend_cents,
    paymentFrequency:     card.payment_frequency ?? 'per_cycle',
  }
}

/**
 * Which cycles carry a minimum payment.
 *
 * `offset` counts from the given first cycle and may be negative, because
 * catching a stale balance up walks through cycles that have already been.
 *
 * A card with no due date pays every cycle, which is the old behaviour.
 */
export function buildMinimumDueSchedule(
  card: any,
  firstCycleStart: string,
  cycleDays: number
): (offset: number) => boolean {
  const isMonthly = (card?.payment_frequency ?? 'per_cycle') === 'monthly'
    && !!card?.payment_anchor_date

  if (!isMonthly) return () => true

  return (offset: number) => {
    const start = addDays(parseDate(firstCycleStart), offset * cycleDays)
    const end   = addDays(start, cycleDays - 1)
    return getOccurrencesInRange(
      card.payment_anchor_date, 'monthly', formatDate(start), formatDate(end)
    ).length > 0
  }
}

/**
 * The actual date the payment falls due inside a cycle, if it does.
 * Used to work out whether that date has passed yet.
 */
export function dueDateInCycle(
  card: any,
  cycleStart: string,
  cycleDays: number
): string | null {
  const isMonthly = (card?.payment_frequency ?? 'per_cycle') === 'monthly'
    && !!card?.payment_anchor_date

  const end = formatDate(addDays(parseDate(cycleStart), cycleDays - 1))
  if (!isMonthly) return end   // paying every cycle: treat the cycle end as the date

  const hits = getOccurrencesInRange(
    card.payment_anchor_date, 'monthly', cycleStart, end
  )
  return hits.length > 0 ? hits[0] : null
}

/**
 * Run the card forward, letting the extra payment vary by cycle.
 *
 * credit.ts takes a single extra amount for the whole run, which is right for
 * a standing plan. Here the caller can change the extra for one cycle only —
 * which is exactly what "just this cycle" means.
 */
export function runCardForward(
  startingBalanceCents: number,
  model: CreditAccountModel,
  extraForCycle: (index: number) => number,
  cycleDays: number,
  minimumDue: (index: number) => boolean,
  maxCycles = 400
): { lines: CreditCycleLine[]; totalInterestCents: number; cyclesToPayoff: number | null } {
  const lines: CreditCycleLine[] = []
  let balance = Math.max(0, startingBalanceCents)
  let totalInterest = 0
  let flat = 0

  for (let i = 0; i < maxCycles; i++) {
    if (balance <= 0) {
      return { lines, totalInterestCents: totalInterest, cyclesToPayoff: lines.length }
    }
    const line = stepCredit(balance, model, extraForCycle(i), cycleDays, minimumDue(i))
    lines.push(line)
    totalInterest += line.interestCents

    // Stop early if the balance is not going down — a payment that never gets
    // ahead of interest would otherwise run to the cycle cap every time.
    if (line.closingBalanceCents >= line.openingBalanceCents) {
      flat++
      if (flat >= 6) {
        return { lines, totalInterestCents: totalInterest, cyclesToPayoff: null }
      }
    } else {
      flat = 0
    }
    balance = line.closingBalanceCents
  }

  return {
    lines,
    totalInterestCents: totalInterest,
    cyclesToPayoff: balance <= 0 ? lines.length : null,
  }
}

/** Days in a cycle, from its own start and end dates. */
export function cycleDaysOf(cycle: { startDate: string; endDate: string } | undefined): number {
  if (!cycle) return 14
  return Math.round(
    (parseDate(cycle.endDate).getTime() - parseDate(cycle.startDate).getTime()) / 86400000
  ) + 1
}

/** A confirmed card payment, as stored. amountCents is null on old rows. */
export interface ConfirmedPayment { cycleStart: string; amountCents: number | null }

/** Shape credit_cycle_payments rows for the functions below. */
export function confirmedPaymentsFrom(rows: any[] | null | undefined): ConfirmedPayment[] {
  return (rows ?? []).map((r: any) => ({ cycleStart: r.cycle_start, amountCents: r.amount_cents ?? null }))
}

function wholeDaysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000)
}
function growth(model: CreditAccountModel, days: number): number {
  return Math.pow(1 + model.aprBasisPoints / 10000 / 365, Math.max(0, days))
}

/**
 * The card's balance at the START of a cycle, worked out from the last
 * figure you typed in. Everything downstream — the forecast, the Credit page,
 * the adjust sheet, the plan-fit check — runs whole cycles from this number.
 *
 * Measured before this cycle began: carried forward, a whole cycle at a time.
 *
 * Measured during this cycle: worked BACK to the start. The figure you typed
 * already contains the interest and assumed spend since the cycle started, and
 * — if the due date had passed — this cycle's payment. Treating it as the
 * start-of-cycle balance took that payment off a second time. So interest and
 * spend come off, and a payment already made goes back on: the confirmed
 * amount if there is one, otherwise the planned one.
 *
 * Known gap: a payment made EARLY (before its due date) and then a balance
 * typed before the due date is counted twice. The "predicted vs real" note
 * on the next update shows the difference.
 */
export function carriedCardBalance(
  card: any,
  firstCycleStart: string,
  cycleDays: number,
  payments: ConfirmedPayment[] = []
) {
  const model = creditModelFrom(card)
  const measuredCents = card.current_balance_cents ?? 0
  const asOf: string | null = card.balance_as_of ?? null
  const due = buildMinimumDueSchedule(card, firstCycleStart, cycleDays)
  const extra = card.strategy_committed ? (card.strategy_extra_cents ?? 0) : 0

  if (asOf && asOf > firstCycleStart) {
    const days = Math.min(wholeDaysBetween(firstCycleStart, asOf), cycleDays)
    const g = growth(model, days)
    const spendSoFar = Math.round(model.assumedSpendCents * days / cycleDays)
    const dueDate = dueDateInCycle(card, firstCycleStart, cycleDays)
    let paidBefore = 0
    if (dueDate && dueDate < asOf) {
      const confirmed = payments.find(p => p.cycleStart === firstCycleStart)
      if (confirmed && confirmed.amountCents != null) {
        paidBefore = confirmed.amountCents
      } else {
        // The planned payment, sized from a first guess at the start balance.
        const guess = Math.max(0, Math.round(measuredCents / g) - spendSoFar)
        paidBefore = stepCredit(guess, model, extra, cycleDays, due(0)).paymentCents
      }
    }
    const start = Math.max(0, Math.round((measuredCents + paidBefore) / g) - spendSoFar)
    return {
      balanceCents: start, interestCents: 0, paidCents: 0, spentCents: 0,
      measuredCents, elapsedCycles: 0, measuredThisCycle: true,
    }
  }

  const elapsedCycles = asOf
    ? elapsedCyclesBetween(parseDate(asOf).getTime(), parseDate(firstCycleStart).getTime(), cycleDays)
    : 0
  // Catching up runs through PAST cycles, so step i is (elapsedCycles - i)
  // cycles before the current one — not cycle i ahead of it.
  const drift = projectBalanceForward(
    measuredCents, model, extra, cycleDays, elapsedCycles, (i: number) => due(i - elapsedCycles)
  )
  return { ...drift, measuredCents, elapsedCycles, measuredThisCycle: false }
}

/**
 * What the card should owe on a given day of a cycle: the start balance plus
 * interest and assumed spend so far, less this cycle's payment if its due date
 * has already passed. Saved with every balance you type, so "predicted vs
 * real" compares like with like — the same day, not the start of the cycle.
 * The exact inverse of the working-back in carriedCardBalance.
 */
export function predictedBalanceOn(
  card: any,
  startBalanceCents: number,
  cycleStart: string,
  cycleDays: number,
  onDate: string,
  plannedPaymentCents: number,
  payments: ConfirmedPayment[] = []
): number {
  const model = creditModelFrom(card)
  const days = Math.min(Math.max(0, wholeDaysBetween(cycleStart, onDate)), cycleDays)
  const spendSoFar = Math.round(model.assumedSpendCents * days / cycleDays)
  const dueDate = dueDateInCycle(card, cycleStart, cycleDays)
  let paid = 0
  if (dueDate && dueDate < onDate) {
    const confirmed = payments.find(p => p.cycleStart === cycleStart)
    paid = confirmed && confirmed.amountCents != null ? confirmed.amountCents : plannedPaymentCents
  }
  return Math.max(0, Math.round((startBalanceCents + spendSoFar) * growth(model, days)) - paid)
}

export interface PlanCheck {
  /** First cycle the committed plan pushes under the floor, or null. */
  breach: { startDate: string; closingCents: number } | null
  /** True when even the minimum alone breaks the floor somewhere. */
  minimumAloneBreaks: boolean
  /** The largest flat extra that fits right now. */
  maxExtraCents: number
}

/**
 * Does the committed plan still fit the forecast as it stands today?
 *
 * Committing stores the extra as a number, and the forecast keeps moving —
 * budgets change, bills are confirmed, savings goals start. This is checked
 * every time either page loads, so a plan that has stopped fitting says so.
 *
 * `noCardCycles` is the shared forecast projected with the card left out
 * (projectFromRows with creditCard: null).
 */
export function committedPlanCheck(
  card: any,
  noCardCycles: { startDate: string; endDate: string; committedClosingBalanceCents: number }[],
  floorCents: number,
  payments: ConfirmedPayment[] = []
): PlanCheck | null {
  if (!card || !card.strategy_committed || noCardCycles.length === 0) return null
  const first = noCardCycles[0]
  const days = cycleDaysOf(first)
  const model = creditModelFrom(card)
  const balance = carriedCardBalance(card, first.startDate, days, payments).balanceCents
  const due = buildMinimumDueSchedule(card, first.startDate, days)
  const surplus = noCardCycles.map(c => c.committedClosingBalanceCents)

  const hit = firstFloorBreach(balance, model, card.strategy_extra_cents ?? 0, days, surplus, floorCents, due)
  const minHit = firstFloorBreach(balance, model, 0, days, surplus, floorCents, due)
  return {
    breach: hit ? { startDate: noCardCycles[hit.index].startDate, closingCents: hit.closingCents } : null,
    minimumAloneBreaks: !!minHit,
    maxExtraCents: maxAffordableExtraCents(balance, model, days, surplus, floorCents, due),
  }
}
