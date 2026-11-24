// savingsPlan.ts — a savings goal's plan as one set of controls (release 6b).
//
// The sheet's slider (the amount each cycle), its date row (saved by) and a
// pause all change the same thing: the one-cycle amounts stored for the goal
// and its standing amount. This works out what a change stores and what the
// forecast does with it, so the sheet's preview is exactly what saving does.
//
// Changes start the cycle after the one shown (k0 + 1). The cycle shown only
// changes by a skip. A goal's date is the start of the cycle its last
// set-aside falls in: it follows the amount, and the app never moves it on
// its own (agreed 24 Nov 2026).

import { projectFromRows, type ForecastResult } from './forecast'
import { contributionCents } from './savings'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { underFloor } from '../engine/floor'

export interface Draft {
  per: number              // the standing amount from the cycle after the one shown
  skip: boolean            // nothing in the cycle shown
  catchUp: boolean         // the skipped amount goes into the next cycle on top
  restart: number | null   // paused: nothing until this cycle (an index), then `per`
}

/** The amount each cycle that finishes `rem` in the cycles from..kD, rounded up to whole dollars. */
export function perFor(rem: number, from: number, kD: number): number {
  if (rem <= 0) return 0
  if (kD < from) return Math.ceil(rem / 100) * 100
  return Math.ceil(rem / (kD - from + 1) / 100) * 100
}

/**
 * The one-cycle amounts a draft stores, as changes to what's there now:
 * a number to set, null to clear. Cycles before the change keep the old
 * amount when the standing amount changes.
 */
export function draftOverrides(
  oldPer: number, d: Draft, k0: number, done: boolean,
  existing: (k: number) => number | undefined,   // the amount stored for cycle k, if any
  lineAt: (k: number) => number,                  // what the forecast takes in cycle k now
): Map<number, number | null> {
  const out = new Map<number, number | null>()
  const F = k0 + 1
  if (d.per !== oldPer) for (let k = 0; k < F; k++) if (existing(k) == null) out.set(k, oldPer)
  if (d.skip) out.set(k0, 0)
  if (d.restart != null) {
    for (let k = done && !d.skip ? F : k0; k < d.restart; k++) out.set(k, 0)
  } else if (d.catchUp && d.skip) {
    out.set(F, lineAt(k0) + d.per)
  }
  return out
}

/** `haveCents`: what the goal holds now (lib/savings). */
export function makePlanner(rows: ForecastResult, goal: any, accountId: string, floorCents: number, k0: number, haveCents: number) {
  const cycles = rows.cycles
  const n = cycles.length
  const len = n > 1 ? Math.round((parseDate(cycles[1].startDate).getTime() - parseDate(cycles[0].startDate).getTime()) / 864e5) : 14
  // Any cycle, before or past the forecast too (k < 0 is before it).
  const startOf = (k: number) => k >= 0 && k < n ? cycles[k].startDate
    : k < 0 ? formatDate(addDays(parseDate(cycles[0].startDate), len * k))
    : formatDate(addDays(parseDate(cycles[n - 1].startDate), len * (k - n + 1)))
  /** The cycle a date falls in (any date, past the forecast too). */
  const kOf = (d: string) => {
    let k = 0
    while (startOf(k + 1) <= d && k < 400) k++
    return k
  }
  const mine = (rows.savingsOverrideRows ?? []).filter((o: any) => o.savings_goal_id === goal.id)
  const existing = (k: number) => mine.find((o: any) => o.cycle_start === startOf(k))?.amount_cents as number | undefined
  const lineOf = (proj: typeof cycles, k: number) => proj[k]?.savingsLines.find(l => l.goalId === goal.id)?.amountCents ?? 0
  const done = (rows.savingsContributionRows ?? []).some((x: any) => x.savings_goal_id === goal.id && x.cycle_start === startOf(k0))

  const rowsFor = (d: Draft): ForecastResult => {
    const ch = draftOverrides(goal.per_cycle_cents, d, k0, done, existing, k => lineOf(cycles, k))
    const starts = new Map([...ch].map(([k, v]) => [startOf(k), v]))
    const ovs = [
      ...(rows.savingsOverrideRows ?? []).filter((o: any) => !(o.savings_goal_id === goal.id && starts.has(o.cycle_start))),
      ...[...starts].filter(([, v]) => v != null).map(([s, v]) => ({ savings_goal_id: goal.id, account_id: accountId, cycle_start: s, amount_cents: v })),
    ]
    return {
      ...rows, savingsOverrideRows: ovs,
      savingsGoalRows: rows.savingsGoalRows.map((g: any) => g.id === goal.id ? { ...g, per_cycle_cents: d.per } : g),
      // A cycle confirmed without its own amount counts at the goal's standing
      // amount, so a new amount would rewrite what's already saved. Fixed at
      // what it counts for now (saveDraft stores the same).
      savingsContributionRows: d.per === goal.per_cycle_cents ? rows.savingsContributionRows : stampedContributions(rows, goal),
    }
  }
  const project = (d: Draft) => projectFromRows(rowsFor(d), floorCents, n)

  /** The cycle the last set-aside falls in; past the forecast, worked out at the standing amount. */
  const finishOf = (proj: typeof cycles, per: number) => {
    let last = -1, planned = 0
    proj.forEach((_c, k) => { const a = lineOf(proj, k); planned += a; if (a > 0) last = k })
    const left = goal.target_cents - haveCents - planned
    return left > 0 && per > 0 ? n - 1 + Math.ceil(left / per) : last
  }

  const fromOf = (d: Draft) => d.restart ?? k0 + 1
  /** Still to save from the first changed cycle on, with this draft's earlier cycles. */
  const remFrom = (d: Draft) => {
    const proj = project({ ...d, catchUp: false })
    let before = 0
    for (let k = 0; k < fromOf(d); k++) before += lineOf(proj, k)
    return Math.max(0, goal.target_cents - haveCents - before)
  }
  /** Fits: no payday the change lowers ends under the floor (the Wishlist's rule). */
  const fits = (proj: typeof cycles, ref: typeof cycles) =>
    proj.every((c, k) => k < k0 || !underFloor(c.committedClosingBalanceCents, floorCents) || c.committedClosingBalanceCents >= ref[k].committedClosingBalanceCents - 50)
  const lowest = (proj: typeof cycles, ref: typeof cycles) => {
    let li = -1
    proj.forEach((c, k) => {
      if (k < k0 || !underFloor(c.committedClosingBalanceCents, floorCents) || c.committedClosingBalanceCents >= ref[k].committedClosingBalanceCents - 50) return
      if (li < 0 || c.committedClosingBalanceCents < proj[li].committedClosingBalanceCents) li = k
    })
    return li
  }
  const clearedAt = (proj: typeof cycles) => proj.findIndex(c => (c.creditOpeningBalanceCents ?? 0) > 0 && (c.creditClosingBalanceCents ?? 0) <= 0)

  return { rows, cycles, n, startOf, kOf, lineOf, done, existing, project, rowsFor, finishOf, fromOf, remFrom, fits, lowest, clearedAt, k0 }
}
export type Planner = ReturnType<typeof makePlanner>

/** The plain goals' set-asides take this payday under the floor: the first such one ahead, or -1. */
export function savingsDip(base: ForecastResult['cycles'], without: ForecastResult['cycles'], floorCents: number, within = 24): number {
  return base.findIndex((c, k) => k < within && underFloor(c.committedClosingBalanceCents, floorCents) && !underFloor(without[k]?.committedClosingBalanceCents ?? -Infinity, floorCents))
}

/** This goal's confirmed cycles with no amount of their own, each with what it counts for now. */
export function unstamped(rows: Pick<ForecastResult, 'savingsContributionRows' | 'savingsOverrideRows'>, goal: any) {
  return (rows.savingsContributionRows ?? [])
    .filter((c: any) => c.savings_goal_id === goal.id && c.amount_cents == null)
    .map((c: any) => ({ ...c, amount_cents: contributionCents(goal, c, rows.savingsOverrideRows) }))
}
function stampedContributions(rows: ForecastResult, goal: any) {
  const fixed = unstamped(rows, goal)
  return (rows.savingsContributionRows ?? []).map((c: any) => fixed.find(f => f.savings_goal_id === c.savings_goal_id && f.cycle_start === c.cycle_start) ?? c)
}
