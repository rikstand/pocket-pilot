import { describe, it, expect } from 'vitest'
import { buildRunway } from './runwaySeries'

// A 14-day cycle, 5–18 Nov, opening at $1,000.
const base = { start: '2026-11-05', end: '2026-11-18', openingCents: 100000 }

describe('the runway: balance at the end of each day', () => {
  it('lands each dated item on its day', () => {
    const r = buildRunway({ ...base, today: '2026-11-10', budgets: [],
      events: [{ date: '2026-11-05', cents: 230000 }, { date: '2026-11-08', cents: -76000 }] })
    expect(r.days).toHaveLength(14)
    expect(r.balances[0]).toBe(330000)
    expect(r.balances[2]).toBe(330000)
    expect(r.balances[3]).toBe(254000)
    expect(r.balances[13]).toBe(254000)
  })

  it('a budget: what was logged on its day, the rest spread over the days after today', () => {
    // $300 budget, $100 logged on 6 Nov; today 10 Nov leaves 8 days after it.
    const r = buildRunway({ ...base, today: '2026-11-10', events: [],
      budgets: [{ plannedCents: 30000, entries: [{ date: '2026-11-06', cents: 10000 }] }] })
    expect(r.balances[1]).toBe(90000)            // 6 Nov
    expect(r.balances[5]).toBe(90000)            // today: nothing assumed yet
    expect(r.balances[6]).toBe(87500)            // $200 over 8 days = $25 a day
    expect(r.balances[13]).toBe(70000)           // the full budget by the end
  })

  it('spending over the budget counts in full, with nothing left to spread', () => {
    const r = buildRunway({ ...base, today: '2026-11-10', events: [],
      budgets: [{ plannedCents: 10000, entries: [{ date: '2026-11-06', cents: 15000 }] }] })
    expect(r.balances[13]).toBe(85000)
  })

  it('on the last day, or after it, what is left lands on the last day', () => {
    const r = buildRunway({ ...base, today: '2026-11-20', events: [],
      budgets: [{ plannedCents: 30000, entries: [] }] })
    expect(r.balances[12]).toBe(100000)
    expect(r.balances[13]).toBe(70000)
  })

  it('cents that do not divide evenly go on the last day', () => {
    const r = buildRunway({ ...base, today: '2026-11-15', events: [],
      budgets: [{ plannedCents: 1000, entries: [] }] })   // 3 days after today
    expect(r.balances[13]).toBe(99000)
    expect(r.outByDay.slice(11)).toEqual([333, 333, 334])
  })

  it('ends on the engine\'s figure, and reports any gap', () => {
    const r = buildRunway({ ...base, today: '2026-11-10', events: [{ date: '2026-11-08', cents: -5000 }], budgets: [],
      expectedClosingCents: 94000 })
    expect(r.balances[13]).toBe(94000)
    expect(r.gapCents).toBe(-1000)
    const exact = buildRunway({ ...base, today: '2026-11-10', events: [{ date: '2026-11-08', cents: -5000 }], budgets: [],
      expectedClosingCents: 95000 })
    expect(exact.gapCents).toBe(0)
  })

  it('ignores anything dated outside the cycle', () => {
    const r = buildRunway({ ...base, today: '2026-11-10', budgets: [{ plannedCents: 0, entries: [{ date: '2026-11-01', cents: 999 }] }],
      events: [{ date: '2026-11-20', cents: -5000 }] })
    expect(r.balances[13]).toBe(100000)
  })
})
