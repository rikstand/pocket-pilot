import { supabase } from './supabase'
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
export async function upsertProfile(userId: string, displayName: string, safetyFloorCents = 0) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, display_name: displayName, safety_floor_cents: safetyFloorCents })
    .select()
    .single()
  if (error) throw error
  return data
}
// --- INCOME SOURCES ---
export async function getIncomeSources(profileId: string) {
  const { data, error } = await supabase
    .from('income_sources')
    .select(`*, income_amount_versions(*)`)
    .eq('profile_id', profileId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}
// --- EXPENSES ---
export async function getExpenses(profileId: string) {
  const { data, error } = await supabase
    .from('expenses')
    .select(`*, expense_amount_versions(*)`)
    .eq('profile_id', profileId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}
// --- LAY-BYS ---
export async function getLayBys(profileId: string) {
  const { data, error } = await supabase
    .from('lay_bys')
    .select('*')
    .eq('profile_id', profileId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}
// --- CYCLES ---
export async function getCycles(profileId: string) {
  const { data, error } = await supabase
    .from('cycles')
    .select('*')
    .eq('profile_id', profileId)
    .order('start_date')
  if (error) throw error
  return data
}
export async function upsertCycle(
  profileId: string,
  startDate: string,
  endDate: string,
  openingBalanceCents: number
) {
  const { data, error } = await supabase
    .from('cycles')
    .upsert({
      profile_id: profileId,
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
export async function getWishlistItems(profileId: string) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at')
  if (error) throw error
  return data
}
export async function addWishlistItem(
  profileId: string,
  name: string,
  amountCents: number,
  notes?: string
) {
  const { data, error } = await supabase
    .from('wishlist_items')
    .insert({ profile_id: profileId, name, amount_cents: amountCents, notes })
    .select()
    .single()
  if (error) throw error
  return data
}