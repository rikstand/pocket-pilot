import { createContext, useContext } from 'react'

/**
 * Journey 5's sheets live in the new shell, so the centre + can open them from
 * any tab. Screens inside the shell open them through this. Outside the new
 * look there is no provider, and screens keep their old behaviour.
 */
export interface LogApi {
  /** Log spend, with a budget picked if it came from that budget's +. */
  log: (budgetId?: string) => void
  /** A budget's spend this cycle. */
  budget: (budgetId: string) => void
  /** Add an expense or income (Journey 9). */
  add: () => void
}

export const LogContext = createContext<LogApi | null>(null)

export function useLog(): LogApi | null {
  return useContext(LogContext)
}
