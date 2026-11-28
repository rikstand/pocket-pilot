import { describe, it, expect } from 'vitest'
import { potHeldCents, potNextPayment } from './savings'
import type { Expense } from '../engine/types'

// A pot fills towards its expense's next payment, then starts again (28 Nov 2026).
const insurance = (over: Partial<Expense> = {}): Expense => ({
  id: 'ins', name: 'Car insurance', frequency: 'annually', anchorDate: '2026-03-11',
  amountCents: 104000, amountVersions: [], mode: 'fixed', ...over,
})
const goal = (over: any = {}) => ({ id: 'pot', expense_id: 'ins', per_cycle_cents: 0, ...over })
const put = (cycle_start: string, amount_cents: number, created_at?: string) =>
  ({ savings_goal_id: 'pot', cycle_start, amount_cents, created_at })

describe('what a pot holds', () => {
  const rows = [put('2025-12-04', 30000), put('2026-01-15', 40000), put('2026-11-19', 13000), put('2026-12-03', 12000)]

  it('counts only what went in since the expense last came out', () => {
    // The 11 Mar 2026 payment took the first two; this year's pot starts after it.
    expect(potHeldCents(goal(), insurance(), rows, [], '2026-12-18')).toBe(25000)
  })

  it('the forecast counts up to its first cycle; a screen counts this cycle too', () => {
    expect(potHeldCents(goal(), insurance(), rows, [], '2026-12-03')).toBe(13000)
    expect(potHeldCents(goal(), insurance(), rows, [], '2026-12-04')).toBe(25000)
  })

  it('a one-off expense: before its payment the pot holds everything; after it, nothing is left to fill', () => {
    const once = insurance({ frequency: 'once', anchorDate: '2027-03-11' })
    expect(potHeldCents(goal(), once, rows, [], '2027-03-11')).toBe(95000)
    expect(potHeldCents(goal(), once, rows, [], '2027-03-12')).toBe(0)
    expect(potNextPayment(once, '2027-03-12')).toBeNull()
  })

  it('a corrected total replaces what came before it, and later confirmations add on top', () => {
    const g = goal({ adjusted_total_cents: 20000, adjusted_at: '2026-11-25T03:00:00Z' })
    const r = [...rows.slice(0, 3).map(c => ({ ...c, created_at: '2026-11-20T03:00:00Z' })), put('2026-12-03', 12000, '2026-12-03T03:00:00Z')]
    expect(potHeldCents(g, insurance(), r, [], '2026-12-18')).toBe(32000)
  })

  it('a correction made before the last payment no longer counts', () => {
    const g = goal({ adjusted_total_cents: 90000, adjusted_at: '2026-02-01T03:00:00Z' })
    expect(potHeldCents(g, insurance(), rows, [], '2026-12-18')).toBe(25000)
  })
})

describe('the next payment a pot fills towards', () => {
  it('is the next one on or after the day, at the amount in force then', () => {
    const e = insurance({ amountVersions: [{ effectiveFrom: '2027-01-01', amountCents: 112000 }] })
    expect(potNextPayment(e, '2026-11-28')).toEqual({ date: '2027-03-11', cents: 112000 })
  })
})
