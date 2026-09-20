import { useEffect, useState } from 'react'
import { useAccount } from './lib/AccountContext'
import { moneyFormatter, currencySymbol } from './lib/money'
import { getWishlistItems, updateAccount } from './lib/repository'
import { loadForecast } from './lib/forecast'

const PROJECT_CYCLES = 6

export default function SettingsPage({ accountId }: { userId: string; accountId: string }) {
  const { activeAccount, reloadAccounts } = useAccount()

  // Amounts follow the account's currency — see lib/money.ts
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)

  const [cycles,  setCycles]  = useState<any[]>([])
  const [wishlist, setWishlist] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)

  const [name,  setName]  = useState(activeAccount?.name ?? '')
  const [floor, setFloor] = useState(String((activeAccount?.safety_floor_cents ?? 0) / 100))

  const savedFloorCents = activeAccount?.safety_floor_cents ?? 0
  const floorCents = Math.max(0, Math.round(parseFloat(floor || '0') * 100))
  const dirty = floorCents !== savedFloorCents || name.trim() !== (activeAccount?.name ?? '')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [wish, forecast] = await Promise.all([
          getWishlistItems(accountId),
          // Floor of 0 so the impact panel can recompute breaches against a
          // candidate floor without re-running the engine on every keystroke.
          // Closing balances do not depend on the floor; only the flag does.
          loadForecast(accountId, 0, { numCycles: PROJECT_CYCLES, safetyFloorCents: 0 }),
        ])
        setWishlist(wish.filter((w: any) => w.status === 'active'))
        setCycles(forecast.cycles)
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [accountId])

  async function save() {
    if (!name.trim()) { setError('Account name is required.'); return }
    setSaving(true); setError('')
    try {
      await updateAccount(accountId, {
        name: name.trim(),
        safety_floor_cents: floorCents,
      })
      await reloadAccounts()
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return (
    <div className="scrollarea" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <p style={{ color:'var(--mut)' }}>Loading…</p>
    </div>
  )

  /* ── impact of the candidate floor ───────────────────────────────── */
  const closings = cycles.map(c => c.committedClosingBalanceCents)
  const breaches = closings.filter(v => v < floorCents).length
  const lowest   = closings.length ? Math.min(...closings) : 0
  const headroom = lowest - floorCents

  // Wishlist reachability: an item is reachable if some projected cycle can
  // absorb it and stay above the floor. Matches resolveActive()'s test, but
  // without reservation between items — this is an indicator, not the resolver.
  const reachable = wishlist.filter(w =>
    closings.some(v => v - w.amount_cents >= floorCents)
  ).length

  // Labels are formatted, not written out, so they follow the account currency.
  const PRESET_CENTS = [0, 25000, 50000, 100000, 200000]

  return (
    <div className="scrollarea">

      <div style={{ padding:'14px 20px 2px' }}>
        <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--mut)' }}>Settings</div>
        <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:22, letterSpacing:'-.02em', marginTop:4 }}>
          {activeAccount?.name ?? 'Account'}
        </div>
      </div>

      <div className="section-hdr sh-fix">
        <span className="sh-label">Safety floor</span>
        <span className="sh-total">{fmt(savedFloorCents, false)}</span>
      </div>

      <div style={{ padding:'8px 16px 0' }}>
        <div className="field">
          <label>Never go below</label>
          <div className="inrow">
            <span className="pre">{sym}</span>
            <input type="number" inputMode="decimal" value={floor}
              onChange={e => setFloor(e.target.value)} placeholder="0" />
          </div>
          <p className="hint">
            Pocket Pilot treats this as untouchable. Cycles projected to close below it are flagged,
            and it caps what any repayment or wishlist commitment will suggest.
          </p>
        </div>

        <div className="floor-presets">
          {PRESET_CENTS.map(cents => (
            <button key={cents}
              className={floorCents === cents ? 'on' : ''}
              onClick={() => setFloor(String(cents / 100))}>
              {cents === 0 ? 'None' : fmt(cents, false)}
            </button>
          ))}
        </div>
      </div>

      <div className="floor-impact">
        <div className="fi-k">What this changes</div>
        <div className="fi-row">
          <span className="l">Cycles flagged in your forecast</span>
          <span className={`v${breaches > PROJECT_CYCLES / 2 ? ' bad' : breaches > 0 ? ' warn' : ' good'}`}>
            {breaches} of {closings.length}
          </span>
        </div>
        <div className="fi-row">
          <span className="l">Tightest cycle leaves</span>
          <span className={`v${headroom < 0 ? ' bad' : ' good'}`}>
            {headroom < 0 ? fmt(headroom, false) + ' short' : fmt(headroom, false) + ' spare'}
          </span>
        </div>
        {wishlist.length > 0 && (
          <div className="fi-row">
            <span className="l">Wishlist items still reachable</span>
            <span className={`v${reachable === 0 ? ' bad' : reachable < wishlist.length ? ' warn' : ' good'}`}>
              {reachable} of {wishlist.length}
            </span>
          </div>
        )}
      </div>

      {floorCents === 0 ? (
        <div className="skipnote" style={{ margin:'12px 16px 0', borderLeft:'2px solid var(--floor)', color:'var(--floor)' }}>
          With no floor, Pocket Pilot will plan you down to <b>{fmt(0, false)}</b> and call it affordable.
          Most people want something here.
        </div>
      ) : breaches > PROJECT_CYCLES / 2 ? (
        <div className="skipnote" style={{ margin:'12px 16px 0', borderLeft:'2px solid var(--warn)', color:'var(--warn)' }}>
          <b>{breaches} of your next {closings.length} cycles</b> already close below this.
          A floor you breach constantly stops working as a warning.
        </div>
      ) : (
        <div className="skipnote" style={{ margin:'12px 16px 0' }}>
          {breaches === 0
            ? <>Comfortable — none of your next {closings.length} cycles come close, so a flag will mean something when it appears.</>
            : <>{breaches} of your next {closings.length} cycles close below this. Tight, but a flag still carries weight.</>}
        </div>
      )}

      <div className="section-hdr sh-fix">
        <span className="sh-label">Account</span>
      </div>

      <div style={{ padding:'8px 16px 0' }}>
        <div className="field">
          <label>Account name</label>
          <div className="inrow">
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Main" />
          </div>
        </div>

        <div className="field">
          <label>Currency</label>
          <div className="inrow" style={{ opacity:.6 }}>
            <input type="text" value={activeAccount?.currency_code ?? ''} disabled />
          </div>
          <p className="hint">
            Set when the account was created. Changing it would reinterpret every stored amount,
            so it's fixed.
          </p>
        </div>
      </div>

      {error && <p style={{ color:'var(--floor)', fontSize:13, padding:'8px 20px 0' }}>{error}</p>}

      <div style={{ padding:'16px 16px 28px' }}>
        <button className="addbtn" onClick={save}
          disabled={saving || !dirty}
          style={{
            background: dirty ? 'var(--acc)' : undefined,
            color: dirty ? '#fff' : undefined,
            borderStyle: dirty ? 'solid' : undefined,
            opacity: saving ? 0.6 : 1,
          }}>
          {saving ? 'Saving…' : saved ? 'Saved ✓' : dirty ? 'Save changes' : 'No changes'}
        </button>
        {dirty && (
          <div style={{ textAlign:'center', fontFamily:"'JetBrains Mono',monospace", fontSize:10.5, color:'var(--mut)', paddingTop:6 }}>
            applies to every projection immediately
          </div>
        )}
      </div>

    </div>
  )
}
