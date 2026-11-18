import { createContext, useContext } from 'react'

export interface ToastOptions {
  undo?: () => void | Promise<void>
  // At most one action beside Undo.
  action?: { label: string; run: () => void | Promise<void> }
  // Something was removed: Undo stays until the next tap elsewhere, up to 30 s.
  lasting?: boolean
}

export type Show = (message: string, options?: ToastOptions) => void

export const ToastContext = createContext<Show>(() => {})

export function useToast(): Show {
  return useContext(ToastContext)
}
