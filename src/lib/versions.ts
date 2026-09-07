/**
 * Amount-version ordering.
 *
 * Both `expense_amount_versions` and `income_amount_versions` store a history of
 * amounts, each effective from a date. Picking "the amount that applies" means
 * sorting by `effective_from` — but two rows can legitimately share one:
 *
 *   - two edits to the same expense in the same cycle (applyEdit always writes
 *     at activeCycle.startDate, so a second edit collides with the first)
 *   - applyConfirm on a variable, for the same reason
 *   - a scoped "just this occurrence" edit whose revert row lands on a date a
 *     later edit also targets
 *
 * With `effective_from` alone the winner is whatever order Postgres happened to
 * return — not stable, and not necessarily the edit the person made last.
 * `created_at` breaks the tie: the most recently written row wins, which is what
 * "I just changed this" should mean.
 *
 * Extracted here rather than duplicated because Dashboard, ExpensesPage and
 * WishlistPage all need the same ordering, and a tiebreak that only holds in two
 * of the three is worse than none — the numbers would disagree between pages.
 */

/** Newest first — effective_from desc, then created_at desc. */
export function byNewest(a: any, b: any): number {
  const af = a?.effective_from ?? ''
  const bf = b?.effective_from ?? ''
  if (af !== bf) return af > bf ? -1 : 1
  const ac = a?.created_at ?? ''
  const bc = b?.created_at ?? ''
  if (ac !== bc) return ac > bc ? -1 : 1
  return 0
}

/** Oldest first — the exact inverse of byNewest. */
export function byOldest(a: any, b: any): number {
  return -byNewest(a, b)
}

/** The most recently written version, ignoring dates entirely. */
export function latestVersion(versions: any[] | null | undefined): any {
  return [...(versions ?? [])].sort(byNewest)[0]
}

/**
 * The version in force on `onDate` — the newest row effective on or before it.
 * Falls back to the earliest row when nothing is effective yet, e.g. a
 * future-dated one-off being read from an earlier cycle.
 */
export function versionForDate(versions: any[] | null | undefined, onDate: string): any {
  const all = versions ?? []
  const applicable = all.filter((v: any) => v?.effective_from <= onDate).sort(byNewest)
  if (applicable.length > 0) return applicable[0]
  return [...all].sort(byOldest)[0]
}