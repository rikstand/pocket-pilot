/**
 * Dates read the way the phone's region writes them (UX fix 25, agreed 27 Nov:
 * the phone's region, not the account's currency, so a USD account kept by a
 * New Zealander still reads "26 Nov"). Numbers and money keep their own format.
 */
export function dateLocale(): string | undefined {
  try { return typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined } catch { return undefined }
}

/** "Thu 19": the weekday then the day, in every region (some regions would print "19 Thu"). */
export function weekdayDay(d: Date): string {
  return `${d.toLocaleDateString(dateLocale(), { weekday: 'short' })} ${d.getDate()}`
}
/** Day and month in the phone's order ("25 Nov", "Nov 25"), never by trimming a longer label. */
export function dayMonth(d: Date): string { return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) }
