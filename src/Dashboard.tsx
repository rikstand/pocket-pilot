import { useEffect, useState, useRef } from 'react'
import { supabase } from './lib/supabase'
import { getIncomeSources, getExpenses, getCycles, getProfile } from './lib/repository'
import { projectCycles } from './engine/index'
import { getOccurrencesInRange } from './engine/recurrence'

function fmt(cents: number, showCents = true) {
  const abs = Math.abs(cents)
  const n = abs / 100
  const str = showCents
    ? n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return (cents < 0 ? '−' : '') + '$' + str
}
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
}
function daysUntil(dateStr: string) {
  const now = new Date(); now.setHours(0,0,0,0)
  return Math.max(0, Math.round((new Date(dateStr + 'T00:00:00').getTime() - now.getTime()) / 86400000))
}
function today() { return new Date().toISOString().split('T')[0] }
function findCurrentIdx(cycles: any[]) {
  const t = today()
  const idx = cycles.findIndex(c => c.startDate <= t && c.endDate >= t)
  return idx >= 0 ? idx : 0
}
// Add one day to a YYYY-MM-DD string — used to compute revert date when on last cycle
function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}
// Pick latest amount version effective on or before cycleStart
function versionForCycle(versions: any[], cycleStart: string): any {
  const all = versions ?? []
  const applicable = all
    .filter((v: any) => v.effective_from <= cycleStart)
    .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)
  if (applicable.length > 0) return applicable[0]
  // Fallback: use earliest version if none are effective yet for this cycle
  return [...all].sort((a: any, b: any) => a.effective_from < b.effective_from ? -1 : 1)[0]
}

export default function Dashboard({ userId, onNavigate }: { userId: string, onNavigate: (page: any) => void }) {
  const [cycles,      setCycles]      = useState<any[]>([])
  const [rawExpenses, setRawExpenses] = useState<any[]>([])
  const [rawIncome,   setRawIncome]   = useState<any[]>([])
  const [profile,     setProfile]     = useState<any>(null)
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [darkMode,    setDarkMode]    = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')
  const [error,       setError]       = useState('')
  const [loading,     setLoading]     = useState(true)
  const [reloadKey,   setReloadKey]   = useState(0)
  const pillsRef = useRef<HTMLDivElement>(null)

  // ── overlay state ──────────────────────────────────────────────────
  const [editCard,   setEditCard]   = useState<any>(null)
  const [editScope,  setEditScope]  = useState<'occurrence' | 'forward' | null>(null)
  const [editStep,   setEditStep]   = useState(0)
  const [editAmount, setEditAmount] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError,  setEditError]  = useState('')

  const [varCard,   setVarCard]   = useState<any>(null)
  const [varAmount, setVarAmount] = useState('')
  const [varSaving, setVarSaving] = useState(false)
  const [varError,  setVarError]  = useState('')

  const [closeOpen,          setCloseOpen]          = useState(false)
  const [closeStep,          setCloseStep]          = useState(0)
  const [closeVarActuals,    setCloseVarActuals]    = useState<Record<string, string>>({})
  const [closeIncomeActuals, setCloseIncomeActuals] = useState<Record<string, string>>({})
  const [closeRealBalance,   setCloseRealBalance]   = useState('')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  // Reload whenever userId changes or reloadKey is bumped (after overlay saves)
  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [prof, income, expenses, storedCycles] = await Promise.all([
          getProfile(userId), getIncomeSources(userId), getExpenses(userId), getCycles(userId),
        ])
        setProfile(prof); setRawIncome(income); setRawExpenses(expenses)

        const engineIncome = income.map((src: any) => {
          const v = (src.income_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
          return {
            id: src.id, name: src.name, frequency: src.frequency,
            anchorDate: src.anchor_date,
            amountCents: v?.amount_cents ?? 0,
            isPotential: src.is_potential ?? false,
          }
        })

        // Pass ALL amount versions so the engine can select per-cycle
        const engineExpenses = expenses.map((exp: any) => {
          const versions = (exp.expense_amount_versions ?? []).map((v: any) => ({
            amountCents: v.amount_cents,
            effectiveFrom: v.effective_from,
          }))
          const latest = versions.sort((a: any, b: any) => a.effectiveFrom > b.effectiveFrom ? -1 : 1)[0]
          return {
            id: exp.id, name: exp.name, frequency: exp.frequency,
            anchorDate: exp.anchor_date,
            amountCents: latest?.amountCents ?? 0,
            amountVersions: versions,
            mode: exp.mode ?? 'fixed',
          }
        })

        const latestCycle = storedCycles[storedCycles.length - 1]
        const projected = projectCycles({
          incomeSources: engineIncome,
          expenses: engineExpenses,
          openingBalanceCents: latestCycle?.opening_balance_cents ?? 0,
          startDate: latestCycle?.start_date ?? today(),
          numCycles: 6,
          safetyFloorCents: prof?.safety_floor_cents ?? 0,
        })
        setCycles(projected)
        setActiveIdx(findCurrentIdx(projected))
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [userId, reloadKey])

  useEffect(() => {
    if (pillsRef.current) {
      const btn = pillsRef.current.children[activeIdx] as HTMLElement
      btn?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  }, [activeIdx])

  if (loading) return <div className="app" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh' }}><p style={{ color:'var(--mut)' }}>Loading…</p></div>
  if (error)      return <div className="app" style={{ padding:24 }}><p style={{ color:'var(--floor)' }}>{error}</p></div>
  if (!cycles.length) return <div className="app" style={{ padding:24 }}><p style={{ color:'var(--mut)' }}>No cycle data.</p></div>

  const activeCycle  = cycles[activeIdx]
  const floorCents   = profile?.safety_floor_cents ?? 0
  const currentIdx   = findCurrentIdx(cycles)
  const openingCents = cycles[0]?.openingBalanceCents ?? 0

  function reload() { setReloadKey(k => k + 1) }

  // next pay
  const primaryIncome = rawIncome.find((s: any) => s.is_primary && !s.is_potential)
  let nextPayStr = ''
  if (primaryIncome) {
    const future = new Date(); future.setDate(future.getDate() + 60)
    const occs = getOccurrencesInRange(primaryIncome.anchor_date, primaryIncome.frequency, today(), future.toISOString().split('T')[0])
    if (occs.length) {
      const d = daysUntil(occs[0])
      nextPayStr = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
    }
  }

  // graph
  const closeVals    = cycles.map(c => c.committedClosingBalanceCents / 100)
  const floorDollars = floorCents / 100
  const maxVal       = Math.max(...closeVals, floorDollars) * 1.15
  const gTop = 18, gBot = 132, gH = gBot - gTop
  const xPad = 16, xRange = 320 - 2 * xPad
  const xs   = closeVals.map((_: any, i: number) => xPad + i * xRange / (closeVals.length - 1))
  const yFor = (v: number) => gTop + (maxVal - v) * gH / maxVal
  const pts  = closeVals.map((v: number, i: number) => [xs[i], yFor(v)])
  const fY   = yFor(floorDollars)
  const splitIdx   = currentIdx >= 0 ? currentIdx : 0
  const monthStart = fmtDate(cycles[0].startDate).split(' ')[1]
  const monthEnd   = fmtDate(cycles[cycles.length - 1].endDate).split(' ')[1]

  function cycleStatus(i: number) {
    const t = today(), c = cycles[i]
    if (c.endDate < t) return 'past'
    if (c.startDate <= t && c.endDate >= t) return 'now'
    if (floorCents > 0 && c.committedClosingBalanceCents - floorCents < floorCents * 0.5) return 'low'
    return 'future'
  }

  function buildCards() {
    const cards: any[] = []
    const cycle = activeCycle

    for (const src of rawIncome) {
      const occs = getOccurrencesInRange(src.anchor_date, src.frequency, cycle.startDate, cycle.endDate)
      if (!occs.length) continue
      const v = (src.income_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
      const unitCents = v?.amount_cents ?? 0
      cards.push({
        name: src.name, icon: '↓',
        iconClass: src.is_potential ? 'pot' : 'inc',
        chips: src.is_potential ? [['pt','potential']] : [['lock','fixed']],
        detail: occs.length === 1 ? `${fmtDate(occs[0])} · ${src.frequency}` : occs.map((o: string) => fmtDate(o)).join(', '),
        value: fmt(unitCents * occs.length, false),
        valueClass: src.is_potential ? 'pot' : 'pos',
        ghost: src.is_potential, dashed: false, act: null,
        expenseId: null, unitCents: 0, originalUnitCents: 0,
      })
    }

    for (const exp of rawExpenses) {
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, cycle.startDate, cycle.endDate)
      if (!occs.length) continue

      // Use cycle-aware version selection so edit/confirm amounts are consistent
      const v        = versionForCycle(exp.expense_amount_versions, cycle.startDate)
      const unitCents = v?.amount_cents ?? 0
      const total     = unitCents * occs.length
      const mode      = exp.mode ?? 'fixed'

      let icon = '▤', iconClass = 'fix', chips: string[][] = [['lock','fixed']], act: string | null = null
      if (mode === 'variable') { icon = '~'; iconClass = 'var'; chips = [['est','estimate']]; act = 'var' }
      else if (mode === 'budget') { icon = '≈'; iconClass = 'base'; chips = [['bl','baseline']] }
      else { act = 'edit' }

      let detail = ''
      if (mode === 'variable') {
        detail = '~ typical ' + exp.frequency.replace('ly','')
      } else if (mode === 'budget') {
        detail = `${fmt(unitCents,false)}/${exp.frequency==='weekly'?'wk':exp.frequency==='fortnightly'?'fn':'mo'}` + (occs.length > 1 ? ` × ${occs.length}` : '')
      } else {
        detail = occs.length === 1 ? `${fmtDate(occs[0])} · ${exp.frequency}` : occs.map((o: string) => fmtDate(o)).join(', ')
        if (exp.category) detail += ' · ' + exp.category
      }

      cards.push({
        name: exp.name, icon, iconClass, chips, detail,
        value: '−' + fmt(total, false), valueClass: '',
        ghost: false, dashed: mode === 'variable', act,
        expenseId: exp.id,
        unitCents,           // current per-occurrence amount for this cycle
        originalUnitCents: unitCents,  // what to revert to after a one-off override
        estimatedCents: unitCents,
      })
    }
    return cards
  }

  // close ritual data
  const varExpensesInCycle = rawExpenses
    .filter(e => e.mode === 'variable')
    .map(exp => {
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, activeCycle.startDate, activeCycle.endDate)
      if (!occs.length) return null
      const v = versionForCycle(exp.expense_amount_versions, activeCycle.startDate)
      return { id: exp.id, name: exp.name, estimatedCents: (v?.amount_cents ?? 0) * occs.length }
    })
    .filter(Boolean) as { id: string, name: string, estimatedCents: number }[]

  const incomeInCycle = rawIncome
    .filter(s => !s.is_potential)
    .map(src => {
      const occs = getOccurrencesInRange(src.anchor_date, src.frequency, activeCycle.startDate, activeCycle.endDate)
      if (!occs.length) return null
      const v = (src.income_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
      return { id: src.id, name: src.name, expectedCents: (v?.amount_cents ?? 0) * occs.length }
    })
    .filter(Boolean) as { id: string, name: string, expectedCents: number }[]

  const confirmedVarTotalCents = varExpensesInCycle.reduce((sum, e) =>
    sum + Math.round(parseFloat(closeVarActuals[e.id] || '0') * 100), 0)
  const closeRealCents   = Math.round(parseFloat(closeRealBalance || '0') * 100)
  const unaccountedCents = closeRealCents > 0 ? closeRealCents - activeCycle.committedClosingBalanceCents : 0

  // ── overlay handlers ──────────────────────────────────────────────
  function openEdit(cd: any) {
    setEditCard(cd); setEditScope(null); setEditStep(0)
    setEditAmount(cd.unitCents ? String(cd.unitCents / 100) : '')
    setEditError('')
  }
  function openVar(cd: any) {
    setVarCard(cd)
    setVarAmount(cd.estimatedCents ? String(cd.estimatedCents / 100) : '')
    setVarError('')
  }
  function openClose() {
    const initVars: Record<string, string>   = {}
    const initIncome: Record<string, string> = {}
    for (const e of varExpensesInCycle) initVars[e.id]   = String(e.estimatedCents / 100)
    for (const s of incomeInCycle)      initIncome[s.id] = String(s.expectedCents / 100)
    setCloseVarActuals(initVars); setCloseIncomeActuals(initIncome)
    setCloseRealBalance(''); setCloseStep(0); setCloseOpen(true)
  }

  // ── SAVE: edit scope overlay ──────────────────────────────────────
  async function applyEdit() {
    if (!editScope || !editAmountCents) return
    setEditSaving(true); setEditError('')
    try {
      // Insert new version for this cycle
      const { error: e1 } = await supabase.from('expense_amount_versions').insert({
        expense_id: editCard.expenseId,
        amount_cents: editAmountCents,
        effective_from: activeCycle.startDate,
      })
      if (e1) throw e1

      if (editScope === 'occurrence') {
        // Revert to original at next cycle start
        const nextStart = cycles[activeIdx + 1]?.startDate ?? addOneDay(activeCycle.endDate)
        const { error: e2 } = await supabase.from('expense_amount_versions').insert({
          expense_id: editCard.expenseId,
          amount_cents: editCard.originalUnitCents,
          effective_from: nextStart,
        })
        if (e2) throw e2
      }

      setEditCard(null); reload()
    } catch (e: any) { setEditError(e.message) }
    finally { setEditSaving(false) }
  }

  // ── SAVE: confirm variable overlay ───────────────────────────────
  async function applyConfirm() {
    if (!varAmountCents) return
    setVarSaving(true); setVarError('')
    try {
      // Lock in actual for this cycle
      const { error: e1 } = await supabase.from('expense_amount_versions').insert({
        expense_id: varCard.expenseId,
        amount_cents: varAmountCents,
        effective_from: activeCycle.startDate,
      })
      if (e1) throw e1

      // Revert to estimate at next cycle start
      const nextStart = cycles[activeIdx + 1]?.startDate ?? addOneDay(activeCycle.endDate)
      const { error: e2 } = await supabase.from('expense_amount_versions').insert({
        expense_id: varCard.expenseId,
        amount_cents: varCard.originalUnitCents,
        effective_from: nextStart,
      })
      if (e2) throw e2

      setVarCard(null); reload()
    } catch (e: any) { setVarError(e.message) }
    finally { setVarSaving(false) }
  }

  const cards        = buildCards()
  const aboveFloor   = activeCycle.committedClosingBalanceCents - floorCents
  const status       = cycleStatus(activeIdx)
  const heroDollars  = Math.floor(openingCents / 100)
  const heroCentsVal = Math.abs(openingCents % 100)
  const editAmountCents = Math.round(parseFloat(editAmount || '0') * 100)
  const varAmountCents  = Math.round(parseFloat(varAmount  || '0') * 100)

  // ── render ────────────────────────────────────────────────────────
  return (
    <div className="app">

      <div className="appbar">
        <div className="nm">Pocket<b>Pilot</b></div>
        <button className="tgl" onClick={() => setDarkMode(!darkMode)}>
          <span>{darkMode ? '☀' : '☾'}</span>
          <span className="lab">{darkMode ? 'LIGHT' : 'DARK'}</span>
        </button>
      </div>

      <div className="scrollarea">

        <div className="hero">
          <div className="k">Balance today · {fmtDate(today())}</div>
          <div className="bal">${heroDollars.toLocaleString()}<small>.{String(heroCentsVal).padStart(2,'0')}</small></div>
          <div className="sub">
            {nextPayStr && <>Next pay <b>{nextPayStr}</b> · </>}
            {floorCents > 0 && <>floor <b>{fmt(floorCents,false)}</b></>}
          </div>
        </div>

        <div className="graphwrap">
          <div className="graph-cap">
            <span>Projected close · {cycles.length} cycles</span>
            <span>{monthStart} → {monthEnd}</span>
          </div>
          <svg className="proj" viewBox="0 0 320 152" aria-label="Balance projection flight path">
            <rect className="ground" x="0" y={fY} width="320" height={152 - fY} />
            <path className="area" d={`M${pts[0][0]},${pts[0][1]} ${pts.map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} L${pts[pts.length-1][0]},${fY} L${pts[0][0]},${fY} Z`} />
            <line className="floorln" x1="12" y1={fY} x2="308" y2={fY} />
            <text className="floortx" x="14" y={fY - 4}>{fmt(floorCents,false)} FLOOR</text>
            <polyline className="pastln" points={pts.slice(0, splitIdx+1).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
            <polyline className="futln"  points={pts.slice(splitIdx).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
            {pts.map((p:number[], i:number) => {
              const s = cycleStatus(i)
              const isLow = s==='low', isPast = s==='past', isActive = i===activeIdx
              return (
                <g key={i} onClick={() => setActiveIdx(i)} style={{ cursor:'pointer' }}>
                  {isActive && <circle className={`focusring${isLow?' low':''}`} cx={p[0]} cy={p[1]} r="8" />}
                  <circle className={`wp${isPast?' past':''}${isLow?' low':''}`} cx={p[0]} cy={p[1]} r="4.2" />
                </g>
              )
            })}
          </svg>
        </div>

        <div className="pills" ref={pillsRef}>
          {cycles.map((c, i) => {
            const s = cycleStatus(i)
            return (
              <button key={i}
                className={`pill${s==='low'?' low':''}${s==='past'?' past':''}${i===activeIdx?' active':''}`}
                onClick={() => setActiveIdx(i)}
              >
                <div className="pd">{fmtDate(c.startDate)}</div>
                <div className="pe">{fmt(c.committedClosingBalanceCents,false)}</div>
                <div className="ps">{s==='now' ? 'this cycle' : `→ ${fmtDate(c.endDate)}`}</div>
              </button>
            )
          })}
        </div>

        <div className="cyc">
          <div className="cyc-h">
            <div className="ttl">{fmtDate(activeCycle.startDate)} – {fmtDate(activeCycle.endDate)}</div>
            <div className={`stt ${status==='past'?'frozen':status}`}>
              {status==='now'?'Current':status==='past'?'Closed':status==='low'?'Near floor':'Forecast'}
            </div>
          </div>
          {activeIdx !== currentIdx && (
            <button className="back-to-now" onClick={() => setActiveIdx(currentIdx)}>
              ← back to current cycle
            </button>
          )}
          <div className="carry">
            <span className="o">opens <b>{fmt(activeCycle.openingBalanceCents,false)}</b></span>
            <span className="arr">→</span>
            <span className="c">closes <b>{fmt(activeCycle.committedClosingBalanceCents,false)}</b></span>
          </div>
          {floorCents > 0 && (
            <div className={`nudge${aboveFloor>=0?' ok':''}`}>
              {aboveFloor>=0
                ? <><b>{fmt(aboveFloor,false)}</b> above your floor this cycle.</>
                : <>Closes <b>{fmt(Math.abs(aboveFloor),false)}</b> below your floor.</>}
            </div>
          )}
        </div>

        <div className="cards">
          {cards.map((cd, i) => (
            <div key={i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}>
              <div className={`ic ${cd.iconClass}`}>{cd.icon}</div>
              <div className="tx">
                <div className="nm">
                  {cd.name}
                  {cd.chips.map(([cls, label]: string[], j: number) => (
                    <span key={j} className={`chip ${cls}`}>{label}</span>
                  ))}
                </div>
                <div className="dt">{cd.detail}</div>
                <div className="act-row">
                  {cd.act === 'edit' && <span className="act" onClick={() => openEdit(cd)}>edit →</span>}
                  {cd.act === 'var'  && <span className="act" onClick={() => openVar(cd)}>confirm →</span>}
                </div>
              </div>
              <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
            </div>
          ))}
        </div>

        {status === 'now' && (
          <>
            <button className="closebtn" onClick={openClose}>Close this cycle →</button>
            <div className="closehint">Confirms the real balance that becomes next cycle's opening.</div>
          </>
        )}

        <div style={{ padding:'8px 16px 24px', textAlign:'center' }}>
          <button onClick={() => onNavigate('expenses')} style={{
            background:'none', border:'1px solid var(--line)', borderRadius:11,
            padding:'10px 20px', cursor:'pointer',
            fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:13, color:'var(--acc)',
          }}>
            Manage expenses →
          </button>
        </div>

      </div>

      {/* ═══════════════════════════════════════════════════════════
          OVERLAY 1 — Edit scope + amount (2-step, now saves to DB)
          ═══════════════════════════════════════════════════════════ */}
      {editCard && (
        <div className="ov" onClick={() => setEditCard(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setEditCard(null)}>×</button>
            <div className="grab" />

            {editStep === 0 && <>
              <h3>Change {editCard.name.toLowerCase()}</h3>
              <p className="sd">When should the new amount apply?</p>
              <div className={`opt${editScope==='occurrence'?' sel':''}`} onClick={() => setEditScope('occurrence')}>
                <div className="ot">Just this occurrence</div>
                <div className="os">A one-off override for this cycle only. Reverts automatically next cycle.</div>
              </div>
              <div className={`opt${editScope==='forward'?' sel':''}`} onClick={() => setEditScope('forward')}>
                <div className="ot">From this date onward</div>
                <div className="os">A permanent change — every future cycle uses the new amount.</div>
              </div>
              <div className="navrow">
                <button
                  className="pri"
                  style={{ opacity: editScope ? 1 : 0.4, cursor: editScope ? 'pointer' : 'default' }}
                  onClick={() => { if (editScope) setEditStep(1) }}
                >
                  Next →
                </button>
              </div>
            </>}

            {editStep === 1 && <>
              <h3>New amount</h3>
              <p className="sd">
                {editScope === 'occurrence'
                  ? 'One-off — reverts to original next cycle.'
                  : `Permanent from ${fmtDate(activeCycle.startDate)} onward.`}
              </p>
              <div className="field">
                <label>{editCard.name} — currently {editCard.unitCents ? fmt(editCard.unitCents, false) : '—'}</label>
                <div className="inrow">
                  <span className="pre">$</span>
                  <input type="number" inputMode="decimal" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
                </div>
              </div>
              {editError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{editError}</p>}
              <div className="navrow">
                <button onClick={() => setEditStep(0)}>Back</button>
                <button
                  className="pri"
                  style={{ opacity: editAmountCents > 0 && !editSaving ? 1 : 0.4 }}
                  onClick={applyEdit}
                >
                  {editSaving ? 'Saving…' : `Apply ${editAmountCents > 0 ? fmt(editAmountCents, false) : ''}`}
                </button>
              </div>
            </>}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          OVERLAY 2 — Confirm variable (now saves to DB)
          ═══════════════════════════════════════════════════════════ */}
      {varCard && (
        <div className="ov" onClick={() => setVarCard(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setVarCard(null)}>×</button>
            <div className="grab" />
            <h3>Confirm {varCard.name.toLowerCase()}</h3>
            <p className="sd">Lock in the real figure — this cycle stops being an estimate. Next cycle reverts to the estimate.</p>
            <div className="field">
              <label>Actual amount for this cycle</label>
              <div className="inrow">
                <span className="pre">$</span>
                <input type="number" inputMode="decimal" value={varAmount} onChange={e => setVarAmount(e.target.value)} />
              </div>
              {varCard.estimatedCents > 0 && (
                <p className="hint">Was estimated at {fmt(varCard.estimatedCents, false)}.</p>
              )}
            </div>
            {varError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{varError}</p>}
            <div className="navrow">
              <button onClick={() => setVarCard(null)}>Cancel</button>
              <button
                className="pri"
                style={{ opacity: varAmountCents > 0 && !varSaving ? 1 : 0.4 }}
                onClick={applyConfirm}
              >
                {varSaving ? 'Saving…' : `Confirm ${varAmountCents > 0 ? fmt(varAmountCents, false) : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          OVERLAY 3 — Close ritual (UI complete, DB write pending)
          ═══════════════════════════════════════════════════════════ */}
      {closeOpen && (
        <div className="ov" onClick={() => setCloseOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setCloseOpen(false)}>×</button>
            <div className="grab" />
            <div className="steps">
              {[0,1,2,3].map(i => <div key={i} className={`s${i <= closeStep ? ' done' : ''}`} />)}
            </div>

            {closeStep === 0 && <>
              <h3>Confirm what varied</h3>
              <p className="sd">Only the items estimated in advance — enter what actually arrived.</p>
              {varExpensesInCycle.length === 0
                ? <div className="skipnote">No variable expenses this cycle.</div>
                : varExpensesInCycle.map(e => (
                    <div key={e.id} className="field">
                      <label>{e.name} — estimated {fmt(e.estimatedCents, false)}</label>
                      <div className="inrow">
                        <span className="pre">$</span>
                        <input type="number" inputMode="decimal"
                          value={closeVarActuals[e.id] || ''}
                          onChange={ev => setCloseVarActuals(p => ({ ...p, [e.id]: ev.target.value }))}
                        />
                      </div>
                    </div>
                  ))
              }
              <div className="skipnote"><b>Budget items skipped on purpose.</b> The real balance is the check.</div>
            </>}

            {closeStep === 1 && <>
              <h3>Did income land?</h3>
              <p className="sd">Confirm the expected deposits — adjust if anything differed.</p>
              {incomeInCycle.length === 0
                ? <div className="skipnote">No income expected this cycle.</div>
                : incomeInCycle.map(s => (
                    <div key={s.id} className="field">
                      <label>{s.name} — expected {fmt(s.expectedCents, false)}</label>
                      <div className="inrow">
                        <span className="pre">$</span>
                        <input type="number" inputMode="decimal"
                          value={closeIncomeActuals[s.id] || ''}
                          onChange={ev => setCloseIncomeActuals(p => ({ ...p, [s.id]: ev.target.value }))}
                        />
                      </div>
                    </div>
                  ))
              }
              <div className="skipnote"><b>Bonus or windfall?</b> Add it here — that's where a potential item becomes real.</div>
            </>}

            {closeStep === 2 && <>
              <h3>Your real balance</h3>
              <p className="sd">Whatever your bank says wins — it becomes next cycle's opening balance.</p>
              <div className="field">
                <label>Actual balance right now</label>
                <div className="inrow">
                  <span className="pre">$</span>
                  <input type="number" inputMode="decimal"
                    value={closeRealBalance} onChange={e => setCloseRealBalance(e.target.value)} placeholder="0.00"
                  />
                </div>
                <p className="hint">We projected {fmt(activeCycle.committedClosingBalanceCents, false)}.</p>
              </div>
            </>}

            {closeStep === 3 && <>
              <h3>Reconcile & close</h3>
              <p className="sd">The gap between forecast and reality.</p>
              <div className="recline"><span>Projected close</span><b>{fmt(activeCycle.committedClosingBalanceCents, false)}</b></div>
              {confirmedVarTotalCents > 0 && <div className="recline"><span>Confirmed variables</span><b>−{fmt(confirmedVarTotalCents, false)}</b></div>}
              <div className="recline"><span>Your real balance</span><b>{closeRealCents > 0 ? fmt(closeRealCents, false) : '—'}</b></div>
              <div className={`recline${unaccountedCents >= 0 ? ' res' : ''}`}>
                <span>Unaccounted (groceries / other)</span>
                <b>{unaccountedCents >= 0 ? '+' : '−'}{fmt(Math.abs(unaccountedCents), false)}</b>
              </div>
              <div className="skipnote" style={{ marginTop:13 }}>
                {unaccountedCents >= 0
                  ? 'Closing above forecast — expected when baselines run conservative.'
                  : 'Closing below forecast — spent a little more than projected.'}
              </div>
            </>}

            <div className="navrow">
              {closeStep > 0 && <button onClick={() => setCloseStep(s => s - 1)}>Back</button>}
              {closeStep < 3
                ? <button className="pri" onClick={() => setCloseStep(s => s + 1)}>Next</button>
                : <button className="pri" onClick={() => { /* TODO: freeze cycle in DB */ setCloseOpen(false) }}>
                    Freeze & start next cycle
                  </button>
              }
            </div>
          </div>
        </div>
      )}

    </div>
  )
}