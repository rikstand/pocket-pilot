import { describe, it, expect, vi } from 'vitest'
// The planner runs the forecast; these tests cover the pure parts only.
vi.mock('./forecast', () => ({ projectFromRows: () => [] }))
import { perFor, draftOverrides, savingsDip, unstamped, makePlanner, type Draft } from './savingsPlan'

const draft = (p: Partial<Draft>): Draft => ({ per: 15000, skip: false, catchUp: false, restart: null, ...p })
const none = () => undefined
const line = () => 15000

describe('perFor: the amount that finishes by a date', () => {
  it('spreads what is left over the cycles from..to, rounded up to a dollar', () => {
    expect(perFor(180000, 1, 11)).toBe(16400)   // $1,800 over 11 cycles = $163.64 → $164
    expect(perFor(99900, 1, 4)).toBe(25000)     // $999 over 4 → $249.75 → $250
  })
  it('a date already passed takes the rest at once; nothing left needs nothing', () => {
    expect(perFor(50000, 3, 2)).toBe(50000)
    expect(perFor(0, 1, 5)).toBe(0)
  })
})

describe('draftOverrides: what a plan change stores', () => {
  it('a new amount keeps the cycle shown at the old amount', () => {
    expect([...draftOverrides(15000, draft({ per: 10000 }), 0, false, none, line)]).toEqual([[0, 15000]])
  })
  it('a cycle that already has its own amount keeps it', () => {
    expect([...draftOverrides(15000, draft({ per: 10000 }), 0, false, k => (k === 0 ? 5000 : undefined), line)]).toEqual([])
  })
  it('a skip is $0 in the cycle shown', () => {
    expect([...draftOverrides(15000, draft({ skip: true }), 0, false, none, line)]).toEqual([[0, 0]])
  })
  it('catch up puts the skipped amount on top of next cycle', () => {
    expect([...draftOverrides(15000, draft({ skip: true, catchUp: true }), 0, false, none, line)]).toEqual([[0, 0], [1, 30000]])
  })
  it('a pause is $0 until the cycle it starts again, from the cycle shown if not yet set aside', () => {
    expect([...draftOverrides(15000, draft({ restart: 3 }), 0, false, none, line)]).toEqual([[0, 0], [1, 0], [2, 0]])
  })
  it('a pause leaves a cycle already set aside alone', () => {
    expect([...draftOverrides(15000, draft({ restart: 3 }), 0, true, none, line)]).toEqual([[1, 0], [2, 0]])
  })
  it('viewing a later cycle: changes start after it, earlier cycles keep the old amount', () => {
    expect([...draftOverrides(15000, draft({ per: 20000 }), 2, false, none, line)]).toEqual([[0, 15000], [1, 15000], [2, 15000]])
  })
})

describe('savingsDip: a payday the goals take under the floor', () => {
  const c = (v: number) => ({ committedClosingBalanceCents: v }) as any
  it('finds the first payday under the floor that is fine without the goals', () => {
    expect(savingsDip([c(500), c(50), c(-200)], [c(900), c(700), c(400)], 100)).toBe(1)
  })
  it('ignores a payday that is under the floor anyway', () => {
    expect(savingsDip([c(500), c(50)], [c(900), c(80)], 100)).toBe(-1)
  })
})

describe('unstamped: what confirmed cycles count for before a new amount', () => {
  it('a cycle confirmed without an amount is fixed at the standing amount, or that cycle\'s own amount', () => {
    const goal = { id: 'g', per_cycle_cents: 16700 }
    const rows = {
      savingsContributionRows: [
        { savings_goal_id: 'g', cycle_start: '2026-10-10', amount_cents: null },
        { savings_goal_id: 'g', cycle_start: '2026-10-24', amount_cents: null },
        { savings_goal_id: 'g', cycle_start: '2026-11-07', amount_cents: 9000 },
        { savings_goal_id: 'x', cycle_start: '2026-10-10', amount_cents: null },
      ],
      savingsOverrideRows: [{ savings_goal_id: 'g', cycle_start: '2026-10-24', amount_cents: 5000 }],
    } as any
    expect(unstamped(rows, goal).map(c => [c.cycle_start, c.amount_cents])).toEqual([['2026-10-10', 16700], ['2026-10-24', 5000]])
  })
})

describe('makePlanner: dates for any cycle', () => {
  const rows: any = { cycles: [{ startDate: '2026-11-15', savingsLines: [] }, { startDate: '2026-11-29', savingsLines: [] }],
    savingsOverrideRows: [], savingsContributionRows: [], savingsGoalRows: [] }
  const P = makePlanner(rows, { id: 'g', per_cycle_cents: 0, target_cents: 0 }, 'a', 10000, 0, 0)
  it('a goal with nothing left (finish -1) still has a date, so the sheet opens (blank-screen fix, 24 Nov)', () => {
    expect(P.startOf(-1)).toBe('2026-11-01')
    expect(P.startOf(3)).toBe('2026-12-27')
    expect(P.kOf('2026-12-01')).toBe(1)
  })
})
