import type { CycleInput, CycleResult, AmountVersion } from './types'
import { parseDate, formatDate, addDays, addMonths, addYears } from './dates'
import { getOccurrencesInRange } from './recurrence'

function getCycleEnd(startDate: string, frequency: string): string {
  const d = parseDate(startDate)
  if (frequency === 'weekly')      return formatDate(addDays(d, 6))
  if (frequency === 'fortnightly') return formatDate(addDays(d, 13))
  if (frequency === 'monthly')     return formatDate(addDays(addMonths(d, 1), -1))
  if (frequency === 'annually')    return formatDate(addDays(addYears(d, 1), -1))
  return formatDate(addDays(d, 13))
}

function nextCycleStart(startDate: string, frequency: string): string {
  const d = parseDate(startDate)
  if (frequency === 'weekly')      return formatDate(addDays(d, 7))
  if (frequency === 'fortnightly') return formatDate(addDays(d, 14))
  if (frequency === 'monthly')     return formatDate(addMonths(d, 1))
  if (frequency === 'annually')    return formatDate(addYears(d, 1))
  return formatDate(addDays(d, 14))
}

// Pick the latest amount version whose effectiveFrom <= cycleStart.
// Falls back to amountCents if no versions are available or none apply yet.
function getAmountForCycle(
  versions: AmountVersion[],
  fallback: number,
  cycleStart: string
): number {
  if (!versions || versions.length === 0) return fallback
  const applicable = versions
    .filter(v => v.effectiveFrom <= cycleStart)
    .sort((a, b) => a.effectiveFrom > b.effectiveFrom ? -1 : 1)
  if (applicable.length > 0) return applicable[0].amountCents
  // Fallback: use earliest version if none are effective yet for this cycle
  const earliest = [...versions].sort((a, b) => a.effectiveFrom < b.effectiveFrom ? -1 : 1)[0]
  return earliest?.amountCents ?? fallback
}

export function projectCycles(input: CycleInput): CycleResult[] {
  const { incomeSources, expenses, openingBalanceCents, startDate, numCycles } = input
  const results: CycleResult[] = []

  const primary = incomeSources.find(s => !s.isPotential) ?? incomeSources[0]
  const cycleFrequency = primary?.frequency ?? 'fortnightly'

  let cycleStart       = startDate
  let committedBalance = openingBalanceCents

  for (let i = 0; i < numCycles; i++) {
    const cycleEnd = getCycleEnd(cycleStart, cycleFrequency)

    // ── income ──────────────────────────────────────────────────────
    let committedIncomeCents = 0
    let potentialIncomeCents = 0
    for (const src of incomeSources) {
      const occs  = getOccurrencesInRange(src.anchorDate, src.frequency, cycleStart, cycleEnd)
      const total = occs.length * src.amountCents
      if (src.isPotential) potentialIncomeCents += total
      else committedIncomeCents += total
    }

    // ── expenses — cycle-aware amount selection ──────────────────────
    let fixedExpensesCents    = 0
    let variableExpensesCents = 0
    let budgetExpensesCents   = 0
    for (const exp of expenses) {
      const occs       = getOccurrencesInRange(exp.anchorDate, exp.frequency, cycleStart, cycleEnd)
      const unitCents  = getAmountForCycle(exp.amountVersions, exp.amountCents, cycleStart)
      const total      = occs.length * unitCents
      if      (exp.mode === 'fixed')    fixedExpensesCents    += total
      else if (exp.mode === 'variable') variableExpensesCents += total
      else if (exp.mode === 'budget')   budgetExpensesCents   += total
    }

    // ── balances ─────────────────────────────────────────────────────
    const committedClosingBalanceCents =
      committedBalance + committedIncomeCents
      - fixedExpensesCents - variableExpensesCents - budgetExpensesCents

    const potentialClosingBalanceCents =
      committedClosingBalanceCents + potentialIncomeCents

    results.push({
      startDate: cycleStart, endDate: cycleEnd,
      openingBalanceCents: committedBalance,
      committedIncomeCents, potentialIncomeCents,
      fixedExpensesCents, variableExpensesCents, budgetExpensesCents,
      committedClosingBalanceCents, potentialClosingBalanceCents,
    })

    committedBalance = committedClosingBalanceCents
    cycleStart = nextCycleStart(cycleStart, cycleFrequency)
  }

  return results
}