import type { Page } from '../AppShell'
import { useAccount } from '../lib/AccountContext'
import { signOut } from '../lib/auth'
import { useToast } from './toastContext'

/** More: accounts, settings and dark mode. Journey 11 fills in the rest. */
interface Props {
  onNavigate: (page: Page) => void
  darkMode: boolean
  onToggleDark: () => void
  onAddAccount: () => void
}

export default function MoreHub({ onNavigate, darkMode, onToggleDark, onAddAccount }: Props) {
  const { accounts, activeAccount, setActiveAccountId } = useAccount()
  const toast = useToast()
  // Signing out loses nothing, so it is one tap. The app shows the sign-in
  // screen as soon as the session ends.
  async function leave() {
    try { await signOut() } catch { toast('Could not sign out. Check your connection and try again.') }
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head"><h1 className="rw-page-title">More</h1></div>

      <div role="heading" aria-level={2} className="rw-section">Accounts</div>
      <div className="rw-group">
        {accounts.map(a => {
          const on = a.id === activeAccount?.id
          return (
            <button key={a.id} type="button" className="rw-row" aria-pressed={on}
              onClick={() => { setActiveAccountId(a.id); onNavigate('cycle') }}>
              <span className="rw-dot">{a.name.charAt(0).toUpperCase()}</span>
              <div className="rw-tx">
                <div className="rw-row-name">{a.name}</div>
                <div className="rw-sub">{a.currency_code}</div>
              </div>
              {on && <span className="rw-check">✓</span>}
            </button>
          )
        })}
        <button type="button" className="rw-row" onClick={onAddAccount}>
          <span className="rw-dot add">+</span>
          <div className="rw-tx"><div className="rw-row-name">Add account</div></div>
        </button>
      </div>

      <div role="heading" aria-level={2} className="rw-section" />
      <div className="rw-group">
        <div className="rw-row static">
          <div className="rw-tx"><div className="rw-row-name">Dark mode</div></div>
          <button type="button" role="switch" aria-checked={darkMode} aria-label="Dark mode"
            className={`rw-switch${darkMode ? ' on' : ''}`} onClick={onToggleDark}><i /></button>
        </div>
        <button type="button" className="rw-row" onClick={() => onNavigate('settings')}>
          <div className="rw-tx">
            <div className="rw-row-name">Settings</div>
            <div className="rw-sub">Safety floor, account name, new look</div>
          </div>
          <span className="rw-chev">›</span>
        </button>
      </div>

      <div role="heading" aria-level={2} className="rw-section" />
      <div className="rw-group">
        <button type="button" className="rw-row" onClick={leave}>
          <div className="rw-tx"><div className="rw-row-name">Sign out</div></div>
        </button>
      </div>
    </div>
  )
}
