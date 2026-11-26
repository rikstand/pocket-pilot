import { useEffect, useState, type ReactNode } from 'react'
import {
  signInWithEmail, signUpWithEmail, sendPasswordReset, setPassword, rememberedEmail, forgetEmail, rememberEmail,
  authMessage, MIN_PASSWORD,
} from '../lib/auth'

/**
 * The welcome screen (agreed 26 Nov 2026, design system › Brand mark): the 10 Nov
 * mark, "Pocket Pilot", a smaller line under it, and a dot grid with the mint
 * runway behind. Sign in, create account, forgotten password, a new password and
 * loading all use this one stage, so moving between them only changes the middle.
 */
const MARK = '12,58 25,49 38,54 50,38 62,45 71,67 81,60 88,46'
const RUNWAY = '-20,600 40,585 95,622 150,560 205,592 250,684 306,640 400,570'

function Mark({ loop }: { loop: boolean }) {
  return (
    <svg className="rw-wel-mark" width={72} height={72} viewBox="0 0 100 100" role="img" aria-label={loop ? 'Loading' : 'Pocket Pilot'}>
      <line x1="10" y1="76" x2="90" y2="76" className="rw-wel-floor" strokeWidth="2.5" strokeDasharray="4 4" />
      <polyline className={`rw-wel-ink ${loop ? 'rw-wel-loop' : 'rw-wel-draw'}`} pathLength={100} points={MARK} fill="none"
        strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle className={`rw-wel-dot ${loop ? 'rw-wel-loopdot' : 'rw-wel-pop'}`} cx="88" cy="46" r="6" />
    </svg>
  )
}

/** The stage. `loading` swaps the line for "Working out your runway…" and loops the mark;
 *  the background then stays still, so a sign-in hands over without anything redrawing. */
export function Stage({ line, loading = false, children }: { line?: ReactNode; loading?: boolean; children?: ReactNode }) {
  return (
    <div className={`app rw rw-app rw-wel${loading ? ' still' : ''}`}>
      <main className="rw-main">
        <svg className="rw-wel-bg" viewBox="0 0 375 780" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          <defs>
            <pattern id="rw-wel-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="9" cy="9" r="1.3" className="rw-wel-grid" /></pattern>
            <linearGradient id="rw-wel-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.3" stopColor="#fff" stopOpacity="0" /><stop offset="0.62" stopColor="#fff" stopOpacity="1" /></linearGradient>
            <mask id="rw-wel-mask"><rect width="375" height="780" fill="url(#rw-wel-fade)" /></mask>
            <linearGradient id="rw-wel-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="rw-wel-a0" /><stop offset="1" className="rw-wel-a1" /></linearGradient>
            <filter id="rw-wel-glow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
          </defs>
          <rect width="375" height="780" fill="url(#rw-wel-dots)" mask="url(#rw-wel-mask)" />
          <polygon points={`${RUNWAY} 400,780 -20,780`} fill="url(#rw-wel-area)" className="rw-wel-fill" />
          <polyline points={RUNWAY} fill="none" className="rw-wel-glow" strokeWidth="14" filter="url(#rw-wel-glow)" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={RUNWAY} fill="none" className="rw-wel-line rw-wel-draw" pathLength={100} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="306" cy="640" r="15" className="rw-wel-halo rw-wel-pop" />
          <circle cx="306" cy="640" r="8.5" className="rw-wel-dot rw-wel-ring rw-wel-pop" />
        </svg>
        <div className="rw-wel-fg">
          <div className="rw-wel-brand">
            <Mark loop={loading} />
            <div className="rw-wel-name">Pocket Pilot</div>
            {loading
              ? <div className="rw-wel-sub rw-wel-wait" role="status">Working out your runway…</div>
              : line && <h1 className="rw-wel-sub">{line}</h1>}
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

/** Loading stays minimal: nothing for the first 0.4 seconds, so a quick load never
 *  flashes the loader; after that, the welcome stage with the mark drawing. */
export function LoadingStage() {
  const [show, setShow] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShow(true), 400); return () => clearTimeout(t) }, [])
  return show ? <Stage loading /> : <div className="app rw rw-app" aria-busy="true" />
}

/** Inside the app (a page's first load): the mark alone, drawing, after the same 0.4 seconds. */
export function LoadingMark() {
  const [show, setShow] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShow(true), 400); return () => clearTimeout(t) }, [])
  return <div className="rw rw-wel-inline" aria-busy="true">{show && <Mark loop />}</div>
}

type Step = 'in' | 'up' | 'checkUp' | 'forgot' | 'checkReset' | 'reset'

/** Sign in, create an account, forgotten password; `recovery` is the email link's "Set a new password". */
export default function Welcome({ recovery = false, recoveryEmail, onRecovered }: {
  recovery?: boolean; recoveryEmail?: string | null; onRecovered?: () => void
}) {
  const [step, setStep] = useState<Step>(recovery ? 'reset' : 'in')
  const [known, setKnown] = useState<string | null>(rememberedEmail)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState('')
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { if (recovery) setStep('reset') }, [recovery])

  const go = (s: Step) => { setStep(s); setErr(''); setPw(''); setPw2('') }
  const remembered = step === 'in' && !!known
  const who = (remembered ? known : email.trim()) || ''
  const short = pw.length > 0 && pw.length < MIN_PASSWORD
  async function run(f: () => Promise<void>) {
    setBusy(true); setErr('')
    try { await f() } catch (e) { setErr(authMessage(e)) } finally { setBusy(false) }
  }

  const emailField = (
    <label className="rw-flab">Email
      <input className="rw-field" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
        value={email} onChange={e => { setEmail(e.target.value); setErr('') }} />
    </label>
  )
  const error = err && <div className="rw-wel-err" role="alert">{err}</div>

  let line: ReactNode = 'Welcome back', body: ReactNode
  if (step === 'in') body = <>
    {remembered && (
      <div className="rw-group rw-wel-who">
        <div className="rw-row static">
          <span className="rw-dot rw-acct rw-acct-5" aria-hidden="true">{known!.charAt(0).toUpperCase()}</span>
          <div className="rw-tx"><div className="rw-row-name">{known}</div><div className="rw-sub">Last signed in on this phone</div></div>
          <button type="button" className="rw-lnk rw-wel-notyou" onClick={() => { forgetEmail(); setKnown(null); go('in') }}>Not you?</button>
        </div>
      </div>
    )}
    <form className="rw-wel-form" onSubmit={e => { e.preventDefault(); run(async () => { await signInWithEmail(who, pw) }) }}>
      {!remembered && emailField}
      {/* The email the phone remembered, for the password manager. */}
      {remembered && <input type="email" autoComplete="username" value={known!} readOnly hidden />}
      <label className="rw-flab">Password
        <input className="rw-field" type="password" autoComplete="current-password" value={pw} onChange={e => { setPw(e.target.value); setErr('') }} />
      </label>
      {error}
      <button type="submit" className="rw-cta rw-wel-full" disabled={busy || !who || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" className="rw-lnk" onClick={() => { if (remembered) setEmail(known!); go('forgot') }}>Forgot password?</button>
      <div className="rw-wel-alt">New here? <button type="button" onClick={() => { setEmail(''); go('up') }}>Create an account</button></div>
    </form>
  </>
  else if (step === 'up') { line = 'Start your runway'; body = (
    <form className="rw-wel-form" onSubmit={e => { e.preventDefault(); run(async () => {
      const r = await signUpWithEmail(email.trim(), pw)
      // With email confirmation on there's no session yet: they open the link first.
      if (!r.session) go('checkUp')
    }) }}>
      <p className="rw-wel-p">Set up your first runway in a few steps.</p>
      {emailField}
      <label className="rw-flab">Password
        <input className="rw-field" type="password" autoComplete="new-password" value={pw} onChange={e => { setPw(e.target.value); setErr('') }} />
      </label>
      {error || <div className={`rw-hint${short ? ' rw-wel-warn' : ''}`}>At least {MIN_PASSWORD} characters.</div>}
      <button type="submit" className="rw-cta rw-wel-full" disabled={busy || !email.trim() || pw.length < MIN_PASSWORD}>{busy ? 'Creating…' : 'Create account'}</button>
      <div className="rw-wel-alt">Have an account? <button type="button" onClick={() => go('in')}>Sign in</button></div>
    </form>
  ) }
  else if (step === 'forgot') { line = 'Reset your password'; body = (
    <form className="rw-wel-form" onSubmit={e => { e.preventDefault(); run(async () => { await sendPasswordReset(email.trim()); rememberEmail(email.trim()); go('checkReset') }) }}>
      <p className="rw-wel-p">We’ll email you a link to set a new one.</p>
      {emailField}
      {error}
      <button type="submit" className="rw-cta rw-wel-full" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send the link'}</button>
      <div className="rw-wel-alt"><button type="button" onClick={() => go('in')}>Back to sign in</button></div>
    </form>
  ) }
  else if (step === 'checkUp' || step === 'checkReset') { line = 'Check your email'; body = (
    <div className="rw-wel-form">
      <p className="rw-wel-p">We sent a link to <b>{email.trim()}</b>. Open it on this phone to {step === 'checkReset' ? 'set a new password' : 'finish'}.</p>
      {error}
      <button type="button" className="rw-cta sec rw-wel-full" onClick={() => { setKnown(rememberedEmail()); go('in') }}>Back to sign in</button>
      <div className="rw-wel-alt">Nothing there? Check spam, or <button type="button" disabled={busy}
        onClick={() => run(async () => { if (step === 'checkReset') await sendPasswordReset(email.trim()); else go('up') })}>send it again</button></div>
    </div>
  ) }
  else { line = 'Set a new password'; body = (
    <form className="rw-wel-form" onSubmit={e => { e.preventDefault(); run(async () => { await setPassword(pw); onRecovered?.() }) }}>
      {recoveryEmail && <p className="rw-wel-p">For {recoveryEmail}</p>}
      {recoveryEmail && <input type="email" autoComplete="username" value={recoveryEmail} readOnly hidden />}
      <label className="rw-flab">New password
        <input className="rw-field" type="password" autoComplete="new-password" value={pw} onChange={e => { setPw(e.target.value); setErr('') }} />
      </label>
      <label className="rw-flab">New password again
        <input className="rw-field" type="password" autoComplete="new-password" value={pw2} onChange={e => { setPw2(e.target.value); setErr('') }} />
      </label>
      {error || <div className={`rw-hint${short || (pw2 && pw2 !== pw) ? ' rw-wel-warn' : ''}`}>{pw2 && pw2 !== pw ? 'The two don’t match.' : `At least ${MIN_PASSWORD} characters.`}</div>}
      <button type="submit" className="rw-cta rw-wel-full" disabled={busy || pw.length < MIN_PASSWORD || pw !== pw2}>{busy ? 'Saving…' : 'Save and sign in'}</button>
    </form>
  ) }

  return <Stage line={line}>{body}</Stage>
}
