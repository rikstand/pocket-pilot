import { useEffect, useState, type ReactNode } from 'react'
import { useAccount } from './lib/AccountContext'
import { useViewport } from './lib/useViewport'

export type Page = 'cycle' | 'forecast' | 'expenses' | 'wishlist' | 'credit' | 'settings'

interface AppShellProps {
  active: Page
  onNavigate: (page: Page) => void
  darkMode: boolean
  onToggleDark: () => void
  onAddAccount: () => void
  children: ReactNode
}

function ForecastIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 L17 7" />
      <path d="M9 7 L17 7 L17 15" />
    </svg>
  )
}

// Four distinct colours — index stable per account order
const ACCT_COLOURS = [
  { bg: '#E6F1FB', text: '#0C447C' }, // blue
  { bg: '#E1F5EE', text: '#085041' }, // teal
  { bg: '#FAECE7', text: '#712B13' }, // coral
  { bg: '#FAEEDA', text: '#633806' }, // amber
]

// Dark-mode equivalents (same order)
const ACCT_COLOURS_DARK = [
  { bg: '#0C447C', text: '#B5D4F4' },
  { bg: '#085041', text: '#9FE1CB' },
  { bg: '#712B13', text: '#F5C4B3' },
  { bg: '#633806', text: '#FAC775' },
]

// One list drives both the drawer and the desktop rail, so the two can never
// offer different pages.
const NAV_MAIN: { page: Page; label: string; icon: ReactNode; di: string }[] = [
  { page: 'cycle',    label: 'Cycle',    icon: '◎',                          di: 'cyc' },
  { page: 'forecast', label: 'Forecast', icon: <ForecastIcon size={15} />,  di: 'fc'  },
]
const NAV_MANAGE: { page: Page; label: string; icon: ReactNode; di: string }[] = [
  { page: 'expenses', label: 'Expenses', icon: '▤', di: 'exp'  },
  { page: 'wishlist', label: 'Wishlist', icon: '☆', di: 'wish' },
  { page: 'credit',   label: 'Credit',   icon: '▭', di: 'crd'  },
]

export default function AppShell({ active, onNavigate, darkMode, onToggleDark, onAddAccount, children }: AppShellProps) {
  const { accounts, activeAccount, setActiveAccountId } = useAccount()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [acctOpen,   setAcctOpen]   = useState(false)
  const viewport = useViewport()
  const isDesktop = viewport === 'desktop'

  // Vite's starter index.css pads and centres #root. That suits the 480px
  // phone column but boxes in the desktop shell, so desktop switches it off
  // with a class rather than rewriting index.css.
  useEffect(() => {
    document.body.classList.toggle('is-desktop', isDesktop)
    if (isDesktop) setDrawerOpen(false)
    return () => { document.body.classList.remove('is-desktop') }
  }, [isDesktop])

  const autoExpand = accounts.length <= 2
  const acctExpanded = autoExpand || acctOpen
  const palette = darkMode ? ACCT_COLOURS_DARK : ACCT_COLOURS

  function go(page: Page) {
    onNavigate(page)
    setDrawerOpen(false)
  }

  function handleSelectAccount(id: string) {
    setActiveAccountId(id)
    setDrawerOpen(false)
    setAcctOpen(false)
  }

  function handleAddAccount() {
    setDrawerOpen(false)
    setAcctOpen(false)
    onAddAccount()
  }

  const activeIdx = accounts.findIndex(a => a.id === activeAccount?.id)
  const activeCol = palette[activeIdx >= 0 ? activeIdx % palette.length : 0]

  /* ── the account list, shared by drawer and rail ── */
  const accountRows = (
    <div className="acct-block">
      {accounts.map((acct, i) => {
        const col = palette[i % palette.length]
        const isActive = acct.id === activeAccount?.id
        return (
          <div
            key={acct.id}
            className={`acct-row${isActive ? ' active' : ''}`}
            onClick={() => handleSelectAccount(acct.id)}
          >
            <div className="acct-dot" style={{ background: col.bg, color: col.text }}>
              {acct.name.charAt(0).toUpperCase()}
            </div>
            <div className="acct-info">
              <div className="acct-name">{acct.name}</div>
              <div className="acct-cur">{acct.currency_code}</div>
            </div>
            {isActive && <span className="acct-check">✓</span>}
          </div>
        )
      })}
      <div className="acct-row" onClick={handleAddAccount}>
        <div className="acct-dot acct-dot-add">+</div>
        <div className="acct-info">
          <div className="acct-name acct-name-add">Add account</div>
        </div>
      </div>
    </div>
  )

  /* ═══════════ desktop: persistent rail, no bottom nav, no drawer ═══════════ */
  if (isDesktop) {
    const navButton = (n: { page: Page; label: string; icon: ReactNode; di: string }) => (
      <button key={n.page} type="button"
        className={`rail-item${active === n.page ? ' active' : ''}`}
        aria-current={active === n.page ? 'page' : undefined}
        onClick={() => go(n.page)}>
        <span className={`di ${n.di}`}>{n.icon}</span>
        <span className="rail-lbl">{n.label}</span>
      </button>
    )

    return (
      <div className="dshell">
        <aside className="rail">
          <div className="rail-mark">Pocket<b>Pilot</b></div>

          {/* The active account is always visible; the full list opens under it. */}
          <button type="button" className="rail-acct" onClick={() => setAcctOpen(o => !o)}
            aria-expanded={acctOpen}>
            {activeAccount && (
              <div className="acct-dot" style={{ background: activeCol.bg, color: activeCol.text }}>
                {activeAccount.name.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="rail-acct-name">{activeAccount?.name ?? 'Account'}</span>
            <span className="acct-cur">{activeAccount?.currency_code}</span>
            <span className="acct-chv" style={{ transform: acctOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
          </button>
          {acctOpen && accountRows}

          <nav className="rail-grp">{NAV_MAIN.map(navButton)}</nav>
          <nav className="rail-grp">
            <div className="rail-grp-lbl">Manage</div>
            {NAV_MANAGE.map(navButton)}
          </nav>

          <div className="rail-gap" />

          <div className="rail-foot">
            <button type="button" className="rail-item" onClick={onToggleDark}>
              <span className="di set">{darkMode ? '☀' : '☾'}</span>
              <span className="rail-lbl">{darkMode ? 'Light mode' : 'Dark mode'}</span>
            </button>
            {navButton({ page: 'settings', label: 'Settings', icon: '⚙', di: 'set' })}
          </div>
        </aside>

        <main className="dmain">
          <div className="dcol">{children}</div>
        </main>
      </div>
    )
  }

  /* ═══════════ mobile: unchanged ═══════════ */
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
          <span className="nav-icon"><ForecastIcon size={18} /></span>Forecast
        </button>
      </div>

      {drawerOpen && (
        <div className="drawer" onClick={e => { if (e.target === e.currentTarget) setDrawerOpen(false) }}>
          <div className="panel">
            <div className="pnm">Pocket<b>Pilot</b></div>
            <div className="psub">Menu</div>

            <div className="drawer-div" />

            {/* ── accounts section ── */}
            <div
              className="acct-sec-hdr"
              onClick={() => { if (!autoExpand) setAcctOpen(o => !o) }}
              style={{ cursor: autoExpand ? 'default' : 'pointer' }}
            >
              <span className="acct-sec-label">Accounts</span>
              {!autoExpand && activeAccount && (
                <div className="acct-sec-collapsed">
                  <div className="acct-dot-sm" style={{ background: activeCol.bg, color: activeCol.text }}>
                    {activeAccount.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="acct-sec-name">{activeAccount.name}</span>
                  <span className="acct-sec-cur">{activeAccount.currency_code}</span>
                  <span className="acct-chv" style={{ transform: acctOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
                </div>
              )}
            </div>

            {acctExpanded && accountRows}

            <div className="drawer-div" />

            {NAV_MAIN.map(n => (
              <div key={n.page} className={`drawer-item${active === n.page ? ' active' : ''}`} onClick={() => go(n.page)}>
                <div className={`di ${n.di}`}>{n.icon}</div><div className="dt">{n.label}</div>
              </div>
            ))}
            <div className="drawer-div" />
            {NAV_MANAGE.map(n => (
              <div key={n.page} className={`drawer-item${active === n.page ? ' active' : ''}`} onClick={() => go(n.page)}>
                <div className={`di ${n.di}`}>{n.icon}</div><div className="dt">{n.label}</div>
              </div>
            ))}
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
