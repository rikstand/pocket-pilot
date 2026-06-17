// AmountVersion — a dated amount record. The engine picks the latest
// version whose effectiveFrom <= the cycle start date, so you can have
// per-cycle overrides and permanent changes on the same expense.
export type Frequency = 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annually'

export interface AmountVersion {
  amountCents: number
  effectiveFrom: string
}

export interface IncomeSource {
  id: string
  name: string
  frequency: Frequency
  anchorDate: string
  amountCents: number   // fallback if no versions supplied
  isPotential: boolean
}

export interface Expense {
  id: string
  name: string
  frequency: Frequency
  anchorDate: string
  amountCents: number          // fallback if amountVersions is empty
  amountVersions: AmountVersion[]
  mode: 'fixed' | 'variable' | 'budget'
}

export interface CycleInput {
  incomeSources: IncomeSource[]
  expenses: Expense[]
  openingBalanceCents: number
  startDate: string
  numCycles: number
  safetyFloorCents: number
}

export interface CycleResult {
  startDate: string
  endDate: string
  openingBalanceCents: number
  committedIncomeCents: number
  potentialIncomeCents: number
  fixedExpensesCents: number
  variableExpensesCents: number
  budgetExpensesCents: number
  committedClosingBalanceCents: number
  potentialClosingBalanceCents: number
}