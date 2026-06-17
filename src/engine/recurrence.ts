import type { Frequency } from './types'
import { parseDate, formatDate, addDays, addMonths, addYears } from './dates'

export function getOccurrencesInRange(
  anchorDate: string,
  frequency: Frequency,
  rangeStart: string,
  rangeEnd: string
): string[] {
  if (frequency === 'once') {
    return anchorDate >= rangeStart && anchorDate <= rangeEnd ? [anchorDate] : []
  }

  const anchor = parseDate(anchorDate)
  const start = parseDate(rangeStart)
  const end = parseDate(rangeEnd)
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