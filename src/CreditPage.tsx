import { useEffect, useState } from 'react'
import { useAccount } from './lib/AccountContext'
import { moneyFormatter, currencySymbol } from './lib/money'
import {
  createCreditAccount, updateCreditAccount,
  commitCreditStrategy, uncommitCreditStrategy,
  addCreditSnapshot, getCreditSnapshots,
} from './lib/repository'
import { loadForecast, projectFromRows } from './lib/forecast'
import {
  projectCreditPayoff, maxAffordableExtraCents, firstFloorBreach,
} from './engine/credit'
import type { CreditProjection } from './engine/credit'
import {
  creditModelFrom, buildMinimumDueSchedule, carriedCardBalance,
  committedPlanCheck, cycleDaysOf,
} from './lib/creditSchedule'
import { parseDate, formatDate, addDays } from './engine/dates'
import { useViewport } from './lib/useViewport'

/* ── formatting ───────────────────────────────────────────────────── */
function fmtDate(d: string) {
  return parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
}
function fmtDateLong(d: string) {
  return parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
}
// Never toISOString() — this app is UTC+12 and that has caused real bugs.
function todayStr() { return formatDate(new Date()) }

const CYCLES_AHEAD = 4
// The chart always spans this many cycles, whichever strategy is picked, so
// switching only redraws the line — the scale never moves under you.
const CHART_CYCLES = 60
const FORECAST_CYCLES = 24

type StrategyKey = 'minimum' | 'extra' | 'max'

export default function CreditPage({ accountId }: { userId: string; accountId: string }) {
  const { activeAccount } = useAccount()

  // Amounts follow the account's currency — see lib/money.ts
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const floorCents = activeAccount?.safety_floor_cents ?? 0
  // Desktop: what you owe and the payoff curve on the left; the strategy,
  // commit button and cycles ahead on the right. Same pieces as the phone.
  const isDesktop = useViewport() === 'desktop'

  const [card,      setCard]      = useState<any>(null)
  const [snapshots, setSnapshots] = useState<any[]>([])
  const [cycles,    setCycles]    = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [strategy, setStrategy] = useState<StrategyKey>('extra')
  const [extraStr, setExtraStr] = useState('0')
  const [saving,   setSaving]   = useState(false)

  // add-card form
  const [fName,  setFName]  = useState('Credit card')
  const [fBal,   setFBal]   = useState('')
  const [fApr,   setFApr]   = useState('21.9')
  const [fMin,   setFMin]   = useState('3')
  const [fSpend, setFSpend] = useState('0')
  const [fFreq,  setFFreq]  = useState<'per_cycle' | 'monthly'>('monthly')
  const [fDueDay, setFDueDay] = useState('15')
  const [formError, setFormError] = useState('')

  // update-balance sheet
  const [balOpen, setBalOpen] = useState(false)
  const [balStr,  setBalStr]  = useState('')

  // card settings sheet
  const [settingsOpen,  setSettingsOpen]  = useState(false)
  const [settingsError, setSettingsError] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        // The same forecast every other page uses. This page used to build its
        // own copy without savings goals, one-cycle amounts or logged spend,
        // so "Max available" was measured against money already promised
        // elsewhere — and disagreed with the Cycle screen.
        const forecast = await loadForecast(accountId, floorCents, { numCycles: FORECAST_CYCLES })
        const creditCard = forecast.creditCard
        setCard(creditCard)
        if (creditCard) {
          setSnapshots(await getCreditSnapshots(creditCard.id))
          const committedExtra = creditCard.strategy_extra_cents ?? 0
          setExtraStr(String(committedExtra / 100))
          // Open on the plan you committed to, so the page starts by showing it.
          setStrategy(creditCard.strategy_committed && committedExtra === 0 ? 'minimum' : 'extra')
        }

        // Projected WITHOUT the card: what each cycle closes with before any
        // card payment. Feeding it a projection that already contains card
        // payments would count them twice.
        setCycles(projectFromRows(
          { ...forecast, creditCard: null, creditOverrideRows: [] },
          floorCents, FORECAST_CYCLES
        ))
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [accountId, reloadKey])

  function reload() { setReloadKey(k => k + 1) }

  if (loading) return (
    <div className="scrollarea" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <p style={{ color:'var(--mut)' }}>Loading…</p>
    </div>
  )
  if (error) return (
    <div className="scrollarea" style={{ padding:24 }}>
      <p style={{ color:'var(--floor)' }}>{error}</p>
    </div>
  )

  /* ── no card yet ──────────────────────────────────────────────── */
  if (!card) {
    async function addCard() {
      const balCents   = Math.round(parseFloat(fBal || '0') * 100)
      const aprBps     = Math.round(parseFloat(fApr || '0') * 100)
      const minPct     = parseFloat(fMin || '0')
      const spendCents = Math.round(parseFloat(fSpend || '0') * 100)
      if (!fName.trim())              { setFormError('Give the card a name.'); return }
      if (!aprBps || minPct <= 0)     { setFormError('Rate and minimum payment are required.'); return }
      setSaving(true); setFormError('')
      try {
        await createCreditAccount(accountId, {
          name: fName.trim(),
          apr_basis_points: aprBps,
          min_payment_pct: minPct,
          min_payment_floor_cents: 1000,
          assumed_spend_cents: spendCents,
        }, balCents, todayStr())
        reload()
      } catch (e: any) { setFormError(e.message) }
      finally { setSaving(false) }
    }

    return (
      <div className="scrollarea">
        <div style={{ padding:'14px 20px 2px' }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--mut)' }}>Credit</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:22, letterSpacing:'-.02em', marginTop:4 }}>What you owe, and the way out</div>
        </div>

        <div className="credit-empty">
          <div className="ce-ic">▭</div>
          <div className="ce-t">No credit card yet</div>
          <div className="ce-d">
            Add one and Pocket Pilot works out the minimum due each cycle, models a payoff
            strategy, and folds it into your forecast. Nothing is committed until you choose
            a strategy.
          </div>
          <div className="ce-form">
            <div className="field">
              <label>Card name</label>
              <div className="inrow"><input type="text" value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. Visa" /></div>
            </div>
            <div className="field">
              <label>Current balance</label>
              <div className="inrow"><span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={fBal} onChange={e => setFBal(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div style={{ display:'flex', gap:9 }}>
              <div className="field" style={{ flex:1, minWidth:0 }}>
                <label>Rate p.a.</label>
                <div className="inrow"><input type="number" inputMode="decimal" value={fApr} onChange={e => setFApr(e.target.value)} /><span className="pre">%</span></div>
              </div>
              <div className="field" style={{ flex:1, minWidth:0 }}>
                <label>Min payment</label>
                <div className="inrow"><input type="number" inputMode="decimal" value={fMin} onChange={e => setFMin(e.target.value)} /><span className="pre">%</span></div>
              </div>
            </div>
            <div className="field" style={{ marginBottom:0 }}>
              <label>Assumed spend per cycle</label>
              <div className="inrow"><span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={fSpend} onChange={e => setFSpend(e.target.value)} placeholder="0" />
              </div>
              <div className="hint">What you expect to put on the card each cycle. Leave at $0 only if you've stopped using it — otherwise every payoff date here is optimistic.</div>
            </div>
            {formError && <p style={{ color:'var(--floor)', fontSize:13, marginTop:8 }}>{formError}</p>}
          </div>
        </div>

        <button className="credit-btn" onClick={addCard} disabled={saving}>
          {saving ? 'Adding…' : 'Add card →'}
        </button>
        <div className="credit-subact">saves the card and its first balance snapshot</div>
      </div>
    )
  }

  /* ── card exists ──────────────────────────────────────────────── */
  const model = creditModelFrom(card)
  const cycleDays = cycleDaysOf(cycles[0])
  const firstCycleStart = cycles[0]?.startDate ?? todayStr()
  const isMonthlyCard = (card.payment_frequency ?? 'per_cycle') === 'monthly'
    && !!card.payment_anchor_date
  // Which cycles carry a minimum, counted forward from the current one.
  const minimumDue = buildMinimumDueSchedule(card, firstCycleStart, cycleDays)

  // ── keeping the balance current ───────────────────────────────────
  // A measured balance is only true on the day it was taken, so it is carried
  // forward to the start of this cycle. Shared with the Cycle screen.
  const drift = carriedCardBalance(card, firstCycleStart, cycleDays)
  const balanceCents  = drift.balanceCents
  const measuredCents = drift.measuredCents
  const elapsedCycles = drift.elapsedCycles

  const surplusSeries = cycles.map(c => c.committedClosingBalanceCents)

  const extraCents = Math.max(0, Math.round(parseFloat(extraStr || '0') * 100))
  const maxExtraCents = maxAffordableExtraCents(balanceCents, model, cycleDays, surplusSeries, floorCents, minimumDue)

  const minProj: CreditProjection = projectCreditPayoff(balanceCents, model, 0, cycleDays, undefined, minimumDue)
  const extProj: CreditProjection = projectCreditPayoff(balanceCents, model, extraCents, cycleDays, undefined, minimumDue)
  const maxProj: CreditProjection = projectCreditPayoff(balanceCents, model, maxExtraCents, cycleDays, undefined, minimumDue)
  const active = strategy === 'minimum' ? minProj : strategy === 'max' ? maxProj : extProj
  const activeExtra = strategy === 'minimum' ? 0 : strategy === 'max' ? maxExtraCents : extraCents

  // ── what is committed, and does it still fit? ─────────────────────
  // Committing stores the extra as a number. The forecast keeps moving, so
  // the committed plan is checked against it every time this page loads.
  const committed = !!card.strategy_committed
  const committedExtra = card.strategy_extra_cents ?? 0
  const isCurrentPlan = committed && activeExtra === committedExtra
  const planCheck = committedPlanCheck(card, cycles, floorCents)
  // The plan on screen, if it is not the committed one.
  const previewBreach = isCurrentPlan
    ? null
    : firstFloorBreach(balanceCents, model, activeExtra, cycleDays, surplusSeries, floorCents, minimumDue)

  function planDesc(extra: number): string {
    return extra > 0 ? `minimum + ${fmt(extra, false)} a cycle` : 'minimum only'
  }
  function payoffDateStr(proj: CreditProjection): string {
    if (proj.neverClears || proj.cyclesToPayoff === null) return 'never'
    const d = addDays(parseDate(firstCycleStart), cycleDays * proj.cyclesToPayoff)
    return fmtDateLong(formatDate(d))
  }
  function payoffMonth(proj: CreditProjection): string {
    if (proj.neverClears || proj.cyclesToPayoff === null) return 'never'
    const d = addDays(parseDate(firstCycleStart), cycleDays * proj.cyclesToPayoff)
    return d.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })
  }
  function payoffLabel(proj: CreditProjection): string {
    if (proj.neverClears || proj.cyclesToPayoff === null) return 'balance grows — never paid off'
    const years = proj.cyclesToPayoff * cycleDays / 365
    return `${proj.cyclesToPayoff} cycles · ${years < 1 ? Math.round(years * 12) + ' months' : years.toFixed(1) + ' years'}`
  }

  // The difference is measured at the moment a balance is saved: what the app
  // had predicted for that day, against what was actually entered. It is stored
  // on the row so it stays true afterwards, instead of being recalculated
  // against a prediction that has since moved on.
  const lastSnap = snapshots[0]
  const projectedAtSnap = lastSnap?.projected_balance_cents ?? null
  const varianceCents = projectedAtSnap != null ? lastSnap.balance_cents - projectedAtSnap : null

  // Stale when the newest snapshot predates the current cycle.
  const currentCycleStart = cycles[0]?.startDate
  const isStale = !!(lastSnap && currentCycleStart && lastSnap.as_of_date < currentCycleStart)

  async function doCommit() {
    setSaving(true)
    try { await commitCreditStrategy(card.id, activeExtra); reload() }
    catch (e: any) { alert('Could not commit: ' + e.message) }
    finally { setSaving(false) }
  }
  async function doUncommit() {
    setSaving(true)
    try { await uncommitCreditStrategy(card.id); reload() }
    catch (e: any) { alert('Could not uncommit: ' + e.message) }
    finally { setSaving(false) }
  }
  async function saveBalance() {
    const cents = Math.round(parseFloat(balStr || '0') * 100)
    if (isNaN(cents) || cents < 0) return
    setSaving(true)
    try {
      // Save what the app predicted for today — the last measurement carried
      // forward, NOT the previous entry. Storing the previous entry is what made
      // this comparison meaningless before.
      await addCreditSnapshot(card.id, accountId, cents, todayStr(), 'manual', balanceCents)
      setBalOpen(false); reload()
    } catch (e: any) { alert('Could not update balance: ' + e.message) }
    finally { setSaving(false) }
  }
  function openSettings() {
    setFName(card.name)
    setFApr(String(card.apr_basis_points / 100))
    setFMin(String(Number(card.min_payment_pct)))
    setFSpend(String(card.assumed_spend_cents / 100))
    setFFreq(card.payment_frequency ?? 'per_cycle')
    setFDueDay(card.payment_anchor_date ? String(parseDate(card.payment_anchor_date).getDate()) : '15')
    setSettingsError('')
    setSettingsOpen(true)
  }

  async function saveSettings() {
    const aprBps     = Math.round(parseFloat(fApr || '0') * 100)
    const minPct     = parseFloat(fMin || '0')
    const spendCents = Math.max(0, Math.round(parseFloat(fSpend || '0') * 100))
    if (!fName.trim())          { setSettingsError('Give the card a name.'); return }
    if (!aprBps || minPct <= 0) { setSettingsError('Rate and minimum payment are required.'); return }
    setSaving(true); setSettingsError('')
    try {
      // Store the due date as a real date so it works with the same recurrence
      // code as every other expense. Only the day of the month matters.
      let anchor: string | null = null
      if (fFreq === 'monthly') {
        const day = Math.min(28, Math.max(1, parseInt(fDueDay || '1', 10)))
        const now = new Date()
        anchor = formatDate(new Date(now.getFullYear(), now.getMonth(), day))
      }

      await updateCreditAccount(card.id, {
        name: fName.trim(),
        apr_basis_points: aprBps,
        min_payment_pct: minPct,
        assumed_spend_cents: spendCents,
        payment_frequency: fFreq,
        payment_anchor_date: anchor,
      })
      setSettingsOpen(false); reload()
    } catch (e: any) { setSettingsError(e.message) }
    finally { setSaving(false) }
  }

  /* payoff curve — minimum-only baseline against the selected strategy.
     Always CHART_CYCLES wide, so the scale never changes between strategies. */
  function chartPath(proj: CreditProjection, w: number, h: number, maxBal: number, span: number) {
    const pts: string[] = []
    const series = [balanceCents, ...proj.lines.map(l => l.closingBalanceCents)].slice(0, span)
    series.forEach((b, i) => {
      const x = (i / Math.max(span - 1, 1)) * w
      const y = h - (Math.max(b, 0) / maxBal) * h
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    })
    return pts.join(' ')
  }
  const chartMax = Math.max(balanceCents, 1)
  const interestSaved = Math.max(minProj.totalInterestCents - active.totalInterestCents, 0)
  const thisCycle = active.lines[0]

  /* ── the pieces, in reading order ─────────────────────────────── */

  const balanceCard = (
    <div className="credit-bal">
      <div className="credit-bal-hdr">
        <div className="credit-bal-title">{card.name} · balance</div>
        <button className="credit-act" type="button"
          onClick={() => { setBalStr(String(balanceCents / 100)); setBalOpen(true) }}>update →</button>
      </div>
      <div className="credit-bal-amt">{fmt(balanceCents, false)}</div>
      <div className="credit-bal-sub">
        {lastSnap
          ? elapsedCycles > 0
            ? <>Projected · last measured <b>{fmt(measuredCents, false)}</b> on {fmtDate(lastSnap.as_of_date)}</>
            : <>Measured <b>{fmtDate(lastSnap.as_of_date)}</b>{card.assumed_spend_cents > 0 && <> · assuming {fmt(card.assumed_spend_cents, false)}/cycle new spend</>}</>
          : <>No balance recorded yet</>}
        {isStale && <span className="credit-stale">not measured this cycle</span>}
      </div>

      {elapsedCycles > 0 && (
        <div className="credit-var">
          Since {fmtDate(lastSnap.as_of_date)} this assumes {fmt(drift.interestCents, false)} interest
          {drift.paidCents > 0 && <> and {fmt(drift.paidCents, false)} paid</>}
          {drift.spentCents > 0 && <> and {fmt(drift.spentCents, false)} new spend</>}.
          {' '}<b>Update it</b> to replace the estimate with a real figure.
        </div>
      )}

      {varianceCents != null && (
        <div className={`credit-var${Math.abs(varianceCents) < 100 ? ' match' : ''}`}>
          {Math.abs(varianceCents) < 100
            ? <>Your last measured balance matched what was predicted.</>
            : <>
                On {fmtDate(lastSnap.as_of_date)} this predicted <b>{fmt(projectedAtSnap!, false)}</b> and the real
                balance was {fmt(lastSnap.balance_cents, false)} — {varianceCents > 0 ? 'more' : 'less'} owing
                than expected by {fmt(Math.abs(varianceCents), false)}.
                {varianceCents > 0 && card.assumed_spend_cents === 0 && <> Possibly new spending, which is currently assumed to be none.</>}
              </>}
        </div>
      )}

      <div className="credit-lines">
        <div className="credit-line">
          <div className="cl-dot" /><div className="cl-lbl">Minimum due this cycle</div>
          <div className="cl-val bad">{fmt(minProj.lines[0]?.minimumCents ?? 0, false)}</div>
        </div>
        <div className="credit-line">
          <div className="cl-dot" /><div className="cl-lbl">Interest this cycle</div>
          <div className="cl-val">{fmt(minProj.lines[0]?.interestCents ?? 0, false)}</div>
        </div>
        <div className="credit-line">
          <div className="cl-dot" style={{ background:'var(--mut)' }} />
          <div className="cl-lbl">Assumed new spend</div>
          <div className="cl-val">{card.assumed_spend_cents > 0 ? fmt(card.assumed_spend_cents, false) : 'none'}</div>
        </div>
      </div>

      <div className="credit-meta">
        <div className="cm-tx">
          <div className="cm-l">Card terms</div>
          <div className="cm-v">
            {(card.apr_basis_points / 100).toFixed(2)}% p.a. · minimum {Number(card.min_payment_pct)}% monthly
            {isMonthlyCard
              ? <> · due {parseDate(card.payment_anchor_date).getDate()}{'th'} of the month</>
              : <> · paid every cycle</>}
          </div>
        </div>
        <button className="credit-act" type="button" onClick={openSettings}>edit →</button>
      </div>
    </div>
  )

  // Pinned: the answer for whichever strategy is on screen. Fixed size, so
  // picking a different strategy changes the numbers, never the layout.
  const results = (
    <div className="credit-results">
      <div className="credit-res">
        <div className="l">Debt free</div>
        <div className="v">{payoffMonth(active)}</div>
        <div className="d">minimum only: {payoffMonth(minProj)}</div>
      </div>
      <div className="credit-res">
        <div className="l">Interest</div>
        <div className="v">{active.neverClears ? '—' : fmt(active.totalInterestCents, false)}</div>
        <div className="d">{interestSaved > 0 ? `${fmt(interestSaved, false)} less than minimum` : 'same as minimum'}</div>
      </div>
      <div className="credit-res">
        <div className="l">This cycle</div>
        <div className="v">{fmt(thisCycle?.paymentCents ?? 0, false)}</div>
        <div className="d">{isCurrentPlan ? 'your plan' : committed ? 'if you recommit' : 'if you commit'}</div>
      </div>
    </div>
  )

  const chart = (
    <div className="credit-chart-wrap">
      <div className="credit-chart-k">
        <span>Balance to zero · {CHART_CYCLES} cycles</span>
        <span>{active.neverClears ? 'balance grows' : payoffLabel(active)}</span>
      </div>
      <div className="credit-chart">
        <svg viewBox="0 0 320 74" preserveAspectRatio="none">
          <line x1="0" y1="74" x2="320" y2="74" stroke="var(--groundln)" strokeWidth="1" />
          <path className="base-ln"  d={chartPath(minProj, 320, 74, chartMax, CHART_CYCLES)} />
          <path className="strat-ln" d={chartPath(active,  320, 74, chartMax, CHART_CYCLES)} />
          {!active.neverClears && active.cyclesToPayoff !== null && active.cyclesToPayoff < CHART_CYCLES && (
            <circle className="zero-dot" r="3.5" cy="74"
              cx={(active.cyclesToPayoff / Math.max(CHART_CYCLES - 1, 1)) * 320} />
          )}
        </svg>
      </div>
      <div className="credit-chart-legend">
        <div className="cll"><div className="swatch" style={{ background:'var(--line)' }} />minimum only</div>
        <div className="cll"><div className="swatch" style={{ background:'var(--credit)' }} />this strategy</div>
      </div>
    </div>
  )

  // Always the same height whichever strategy is picked — the slider used to
  // appear and disappear here, which is what made the page jump.
  const optionBody = (
    <div className={`credit-optbody${active.neverClears ? ' bad' : ''}`}>
      {active.neverClears ? (
        <>At {fmt(card.assumed_spend_cents, false)} of new spend a cycle, this payment never gets ahead
          of interest — <b>the balance grows and the card never clears</b>.</>
      ) : strategy === 'extra' ? (
        <div className="credit-slider">
          <div className="credit-slider-top">
            <span className="l">Extra per cycle</span>
            <span className="v">{fmt(extraCents, false)}</span>
          </div>
          <input type="range" min={0} max={Math.max(maxExtraCents, 100)} step={500}
            value={Math.min(extraCents, Math.max(maxExtraCents, 100))}
            onChange={e => setExtraStr(String(parseInt(e.target.value, 10) / 100))} />
          <div className="credit-slider-ends">
            <span>$0</span>
            <span>{fmt(maxExtraCents, false)} · max that fits</span>
          </div>
        </div>
      ) : strategy === 'max' ? (
        <>The most you can pay <b>every</b> cycle without any cycle closing under
          your {fmt(floorCents, false)} floor: {fmt(maxExtraCents, false)} on top of the minimum. Saved as
          that amount when you commit — you'll be told if it stops fitting.</>
      ) : (
        <>Only what the card agreement asks. Clears {payoffDateStr(minProj)} and costs
          {' '}<b>{fmt(minProj.totalInterestCents, false)}</b> in interest
          — {Math.round(minProj.totalInterestCents / Math.max(balanceCents, 1) * 100)}% of what you owe.</>
      )}
    </div>
  )

  const strategyPicker = (
    <>
      <div className="section-hdr sh-crd">
        <span className="sh-label">Payoff strategy</span>
        <span className="sh-total">{payoffDateStr(active)}</span>
      </div>

      {floorCents === 0 && (
        <div className="skipnote" style={{ margin:'8px 16px 0' }}>
          Your safety floor is <b>$0</b>, so "max available" means draining every cycle to nothing.
          Set a floor in Settings before treating that number as a plan.
        </div>
      )}

      <div style={{ padding:'8px 16px 0' }}>
        <div className={`modeopt${strategy === 'minimum' ? ' sel' : ''}`} onClick={() => setStrategy('minimum')}>
          <div className="mi" style={{ background:'var(--floor-s)', color:'var(--floor)' }}>!</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div className="mt">Minimum only</div>
            <div className="ms">{payoffLabel(minProj)} · {fmt(minProj.totalInterestCents, false)} interest</div>
          </div>
          <div className="strat-amt">{fmt(minProj.lines[0]?.minimumCents ?? 0, false)}<small>falling</small></div>
        </div>

        <div className={`modeopt${strategy === 'extra' ? ' sel' : ''}`} onClick={() => setStrategy('extra')}>
          <div className="mi" style={{ background:'var(--credit-s)', color:'var(--credit)' }}>+</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div className="mt">Minimum + extra</div>
            <div className="ms">{payoffLabel(extProj)} · {fmt(extProj.totalInterestCents, false)} interest</div>
          </div>
          <div className="strat-amt">{fmt((extProj.lines[0]?.paymentCents ?? 0), false)}<small>min + {fmt(extraCents, false)}</small></div>
        </div>

        <div className={`modeopt${strategy === 'max' ? ' sel' : ''}`} onClick={() => setStrategy('max')}>
          <div className="mi" style={{ background:'var(--pos-s)', color:'var(--pos)' }}>▲</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div className="mt">Max available</div>
            <div className="ms">{payoffLabel(maxProj)} · {fmt(maxProj.totalInterestCents, false)} interest</div>
          </div>
          <div className="strat-amt">{fmt((maxProj.lines[0]?.paymentCents ?? 0), false)}<small>min + {fmt(maxExtraCents, false)}</small></div>
        </div>
      </div>

      {optionBody}
    </>
  )

  // Commit stays explicit: picking a strategy only previews it. When the
  // committed plan has stopped fitting the forecast, this is where it says so.
  const commitBlock = (
    <div className="credit-commit">
      {committed && planCheck?.breach && (
        <div className="pay-note bad credit-fitnote">
          <b>Your plan no longer fits.</b>{' '}
          {planCheck.minimumAloneBreaks
            ? <>Even the minimum alone takes the cycle starting {fmtDate(planCheck.breach.startDate)} under
                your {fmt(floorCents, false)} floor — your forecast is tight there before the card.</>
            : <>Since you committed ({planDesc(committedExtra)}), your forecast has changed: the cycle
                starting {fmtDate(planCheck.breach.startDate)} would close at {fmt(planCheck.breach.closingCents, false)},
                under your {fmt(floorCents, false)} floor. Up to {fmt(planCheck.maxExtraCents, false)} extra a cycle fits now.</>}
        </div>
      )}

      {isCurrentPlan ? (
        <>
          <div className="credit-plan">
            <span>✓ This is your plan</span>
            <button className="credit-act" type="button" style={{ color:'var(--floor)' }}
              onClick={doUncommit} disabled={saving}>uncommit</button>
          </div>
          <div className="credit-subact">
            {planDesc(committedExtra)}
            {!planCheck?.breach && planCheck && planCheck.maxExtraCents >= committedExtra + 5000
              && <> · up to {fmt(planCheck.maxExtraCents, false)} extra would still fit</>}
          </div>
        </>
      ) : (
        <>
          <button className="credit-btn" onClick={doCommit} disabled={saving}>
            {saving ? 'Saving…' : `${committed ? 'Recommit' : 'Commit'}: ${planDesc(activeExtra)} →`}
          </button>
          <div className="credit-subact">
            {previewBreach
              ? <span style={{ color:'var(--floor)' }}>
                  Careful: the cycle starting {cycles[previewBreach.index] ? fmtDate(cycles[previewBreach.index].startDate) : '—'} would
                  close at {fmt(previewBreach.closingCents, false)}, under your floor.
                </span>
              : committed
                ? <>currently committed: {planDesc(committedExtra)}</>
                : active.neverClears
                  ? 'adds a credit line to every cycle — balance still grows'
                  : `adds a credit line to the next ${active.cyclesToPayoff} cycles, ending ${payoffDateStr(active)}`}
          </div>
        </>
      )}
    </div>
  )

  const cyclesAhead = (
    <>
      <div className="section-hdr sh-crd">
        <span className="sh-label">Cycles ahead</span>
        <span className="sh-total">
          −{fmt(active.lines.slice(0, CYCLES_AHEAD).reduce((s, l) => s + l.paymentCents, 0), false)}
        </span>
      </div>
      <div className="credit-subact" style={{ textAlign:'left', padding:'0 18px 2px' }}>
        derived each cycle from the balance — not stored expenses
      </div>

      <div className="cards">
        {active.lines.slice(0, CYCLES_AHEAD).map((line, i) => {
          const pct = balanceCents > 0
            ? Math.min(100, Math.max(0, Math.round((1 - line.closingBalanceCents / balanceCents) * 100)))
            : 0
          const start = cycles[i]?.startDate
          return (
            <div key={i} className="card">
              <div className="ic crd">▭</div>
              <div className="tx">
                <div className="nm">
                  Credit payments
                  <span className="chip drv">derived</span>
                  {!isCurrentPlan && <span className="chip bl">preview</span>}
                </div>
                <div className="dt">
                  {start ? fmtDate(start) : `cycle ${i + 1}`} · min {fmt(line.minimumCents, false)}
                  {line.extraCents > 0 && <> + extra {fmt(line.extraCents, false)}</>}
                  {' · '}{fmt(line.closingBalanceCents, false)} left
                </div>
                <div className="act-row">
                  <div className="exp-prog" style={{ flex:1, marginTop:0 }}>
                    <div className="fill" style={{ width: pct + '%', background:'var(--credit)' }} />
                  </div>
                </div>
              </div>
              <div className="vl">−{fmt(line.paymentCents, false)}</div>
            </div>
          )
        })}
      </div>
    </>
  )

  return (
    <>
      <div className="scrollarea">

        <div style={{ padding:'14px 20px 2px' }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--mut)' }}>Credit</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:22, letterSpacing:'-.02em', marginTop:4 }}>What you owe, and the way out</div>
        </div>

        {/* Desktop: what you owe and how fast it falls on the left; the choice
            on the right. The phone reads the same pieces top to bottom. */}
        {isDesktop ? (
          <div className="dcr">
            <div className="dcr-col">{balanceCard}{results}{chart}</div>
            <div className="dcr-col">{strategyPicker}{commitBlock}{cyclesAhead}</div>
          </div>
        ) : (
          <>{balanceCard}{results}{chart}{strategyPicker}{commitBlock}{cyclesAhead}</>
        )}

        <div style={{ height:24 }} />

      </div>

      {/* ── update balance ── */}
      {balOpen && (
        <div className="ov" onClick={() => setBalOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setBalOpen(false)}>×</button>
            <div className="grab" />
            <h3>Update balance</h3>
            <p className="sd">
              Records a dated snapshot. Your forecast runs forward from the newest one, so this
              is how the projection stays honest between cycles.
            </p>
            <div className="field">
              <label>Balance today</label>
              <div className="inrow"><span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={balStr}
                  onChange={e => setBalStr(e.target.value)} placeholder="0" />
              </div>
              <div className="hint">
                {elapsedCycles > 0
                  ? <>Currently projecting {fmt(balanceCents, false)}, carried forward from the {fmt(measuredCents, false)} you measured on {fmtDate(lastSnap.as_of_date)}. Your real figure replaces the estimate.</>
                  : <>Currently holding {fmt(balanceCents, false)}.</>}
              </div>
            </div>
            <div className="navrow">
              <button onClick={() => setBalOpen(false)}>Cancel</button>
              <button className="pri" onClick={saveBalance} disabled={saving}>
                {saving ? 'Saving…' : 'Save balance'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── card settings ── */}
      {settingsOpen && (
        <div className="ov" onClick={() => setSettingsOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setSettingsOpen(false)}>×</button>
            <div className="grab" />
            <h3>Card settings</h3>
            <p className="sd">
              Changing the rate or minimum recalculates every projection on this page. If a
              strategy is committed, its credit line updates from the next cycle onward.
            </p>

            <div className="field">
              <label>Card name</label>
              <div className="inrow">
                <input type="text" value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. Visa" />
              </div>
            </div>

            <div className="field">
              <label>How you pay it</label>
              <div className="floor-presets">
                <button className={fFreq === 'monthly' ? 'on' : ''}
                  onClick={() => setFFreq('monthly')}>Monthly, on a due date</button>
                <button className={fFreq === 'per_cycle' ? 'on' : ''}
                  onClick={() => setFFreq('per_cycle')}>Every cycle</button>
              </div>
              <p className="hint">
                {fFreq === 'monthly'
                  ? 'One bill a month, so the minimum lands in some cycles and not others. This is how most cards work.'
                  : 'Assumes you pay something every cycle, sharing the monthly minimum across them.'}
              </p>
            </div>

            {fFreq === 'monthly' && (
              <div className="field">
                <label>Payment due day</label>
                <div className="inrow">
                  <input type="number" inputMode="numeric" min={1} max={28}
                    value={fDueDay} onChange={e => setFDueDay(e.target.value)} />
                  <span className="pre">of each month</span>
                </div>
                <p className="hint">
                  Capped at 28 so it falls in every month. If your real due date is later,
                  use 28 — the difference is at most a few days.
                </p>
              </div>
            )}

            <div style={{ display:'flex', gap:9 }}>
              <div className="field" style={{ flex:1, minWidth:0 }}>
                <label>Rate p.a.</label>
                <div className="inrow">
                  <input type="number" inputMode="decimal" step="0.1" value={fApr} onChange={e => setFApr(e.target.value)} />
                  <span className="pre">%</span>
                </div>
              </div>
              <div className="field" style={{ flex:1, minWidth:0 }}>
                <label>Min payment</label>
                <div className="inrow">
                  <input type="number" inputMode="decimal" step="0.5" value={fMin} onChange={e => setFMin(e.target.value)} />
                  <span className="pre">%</span>
                </div>
              </div>
            </div>
            <div className="hint" style={{ marginTop:-8, marginBottom:14 }}>
              Minimum is a monthly percentage of the balance. Pocket Pilot pro-rates it to your cycle length.
            </div>

            <div className="field">
              <label>Assumed spend per cycle</label>
              <div className="inrow">
                <span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={fSpend} onChange={e => setFSpend(e.target.value)} placeholder="0" />
              </div>
              <div className="hint">
                What you expect to put on the card each cycle. At $0 every payoff date here assumes
                you never use the card again.
              </div>
            </div>

            {settingsError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{settingsError}</p>}

            <div className="navrow">
              <button onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button className="pri" onClick={saveSettings} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
