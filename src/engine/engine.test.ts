import { describe, it, expect } from 'vitest'
import { getOccurrencesInRange } from './recurrence'
import { projectCycles, cycleStartAt, cycleEndAt, budgetAmountForCycle } from './engine'
import type { CycleInput, Expense, IncomeSource } from './types'

// ── helpers ─────────────────────────────────────────────────────────
const pay = (over: Partial<IncomeSource> = {}): IncomeSource => ({
  id: 'pay', name: 'Salary', frequency: 'fortnightly', anchorDate: '2026-11-05',
  amountCents: 230000, isPotential: false, isPrimary: true, ...over,
})
const bill = (over: Partial<Expense> = {}): Expense => ({
  id: 'b', name: 'Bill', frequency: 'monthly', anchorDate: '2026-11-12',
  amountCents: 10000, amountVersions: [], mode: 'fixed', ...over,
})
const budget = (over: Partial<Expense> = {}): Expense =>
  bill({ id: 'g', name: 'Groceries', frequency: 'fortnightly', anchorDate: '2026-01-01', amountCents: 32000, mode: 'budget', ...over })
const run = (over: Partial<CycleInput> = {}) => projectCycles({
  incomeSources: [pay()], expenses: [], openingBalanceCents: 100000,
  startDate: '2026-11-05', numCycles: 3, safetyFloorCents: 50000, ...over,
})

// ── recurrence ──────────────────────────────────────────────────────
describe('getOccurrencesInRange — month ends', () => {
  it('a bill on the 31st falls on the last day of shorter months, then back on the 31st', () => {
    expect(getOccurrencesInRange('2027-01-31', 'monthly', '2027-01-01', '2027-05-31'))
      .toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'])
  })

  it('still lands on the 31st when the window starts months after the anchor', () => {
    expect(getOccurrencesInRange('2026-01-31', 'monthly', '2026-09-01', '2026-10-31'))
      .toEqual(['2026-09-30', '2026-10-31'])
  })

  it('a yearly date on 29 Feb falls on 28 Feb in other years', () => {
    expect(getOccurrencesInRange('2028-02-29', 'annually', '2028-01-01', '2032-12-31'))
      .toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'])
  })
})

describe('getOccurrencesInRange — every N', () => {
  it('every 3 weeks', () => {
    expect(getOccurrencesInRange('2026-11-02', 'weekly', '2026-11-01', '2026-12-31', undefined, 3))
      .toEqual(['2026-11-02', '2026-11-23', '2026-12-14'])
  })

  it('quarterly (every 3 months), clamped at month ends', () => {
    expect(getOccurrencesInRange('2026-11-30', 'monthly', '2026-11-01', '2027-12-31', undefined, 3))
      .toEqual(['2026-11-30', '2027-02-28', '2027-05-30', '2027-08-30', '2027-11-30'])
  })

  it('every 2 days', () => {
    expect(getOccurrencesInRange('2026-11-05', 'daily', '2026-11-06', '2026-11-12', undefined, 2))
      .toEqual(['2026-11-07', '2026-11-09', '2026-11-11'])
  })

  it('every N of 1 (or missing) behaves exactly as before', () => {
    const a = getOccurrencesInRange('2026-07-03', 'fortnightly', '2026-07-01', '2026-09-01')
    const b = getOccurrencesInRange('2026-07-03', 'fortnightly', '2026-07-01', '2026-09-01', undefined, 1)
    expect(a).toEqual(b)
    expect(a).toEqual(['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28'])
  })

  it('never falls before its anchor, even with every N', () => {
    expect(getOccurrencesInRange('2026-12-01', 'weekly', '2026-11-01', '2026-12-31', undefined, 2))
      .toEqual(['2026-12-01', '2026-12-15', '2026-12-29'])
  })

  it('stops at the end date, with every N', () => {
    expect(getOccurrencesInRange('2026-11-02', 'weekly', '2026-11-01', '2027-03-01', '2026-12-20', 3))
      .toEqual(['2026-11-02', '2026-11-23', '2026-12-14'])
  })

  it('a window that ends before the anchor is empty', () => {
    expect(getOccurrencesInRange('2027-01-15', 'monthly', '2026-11-01', '2026-12-31')).toEqual([])
  })
})

// ── cycles ──────────────────────────────────────────────────────────
describe('cycle dates', () => {
  it('fortnightly cycles run 14 days', () => {
    const r = { frequency: 'fortnightly' as const }
    expect(cycleStartAt('2026-11-05', r, 1)).toBe('2026-11-19')
    expect(cycleEndAt('2026-11-05', r, 0)).toBe('2026-11-18')
  })

  it('pay every 4 weeks gives 28-day cycles', () => {
    const r = { frequency: 'weekly' as const, everyN: 4 }
    expect(cycleStartAt('2026-11-05', r, 1)).toBe('2026-12-03')
    expect(cycleEndAt('2026-11-05', r, 0)).toBe('2026-12-02')
  })

  it('monthly cycles from the 31st come back to the 31st', () => {
    const r = { frequency: 'monthly' as const }
    expect([0, 1, 2].map(i => cycleStartAt('2027-01-31', r, i))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'])
    expect(cycleEndAt('2027-01-31', r, 0)).toBe('2027-02-27')
  })

  it('a one-off primary income falls back to fortnightly cycles', () => {
    expect(cycleStartAt('2026-11-05', { frequency: 'once' }, 1)).toBe('2026-11-19')
  })

  it('the flagged primary income sets the cycle, not the first in the list', () => {
    const side = pay({ id: 'side', name: 'Side', frequency: 'weekly', isPrimary: false, amountCents: 10000 })
    const main = pay({ id: 'main', frequency: 'monthly', anchorDate: '2026-11-05' })
    const out = run({ incomeSources: [side, main], numCycles: 2 })
    expect(out[0].endDate).toBe('2026-12-04')
    expect(out[1].startDate).toBe('2026-12-05')
  })

  it('every 4 weeks primary pay: projection uses 28-day cycles', () => {
    const out = run({ incomeSources: [pay({ frequency: 'weekly', everyN: 4 })], numCycles: 2 })
    expect(out.map(c => [c.startDate, c.endDate])).toEqual([
      ['2026-11-05', '2026-12-02'], ['2026-12-03', '2026-12-30'],
    ])
  })
})

// ── budgets as a daily rate ─────────────────────────────────────────
describe('budgets as a daily rate', () => {
  const fortnight = { frequency: 'fortnightly' as const }

  it('a fortnightly budget on fortnightly pay is its full amount', () => {
    expect(budgetAmountForCycle(budget(), '2026-11-05', '2026-11-18', fortnight)).toBe(32000)
  })

  it('a weekly budget on fortnightly pay is twice the amount, as before', () => {
    expect(budgetAmountForCycle(budget({ frequency: 'weekly', amountCents: 10000 }), '2026-11-05', '2026-11-18', fortnight)).toBe(20000)
  })

  it('a monthly budget is spread evenly over fortnights instead of landing in some', () => {
    const b = budget({ frequency: 'monthly', amountCents: 60000 })
    const a = budgetAmountForCycle(b, '2026-11-05', '2026-11-18', fortnight)
    const c = budgetAmountForCycle(b, '2026-11-19', '2026-12-02', fortnight)
    expect(a).toBe(27598)   // $600 × 14 days ÷ 30.4375
    expect(c).toBe(a)
  })

  it('a monthly budget on monthly pay is its full amount in short and long months', () => {
    const b = budget({ frequency: 'monthly', amountCents: 60000 })
    const monthly = { frequency: 'monthly' as const }
    expect(budgetAmountForCycle(b, '2027-02-01', '2027-02-28', monthly)).toBe(60000)
    expect(budgetAmountForCycle(b, '2027-03-01', '2027-03-31', monthly)).toBe(60000)
  })

  it('a budget added partway through a cycle only takes the days left', () => {
    expect(budgetAmountForCycle(budget({ anchorDate: '2026-11-12' }), '2026-11-05', '2026-11-18', fortnight)).toBe(16000)
  })

  it('a budget that ends partway through a cycle only takes the days it runs', () => {
    expect(budgetAmountForCycle(budget({ endDate: '2026-11-11' }), '2026-11-05', '2026-11-18', fortnight)).toBe(16000)
  })

  it('a budget that has not started or has ended takes nothing', () => {
    expect(budgetAmountForCycle(budget({ anchorDate: '2026-12-01' }), '2026-11-05', '2026-11-18', fortnight)).toBe(0)
    expect(budgetAmountForCycle(budget({ endDate: '2026-11-01' }), '2026-11-05', '2026-11-18', fortnight)).toBe(0)
  })

  it('uses the amount in force when the cycle starts', () => {
    const b = budget({ amountVersions: [
      { amountCents: 40000, effectiveFrom: '2026-11-19' },
      { amountCents: 32000, effectiveFrom: '2026-01-01' },
    ] })
    expect(budgetAmountForCycle(b, '2026-11-05', '2026-11-18', fortnight)).toBe(32000)
    expect(budgetAmountForCycle(b, '2026-11-19', '2026-12-02', fortnight)).toBe(40000)
  })

  it('a one-off budget is its whole amount in the cycle it falls in', () => {
    const b = budget({ frequency: 'once', anchorDate: '2026-11-25', amountCents: 50000 })
    expect(budgetAmountForCycle(b, '2026-11-05', '2026-11-18', fortnight)).toBe(0)
    expect(budgetAmountForCycle(b, '2026-11-19', '2026-12-02', fortnight)).toBe(50000)
  })

  it('in the projection: a one-cycle amount still replaces the budget', () => {
    const out = run({
      expenses: [budget()],
      expenseOverrides: [{ expenseId: 'g', cycleStart: '2026-11-19', amountCents: 50000 }],
    })
    expect(out.map(c => c.budgetExpensesCents)).toEqual([32000, 50000, 32000])
  })

  it('in the projection: spending over the budget counts, under stays at the budget', () => {
    const out = run({
      expenses: [budget()],
      budgetSpend: [
        { expenseId: 'g', amountCents: 40000, spentDate: '2026-11-10' },
        { expenseId: 'g', amountCents: 10000, spentDate: '2026-11-20' },
      ],
    })
    expect(out.map(c => c.budgetExpensesCents)).toEqual([40000, 32000, 32000])
  })
})

// ── the projection ──────────────────────────────────────────────────
describe('projectCycles', () => {
  it('closing = opening + pay − bills, carried into the next cycle', () => {
    const out = run({ expenses: [bill()], numCycles: 2 })
    expect(out[0].committedIncomeCents).toBe(230000)
    expect(out[0].fixedExpensesCents).toBe(10000)
    expect(out[0].committedClosingBalanceCents).toBe(100000 + 230000 - 10000)
    expect(out[1].openingBalanceCents).toBe(out[0].committedClosingBalanceCents)
    expect(out[1].fixedExpensesCents).toBe(0)   // the monthly bill on the 12th isn't in 19 Nov – 2 Dec
  })

  it('each payment uses the amount in force on its own date (BNPL top-up)', () => {
    const bnpl = bill({
      id: 'bn', frequency: 'fortnightly', anchorDate: '2026-11-10', endDate: '2026-12-22',
      amountVersions: [
        { amountCents: 17476, effectiveFrom: '2026-11-10' },
        { amountCents: 17472, effectiveFrom: '2026-12-22' },
      ],
    })
    const out = run({ expenses: [bnpl], numCycles: 4 })
    expect(out.map(c => c.fixedExpensesCents)).toEqual([17476, 17476, 17476, 17472])
  })

  it('a BNPL plan stops after its end date', () => {
    const bnpl = bill({ frequency: 'fortnightly', anchorDate: '2026-11-10', endDate: '2026-11-24', amountCents: 5000 })
    expect(run({ expenses: [bnpl] }).map(c => c.fixedExpensesCents)).toEqual([5000, 5000, 0])
  })

  it('a bill every 3 weeks lands in the right cycles', () => {
    const b = bill({ frequency: 'weekly', everyN: 3, anchorDate: '2026-11-06', amountCents: 3000 })
    // 6 Nov, 27 Nov, 18 Dec
    expect(run({ expenses: [b], numCycles: 4 }).map(c => c.fixedExpensesCents)).toEqual([3000, 3000, 0, 3000])
  })

  it('a one-cycle amount on a fixed bill only applies where the bill falls', () => {
    const out = run({
      expenses: [bill()],
      expenseOverrides: [
        { expenseId: 'b', cycleStart: '2026-11-05', amountCents: 14200 },
        { expenseId: 'b', cycleStart: '2026-11-19', amountCents: 99900 },
      ],
      numCycles: 2,
    })
    expect(out.map(c => c.fixedExpensesCents)).toEqual([14200, 0])
  })

  it('flags a cycle that closes under the floor', () => {
    const out = run({ expenses: [bill({ amountCents: 290000 })], numCycles: 1 })
    expect(out[0].breachesFloor).toBe(true)
  })
})
