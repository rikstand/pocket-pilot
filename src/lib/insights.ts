import type { CycleResult } from '../engine/types'
import type { CycleRecord } from '../runway/cycleRecord'

/**
 * Release 7, By type: where each pay goes, and how spending compared with
 * the forecast. Pure, so it can be tested on its own.
 *
 * Types are the expense modes the app already has. No categories to set up.
 */
export type TypeKey = 'fixed' | 'budgets' | 'estimates' | 'bnpl' | 'savings' | 'card'
export const TYPE_ORDER: TypeKey[] = ['fixed', 'budgets', 'estimates', 'bnpl', 'savings', 'card']
export const TYPE_NAME: Record<TypeKey, string> = {
  fixed: 'Fixed', budgets: 'Budgets', estimates: 'Estimates', bnpl: 'BNPL', savings: 'Savings', card: 'Card',
}
export type Split = Record<TypeKey, number> & { pay: number }

const zero = (): Split => ({ fixed: 0, budgets: 0, estimates: 0, bnpl: 0, savings: 0, card: 0, pay: 0 })
export const outOf = (s: Split) => TYPE_ORDER.reduce((t, k) => t + s[k], 0)

/** A cycle the forecast projects: what the engine takes out, by type.
 *  `bnpl` is that cycle's BNPL payments, which the engine counts as fixed. */
export function splitOfProjected(c: CycleResult, bnpl: number): Split {
  return {
    fixed: Math.max(0, c.fixedExpensesCents - bnpl), bnpl,
    estimates: c.variableExpensesCents, budgets: c.budgetExpensesCents,
    savings: c.savingsTotalCents, card: c.creditPaymentCents, pay: c.committedIncomeCents,
  }
}

/** A closed cycle: what its records say went out. Budgets are what was logged. */
export function splitOfClosed(rec: CycleRecord): Split {
  const s = zero()
  for (const f of rec.fixed) s[f.bnpl ? 'bnpl' : 'fixed'] += f.cents
  for (const e of rec.estimates) s.estimates += e.actual ?? e.estimate
  for (const b of rec.budgets) s.budgets += b.spent
  for (const x of rec.savings) s.savings += x.cents
  s.card = rec.card?.cents ?? 0
  s.pay = rec.income.reduce((t: number, i: any) => t + i.cents, 0)
  return s
}

/** The average of each type over some cycles: "a pay, on average". */
export function averageSplit(splits: Split[]): Split {
  const s = zero()
  if (!splits.length) return s
  for (const x of splits) for (const k of [...TYPE_ORDER, 'pay'] as const) s[k] += x[k]
  for (const k of [...TYPE_ORDER, 'pay'] as const) s[k] = Math.round(s[k] / splits.length)
  return s
}

/* ── Spending vs forecast ─────────────────────────────────────────────
 * Spending only, so a card plan of "whatever's spare" (which always closes
 * at the floor) can't hide it. Positive = spent more than the forecast said.
 *
 *  budgets    logged minus what the budget was
 *  estimates  the real figure (saved at the close, else confirmed in the
 *             cycle) minus the usual estimate
 *  not logged what the bank showed at the close that the records don't
 *             explain: the same sum Past cycles shows, turned around
 *
 * Only closed cycles with a forecast saved at the close can say this.
 */
export interface Move { id: string; name: string; kind: 'budget' | 'estimate' | 'unlogged'; v: number }

export function movesOf(c: any, rec: CycleRecord): { moved: number; parts: Move[] } {
  const diff = c.closing_balance_cents - Number(c.projected_close_cents)
  let explained = 0
  const parts: Move[] = []
  for (const b of rec.budgets) {
    explained += Math.max(0, b.planned - b.spent)
    parts.push({ id: b.id, name: b.name, kind: 'budget', v: b.spent - b.planned })
  }
  for (const e of rec.estimates) {
    if (e.actual != null) explained += e.estimate - e.actual
    const real = e.actual ?? e.override
    if (real != null) parts.push({ id: e.id, name: e.name, kind: 'estimate', v: real - e.usual })
  }
  parts.push({ id: 'unlogged', name: 'Not logged', kind: 'unlogged', v: explained - diff })
  return { moved: parts.reduce((t, x) => t + x.v, 0), parts }
}

export const hasForecast = (c: any) => c.is_closed && c.projected_close_cents != null && !c.closed_on_forecast

/**
 * Each row's average a cycle, in whole dollars, adding up exactly to the
 * average shown on the chart (largest remainder). Rows that round to $0 go.
 */
export function averageMoves(cycles: { moved: number; parts: Move[] }[]): { avg: number; rows: Move[] } {
  const n = cycles.length
  if (!n) return { avg: 0, rows: [] }
  const by = new Map<string, Move>()
  for (const c of cycles) for (const p of c.parts) {
    const m = by.get(p.id) ?? { ...p, v: 0 }
    m.v += p.v; by.set(p.id, m)
  }
  const rows = [...by.values()].map(m => ({ ...m, v: m.v / n }))
  const exact = rows.map(r => r.v)
  const avg = Math.round(cycles.reduce((t, c) => t + c.moved, 0) / n / 100) * 100
  rows.forEach(r => { r.v = Math.round(r.v / 100) * 100 })
  let gap = avg - rows.reduce((t, r) => t + r.v, 0)
  while (gap !== 0 && rows.length) {
    const st = gap > 0 ? 100 : -100
    let bi = 0
    exact.forEach((x, j) => { if ((x - rows[j].v) * Math.sign(st) > (exact[bi] - rows[bi].v) * Math.sign(st)) bi = j })
    rows[bi].v += st; gap -= st
  }
  return { avg, rows: rows.filter(r => r.v !== 0).sort((a, b) => b.v - a.v) }
}
