import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getProfile } from './lib/repository'
import { AccountProvider, useAccount } from './lib/AccountContext'
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
import WishlistPlan from './runway/WishlistPlan'
import SavingsPlan from './runway/SavingsPlan'
import { ToastProvider } from './runway/Toast'
import { useNewLook } from './lib/look'
import { useBackLayer } from './runway/Sheet'
import { BACK } from './runway/RunwayShell'
import Welcome, { LoadingStage } from './runway/Welcome'
import SettingsHub from './runway/SettingsHub'
import AccountsPage from './runway/AccountsPage'
import { useTheme, setTheme } from './lib/theme'

function AuthedApp({ userId, email }: { userId: string; email: string | null }) {
  const { activeAccount, loading: accountLoading, reloadAccounts } = useAccount()
  const [page,           setPage]          = useState<Page>('cycle')
  const [dataVersion,    setDataVersion]   = useState(0)
  // Light, Dark or Match my phone, kept on this phone (Settings › Theme). The old
  // look's moon button still flips between light and dark.
  const { dark: darkMode } = useTheme()
  const [addingAccount, setAddingAccount] = useState(false)
  const [newLook] = useNewLook()
  const [addSignal, setAddSignal] = useState(0)

  // Plan, More and Expenses & income only exist in the new shell. Turning the new look off
  // while on one of them shows Cycle.
  const shown: Page = !newLook && (page === 'plan' || page === 'more' || page === 'items' || page === 'savings' || page === 'accounts') ? 'cycle' : page

  // The phone's Back goes one level up in the new look, as the ‹ link does:
  // a page under Plan or More goes back to it, and a tab goes back to Cycle.
  useBackLayer(newLook && shown !== 'cycle', () => navigate(BACK[shown]?.to ?? 'cycle'))

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

  if (accountLoading) return <LoadingStage />

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
        <Dashboard key={'cycle-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="cycle" onForecast={() => navigate('forecast')} onCredit={() => navigate('credit')} onNavigate={navigate} />
      )}
      {shown === 'forecast' && (
        <Dashboard key={'forecast-' + dataVersion} userId={userId} accountId={activeAccount.id} variant="forecast" onCredit={() => navigate('credit')} onNavigate={navigate} />
      )}
      {shown === 'items' && <ItemsPage accountId={activeAccount.id} onNavigate={navigate} />}
      {shown === 'expenses' && (
        <ExpensesPage userId={userId} accountId={activeAccount.id} onBack={goCycleAndReload} addSignal={addSignal} />
      )}
      {shown === 'savings' && <SavingsPlan accountId={activeAccount.id} />}
      {shown === 'wishlist' && (
        newLook
          ? <WishlistPlan accountId={activeAccount.id} userId={userId} />
          : <WishlistPage userId={userId} accountId={activeAccount.id} />
      )}
      {shown === 'credit' && (
        newLook
          ? <CreditPlan key={'credit-' + dataVersion} accountId={activeAccount.id} />
          : <CreditPage key={'credit-' + dataVersion} userId={userId} accountId={activeAccount.id} />
      )}
      {shown === 'settings' && (newLook
        ? <SettingsHub key={'settings-' + activeAccount.id} onNavigate={navigate} email={email} />
        : <SettingsPage key={'settings-' + dataVersion} userId={userId} accountId={activeAccount.id} />
      )}
      {shown === 'accounts' && <AccountsPage onAddAccount={() => setAddingAccount(true)} />}
    </>
  )

  if (newLook) return (
    <LogSheetsProvider accountId={activeAccount.id} userId={userId}>
    <RunwayShell
      active={shown}
      onNavigate={navigate}
      onAdd={addFromShell}
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
      onToggleDark={() => setTheme(darkMode ? 'light' : 'dark')}
      onAddAccount={() => setAddingAccount(true)}
    >
      {pages}
    </AppShell>
  )
}

export default function App() {
  const [userId,     setUserId]     = useState<string | null>(null)
  const [email,      setEmail]      = useState<string | null>(null)
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)
  const [checking,   setChecking]   = useState(true)
  // Opened from the "reset your password" email: ask for the new one first.
  const [recovery,   setRecovery]   = useState(false)
  useTheme()

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
      setUserId(uid); setEmail(data.session?.user.email ?? null)
      if (uid) checkProfile(uid).finally(() => setChecking(false))
      else setChecking(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user.id ?? null
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      setUserId(uid); setEmail(session?.user.email ?? null)
      if (uid) checkProfile(uid)
      else setHasProfile(null)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (checking || (userId && hasProfile === null && !recovery)) return <LoadingStage />
  if (!userId || recovery) return (
    <Welcome recovery={recovery} recoveryEmail={email} onRecovered={() => setRecovery(false)} />
  )
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
        <AuthedApp userId={userId} email={email} />
      </ToastProvider>
    </AccountProvider>
  )
}
