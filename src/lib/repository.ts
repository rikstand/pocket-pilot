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
    .insert({ account_id: accountId, name, amount_cents: amountCents, notes, rank: nextRank })
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
      spent_date: spentDate ?? new Date().toISOString().split('T')[0],
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