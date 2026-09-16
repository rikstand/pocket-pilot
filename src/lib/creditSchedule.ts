// creditSchedule.ts — the bits of credit maths that need to know about dates.
//
// credit.ts is deliberately date-free so it can be tested on its own. This
// file bridges it to real calendar dates, and is shared by the Credit page and
// the Cycle screen so the two never disagree about which cycles carry a
// minimum payment.

import type { CreditAccountModel, CreditCycleLine } from '../engine/credit'
import { stepCredit } from '../engine/credit'
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
