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

  // How the committed plan pays, chosen by the user on the Credit page:
  //   'minimum' — only what the card agreement asks
  //   'extra'   — the minimum plus strategyExtraCents
  //   'spare'   — the minimum plus whatever the cycle has above the floor,
  //               worked out fresh in every cycle
  // Optional so older callers still compile: missing means 'extra', which is
  // exactly what the engine did before plans had a mode.
  strategyMode?: 'minimum' | 'extra' | 'spare'

  // On a card with a monthly due date: does the extra go out with every pay
  // cycle, or only in the cycle that holds the due date? The user's choice,
  // in card settings. Ignored on a card paid every cycle. Missing means
  // 'every_cycle', the old behaviour.
  extraTiming?: 'every_cycle' | 'due_cycle'
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

// ── expense overrides ─────────────────────────────────────────────
// A different amount for ONE cycle, on any expense — "Christmas groceries",
// "power came in at $142", "skip the gym this fortnight". Same shape as the
// credit and savings overrides: an exception, not a new default. A new default
// is a new amount version, as it always was.
//
// Before this, a one-cycle change was stored as TWO amount versions: the new
// amount from this cycle, and the old amount put back from the next. That
// "put back" row could silently overwrite a change already made to the next
// cycle. An override touches nothing but its own cycle.
//
// amountCents is the whole cycle's amount, not the per-occurrence amount, so a
// weekly expense in a fortnightly cycle is set as one figure.
export interface ExpenseOverride {
  expenseId: string
  cycleStart: string
  amountCents: number
}

// The user's choice for ONE cycle. The minimum is contractual and
// deliberately not overridable.
//   choice 'extra' — the minimum plus extraCents (0 = minimum only)
//   choice 'spare' — the minimum plus whatever this cycle has above the
//                    floor, kept live: if the cycle changes after the choice,
//                    the payment follows
export interface CreditExtraOverride {
  cycleStart: string
  extraCents: number
  choice?: 'extra' | 'spare'   // missing means 'extra', as before
}

// A card payment confirmed with the amount that actually went out. The
// forecast uses this amount for that cycle instead of the plan.
export interface CreditPayment {
  cycleStart: string
  amountCents: number
}

export interface CycleInput {
  incomeSources: IncomeSource[]
  expenses: Expense[]
  openingBalanceCents: number
  startDate: string
  numCycles: number
  safetyFloorCents: number
  // The floor a "whatever's spare" payment keeps the account above. Always
  // the account's real floor, even when a caller passes a different
  // safetyFloorCents to recompute breaches (Settings passes 0). Defaults to
  // safetyFloorCents.
  spareFloorCents?: number
  creditAccount?: CreditAccount | null
  creditOverrides?: CreditExtraOverride[]
  creditPayments?: CreditPayment[]
  budgetSpend?: BudgetSpendEntry[]
  expenseOverrides?: ExpenseOverride[]
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
  // What this cycle has above the spare floor BEFORE the card payment — the
  // most a "whatever's spare" payment could be. Zero when no committed card.
  creditSpareCents: number

  committedClosingBalanceCents: number
  potentialClosingBalanceCents: number

  // Convenience for floor checks, now that the engine actually knows the
  // floor. Previously safetyFloorCents was a required input that
  // projectCycles() never read.
  safetyFloorCents: number
  breachesFloor: boolean
}
