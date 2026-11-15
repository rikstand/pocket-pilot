import type { Frequency, ScheduleVersion } from './types'
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

// ── schedules from a date ───────────────────────────────────────────
/** How an item repeats: what one schedule needs. */
export interface Schedule {
  frequency: Frequency
  everyN?: number
  anchorDate: string
}

/** Anything with a schedule, an optional end date and schedule changes. */
export interface Scheduled extends Schedule {
  endDate?: string
  schedules?: ScheduleVersion[]
  skipDates?: string[]      // payments that didn't go out
}

/**
 * The schedule changes in date order, one per date. Two changes saved for the
 * same date: the newest written wins — callers pass them newest-first, the
 * same order as amount versions.
 */
export function changesInOrder(versions: ScheduleVersion[] | undefined): ScheduleVersion[] {
  const seen = new Set<string>()
  const out: ScheduleVersion[] = []
  for (const v of versions ?? []) {
    if (seen.has(v.effectiveFrom)) continue
    seen.add(v.effectiveFrom)
    out.push(v)
  }
  return out.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
}

/** The schedule in force on a date. */
export function scheduleOn(item: Scheduled, onDate: string): Schedule {
  let s: Schedule = item
  for (const v of changesInOrder(item.schedules)) {
    if (v.effectiveFrom <= onDate) s = v
    else break
  }
  return s
}

/**
 * The stretches of [rangeStart, rangeEnd] and the schedule in force over each.
 * One stretch when nothing changes inside the range.
 */
export function scheduleSegments(
  item: Scheduled, rangeStart: string, rangeEnd: string
): { from: string; to: string; schedule: Schedule }[] {
  const changes = changesInOrder(item.schedules).filter(v => v.effectiveFrom > rangeStart && v.effectiveFrom <= rangeEnd)
  const out: { from: string; to: string; schedule: Schedule }[] = []
  let from = rangeStart
  let sched = scheduleOn(item, rangeStart)
  for (const v of changes) {
    out.push({ from, to: formatDate(addDays(parseDate(v.effectiveFrom), -1)), schedule: sched })
    from = v.effectiveFrom
    sched = v
  }
  out.push({ from, to: rangeEnd, schedule: sched })
  return out
}

/**
 * Every date an item falls on between rangeStart and rangeEnd, following any
 * schedule changes: the old schedule up to the day before a change, the new
 * one from it. With no changes this is exactly getOccurrencesInRange.
 */
export function occurrencesOf(item: Scheduled, rangeStart: string, rangeEnd: string): string[] {
  let out: string[]
  if (!item.schedules || item.schedules.length === 0) {
    out = getOccurrencesInRange(item.anchorDate, item.frequency, rangeStart, rangeEnd, item.endDate, item.everyN ?? 1)
  } else {
    out = []
    for (const seg of scheduleSegments(item, rangeStart, rangeEnd)) {
      out.push(...getOccurrencesInRange(seg.schedule.anchorDate, seg.schedule.frequency, seg.from, seg.to, item.endDate, seg.schedule.everyN ?? 1))
    }
  }
  // A payment that didn't go out isn't money leaving the account.
  if (item.skipDates && item.skipDates.length > 0) {
    const skip = new Set(item.skipDates)
    out = out.filter(d => !skip.has(d))
  }
  return out
}
