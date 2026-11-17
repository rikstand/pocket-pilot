import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The one bottom sheet. Every sheet in the new look is drawn by this, so they
 * all behave the same way:
 *
 *   - the button row stays pinned to the bottom while the content scrolls
 *   - the phone's Back button, Escape and a tap outside all close the sheet
 *   - if something was typed, those three ask before throwing it away
 *     (× and Cancel are a deliberate choice, so they close straight away)
 *   - focus moves into the sheet and stays there; it goes back to where it
 *     was when the sheet closes
 *   - the sheet is named for screen readers by its own title
 *   - a save that fails shows one plain line at the top, with the technical
 *     detail behind "Details", in place of a browser alert box
 */

interface Props {
  onClose: () => void
  busy?: boolean
  children: ReactNode
}

/* ── one history entry while any sheet is open ──────────────────────────
   A sheet that swaps for another (plan → this cycle's payment) must not
   leave two entries behind, and closing one by its own buttons must take the
   entry away again. So the entry belongs to "a sheet is open", not to a
   particular sheet. */
type Open = { ask: () => void; fail: (m: string, detail: string) => void }
const stack: Open[] = []
let entry = false        // our entry is on top of the history
let skipPop = false      // the next popstate is our own history.back()
let listening = false

function sync() {
  window.setTimeout(() => {
    if (stack.length > 0 && !entry) { window.history.pushState({ rwSheet: true }, ''); entry = true }
    else if (stack.length === 0 && entry) { entry = false; skipPop = true; window.history.back() }
  }, 0)
}
function onPop() {
  if (skipPop) { skipPop = false; return }
  entry = false
  const top = stack[stack.length - 1]
  if (top) top.ask()
  sync()                 // still open (busy, or asking about typed input): put the entry back
}

/** A save or load that failed. Shown in the open sheet; with no sheet open, as a toast. */
let toastFallback: ((message: string) => void) | null = null
export function setErrorToast(show: (message: string) => void) { toastFallback = show }
export function reportError(message: string, error?: unknown) {
  const detail = error instanceof Error ? error.message : error ? String(error) : ''
  console.error(message, error)
  const top = stack[stack.length - 1]
  if (top) top.fail(message, detail)
  else if (toastFallback) toastFallback(`${message} Check your connection and try again.`)
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export default function Sheet({ onClose, busy = false, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [asking, setAsking] = useState(false)
  const [err, setErr] = useState<{ message: string; detail: string } | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const touched = useRef(false)
  const live = useRef({ onClose, busy, asking })
  live.current = { onClose, busy, asking }

  // Back, Escape and a tap outside: ask first when something was typed.
  function ask() {
    const now = live.current
    if (now.busy) return
    if (touched.current && !now.asking) { setAsking(true); return }
    now.onClose()
  }

  useEffect(() => {
    const me: Open = { ask, fail: (message, detail) => { setErr({ message, detail }); setShowDetail(false) } }
    stack.push(me)
    if (!listening) { window.addEventListener('popstate', onPop); listening = true }
    sync()
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    return () => {
      const i = stack.indexOf(me); if (i >= 0) stack.splice(i, 1)
      sync()
      if (before && document.contains(before)) before.focus({ preventScroll: true })
    }
  }, [])

  // Named by its own title, whatever step it is showing.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const title = el.querySelector('.rw-sheet-title')?.textContent
    if (title) el.setAttribute('aria-label', title)
  })

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); ask(); return }
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null)
    if (items.length === 0) { e.preventDefault(); return }
    const first = items[0], last = items[items.length - 1], at = document.activeElement
    if (e.shiftKey && (at === first || at === ref.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className="rw rw-ov" onClick={e => { if (e.target === e.currentTarget) ask() }} onKeyDown={onKeyDown}>
      <div ref={ref} className={`rw-sheet shared${busy ? ' busy' : ''}`} role="dialog" aria-modal="true" aria-busy={busy || undefined} tabIndex={-1}
        onInput={() => { touched.current = true; if (err) setErr(null) }}>
        {err && !asking && (
          <div className="rw-sheet-err" role="alert">
            <div><b>{err.message}</b> Check your connection and try again.
              {err.detail && <> <button type="button" onClick={() => setShowDetail(s => !s)}>{showDetail ? 'Hide details' : 'Details'}</button></>}
              {showDetail && <small>{err.detail}</small>}</div>
            <button type="button" className="rw-x" aria-label="Dismiss" onClick={() => setErr(null)}>×</button>
          </div>
        )}
        {asking && (
          <div className="rw-sheet-body">
            <div className="rw-grab" />
            <div className="rw-sh-h"><div><div className="rw-sheet-title">Discard what you typed?</div>
              <div className="rw-sd">Your changes on this sheet haven’t been saved.</div></div></div>
            <div className="rw-ctas">
              <button type="button" className="rw-cta sec" onClick={() => live.current.onClose()}>Discard</button>
              <button type="button" className="rw-cta" autoFocus onClick={() => setAsking(false)}>Keep editing</button>
            </div>
          </div>
        )}
        {/* Kept mounted while the question shows, so nothing typed is lost. */}
        <div className="rw-sheet-body" hidden={asking}>{children}</div>
      </div>
    </div>
  )
}
