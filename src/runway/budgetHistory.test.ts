import { describe, it, expect } from 'vitest'
import { budgetHistory, budgetFlag, type PastCycle } from './budgetHistory'
import type { Expense } from '../engine/types'

const pc = (spent: number, planned = 30000): PastCycle => ({ start: '', end: '', plannedCents: planned, spentCents: spent })

describe('a budget that is usually off', () => {
  it('3 of the last 4 over: flagged over, average rounded to $5', () => {
    const f = budgetFlag([pc(29600), pc(31800), pc(33100), pc(30500), pc(34200), pc(31200)], 30000)
    expect(f).toEqual({ dir: 'over', cycles: 4, averageCents: 32500, gapCents: 2500 })
  })
  it('3 of the last 4 under: flagged under', () => {
    const f = budgetFlag([pc(17200, 25000), pc(15000, 25000), pc(18100, 25000), pc(16900, 25000)], 25000)
    expect(f?.dir).toBe('under')
    expect(f?.averageCents).toBe(17000)             // $168 → $170
  })
  it('split 2 and 2: no flag', () => {
    expect(budgetFlag([pc(31000), pc(29000), pc(31000), pc(29000)], 30000)).toBeNull()
  })
  it('fewer than 3 closed cycles: no flag', () => {
    expect(budgetFlag([pc(40000), pc(40000)], 30000)).toBeNull()
  })
  it('no flag once the budget already matches the average', () => {
    // Usually over the OLD budget, but the budget has since been raised to it.
    expect(budgetFlag([pc(33000), pc(33000), pc(33000), pc(33000)], 33000)).toBeNull()
  })
})

describe('past cycles for a budget', () => {
  const groceries = {
    id: 'g', name: 'Groceries', amountCents: 15000, frequency: 'weekly', anchorDate: '2026-01-01',
    mode: 'budget', amountVersions: [],
  } as unknown as Expense
  const cycles = [
    { start_date: '2026-10-08', end_date: '2026-10-21' },
    { start_date: '2026-10-22', end_date: '2026-11-04' },
  ]
  const rule = () => ({ frequency: 'fortnightly' as const, everyN: 1 })

  it('planned from the budget, spent from that cycle\'s entries, overrides win', () => {
    const h = budgetHistory(groceries, cycles,
      [{ expense_id: 'g', spent_date: '2026-10-10', amount_cents: 12000 },
       { expense_id: 'g', spent_date: '2026-10-25', amount_cents: 9000 },
       { expense_id: 'x', spent_date: '2026-10-25', amount_cents: 999 }],
      [{ expense_id: 'g', cycle_start: '2026-10-22', amount_cents: 40000 }], rule)
    expect(h.map(c => [c.plannedCents, c.spentCents])).toEqual([[30000, 12000], [40000, 9000]])
  })
})
