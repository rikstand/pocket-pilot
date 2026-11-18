import { supabase } from './supabase'

// --- ACCOUNTS ---

// The database returns at most 1,000 rows a request. Lists that grow with use
// (spend entries, cycles, one-cycle amounts) are read a page at a time, in a
// fixed order, until a page comes back short (code review finding 5).
const PAGE = 1000
async function allRows(build: () => any): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

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
    .select(`*, income_amount_versions(*), income_schedule_versions(*)`)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

// Every write below throws when the database refuses it, so a page can show
// the error instead of carrying on as if it worked.

// A new income: a bonus, a refund (frequency 'once') or the main salary from
// Setup. is_potential / is_primary are only sent when given, so the
// database defaults apply otherwise — the same rows the pages wrote before.
export async function addIncomeSource(
  accountId: string,
  userId: string,
  income: {
    name: string
    frequency: string
    anchorDate: string
    amountCents: number
    isPotential?: boolean
    isPrimary?: boolean
    everyN?: number          // every N of frequency (Journey 9's Custom)
    endDate?: string | null  // last payment on or before
  }
) {
  const row: Record<string, unknown> = {
    profile_id: userId,
    account_id: accountId,
    name: income.name,
    frequency: income.frequency,
    anchor_date: income.anchorDate,
  }
  if (income.everyN !== undefined) row.every_n = income.everyN
  if (income.endDate) row.end_date = income.endDate
  if (income.isPotential !== undefined) row.is_potential = income.isPotential
  if (income.isPrimary !== undefined) row.is_primary = income.isPrimary

  const { data: src, error: e1 } = await supabase
    .from('income_sources')
    .insert(row)
    .select().single()
  if (e1) throw e1

  await addIncomeAmount(src.id, income.amountCents, income.anchorDate)
  return src
}

export async function updateIncomeSource(
  incomeId: string,
  fields: { name?: string; is_potential?: boolean }
) {
  const { error } = await supabase.from('income_sources').update(fields).eq('id', incomeId)
  if (error) throw error
}

// A new amount from a date. Always a new row, never an edit of an old one, so
// the history stays and the newest row on a date wins.
export async function addIncomeAmount(incomeId: string, amountCents: number, effectiveFrom: string) {
  const { error } = await supabase
    .from('income_amount_versions')
    .insert({ income_source_id: incomeId, amount_cents: amountCents, effective_from: effectiveFrom })
  if (error) throw error
}

// "From now on": a new amount from a cycle. Inserted first and the older
// same-day rows removed second, so if the clean-up fails the new amount still
// wins — the newest row on a date always does. Same as setExpenseAmountFrom.
export async function setIncomeAmountFrom(incomeId: string, effectiveFrom: string, amountCents: number) {
  const { data, error } = await supabase
    .from('income_amount_versions')
    .insert({ income_source_id: incomeId, amount_cents: amountCents, effective_from: effectiveFrom })
    .select()
    .single()
  if (error) throw error

  const { error: e2 } = await supabase
    .from('income_amount_versions')
    .delete()
    .eq('income_source_id', incomeId)
    .eq('effective_from', effectiveFrom)
    .neq('id', data.id)
  if (e2) console.warn('older same-day amount not removed:', e2.message)

  return data
}

// --- INCOME OVERRIDES ---
// A different amount of pay for one cycle: a short week, overtime, unpaid
// leave. An exception for that cycle only, like expense_overrides — never a
// dated amount with the old one "put back" afterwards. amountCents is the
// whole cycle's pay.
export async function getAllIncomeOverrides(accountId: string) {
  return allRows(() => supabase
    .from('income_overrides')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
    .order('income_source_id'))
}

export async function setIncomeOverride(
  incomeId: string,
  accountId: string,
  cycleStart: string,
  amountCents: number
) {
  const { data, error } = await supabase
    .from('income_overrides')
    .upsert(
      { income_source_id: incomeId, account_id: accountId, cycle_start: cycleStart, amount_cents: amountCents },
      { onConflict: 'income_source_id,cycle_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function clearIncomeOverride(incomeId: string, cycleStart: string) {
  const { error } = await supabase
    .from('income_overrides')
    .delete()
    .eq('income_source_id', incomeId)
    .eq('cycle_start', cycleStart)
  if (error) throw error
}

// Switched off, not deleted: the row stays for history.
export async function deactivateIncomeSource(incomeId: string) {
  const { error } = await supabase.from('income_sources').update({ is_active: false }).eq('id', incomeId)
  if (error) throw error
}

// --- EXPENSES ---
export async function getExpenses(accountId: string) {
  const { data, error } = await supabase
    .from('expenses')
    .select(`*, expense_amount_versions(*), expense_schedule_versions(*), bnpl_missed_payments!bnpl_missed_payments_expense_id_fkey(*)`)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
  if (error) throw error
  return data
}

// A new expense with its first amount, dated from its anchor date. Used for a
// one-off from the Cycle screen, the Expenses page and Setup. icon is only
// sent when given.
export async function addExpense(
  accountId: string,
  userId: string,
  expense: {
    name: string
    frequency: string
    anchorDate: string
    mode: 'fixed' | 'variable' | 'budget'
    amountCents: number
    icon?: string
    everyN?: number          // every N of frequency (Journey 9's Custom)
    endDate?: string | null  // last payment on or before
  }
) {
  const row: Record<string, unknown> = {
    profile_id: userId,
    account_id: accountId,
    name: expense.name,
    frequency: expense.frequency,
    anchor_date: expense.anchorDate,
    mode: expense.mode,
  }
  if (expense.icon !== undefined) row.icon = expense.icon
  if (expense.everyN !== undefined) row.every_n = expense.everyN
  if (expense.endDate) row.end_date = expense.endDate

  const { data: exp, error: e1 } = await supabase
    .from('expenses')
    .insert(row)
    .select().single()
  if (e1) throw e1

  await addExpenseAmount(exp.id, accountId, expense.amountCents, expense.anchorDate)
  return exp
}

export async function updateExpense(
  expenseId: string,
  fields: { name?: string; frequency?: string; anchor_date?: string; mode?: string; icon?: string }
) {
  const { error } = await supabase.from('expenses').update(fields).eq('id', expenseId)
  if (error) throw error
}

// A new amount from a date, as a new row. Unlike setExpenseAmountFrom this
// leaves older rows on the same date alone — the newest still wins.
export async function addExpenseAmount(
  expenseId: string,
  accountId: string,
  amountCents: number,
  effectiveFrom: string
) {
  const { error } = await supabase
    .from('expense_amount_versions')
    .insert({ expense_id: expenseId, account_id: accountId, amount_cents: amountCents, effective_from: effectiveFrom })
  if (error) throw error
}

// Switched off, not deleted: the row and its amounts stay for history.
export async function deactivateExpense(expenseId: string) {
  const { error } = await supabase.from('expenses').update({ is_active: false }).eq('id', expenseId)
  if (error) throw error
}

// Undo for a delete: switch it back on.
export async function reactivateExpense(expenseId: string) {
  const { error } = await supabase.from('expenses').update({ is_active: true }).eq('id', expenseId)
  if (error) throw error
}

export async function reactivateIncomeSource(incomeId: string) {
  const { error } = await supabase.from('income_sources').update({ is_active: true }).eq('id', incomeId)
  if (error) throw error
}

// Undo for a schedule change from a date: remove the row it wrote.
export async function deleteExpenseScheduleVersion(versionId: string) {
  const { error } = await supabase.from('expense_schedule_versions').delete().eq('id', versionId)
  if (error) throw error
}

export async function deleteIncomeScheduleVersion(versionId: string) {
  const { error } = await supabase.from('income_schedule_versions').delete().eq('id', versionId)
  if (error) throw error
}

// Undo for setIncomeAmountFrom: remove the dated amount it wrote.
export async function deleteIncomeAmountVersion(versionId: string) {
  const { error } = await supabase.from('income_amount_versions').delete().eq('id', versionId)
  if (error) throw error
}

// --- SCHEDULE CHANGES FROM A DATE ---
// From effectiveFrom on, the item repeats on a new schedule. Payments before
// it never change, and the item stays one item: its spend log, places and
// one-cycle amounts stay with it. Inserted first and older rows for the same
// date removed second — the newest row on a date always wins anyway.
export interface ScheduleChange {
  effectiveFrom: string
  frequency: string
  everyN?: number
  anchorDate: string
}

export async function setExpenseScheduleFrom(expenseId: string, accountId: string, change: ScheduleChange) {
  const { data, error } = await supabase
    .from('expense_schedule_versions')
    .insert({
      expense_id: expenseId, account_id: accountId, effective_from: change.effectiveFrom,
      frequency: change.frequency, every_n: change.everyN ?? 1, anchor_date: change.anchorDate,
    })
    .select().single()
  if (error) throw error
  const { error: e2 } = await supabase
    .from('expense_schedule_versions')
    .delete()
    .eq('expense_id', expenseId)
    .eq('effective_from', change.effectiveFrom)
    .neq('id', data.id)
  if (e2) console.warn('older same-day schedule not removed:', e2.message)
  return data
}

export async function setIncomeScheduleFrom(incomeId: string, accountId: string, change: ScheduleChange) {
  const { data, error } = await supabase
    .from('income_schedule_versions')
    .insert({
      income_source_id: incomeId, account_id: accountId, effective_from: change.effectiveFrom,
      frequency: change.frequency, every_n: change.everyN ?? 1, anchor_date: change.anchorDate,
    })
    .select().single()
  if (error) throw error
  const { error: e2 } = await supabase
    .from('income_schedule_versions')
    .delete()
    .eq('income_source_id', incomeId)
    .eq('effective_from', change.effectiveFrom)
    .neq('id', data.id)
  if (e2) console.warn('older same-day schedule not removed:', e2.message)
  return data
}

// --- ENDING, ARCHIVING, DELETING ---
// Stop: the last date it can fall on (null = no end). Payments before it stay.
export async function setExpenseEndDate(expenseId: string, endDate: string | null) {
  const { error } = await supabase.from('expenses').update({ end_date: endDate }).eq('id', expenseId)
  if (error) throw error
}

export async function setIncomeEndDate(incomeId: string, endDate: string | null) {
  const { error } = await supabase.from('income_sources').update({ end_date: endDate }).eq('id', incomeId)
  if (error) throw error
}

// Archive a budget: it stops after endDate and moves to the archived list.
// Its spending history stays. Unarchive clears both.
export async function archiveExpense(expenseId: string, endDate: string) {
  const { error } = await supabase
    .from('expenses')
    .update({ end_date: endDate, archived_at: new Date().toISOString() })
    .eq('id', expenseId)
  if (error) throw error
}

export async function unarchiveExpense(expenseId: string) {
  const { error } = await supabase
    .from('expenses')
    .update({ end_date: null, archived_at: null })
    .eq('id', expenseId)
  if (error) throw error
}

// Has anything been logged against this expense? Delete is only offered when
// not — otherwise the choice is Stop (or Archive for a budget).
export async function expenseSpendCount(expenseId: string): Promise<number> {
  const { count, error } = await supabase
    .from('budget_spend_entries')
    .select('id', { count: 'exact', head: true })
    .eq('expense_id', expenseId)
  if (error) throw error
  return count ?? 0
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

// --- ADJUSTING A RUNNING BNPL PLAN (Journey 3) ---
// Change and Pay off early both replace the payments still to come. Payments
// before the first new one are never touched. The new payments are written
// first and the old future ones removed after, so if anything fails halfway
// the plan still has its payments rather than none.
//
// Pay off early is the same call with one payment and frequency 'once'.
export async function replaceBnplPayments(
  accountId: string,
  plan: { expenseId: string; layById: string | null },
  change: { frequency: 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annually'; payments: { date: string; amountCents: number }[] }
) {
  const pays = change.payments
  if (!pays.length) throw new Error('A BNPL plan needs at least one payment.')
  const first = pays[0].date
  const last  = pays[pays.length - 1].date

  // 1. The new schedule from the first new payment, and one amount per payment.
  const { data: sched, error: e1 } = await supabase
    .from('expense_schedule_versions')
    .insert({ expense_id: plan.expenseId, account_id: accountId, effective_from: first, frequency: change.frequency, every_n: 1, anchor_date: first })
    .select('id').single()
  if (e1) throw e1
  const { data: amts, error: e2 } = await supabase
    .from('expense_amount_versions')
    .insert(pays.map(p => ({ expense_id: plan.expenseId, account_id: accountId, amount_cents: p.amountCents, effective_from: p.date })))
    .select('id')
  if (e2) throw e2

  // 2. The old future ones go: an old amount dated after a new payment would
  //    otherwise win on the dates after it.
  const keepAmts = (amts ?? []).map((r: any) => r.id)
  const { error: e3 } = await supabase.from('expense_amount_versions').delete()
    .eq('expense_id', plan.expenseId).gte('effective_from', first)
    .not('id', 'in', `(${keepAmts.join(',')})`)
  if (e3) throw e3
  const { error: e4 } = await supabase.from('expense_schedule_versions').delete()
    .eq('expense_id', plan.expenseId).gte('effective_from', first).neq('id', sched.id)
  if (e4) throw e4

  // 3. The plan ends on its new last payment.
  const { error: e5 } = await supabase.from('expenses').update({ end_date: last }).eq('id', plan.expenseId)
  if (e5) throw e5

  // 4. The plan row's totals follow: payments made so far plus the new ones.
  if (plan.layById) {
    const { data: before, error: e6 } = await supabase.from('expense_amount_versions')
      .select('amount_cents').eq('expense_id', plan.expenseId).lt('effective_from', first)
    if (e6) throw e6
    const paidCount = (before ?? []).length
    const paidCents = (before ?? []).reduce((s: number, r: any) => s + r.amount_cents, 0)
    const newCents  = pays.reduce((s, p) => s + p.amountCents, 0)
    const { error: e7 } = await supabase.from('lay_bys').update({
      payments_total: paidCount + pays.length,
      payment_amount_cents: pays[0].amountCents,
      target_amount_cents: paidCents + newCents,
      target_date: last,
    }).eq('id', plan.layById)
    if (e7) throw e7
  }
}

// Missed one: the payment due on paymentDate didn't go out. It is left out of
// the forecast (the engine skips that date), and the repayment — the amount
// plus any late fee you enter — is a one-off on repayDate: a date you pick, or
// one period after the last payment. Undo puts it all back.
export async function markBnplPaymentMissed(
  accountId: string,
  userId: string,
  missed: {
    expenseId: string; layById: string | null; name: string
    paymentDate: string; amountCents: number; feeCents: number; repayDate: string
  }
) {
  const repay = await addExpense(accountId, userId, {
    name: `${missed.name} · missed payment`,
    frequency: 'once',
    anchorDate: missed.repayDate,
    mode: 'fixed',
    amountCents: missed.amountCents + missed.feeCents,
  })
  const { data, error } = await supabase
    .from('bnpl_missed_payments')
    .insert({
      account_id: accountId, expense_id: missed.expenseId, lay_by_id: missed.layById,
      payment_date: missed.paymentDate, amount_cents: missed.amountCents, fee_cents: missed.feeCents,
      repay_date: missed.repayDate, repay_expense_id: repay.id,
    })
    .select().single()
  if (error) {
    await deactivateExpense(repay.id)
    throw error
  }
  return data
}

export async function undoBnplMissed(missedId: string) {
  const { data: row, error: e1 } = await supabase
    .from('bnpl_missed_payments').select('repay_expense_id').eq('id', missedId).maybeSingle()
  if (e1) throw e1
  if (row?.repay_expense_id) await deactivateExpense(row.repay_expense_id)
  const { error } = await supabase.from('bnpl_missed_payments').delete().eq('id', missedId)
  if (error) throw error
}

// Removes a BNPL plan from the forecast: its expense and its plan row are
// both switched off.
export async function deactivateBnplPlan(expenseId: string, laybyId: string | null) {
  await deactivateExpense(expenseId)
  if (laybyId) {
    const { error } = await supabase.from('lay_bys').update({ is_active: false }).eq('id', laybyId)
    if (error) throw error
  }
}

// --- CYCLES ---
export async function getCycles(accountId: string) {
  return allRows(() => supabase
    .from('cycles')
    .select('*')
    .eq('account_id', accountId)
    .order('start_date')
    .order('id'))
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

// The first cycle, written by Setup. Every later cycle is opened by
// closeCycle, so this one anchors the whole chain.
export async function createCycle(
  accountId: string,
  userId: string,
  startDate: string,
  endDate: string,
  openingBalanceCents: number
) {
  const { error } = await supabase
    .from('cycles')
    .insert({
      profile_id: userId,
      account_id: accountId,
      start_date: startDate,
      end_date: endDate,
      opening_balance_cents: openingBalanceCents,
    })
  if (error) throw error
}

// Closing a cycle is one database call, one transaction (close_cycle.sql):
// close this cycle, save the confirmed actuals and open the next one — all of
// it or none of it. Three separate writes once left a cycle closed with no
// cycle after it (30 Sep 2026).
//
// projectedCents is what the app forecast this cycle would close at (before
// pay), saved so closed cycles can later show "actual vs forecast". It is
// written just before close_cycle runs, not inside it, so the close itself is
// untouched. If this save fails, the close still goes ahead: a missing
// forecast costs one comparison, a failed close costs the user their evening.
// If the close fails after it, the next attempt simply writes it again.
export async function closeCycle(
  accountId: string,
  close: {
    cycleId: string | null
    closingCents: number
    projectedCents?: number | null
    nextStart: string
    nextEnd: string
    actuals: { expense_id: string; actual_amount_cents: number }[]
    enteredCents?: number | null   // the balance typed at the close
    payIn?: boolean | null         // whether next cycle's pay was in it
  }
) {
  // A cycle with no row is only forecast: an earlier one is still open. Closing
  // it anyway made close_cycle skip the close and open a second cycle beside
  // the old one (found 16 Nov 2026 on a test account).
  if (!close.cycleId) throw new Error('An earlier cycle hasn\u2019t been closed yet. Close that one first.')
  if (close.cycleId && close.projectedCents != null && Number.isFinite(close.projectedCents)) {
    const { error: pErr } = await supabase
      .from('cycles')
      .update({ projected_close_cents: Math.round(close.projectedCents) })
      .eq('id', close.cycleId)
      .eq('account_id', accountId)
      .eq('is_closed', false)
    if (pErr) console.warn('Could not save the forecast close:', pErr.message)
  }

  const { error } = await supabase.rpc('close_cycle', {
    p_account_id:    accountId,
    p_cycle_id:      close.cycleId,
    p_closing_cents: close.closingCents,
    p_next_start:    close.nextStart,
    p_next_end:      close.nextEnd,
    p_actuals:       close.actuals,
  })
  if (error) throw error

  // What was typed, kept so the close can be fixed later (Journey 10). The
  // close itself has happened; failing to keep this only costs the fix sheet
  // its "you entered" line.
  if (close.cycleId && (close.enteredCents != null || close.payIn != null)) {
    const { error: hErr } = await supabase
      .from('cycles')
      .update({ entered_balance_cents: close.enteredCents ?? null, pay_in_balance: close.payIn ?? null })
      .eq('id', close.cycleId)
      .eq('account_id', accountId)
    if (hErr) console.warn('Could not keep what was entered at the close:', hErr.message)
  }
}

/** Journey 10: close every missed cycle in one go (catch_up runs close_cycle for
 *  each, so all close or none do). Returns the new open cycle's id. */
export async function catchUp(accountId: string, cycleId: string, closes: {
  start_date: string; end_date: string; closing_cents: number; projected_cents: number
  next_start: string; next_end: string; on_forecast: boolean
  actuals: { expense_id: string; actual_amount_cents: number }[]
}[], enteredCents: number | null, payIn: boolean | null): Promise<string> {
  const { data, error } = await supabase.rpc('catch_up', {
    p_account_id: accountId, p_cycle_id: cycleId, p_closes: closes,
    p_entered_cents: enteredCents, p_pay_in: payIn,
  })
  if (error) throw error
  return data as string
}

/** Journey 10: change the most recent close and the next cycle's opening, together.
 *  Returns how much every payday after moved. */
export async function fixLastClose(accountId: string, cycleId: string, closingCents: number,
  enteredCents: number | null, payIn: boolean | null): Promise<number> {
  const { data, error } = await supabase.rpc('fix_last_close', {
    p_account_id: accountId, p_cycle_id: cycleId, p_closing_cents: closingCents,
    p_entered_cents: enteredCents, p_pay_in: payIn,
  })
  if (error) throw error
  return Number(data ?? 0)
}

// --- PAST CYCLES (Journey 10) ---
// What each estimate actually came to, saved at close. A correction adds a
// new row rather than editing the old one, so the first figure stays as
// history; the newest row for a cycle and expense is the one that counts.
export async function getCycleActuals(accountId: string) {
  return allRows(() => supabase
    .from('cycle_expense_actuals')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at')
    .order('id'))
}

export async function addCycleActual(cycleId: string, accountId: string, expenseId: string, amountCents: number) {
  const { data, error } = await supabase
    .from('cycle_expense_actuals')
    .insert({ cycle_id: cycleId, account_id: accountId, expense_id: expenseId, actual_amount_cents: amountCents })
    .select().single()
  if (error) throw error
  return data
}

// Undo for a correction: remove the row it added.
export async function deleteCycleActual(id: string) {
  const { error } = await supabase.from('cycle_expense_actuals').delete().eq('id', id)
  if (error) throw error
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
    // When it was saved, to the second — compared with when a payment was
    // confirmed, so a payment made before the balance was typed is not
    // taken off a second time.
    balance_recorded_at: snapshot?.created_at ?? null,
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
    extra_timing?: 'every_cycle' | 'due_cycle'
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
// the card entirely. mode is the plan: minimum only, a set extra, or
// whatever's spare. extraCents is kept for a spare plan too, so switching
// back to a set extra starts from the last amount.
export async function commitCreditStrategy(
  creditAccountId: string,
  mode: 'minimum' | 'extra' | 'spare',
  extraCents: number
) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .update({
      strategy_mode: mode,
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
// The Cycle screen no longer calls this (its changes are for one cycle only;
// the plan changes on the Credit page). Kept so nothing else that imports it
// breaks.
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
  return allRows(() => supabase
    .from('credit_balance_snapshots')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('as_of_date', { ascending: false })
    .order('id'))
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

// Undo for a balance just saved. Snapshots are otherwise append-only; this
// removes the one row the Undo belongs to, and says so if nothing was removed
// (the database refusing a delete returns no error, only no rows).
export async function deleteCreditSnapshot(id: string) {
  const { data, error } = await supabase
    .from('credit_balance_snapshots')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('The saved balance could not be removed.')
}

// --- CREDIT EXTRA OVERRIDES ---
// The user's choice for one cycle: a set extra on top of the minimum (0 =
// minimum only), or 'spare' — whatever this cycle has above the floor, kept
// live. There is deliberately no way to plan below the minimum: it is
// contractual. What actually went out is recorded by confirming the payment.
// --- CARD PLAN FROM A DATE (credit_plan_versions) ---
// The plan on credit_accounts is the plan from the start; each row here
// replaces it from its cycle onwards. Oldest first.
export async function getCreditPlanVersions(creditAccountId: string) {
  const { data, error } = await supabase
    .from('credit_plan_versions')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('effective_from')
  if (error) throw error
  return data ?? []
}

/** One plan per card per date: setting a date again replaces that row. */
export async function setCreditPlanFrom(
  creditAccountId: string, accountId: string, effectiveFrom: string,
  mode: 'minimum' | 'extra' | 'spare', extraCents: number
) {
  const { data, error } = await supabase
    .from('credit_plan_versions')
    .upsert({
      credit_account_id: creditAccountId, account_id: accountId, effective_from: effectiveFrom,
      mode, extra_cents: mode === 'extra' ? Math.max(0, Math.round(extraCents)) : 0,
    }, { onConflict: 'credit_account_id,effective_from' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteCreditPlanVersion(id: string) {
  const { error } = await supabase.from('credit_plan_versions').delete().eq('id', id)
  if (error) throw error
}

export async function getCreditExtraOverrides(creditAccountId: string) {
  return allRows(() => supabase
    .from('credit_extra_overrides')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('cycle_start'))
}

export async function setCreditExtraOverride(
  creditAccountId: string,
  accountId: string,
  cycleStart: string,
  extraCents: number,
  choice: 'extra' | 'spare' = 'extra'
) {
  const { data, error } = await supabase
    .from('credit_extra_overrides')
    .upsert(
      {
        credit_account_id: creditAccountId,
        account_id: accountId,
        cycle_start: cycleStart,
        extra_cents: extraCents,
        choice,
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
  return allRows(() => supabase
    .from('credit_cycle_payments')
    .select('*')
    .eq('credit_account_id', creditAccountId)
    .order('cycle_start'))
}

// amountCents is what actually left the account. Rows confirmed before it
// was recorded have none, and are treated as the planned amount. Can be
// confirmed any time — paying early counts. confirmed_at is set on every
// save, so re-confirming moves it and the balance working stays in order.
export async function confirmCreditPayment(
  creditAccountId: string,
  accountId: string,
  cycleStart: string,
  amountCents: number
) {
  const { data, error } = await supabase
    .from('credit_cycle_payments')
    .upsert(
      {
        credit_account_id: creditAccountId, account_id: accountId, cycle_start: cycleStart,
        amount_cents: amountCents, confirmed_at: new Date().toISOString(),
      },
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

// A pot for a bill: money set aside each cycle so the bill comes out of the
// pot instead of one payday. The forecast works out how much each cycle from
// the bill itself, so there is no target or amount to store. It keeps going
// while the bill repeats and stops when the bill ends.
export async function createBillPot(
  accountId: string,
  fields: { expense_id: string; name: string; start_cycle_start: string }
) {
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({
      account_id: accountId, ...fields,
      target_cents: 0, per_cycle_cents: 0, cycles_total: 0,
    })
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
// confirmation. A goal's amount is known from the goal, so it stores none; a
// pot for a bill stores what went in, because that changes cycle to cycle.
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
  return allRows(() => supabase
    .from('savings_contributions')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
    .order('savings_goal_id'))
}

export async function confirmSavingsContribution(
  goalId: string,
  accountId: string,
  cycleStart: string,
  // What actually went in. Needed for a pot for a bill, whose amount changes
  // cycle to cycle; leave it out for a goal and the goal's amount is used.
  amountCents?: number | null
) {
  const { data, error } = await supabase
    .from('savings_contributions')
    .upsert(
      { savings_goal_id: goalId, account_id: accountId, cycle_start: cycleStart, amount_cents: amountCents ?? null },
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

// --- PAYDAYS LEFT TO DIP ---
// When a bill takes a payday under the floor and the user says "let it dip",
// that payday isn't asked about again. One row per bill and cycle.
export async function getAcceptedDips(accountId: string) {
  return allRows(() => supabase
    .from('accepted_dips')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
    .order('expense_id'))
}

export async function acceptDip(accountId: string, expenseId: string, cycleStart: string) {
  const { error } = await supabase
    .from('accepted_dips')
    .upsert(
      { account_id: accountId, expense_id: expenseId, cycle_start: cycleStart },
      { onConflict: 'expense_id,cycle_start' }
    )
  if (error) throw error
}

export async function clearAcceptedDip(expenseId: string, cycleStart: string) {
  const { error } = await supabase
    .from('accepted_dips')
    .delete()
    .eq('expense_id', expenseId)
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
  return allRows(() => supabase
    .from('savings_overrides')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
    .order('savings_goal_id'))
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
  return allRows(() => supabase
    .from('budget_spend_entries')
    .select('*')
    .eq('account_id', accountId)
    .order('spent_date', { ascending: false })
    .order('id'))
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
  place?: { payeeId?: string | null; note?: string | null },
  // Moving an entry to another budget or another day (Journey 5's edit).
  move?: { expenseId?: string; spentDate?: string }
) {
  const fields: any = { amount_cents: amountCents, label }
  if (place) {
    fields.payee_id = place.payeeId ?? null
    fields.note = place.note?.trim() ? place.note.trim() : null
  }
  if (move?.expenseId) fields.expense_id = move.expenseId
  if (move?.spentDate) fields.spent_date = move.spentDate
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
  return allRows(() => supabase
    .from('expense_overrides')
    .select('*')
    .eq('account_id', accountId)
    .order('cycle_start')
    .order('expense_id'))
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

// Undo for setExpenseAmountFrom: remove the dated amount it wrote.
export async function deleteExpenseAmountVersion(versionId: string) {
  const { error } = await supabase.from('expense_amount_versions').delete().eq('id', versionId)
  if (error) throw error
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

// Every place, archived ones included, for the Places page.
export async function getAllPayees(accountId: string) {
  const { data, error } = await supabase
    .from('payees')
    .select('*')
    .eq('account_id', accountId)
    .order('name')
  if (error) throw error
  return data
}

export async function setPayeeArchived(payeeId: string, archived: boolean) {
  const { error } = await supabase.from('payees').update({ archived }).eq('id', payeeId)
  if (error) throw error
}

// Merge one place into another: every entry moves across, then the empty
// place is archived (not deleted, so nothing that still points at it breaks).
export async function mergePayee(fromId: string, intoId: string) {
  if (fromId === intoId) return
  const { error } = await supabase.from('budget_spend_entries').update({ payee_id: intoId }).eq('payee_id', fromId)
  if (error) throw error
  await setPayeeArchived(fromId, true)
}

// Delete a place only when nothing was ever spent there. Returns false, and
// deletes nothing, when entries still point at it — archive it instead.
export async function deletePayeeIfUnused(payeeId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('budget_spend_entries')
    .select('id', { count: 'exact', head: true })
    .eq('payee_id', payeeId)
  if (error) throw error
  if ((count ?? 0) > 0) return false
  const { error: e2 } = await supabase.from('payees').delete().eq('id', payeeId)
  if (e2) throw e2
  return true
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
