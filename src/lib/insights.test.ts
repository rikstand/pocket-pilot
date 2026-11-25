import { describe, it, expect } from 'vitest'
import { movesOf, averageMoves, splitOfClosed, averageSplit, hasForecast, outOf } from './insights'

const rec = (over: any = {}) => ({
  income: [{ cents: 260000 }], fixed: [{ cents: 65000, bnpl: false }, { cents: 7500, bnpl: true }],
  card: { name: 'Card', cents: 5800 }, savings: [{ cents: 16700 }],
  estimates: [{ id: 'p', name: 'Power', estimate: 12400, usual: 12400, override: null, actual: 14000 }],
  budgets: [{ id: 'g', name: 'Groceries', planned: 30000, spent: 32000 }, { id: 'd', name: 'Dining', planned: 25000, spent: 20000 }],
  ...over,
}) as any

describe('movesOf', () => {
  it('adds budgets, estimates and what the records do not explain', () => {
    // Forecast at close assumed: groceries 320 (over), dining 250, power 124.
    // Bank: dining 50 under (+5000), power 16 over (−1600), and 30 unlogged (−3000).
    const c = { projected_close_cents: 100000, closing_balance_cents: 100000 + 5000 - 1600 - 3000 }
    const m = movesOf(c, rec())
    const by = Object.fromEntries(m.parts.map(p => [p.id, p.v]))
    expect(by.g).toBe(2000)
    expect(by.d).toBe(-5000)
    expect(by.p).toBe(1600)
    expect(by.unlogged).toBe(3000)
    expect(m.moved).toBe(2000 - 5000 + 1600 + 3000)
  })
  it('counts an estimate confirmed in the cycle against its usual amount', () => {
    const r = rec({ estimates: [{ id: 'p', name: 'Power', estimate: 15000, usual: 12400, override: 15000, actual: null }], budgets: [] })
    const m = movesOf({ projected_close_cents: 5000, closing_balance_cents: 5000 }, r)
    expect(m.parts.find(p => p.id === 'p')!.v).toBe(2600)
    expect(m.parts.find(p => p.id === 'unlogged')!.v).toBe(0)
  })
})

describe('averageMoves', () => {
  it('rounds rows to dollars that add up to the rounded average', () => {
    const cyc = [
      { moved: 4049, parts: [{ id: 'a', name: 'A', kind: 'budget' as const, v: 1349 }, { id: 'b', name: 'B', kind: 'budget' as const, v: 1350 }, { id: 'c', name: 'C', kind: 'budget' as const, v: 1350 }] },
    ]
    const r = averageMoves(cyc)
    expect(r.avg).toBe(4000)
    expect(r.rows.reduce((t, x) => t + x.v, 0)).toBe(4000)
  })
  it('drops rows that round to nothing', () => {
    const r = averageMoves([{ moved: 1020, parts: [{ id: 'a', name: 'A', kind: 'budget', v: 1000 }, { id: 'b', name: 'B', kind: 'budget', v: 20 }] }])
    expect(r.rows.map(x => x.id)).toEqual(['a'])
  })
  it('sorts spent more first', () => {
    const r = averageMoves([{ moved: 0, parts: [{ id: 'a', name: 'A', kind: 'budget', v: -500 }, { id: 'b', name: 'B', kind: 'budget', v: 500 }] }])
    expect(r.rows.map(x => x.id)).toEqual(['b', 'a'])
  })
})

describe('splitOfClosed', () => {
  it('splits BNPL from fixed and uses the real estimate', () => {
    const s = splitOfClosed(rec())
    expect(s.fixed).toBe(65000)
    expect(s.bnpl).toBe(7500)
    expect(s.estimates).toBe(14000)
    expect(s.budgets).toBe(52000)
    expect(s.card).toBe(5800)
    expect(s.pay).toBe(260000)
    expect(outOf(s)).toBe(65000 + 7500 + 14000 + 52000 + 16700 + 5800)
  })
})

describe('averageSplit / hasForecast', () => {
  it('averages each type', () => {
    const a = averageSplit([splitOfClosed(rec()), { ...splitOfClosed(rec()), card: 0 }])
    expect(a.card).toBe(2900)
  })
  it('needs a saved forecast that was not a catch-up', () => {
    expect(hasForecast({ is_closed: true, projected_close_cents: 1 })).toBe(true)
    expect(hasForecast({ is_closed: true, projected_close_cents: null })).toBe(false)
    expect(hasForecast({ is_closed: true, projected_close_cents: 1, closed_on_forecast: true })).toBe(false)
  })
})
