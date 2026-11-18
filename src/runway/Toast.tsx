import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { setErrorToast } from './Sheet'
import { ToastContext, type Show, type ToastOptions } from './toastContext'

/**
 * Toast with Undo: every save says what happened and offers Undo. At most one
 * other action sits beside Undo. A new toast replaces the one showing.
 * Pages call useToast() from ./toastContext.
 */
// How long a toast stays. Long enough to read it and reach Undo (J5).
const SHOW_MS = 5000
// A removal keeps its Undo until you do something else, up to this long.
const LASTING_MS = 30000

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

  // A failure with no sheet open (a page-level action) is said here.
  useEffect(() => { setErrorToast(m => show(m)) }, [show])

  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!toast) return
    timer.current = window.setTimeout(() => setHiding(true), toast.lasting ? LASTING_MS : SHOW_MS)
    if (!toast.lasting) return () => window.clearTimeout(timer.current)
    // The next tap anywhere but the toast is the next action: it goes then.
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setHiding(true) }
    const arm = window.setTimeout(() => document.addEventListener('pointerdown', away, true), 400)
    return () => { window.clearTimeout(timer.current); window.clearTimeout(arm); document.removeEventListener('pointerdown', away, true) }
  }, [toast])

  // Drop it once the fade has finished, so it can't be tapped while invisible.
  useEffect(() => {
    if (!hiding) return
    const t = window.setTimeout(() => setToast(null), 300)
    return () => window.clearTimeout(t)
  }, [hiding])

  async function run(fn?: () => void | Promise<void>) {
    setHiding(true)
    if (!fn) return
    // An Undo that fails must say so: otherwise the change looks undone and isn't.
    try { await fn() } catch { show('Undo didn’t work, so that change is still saved.') }
  }

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} ref={box} className={`rw rw-toast${hiding ? ' hide' : ''}`} role="status" aria-live="polite">
          <span className="rw-toast-msg">{toast.message}</span>
          {toast.action && <button type="button" onClick={() => run(toast.action!.run)}>{toast.action.label}</button>}
          {toast.undo && <button type="button" onClick={() => run(toast.undo)}>Undo</button>}
        </div>
      )}
    </ToastContext.Provider>
  )
}
