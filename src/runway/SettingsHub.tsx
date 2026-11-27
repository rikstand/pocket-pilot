import { useEffect, useState } from 'react'
import type { Page } from '../AppShell'
import { useAccount } from '../lib/AccountContext'
import { getIncomeSources, getWishlistItems, updateAccount } from '../lib/repository'
import { loadForecast, type ForecastResult } from '../lib/forecast'
import { moneyFormatter, currencySymbol } from '../lib/money'
import { useNewLook } from '../lib/look'
import { useTheme, type ThemePref } from '../lib/theme'
import { checkPassword, setPassword, sendPasswordReset, authMessage, MIN_PASSWORD } from '../lib/auth'
import Sheet, { reportError } from './Sheet'
import Preview from './Preview'
import { Segmented } from './controls'
import { useToast } from './toastContext'
import AcctDot from './AcctDot'
import { AccountSheet } from './AccountsPage'
import { floorImpact, FLOOR_PAYDAYS } from './floorImpact'

/** More › Settings in the new look (Journey 11, release 8a). */
const HOW_PAID: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', annually: 'Yearly', once: 'Once' }
const UNIT: Record<string, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', annually: 'years' }

export default function SettingsHub({ onNavigate, email }: { onNavigate: (p: Page) => void; email: string | null }) {
  const { activeAccount: a, accounts, allAccounts } = useAccount()
  const [newLook, setNewLook] = useNewLook()
  const theme = useTheme()
  const toast = useToast()
  const [open, setOpen] = useState<'floor' | 'acct' | 'pw' | null>(null)
  const [paid, setPaid] = useState<string | null>(null)

  useEffect(() => {
    if (!a) return
    let live = true
    getIncomeSources(a.id).then((src: any[]) => {
      const p = src.find(s => s.is_primary && s.is_active !== false) ?? src.find(s => !s.is_potential && s.frequency !== 'once')
      if (!live || !p) return
      const n = p.every_n ?? 1
      setPaid(n > 1 ? `Every ${n} ${UNIT[p.frequency] ?? ''}`.trim() : HOW_PAID[p.frequency] ?? null)
    }).catch(() => {})
    return () => { live = false }
  }, [a?.id])

  if (!a) return null
  const fmt = moneyFormatter(a.currency_code)
  const archived = allAccounts.length - accounts.length

  function toggleLook() {
    const was = newLook
    setNewLook(!was)
    toast(was ? 'New look off on this phone' : 'New look on for this phone', { undo: () => setNewLook(was) })
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head"><h1 className="rw-page-title">Settings</h1></div>

      <div role="heading" aria-level={2} className="rw-section"><span className="rw-sec-acct"><AcctDot account={a} i={allAccounts.indexOf(a)} size="sm" />{a.name}</span></div>
      <div className="rw-group">
        <button type="button" className="rw-row" onClick={() => setOpen('floor')}>
          <div className="rw-tx"><div className="rw-row-name">Safety floor</div><div className="rw-sub">What every warning is measured against</div></div>
          <span className="rw-rval">{fmt(a.safety_floor_cents, false)}</span><span className="rw-chev">›</span>
        </button>
        <button type="button" className="rw-row" onClick={() => setOpen('acct')}>
          <div className="rw-tx"><div className="rw-row-name">Name and colour</div></div>
          <span className="rw-rval">{a.name}</span><span className="rw-chev">›</span>
        </button>
        <button type="button" className="rw-row" onClick={() => onNavigate('items')}>
          <div className="rw-tx"><div className="rw-row-name">How often you’re paid</div><div className="rw-sub">Change it on your pay, in Expenses &amp; income</div></div>
          {paid && <span className="rw-rval">{paid}</span>}<span className="rw-chev">›</span>
        </button>
      </div>

      <div role="heading" aria-level={2} className="rw-section">All accounts</div>
      <div className="rw-group">
        <button type="button" className="rw-row" onClick={() => onNavigate('accounts')}>
          <div className="rw-tx"><div className="rw-row-name">Accounts</div><div className="rw-sub">{accounts.length} in use{archived ? ` · ${archived} archived` : ''}</div></div>
          <span className="rw-chev">›</span>
        </button>
      </div>

      <div role="heading" aria-level={2} className="rw-section">Appearance</div>
      <div className="rw-group">
        <div className="rw-row static rw-col">
          <div className="rw-tx"><div className="rw-row-name">Theme</div></div>
          <Segmented<ThemePref> value={theme.pref} onChange={theme.set}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Match phone' }]} />
        </div>
        <div className="rw-row static">
          <div className="rw-tx"><div className="rw-row-name">New look</div><div className="rw-sub">On this phone, until launch</div></div>
          <button type="button" role="switch" aria-checked={newLook} aria-label="New look"
            className={`rw-switch${newLook ? ' on' : ''}`} onClick={toggleLook}><i /></button>
        </div>
      </div>

      <div role="heading" aria-level={2} className="rw-section">You</div>
      <div className="rw-group">
        <div className="rw-row static">
          <div className="rw-tx"><div className="rw-row-name">Email</div></div>
          <span className="rw-rval">{email ?? ''}</span>
        </div>
        <button type="button" className="rw-row" onClick={() => setOpen('pw')}>
          <div className="rw-tx"><div className="rw-row-name">Change password</div></div><span className="rw-chev">›</span>
        </button>
      </div>

      {open === 'floor' && <FloorSheet onClose={() => setOpen(null)} />}
      {open === 'acct' && <AccountSheet account={a} onClose={() => setOpen(null)} />}
      {open === 'pw' && email && <PasswordSheet email={email} onClose={() => setOpen(null)} />}
    </div>
  )
}

/* ── The floor: amount, chips, the standard preview, today's checks ── */
function FloorSheet({ onClose }: { onClose: () => void }) {
  const { activeAccount: a, reloadAccounts } = useAccount()
  const toast = useToast()
  const saved = a?.safety_floor_cents ?? 0
  const [amt, setAmt] = useState(String(saved / 100))
  const [rows, setRows] = useState<ForecastResult | null>(null)
  const [wish, setWish] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!a) return
    let live = true
    Promise.all([loadForecast(a.id, saved, { numCycles: FLOOR_PAYDAYS }), getWishlistItems(a.id)])
      .then(([f, w]) => { if (!live) return; setRows(f); setWish(w.filter((x: any) => x.status === 'active').map((x: any) => x.amount_cents)) })
      .catch(e => reportError('The preview didn’t load.', e))
    return () => { live = false }
  }, [a?.id])

  if (!a) return null
  const fmt = moneyFormatter(a.currency_code), money = (c: number) => fmt(c, false)
  const f = Math.max(0, Math.round((parseFloat(amt) || 0) * 100))
  const changed = f !== saved
  const im = rows ? floorImpact(rows, saved, f, wish) : null

  async function save() {
    setBusy(true)
    try {
      await updateAccount(a!.id, { safety_floor_cents: f })
      await reloadAccounts()
      onClose()
      toast(f ? `Floor ${money(f)}. Every warning re-measured` : 'No floor. Warnings start at $0', {
        undo: async () => { await updateAccount(a!.id, { safety_floor_cents: saved }); await reloadAccounts() },
      })
    } catch (e) { reportError('The floor didn’t save.', e) } finally { setBusy(false) }
  }

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h">
        <div><h2 className="rw-sheet-title">Safety floor</h2><div className="rw-sd">{a.name} · now {money(saved)}</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="rw-card rw-sl-card">
        <div className="rw-pv-k"><span>Never plan below</span></div>
        <div className="rw-amt"><span>{currencySymbol(a.currency_code)}</span>
          <input type="number" inputMode="decimal" min={0} aria-label="Safety floor" value={amt} onChange={e => setAmt(e.target.value)} /></div>
        <div className="rw-chips rw-floor-chips">{[0, 25000, 50000, 100000, 200000].map(v =>
          <button key={v} type="button" className={f === v ? 'on' : ''} onClick={() => setAmt(String(v / 100))}>{v ? money(v) : 'None'}</button>)}</div>
      </div>
      {im ? <>
        <Preview nowCents={im.now} newCents={im.next} payDates={im.payDates} floorCents={f} money={money} third={im.third} tilesFirst />
        {f === 0 && <div className="rw-warn-ban near"><span className="i">!</span><span>No floor: paydays can plan down to {money(0)}.</span></div>}
        {f > 0 && im.under > im.next.length / 2 && <div className="rw-warn-ban near"><span className="i">!</span><span><b>{im.under} of {im.next.length}</b> paydays sit under this. A floor you’re always under stops warning you.</span></div>}
        <div className="rw-hint">{wish.length ? `Wishlist in reach: ${im.reach} of ${wish.length}.` : ''}{im.spareCard ? `${wish.length ? ' ' : ''}On “whatever’s spare”, a higher floor means smaller card payments.` : ''}</div>
      </> : <div className="rw-card rw-sd">Working out your paydays…</div>}
      <div className="rw-ctas">
        {changed
          ? <><button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
              <button type="button" className="rw-cta" disabled={busy} onClick={save}>{busy ? 'Saving…' : f ? `Set floor to ${money(f)}` : 'Remove the floor'}</button></>
          : <button type="button" className="rw-cta" onClick={onClose}>Close</button>}
      </div>
    </Sheet>
  )
}

/* ── Change password: checks the current one first ── */
function PasswordSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const toast = useToast()
  const [cur, setCur] = useState(''), [pw, setPw] = useState(''), [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const short = pw.length > 0 && pw.length < MIN_PASSWORD, mism = pw2.length > 0 && pw2 !== pw

  async function change() {
    setBusy(true); setErr('')
    try {
      if (!(await checkPassword(email, cur))) { setErr('Your current password isn’t right.'); return }
      await setPassword(pw)
      onClose(); toast('Password changed')
    } catch (e) { setErr(authMessage(e)) } finally { setBusy(false) }
  }
  async function forgot() {
    try { await sendPasswordReset(email); onClose(); toast(`Reset link sent to ${email}`) }
    catch (e) { setErr(authMessage(e)) }
  }

  return (
    <Sheet onClose={onClose} busy={busy}>
      <div className="rw-grab" />
      <div className="rw-sh-h">
        <div><h2 className="rw-sheet-title">Change password</h2><div className="rw-sd">{email}</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <form className="rw-card" onSubmit={e => { e.preventDefault(); change() }}>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="rw-flab rw-flab-0">Current password<input className="rw-field" type="password" autoComplete="current-password" value={cur} onChange={e => { setCur(e.target.value); setErr('') }} /></label>
        <label className="rw-flab">New password<input className="rw-field" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
        <label className="rw-flab">New password again<input className="rw-field" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></label>
        {err ? <div className="rw-wel-err" role="alert">{err}</div>
          : <div className={`rw-hint${short || mism ? ' rw-wel-warn' : ''}`}>{mism ? 'The two new passwords don’t match.' : `At least ${MIN_PASSWORD} characters.`}</div>}
      </form>
      <button type="button" className="rw-lnk" onClick={forgot}>Forgot your current password?</button>
      <div className="rw-ctas">
        <button type="button" className="rw-cta sec" onClick={onClose}>Cancel</button>
        <button type="button" className="rw-cta" disabled={busy || !cur || pw.length < MIN_PASSWORD || pw !== pw2} onClick={change}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </Sheet>
  )
}
