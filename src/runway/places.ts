/**
 * What the app knows about a place (Journey 11, release 8b): its last 6 closed
 * cycles, this cycle so far, its usual amount and the spend per visit.
 * Kept free of the database so it can be tested.
 */
export const PLACE_CYCLES = 6

export interface Window { start: string; end: string }
export interface PlaceStats {
  hist: number[]        // spend in each of the last closed cycles, oldest first
  visits: number[]
  soFar: number         // this cycle
  soFarVisits: number
  usual: number | null  // average of `hist` to the nearest dollar (cycles with no visit count as $0); null before any cycle closes
  perVisit: number | null
  ever: boolean         // anything ever logged here (decides Delete vs Merge/Archive)
}

/** The last closed cycles, oldest first. */
export function closedWindows(stored: { start_date: string; end_date: string; is_closed?: boolean }[], n = PLACE_CYCLES): Window[] {
  return stored.filter(c => c.is_closed).sort((a, b) => a.start_date.localeCompare(b.start_date))
    .slice(-n).map(c => ({ start: c.start_date, end: c.end_date }))
}

export function placeStats(
  payeeId: string,
  entries: { payee_id: string | null; spent_date: string; amount_cents: number; expense_id?: string }[],
  closed: Window[],
  current: Window,
  budgetId?: string,
): PlaceStats {
  const mine = entries.filter(e => e.payee_id === payeeId && (!budgetId || e.expense_id === budgetId))
  const inW = (w: Window) => mine.filter(e => e.spent_date >= w.start && e.spent_date <= w.end)
  const hist = closed.map(w => inW(w).reduce((s, e) => s + e.amount_cents, 0))
  const visits = closed.map(w => inW(w).length)
  const now = inW(current)
  const total = hist.reduce((s, v) => s + v, 0), seen = visits.reduce((s, v) => s + v, 0)
  return {
    hist, visits,
    soFar: now.reduce((s, e) => s + e.amount_cents, 0),
    soFarVisits: now.length,
    usual: closed.length ? Math.round(total / closed.length / 100) * 100 : null,
    perVisit: seen ? Math.round(total / seen) : null,
    ever: entries.some(e => e.payee_id === payeeId),
  }
}
