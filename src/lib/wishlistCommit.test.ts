import { describe, it, expect, vi, beforeEach } from 'vitest'

// A stand-in for the database that records every write. A wishlist item is
// "active" until claimed; the claim only matches while it still is.
const writes: string[] = []
let itemStatus = 'active'
let failGoalLink = false
vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => {
      let op = '', filters: Record<string, any> = {}, payload: any = null
      const run = () => {
        writes.push(`${table}.${op}${payload?.status ? ':' + payload.status : ''}${payload?.is_active === false ? ':off' : ''}`)
        if (table === 'wishlist_items' && op === 'update') {
          if (filters.status && filters.status !== itemStatus) return { data: [], error: null }
          if (payload?.savings_goal_id && failGoalLink) return { data: null, error: new Error('link failed') }
          if (payload?.status) itemStatus = payload.status
          return { data: [{ id: 'w1' }], error: null }
        }
        return { data: { id: table + '-new' }, error: null }
      }
      const q: any = {
        update: (p: any) => { op = 'update'; payload = p; return q },
        insert: (p: any) => { op = 'insert'; payload = p; return q },
        select: () => q, single: () => q,
        eq: (k: string, v: any) => { filters[k] = v; return q },
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      }
      return q
    },
  },
}))

import { commitWishlistBnpl, commitWishlistSaving } from './repository'

const plan = { frequency: 'fortnightly' as const, payments: [{ date: '2026-12-10', amountCents: 17475 }, { date: '2026-12-24', amountCents: 17475 }] }

describe('a wishlist item can only get one plan (release 5a)', () => {
  beforeEach(() => { writes.length = 0; itemStatus = 'active'; failGoalLink = false })

  it('a second commit is refused before any plan is written', async () => {
    await commitWishlistBnpl('a', 'u', { id: 'w1', name: 'Desk' }, plan)
    expect(writes.filter(w => w.startsWith('lay_bys.insert'))).toHaveLength(1)
    writes.length = 0
    await expect(commitWishlistBnpl('a', 'u', { id: 'w1', name: 'Desk' }, plan)).rejects.toThrow(/already has a plan/)
    expect(writes).toEqual(['wishlist_items.update:committed'])
  })

  it('a goal whose link fails is switched off and the item goes back on the list', async () => {
    failGoalLink = true
    await expect(commitWishlistSaving('a', { id: 'w1', name: 'Desk', amountCents: 69900 },
      { perCycleCents: 19000, cyclesTotal: 4, startCycleStart: '2026-12-10' })).rejects.toThrow('link failed')
    expect(writes).toContain('savings_goals.update:off')
    expect(itemStatus).toBe('active')
  })
})
