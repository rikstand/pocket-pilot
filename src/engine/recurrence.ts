import type { Frequency } from './types'
import { parseDate, formatDate, addDays, addMonthsClamped, daysBetween } from './dates'

/**
 * How far one step of a schedule goes, as days or as months.
 * everyN multiplies it: weekly × 3 = every 3 weeks, monthly × 3 = quarterly.
 * 'once' has no step.
 */
export function stepOf(frequency: Frequency, everyN = 1): { days: number } | { months: number } | null {
  const n = Math.max(1, Math.floor(everyN || 1))
  switch (frequency) {
    case 'daily':       return { days: n }
    case 'weekly':      return { days: 7 * n }
    case 'fortnightly': return { days: 14 * n }
    case 'monthly':     return { months: n }
    case 'annually':    return { months: 12 * n }
    default:            return null
  }
}

/** The k-th date of a schedule (k = 0 is the anchor itself), always worked out from the anchor. */
export function nthOccurrence(anchor: Date, frequency: Frequency, everyN: number, k: number): Date {
  const step = stepOf(frequency, everyN)
  if (!step) return new Date(anchor)
  return 'days' in step ? addDays(anchor, step.days * k) : addMonthsClamped(anchor, step.months * k)
}

/**
 * Every date a schedule falls on between rangeStart and rangeEnd, inclusive.
 *
 * endDate is the schedule's own last possible date (a BNPL plan's last payment,
 * a bill that stops). Nothing is ever charged before the anchor: a plan starting
 * next fortnight has no payment in this one.
 *
 * Each date is worked out from the anchor, not from the date before it, so a
 * monthly bill on the 31st falls on 28 Feb and then back on 31 Mar.
 *
 * everyN is last and optional so every existing caller keeps working unchanged.
 */
export function getOccurrencesInRange(
  anchorDate: string,
  frequency: Frequency,
  rangeStart: string,
  rangeEnd: string,
  endDate?: string,
  everyN = 1
): string[] {
  // Clip to whichever ends first: the window we're asked about, or the
  // schedule's own hard end date (if it has one).
  const effectiveEnd = endDate && endDate < rangeEnd ? endDate : rangeEnd

  if (frequency === 'once') {
    return anchorDate >= rangeStart && anchorDate <= effectiveEnd ? [anchorDate] : []
  }
  const step = stepOf(frequency, everyN)
  if (!step) return []

  const anchor = parseDate(anchorDate)
  const start  = parseDate(rangeStart)
  const end    = parseDate(effectiveEnd)
  if (end < anchor || end < start) return []

  // First step that could fall in the window. Never negative: nothing before the anchor.
  let k: number
  if ('days' in step) {
    k = Math.max(0, Math.ceil(daysBetween(anchor, start) / step.days))
  } else {
    const months = (start.getFullYear() - anchor.getFullYear()) * 12 + (start.getMonth() - anchor.getMonth())
    k = Math.max(0, Math.floor(months / step.months) - 1)
    while (nthOccurrence(anchor, frequency, everyN, k) < start) k++
  }

  const results: string[] = []
  for (let d = nthOccurrence(anchor, frequency, everyN, k); d <= end; d = nthOccurrence(anchor, frequency, everyN, ++k)) {
    if (d >= start) results.push(formatDate(d))
  }
  return results
}
