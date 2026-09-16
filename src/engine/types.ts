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
