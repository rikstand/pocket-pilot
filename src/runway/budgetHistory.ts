import { budgetAmountForCycle } from '../engine/engine'
import type { CycleRule } from '../engine/engine'
import type { Expense } from '../engine/types'

/**
 * How a budget went in past cycles, and whether it is usually off.
 * Pure: the caller passes the rows, so this can be tested on its own.
 */
export interface PastCycle { start: string; end: string; plannedCents: number; spentCents: number }

export function budgetHistory(
  budget: Expense,
  closedCycles: { start_date: string; end_date: string }[],
  entries: { expense_id: string; spent_date: string; amount_cents: number }[],
  overrides: { expense_id: string; cycle_start: string; amount_cents: number }[],
  ruleAt: (date: string) => CycleRule,
  count = 6
): PastCycle[] {
  return closedCycles
    .slice(-count)
    .map(c => {
      const ov = overrides.find(o => o.expense_id === budget.id && o.cycle_start === c.start_date)
      return {
        start: c.start_date,
        end: c.end_date,
        plannedCents: ov ? ov.amount_cents : budgetAmountForCycle(budget, c.start_date, c.end_date, ruleAt(c.start_date)),
        spentCents: entries
          .filter(e => e.expense_id === budget.id && e.spent_date >= c.start_date && e.spent_date <= c.end_date)
          .reduce((s, e) => s + e.amount_cents, 0),
      }
    })
    // A cycle the budget wasn't running in says nothing about it.
    .filter(c => c.plannedCents > 0)
}

export interface BudgetFlag {
  dir: 'over' | 'under'
  cycles: number          // how many of the last 4 landed on that side
  averageCents: number    // last 4, rounded to $5
  gapCents: number        // average against today's budget, always positive
}

/**
 * Usually off: spending landed on the same side of the budget in 3 of the
 * last 4 closed cycles. The average is rounded to $5 so it reads as a
 * suggestion, not a measurement.
 */
export function budgetFlag(history: PastCycle[], currentCents: number): BudgetFlag | null {
  const last = history.slice(-4)
  if (last.length < 3) return null
  const over = last.filter(c => c.spentCents > c.plannedCents).length
  const under = last.filter(c => c.spentCents < c.plannedCents).length
  const avg = last.reduce((s, c) => s + c.spentCents, 0) / last.length
  const averageCents = Math.round(avg / 500) * 500
  if (over >= 3 && averageCents > currentCents) return { dir: 'over', cycles: over, averageCents, gapCents: averageCents - currentCents }
  if (under >= 3 && averageCents < currentCents) return { dir: 'under', cycles: under, averageCents, gapCents: currentCents - averageCents }
  return null
}
