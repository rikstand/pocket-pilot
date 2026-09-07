// credit.ts — pure payoff maths for a revolving credit balance.
//
// No Supabase, no React, no dates.ts dependency beyond day counts. This is
// deliberately standalone so three callers can share it:
//   1. projectCycles()      — derives the credit line inside each cycle
//   2. the Credit page      — strategy comparison and payoff curve
//   3. the wishlist sim     — delta between payoff-with and payoff-without
//
// Modelling decisions, stated plainly because they are assumptions, not facts:
//
//   ORDER WITHIN A CYCLE is spend -> interest -> payment. Once a balance is
//   revolving, most NZ cards charge interest on new purchases from day one,
//   so there is no grace period to model.
//
//   INTEREST is daily-compounded over the cycle's actual day count, not a
//   flat fortnightly rate. A 14-day cycle and a 31-day monthly cycle give
//   different interest on the same balance, which is correct.
//
//   MINIMUM DUE is expressed as a MONTHLY percentage and pro-rated to the
//   cycle length. This models "you pay every cycle", which is what the
//   forecast shows. A card whose statement is genuinely monthly would fire
//   in some fortnightly cycles and not others; that is a more complex model
//   and not what was designed.

export interface CreditAccountModel {
  aprBasisPoints: number        // 2190 = 21.90% p.a.
  minPaymentPct: number         // monthly, e.g. 3 = 3% of balance
  minPaymentFloorCents: number  // e.g. 1000 = $10
  assumedSpendCents: number     // expected new spending per cycle
}

export interface CreditCycleLine {
  openingBalanceCents: number
  assumedSpendCents: number
  interestCents: number
  minimumCents: number
  extraCents: number
  paymentCents: number
  closingBalanceCents: number
}

export interface CreditProjection {
  lines: CreditCycleLine[]
  totalInterestCents: number
  cyclesToPayoff: number | null   // null when it never clears
  neverClears: boolean
  totalPaidCents: number
}

const DAYS_PER_MONTH = 30.44
const MAX_PROJECTION_CYCLES = 1200   // ~46 fortnightly years
const GROWTH_BAILOUT_CYCLES = 6      // consecutive non-decreasing cycles

/** Interest accrued on `balanceCents` over `days`, daily-compounded. */
export function cycleInterestCents(
  balanceCents: number,
  aprBasisPoints: number,
  days: number
): number {
  if (balanceCents <= 0 || aprBasisPoints <= 0 || days <= 0) return 0
  const dailyRate = aprBasisPoints / 10000 / 365
  return Math.round(balanceCents * (Math.pow(1 + dailyRate, days) - 1))
}

/**
 * Minimum due for a cycle of `days`, derived from the balance. Never stored:
 * this falls as the balance falls, which is exactly why the credit line is a
 * derived value rather than a stored expense amount.
 */
export function minimumDueCents(
  balanceCents: number,
  account: CreditAccountModel,
  days: number
): number {
  if (balanceCents <= 0) return 0
  const monthlyMin = balanceCents * (account.minPaymentPct / 100)
  const prorated = Math.round(monthlyMin * (days / DAYS_PER_MONTH))
  return Math.min(balanceCents, Math.max(prorated, account.minPaymentFloorCents))
}

/**
 * Advance the card by one cycle.
 *
 * `extraCents` is the discretionary top-up above the minimum. It is capped so
 * a payment never exceeds the balance — you cannot overpay a card into credit
 * through this model.
 */
export function stepCredit(
  openingBalanceCents: number,
  account: CreditAccountModel,
  extraCents: number,
  days: number
): CreditCycleLine {
  const opening = Math.max(0, openingBalanceCents)

  if (opening <= 0 && account.assumedSpendCents <= 0) {
    return {
      openingBalanceCents: 0,
      assumedSpendCents: 0,
      interestCents: 0,
      minimumCents: 0,
      extraCents: 0,
      paymentCents: 0,
      closingBalanceCents: 0,
    }
  }

  const spend = Math.max(0, account.assumedSpendCents)
  const afterSpend = opening + spend
  const interest = cycleInterestCents(afterSpend, account.aprBasisPoints, days)
  const beforePayment = afterSpend + interest

  const minimum = minimumDueCents(beforePayment, account, days)
  const headroom = Math.max(0, beforePayment - minimum)
  const extra = Math.min(Math.max(0, extraCents), headroom)
  const payment = minimum + extra

  return {
    openingBalanceCents: opening,
    assumedSpendCents: spend,
    interestCents: interest,
    minimumCents: minimum,
    extraCents: extra,
    paymentCents: payment,
    closingBalanceCents: Math.max(0, beforePayment - payment),
  }
}

/**
 * Run the card forward until it clears, or until it is clear that it won't.
 *
 * A percentage-based minimum means a growing balance does not grow forever —
 * it converges on the point where the minimum equals interest plus assumed
 * spend. That equilibrium is still "never paid off", so it is reported as
 * such rather than as a very distant date.
 */
export function projectCreditPayoff(
  startingBalanceCents: number,
  account: CreditAccountModel,
  extraCents: number,
  cycleDays: number,
  maxCycles: number = MAX_PROJECTION_CYCLES
): CreditProjection {
  const lines: CreditCycleLine[] = []
  let balance = Math.max(0, startingBalanceCents)
  let totalInterest = 0
  let totalPaid = 0
  let nonDecreasing = 0

  for (let i = 0; i < maxCycles; i++) {
    if (balance <= 0) {
      return {
        lines,
        totalInterestCents: totalInterest,
        cyclesToPayoff: lines.length,
        neverClears: false,
        totalPaidCents: totalPaid,
      }
    }

    const line = stepCredit(balance, account, extraCents, cycleDays)
    lines.push(line)
    totalInterest += line.interestCents
    totalPaid += line.paymentCents

    if (line.closingBalanceCents >= line.openingBalanceCents) {
      nonDecreasing++
      if (nonDecreasing >= GROWTH_BAILOUT_CYCLES) {
        return {
          lines,
          totalInterestCents: totalInterest,
          cyclesToPayoff: null,
          neverClears: true,
          totalPaidCents: totalPaid,
        }
      }
    } else {
      nonDecreasing = 0
    }

    balance = line.closingBalanceCents
  }

  return {
    lines,
    totalInterestCents: totalInterest,
    cyclesToPayoff: balance <= 0 ? lines.length : null,
    neverClears: balance > 0,
    totalPaidCents: totalPaid,
  }
}

/**
 * Largest flat extra payment that never drops a projected cycle's closing
 * balance below the safety floor. Binary search over the surplus array.
 *
 * `cycleSurplusCents[i]` is what cycle i closes with BEFORE any credit
 * payment. Caller supplies this from projectCycles run without a card.
 *
 * NOTE: with safety_floor_cents currently zeroed, this returns "drain every
 * cycle to nothing", which is not a number to act on. The Credit page should
 * say so until the floor has a real value.
 */
export function maxAffordableExtraCents(
  startingBalanceCents: number,
  account: CreditAccountModel,
  cycleDays: number,
  cycleSurplusCents: number[],
  safetyFloorCents: number
): number {
  if (cycleSurplusCents.length === 0) return 0

  // Closing balances CHAIN, so by cycle 5 the account has absorbed five card
  // payments, not one. Comparing a single cycle's payment against that cycle's
  // closing balance overstates what is affordable — badly, and increasingly so
  // the further out you look. Payments must accumulate.
  const fits = (extra: number): boolean => {
    const proj = projectCreditPayoff(
      startingBalanceCents, account, extra, cycleDays,
      Math.min(cycleSurplusCents.length, 400)
    )
    let cumulativePaidCents = 0
    for (let i = 0; i < proj.lines.length && i < cycleSurplusCents.length; i++) {
      cumulativePaidCents += proj.lines[i].paymentCents
      if (cycleSurplusCents[i] - cumulativePaidCents < safetyFloorCents) return false
    }
    return true
  }

  if (!fits(0)) return 0

  let lo = 0
  let hi = Math.max(...cycleSurplusCents, startingBalanceCents)
  for (let i = 0; i < 40 && hi - lo > 100; i++) {
    const mid = Math.round((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo / 100) * 100
}

/**
 * What adding `itemCostCents` to the card does to a committed payoff plan.
 *
 * This is the honest framing for the wishlist credit option: once a real
 * balance exists, interest is not attributable to one purchase. Only the
 * change in payoff date and total interest can be stated truthfully.
 */
export function creditItemDelta(
  currentBalanceCents: number,
  itemCostCents: number,
  account: CreditAccountModel,
  extraCents: number,
  cycleDays: number
): {
  before: CreditProjection
  after: CreditProjection
  extraInterestCents: number
  extraCyclesInDebt: number | null
  realCostCents: number
} {
  const before = projectCreditPayoff(currentBalanceCents, account, extraCents, cycleDays)
  const after = projectCreditPayoff(currentBalanceCents + itemCostCents, account, extraCents, cycleDays)

  const extraInterestCents = Math.max(0, after.totalInterestCents - before.totalInterestCents)
  const extraCyclesInDebt =
    before.cyclesToPayoff !== null && after.cyclesToPayoff !== null
      ? after.cyclesToPayoff - before.cyclesToPayoff
      : null

  return {
    before,
    after,
    extraInterestCents,
    extraCyclesInDebt,
    realCostCents: itemCostCents + extraInterestCents,
  }
}
