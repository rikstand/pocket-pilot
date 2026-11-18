import { describe, it, expect, vi } from 'vitest'

// A stand-in for the database: 2,345 spend entries, served at most 1,000 a
// request, the way Supabase serves them.
const ROWS = Array.from({ length: 2345 }, (_, i) => ({ id: `e${String(i).padStart(5, '0')}`, amount_cents: 100 }))
const asked: [number, number][] = []
vi.mock('./supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, order: () => q,
        range: (from: number, to: number) => {
          asked.push([from, to])
          return Promise.resolve({ data: ROWS.slice(from, Math.min(to + 1, from + 1000)), error: null })
        },
      }
      return q
    },
  },
}))

import { getBudgetSpendEntries } from './repository'

describe('lists past 1,000 rows (code review finding 5)', () => {
  it('reads every page until one comes back short', async () => {
    const rows = await getBudgetSpendEntries('acc')
    expect(rows).toHaveLength(2345)
    expect(new Set(rows.map((r: any) => r.id)).size).toBe(2345)
    expect(asked).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})
