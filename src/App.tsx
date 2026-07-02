import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getProfile } from './lib/repository'
import LoginPage from './LoginPage'
import SetupPage from './SetupPage'
import Dashboard from './Dashboard'
import ExpensesPage from './ExpensesPage'
import AppShell, { type Page } from './AppShell'

export default function App() {
  const [userId,      setUserId]      = useState<string | null>(null)
  const [hasProfile,  setHasProfile]  = useState<boolean | null>(null)
  const [checking,    setChecking]    = useState(true)
  const [page,        setPage]        = useState<Page>('cycle')
  const [dataVersion, setDataVersion] = useState(0)
  const [darkMode,    setDarkMode]    = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')

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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  if (checking)    return <p style={{ fontFamily:'sans-serif', padding:24 }}>Loading…</p>
  if (!userId)     return <LoginPage onLogin={() => {}} />
  if (!hasProfile) return <SetupPage userId={userId} onComplete={() => setHasProfile(true)} />

  function goCycleAndReload() {
    setDataVersion(v => v + 1)
    setPage('cycle')
  }

  return (
    <AppShell active={page} onNavigate={setPage} darkMode={darkMode} onToggleDark={() => setDarkMode(d => !d)}>
      {page === 'cycle' && (
        <Dashboard key={dataVersion} userId={userId} />
      )}
      {page === 'expenses' && (
        <ExpensesPage userId={userId} onBack={goCycleAndReload} />
      )}
      {page === 'forecast' && (
        <div className="scrollarea" style={{ padding: 24 }}>
          <p style={{ color: 'var(--mut)' }}>Forecast — next build session.</p>
        </div>
      )}
      {page === 'wishlist' && (
        <div className="scrollarea" style={{ padding: 24 }}>
          <p style={{ color: 'var(--mut)' }}>Wishlist — coming soon.</p>
        </div>
      )}
      {page === 'settings' && (
        <div className="scrollarea" style={{ padding: 24 }}>
          <p style={{ color: 'var(--mut)' }}>Settings — not built yet.</p>
        </div>
      )}
    </AppShell>
  )
}