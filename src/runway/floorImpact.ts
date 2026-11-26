import { projectFromRows, type ForecastResult } from '../lib/forecast'
import { planModeOf } from '../lib/creditSchedule'
import { parseDate, formatDate, addDays } from '../engine/dates'

export const FLOOR_PAYDAYS = 13
const LONG = 130

const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const monthYear = (d: string) => parseDate(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })

/**
 * What a new floor changes, for the floor sheet: the paydays as they are and at
 * the new floor, how many sit under it, the wishlist in reach, and the third tile.
 * Closing balances only move with the floor on a "whatever's spare" card plan
 * (it pays everything above the floor); then the third tile says when the card
 * clears instead of how many paydays sit under.
 */
export function floorImpact(rows: ForecastResult, savedFloor: number, floor: number, wishlistCents: number[]) {
  const a = projectFromRows(rows, savedFloor, FLOOR_PAYDAYS)
  const b = projectFromRows(rows, floor, FLOOR_PAYDAYS)
  const now = a.map(c => c.committedClosingBalanceCents)
  const next = b.map(c => c.committedClosingBalanceCents)
  const payDates = b.map(c => shift(c.endDate, 1))
  const under = next.filter(v => v < floor).length
  const reach = wishlistCents.filter(w => next.some(v => v - w >= floor)).length
  const spareCard = !!rows.creditCard?.strategy_committed && planModeOf(rows.creditCard) === 'spare'

  let third: { k: string; v: string; d: string; cls?: string } = { k: 'Under the floor', v: `${under} of ${next.length}`, d: 'paydays', cls: under ? 'near' : '' }
  if (spareCard && floor !== savedFloor) {
    const la = projectFromRows(rows, savedFloor, LONG), lb = projectFromRows(rows, floor, LONG)
    const clear = (cs: typeof la) => cs.findIndex(c => c.creditOpeningBalanceCents > 0 && c.creditClosingBalanceCents <= 0)
    const ca = clear(la), cb = clear(lb)
    if (ca >= 0 && ca !== cb) {
      const dC = cb < 0 ? null : cb - ca
      third = {
        k: 'Card cleared',
        v: cb >= 0 ? monthYear(shift(lb[cb].endDate, 1)) : 'Later',
        d: dC == null ? `after ${monthYear(shift(la[la.length - 1].endDate, 1))}` : `${Math.abs(dC)} cycle${Math.abs(dC) > 1 ? 's' : ''} ${dC > 0 ? 'later' : 'sooner'}`,
        cls: dC == null || dC > 0 ? 'near' : 'good',
      }
    }
  }
  return { now, next, payDates, under, reach, spareCard, third }
}
