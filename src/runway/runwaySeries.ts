import { addDays, formatDate, parseDate } from '../engine/dates'

/**
 * Your balance at the end of each day of one cycle: the runway line.
 *
 * The engine works per cycle; this spreads one cycle over its days so the
 * line can be drawn. Everything with a date lands on its date. Budgets are
 * the one thing without dates:
 *   - days up to today: what was actually logged, on the day it was logged;
 *   - days after today: what's left of each budget, spread evenly.
 * So the line ends where the forecast does (left before pay), and doesn't
 * look better than it is until the last day.
 */
export interface RunwayEvent { date: string; cents: number }   // + in, − out
export interface RunwayBudget { plannedCents: number; entries: RunwayEvent[] } // entries: cents spent, positive

export interface RunwayInput {
  start: string
  end: string
  today: string
  openingCents: number
  events: RunwayEvent[]
  budgets: RunwayBudget[]
  // The engine's own figure for the end of the cycle. If given, any gap
  // between it and the sum here lands on the last day, so the line and the
  // hero can never disagree. Normally zero; `gapCents` reports it.
  expectedClosingCents?: number
}

export interface Runway {
  days: string[]
  openingCents: number
  balances: number[]       // end of each day
  outByDay: number[]       // money out each day (positive), for the item dots
  gapCents: number
}

export function buildRunway(input: RunwayInput): Runway {
  const { start, end, today, openingCents, events, budgets } = input
  const days: string[] = []
  for (let d = start; d <= end; d = formatDate(addDays(parseDate(d), 1))) days.push(d)
  const n = days.length
  const delta = new Array<number>(n).fill(0)
  const out = new Array<number>(n).fill(0)
  const at = (date: string) => days.indexOf(date)

  for (const e of events) {
    const i = at(e.date)
    if (i < 0) continue
    delta[i] += e.cents
    if (e.cents < 0) out[i] -= e.cents
  }

  // Days the rest of each budget is spread over: those after today. With
  // none left (the last day, or a cycle that has ended) it all lands on the
  // last day.
  const later = days.map((d, i) => (d > today ? i : -1)).filter(i => i >= 0)
  const spreadOver = later.length ? later : [n - 1]

  for (const b of budgets) {
    let spent = 0
    for (const e of b.entries) {
      const i = at(e.date)
      if (i < 0) continue
      delta[i] -= e.cents
      out[i] += e.cents
      spent += e.cents
    }
    const rest = Math.max(0, b.plannedCents - spent)
    if (rest === 0) continue
    const each = Math.floor(rest / spreadOver.length)
    spreadOver.forEach((i, k) => {
      const c = k === spreadOver.length - 1 ? rest - each * (spreadOver.length - 1) : each
      delta[i] -= c
      out[i] += c
    })
  }

  const balances: number[] = []
  let bal = openingCents
  for (let i = 0; i < n; i++) { bal += delta[i]; balances.push(bal) }

  let gapCents = 0
  if (input.expectedClosingCents != null && n > 0) {
    gapCents = input.expectedClosingCents - balances[n - 1]
    if (gapCents !== 0) {
      balances[n - 1] += gapCents
      if (gapCents < 0) out[n - 1] -= gapCents
    }
  }
  return { days, openingCents, balances, outByDay: out, gapCents }
}
