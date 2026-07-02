import { useState, type ReactNode } from 'react'

export type Page = 'cycle' | 'forecast' | 'expenses' | 'wishlist' | 'settings'

interface AppShellProps {
  active: Page
  onNavigate: (page: Page) => void
  darkMode: boolean
  onToggleDark: () => void
  children: ReactNode
}

export default function AppShell({ active, onNavigate, darkMode, onToggleDark, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  function go(page: Page) {
    onNavigate(page)
    setDrawerOpen(false)
  }

  return (
    <div className="app">
      <div className="appbar">
        <button className="hb" onClick={() => setDrawerOpen(true)} aria-label="Open menu">☰</button>
        <div className="nm">Pocket<b>Pilot</b></div>
        <button className="tgl" onClick={onToggleDark}>
          <span>{darkMode ? '☀' : '☾'}</span>
          <span className="lab">{darkMode ? 'LIGHT' : 'DARK'}</span>
        </button>
      </div>

      {children}

      <div className="bottom-nav">
        <button className={`nav-item${active === 'cycle' ? ' active' : ''}`} onClick={() => go('cycle')}>
          <span className="nav-icon">◎</span>Cycle
        </button>
        <button className={`nav-item${active === 'forecast' ? ' active' : ''}`} onClick={() => go('forecast')}>
          <span className="nav-icon">↗</span>Forecast
        </button>
      </div>

      {drawerOpen && (
        <div className="drawer" onClick={e => { if (e.target === e.currentTarget) setDrawerOpen(false) }}>
          <div className="panel">
            <div className="pnm">Pocket<b>Pilot</b></div>
            <div className="psub">Menu</div>

            <div className={`drawer-item${active === 'cycle' ? ' active' : ''}`} onClick={() => go('cycle')}>
              <div className="di cyc">◎</div><div className="dt">Cycle</div>
            </div>
            <div className={`drawer-item${active === 'forecast' ? ' active' : ''}`} onClick={() => go('forecast')}>
              <div className="di fc">↗</div><div className="dt">Forecast</div>
            </div>

            <div className="drawer-div" />

            <div className={`drawer-item${active === 'expenses' ? ' active' : ''}`} onClick={() => go('expenses')}>
              <div className="di exp">▤</div><div className="dt">Expenses</div>
            </div>
            <div className={`drawer-item${active === 'wishlist' ? ' active' : ''}`} onClick={() => go('wishlist')}>
              <div className="di wish">☆</div><div className="dt">Wishlist</div>
            </div>

            <div className="drawer-div" />

            <div className={`drawer-item${active === 'settings' ? ' active' : ''}`} onClick={() => go('settings')}>
              <div className="di set">⚙</div><div className="dt">Settings</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}