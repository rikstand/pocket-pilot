import { useEffect, useState, useRef } from 'react'
import { supabase } from './lib/supabase'
import { getIncomeSources, getExpenses, getCycles, getProfile, getLayBys } from './lib/repository'
import { projectCycles } from './engine/index'
import { getOccurrencesInRange } from './engine/recurrence'
import { parseDate, formatDate, addDays, addMonths, addYears } from './engine/dates'
import { ExpenseIcon, guessIcon } from './lib/icons'

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
// Inline override for chip colour — mirrors the lay-by chip styling on ExpensesPage.
// Returns undefined for every other chip class so normal CSS classes keep driving the look.
function chipStyle(cls: string): { color: string, borderColor: string, background: string } | undefined {
  if (cls === 'evt') return { color: 'var(--event)', borderColor: 'var(--event)', background: 'var(--event-s)' }
  return undefined
}
// Step forward `count` dates starting at firstDate, at the given frequency.
// Shared by the lay-by form preview and (next step) the actual save.
function computeLaybySchedule(
  firstDate: string,
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'annually',
  count: number
): string[] {
  if (!firstDate || count <= 0) return []
  const dates: string[] = []
  let d = parseDate(firstDate)
  for (let i = 0; i < count; i++) {
    dates.push(formatDate(d))
    if (frequency === 'weekly') d = addDays(d, 7)
    else if (frequency === 'fortnightly') d = addDays(d, 14)
    else if (frequency === 'monthly') d = addMonths(d, 1)
    else d = addYears(d, 1)
  }
  return dates
}

export default function Dashboard({ userId, onNavigate }: { userId: string, onNavigate: (page: any) => void }) {
  const [cycles,      setCycles]      = useState<any[]>([])
  const [rawExpenses, setRawExpenses] = useState<any[]>([])
  const [rawIncome,   setRawIncome]   = useState<any[]>([])
  const [rawLayBys,   setRawLayBys]   = useState<any[]>([])
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
  const [closeSaving,        setCloseSaving]        = useState(false)
  const [closeFrozen,        setCloseFrozen]        = useState(false)

  // ── add-to-cycle overlay state (type picker → one-off / income-stub / layby) ──
  const [addOpen,     setAddOpen]     = useState(false)
  const [addStep,     setAddStep]     = useState(0) // 0 = type picker, 1 = form, 2 = layby preview (stub for now)
  const [addType,     setAddType]     = useState<'oneoff' | 'income' | 'layby' | null>(null)
  const [oneoffName,   setOneoffName]   = useState('')
  const [oneoffAmount, setOneoffAmount] = useState('')
  const [oneoffDate,   setOneoffDate]   = useState('')
  const [addSaving,   setAddSaving]   = useState(false)
  const [addError,    setAddError]    = useState('')

  // ── lay-by form fields ──────────────────────────────────────────────
  const [laybyName,     setLaybyName]     = useState('')
  const [laybyTotal,    setLaybyTotal]    = useState('')
  const [laybyFrequency,setLaybyFrequency]= useState<'weekly'|'fortnightly'|'monthly'|'annually'>('fortnightly')
  const [laybyPayments, setLaybyPayments] = useState('4')
  const [laybyFirstDate,setLaybyFirstDate]= useState('')
  const [laybySaving,   setLaybySaving]   = useState(false)
  const [laybyResult,   setLaybyResult]   = useState<any>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  // Reload whenever userId changes or reloadKey is bumped (after overlay saves)
  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [prof, income, expenses, storedCycles, layBys] = await Promise.all([
          getProfile(userId), getIncomeSources(userId), getExpenses(userId), getCycles(userId), getLayBys(userId),
        ])
        setProfile(prof); setRawIncome(income); setRawExpenses(expenses); setRawLayBys(layBys)

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
            endDate: exp.end_date ?? undefined,
          }
        })

        // Show the latest closed cycle (if any) for historical context,
        // then project forward from the current/next open cycle.
        const openCycles   = storedCycles.filter((c: any) => !c.is_closed)
        const closedCycles = storedCycles.filter((c: any) => c.is_closed)
        const latestClosed = closedCycles[closedCycles.length - 1]
        const projectFrom  = openCycles[0] ?? storedCycles[storedCycles.length - 1]

        const projected = projectCycles({
          incomeSources: engineIncome,
          expenses: engineExpenses,
          openingBalanceCents: projectFrom?.opening_balance_cents ?? 0,
          startDate: projectFrom?.start_date ?? today(),
          numCycles: 6,
          safetyFloorCents: prof?.safety_floor_cents ?? 0,
        })

        // Prepend the latest closed cycle so user can see history
        let cyclesWithHistory: any[] = projected
        if (latestClosed) {
          const historicalCycle = {
            startDate: latestClosed.start_date,
            endDate: latestClosed.end_date,
            openingBalanceCents: latestClosed.opening_balance_cents,
            committedClosingBalanceCents: latestClosed.closing_balance_cents ?? 0,
            potentialClosingBalanceCents: latestClosed.closing_balance_cents ?? 0,
            committedIncomeCents: 0,
            potentialIncomeCents: 0,
            fixedExpensesCents: 0,
            variableExpensesCents: 0,
            budgetExpensesCents: 0,
            isHistorical: true,
          }
          cyclesWithHistory = [historicalCycle, ...projected]
        }

        const cyclesWithIds = cyclesWithHistory.map((p: any) => {
          const stored = storedCycles.find((s: any) => s.start_date === p.startDate)
          return stored ? { ...p, id: stored.id } : p
        })
        setCycles(cyclesWithIds)
        setActiveIdx(findCurrentIdx(cyclesWithIds))
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

  // graph — concept D: auto-scale, Y-axis labels, active dot label
  const closeVals    = cycles.map(c => c.committedClosingBalanceCents / 100)
  const floorDollars = floorCents / 100
  const dataMax      = Math.max(...closeVals, floorDollars, 100)
  const dataMin      = Math.min(...closeVals, 0)
  const tickStep     = dataMax > 8000 ? 2000 : dataMax > 3000 ? 1000 : 500
  const maxTick      = Math.ceil(dataMax * 1.1 / tickStep) * tickStep
  const minTick      = dataMin < 0 ? Math.floor(dataMin * 1.1 / tickStep) * tickStep : 0
  const tickRange    = maxTick - minTick
  const ticks: number[] = []
  for (let tv = minTick; tv <= maxTick; tv += tickStep) ticks.push(tv)
  const fmtAxis = (v: number) => v === 0 ? '$0' : v >= 1000 ? `$${v / 1000}k` : v > 0 ? `$${v}` : v <= -1000 ? `-$${Math.abs(v) / 1000}k` : `-$${Math.abs(v)}`
  const gTop = 16, gBot = 136, gH = gBot - gTop
  const xLeft = 40, xRight = 328, xRange = xRight - xLeft
  const xs   = closeVals.map((_: any, i: number) => xLeft + i * xRange / Math.max(closeVals.length - 1, 1))
  const yFor = (v: number) => gBot - ((v - minTick) / tickRange) * gH
  const pts  = closeVals.map((v: number, i: number) => [xs[i], yFor(v)])
  const fY   = yFor(floorDollars)
  const zeroY = yFor(0)
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
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, cycle.startDate, cycle.endDate, exp.end_date ?? undefined)
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

      // ── lay-by visual override ──────────────────────────────────
      // Lay-bys are saved with mode: 'fixed', so they still total correctly
      // and sit in the Fixed expenses section above. This only swaps the
      // icon/chip colour and replaces the date-list detail with payment
      // progress + remaining balance, matching the ExpensesPage treatment.
      let displayIconClass = iconClass
      let iconSvg = exp.icon || guessIcon(exp.name)
      const isLayby = !!exp.lay_by_id
      if (isLayby) {
        icon = '◫'
        iconSvg = exp.icon || 'gift'
        displayIconClass = 'evt'
        chips = [['evt', 'lay-by']]
        act = null

        const layby = rawLayBys.find((l: any) => l.id === exp.lay_by_id)
        const sortedVersions = [...(exp.expense_amount_versions ?? [])]
          .sort((a: any, b: any) => a.effective_from < b.effective_from ? -1 : 1)
        const lastOccDate = occs[occs.length - 1]
        const idx = sortedVersions.findIndex((sv: any) => sv.effective_from === lastOccDate)
        const paymentNumber  = idx >= 0 ? idx + 1 : sortedVersions.length
        const totalPayments  = layby?.payments_total ?? sortedVersions.length
        const paidThroughCents = sortedVersions
          .slice(0, idx >= 0 ? idx + 1 : sortedVersions.length)
          .reduce((s: number, sv: any) => s + sv.amount_cents, 0)
        const remainingCents = Math.max(0, (layby?.target_amount_cents ?? 0) - paidThroughCents)

        detail = `Payment ${paymentNumber} of ${totalPayments} · ${fmt(remainingCents, false)} left`
      }

      cards.push({
        name: exp.name, icon, iconClass, displayIconClass, iconSvg, chips, detail,
        value: '−' + fmt(total, false), valueClass: '', totalCents: total,
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

  // ── lay-by derived preview values ──────────────────────────────────
  const laybyTotalCents     = Math.round(parseFloat(laybyTotal || '0') * 100)
  const laybyCountNum       = parseInt(laybyPayments || '0', 10) || 0
  const laybyDates          = computeLaybySchedule(laybyFirstDate, laybyFrequency, laybyCountNum)
  const laybyPerPaymentCents= laybyCountNum > 0 ? Math.floor(laybyTotalCents / laybyCountNum) : 0
  const laybyRemainderCents = laybyTotalCents - laybyPerPaymentCents * laybyCountNum
  const laybyEndDate        = laybyDates[laybyDates.length - 1]

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

  // ── add-to-cycle handlers ──────────────────────────────────────────
  function openAddToCycle() {
    setAddType(null); setAddStep(0)
    setOneoffName(''); setOneoffAmount(''); setOneoffDate(activeCycle.startDate)
    setLaybyName(''); setLaybyTotal(''); setLaybyFrequency('fortnightly')
    setLaybyPayments('4'); setLaybyFirstDate('')
    setAddError(''); setAddOpen(true)
  }
  function closeAddSheet() {
    setAddOpen(false); setAddType(null); setAddStep(0); setAddError('')
  }
  function selectAddType(t: 'oneoff' | 'income' | 'layby') {
    setAddType(t); setAddStep(1); setAddError('')
    if (t === 'layby') {
      setLaybyName(''); setLaybyTotal(''); setLaybyFrequency('fortnightly')
      setLaybyPayments('4'); setLaybyFirstDate(activeCycle.startDate)
    }
  }
  async function saveOneOff() {
    const amountCents = Math.round(parseFloat(oneoffAmount || '0') * 100)
    if (!oneoffName.trim() || !amountCents || !oneoffDate) {
      setAddError('Name, amount and date are required.'); return
    }
    setAddSaving(true); setAddError('')
    try {
      const { data: exp, error: e1 } = await supabase
        .from('expenses')
        .insert({ profile_id: userId, name: oneoffName.trim(), frequency: 'once', anchor_date: oneoffDate, mode: 'fixed' })
        .select().single()
      if (e1) throw e1
      const { error: e2 } = await supabase
        .from('expense_amount_versions')
        .insert({ expense_id: exp.id, amount_cents: amountCents, effective_from: oneoffDate })
      if (e2) throw e2
      closeAddSheet(); reload()
    } catch (e: any) { setAddError(e.message) }
    finally { setAddSaving(false) }
  }
  // Validates the lay-by form, writes the lay_bys row + linked expense +
  // one amount_version per scheduled payment, then shows the confirmation step.
  async function saveLayby() {
    if (!laybyName.trim() || !laybyTotalCents || laybyCountNum <= 0 || !laybyFirstDate) {
      setAddError('Name, total, payments, and first payment date are required.'); return
    }
    setLaybySaving(true); setAddError('')
    try {
      const lastPaymentCents = laybyPerPaymentCents + laybyRemainderCents

      const { data: layby, error: e1 } = await supabase
        .from('lay_bys')
        .insert({
          profile_id: userId,
          name: laybyName.trim(),
          target_amount_cents: laybyTotalCents,
          target_date: laybyEndDate,
          payment_amount_cents: laybyPerPaymentCents,
          payments_total: laybyCountNum,
        })
        .select().single()
      if (e1) throw e1

      const { data: exp, error: e2 } = await supabase
        .from('expenses')
        .insert({
          profile_id: userId,
          name: laybyName.trim(),
          frequency: laybyFrequency,
          anchor_date: laybyFirstDate,
          mode: 'fixed',
          end_date: laybyEndDate,
          lay_by_id: layby.id,
        })
        .select().single()
      if (e2) throw e2

      const versionRows = laybyDates.map((date, i) => ({
        expense_id: exp.id,
        amount_cents: i === laybyDates.length - 1 ? lastPaymentCents : laybyPerPaymentCents,
        effective_from: date,
      }))
      const { error: e3 } = await supabase.from('expense_amount_versions').insert(versionRows)
      if (e3) throw e3

      setLaybyResult({ name: laybyName.trim(), totalCents: laybyTotalCents, perPaymentCents: laybyPerPaymentCents, count: laybyCountNum, endDate: laybyEndDate })
      setAddStep(2)
    } catch (e: any) { setAddError(e.message) }
    finally { setLaybySaving(false) }
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
// ── SAVE: close ritual ───────────────────────────────────────────
  async function applyFreeze() {
    if (!closeRealCents) return
    setCloseSaving(true)
    try {
      // 1. Save variable expense actuals
      for (const e of varExpensesInCycle) {
        const actualStr = closeVarActuals[e.id]
        if (!actualStr) continue
        const actualCents = Math.round(parseFloat(actualStr) * 100)
        const { error } = await supabase.from('cycle_expense_actuals').insert({
          cycle_id: activeCycle.id ?? null,  // may not exist if cycle was engine-projected
          expense_id: e.id,
          actual_amount_cents: actualCents,
        })
        // Soft-fail — the cycle row may be virtual (engine-projected, not in DB yet)
        if (error) console.warn('actual insert failed:', error.message)
      }

      // 2. Freeze the current cycle (if it exists in DB)
      if (activeCycle.id) {
        const { error: e1 } = await supabase.from('cycles')
          .update({
            closing_balance_cents: closeRealCents,
            is_closed: true,
            closed_at: new Date().toISOString(),
          })
          .eq('id', activeCycle.id)
        if (e1) throw e1
      }

      // 3. Create the next cycle with the real balance as opening
      const nextStart = addOneDay(activeCycle.endDate)
      const nextEndDate = new Date(nextStart + 'T00:00:00')
      const freq = primaryIncome?.frequency ?? 'fortnightly'
      if      (freq === 'weekly')      nextEndDate.setDate(nextEndDate.getDate() + 6)
      else if (freq === 'fortnightly') nextEndDate.setDate(nextEndDate.getDate() + 13)
      else if (freq === 'monthly')   { nextEndDate.setMonth(nextEndDate.getMonth() + 1); nextEndDate.setDate(nextEndDate.getDate() - 1) }
      else                           { nextEndDate.setFullYear(nextEndDate.getFullYear() + 1); nextEndDate.setDate(nextEndDate.getDate() - 1) }

      const { error: e2 } = await supabase.from('cycles').insert({
        profile_id: userId,
        start_date: nextStart,
        end_date: nextEndDate.toISOString().split('T')[0],
        opening_balance_cents: closeRealCents,
        contingency_cents: 0,
        is_closed: false,
      })
      if (e2) throw e2

      // 4. Show success, then reload
      setCloseFrozen(true)
      setTimeout(() => {
        setCloseOpen(false)
        setCloseFrozen(false)
        reload()
      }, 1500)
    } catch (e: any) {
      console.error(e)
      alert('Could not freeze cycle: ' + e.message)
    } finally {
      setCloseSaving(false)
    }
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
  const incomeCards  = cards.filter(c => c.iconClass === 'inc' || c.iconClass === 'pot')
  const fixedCards   = cards.filter(c => c.iconClass === 'fix')
  const varCards     = cards.filter(c => c.iconClass === 'var')
  const budgetCards  = cards.filter(c => c.iconClass === 'base')
  const fixedTotalCents  = fixedCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)
  const varTotalCents    = varCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)
  const budgetTotalCents = budgetCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)
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
          <svg className="proj" viewBox="0 0 340 152" aria-label="Balance projection">
            {/* axis lines */}
            <line className="axln" x1={xLeft} y1={gTop} x2={xLeft} y2={gBot} />
            <line className="axln" x1={xLeft} y1={gBot} x2={xRight} y2={gBot} />
            {/* gridlines + Y-axis labels */}
            {ticks.map(tv => (
              <g key={tv}>
                {tv !== minTick && (
                  <line className={tv === 0 && minTick < 0 ? 'axln' : 'gridln'}
                    x1={xLeft} y1={yFor(tv)} x2={xRight} y2={yFor(tv)} />
                )}
                <text className="axtx" x={xLeft - 4} y={yFor(tv) + 3} textAnchor="end">{fmtAxis(tv)}</text>
              </g>
            ))}
            {/* floor line */}
            {floorCents > 0 && <>
              <line className="floorln" x1={xLeft} y1={fY} x2={xRight} y2={fY} />
              <text className="floortx" x={xLeft + 4} y={fY - 4}>{fmt(floorCents,false)} FLOOR</text>
            </>}
            {/* area fill — anchored to $0 line, not chart bottom */}
            <path className="area" d={`M${pts[0][0]},${pts[0][1]} ${pts.map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} L${pts[pts.length-1][0]},${zeroY} L${pts[0][0]},${zeroY} Z`} />
            {/* past + future lines */}
            <polyline className="pastln" points={pts.slice(0, splitIdx+1).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
            <polyline className="futln"  points={pts.slice(splitIdx).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
            {/* waypoints + active dot label */}
            {pts.map((p:number[], i:number) => {
              const s = cycleStatus(i)
              const isLow = s==='low', isPast = s==='past', isActive = i===activeIdx
              return (
                <g key={i} onClick={() => setActiveIdx(i)} style={{ cursor:'pointer' }}>
                  {isActive && <circle className={`focusring${isLow?' low':''}`} cx={p[0]} cy={p[1]} r="8" />}
                  <circle className={`wp${isPast?' past':''}${isLow?' low':''}`} cx={p[0]} cy={p[1]} r="4.2" />
                  {isActive && (
                    <text className={`dotlbl${isLow?' low':''}`} x={p[0]} y={p[1] - 12} textAnchor="middle">
                      {fmt(cycles[i].committedClosingBalanceCents, false)}
                    </text>
                  )}
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
          {incomeCards.map((cd, i) => (
            <div key={'inc'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}>
              <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
              <div className="tx">
                <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                <div className="dt">{cd.detail}</div>
                <div className="act-row">{cd.act === 'edit' && <span className="act" onClick={() => openEdit(cd)}>edit →</span>}{cd.act === 'var' && <span className="act" onClick={() => openVar(cd)}>confirm →</span>}</div>
              </div>
              <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
            </div>
          ))}
        </div>

        {fixedCards.length > 0 && (
          <>
            <div className="section-hdr sh-fix"><span className="sh-label">Fixed expenses</span><span className="sh-total">−{fmt(fixedTotalCents, false)}</span></div>
            <div className="cards">
              {fixedCards.map((cd, i) => (
                <div key={'fix'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}>
                  <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                  <div className="tx">
                    <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                    <div className="dt">{cd.detail}</div>
                    <div className="act-row">{cd.act === 'edit' && <span className="act" onClick={() => openEdit(cd)}>edit →</span>}</div>
                  </div>
                  <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {varCards.length > 0 && (
          <>
            <div className="section-hdr sh-var"><span className="sh-label">Estimates</span><span className="sh-total">−{fmt(varTotalCents, false)}</span></div>
            <div className="cards">
              {varCards.map((cd, i) => (
                <div key={'var'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}>
                  <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                  <div className="tx">
                    <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                    <div className="dt">{cd.detail}</div>
                    <div className="act-row">{cd.act === 'var' && <span className="act" onClick={() => openVar(cd)}>confirm →</span>}</div>
                  </div>
                  <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {budgetCards.length > 0 && (
          <>
            <div className="section-hdr sh-bud"><span className="sh-label">Budget</span><span className="sh-total">−{fmt(budgetTotalCents, false)}</span></div>
            <div className="cards">
              {budgetCards.map((cd, i) => (
                <div key={'bud'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}>
                  <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                  <div className="tx">
                    <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                    <div className="dt">{cd.detail}</div>
                    <div className="act-row" />
                  </div>
                  <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {status !== 'past' && (
          <div style={{ padding:'14px 16px 0' }}>
            <button className="addbtn" onClick={openAddToCycle}>+ Add to this cycle</button>
          </div>
        )}

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

            {closeFrozen
              ? (
                <div style={{
                  textAlign:'center', padding:'24px 0',
                  fontFamily:"'Space Grotesk',sans-serif", fontSize:18, fontWeight:600,
                  color:'var(--pos)',
                }}>
                  ✓ Cycle frozen
                </div>
              )
              : (
                <div className="navrow">
                  {closeStep > 0 && <button onClick={() => setCloseStep(s => s - 1)}>Back</button>}
                  {closeStep < 3
                    ? <button className="pri" onClick={() => setCloseStep(s => s + 1)}>Next</button>
                    : <button
                        className="pri"
                        style={{ opacity: closeRealCents > 0 && !closeSaving ? 1 : 0.4 }}
                        onClick={applyFreeze}
                      >
                        {closeSaving ? 'Freezing…' : 'Freeze & start next cycle'}
                      </button>
                  }
                </div>
              )
            }
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          OVERLAY 4 — Add to this cycle (type picker → one-off / income-stub / layby form)
          ═══════════════════════════════════════════════════════════ */}
      {addOpen && (
        <div className="ov" onClick={closeAddSheet}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={closeAddSheet}>×</button>
            <div className="grab" />

            {addStep === 0 && <>
              <h3>Add to this cycle</h3>
              <p className="sd">{fmtDate(activeCycle.startDate)} – {fmtDate(activeCycle.endDate)}. Pick the kind of thing — the form adapts.</p>

              <div className="typeopt" onClick={() => selectAddType('oneoff')}>
                <div className="ti ic fix">−</div>
                <div className="tx2"><div className="tt2">One-off expense</div><div className="ts2">A single cost on a date.</div></div>
              </div>
              <div className="typeopt" onClick={() => selectAddType('income')}>
                <div className="ti ic inc">+</div>
                <div className="tx2"><div className="tt2">Money coming in</div><div className="ts2">A bonus, refund, tax return.</div></div>
              </div>
              <div className="typeopt" onClick={() => selectAddType('layby')}>
                <div className="ti ic evt">◫</div>
                <div className="tx2"><div className="tt2">Lay-by or instalment</div><div className="ts2">A fixed total, paid off over time. Self-retires when done.</div></div>
              </div>
            </>}

            {addStep === 1 && addType === 'oneoff' && <>
              <h3>One-off expense</h3>
              <p className="sd">A single cost on a date — doesn't repeat.</p>

              <div className="field">
                <label>What's it for?</label>
                <div className="inrow">
                  <input type="text" value={oneoffName} onChange={e => setOneoffName(e.target.value)} placeholder="e.g. Car registration" />
                </div>
              </div>

              <div className="field">
                <label>Amount</label>
                <div className="inrow">
                  <span className="pre">$</span>
                  <input type="number" inputMode="decimal" value={oneoffAmount} onChange={e => setOneoffAmount(e.target.value)} placeholder="0" />
                </div>
              </div>

              <div className="field">
                <label>Date</label>
                <div className="inrow">
                  <input
                    type="date" value={oneoffDate} onChange={e => setOneoffDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                  />
                </div>
                <p className="hint">Defaults to the start of this cycle — change it if it actually falls in a different one.</p>
              </div>

              {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{addError}</p>}

              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
                <button
                  className="pri"
                  onClick={saveOneOff}
                  style={{ opacity: addSaving ? 0.6 : 1, cursor: addSaving ? 'default' : 'pointer' }}
                >
                  {addSaving ? 'Saving…' : 'Add expense'}
                </button>
              </div>
            </>}

            {addStep === 1 && addType === 'income' && <>
              <h3>Money coming in</h3>
              <p className="sd">Coming soon — not wired up yet.</p>
              <div className="skipnote">Bonuses, tax returns, and other one-off income land here next.</div>
              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
              </div>
            </>}

            {addStep === 1 && addType === 'layby' && <>
              <h3>Lay-by or instalment</h3>
              <p className="sd">A fixed total, split into equal payments. Stops itself once paid off.</p>

              <div className="field">
                <label>What's it for?</label>
                <div className="inrow">
                  <input type="text" value={laybyName} onChange={e => setLaybyName(e.target.value)} placeholder="e.g. Winter coat" />
                </div>
              </div>

              <div className="field">
                <label>Total</label>
                <div className="inrow">
                  <span className="pre">$</span>
                  <input type="number" inputMode="decimal" value={laybyTotal} onChange={e => setLaybyTotal(e.target.value)} placeholder="0" />
                </div>
              </div>

              <div className="field">
                <label>Pay every</label>
                <div className="freq-picker">
                  {(['weekly','fortnightly','monthly','annually'] as const).map(f => (
                    <button
                      key={f}
                      className={`freq-opt${laybyFrequency === f ? ' sel' : ''}`}
                      onClick={() => setLaybyFrequency(f)}
                    >
                      {f === 'weekly' ? 'Weekly' : f === 'fortnightly' ? 'Fortnightly' : f === 'monthly' ? 'Monthly' : 'Annually'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Payments</label>
                <div className="inrow">
                  <input type="number" inputMode="numeric" value={laybyPayments} onChange={e => setLaybyPayments(e.target.value)} placeholder="4" />
                </div>
              </div>

              <div className="field">
                <label>First payment</label>
                <div className="inrow">
                  <input
                    type="date" value={laybyFirstDate} onChange={e => setLaybyFirstDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                  />
                </div>
              </div>

              {laybyCountNum > 0 && laybyTotalCents > 0 && laybyFirstDate && (
                <div className="skipnote">
                  <b>{fmt(laybyPerPaymentCents, false)}</b> per payment × {laybyCountNum}
                  {laybyRemainderCents !== 0 && <> (last payment {fmt(laybyPerPaymentCents + laybyRemainderCents, false)}, absorbs rounding)</>}
                  <br />First payment {fmtDate(laybyDates[0])} · last payment {fmtDate(laybyEndDate)}
                </div>
              )}

              {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{addError}</p>}

              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
                <button
                  className="pri"
                  onClick={saveLayby}
                  style={{ opacity: laybySaving ? 0.6 : 1, cursor: laybySaving ? 'default' : 'pointer' }}
                >
                  {laybySaving ? 'Saving…' : 'Add lay-by'}
                </button>
              </div>
            </>}

            {addStep === 2 && addType === 'layby' && laybyResult && <>
              <h3>Lay-by added</h3>
              <p className="sd">{laybyResult.name} is now tracked across {laybyResult.count} cycles.</p>
              <div className="recline"><span>Total</span><b>{fmt(laybyResult.totalCents)}</b></div>
              <div className="recline"><span>Per payment</span><b>{fmt(laybyResult.perPaymentCents)}</b></div>
              <div className="recline res"><span>Paid off by</span><b>{fmtDate(laybyResult.endDate)}</b></div>
              <div className="skipnote" style={{ marginTop:13 }}>
                It'll show up as a card in every cycle it touches, and disappear on its own once the last payment lands.
              </div>
              <div className="navrow">
                <button className="pri" onClick={() => { closeAddSheet(); reload() }}>Done</button>
              </div>
            </>}
          </div>
        </div>
      )}

    </div>
  )
}