import { cycleRuleOn, toEngineExpenses, toEngineIncome, type ForecastResult } from '../lib/forecast'
import { versionForDate } from '../lib/versions'
import { occurrencesOf } from '../engine/index'
import { budgetAmountForCycle } from '../engine/engine'

/**
 * What a closed cycle's records say happened: pay, fixed expenses and BNPL,
 * estimates (with the real figure saved at or after the close), the card
 * payment, savings set aside and budgets with what was logged.
 *
 * Past cycles (Journey 10) shows this; By type (release 7) uses it for past
 * pays and for Spending vs forecast. Moved here from PastCycles unchanged,
 * plus each estimate's usual amount and its one-cycle amount, kept apart.
 */
export function describeCycle(c: any, rows: ForecastResult, actuals: any[]) {
  const s = c.start_date, e = c.end_date
  const spread = (total: number, n: number, k: number) => { const each = Math.floor(total / n); return k === n - 1 ? total - each * (n - 1) : each }

  const income = rows.incomeRows.filter((r: any) => !r.is_potential).flatMap((r: any) => {
    const occs = occurrencesOf(toEngineIncome([r])[0], s, e)
    const ov = (rows.incomeOverrideRows ?? []).find((o: any) => o.income_source_id === r.id && o.cycle_start === s)
    return occs.map((d: string, k: number) => ({ key: `${r.id}-${d}`, name: r.name, date: d,
      cents: ov ? spread(ov.amount_cents, occs.length, k) : versionForDate(r.income_amount_versions, d)?.amount_cents ?? 0 }))
  })

  const fixed: any[] = [], estimates: any[] = []
  for (const r of rows.expenseRows) {
    if ((r.mode ?? 'fixed') === 'budget') continue
    const occs = occurrencesOf(toEngineExpenses([r])[0], s, e)
    if (!occs.length) continue
    const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === s)
    const usual = occs.reduce((t: number, d: string) => t + (versionForDate(r.expense_amount_versions, d)?.amount_cents ?? 0), 0)
    if (r.mode === 'variable') {
      const saved = actuals.filter(a => a.cycle_id === c.id && a.expense_id === r.id).pop()
      estimates.push({ id: r.id, name: r.name, dates: occs, estimate: ov ? ov.amount_cents : usual,
        usual, override: ov ? ov.amount_cents as number : null,
        actual: saved ? saved.actual_amount_cents : null, savedRow: saved ?? null })
    } else {
      occs.forEach((d: string, k: number) => fixed.push({ key: `${r.id}-${d}`, name: r.name, date: d, bnpl: !!r.lay_by_id,
        cents: ov ? spread(ov.amount_cents, occs.length, k) : versionForDate(r.expense_amount_versions, d)?.amount_cents ?? 0 }))
    }
  }
  fixed.sort((a, b) => a.date.localeCompare(b.date))

  const paid = (rows.creditPaymentRows ?? []).find((p: any) => p.cycle_start === s)
  const card = paid && rows.creditCard ? { name: rows.creditCard.name ?? 'Card', cents: paid.amount_cents ?? 0 } : null

  const savings = (rows.savingsContributionRows ?? []).filter((x: any) => x.cycle_start === s).map((x: any) => {
    const g = (rows.savingsGoalRows ?? []).find((g: any) => g.id === x.savings_goal_id)
    const ov = (rows.savingsOverrideRows ?? []).find((o: any) => o.savings_goal_id === x.savings_goal_id && o.cycle_start === s)
    return { key: x.id, name: g?.name ?? 'Savings', cents: x.amount_cents ?? ov?.amount_cents ?? g?.per_cycle_cents ?? 0 }
  })

  const rule = cycleRuleOn(rows.incomeRows, s)
  const budgets = rows.expenseRows.filter((r: any) => r.mode === 'budget').map((r: any) => {
    const ov = (rows.expenseOverrideRows ?? []).find((o: any) => o.expense_id === r.id && o.cycle_start === s)
    const planned = ov ? ov.amount_cents : budgetAmountForCycle(toEngineExpenses([r])[0], s, e, rule)
    const entries = (rows.budgetSpendRows ?? []).filter((x: any) => x.expense_id === r.id && x.spent_date >= s && x.spent_date <= e)
    return { id: r.id, name: r.name, planned, entries, spent: entries.reduce((t: number, x: any) => t + x.amount_cents, 0) }
  }).filter((b: any) => b.planned > 0 || b.spent !== 0)

  return { income, fixed, card, estimates, savings, budgets }
}

export type CycleRecord = ReturnType<typeof describeCycle>
