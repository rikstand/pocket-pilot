import { supabase } from './supabase'

// --- ACCOUNTS ---
export async function getAccounts(userId: string) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at')
  if (error) throw error
  return data
}

export async function createAccount(
  userId: string,
  name: string,
  currencyCode: string,
  openingBalanceCents: number,
  safetyFloorCents: number
) {
  const { data, error } = await supabase
    .from('accounts')
    .insert({ user_id: userId, name, currency_code: currencyCode, opening_balance_cents: openingBalanceCents, safety_floor_cents: safetyFloorCents })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateAccount(
  accountId: string,
  fields: { name?: string; currency_code?: string; safety_floor_cents?: number }
) {
  const { data, error } = await supabase
    .from('accounts')
    .update(fields)
    .eq('id', accountId)
    .select()
    .single()
  if (error) throw error
  return data
}

// --- PROFILE ---
export async function getProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error) throw error
  return data
}

export async function upsertProfile(userId: string, displayName: string) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, display_name: displayName })
    .select()
    .single()
  if (error) throw error
  return data
}

// --- INCOME SOURCES ---
export async function getIncomeSources(accountId: string) {
  const { data, error } = await supabase
    .from('income_sources')
    .select(`*, income_amount_versions(*)`)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

// --- EXPENSES ---
export async function getExpenses(accountId: string) {
  const { data, error } = await supabase
    .from('expenses')
    .select(`*, expense_amount_versions(*)`)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

// --- LAY-BYS ---
export async function getLayBys(accountId: string) {
  const { data, error } = await supabase
    .from('lay_bys')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

// --- BNPL PLANS ---
// A BNPL plan is three rows saved together: the plan itself (lay_bys — the
// table keeps its old name), the expense that carries it, and one amount per
// payment, with the last payment taking any rounding top-up. The Cycle sheet
// and the wishlist both come through here so they cannot drift apart again:
// the wishlist used to save a plain expense with a single amount, which lost
// the last payment's top-up and kept the plan out of the BNPL section.
//
// Not one transaction: if a later step fails, the earlier rows are switched
// off so nothing half-made reaches the forecast.
export async function createBnplPlan(
  accountId: string,
  userId: string,
  plan: {
    name: string
    frequency: 'weekly' | 'fortnightly' | 'monthly' | 'annually'
    payments: { date: string; amountCents: number }[]
  }
) {
  const pays = plan.payments
  if (!pays.length) throw new Error('A BNPL plan needs at least one payment.')
  const totalCents = pays.reduce((s, p) => s + p.amountCents, 0)
  const firstDate  = pays[0].date
  const lastDate   = pays[pays.length - 1].date

  const { data: layby, error: e1 } = await supabase
    .from('lay_bys')
    .insert({
      profile_id: userId,
      account_id: accountId,
      name: plan.name,
      target_amount_cents: totalCents,
      target_date: lastDate,
      payment_amount_cents: pays[0].amountCents,
      payments_total: pays.length,
    })
    .select().single()
  if (e1) throw e1

  const { data: expense, error: e2 } = await supabase
    .from('expenses')
    .insert({
      profile_id: userId,
      account_id: accountId,
      name: plan.name,
      frequency: plan.frequency,
      anchor_date: firstDate,
      mode: 'fixed',
      end_date: lastDate,
      lay_by_id: layby.id,
    })
    .select().single()
  if (e2) {
    await supabase.from('lay_bys').update({ is_active: false }).eq('id', layby.id)
    throw e2
  }

  const { error: e3 } = await supabase
    .from('expense_amount_versions')
    .insert(pays.map(p => ({
      expense_id: expense.id,
      account_id: accountId,
      amount_cents: p.amountCents,
      effective_from: p.date,
    })))
  if (e3) {
    await supabase.from('expenses').update({ is_active: false }).eq('id', expense.id)
    await supabase.from('lay_bys').update({ is_active: false }).eq('id', layby.id)
    throw e3
  }

  return { layby, expense }
}

// --- CYCLES ---
export async function getCycles(accountId: string) {
  const { data, error } = await supabase
    .from('cycles')
    .select('*')
    .eq('account_id', accountId)
    .order('start_date')
  if (error) throw error
  return data
}

export async function upsertCycle(
  accountId: string,
  startDate: string,
  endDate: string,
  openingBalanceCents: number
) {
  const { data, error } = await supabase
    .from('cycles')
    .upsert({
      account_id: accountId,
      start_date: startDate,
      end_date: endDate,
      opening_balance_cents: openingBalanceCents,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// --- WISHLIST ---
export async function getWishlistItems(accountId: string) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .select('*')
    .eq('account_id', accountId)
    .order('rank')
  if (error) throw error
  return data
}

export async function addWishlistItem(
  accountId: string,
  profileId: string,
  name: string,
  amountCents: number,
  notes?: string
) {
  const { data: existing, error: e1 } = await supabase
    .from('wishlist_items')
    .select('rank')
    .eq('account_id', accountId)
    .order('rank', { ascending: false })
    .limit(1)
  if (e1) throw e1
  const nextRank = (existing?.[0]?.rank ?? 0) + 1

  const { data, error } = await supabase
    .from('wishlist_items')
    .insert({ profile_id: profileId,account_id: accountId, name, amount_cents: amountCents, notes, rank: nextRank })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function reorderWishlistItems(items: { id: string; rank: number }[]) {
  const updates = items.map(({ id, rank }) =>
    supabase.from('wishlist_items').update({ rank }).eq('id', id)
  )
  const results = await Promise.all(updates)
  const failed = results.find(r => r.error)
  if (failed?.error) throw failed.error
}

export async function commitWishlistItem(
  itemId: string,
  expenseId: string,
  cycleStartDate: string
) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .update({
      status: 'committed',
      committed_expense_id: expenseId,
      committed_cycle_start: cycleStartDate,
    })
    .eq('id', itemId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Takes back a commitment that has an expense: a BNPL plan, or an older
// single-payment commit. A BNPL plan's lay_bys row is switched off too, or it
// would be left behind with nothing pointing at it. payment_method is cleared
// so the item no longer reads as paid by BNPL once it is back on the list.
export async function uncommitWishlistItem(itemId: string, expenseId: string) {
  const { data: exp, error: e0 } = await supabase
    .from('expenses')
    .select('lay_by_id')
    .eq('id', expenseId)
    .maybeSingle()
  if (e0) throw e0

  const { error: e1 } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (e1) throw e1

  if (exp?.lay_by_id) {
    const { error: eL } = await supabase
      .from('lay_bys')
      .update({ is_active: false })
      .eq('id', exp.lay_by_id)
    if (eL) throw eL
  }

  const { data, error: e2 } = await supabase
    .from('wishlist_items')
    .update({ status: 'active', payment_method: null, committed_expense_id: null, committed_cycle_start: null })
    .eq('id', itemId)
    .select()
    .single()
  if (e2) throw e2
  return data
}

// Puts an item back on the active list without touching expenses. A savings
// goal has no expense row to delete — the amount is derived — so the older
// uncommit path does not apply to it.
export async function releaseWishlistItem(itemId: string) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .update({
      status: 'active',
      payment_method: null,
      savings_goal_id: null,
      committed_expense_id: null,
      committed_cycle_start: null,
    })
    .eq('id', itemId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteWishlistItem(itemId: string) {
  const { error } = await supabase.from('wishlist_items').delete().eq('id', itemId)
  if (error) throw error
}

// --- CREDIT ACCOUNTS ---
// A card's balance lives in credit_balance_snapshots, not on the account row.
// getCreditAccount() folds the latest snapshot in as currentBalanceCents so
// callers get one object shaped like the engine's CreditAccount type.
export async function getCreditAccount(accountId: string) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
  if (error) throw error
  const card = data?.[0]
  if (!card) return null

  const snapshot = await getLatestCreditSnapshot(card.id)
  return {
    ...card,
    current_balance_cents: snapshot?.balance_cents ?? 0,
    balance_as_of: snapshot?.as_of_date ?? null,
    balance_source: snapshot?.source ?? null,
  }
}

export async function createCreditAccount(
  accountId: string,
  fields: {
    name: string
    apr_basis_points: number
    min_payment_pct: number
    min_payment_floor_cents: number
    assumed_spend_cents: number
    payment_frequency?: 'per_cycle' | 'monthly'
    payment_anchor_date?: string | null
  },
  openingBalanceCents: number,
  asOfDate: string
) {
  const { data: card, error: e1 } = await supabase
    .from('credit_accounts')
    .insert({ account_id: accountId, ...fields })
    .select()
    .single()
  if (e1) throw e1

  const { error: e2 } = await supabase
    .from('credit_balance_snapshots')
    .insert({
      credit_account_id: card.id,
      account_id: accountId,
      balance_cents: openingBalanceCents,
      as_of_date: asOfDate,
      source: 'initial',
    })
  if (e2) throw e2

  return card
}

export async function updateCreditAccount(
  creditAccountId: string,
  fields: {
    name?: string
    apr_basis_points?: number
    min_payment_pct?: number
    min_payment_floor_cents?: number
    assumed_spend_cents?: number
    payment_frequency?: 'per_cycle' | 'monthly'
    payment_anchor_date?: string | null
  }
) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .update(fields)
    .eq('id', creditAccountId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Committing a strategy is what lets the credit line reach the forecast.
// Until this runs, the Credit page is a simulator and projectCycles() ignores
// the card entirely.
export async function commitCreditStrategy(creditAccountId: string, extraCents: number) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .update({
      strategy_extra_cents: extraCents,
      strategy_committed: true,
      strategy_committed_at: new Date().toISOString(),
    })
    .eq('id', creditAccountId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Change the standing extra without touching whether a strategy is committed.
// Used when adjusting from the Cycle screen with "from now on".
export async function updateCreditStrategyExtra(creditAccountId: string, extraCents: number) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .update({ strategy_extra_cents: extraCents })
    .eq('id', creditAccountId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function uncommitCreditStrategy(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .update({ strategy_committed: false, strategy_committed_at: null })
    .eq('id', creditAccountId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteCreditAccount(creditAccountId: string) {
  const { error } = await supabase
    .from('credit_accounts')
    .update({ is_active: false })
    .eq('id', creditAccountId)
  if (error) throw error
}

// --- CREDIT BALANCE SNAPSHOTS ---
// Append-only, same shape as expense_amount_versions: never overwrite, always
// add a dated row. Manual updates and cycle-close updates take this one path.
export async function getLatestCreditSnapshot(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_balance_snapshots')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('as_of_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

export async function getCreditSnapshots(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_balance_snapshots')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('as_of_date', { ascending: false })
  if (error) throw error
  return data
}

export async function addCreditSnapshot(
  creditAccountId: string,
  accountId: string,
  balanceCents: number,
  asOfDate: string,
  source: 'manual' | 'cycle_close' | 'initial' = 'manual',
  projectedBalanceCents?: number
) {
  const { data, error } = await supabase
    .from('credit_balance_snapshots')
    .insert({
      credit_account_id: creditAccountId,
      account_id: accountId,
      balance_cents: balanceCents,
      as_of_date: asOfDate,
      source,
      projected_balance_cents: projectedBalanceCents ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// --- CREDIT EXTRA OVERRIDES ---
// Adjusts only the discretionary extra, for one cycle. There is deliberately
// no equivalent for the minimum: it is contractual, and the app should not
// help normalise skipping it.
export async function getCreditExtraOverrides(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_extra_overrides')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function setCreditExtraOverride(
  creditAccountId: string,
  accountId: string,
  cycleStart: string,
  extraCents: number
) {
  const { data, error } = await supabase
    .from('credit_extra_overrides')
    .upsert(
      {
        credit_account_id: creditAccountId,
        account_id: accountId,
        cycle_start: cycleStart,
        extra_cents: extraCents,
      },
      { onConflict: 'credit_account_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function clearCreditExtraOverride(creditAccountId: string, cycleStart: string) {
  const { error } = await supabase
    .from('credit_extra_overrides')
    .delete()
    .eq('credit_account_id', creditAccountId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// --- CREDIT CYCLE PAYMENTS ---
// A row here means "the payment for this cycle has gone out". Once that is
// true, later changes to the plan must not rewrite that cycle.
export async function getCreditCyclePayments(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_cycle_payments')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function confirmCreditPayment(
  creditAccountId: string,
  accountId: string,
  cycleStart: string
) {
  const { data, error } = await supabase
    .from('credit_cycle_payments')
    .upsert(
      { credit_account_id: creditAccountId, account_id: accountId, cycle_start: cycleStart },
      { onConflict: 'credit_account_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function unconfirmCreditPayment(creditAccountId: string, cycleStart: string) {
  const { error } = await supabase
    .from('credit_cycle_payments')
    .delete()
    .eq('credit_account_id', creditAccountId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// --- SAVINGS GOALS ---
// A savings goal is a real commitment: money leaves your spendable balance
// each cycle, like a lay-by payment. It exists because "you could afford this
// in March" assumes you never spend the money in between.
export async function getSavingsGoals(accountId: string) {
  const { data, error } = await supabase
    .from('savings_goals')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

export async function createSavingsGoal(
  accountId: string,
  fields: {
    name: string
    target_cents: number
    per_cycle_cents: number
    cycles_total: number
    start_cycle_start: string
    wishlist_item_id?: string | null
  }
) {
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({ account_id: accountId, ...fields })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateSavingsGoal(
  goalId: string,
  fields: {
    name?: string
    per_cycle_cents?: number
    cycles_total?: number
    adjusted_total_cents?: number | null
    adjusted_at?: string | null
    status?: 'active' | 'completed' | 'cancelled'
  }
) {
  const { data, error } = await supabase
    .from('savings_goals')
    .update(fields)
    .eq('id', goalId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteSavingsGoal(goalId: string) {
  const { error } = await supabase
    .from('savings_goals')
    .update({ is_active: false })
    .eq('id', goalId)
  if (error) throw error
}

// --- SAVINGS CONTRIBUTIONS ---
// One row per cycle where the money actually went in. The row existing is the
// confirmation — no amount is stored, because what was meant to go in is
// already known from the goal.
export async function getSavingsContributions(goalId: string) {
  const { data, error } = await supabase
    .from('savings_contributions')
    .select('*')
    .eq('savings_goal_id', goalId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function getAllSavingsContributions(accountId: string) {
  const { data, error } = await supabase
    .from('savings_contributions')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function confirmSavingsContribution(
  goalId: string,
  accountId: string,
  cycleStart: string
) {
  const { data, error } = await supabase
    .from('savings_contributions')
    .upsert(
      { savings_goal_id: goalId, account_id: accountId, cycle_start: cycleStart },
      { onConflict: 'savings_goal_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function unconfirmSavingsContribution(goalId: string, cycleStart: string) {
  const { error } = await supabase
    .from('savings_contributions')
    .delete()
    .eq('savings_goal_id', goalId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// Links a wishlist item to how it is being paid for.
export async function setWishlistPaymentMethod(
  itemId: string,
  method: 'cash' | 'savings' | 'layby' | 'credit',
  savingsGoalId?: string | null
) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .update({
      status: 'committed',
      payment_method: method,
      savings_goal_id: savingsGoalId ?? null,
    })
    .eq('id', itemId)
    .select()
    .single()
  if (error) throw error
  return data
}

// --- SAVINGS OVERRIDES ---
// A per-cycle amount exception. "Set aside $500 this cycle to catch up, then
// back to $250" is an exception, not a change to the plan — same shape as the
// credit extra override.
export async function getSavingsOverrides(goalId: string) {
  const { data, error } = await supabase
    .from('savings_overrides')
    .select('*')
    .eq('savings_goal_id', goalId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function getAllSavingsOverrides(accountId: string) {
  const { data, error } = await supabase
    .from('savings_overrides')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function setSavingsOverride(
  goalId: string,
  accountId: string,
  cycleStart: string,
  amountCents: number
) {
  const { data, error } = await supabase
    .from('savings_overrides')
    .upsert(
      { savings_goal_id: goalId, account_id: accountId, cycle_start: cycleStart, amount_cents: amountCents },
      { onConflict: 'savings_goal_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function clearSavingsOverride(goalId: string, cycleStart: string) {
  const { error } = await supabase
    .from('savings_overrides')
    .delete()
    .eq('savings_goal_id', goalId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// --- BUDGET SPEND ENTRIES ---
export async function getBudgetSpendEntries(accountId: string) {
  const { data, error } = await supabase
    .from('budget_spend_entries')
    .select('*')
    .eq('account_id', accountId)
    .order('spent_date', { ascending: false })
  if (error) throw error
  return data
}

export async function addBudgetSpendEntry(
  accountId: string,
  expenseId: string,
  amountCents: number,
  label = '',
  spentDate?: string,
  // Where it was spent and an optional note. Both optional — a bare amount is
  // still a perfectly good entry.
  place?: { payeeId?: string | null; note?: string | null }
) {
  const { data, error } = await supabase
    .from('budget_spend_entries')
    .insert({
      account_id: accountId,
      expense_id: expenseId,
      amount_cents: amountCents,
      label,
      payee_id: place?.payeeId ?? null,
      note: place?.note?.trim() ? place.note.trim() : null,
      source: 'manual',
      spent_date: spentDate ?? (() => {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })(),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateBudgetSpendEntry(
  entryId: string,
  amountCents: number,
  label: string,
  place?: { payeeId?: string | null; note?: string | null }
) {
  const fields: any = { amount_cents: amountCents, label }
  if (place) {
    fields.payee_id = place.payeeId ?? null
    fields.note = place.note?.trim() ? place.note.trim() : null
  }
  const { data, error } = await supabase
    .from('budget_spend_entries')
    .update(fields)
    .eq('id', entryId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteBudgetSpendEntry(entryId: string) {
  const { error } = await supabase.from('budget_spend_entries').delete().eq('id', entryId)
  if (error) throw error
}
// --- EXPENSE OVERRIDES ---
// A different amount for one cycle, on any expense: a budget for Christmas, a
// confirmed power bill, a skipped gym fortnight. Same shape as the credit and
// savings overrides: an exception for that cycle, not a new default. Changing
// an amount "from now on" is a new amount version instead — see
// setExpenseAmountFrom. amountCents is the whole cycle's amount.
export async function getAllExpenseOverrides(accountId: string) {
  const { data, error } = await supabase
    .from('expense_overrides')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
  if (error) throw error
  return data
}

export async function setExpenseOverride(
  expenseId: string,
  accountId: string,
  cycleStart: string,
  amountCents: number
) {
  const { data, error } = await supabase
    .from('expense_overrides')
    .upsert(
      { expense_id: expenseId, account_id: accountId, cycle_start: cycleStart, amount_cents: amountCents },
      { onConflict: 'expense_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function clearExpenseOverride(expenseId: string, cycleStart: string) {
  const { error } = await supabase
    .from('expense_overrides')
    .delete()
    .eq('expense_id', expenseId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// --- EXPENSE AMOUNT FROM A DATE ---
// "From now on": a new amount version starting at a cycle. Inserted first and
// the older same-day versions removed second, so if the clean-up fails the new
// amount still wins — the newest version on a date always does.
export async function setExpenseAmountFrom(
  expenseId: string,
  accountId: string,
  effectiveFrom: string,
  amountCents: number
) {
  const { data, error } = await supabase
    .from('expense_amount_versions')
    .insert({ expense_id: expenseId, account_id: accountId, effective_from: effectiveFrom, amount_cents: amountCents })
    .select()
    .single()
  if (error) throw error

  const { error: e2 } = await supabase
    .from('expense_amount_versions')
    .delete()
    .eq('expense_id', expenseId)
    .eq('effective_from', effectiveFrom)
    .neq('id', data.id)
  if (e2) console.warn('older same-day amount not removed:', e2.message)

  return data
}

// --- PLACES (payees) ---
// Where spend happens: Woolworths, New World, Z Energy. One list per account.
// Entries point at a place rather than copying its name, so renaming a place
// renames it everywhere — and "how much do I usually spend at New World?"
// becomes a question the data can answer later.
export async function getPayees(accountId: string) {
  const { data, error } = await supabase
    .from('payees')
    .select('*')
    .eq('account_id', accountId)
    .eq('archived', false)
    .order('name')
  if (error) throw error
  return data
}

// Find a place by name (any capitalisation, spaces trimmed) or create it.
// If two taps race to create the same place, the database's unique rule turns
// the second into a lookup instead of a duplicate.
export async function findOrCreatePayee(accountId: string, name: string) {
  const clean = name.trim()
  if (!clean) return null
  const key = clean.toLowerCase()

  const { data: found, error: e1 } = await supabase
    .from('payees')
    .select('*')
    .eq('account_id', accountId)
    .eq('name_key', key)
    .limit(1)
  if (e1) throw e1
  if (found?.[0]) return found[0]

  const { data, error } = await supabase
    .from('payees')
    .insert({ account_id: accountId, name: clean })
    .select()
    .single()
  if (!error) return data
  if (error.code !== '23505') throw error

  const { data: again, error: e3 } = await supabase
    .from('payees')
    .select('*')
    .eq('account_id', accountId)
    .eq('name_key', key)
    .limit(1)
  if (e3) throw e3
  return again?.[0] ?? null
}
