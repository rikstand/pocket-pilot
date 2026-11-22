import type { Page } from '../AppShell'

/**
 * Plan: everything you set up ahead. Each row opens today's screen for now;
 * Journeys 2, 3, 4 and 9 replace them one at a time.
 */
const ROWS: { page: Page; name: string; sub: string }[] = [
  { page: 'items',    name: 'Expenses & income', sub: 'Everything that repeats, and what it is each pay' },
  { page: 'wishlist', name: 'Wishlist', sub: 'Things to buy and how to pay' },
  { page: 'savings',  name: 'Savings',  sub: 'Goals, and money put away for expenses' },
  { page: 'credit',   name: 'Credit',   sub: 'Your card and its plan' },
]

export default function PlanHub({ onNavigate }: { onNavigate: (page: Page) => void }) {
  return (
    <div className="rw-page">
      <div className="rw-page-head"><h1 className="rw-page-title">Plan</h1></div>
      <div role="heading" aria-level={2} className="rw-section" />
      <div className="rw-group">
        {ROWS.map(r => (
          <button key={r.page} type="button" className="rw-row" onClick={() => onNavigate(r.page)}>
            <div className="rw-tx">
              <div className="rw-row-name">{r.name}</div>
              <div className="rw-sub">{r.sub}</div>
            </div>
            <span className="rw-chev">›</span>
          </button>
        ))}
      </div>
    </div>
  )
}
