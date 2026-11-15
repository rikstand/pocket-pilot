import type { Page } from '../AppShell'

/**
 * Plan: everything you set up ahead. Each row opens today's screen for now;
 * Journeys 2, 3, 4 and 9 replace them one at a time.
 */
const ROWS: { page: Page; name: string; sub: string }[] = [
  { page: 'expenses', name: 'Expenses', sub: 'Bills, budgets and BNPL' },
  { page: 'wishlist', name: 'Wishlist', sub: 'Things to buy and how to pay' },
  { page: 'credit',   name: 'Credit',   sub: 'Your card and its plan' },
]

export default function PlanHub({ onNavigate }: { onNavigate: (page: Page) => void }) {
  return (
    <div className="rw-page">
      <div className="rw-page-head"><div className="rw-page-title">Plan</div></div>
      <div className="rw-section" />
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
