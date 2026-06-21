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
  // Walk forward collecting dates in range
  while (current <= end) {
    if (current >= start) results.push(formatDate(current))
    if (frequency === 'weekly') current = addDays(current, 7)
    else if (frequency === 'fortnightly') current = addDays(current, 14)
    else if (frequency === 'monthly') current = addMonths(current, 1)
    else if (frequency === 'annually') current = addYears(current, 1)
  }
  return results
}