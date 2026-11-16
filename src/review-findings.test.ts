// Tests for the fixes from the 17 Nov 2026 code review (fix/review-findings).
import { describe, it, expect, vi } from 'vitest'
vi.mock('./lib/supabase', () => ({ supabase: {} }))
import { toEngineSavings } from './lib/forecast'
import { savedSoFarCents } from './lib/savings'
import { projectCycles, creditPlanOn } from './engine/index'

const goal = (over: any = {}) => ({ id: 'g', name: 'Bike', status: 'active', target_cents: 100000, per_cycle_cents: 10000,
  start_cycle_start: '2026-08-06', adjusted_total_cents: null, adjusted_at: null, ...over })
const tick = (cycle_start: string, over: any = {}) => ({ savings_goal_id: 'g', cycle_start, amount_cents: null, ...over })

describe('savings: what a goal holds', () => {
  it('no corrected total: every confirmed cycle counts', () => {
    expect(savedSoFarCents(goal(), [tick('2026-08-06'), tick('2026-08-20')], [])).toBe(20000)
  })
  it('a one-cycle amount counts at that amount, not the standing one', () => {
    const ov = [{ savings_goal_id: 'g', cycle_start: '2026-08-20', amount_cents: 25000 }]
    expect(savedSoFarCents(goal(), [tick('2026-08-06'), tick('2026-08-20')], ov)).toBe(35000)
  })
  it('corrected to $500, then 3 cycles confirmed: $800, and the forecast agrees', () => {
    const g = goal({ adjusted_total_cents: 50000, adjusted_at: '2026-10-01T02:00:00Z' })
    const ticks = [tick('2026-09-17'), tick('2026-10-15'), tick('2026-10-29'), tick('2026-11-12')]
    expect(savedSoFarCents(g, ticks, [])).toBe(80000)
    expect(toEngineSavings([g], ticks, [])[0].savedSoFarCents).toBe(80000)
  })
  it('a cycle already ticked when the total was corrected is inside the corrected figure', () => {
    const g = goal({ adjusted_total_cents: 50000, adjusted_at: '2026-10-20T02:00:00Z' })
    const ticks = [tick('2026-10-15', { created_at: '2026-10-16T00:00:00Z' })]
    expect(savedSoFarCents(g, ticks, [])).toBe(50000)
  })
  it('the same cycle ticked AFTER the correction is added on top', () => {
    const g = goal({ adjusted_total_cents: 50000, adjusted_at: '2026-10-20T02:00:00Z' })
    const ticks = [tick('2026-10-15', { created_at: '2026-10-27T00:00:00Z' })]
    expect(savedSoFarCents(g, ticks, [])).toBe(60000)
  })
})

describe('card: the minimum is in the forecast before a plan is committed', () => {
  const card: any = { id: 'c', name: 'Visa', aprBasisPoints: 2190, minPaymentPct: 3, minPaymentFloorCents: 1000, assumedSpendCents: 0,
    strategyExtraCents: 20000, strategyCommitted: false, strategyMode: 'extra', extraTiming: 'every_cycle', planVersions: [],
    currentBalanceCents: 500000, paymentFrequency: 'per_cycle' }
  const run = (c: any) => projectCycles({ incomeSources: [], expenses: [], openingBalanceCents: 200000,
    startDate: '2026-11-05', numCycles: 1, safetyFloorCents: 0, creditAccount: c } as any)[0]

  it('no plan: pays the minimum, and no extra', () => {
    const r = run(card)
    expect(r.creditPaymentCents).toBeGreaterThan(0)
    expect(r.creditExtraCents).toBe(0)
    expect(r.creditPaymentCents).toBe(r.creditMinimumCents)
    expect(r.committedClosingBalanceCents).toBe(200000 - r.creditPaymentCents)
    expect(creditPlanOn(card, '2026-11-05').mode).toBe('minimum')
  })
  it('a committed plan is unchanged: minimum plus the extra', () => {
    const r = run({ ...card, strategyCommitted: true })
    expect(r.creditExtraCents).toBe(20000)
  })
})
