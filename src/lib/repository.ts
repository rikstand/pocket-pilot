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

export async function uncommitWishlistItem(itemId: string, expenseId: string) {
  const { error: e1 } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (e1) throw e1

  const { data, error: e2 } = await supabase
    .from('wishlist_items')
    .update({ status: 'active', committed_expense_id: null, committed_cycle_start: null })
    .eq('id', itemId)
    .select()
    .single()
  if (e2) throw e2
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
  label = 'Quick add',
  spentDate?: string
) {
  const { data, error } = await supabase
    .from('budget_spend_entries')
    .insert({
      account_id: accountId,
      expense_id: expenseId,
      amount_cents: amountCents,
      label,
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

export async function updateBudgetSpendEntry(entryId: string, amountCents: number, label: string) {
  const { data, error } = await supabase
    .from('budget_spend_entries')
    .update({ amount_cents: amountCents, label })
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