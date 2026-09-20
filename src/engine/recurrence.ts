import type { Frequency } from './types'
import { parseDate, formatDate, addDays, addMonths, addYears } from './dates'

export function getOccurrencesInRange(
  anchorDate: string,
  frequency: Frequency,
  rangeStart: string,
  rangeEnd: string,
  endDate?: string
): string[] {
  // Clip to whichever ends first: the cycle window we're asked about, or the
  // expense's own hard end date (if it has one). This is what lets a lay-by
  // stop generating occurrences once it's paid off.
  const effectiveEnd = endDate && endDate < rangeEnd ? endDate : rangeEnd

  if (frequency === 'once') {
    return anchorDate >= rangeStart && anchorDate <= effectiveEnd ? [anchorDate] : []
  }
  const anchor = parseDate(anchorDate)
  const start = parseDate(rangeStart)
  const end = parseDate(effectiveEnd)
  const results: string[] = []
  // Wind anchor back to before range start
  let current = new Date(anchor)
  while (current > start) {
    if (frequency === 'weekly') current = addDays(current, -7)
    else if (frequency === 'fortnightly') current = addDays(current, -14)
    else if (frequency === 'monthly') current = addMonths(current, -1)
    else if (frequency === 'annually') current = addYears(current, -1)
  }
  // Walk forward collecting dates in range.
  //
  // `current >= anchor` is what stops something being charged before it
  // starts. Finding the pattern means stepping BACKWARDS from the anchor until
  // we are before the window, and those wound-back dates are real dates the
  // loop would otherwise collect. Anything anchored in the future would pick up
  // a phantom occurrence in the current cycle — a four-payment lay-by starting
  // next fortnight billed five times.
  while (current <= end) {
    if (current >= start && current >= anchor) results.push(formatDate(current))
    if (frequency === 'weekly') current = addDays(current, 7)
    else if (frequency === 'fortnightly') current = addDays(current, 14)
    else if (frequency === 'monthly') current = addMonths(current, 1)
    else if (frequency === 'annually') current = addYears(current, 1)
  }
  return results
}