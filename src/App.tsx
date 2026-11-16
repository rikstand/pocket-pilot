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
import CreditPage from './CreditPage'
import CreditPlan from './runway/CreditPlan'
import SettingsPage from './SettingsPage'
import RunwayShell from './runway/RunwayShell'
import { LogSheetsProvider } from './runway/LogSheets'
import ItemsPage from './runway/ItemsPage'
import { ToastProvider } from './runway/Toast'
import { useNewLook } from './lib/look'

function AuthedApp({ userId }: { userId: string }) {
  const { activeAccount, loading: accountLoading, reloadAccounts } = useAccount()
  const [page,           setPage]          = useState<Page>('cycle')
  const [dataVersion,    setDataVersion]   = useState(0)
  const [darkMode,       setDarkMode]      = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'
  )
  const [addingAccount, setAddingAccount] = useState(false)
  const [newLook] = useNewLook()
  const [addSignal, setAddSignal] = useState(0)

  // Plan, More and Expenses & income only exist in the new shell. Turning the new look off
  // while on one of them shows Cycle.
  const shown: Page = !newLook && (page === 'plan' || page === 'more' || page === 'items') ? 'cycle' : page

  function navigate(to: Page) {
    setPage(to)
    // Off the page, so coming back to Expenses later doesn't reopen the add sheet.
    if (to !== 'expenses') setAddSignal(0)
  }

  // Today's add-expense sheet: "Add a bill, one-off or income" under Log
  // spend, until Journey 9 replaces it.
  function addFromShell() {
    setPage('expenses')
    setAddSignal(n => n + 1)
  }

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

  const pages = (
    <>
      {shown === 'cycle' && (
        <Dashboard key={'cycle-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="cycle" onForecast={() => navigate('forecast')} onCredit={() => navigate('credit')} />
      )}
      {shown === 'forecast' && (
        <Dashboard key={'forecast-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="forecast" onCredit={() => navigate('credit')} />
      )}
      {shown === 'items' && <ItemsPage accountId={activeAccount.id} onNavigate={navigate} />}
      {shown === 'expenses' && (
        <ExpensesPage userId={userId} accountId={activeAccount.id} onBack={goCycleAndReload} addSignal={addSignal} />
      )}
      {shown === 'wishlist' && (
        <WishlistPage userId={userId} accountId={activeAccount.id} />
      )}
      {shown === 'credit' && (
        newLook
          ? <CreditPlan key={'credit-' + dataVersion} accountId={activeAccount.id} />
          : <CreditPage key={'credit-' + dataVersion} userId={userId} accountId={activeAccount.id} />
      )}
      {shown === 'settings' && (
        <SettingsPage key={'settings-' + dataVersion} userId={userId} accountId={activeAccount.id} />
      )}
    </>
  )

  if (newLook) return (
    <LogSheetsProvider accountId={activeAccount.id} userId={userId}>
    <RunwayShell
      active={shown}
      onNavigate={navigate}
      onAdd={addFromShell}
      darkMode={darkMode}
      onToggleDark={() => setDarkMode(d => !d)}
      onAddAccount={() => setAddingAccount(true)}
    >
      {pages}
    </RunwayShell>
    </LogSheetsProvider>
  )

  return (
    <AppShell
      active={shown}
      onNavigate={navigate}
      darkMode={darkMode}
      onToggleDark={() => setDarkMode(d => !d)}
      onAddAccount={() => setAddingAccount(true)}
    >
      {pages}
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
      <ToastProvider>
        <AuthedApp userId={userId} />
      </ToastProvider>
    </AccountProvider>
  )
}