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

import { formatDate } from '../engine/dates'

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
