import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type Show, type ToastOptions } from './toastContext'

/**
 * Toast with Undo: every save says what happened and offers Undo. At most one
 * other action sits beside Undo. A new toast replaces the one showing.
 * Pages call useToast() from ./toastContext.
 */
// How long a toast stays. Long enough to read it and reach Undo (J5).
const SHOW_MS = 5000

interface Current extends ToastOptions { id: number; message: string }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Current | null>(null)
  const [hiding, setHiding] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)

  const show = useCallback<Show>((message, options = {}) => {
    window.clearTimeout(timer.current)
    seq.current += 1
    setHiding(false)
    setToast({ id: seq.current, message, ...options })
  }, [])

  useEffect(() => {
    if (!toast) return
    timer.current = window.setTimeout(() => setHiding(true), SHOW_MS)
    return () => window.clearTimeout(timer.current)
  }, [toast])

  // Drop it once the fade has finished, so it can't be tapped while invisible.
  useEffect(() => {
    if (!hiding) return
    const t = window.setTimeout(() => setToast(null), 300)
    return () => window.clearTimeout(t)
  }, [hiding])

  async function run(fn?: () => void | Promise<void>) {
    setHiding(true)
    if (fn) await fn()
  }

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} className={`rw rw-toast${hiding ? ' hide' : ''}`} role="status" aria-live="polite">
          <span className="rw-toast-msg">{toast.message}</span>
          {toast.action && <button type="button" onClick={() => run(toast.action!.run)}>{toast.action.label}</button>}
          {toast.undo && <button type="button" onClick={() => run(toast.undo)}>Undo</button>}
        </div>
      )}
    </ToastContext.Provider>
  )
}
