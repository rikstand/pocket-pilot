import { describe, it, expect } from 'vitest'
import { closedWindows, placeStats } from './places'

const stored = [
  { start_date: '2026-10-08', end_date: '2026-10-21', is_closed: true },
  { start_date: '2026-10-22', end_date: '2026-11-04', is_closed: true },
  { start_date: '2026-11-05', end_date: '2026-11-18', is_closed: true },
  { start_date: '2026-11-19', end_date: '2026-12-02', is_closed: false },
]
const e = (payee_id: string | null, spent_date: string, amount_cents: number, expense_id = 'gro') => ({ payee_id, spent_date, amount_cents, expense_id })

describe('places', () => {
  it('takes the closed cycles, oldest first', () => {
    expect(closedWindows(stored).map(w => w.start)).toEqual(['2026-10-08', '2026-10-22', '2026-11-05'])
    expect(closedWindows(stored, 2).map(w => w.start)).toEqual(['2026-10-22', '2026-11-05'])
  })
  it('works out each cycle, this cycle, usual and per visit', () => {
    const entries = [e('pak', '2026-10-09', 10000), e('pak', '2026-10-20', 5000), e('pak', '2026-11-06', 9000),
      e('pak', '2026-11-20', 4200), e('wol', '2026-11-20', 999)]
    const s = placeStats('pak', entries, closedWindows(stored), { start: '2026-11-19', end: '2026-12-02' })
    expect(s.hist).toEqual([15000, 0, 9000])
    expect(s.visits).toEqual([2, 0, 1])
    expect(s.soFar).toBe(4200)
    expect(s.usual).toBe(8000)        // (150 + 0 + 90) / 3 = $80, a cycle with no visit counts as $0
    expect(s.perVisit).toBe(8000)     // $240 over 3 visits
    expect(s.ever).toBe(true)
  })
  it('has no usual before any cycle closes, and knows a place never used', () => {
    const s = placeStats('mit', [e('pak', '2026-11-20', 100)], [], { start: '2026-11-19', end: '2026-12-02' })
    expect(s.usual).toBeNull()
    expect(s.perVisit).toBeNull()
    expect(s.ever).toBe(false)
  })
  it('can count one budget only', () => {
    const entries = [e('pak', '2026-11-20', 4000, 'gro'), e('pak', '2026-11-21', 1500, 'hou')]
    expect(placeStats('pak', entries, [], { start: '2026-11-19', end: '2026-12-02' }, 'gro').soFar).toBe(4000)
  })
})
