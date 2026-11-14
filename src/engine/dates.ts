export function parseDate(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day)
}

export function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(d: Date, n: number): Date {
  const result = new Date(d)
  result.setDate(result.getDate() + n)
  return result
}

// Plain JavaScript month arithmetic: 31 Jan + 1 month = 3 Mar. Kept as it was
// for anything that already relies on it. Anything stepping through a schedule
// should use addMonthsClamped instead.
export function addMonths(d: Date, n: number): Date {
  const result = new Date(d)
  result.setMonth(result.getMonth() + n)
  return result
}

export function addYears(d: Date, n: number): Date {
  const result = new Date(d)
  result.setFullYear(result.getFullYear() + n)
  return result
}

/**
 * n months on from d, landing on the last day of the month when the day does
 * not exist there: 31 Jan + 1 = 28 Feb (29 in a leap year), 31 Jan + 2 = 31 Mar.
 *
 * Always step from the ORIGINAL date, never from the previous result. Stepping
 * from 28 Feb would give 28 Mar and the 31st would be lost for good — the bug
 * this replaces, where a bill on the 31st drifted to the 3rd and stayed there.
 */
export function addMonthsClamped(d: Date, n: number): Date {
  const y = d.getFullYear()
  const m = d.getMonth() + n
  const lastDay = new Date(y, m + 1, 0).getDate()
  return new Date(y, m, Math.min(d.getDate(), lastDay))
}

/** Whole days from a to b (b − a). Both are local midnights, so rounding absorbs daylight saving. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}
