import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'

export interface Account {
  id: string
  user_id: string
  name: string
  currency_code: string
  opening_balance_cents: number
  safety_floor_cents: number
  created_at: string
}

interface AccountContextValue {
  accounts: Account[]
  activeAccount: Account | null
  setActiveAccountId: (id: string) => void
  reloadAccounts: () => Promise<void>
  loading: boolean
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [accounts, setAccounts]               = useState<Account[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() =>
    localStorage.getItem(`pp_active_account_${userId}`)
  )
  const [loading, setLoading] = useState(true)

  async function loadAccounts() {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at')
    if (error) throw error

    setAccounts(data ?? [])

    // If no stored preference, or stored id no longer exists, default to first account
    const storedStillValid = data?.some(a => a.id === activeAccountId)
    if (!storedStillValid && data && data.length > 0) {
      setActiveAccountId(data[0].id)
    }

    setLoading(false)
  }

  useEffect(() => {
    loadAccounts()
  }, [userId])

  // Persist active account choice
  useEffect(() => {
    if (activeAccountId) {
      localStorage.setItem(`pp_active_account_${userId}`, activeAccountId)
    }
  }, [activeAccountId, userId])

  function handleSetActiveAccountId(id: string) {
    setActiveAccountId(id)
  }

  const activeAccount = accounts.find(a => a.id === activeAccountId) ?? null

  return (
    <AccountContext.Provider value={{
      accounts,
      activeAccount,
      setActiveAccountId: handleSetActiveAccountId,
      reloadAccounts: loadAccounts,
      loading,
    }}>
      {children}
    </AccountContext.Provider>
  )
}

export function useAccount() {
  const ctx = useContext(AccountContext)
  if (!ctx) throw new Error('useAccount must be used inside AccountProvider')
  return ctx
}