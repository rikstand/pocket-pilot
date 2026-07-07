import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getProfile } from './lib/repository'
import { AccountProvider, useAccount } from './lib/AccountContext'
import LoginPage from './LoginPage'
import SetupPage from './SetupPage'
import Dashboard from './Dashboard'
import ExpensesPage from './ExpensesPage'
import AppShell, { type Page } from './AppShell'
import WishlistPage from './WishlistPage'

function AuthedApp({ userId }: { userId: string }) {
  const { activeAccount, loading: accountLoading, reloadAccounts } = useAccount()
  const [page,           setPage]          = useState<Page>('cycle')
  const [dataVersion,    setDataVersion]   = useState(0)
  const [darkMode,       setDarkMode]      = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'
  )
  const [addingAccount, setAddingAccount] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  function goCycleAndReload() {
    setDataVersion(v => v + 1)
    setPage('cycle')
  }

  async function handleAccountAdded() {
    await reloadAccounts()
    setAddingAccount(false)
    setDataVersion(v => v + 1)
    setPage('cycle')
  }

  if (accountLoading) return <p style={{ fontFamily: 'sans-serif', padding: 24 }}>Loading…</p>

  if (addingAccount) return (
    <SetupPage
      userId={userId}
      isFirstRun={false}
      onCancel={() => setAddingAccount(false)}
      onComplete={handleAccountAdded}
    />
  )

  if (!activeAccount) return <p style={{ fontFamily: 'sans-serif', padding: 24 }}>No account found.</p>

  return (
    <AppShell
      active={page}
      onNavigate={setPage}
      darkMode={darkMode}
      onToggleDark={() => setDarkMode(d => !d)}
      onAddAccount={() => setAddingAccount(true)}
    >
      {page === 'cycle' && (
        <Dashboard key={'cycle-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="cycle" />
      )}
      {page === 'forecast' && (
        <Dashboard key={'forecast-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="forecast" />
      )}
      {page === 'expenses' && (
        <ExpensesPage userId={userId} accountId={activeAccount.id} onBack={goCycleAndReload} />
      )}
      {page === 'wishlist' && (
        <WishlistPage userId={userId} accountId={activeAccount.id} />
      )}
      {page === 'settings' && (
        <div className="scrollarea" style={{ padding: 24 }}>
          <p style={{ color: 'var(--mut)' }}>Settings — not built yet.</p>
        </div>
      )}
    </AppShell>
  )
}

export default function App() {
  const [userId,     setUserId]     = useState<string | null>(null)
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)
  const [checking,   setChecking]   = useState(true)

  async function checkProfile(uid: string) {
    try {
      const profile = await getProfile(uid)
      setHasProfile(!!profile)
    } catch {
      setHasProfile(false)
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user.id ?? null
      setUserId(uid)
      if (uid) checkProfile(uid).finally(() => setChecking(false))
      else setChecking(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user.id ?? null
      setUserId(uid)
      if (uid) checkProfile(uid)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (checking)    return <p style={{ fontFamily: 'sans-serif', padding: 24 }}>Loading…</p>
  if (!userId)     return <LoginPage onLogin={() => {}} />
  if (!hasProfile) return (
    <SetupPage
      userId={userId}
      isFirstRun={true}
      onComplete={() => setHasProfile(true)}
    />
  )

  return (
    <AccountProvider userId={userId}>
      <AuthedApp userId={userId} />
    </AccountProvider>
  )
}