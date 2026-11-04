// creditSchedule.ts — the bits of credit maths that need to know about dates.
//
// credit.ts is deliberately date-free so it can be tested on its own. This
// file bridges it to real calendar dates, and is shared by the Credit page and
// the Cycle screen so the two never disagree about which cycles carry a
// minimum payment.

import type { CreditAccountModel, CreditCycleLine } from '../engine/credit'
import {
  stepCredit, firstFloorBreach, maxAffordableExtraCents,
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
/** The plan a card is on. Old rows have no mode: a committed $0 extra reads as minimum only. */
export type PlanMode = 'minimum' | 'extra' | 'spare'
export function planModeOf(card: any): PlanMode {
  const m = card?.strategy_mode
  if (m === 'minimum' || m === 'extra' || m === 'spare') return m
  return (card?.strategy_extra_cents ?? 0) > 0 ? 'extra' : 'minimum'
}

/** True when the card has one bill a month on a set day. */
export function isMonthlyCard(card: any): boolean {
  return (card?.payment_frequency ?? 'per_cycle') === 'monthly' && !!card?.payment_anchor_date
}

export function buildMinimumDueSchedule(
  card: any,
  firstCycleStart: string,
  cycleDays: number
): (offset: number) => boolean {
  if (!isMonthlyCard(card)) return () => true

  return (offset: number) => {
    const start = addDays(parseDate(firstCycleStart), offset * cycleDays)
    const end   = addDays(start, cycleDays - 1)
    return getOccurrencesInRange(
      card.payment_anchor_date, 'monthly', formatDate(start), formatDate(end)
    ).length > 0
  }
}

/**
 * Which cycles the plan's extra goes out in. On a monthly card the user picks
 * (card settings): with every pay cycle, or only in the cycle holding the due
 * date. Any other card pays its extra every cycle.
 */
export function buildExtraSchedule(
  card: any,
  firstCycleStart: string,
  cycleDays: number
): (offset: number) => boolean {
  if (!isMonthlyCard(card) || card?.extra_timing !== 'due_cycle') return () => true
  return buildMinimumDueSchedule(card, firstCycleStart, cycleDays)
}

/**
 * The extra a committed plan pays where it cannot know the spare: catching a
 * balance up through cycles already gone, or guessing a payment not yet
 * confirmed. A spare plan's spare needs the forecast, which needs this
 * balance — so it is taken as the minimum, and confirming the real amount
 * replaces the guess.
 */
function knownPlanExtra(card: any): number {
  if (!card?.strategy_committed) return 0
  return planModeOf(card) === 'extra' ? (card.strategy_extra_cents ?? 0) : 0
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
  const end = formatDate(addDays(parseDate(cycleStart), cycleDays - 1))
  if (!isMonthlyCard(card)) return end   // paying every cycle: treat the cycle end as the date

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
 * A confirmed card payment, as stored. amountCents is null on rows confirmed
 * before amounts were recorded; confirmedAt is when it was confirmed.
 */
export interface ConfirmedPayment { cycleStart: string; amountCents: number | null; confirmedAt: string | null }

/** Shape credit_cycle_payments rows for the functions below. */
export function confirmedPaymentsFrom(rows: any[] | null | undefined): ConfirmedPayment[] {
  return (rows ?? []).map((r: any) => ({
    cycleStart: r.cycle_start,
    amountCents: r.amount_cents ?? null,
    confirmedAt: r.confirmed_at ?? null,
  }))
}

function wholeDaysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000)
}
function growth(model: CreditAccountModel, days: number): number {
  return Math.pow(1 + model.aprBasisPoints / 10000 / 365, Math.max(0, days))
}

/**
 * Was this confirmed payment already inside the balance that was typed?
 *
 * Both are timestamped, so the order is known: confirmed before the balance
 * was saved means the balance already shows it. Rows without a timestamp
 * fall back to the due date: a payment due before the balance's date is
 * taken as already in it.
 */
function inMeasurement(
  p: ConfirmedPayment,
  recordedAt: string | null,
  dueDate: string | null,
  asOf: string
): boolean {
  // Compared as times, not text: the database can return different numbers
  // of fractional-second digits for two timestamps.
  const confirmedMs = p.confirmedAt ? Date.parse(p.confirmedAt) : NaN
  const recordedMs  = recordedAt ? Date.parse(recordedAt) : NaN
  if (!isNaN(confirmedMs) && !isNaN(recordedMs)) return confirmedMs <= recordedMs
  return !!dueDate && dueDate < asOf
}

/** The confirmed payment for the cycle starting at `cycleStart`, matched on the cycle's date range. */
function confirmedIn(payments: ConfirmedPayment[], cycleStart: string, cycleDays: number): ConfirmedPayment | null {
  const end = formatDate(addDays(parseDate(cycleStart), cycleDays - 1))
  return payments.find(p => p.amountCents != null && p.cycleStart >= cycleStart && p.cycleStart <= end) ?? null
}

/**
 * The card's balance at the START of a cycle, worked out from the last
 * figure you typed in. Everything downstream — the forecast, the Credit page,
 * the change sheet, the plan-fit check — runs whole cycles from this number.
 *
 * Measured during this cycle: worked BACK to the start. The figure you typed
 * already contains the interest and assumed spend since the cycle started,
 * and any payment made before you typed it. So interest and spend come off,
 * and a payment already made goes back on.
 *
 * Measured before this cycle: carried FORWARD, one cycle at a time, from the
 * day it was typed (the first stretch may be part of a cycle). Each cycle
 * takes off what was actually paid when a payment was confirmed, and the
 * plan's payment when it wasn't.
 *
 * Whether a confirmed payment is already in the typed figure is settled by
 * the timestamps (confirmed before or after the balance was saved), so paying
 * early — before the due date — is counted once, not twice.
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
  const recordedAt: string | null = card.balance_recorded_at ?? null
  const due = buildMinimumDueSchedule(card, firstCycleStart, cycleDays)
  const extraDue = buildExtraSchedule(card, firstCycleStart, cycleDays)
  const planExtra = knownPlanExtra(card)
  const extraAt = (offset: number) => (extraDue(offset) ? planExtra : 0)

  // ── measured during this cycle: work back to its start ──
  if (asOf && asOf > firstCycleStart) {
    const days = Math.min(wholeDaysBetween(firstCycleStart, asOf), cycleDays)
    const g = growth(model, days)
    const spendSoFar = Math.round(model.assumedSpendCents * days / cycleDays)
    const dueDate = dueDateInCycle(card, firstCycleStart, cycleDays)
    const confirmed = confirmedIn(payments, firstCycleStart, cycleDays)
    let paidBefore = 0
    if (confirmed) {
      if (inMeasurement(confirmed, recordedAt, dueDate, asOf)) paidBefore = confirmed.amountCents!
    } else if (dueDate && dueDate < asOf) {
      // Not confirmed, but due before the balance was typed: assume the plan's
      // payment went out, sized from a first guess at the start balance.
      const guess = Math.max(0, Math.round(measuredCents / g) - spendSoFar)
      paidBefore = stepCredit(guess, model, extraAt(0), cycleDays, due(0)).paymentCents
    }
    const start = Math.max(0, Math.round((measuredCents + paidBefore) / g) - spendSoFar)
    return {
      balanceCents: start, interestCents: 0, paidCents: 0, spentCents: 0,
      measuredCents, elapsedCycles: 0, measuredThisCycle: true,
    }
  }

  const gapDays = asOf ? wholeDaysBetween(asOf, firstCycleStart) : 0
  if (!asOf || gapDays <= 0) {
    return {
      balanceCents: Math.max(0, measuredCents), interestCents: 0, paidCents: 0, spentCents: 0,
      measuredCents, elapsedCycles: 0, measuredThisCycle: false,
    }
  }

  // ── measured before this cycle: carry it forward ──
  // Stretches run oldest first. Stretch k covers the cycle k+1 cycles before
  // the current one; the oldest may start partway through, on the day typed.
  const stretches = Math.ceil(gapDays / cycleDays)
  let balance = Math.max(0, measuredCents)
  let interest = 0, paid = 0, spent = 0

  for (let k = stretches - 1; k >= 0; k--) {
    const offset = -(k + 1)
    const cycleStart = formatDate(addDays(parseDate(firstCycleStart), offset * cycleDays))
    const from = cycleStart < asOf ? asOf : cycleStart
    const days = wholeDaysBetween(from, formatDate(addDays(parseDate(cycleStart), cycleDays)))
    if (days <= 0) continue
    const partial = from !== cycleStart
    const spendHere = Math.round(model.assumedSpendCents * days / cycleDays)
    const stretchModel = { ...model, assumedSpendCents: spendHere }
    const dueDate = dueDateInCycle(card, cycleStart, cycleDays)
    const confirmed = confirmedIn(payments, cycleStart, cycleDays)

    let fixed: number | null = null
    let extra = extraAt(offset)
    if (confirmed) {
      // Already in the typed figure → nothing more comes off for this cycle.
      fixed = partial && inMeasurement(confirmed, recordedAt, dueDate, asOf) ? 0 : confirmed.amountCents!
    } else if (partial && !(dueDate && dueDate >= asOf)) {
      // The typed figure is from after this cycle's due date (or the cycle
      // has none): the payment, if any, is already in it.
      fixed = 0
      extra = 0
    }

    const line = stepCredit(balance, stretchModel, extra, days, due(offset), fixed)
    interest += line.interestCents
    paid     += line.paymentCents
    spent    += line.assumedSpendCents
    balance   = line.closingBalanceCents
  }

  return {
    balanceCents: balance, interestCents: interest, paidCents: paid, spentCents: spent,
    measuredCents, elapsedCycles: stretches, measuredThisCycle: false,
  }
}

/**
 * What the card should owe on a given day of a cycle: the start balance plus
 * interest and assumed spend so far, less this cycle's payment once it has
 * gone out — confirmed (at any time, early included), or by its due date if
 * not confirmed. Saved with every balance you type, so "predicted vs real"
 * compares like with like — the same day, not the start of the cycle.
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
  const confirmed = confirmedIn(payments, cycleStart, cycleDays)
  let paidSoFar = 0
  if (confirmed) paidSoFar = confirmed.amountCents!
  else if (dueDate && dueDate < onDate) paidSoFar = plannedPaymentCents
  return Math.max(0, Math.round((startBalanceCents + spendSoFar) * growth(model, days)) - paidSoFar)
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
 * A set extra is stored as a number, and the forecast keeps moving — budgets
 * change, bills are confirmed, savings goals start. This is checked every
 * time either page loads, so a plan that has stopped fitting says so.
 *
 * A "whatever's spare" plan cannot stop fitting: it is worked out from the
 * forecast every cycle. It only breaks the floor where the minimum alone does.
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
  const extraDue = buildExtraSchedule(card, first.startDate, days)
  const surplus = noCardCycles.map(c => c.committedClosingBalanceCents)
  const mode = planModeOf(card)

  const minHit = firstFloorBreach(balance, model, 0, days, surplus, floorCents, due)
  const hit = mode === 'extra'
    ? firstFloorBreach(balance, model, card.strategy_extra_cents ?? 0, days, surplus, floorCents, due, extraDue)
    : minHit
  return {
    breach: hit ? { startDate: noCardCycles[hit.index].startDate, closingCents: hit.closingCents } : null,
    minimumAloneBreaks: !!minHit,
    maxExtraCents: maxAffordableExtraCents(balance, model, days, surplus, floorCents, due, extraDue),
  }
}
