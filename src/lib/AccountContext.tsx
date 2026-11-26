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
  // Release 8: a colour of its own (0–5, see ACCOUNT_COLOURS) and archiving.
  // Null colour on an account made before the SQL ran: it follows the list order.
  colour?: number | null
  archived?: boolean | null
}

export { ACCOUNT_COLOURS, colourOf } from './accountColours'

interface AccountContextValue {
  // Accounts in use. Archived ones are hidden everywhere but Settings › Accounts.
  accounts: Account[]
  allAccounts: Account[]
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

    const all = data ?? []
    setAccounts(all)

    // If no stored preference, or the stored account is gone or archived, open the first in use
    const live = all.filter(a => !a.archived)
    const stored = localStorage.getItem(`pp_active_account_${userId}`)
    if (!live.some(a => a.id === stored) && live.length > 0) {
      setActiveAccountId(live[0].id)
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

  const live = accounts.filter(a => !a.archived)
  const activeAccount = live.find(a => a.id === activeAccountId) ?? null

  return (
    <AccountContext.Provider value={{
      accounts: live,
      allAccounts: accounts,
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