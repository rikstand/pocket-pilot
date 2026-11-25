import { Component, useState, type ReactNode } from 'react'
import Sheet from './Sheet'

/**
 * A sheet that fails to draw no longer blanks the app (6b's blank screen on
 * a savings row). The page stays, and a small sheet says it didn't open, with
 * the technical detail behind Details, as for a failed save.
 */
export default class SheetGuard extends Component<{ onClose: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('A sheet failed to open', error) }
  render() {
    return this.state.error ? <Failed error={this.state.error} onClose={this.props.onClose} /> : this.props.children
  }
}

function Failed({ error, onClose }: { error: Error; onClose: () => void }) {
  const [more, setMore] = useState(false)
  return (
    <Sheet onClose={onClose}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><h2 className="rw-sheet-title">This didn’t open</h2>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="rw-card">
        <div className="rw-body-t">Something went wrong showing this. Nothing was changed.</div>
        <button type="button" className="rw-lnk" style={{ marginTop: 8 }} onClick={() => setMore(v => !v)}>{more ? 'Hide details' : 'Details'}</button>
        {more && <div className="rw-sub" style={{ marginTop: 6, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>{error.message}</div>}
      </div>
      <div className="rw-ctas"><button type="button" className="rw-cta" onClick={onClose}>Close</button></div>
    </Sheet>
  )
}
