import { useEffect, type ReactNode } from 'react'
import type { Page } from '../AppShell'
import { PhoneLayout } from '../lib/useViewport'
import { useLog } from './logContext'
import PlanHub from './PlanHub'
import MoreHub from './MoreHub'

/**
 * The new shell: Cycle · Forecast · + · Plan · More.
 *
 * Until each journey replaces it, an old screen sits inside this shell as it
 * is. The shell keeps design.css's .app column so those screens lay out as
 * they always have, and holds every screen to the phone layout, on a computer
 * too: there the column is centred at phone width.
 */
interface Props {
  active: Page
  onNavigate: (page: Page) => void
  onAdd: () => void
  darkMode: boolean
  onToggleDark: () => void
  onAddAccount: () => void
  children: ReactNode
}

// Which tab a page belongs to, and where its back button goes.
const TAB_OF: Record<Page, 'cycle' | 'forecast' | 'plan' | 'more'> = {
  cycle: 'cycle', forecast: 'forecast',
  plan: 'plan', items: 'plan', expenses: 'plan', wishlist: 'plan', credit: 'plan',
  more: 'more', settings: 'more',
}
// The browser tab and the screen reader say which page this is.
const TITLE: Record<Page, string> = {
  cycle: 'Cycle', forecast: 'Forecast', plan: 'Plan', items: 'Expenses & income', expenses: 'Expenses',
  wishlist: 'Wishlist', credit: 'Credit', more: 'More', settings: 'Settings',
}
const BACK: Partial<Record<Page, { to: Page; label: string }>> = {
  items:    { to: 'plan', label: 'Plan' },
  expenses: { to: 'plan', label: 'Plan' },
  wishlist: { to: 'plan', label: 'Plan' },
  credit:   { to: 'plan', label: 'Plan' },
  settings: { to: 'more', label: 'More' },
}

const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ICON = {
  cycle:    <svg {...svg}><circle cx="12" cy="12" r="7.5" /></svg>,
  forecast: <svg {...svg}><path d="M7 17 L17 7" /><path d="M9 7 L17 7 L17 15" /></svg>,
  plan:     <svg {...svg}><path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8z" /></svg>,
  more:     <svg {...svg}><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></svg>,
  add:      <svg {...svg} strokeWidth={2.2}><path d="M12 5v14M5 12h14" /></svg>,
}

export default function RunwayShell({ active, onNavigate, onAdd, darkMode, onToggleDark, onAddAccount, children }: Props) {
  useEffect(() => {
    document.body.classList.add('is-runway')
    return () => { document.body.classList.remove('is-runway') }
  }, [])

  // The centre + logs spend (Journey 5); without the sheets it falls back.
  const log = useLog()
  useEffect(() => { document.title = `${TITLE[active] ?? 'Pocket Pilot'} · Pocket Pilot` }, [active])
  const tab = TAB_OF[active]
  const back = BACK[active]

  const tabButton = (t: 'cycle' | 'forecast' | 'plan' | 'more', label: string) => (
    <button type="button" className={`rw-tab${tab === t ? ' on' : ''}`}
      aria-current={tab === t ? 'page' : undefined} onClick={() => onNavigate(t)}>
      {ICON[t]}{label}
    </button>
  )

  return (
    <PhoneLayout.Provider value={true}>
      <div className="app rw rw-app">
        {back && (
          <div className="rw-top">
            <button type="button" className="rw-back" onClick={() => onNavigate(back.to)}>‹ {back.label}</button>
          </div>
        )}

        <main className="rw-main">
          {active === 'plan' ? <PlanHub onNavigate={onNavigate} />
            : active === 'more' ? <MoreHub onNavigate={onNavigate} darkMode={darkMode} onToggleDark={onToggleDark} onAddAccount={onAddAccount} />
            : children}
        </main>

        <nav className="rw-tabs" aria-label="Main">
          {tabButton('cycle', 'Cycle')}
          {tabButton('forecast', 'Forecast')}
          <button type="button" className="rw-fab" aria-label="Log spend" onClick={() => (log ? log.log() : onAdd())}>{ICON.add}</button>
          {tabButton('plan', 'Plan')}
          {tabButton('more', 'More')}
        </nav>
      </div>
    </PhoneLayout.Provider>
  )
}
