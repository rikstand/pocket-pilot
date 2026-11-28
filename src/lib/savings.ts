// savings.ts — one place that works out what a savings goal holds.
//
// The forecast, the Cycle screen and the Wishlist each had their own copy of
// this sum, and they disagreed: the screens counted every confirmed cycle at
// the goal's standing amount, while the forecast counted a one-cycle amount
// when there was one. All three also stopped counting for good once a total
// was corrected, so a goal corrected to $500 stayed at $500 however many
// cycles were confirmed after it (found in the 17 Nov 2026 review).
//
// The rule, for a goal that saves towards something:
//   - No corrected total: every confirmed cycle counts.
//   - A corrected total is a statement about reality on the day it was typed.
//     It replaces everything confirmed up to then, and every cycle confirmed
//     AFTER it is added on top.
//
// "After" is settled by when the confirmation was saved, compared with when
// the total was corrected. A confirmation with no saved time falls back to its
// cycle: it counts when its cycle started after the day of the correction.

import { formatDate, parseDate, addDays } from '../engine/dates'
import { occurrencesOf } from '../engine/recurrence'
import { getAmountOn } from '../engine/engine'
import type { Expense } from '../engine/types'

/** What one confirmed cycle put in: its own amount, else that cycle's one-off amount, else the goal's standing amount. */
export function contributionCents(goal: any, contribution: any, overrideRows: any[] | null | undefined): number {
  if (contribution.amount_cents != null) return contribution.amount_cents
  const ov = (overrideRows ?? []).find((o: any) =>
    o.savings_goal_id === goal.id && o.cycle_start === contribution.cycle_start)
  return ov ? ov.amount_cents : (goal.per_cycle_cents ?? 0)
}

/** Was this cycle confirmed after the goal's total was last corrected? */
function afterCorrection(goal: any, contribution: any): boolean {
  const correctedMs = goal.adjusted_at ? Date.parse(goal.adjusted_at) : NaN
  // No time on the correction: nothing can be placed after it, so the
  // corrected total stands on its own, as it did before.
  if (isNaN(correctedMs)) return false
  const savedMs = contribution.created_at ? Date.parse(contribution.created_at) : NaN
  if (!isNaN(savedMs)) return savedMs > correctedMs
  // Local calendar date of the correction. Never toISOString() for a date.
  return contribution.cycle_start > formatDate(new Date(correctedMs))
}

/** What a goal holds right now, in cents. */
export function savedSoFarCents(
  goal: any,
  contributionRows: any[] | null | undefined,
  overrideRows: any[] | null | undefined
): number {
  if (!goal) return 0
  const mine = (contributionRows ?? []).filter((c: any) => c.savings_goal_id === goal.id)
  const sum = (rows: any[]) => rows.reduce((s: number, c: any) => s + contributionCents(goal, c, overrideRows), 0)
  if (goal.adjusted_total_cents == null) return sum(mine)
  return goal.adjusted_total_cents + sum(mine.filter((c: any) => afterCorrection(goal, c)))
}

// ── pots: money put away for an expense ──────────────────────────────────
//
// A pot fills towards the expense's NEXT payment, which then comes out of it.
// So it holds what went in since the expense last came out, not everything
// ever put in. A one-off expense has one payment: after it the pot has
// nothing left to fill towards. A recurring one starts again for the next.
//
// The forecast, Plan › Savings, the pot's sheet and the Cycle row all use
// this one sum, so they can't disagree (28 Nov 2026: the screens counted
// everything ever put in, which would have overstated a pot after its first
// payout).

/** The expense's last payment before `before` (exclusive), or '' if none in three years. */
function lastPaymentBefore(expense: Expense, before: string): string {
  const back = formatDate(addDays(parseDate(before), -3 * 366))
  const dayBefore = formatDate(addDays(parseDate(before), -1))
  return occurrencesOf(expense, back, dayBefore).pop() ?? ''
}

/**
 * What a pot holds, counting confirmations for cycles that start before `before`.
 * The forecast passes its first cycle (it projects that cycle itself); a screen
 * passes tomorrow, so this cycle's set-aside counts once it's ticked.
 * A corrected total made since the last payment replaces what came before it,
 * and confirmations saved after the correction are added on top, as for goals.
 */
export function potHeldCents(
  goal: any,
  expense: Expense,
  contributionRows: any[] | null | undefined,
  overrideRows: any[] | null | undefined,
  before: string
): number {
  if (!goal) return 0
  const last = lastPaymentBefore(expense, before)
  const since = (contributionRows ?? []).filter((c: any) =>
    c.savings_goal_id === goal.id && c.cycle_start > last && c.cycle_start < before)
  const sum = (rows: any[]) => rows.reduce((s: number, c: any) => s + contributionCents(goal, c, overrideRows), 0)
  const corrected = goal.adjusted_total_cents != null && goal.adjusted_at && goal.adjusted_at.slice(0, 10) > last
  if (!corrected) return sum(since)
  return goal.adjusted_total_cents + sum(since.filter((c: any) => afterCorrection(goal, c)))
}

/** The pot's next payment on or after `from`: its date and amount, or null when there isn't one. */
export function potNextPayment(expense: Expense, from: string): { date: string; cents: number } | null {
  const date = occurrencesOf(expense, from, formatDate(addDays(parseDate(from), 3 * 366)))[0]
  if (!date) return null
  return { date, cents: getAmountOn(expense.amountVersions, expense.amountCents, date) }
}

/** What a pot holds today and the payment it's filling towards (null once there's no payment left). */
export function potToday(
  goal: any,
  expense: Expense,
  contributionRows: any[] | null | undefined,
  overrideRows: any[] | null | undefined,
  today: string
): { heldCents: number; next: { date: string; cents: number } | null } {
  return {
    heldCents: potHeldCents(goal, expense, contributionRows, overrideRows, formatDate(addDays(parseDate(today), 1))),
    next: potNextPayment(expense, today),
  }
}

/** What any goal holds today: a pot since its expense last came out, a goal everything confirmed. */
export function heldToday(
  goal: any,
  expenses: Expense[],
  contributionRows: any[] | null | undefined,
  overrideRows: any[] | null | undefined,
  today: string
): number {
  const exp = goal?.expense_id ? expenses.find(e => e.id === goal.expense_id) : undefined
  return exp ? potToday(goal, exp, contributionRows, overrideRows, today).heldCents : savedSoFarCents(goal, contributionRows, overrideRows)
}
