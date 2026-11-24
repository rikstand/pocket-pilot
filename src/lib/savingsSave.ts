// savingsSave.ts — storing a savings plan change (release 6b). Kept apart
// from the sheet so the sheet file only exports components.
import { draftOverrides, unstamped, type Draft, type Planner } from './savingsPlan'
import { confirmSavingsContribution, setSavingsOverride, clearSavingsOverride, updateSavingsGoal } from './repository'

/**
 * Store a plan draft: the one-cycle amounts it changes, the standing amount
 * and the "saved by" date (a date only when the goal has one or one was
 * picked). Returns what to put back for Undo. Used by this sheet and by Plan ›
 * Savings' payday prompt, so the two can't store a plan differently.
 */
export async function saveDraft(P: Planner, goal: any, accountId: string, d: Draft, date?: string) {
  const ch = draftOverrides(goal.per_cycle_cents, d, P.k0, P.done, P.existing, k => P.lineOf(P.cycles, k))
  const was: { start: string; cents: number | undefined }[] = []
  for (const [k, v] of ch) {
    const s2 = P.startOf(k); was.push({ start: s2, cents: P.existing(k) })
    v == null ? await clearSavingsOverride(goal.id, s2) : await setSavingsOverride(goal.id, accountId, s2, v)
  }
  const before = { per_cycle_cents: goal.per_cycle_cents, target_date: goal.target_date ?? null }
  const patch: { per_cycle_cents?: number; target_date?: string } = {}
  if (d.per !== goal.per_cycle_cents) {
    patch.per_cycle_cents = d.per
    // Confirmed cycles saved without an amount count at the standing amount:
    // fix each at what it counts for now, so the new amount doesn't rewrite them.
    for (const c of unstamped(P.rows, goal)) await confirmSavingsContribution(goal.id, accountId, c.cycle_start, c.amount_cents)
  }
  if (date && date !== goal.target_date) patch.target_date = date
  if (patch.per_cycle_cents != null || patch.target_date) await updateSavingsGoal(goal.id, patch)
  return {
    date: patch.target_date ?? goal.target_date ?? null,
    undo: async () => {
      if (patch.per_cycle_cents != null || patch.target_date) await updateSavingsGoal(goal.id, before)
      for (const x of was) x.cents == null ? await clearSavingsOverride(goal.id, x.start) : await setSavingsOverride(goal.id, accountId, x.start, x.cents)
    },
  }
}
