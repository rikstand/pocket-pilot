import { projectFromRows, type ForecastResult } from '../lib/forecast'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { dateLocale } from '../lib/dateFormat'

const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const short = (d: string) => parseDate(d).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
const PAYS = 8

/**
 * The standard preview's numbers for a change made from a cycle: paydays as
 * they are now and with the change, starting at that cycle. When the change
 * moves the card (a "whatever's spare" plan, say), the third tile says when
 * the card clears instead of a date the change doesn't have.
 */
export function previewFor(rows: ForecastResult, floorCents: number, k0: number, changed: ForecastResult | null,
  money: (c: number) => string) {
  const span = k0 + PAYS
  const base = span <= rows.cycles.length ? rows.cycles : projectFromRows(rows, floorCents, span + 1)
  const now = base.slice(k0, span).map(c => c.committedClosingBalanceCents)
  const payDates = base.slice(k0, span).map(c => shift(c.endDate, 1))
  if (!changed) return { now, after: [] as number[], payDates, third: undefined }
  const aft = projectFromRows(changed, floorCents, span + 1)
  const after = aft.slice(k0, span).map(c => c.committedClosingBalanceCents)

  let third: { k: string; v: string; d: string; cls?: string } | undefined
  const cardMoves = !!rows.creditCard && aft.slice(k0, span).some((c, i) => Math.abs(c.creditPaymentCents - base[k0 + i].creditPaymentCents) > 50)
  if (cardMoves) {
    const L = 130
    const a = projectFromRows(rows, floorCents, L), b = projectFromRows(changed, floorCents, L)
    const clear = (cs: typeof a) => cs.findIndex((c, i) => i >= k0 && c.creditOpeningBalanceCents > 0 && c.creditClosingBalanceCents <= 0)
    const interest = (cs: typeof a) => cs.slice(k0).reduce((t, c) => t + c.creditInterestCents, 0)
    const ca = clear(a), cb = clear(b), dI = interest(b) - interest(a)
    if (ca >= 0) {
      const dC = cb < 0 ? null : cb - ca
      third = {
        k: 'Card cleared',
        v: cb >= 0 ? short(shift(b[cb].endDate, 1)) : 'Later',
        d: dC == null ? 'later' : dC ? `${Math.abs(dC)} cycle${Math.abs(dC) > 1 ? 's' : ''} ${dC > 0 ? 'later' : 'sooner'}`
          : Math.abs(dI) >= 100 ? `${dI > 0 ? '+' : '−'}${money(Math.abs(dI))} interest` : 'no change',
        cls: dC == null || dC > 0 ? 'near' : dC < 0 ? 'good' : '',
      }
    }
  }
  return { now, after, payDates, third }
}
