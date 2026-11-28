// bnpl.ts — a BNPL plan's payments, split into made and still to come.
//
// The plan's sheet and its Cycle row both count from here, so "2 of 4 paid ·
// $150 left" reads the same in both places (28 Nov 2026). A missed payment
// is neither: it's left out, and its repayment is its own one-off.

export interface BnplPayment { date: string; cents: number; missed: boolean }

/** Payments dated before `today` are made; today's and later are still to come. */
export function bnplPayments(row: any, today: string): { all: BnplPayment[]; paid: BnplPayment[]; ahead: BnplPayment[] } {
  const missed = new Set((row.bnpl_missed_payments ?? []).map((m: any) => m.payment_date))
  const all = [...(row.expense_amount_versions ?? [])]
    .filter((v: any) => !row.end_date || v.effective_from <= row.end_date)
    .sort((a: any, b: any) => a.effective_from.localeCompare(b.effective_from))
    .map((v: any) => ({ date: v.effective_from as string, cents: v.amount_cents as number, missed: missed.has(v.effective_from) }))
  return { all, paid: all.filter(p => p.date < today && !p.missed), ahead: all.filter(p => p.date >= today && !p.missed) }
}
