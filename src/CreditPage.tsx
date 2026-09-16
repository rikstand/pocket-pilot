import { useEffect, useState } from 'react'
import { useAccount } from './lib/AccountContext'
import { moneyFormatter, currencySymbol } from './lib/money'
import {
  getIncomeSources, getExpenses, getCycles,
  getCreditAccount, createCreditAccount, updateCreditAccount,
  commitCreditStrategy, uncommitCreditStrategy,
  addCreditSnapshot, getCreditSnapshots,
} from './lib/repository'
import { projectCycles } from './engine/index'
import {
  projectCreditPayoff, maxAffordableExtraCents,
  projectBalanceForward, elapsedCyclesBetween,
} from './engine/credit'
import type { CreditAccountModel, CreditProjection } from './engine/credit'
import { parseDate, formatDate, addDays } from './engine/dates'
import { getOccurrencesInRange } from './engine/recurrence'

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
const CHART_CYCLES = 60

type StrategyKey = 'minimum' | 'extra' | 'max'

export default function CreditPage({ accountId }: { userId: string; accountId: string }) {
  const { activeAccount } = useAccount()

  // Amounts follow the account's currency — see lib/money.ts
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const floorCents = activeAccount?.safety_floor_cents ?? 0

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
        const [income, expenses, storedCycles, creditCard] = await Promise.all([
          getIncomeSources(accountId),
          getExpenses(accountId),
          getCycles(accountId),
          getCreditAccount(accountId),
        ])
        setCard(creditCard)
        if (creditCard) {
          setSnapshots(await getCreditSnapshots(creditCard.id))
          setExtraStr(String((creditCard.strategy_extra_cents ?? 0) / 100))
          if (creditCard.strategy_committed) setStrategy('extra')
        }

        const engineIncome = income.map((src: any) => {
          const v = (src.income_amount_versions ?? [])
            .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
          return {
            id: src.id, name: src.name, frequency: src.frequency,
            anchorDate: src.anchor_date, amountCents: v?.amount_cents ?? 0,
            isPotential: src.is_potential ?? false, isPrimary: src.is_primary ?? false,
          }
        })
        const engineExpenses = expenses.map((exp: any) => {
          const versions = (exp.expense_amount_versions ?? [])
            .map((v: any) => ({ amountCents: v.amount_cents, effectiveFrom: v.effective_from }))
          const latest = [...versions].sort((a: any, b: any) => a.effectiveFrom > b.effectiveFrom ? -1 : 1)[0]
          return {
            id: exp.id, name: exp.name, frequency: exp.frequency,
            anchorDate: exp.anchor_date, amountCents: latest?.amountCents ?? 0,
            amountVersions: versions, mode: exp.mode ?? 'fixed',
            endDate: exp.end_date ?? undefined,
          }
        })

        const openCycles  = storedCycles.filter((c: any) => !c.is_closed)
        const projectFrom = openCycles[0] ?? storedCycles[storedCycles.length - 1]

        // Projected WITHOUT the card. This is the surplus baseline the
        // affordability search measures against — feeding it a projection that
        // already contains card payments would double-count them.
        setCycles(projectCycles({
          incomeSources: engineIncome,
          expenses: engineExpenses,
          openingBalanceCents: projectFrom?.opening_balance_cents ?? 0,
          startDate: projectFrom?.start_date ?? todayStr(),
          numCycles: 24,
          safetyFloorCents: floorCents,
        }))
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
  const model: CreditAccountModel = {
    aprBasisPoints:       card.apr_basis_points,
    minPaymentPct:        Number(card.min_payment_pct),
    minPaymentFloorCents: card.min_payment_floor_cents,
    assumedSpendCents:    card.assumed_spend_cents,
    paymentFrequency:     card.payment_frequency ?? 'per_cycle',
  }
  const measuredCents = card.current_balance_cents ?? 0

  const cycleDays = cycles.length > 0
    ? Math.round((parseDate(cycles[0].endDate).getTime() - parseDate(cycles[0].startDate).getTime()) / 86400000) + 1
    : 14

  // ── which cycles actually carry a minimum ─────────────────────────
  // The payoff projection runs far beyond the cycles we have dates for, so
  // work each cycle's window out arithmetically and ask the same recurrence
  // code the engine uses. That keeps this page and the forecast in agreement
  // instead of quietly disagreeing past the horizon.
  const firstCycleStart = cycles[0]?.startDate ?? todayStr()
  const isMonthlyCard = (card.payment_frequency ?? 'per_cycle') === 'monthly'
    && !!card.payment_anchor_date

  // `offset` is counted from the current cycle and may be negative, because
  // catching up a stale balance walks through cycles that have already been.
  const dueInCycleOffset = (offset: number): boolean => {
    if (!isMonthlyCard) return true
    const start = addDays(parseDate(firstCycleStart), offset * cycleDays)
    const end   = addDays(start, cycleDays - 1)
    return getOccurrencesInRange(
      card.payment_anchor_date, 'monthly', formatDate(start), formatDate(end)
    ).length > 0
  }

  // Forward from now.
  const minimumDue = isMonthlyCard ? (i: number) => dueInCycleOffset(i) : undefined

  // ── keeping the balance current ───────────────────────────────────
  // A measured balance is only true on the day it was taken. Work out how many
  // cycles have passed since, then run the card forward that many cycles so the
  // figure shown matches what the forecast is already using.
  const elapsedCycles = card.balance_as_of && cycles[0]?.startDate
    ? elapsedCyclesBetween(
        parseDate(card.balance_as_of).getTime(),
        parseDate(cycles[0].startDate).getTime(),
        cycleDays
      )
    : 0

  // Catching up runs through PAST cycles, so step i here is
  // (elapsedCycles - i) cycles before the current one — not cycle i ahead of it.
  const minimumDueWhileCatchingUp = isMonthlyCard
    ? (i: number) => dueInCycleOffset(i - elapsedCycles)
    : undefined

  const drift = projectBalanceForward(
    measuredCents, model,
    card.strategy_committed ? card.strategy_extra_cents : 0,
    cycleDays, elapsedCycles, minimumDueWhileCatchingUp
  )
  const balanceCents = drift.balanceCents

  // Surplus baseline, card excluded — see the projection call above.
  const surplusSeries = cycles.map(c => c.committedClosingBalanceCents)

  const extraCents = Math.max(0, Math.round(parseFloat(extraStr || '0') * 100))
  const maxExtraCents = maxAffordableExtraCents(balanceCents, model, cycleDays, surplusSeries, floorCents, minimumDue)

  const minProj: CreditProjection = projectCreditPayoff(balanceCents, model, 0, cycleDays, undefined, minimumDue)
  const extProj: CreditProjection = projectCreditPayoff(balanceCents, model, extraCents, cycleDays, undefined, minimumDue)
  const maxProj: CreditProjection = projectCreditPayoff(balanceCents, model, maxExtraCents, cycleDays, undefined, minimumDue)
  const active = strategy === 'minimum' ? minProj : strategy === 'max' ? maxProj : extProj
  const activeExtra = strategy === 'minimum' ? 0 : strategy === 'max' ? maxExtraCents : extraCents

  function payoffDateStr(proj: CreditProjection): string {
    if (proj.neverClears || proj.cyclesToPayoff === null) return 'never'
    const d = addDays(parseDate(cycles[0]?.startDate ?? todayStr()), cycleDays * proj.cyclesToPayoff)
    return fmtDateLong(formatDate(d))
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

  /* payoff curve — minimum-only baseline against the selected strategy */
  function chartPath(proj: CreditProjection, w: number, h: number, maxBal: number, maxLen: number) {
    const pts: string[] = []
    const series = [balanceCents, ...proj.lines.map(l => l.closingBalanceCents)].slice(0, maxLen)
    series.forEach((b, i) => {
      const x = (i / Math.max(maxLen - 1, 1)) * w
      const y = h - (Math.max(b, 0) / maxBal) * h
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    })
    return pts.join(' ')
  }
  const chartLen = Math.min(
    Math.max(minProj.lines.length, active.lines.length) + 1,
    CHART_CYCLES
  )
  const chartMax = Math.max(balanceCents, 1)

  return (
    <>
      <div className="scrollarea">

        <div style={{ padding:'14px 20px 2px' }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, letterSpacing:'.18em', textTransform:'uppercase', color:'var(--mut)' }}>Credit</div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:22, letterSpacing:'-.02em', marginTop:4 }}>What you owe, and the way out</div>
        </div>

        {/* ── balance ── */}
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

        {/* ── strategy ── */}
        <div className="section-hdr sh-crd">
          <span className="sh-label">Payoff strategy</span>
          <span className="sh-total">{payoffDateStr(active)}</span>
        </div>

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

        {strategy === 'extra' && (
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
              <span>{fmt(maxExtraCents, false)} · max available</span>
            </div>
          </div>
        )}

        {floorCents === 0 && (
          <div className="skipnote" style={{ margin:'12px 16px 0' }}>
            Your safety floor is <b>$0</b>, so "max available" means draining every cycle to nothing.
            Set a floor in Settings before treating that number as a plan.
          </div>
        )}

        {/* ── payoff curve ── */}
        <div className="credit-chart-wrap">
          <div className="credit-chart-k">
            <span>Balance to zero</span>
            <span>{active.neverClears ? 'balance grows' : `${fmt(active.totalInterestCents, false)} interest`}</span>
          </div>
          <div className="credit-chart">
            <svg viewBox="0 0 320 74" preserveAspectRatio="none">
              <line x1="0" y1="74" x2="320" y2="74" stroke="var(--groundln)" strokeWidth="1" />
              <path className="base-ln"  d={chartPath(minProj, 320, 74, chartMax, chartLen)} />
              <path className="strat-ln" d={chartPath(active,  320, 74, chartMax, chartLen)} />
              {!active.neverClears && active.cyclesToPayoff !== null && active.cyclesToPayoff < chartLen && (
                <circle className="zero-dot" r="3.5" cy="74"
                  cx={(active.cyclesToPayoff / Math.max(chartLen - 1, 1)) * 320} />
              )}
            </svg>
          </div>
          <div className="credit-chart-legend">
            <div className="cll"><div className="swatch" style={{ background:'var(--line)' }} />minimum only</div>
            <div className="cll"><div className="swatch" style={{ background:'var(--credit)' }} />this strategy</div>
          </div>
        </div>

        {active.neverClears ? (
          <div className="skipnote" style={{ margin:'12px 16px 0', borderLeft:'2px solid var(--floor)', color:'var(--floor)' }}>
            At {fmt(card.assumed_spend_cents, false)} of new spend a cycle, this payment never gets
            ahead of interest — <b>the balance grows and the card never clears</b>. You can still
            commit it, but nothing here pays it off.
          </div>
        ) : (
          <div className="skipnote" style={{ margin:'12px 16px 0' }}>
            {strategy === 'minimum'
              ? <>Minimum only runs to <b>{payoffDateStr(minProj)}</b> and costs {fmt(minProj.totalInterestCents, false)} in interest — {Math.round(minProj.totalInterestCents / Math.max(balanceCents, 1) * 100)}% of what you owe.</>
              : <>Clears <b>{Math.max((minProj.cyclesToPayoff ?? 0) - (active.cyclesToPayoff ?? 0), 0)} cycles sooner</b> than the minimum and saves {fmt(Math.max(minProj.totalInterestCents - active.totalInterestCents, 0), false)} in interest.</>}
          </div>
        )}

        {card.strategy_committed ? (
          <>
            <button className="credit-btn" onClick={doCommit} disabled={saving}>
              {saving ? 'Updating…' : 'Update committed strategy →'}
            </button>
            <div className="credit-subact">
              committed {fmt(card.strategy_extra_cents, false)}/cycle extra ·{' '}
              <button className="credit-act" type="button"
                style={{ color:'var(--floor)' }} onClick={doUncommit}>uncommit</button>
            </div>
          </>
        ) : (
          <>
            <button className="credit-btn" onClick={doCommit} disabled={saving}>
              {saving ? 'Committing…' : 'Commit strategy →'}
            </button>
            <div className="credit-subact">
              {active.neverClears
                ? 'adds a credit line to every cycle — balance still grows'
                : `adds a credit line to the next ${active.cyclesToPayoff} cycles, ending ${payoffDateStr(active)}`}
            </div>
          </>
        )}

        {/* ── cycles ahead ── */}
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
                    {!card.strategy_committed && <span className="chip bl">not committed</span>}
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
