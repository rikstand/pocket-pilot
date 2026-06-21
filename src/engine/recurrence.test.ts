import { describe, it, expect } from 'vitest'
import { getOccurrencesInRange } from './recurrence'

describe('getOccurrencesInRange — endDate clipping', () => {
  it('recurs forever when no endDate is given (existing behaviour, unchanged)', () => {
    const occs = getOccurrencesInRange(
      '2026-07-03', 'fortnightly', '2026-07-01', '2026-09-01'
    )
    expect(occs).toEqual(['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28'])
  })

  it('stops generating occurrences once endDate is passed', () => {
    const occs = getOccurrencesInRange(
      '2026-07-03', 'fortnightly', '2026-07-01', '2026-09-01', '2026-07-31'
    )
    expect(occs).toEqual(['2026-07-03', '2026-07-17', '2026-07-31'])
  })

  it('includes the occurrence that lands exactly on endDate', () => {
    const occs = getOccurrencesInRange(
      '2026-07-03', 'fortnightly', '2026-07-01', '2026-07-31', '2026-07-31'
    )
    expect(occs).toEqual(['2026-07-03', '2026-07-17', '2026-07-31'])
  })

  it('a "once" expense with endDate before its anchor never occurs', () => {
    const occs = getOccurrencesInRange(
      '2026-08-01', 'once', '2026-07-01', '2026-09-01', '2026-07-31'
    )
    expect(occs).toEqual([])
  })

  it('endDate later than the cycle range has no effect (range still wins)', () => {
    const occs = getOccurrencesInRange(
      '2026-07-03', 'fortnightly', '2026-07-01', '2026-07-31', '2026-12-31'
    )
    expect(occs).toEqual(['2026-07-03', '2026-07-17', '2026-07-31'])
  })
})