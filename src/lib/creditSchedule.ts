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

/**
 * The card's balance at the start of a cycle, carried forward from the last
 * figure you typed in.
 *
 * A measured balance is only true on the day it was taken. Work out how many
 * whole cycles have passed since, and run the card forward that many cycles.
 * Lives here, not on the Credit page, so the Credit page and the Cycle screen
 * start from the same number.
 */
export function carriedCardBalance(card: any, firstCycleStart: string, cycleDays: number) {
  const model = creditModelFrom(card)
  const measuredCents = card.current_balance_cents ?? 0
  const elapsedCycles = card.balance_as_of
    ? elapsedCyclesBetween(
        parseDate(card.balance_as_of).getTime(),
        parseDate(firstCycleStart).getTime(),
        cycleDays
      )
    : 0
  // Catching up runs through PAST cycles, so step i is (elapsedCycles - i)
  // cycles before the current one — not cycle i ahead of it.
  const due = buildMinimumDueSchedule(card, firstCycleStart, cycleDays)
  const drift = projectBalanceForward(
    measuredCents, model,
    card.strategy_committed ? card.strategy_extra_cents : 0,
    cycleDays, elapsedCycles, (i: number) => due(i - elapsedCycles)
  )
  return { ...drift, measuredCents, elapsedCycles }
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
  floorCents: number
): PlanCheck | null {
  if (!card || !card.strategy_committed || noCardCycles.length === 0) return null
  const first = noCardCycles[0]
  const days = cycleDaysOf(first)
  const model = creditModelFrom(card)
  const balance = carriedCardBalance(card, first.startDate, days).balanceCents
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
