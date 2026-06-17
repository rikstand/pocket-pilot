import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getProfile } from './lib/repository'
import LoginPage from './LoginPage'
import SetupPage from './SetupPage'
import Dashboard from './Dashboard'
import ExpensesPage from './ExpensesPage'

type Page = 'dashboard' | 'expenses'

export default function App() {
  const [userId,      setUserId]      = useState<string | null>(null)
  const [hasProfile,  setHasProfile]  = useState<boolean | null>(null)
  const [checking,    setChecking]    = useState(true)
  const [page,        setPage]        = useState<Page>('dashboard')
  const [dataVersion, setDataVersion] = useState(0)

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

  if (checking)    return <p style={{ fontFamily:'sans-serif', padding:24 }}>Loading…</p>
  if (!userId)     return <LoginPage onLogin={() => {}} />
  if (!hasProfile) return <SetupPage userId={userId} onComplete={() => setHasProfile(true)} />

  if (page === 'expenses') return (
    <ExpensesPage
      userId={userId}
      onBack={() => {
        setDataVersion(v => v + 1)
        setPage('dashboard')
      }}
    />
  )

  return (
    <Dashboard
      key={dataVersion}
      userId={userId}
      onNavigate={setPage}
    />
  )
}