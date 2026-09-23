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
  isPrimary: boolean    // identifies which income source drives cycle length —
                         // without this, projectCycles() falls back to array
                         // order, which silently picks the wrong source on any
                         // account with more than one non-potential income.
}
export interface Expense {
  id: string
  name: string
  frequency: Frequency
  anchorDate: string
  amountCents: number          // fallback if amountVersions is empty
  amountVersions: AmountVersion[]
  mode: 'fixed' | 'variable' | 'budget'
  endDate?: string             // last date this can occur on. undefined = recurs forever (default, unchanged behaviour). Powers lay-by self-retirement.
}

// ── credit ────────────────────────────────────────────────────────
// A revolving card balance is not an expense: it is a running quantity that
// changes every cycle. The payment it produces is DERIVED inside the cycle
// loop from the balance, never stored, so the minimum falls as the balance
// falls and the line self-terminates at payoff.
//
// Consequence worth knowing: with a card attached, cycle N can no longer be
// resolved in isolation. The engine must walk from a known-good balance,
// because each cycle's card payment depends on the previous cycle's closing
// card balance. projectCycles() already iterates in order, so this is safe —
// but anything that projects a single cycle standalone is not.
export interface CreditAccount {
  id: string
  name: string
  aprBasisPoints: number         // 2190 = 21.90% p.a.
  minPaymentPct: number          // monthly percentage of balance, e.g. 3
  minPaymentFloorCents: number   // e.g. 1000 = $10
  assumedSpendCents: number      // expected new spending per cycle
  strategyExtraCents: number     // committed extra above the minimum
  strategyCommitted: boolean     // nothing reaches the forecast until true
  currentBalanceCents: number    // from the latest balance snapshot

  // When the payment is actually due. 'per_cycle' shares the monthly minimum
  // across every cycle, which is what the app did before due dates existed.
  // 'monthly' puts the whole minimum in the cycle containing the due date and
  // none in the others — which is how most cards really work.
  paymentFrequency: 'per_cycle' | 'monthly'
  paymentAnchorDate?: string     // the due date; only the day of month matters
}

// ── budget spend ──────────────────────────────────────────────────
// What was ACTUALLY spent against a budget, as logged. The projection takes
// the higher of the baseline and this: you cannot unspend money, so going over
// has to show up in the closing balance. Under budget stays conservative.
export interface BudgetSpendEntry {
  expenseId: string
  amountCents: number
  spentDate: string
}

// ── savings goals ─────────────────────────────────────────────────
// Deliberately the same shape as credit, and for the same reason. A savings
// goal is not an expense: it is a target with a running total, and the amount
// each cycle is DERIVED from it.
//
// The alternative — a stored recurring expense — meant the forecast subtracted
// the money whether or not you actually set it aside. Skip a cycle and your
// real balance would be higher than the app thought, while the progress bar
// counted a contribution that never happened. Deriving it keeps the forecast
// and the progress honest about the same thing.
export interface SavingsOverride {
  cycleStart: string
  amountCents: number
}

export interface SavingsGoal {
  id: string
  name: string
  targetCents: number
  perCycleCents: number
  startCycleStart: string
  /** Confirmed so far, or a corrected figure. Set by the caller, not the engine. */
  savedSoFarCents: number
  overrides: SavingsOverride[]
}

/** What one goal takes from one cycle. */
export interface SavingsCycleLine {
  goalId: string
  name: string
  amountCents: number
  targetCents: number
  /** Still to find after this cycle's amount. Zero means the goal completes here. */
  remainingAfterCents: number
  isOverride: boolean
}

// Adjusts ONLY the extra portion, for one cycle. The minimum is contractual
// and deliberately not overridable.
export interface CreditExtraOverride {
  cycleStart: string
  extraCents: number
}

export interface CycleInput {
  incomeSources: IncomeSource[]
  expenses: Expense[]
  openingBalanceCents: number
  startDate: string
  numCycles: number
  safetyFloorCents: number
  creditAccount?: CreditAccount | null
  creditOverrides?: CreditExtraOverride[]
  budgetSpend?: BudgetSpendEntry[]
  savingsGoals?: SavingsGoal[]
}

export interface CycleResult {
  startDate: string
  endDate: string
  openingBalanceCents: number
  committedIncomeCents: number
  potentialIncomeCents: number
  fixedExpensesCents: number
  variableExpensesCents: number
  // What is actually subtracted for budgets: the HIGHER of the baseline and
  // what was logged. Overspending used to vanish from the forecast entirely —
  // the closing balance kept assuming the baseline no matter what was spent.
  budgetExpensesCents: number
  budgetBaselineCents: number   // what the budgets are set to
  budgetActualCents: number     // what was logged in this cycle

  // ── savings, zero when no active goals ──
  savingsTotalCents: number
  savingsLines: SavingsCycleLine[]

  // ── credit, zero when no committed card ──
  creditOpeningBalanceCents: number
  creditAssumedSpendCents: number
  creditInterestCents: number
  creditMinimumCents: number    // contractual, not adjustable
  creditExtraCents: number      // discretionary, adjustable per cycle
  creditPaymentCents: number    // minimum + extra, deducted from balance
  creditClosingBalanceCents: number

  committedClosingBalanceCents: number
  potentialClosingBalanceCents: number

  // Convenience for floor checks, now that the engine actually knows the
  // floor. Previously safetyFloorCents was a required input that
  // projectCycles() never read.
  safetyFloorCents: number
  breachesFloor: boolean
}
