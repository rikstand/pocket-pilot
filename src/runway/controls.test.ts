import { describe, it, expect } from 'vitest'
import { ruleOf, nextDates, newSchedule } from './controls'

describe('a schedule from the Add form', () => {
  it('custom every 6 months, stored as monthly with every_n 6', () => {
    const s = { ...newSchedule('2027-02-12'), how: 'custom' as const, n: 6, unit: 'monthly' as const }
    expect(ruleOf(s)).toMatchObject({ frequency: 'monthly', everyN: 6, anchorDate: '2027-02-12', endDate: null })
    expect(nextDates(s, '2027-01-01')).toEqual(['2027-02-12', '2027-08-12', '2028-02-12'])
  })
  it('after a number of payments: the last one becomes the end date', () => {
    const s = { ...newSchedule('2026-12-01'), how: 'fortnightly' as const, ends: 'count' as const, count: 4 }
    expect(ruleOf(s).endDate).toBe('2027-01-12')
    expect(nextDates(s, '2026-12-01', 10)).toHaveLength(4)
  })
  it('monthly on the 31st falls on the last day of shorter months', () => {
    const s = { ...newSchedule('2027-01-31'), how: 'monthly' as const }
    expect(nextDates(s, '2027-01-01')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'])
  })
  it('once: one date, no end', () => {
    const s = { ...newSchedule('2026-12-24'), how: 'once' as const, ends: 'count' as const }
    expect(ruleOf(s)).toMatchObject({ frequency: 'once', endDate: null })
  })
})
