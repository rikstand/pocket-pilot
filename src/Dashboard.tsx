import { useEffect, useState, useRef } from 'react'
import type { CSSProperties } from 'react'
import { supabase } from './lib/supabase'
import {
  getLayBys,
  getBudgetSpendEntries,
  addBudgetSpendEntry,
  updateBudgetSpendEntry,
  deleteBudgetSpendEntry,
  setCreditExtraOverride,
  clearCreditExtraOverride,
  getSavingsGoals, getAllSavingsContributions,
  confirmSavingsContribution, unconfirmSavingsContribution,
  setSavingsOverride, clearSavingsOverride, updateSavingsGoal,
  getCreditCyclePayments,
  confirmCreditPayment,
  unconfirmCreditPayment,
  updateCreditStrategyExtra,
} from './lib/repository'
import { useAccount } from './lib/AccountContext'
import { moneyFormatter, currencySymbol } from './lib/money'
import { creditModelFrom, buildMinimumDueSchedule, dueDateInCycle, runCardForward } from './lib/creditSchedule'
import { loadForecast, cycleTickLabel, cycleDateLabel, baseYearOf, baselineChecks } from './lib/forecast'
import { getOccurrencesInRange } from './engine/recurrence'
import { parseDate, formatDate, addDays, addMonths, addYears } from './engine/dates'
import { byOldest, latestVersion, versionForDate } from './lib/versions'
import { ExpenseIcon, guessIcon } from './lib/icons'

function fmtDate(d: string) {
  return parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
}
function daysUntil(dateStr: string) {
  const now = new Date(); now.setHours(0,0,0,0)
  return Math.max(0, Math.round((parseDate(dateStr).getTime() - now.getTime()) / 86400000))
}
function today() { return formatDate(new Date()) }
function findCurrentIdx(cycles: any[]) {
  const t = today()
  const idx = cycles.findIndex(c => c.startDate <= t && c.endDate >= t)
  return idx >= 0 ? idx : 0
}
function addOneDay(dateStr: string): string {
  return formatDate(addDays(parseDate(dateStr), 1))
}
function chipStyle(cls: string): { color: string, borderColor: string, background: string } | undefined {
  if (cls === 'evt') return { color: 'var(--event)', borderColor: 'var(--event)', background: 'var(--event-s)' }
  return undefined
}
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

export default function Dashboard({ userId, accountId, variant }: { userId: string, accountId: string, variant: 'cycle' | 'forecast' }) {
  const { activeAccount } = useAccount()

  // Amounts follow the account's currency — see lib/money.ts
  const fmt = moneyFormatter(activeAccount?.currency_code)
  const sym = currencySymbol(activeAccount?.currency_code)
  const [cycles,      setCycles]      = useState<any[]>([])
  const [rawExpenses, setRawExpenses] = useState<any[]>([])
  const [rawIncome,   setRawIncome]   = useState<any[]>([])
  const [rawLayBys,   setRawLayBys]   = useState<any[]>([])
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [error,       setError]       = useState('')
  const [loading,     setLoading]     = useState(true)
  const [reloadKey,   setReloadKey]   = useState(0)
  const pillsRef = useRef<HTMLDivElement>(null)

  // NEW — cycle carousel dot tracking (Available-to-spend / Next-payments swipe)
  const [activeCarouselDot, setActiveCarouselDot] = useState(0)
  const carouselRef = useRef<HTMLDivElement>(null)
  function handleCarouselScroll() {
    const el = carouselRef.current
    if (!el || el.clientWidth === 0) return
    const idx = Math.round(el.scrollLeft / el.clientWidth)
    setActiveCarouselDot(idx)
  }

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
  const [closeVarActuals,  setCloseVarActuals]  = useState<Record<string, string>>({})
  const [closePayLanded,   setClosePayLanded]   = useState<boolean | null>(null)
  const [closePayAmount,   setClosePayAmount]   = useState('')
  const [closeRealBalance,   setCloseRealBalance]   = useState('')
  const [closeSaving,        setCloseSaving]        = useState(false)
  const [closeFrozen,        setCloseFrozen]        = useState(false)

  const [addOpen,     setAddOpen]     = useState(false)
  const [addStep,     setAddStep]     = useState(0)
  const [addType,     setAddType]     = useState<'oneoff' | 'income' | 'layby' | null>(null)
  const [oneoffName,   setOneoffName]   = useState('')
  const [oneoffAmount, setOneoffAmount] = useState('')
  const [oneoffDate,   setOneoffDate]   = useState('')
  const [addSaving,   setAddSaving]   = useState(false)
  const [addError,    setAddError]    = useState('')

  const [incomeName,    setIncomeName]    = useState('')
  const [incomeAmount,  setIncomeAmount]  = useState('')
  const [incomeDate,    setIncomeDate]    = useState('')
  const [incomeCertain, setIncomeCertain] = useState(false)

  const [oneOffItem,     setOneOffItem]     = useState<any>(null)
  const [oneOffName,     setOneOffName]     = useState('')
  const [oneOffAmt,      setOneOffAmt]      = useState('')
  const [oneOffCertain,  setOneOffCertain]  = useState(false)
  const [oneOffSaving,   setOneOffSaving]   = useState(false)
  const [oneOffDeleting, setOneOffDeleting] = useState(false)
  const [oneOffError,    setOneOffError]    = useState('')

  const [laybyName,      setLaybyName]      = useState('')
  const [laybyTotal,     setLaybyTotal]     = useState('')
  const [laybyFrequency, setLaybyFrequency] = useState<'weekly'|'fortnightly'|'monthly'|'annually'>('fortnightly')
  const [laybyPayments,  setLaybyPayments]  = useState('4')
  const [laybyFirstDate, setLaybyFirstDate] = useState('')
  const [laybySaving,    setLaybySaving]    = useState(false)
  const [laybyResult,    setLaybyResult]    = useState<any>(null)

  const [rawBudgetEntries, setRawBudgetEntries] = useState<any[]>([])
  const [rawStoredCycles,  setRawStoredCycles]  = useState<any[]>([])
  const [dismissedBaseline, setDismissedBaseline] = useState<string[]>([])

  // How far the Forecast page looks ahead. Cycle stays on the near term — a
  // year of cycles is not what you want when deciding about this fortnight.
  const [horizonCycles, setHorizonCycles] = useState(6)

  // savings
  const [savingsGoals,   setSavingsGoals]   = useState<any[]>([])
  const [savingsDone,    setSavingsDone]    = useState<any[]>([])
  const [savTarget,      setSavTarget]      = useState<any>(null)   // goal detail
  const [savAdjust,      setSavAdjust]      = useState<any>(null)   // change amount
  const [savAdjAmount,   setSavAdjAmount]   = useState('')
  const [savAdjScope,    setSavAdjScope]    = useState<'once' | 'always'>('once')
  const [savFixTotal,    setSavFixTotal]    = useState<any>(null)   // correct total
  const [savFixAmount,   setSavFixAmount]   = useState('')
  const [savBusy,        setSavBusy]        = useState(false)
  const [openQuickAdd,     setOpenQuickAdd]     = useState<string | null>(null)
  const [quickAddAmount,   setQuickAddAmount]   = useState('')
  const [logItem,          setLogItem]          = useState<any>(null)
  const [editingEntryId,   setEditingEntryId]   = useState<string | null>(null)
  const [editEntryAmount,  setEditEntryAmount]  = useState('')
  const [editEntryLabel,   setEditEntryLabel]   = useState('')

  // NEW — Salary / recurring income edit sheet (amount + frequency + payday)
  const [incomeEditItem,      setIncomeEditItem]      = useState<any>(null)
  const [incomeEditScope,     setIncomeEditScope]     = useState<'occurrence' | 'forward' | null>(null)
  const [incomeEditStep,      setIncomeEditStep]      = useState(0)
  const [incomeEditAmount,    setIncomeEditAmount]    = useState('')
  const [incomeEditFrequency, setIncomeEditFrequency] = useState<'weekly'|'fortnightly'|'monthly'|'annually'>('fortnightly')
  const [incomeEditAnchor,    setIncomeEditAnchor]    = useState('')
  const [incomeEditSaving,    setIncomeEditSaving]    = useState(false)
  const [incomeEditError,     setIncomeEditError]     = useState('')

  const [rawCredit,     setRawCredit]     = useState<any>(null)
  const [creditPaid,    setCreditPaid]    = useState<any[]>([])

  // adjust sheet
  const [adjOpen,   setAdjOpen]   = useState(false)
  const [adjExtra,  setAdjExtra]  = useState(0)
  const [adjScope,  setAdjScope]  = useState<'once' | 'always'>('once')
  const [adjSaving, setAdjSaving] = useState(false)

  const [openSecs, setOpenSecs] = useState<Record<string, boolean>>({
    income: true, fixed: true, var: true, budget: true, savings: true, credit: true,
  })
  function toggleSec(k: string) { setOpenSecs(p => ({ ...p, [k]: !p[k] })) }

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const floorCents = activeAccount?.safety_floor_cents ?? 0

        // One shared loader builds the projection for every screen. Before this,
        // the Cycle screen, Wishlist and Settings each had their own copy of the
        // mapping, and two of them had quietly drifted — Wishlist forecast a
        // bigger balance because its copy never loaded the credit card.
        const [layBys, budgetEntries, forecast] = await Promise.all([
          getLayBys(accountId),
          getBudgetSpendEntries(accountId),
          // The Cycle page renders only the focused cycle, so a longer projection
          // costs nothing on screen — but the adjust sheet needs it. A payment
          // running fifteen cycles was being judged against six.
          loadForecast(accountId, floorCents, { numCycles: variant === 'forecast' ? horizonCycles : 20 }),
        ])

        const {
          cycles: projected,
          incomeRows: income,
          expenseRows: expenses,
          storedCycles,
          creditCard,
        } = forecast

        setRawCredit(creditCard)

        // Payment confirmations only exist once a card does.
        const creditPaidRows = creditCard
          ? await getCreditCyclePayments(creditCard.id)
          : []
        setCreditPaid(creditPaidRows ?? [])

        const [goalRows, contribRows] = await Promise.all([
          getSavingsGoals(accountId),
          getAllSavingsContributions(accountId),
        ])
        setSavingsGoals(goalRows ?? [])
        setSavingsDone(contribRows ?? [])
        setRawIncome(income)
        setRawExpenses(expenses)
        setRawLayBys(layBys)
        setRawBudgetEntries(budgetEntries)
        setRawStoredCycles(storedCycles)

        const closedCycles = storedCycles.filter((c: any) => c.is_closed)
        const latestClosed = closedCycles[closedCycles.length - 1]

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
            creditOpeningBalanceCents: 0,
            creditAssumedSpendCents: 0,
            creditInterestCents: 0,
            creditMinimumCents: 0,
            creditExtraCents: 0,
            creditPaymentCents: 0,
            creditClosingBalanceCents: 0,
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
  }, [accountId, reloadKey, horizonCycles, variant])

  useEffect(() => {
    if (pillsRef.current) {
      const btn = pillsRef.current.children[activeIdx] as HTMLElement
      btn?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  }, [activeIdx])

  useEffect(() => {
    if (variant === 'cycle' && cycles.length) {
      setActiveIdx(findCurrentIdx(cycles))
    }
  }, [variant, cycles])

  if (loading) return <div className="app" style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh' }}><p style={{ color:'var(--mut)' }}>Loading…</p></div>
  if (error)   return <div className="app" style={{ padding:24 }}><p style={{ color:'var(--floor)' }}>{error}</p></div>
  if (!cycles.length) return <div className="app" style={{ padding:24 }}><p style={{ color:'var(--mut)' }}>No cycle data.</p></div>

  const activeCycle  = cycles[activeIdx]
  const floorCents   = activeAccount?.safety_floor_cents ?? 0
  const currentIdx   = findCurrentIdx(cycles)

  function reload() { setReloadKey(k => k + 1) }

  const primaryIncome = rawIncome.find((s: any) => s.is_primary && !s.is_potential)

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

  // Overdue-cycle fix: a cycle is only genuinely "past" (frozen) when it's the
  // stored historical snapshot from the close ritual. If a cycle's end date has
  // simply gone by without ever being closed, it's "overdue" — still editable,
  // still closeable, distinct from a truly frozen record.
  function cycleStatus(i: number) {
    const t = today(), c = cycles[i]
    if (c.isHistorical) return 'past'
    if (c.endDate < t) return 'overdue'
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
      const v = latestVersion(src.income_amount_versions)
      const unitCents = v?.amount_cents ?? 0
      const isOneOffIncome = src.frequency === 'once'
      cards.push({
        name: src.name, icon: '↓',
        iconClass: src.is_potential ? 'pot' : 'inc',
        chips: src.is_potential ? [['pt','potential']] : [['lock','fixed']],
        detail: occs.length === 1 ? `${fmtDate(occs[0])} · ${src.frequency}` : occs.map((o: string) => fmtDate(o)).join(', '),
        value: fmt(unitCents * occs.length, false),
        valueClass: src.is_potential ? 'pot' : 'pos',
        totalCents: unitCents * occs.length,
        ghost: src.is_potential, dashed: false, act: null,
        oneOff: isOneOffIncome, oneOffKind: 'income', incomeId: src.id,
        isPotential: src.is_potential ?? false,
        oneOffDateStr: fmtDate(occs[0]),
        // raw ISO date — the formatted oneOffDateStr can't be written back to
        // the DB, and a one-off edit needs a real effective_from
        oneOffDate: occs[0],
        // FIX: was hardcoded to 0/0, which meant the income edit sheet had no
        // "currently $X" to show and no baseline to diff a scoped edit against.
        expenseId: null, unitCents, originalUnitCents: unitCents,
      })
    }

    for (const exp of rawExpenses) {
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, cycle.startDate, cycle.endDate, exp.end_date ?? undefined)
      if (!occs.length) continue

      const v         = versionForDate(exp.expense_amount_versions, cycle.startDate)
      const unitCents = v?.amount_cents ?? 0
      const total     = unitCents * occs.length
      const mode      = exp.mode ?? 'fixed'

      let icon = '▤', iconClass = 'fix', chips: string[][] = [['lock','fixed']], act: string | null = null
      if (mode === 'variable') { icon = '~'; iconClass = 'var'; chips = [['est','estimate']]; act = 'var' }
      else if (mode === 'budget') { icon = '≈'; iconClass = 'base'; chips = [['bl','baseline']] }
      else { act = 'edit' }

      const isOneOffExp = exp.frequency === 'once' && !exp.lay_by_id
      if (isOneOffExp) act = 'oneoff'

      let detail = ''
      if (mode === 'variable') {
        detail = '~ typical ' + exp.frequency.replace('ly','')
      } else if (mode === 'budget') {
        detail = `${fmt(unitCents,false)}/${exp.frequency==='weekly'?'wk':exp.frequency==='fortnightly'?'fn':'mo'}` + (occs.length > 1 ? ` × ${occs.length}` : '')
      } else {
        detail = occs.length === 1 ? `${fmtDate(occs[0])} · ${exp.frequency}` : occs.map((o: string) => fmtDate(o)).join(', ')
        if (exp.category) detail += ' · ' + exp.category
      }

      let displayIconClass = iconClass
      let iconSvg = exp.icon || guessIcon(exp.name)
      let laybyPct: number | null = null
      const isLayby = !!exp.lay_by_id
      if (isLayby) {
        icon = '◫'
        iconSvg = exp.icon || 'gift'
        displayIconClass = 'evt'
        chips = [['evt', 'lay-by']]
        act = null

        const layby = rawLayBys.find((l: any) => l.id === exp.lay_by_id)
        const sortedVersions = [...(exp.expense_amount_versions ?? [])].sort(byOldest)
        const lastOccDate = occs[occs.length - 1]
        const idx = sortedVersions.findIndex((sv: any) => sv.effective_from === lastOccDate)
        const paymentNumber  = idx >= 0 ? idx + 1 : sortedVersions.length
        const totalPayments  = layby?.payments_total ?? sortedVersions.length
        const paidThroughCents = sortedVersions
          .slice(0, idx >= 0 ? idx + 1 : sortedVersions.length)
          .reduce((s: number, sv: any) => s + sv.amount_cents, 0)
        const targetCents    = layby?.target_amount_cents ?? 0
        const remainingCents = Math.max(0, targetCents - paidThroughCents)

        const firstIdx = sortedVersions.findIndex((sv: any) => sv.effective_from === occs[0])
        const paymentLabel = occs.length > 1 && firstIdx >= 0
          ? `Payments ${firstIdx + 1}–${paymentNumber} of ${totalPayments}`
          : `Payment ${paymentNumber} of ${totalPayments}`
        const dateStr = occs.map((o: string) => fmtDate(o)).join(', ')

        detail = `${paymentLabel} · ${dateStr} · ${fmt(remainingCents, false)} left`
        laybyPct = targetCents > 0
          ? Math.min(100, Math.round((paidThroughCents / targetCents) * 100))
          : 0
      }

      cards.push({
        name: exp.name, icon, iconClass, displayIconClass, iconSvg, chips, detail,
        value: '−' + fmt(total, false), valueClass: '', totalCents: total,
        ghost: false, dashed: mode === 'variable', act,
        expenseId: exp.id,
        oneOff: isOneOffExp, oneOffKind: 'expense',
        oneOffDateStr: fmtDate(occs[0]),
        oneOffDate: occs[0],
        laybyPct,
        unitCents,
        originalUnitCents: unitCents,
        estimatedCents: unitCents,
      })
    }
    return cards
  }

  // NEW — flattened, per-occurrence fixed/lay-by payments for the carousel.
  // Distinct from buildCards(), which aggregates occurrences into one card per expense.
  // This returns one entry per individual future occurrence, chronologically ordered,
  // mixing plain fixed expenses and lay-by payments together (per design decision).
  function buildFixedOccurrences() {
    type PaymentItem = {
      name: string, date: string, amountCents: number,
      isLayby: boolean, icon: string, subLabel: string,
    }
    const items: PaymentItem[] = []
    const t = today()

    for (const exp of rawExpenses) {
      if ((exp.mode ?? 'fixed') !== 'fixed') continue
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, activeCycle.startDate, activeCycle.endDate, exp.end_date ?? undefined)
      if (!occs.length) continue
      const isLayby = !!exp.lay_by_id
      const sortedVersions = [...(exp.expense_amount_versions ?? [])].sort(byOldest)
      const layby = isLayby ? rawLayBys.find((l: any) => l.id === exp.lay_by_id) : null

      for (const occDate of occs) {
        if (occDate < t) continue // only upcoming occurrences count as "remaining"

        let amountCents: number
        let subLabel: string
        if (isLayby) {
          const match = sortedVersions.find((sv: any) => sv.effective_from === occDate)
          amountCents = match?.amount_cents ?? 0
          const idx = sortedVersions.findIndex((sv: any) => sv.effective_from === occDate)
          const totalPayments = layby?.payments_total ?? sortedVersions.length
          subLabel = `payment ${idx >= 0 ? idx + 1 : '?'} of ${totalPayments}`
        } else {
          const v = versionForDate(exp.expense_amount_versions, occDate)
          amountCents = v?.amount_cents ?? 0
          subLabel = 'fixed'
        }

        items.push({
          name: exp.name,
          date: occDate,
          amountCents,
          isLayby,
          icon: exp.icon || (isLayby ? 'gift' : guessIcon(exp.name)),
          subLabel,
        })
      }
    }

    items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    return items
  }

  const varExpensesInCycle = rawExpenses
    .filter(e => e.mode === 'variable')
    .map(exp => {
      const occs = getOccurrencesInRange(exp.anchor_date, exp.frequency, activeCycle.startDate, activeCycle.endDate)
      if (!occs.length) return null
      const v = versionForDate(exp.expense_amount_versions, activeCycle.startDate)
      return { id: exp.id, name: exp.name, estimatedCents: (v?.amount_cents ?? 0) * occs.length }
    })
    .filter(Boolean) as { id: string, name: string, estimatedCents: number }[]

  

  const confirmedVarTotalCents = varExpensesInCycle.reduce((sum, e) =>
    sum + Math.round(parseFloat(closeVarActuals[e.id] || '0') * 100), 0)
  const closeRealCents = Math.round(parseFloat(closeRealBalance || '0') * 100)

  // The pay for the NEXT cycle lands the night before it starts. If it's
  // already sitting in the balance being entered, hold it back so the next
  // cycle opens pre-pay — the engine then counts it as income on payday.
  const nextCycleStartDate = addOneDay(activeCycle.endDate)
  const scheduledPayCents  = primaryIncome
    ? (versionForDate(primaryIncome.income_amount_versions, nextCycleStartDate)?.amount_cents ?? 0)
    : 0
  const payLandedCents    = closePayLanded ? Math.round(parseFloat(closePayAmount || '0') * 100) : 0
  const adjustedRealCents = closeRealCents - payLandedCents
  const unaccountedCents  = closeRealCents > 0 ? adjustedRealCents - activeCycle.committedClosingBalanceCents : 0

  const laybyTotalCents      = Math.round(parseFloat(laybyTotal || '0') * 100)
  const laybyCountNum        = parseInt(laybyPayments || '0', 10) || 0
  const laybyDates           = computeLaybySchedule(laybyFirstDate, laybyFrequency, laybyCountNum)
  const laybyPerPaymentCents = laybyCountNum > 0 ? Math.floor(laybyTotalCents / laybyCountNum) : 0
  const laybyRemainderCents  = laybyTotalCents - laybyPerPaymentCents * laybyCountNum
  const laybyEndDate         = laybyDates[laybyDates.length - 1]

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
    const initVars: Record<string, string> = {}
    for (const e of varExpensesInCycle) initVars[e.id] = String(e.estimatedCents / 100)
    setCloseVarActuals(initVars)
    setClosePayLanded(null)
    setClosePayAmount(scheduledPayCents ? String(scheduledPayCents / 100) : '')
    setCloseRealBalance(''); setCloseStep(0); setCloseOpen(true)
  }

  function openAddToCycle() {
    setAddType(null); setAddStep(0)
    setOneoffName(''); setOneoffAmount(''); setOneoffDate(activeCycle.startDate)
    setIncomeName(''); setIncomeAmount(''); setIncomeDate(activeCycle.startDate); setIncomeCertain(false)
    setLaybyName(''); setLaybyTotal(''); setLaybyFrequency('fortnightly')
    setLaybyPayments('4'); setLaybyFirstDate('')
    setAddError(''); setAddOpen(true)
  }
  function closeAddSheet() {
    setAddOpen(false); setAddType(null); setAddStep(0); setAddError('')
  }
  function selectAddType(t: 'oneoff' | 'income' | 'layby') {
    setAddType(t); setAddStep(1); setAddError('')
    if (t === 'income') {
      setIncomeName(''); setIncomeAmount('')
      setIncomeDate(activeCycle.startDate); setIncomeCertain(false)
    }
    if (t === 'layby') {
      setLaybyName(''); setLaybyTotal(''); setLaybyFrequency('fortnightly')
      setLaybyPayments('4'); setLaybyFirstDate(activeCycle.startDate)
    }
  }

  // NEW — open the Salary / recurring income edit sheet
  function openIncomeEdit(cd: any) {
    const src = rawIncome.find((s: any) => s.id === cd.incomeId)
    if (!src) return
    setIncomeEditItem({ ...cd, src })
    setIncomeEditScope(null); setIncomeEditStep(0)
    setIncomeEditAmount(cd.unitCents ? String(cd.unitCents / 100) : '')
    setIncomeEditFrequency(src.frequency)
    setIncomeEditAnchor(src.anchor_date)
    setIncomeEditError('')
  }

  // NEW — save Salary edits. Amount follows the same "just this cycle" vs
  // "from this date onward" versioning as fixed-expense edits. Frequency and
  // payday aren't versioned (income_sources has no history table for those
  // fields), so they apply immediately — acceptable for now since the common
  // case (a real job change) happens at a cycle boundary anyway.
  async function applyIncomeEdit() {
    if (!incomeEditItem) return
    const amountCents = Math.round(parseFloat(incomeEditAmount || '0') * 100)
    const amountChanged = amountCents > 0 && amountCents !== incomeEditItem.unitCents
    if (amountChanged && !incomeEditScope) {
      setIncomeEditError('Choose when the new amount applies.'); return
    }
    setIncomeEditSaving(true); setIncomeEditError('')
    try {
      if (amountChanged) {
        const { error: e1 } = await supabase.from('income_amount_versions').insert({
          income_source_id: incomeEditItem.incomeId,
          amount_cents: amountCents,
          effective_from: activeCycle.startDate,
        })
        if (e1) throw e1
        if (incomeEditScope === 'occurrence') {
          const nextStart = cycles[activeIdx + 1]?.startDate ?? addOneDay(activeCycle.endDate)
          const { error: e2 } = await supabase.from('income_amount_versions').insert({
            income_source_id: incomeEditItem.incomeId,
            amount_cents: incomeEditItem.unitCents,
            effective_from: nextStart,
          })
          if (e2) throw e2
        }
      }

      const freqChanged   = incomeEditFrequency !== incomeEditItem.src.frequency
      const anchorChanged = incomeEditAnchor    !== incomeEditItem.src.anchor_date
      if (freqChanged || anchorChanged) {
        const { error: e3 } = await supabase.from('income_sources')
          .update({ frequency: incomeEditFrequency, anchor_date: incomeEditAnchor })
          .eq('id', incomeEditItem.incomeId)
        if (e3) throw e3
      }

      setIncomeEditItem(null); reload()
    } catch (e: any) { setIncomeEditError(e.message) }
    finally { setIncomeEditSaving(false) }
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
        .insert({ profile_id: userId, account_id: accountId, name: oneoffName.trim(), frequency: 'once', anchor_date: oneoffDate, mode: 'fixed' })
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

  async function saveIncome() {
    const amountCents = Math.round(parseFloat(incomeAmount || '0') * 100)
    if (!incomeName.trim() || !amountCents || !incomeDate) {
      setAddError('Name, amount and date are required.'); return
    }
    setAddSaving(true); setAddError('')
    try {
      const { data: src, error: e1 } = await supabase
        .from('income_sources')
        .insert({
          profile_id: userId,
          account_id: accountId,
          name: incomeName.trim(),
          frequency: 'once',
          anchor_date: incomeDate,
          is_potential: !incomeCertain,
        })
        .select().single()
      if (e1) throw e1
      const { error: e2 } = await supabase
        .from('income_amount_versions')
        .insert({ income_source_id: src.id, amount_cents: amountCents, effective_from: incomeDate })
      if (e2) throw e2
      closeAddSheet(); reload()
    } catch (e: any) { setAddError(e.message) }
    finally { setAddSaving(false) }
  }

  // Amount changes are written as a NEW version row rather than updated in
  // place. The old code ran an UPDATE filtered only by expense_id /
  // income_source_id — no effective_from — so every version row for the parent
  // was rewritten to the new amount, flattening any history the record had
  // accumulated. Inserting also matches how every other edit path in the app
  // works, and leaves the trail an activity log will want.
  //
  // effective_from is the occurrence's own date, not today: a future-dated
  // one-off written at today's date would be superseded by the original row
  // sitting on the later anchor date, and versionForDate would return the stale
  // amount for the cycle that actually contains the occurrence.
  async function saveOneOffEdits() {
    const amountCents = Math.round(parseFloat(oneOffAmt || '0') * 100)
    if (!oneOffName.trim() || !amountCents) {
      setOneOffError('Name and amount are required.'); return
    }
    setOneOffSaving(true); setOneOffError('')
    try {
      const effectiveFrom = oneOffItem.oneOffDate
      const amountChanged = amountCents !== oneOffItem.unitCents

      if (oneOffItem.oneOffKind === 'income') {
        const { error: e1 } = await supabase
          .from('income_sources')
          .update({ name: oneOffName.trim(), is_potential: !oneOffCertain })
          .eq('id', oneOffItem.incomeId)
        if (e1) throw e1
        if (amountChanged) {
          const { error: e2 } = await supabase
            .from('income_amount_versions')
            .insert({
              income_source_id: oneOffItem.incomeId,
              amount_cents: amountCents,
              effective_from: effectiveFrom,
            })
          if (e2) throw e2
        }
      } else {
        const { error: e1 } = await supabase
          .from('expenses')
          .update({ name: oneOffName.trim() })
          .eq('id', oneOffItem.expenseId)
        if (e1) throw e1
        if (amountChanged) {
          const { error: e2 } = await supabase
            .from('expense_amount_versions')
            .insert({
              expense_id: oneOffItem.expenseId,
              amount_cents: amountCents,
              effective_from: effectiveFrom,
            })
          if (e2) throw e2
        }
      }
      setOneOffItem(null); reload()
    } catch (e: any) { setOneOffError(e.message) }
    finally { setOneOffSaving(false) }
  }

  async function deleteOneOff() {
    if (!oneOffItem || oneOffDeleting) return
    setOneOffDeleting(true); setOneOffError('')
    try {
      if (oneOffItem.oneOffKind === 'income') {
        const { error } = await supabase
          .from('income_sources').update({ is_active: false }).eq('id', oneOffItem.incomeId)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('expenses').update({ is_active: false }).eq('id', oneOffItem.expenseId)
        if (error) throw error
      }
      setOneOffItem(null); reload()
    } catch (e: any) { setOneOffError(e.message) }
    finally { setOneOffDeleting(false) }
  }

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
          account_id: accountId,
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
          account_id: accountId,
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

  async function applyEdit() {
    if (!editScope || !editAmountCents) return
    setEditSaving(true); setEditError('')
    try {
      const { error: e1 } = await supabase.from('expense_amount_versions').insert({
        expense_id: editCard.expenseId,
        amount_cents: editAmountCents,
        effective_from: activeCycle.startDate,
      })
      if (e1) throw e1

      if (editScope === 'occurrence') {
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

  async function applyFreeze() {
    if (!closeRealCents) return
    setCloseSaving(true)
    try {
      for (const e of varExpensesInCycle) {
        const actualStr = closeVarActuals[e.id]
        if (!actualStr) continue
        const actualCents = Math.round(parseFloat(actualStr) * 100)
        const { error } = await supabase.from('cycle_expense_actuals').insert({
          cycle_id: activeCycle.id ?? null,
          account_id: accountId,
          expense_id: e.id,
          actual_amount_cents: actualCents,
        })
        if (error) console.warn('actual insert failed:', error.message)
      }

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

      const nextStart = addOneDay(activeCycle.endDate)
      const freq      = primaryIncome?.frequency ?? 'fortnightly'
      const nsDate    = parseDate(nextStart)
      let nextEnd: string
      if      (freq === 'weekly')      nextEnd = formatDate(addDays(nsDate, 6))
      else if (freq === 'fortnightly') nextEnd = formatDate(addDays(nsDate, 13))
      else if (freq === 'monthly')     nextEnd = formatDate(addDays(addMonths(nsDate, 1), -1))
      else                             nextEnd = formatDate(addDays(addYears(nsDate, 1), -1))

      const { error: e2 } = await supabase.from('cycles').insert({
        profile_id: userId,
        account_id: accountId,
        start_date: nextStart,
        end_date: nextEnd,
        opening_balance_cents: closeRealCents,
        contingency_cents: 0,
        is_closed: false,
      })
      if (e2) throw e2

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

  async function applyConfirm() {
    if (!varAmountCents) return
    setVarSaving(true); setVarError('')
    try {
      const { error: e1 } = await supabase.from('expense_amount_versions').insert({
        expense_id: varCard.expenseId,
        amount_cents: varAmountCents,
        effective_from: activeCycle.startDate,
      })
      if (e1) throw e1

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

  function entriesForExpenseInCycle(expenseId: string) {
    return rawBudgetEntries.filter(e =>
      e.expense_id === expenseId &&
      e.spent_date >= activeCycle.startDate &&
      e.spent_date <= activeCycle.endDate
    )
  }
  function toggleQuickAdd(expenseId: string) {
    setOpenQuickAdd(prev => prev === expenseId ? null : expenseId)
    setQuickAddAmount('')
  }
  async function saveQuickAdd(expenseId: string) {
    const cents = Math.round(parseFloat(quickAddAmount || '0') * 100)
    if (!cents) return
    try {
      await addBudgetSpendEntry(accountId, expenseId, cents, 'Quick add', today())
      setOpenQuickAdd(null); setQuickAddAmount(''); reload()
    } catch (e: any) { alert('Could not log spend: ' + e.message) }
  }
  function openLog(cd: any) { setLogItem(cd); setEditingEntryId(null) }
  function closeLog() { setLogItem(null); setEditingEntryId(null) }
  function startEditEntry(entry: any) {
    setEditingEntryId(entry.id)
    setEditEntryAmount(String(entry.amount_cents / 100))
    setEditEntryLabel(entry.label)
  }
  async function saveEditEntry(entry: any) {
    const cents = Math.round(parseFloat(editEntryAmount || '0') * 100)
    if (!cents) return
    try {
      await updateBudgetSpendEntry(entry.id, cents, editEntryLabel)
      setEditingEntryId(null); reload()
    } catch (e: any) { alert('Could not update entry: ' + e.message) }
  }
  async function deleteEntry(entry: any) {
    try { await deleteBudgetSpendEntry(entry.id); reload() }
    catch (e: any) { alert('Could not delete entry: ' + e.message) }
  }

  const cards        = buildCards()
  const incomeCards  = cards.filter(c => c.iconClass === 'inc' || c.iconClass === 'pot')
  const fixedCards   = cards.filter(c => c.iconClass === 'fix')
  const varCards     = cards.filter(c => c.iconClass === 'var')
  const budgetCards  = cards.filter(c => c.iconClass === 'base')
  const incomeTotalCents = incomeCards.filter(c => !c.ghost).reduce((s, c) => s + (c.totalCents ?? 0), 0)
  const fixedTotalCents  = fixedCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)
  const varTotalCents    = varCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)
  // Past roughly three months the projection is built entirely on today's
  // income and expenses. Drawing it as firmly as next fortnight would claim
  // more than the app knows, so it fades.
  const farFromIdx = currentIdx + 7

  const budgetTotalCents = budgetCards.reduce((s, c) => s + (c.totalCents ?? 0), 0)

  // Budgets set higher than you ever actually spend make every cycle look
  // tighter than it is, and push wishlist items out of reach for no real
  // reason. The app does not quietly start forecasting on averages — a budget
  // is a ceiling — it just says when the ceiling no longer matches reality.
  const baselineAdvice = baselineChecks(rawExpenses, rawBudgetEntries, rawStoredCycles)
    .filter(b => !dismissedBaseline.includes(b.expenseId))
  // ── credit line for the focused cycle ──────────────────────────────
  // Derived from the cycle result, not from buildCards(): a credit payment is
  // not an expense row, so it never enters the `cards` array. Rendering it as
  // its own section keeps that distinction visible rather than disguising a
  // derived value as a stored one.
  const creditPaymentCents = activeCycle.creditPaymentCents ?? 0
  const creditMinimumCents = activeCycle.creditMinimumCents ?? 0
  const creditExtraCents   = activeCycle.creditExtraCents ?? 0
  const creditLeftCents    = activeCycle.creditClosingBalanceCents ?? 0
  // ── savings for this cycle ────────────────────────────────────────
  // The amounts come from the engine, which derives them from each goal. This
  // just works out progress and state for display.
  const savingsLines = (activeCycle.savingsLines ?? []) as any[]
  const savingsTotalCents = activeCycle.savingsTotalCents ?? 0
  const showSavings = !activeCycle.isHistorical && savingsLines.length > 0

  function goalRow(goalId: string) {
    return savingsGoals.find((g: any) => g.id === goalId)
  }

  /** What has actually been confirmed, or a corrected figure if one was given. */
  function savedSoFar(goalId: string): number {
    const g = goalRow(goalId)
    if (!g) return 0
    if (g.adjusted_total_cents != null) return g.adjusted_total_cents
    return savingsDone
      .filter((c: any) => c.savings_goal_id === goalId)
      .reduce((sum: number) => sum + g.per_cycle_cents, 0)
  }

  function isSetAside(goalId: string): boolean {
    return savingsDone.some((c: any) =>
      c.savings_goal_id === goalId && c.cycle_start === activeCycle.startDate)
  }

  /** Where the plan says you should be by now — the tick on the progress bar. */
  function planSaysBy(goalId: string): number {
    const g = goalRow(goalId)
    if (!g) return 0
    const start = parseDate(g.start_cycle_start).getTime()
    const here  = parseDate(activeCycle.startDate).getTime()
    const days = Math.max(1,
      Math.round((parseDate(activeCycle.endDate).getTime() -
                  parseDate(activeCycle.startDate).getTime()) / 86400000) + 1)
    const elapsed = Math.max(0, Math.round((here - start) / 86400000 / days))
    return Math.min(g.target_cents, elapsed * g.per_cycle_cents)
  }

  const showCredit         = !activeCycle.isHistorical && creditPaymentCents > 0
  // Progress is against the balance when the strategy was committed, not the
  // original purchase — a revolving balance has no single starting point.
  const creditPct = rawCredit?.current_balance_cents
    ? Math.min(100, Math.max(0, Math.round((1 - creditLeftCents / rawCredit.current_balance_cents) * 100)))
    : 0

  // ── credit: what state is this cycle's payment in? ────────────────
  // Three states, and only one action is ever offered:
  //   before the due date  -> adjust
  //   due date passed      -> confirm it went out
  //   confirmed            -> nothing, and the cycle is locked
  const creditCycleDays = activeCycle.endDate && activeCycle.startDate
    ? Math.round((parseDate(activeCycle.endDate).getTime() - parseDate(activeCycle.startDate).getTime()) / 86400000) + 1
    : 14

  const creditDueDate = rawCredit ? dueDateInCycle(rawCredit, activeCycle.startDate, creditCycleDays) : null
  const creditIsPaid  = creditPaid.some((p: any) => p.cycle_start === activeCycle.startDate)
  const creditDuePassed = !!creditDueDate && creditDueDate < today()
  const creditState: 'before' | 'due' | 'paid' =
    creditIsPaid ? 'paid' : creditDuePassed ? 'due' : 'before'

  // ── what a different top-up would do ──────────────────────────────
  // Recomputed live while the sheet is open. Two things move together: the
  // card clears sooner or later, and the account has more or less left in it —
  // and because payments accumulate, a bigger one can break a cycle further
  // out rather than this one.
  const creditModel = rawCredit ? creditModelFrom(rawCredit) : null
  const creditMinDue = rawCredit
    ? buildMinimumDueSchedule(rawCredit, activeCycle.startDate, creditCycleDays)
    : () => true
  const standingExtra = rawCredit?.strategy_extra_cents ?? 0
  const cardBalanceNow = activeCycle.creditOpeningBalanceCents ?? 0

  function creditWhatIf(extra: number, scope: 'once' | 'always') {
    if (!creditModel) return null
    const extraFor = (i: number) => (scope === 'always' ? extra : (i === 0 ? extra : standingExtra))
    return runCardForward(cardBalanceNow, creditModel, extraFor, creditCycleDays, creditMinDue)
  }

  const creditPlanNow = creditWhatIf(creditExtraCents, 'always')
  const creditPlanNew = adjOpen ? creditWhatIf(adjExtra, adjScope) : null

  // Account balances under the candidate plan. Start from what the forecast
  // already says, then apply the DIFFERENCE in cumulative payments — payments
  // add up, so cycle 5 carries five of them, not one.
  // Enough bars to cover most payoff plans. Anything longer says so underneath
  // rather than letting the chart imply it is the whole story.
  const CREDIT_BARS = 18

  const creditBankSeries: number[] = (() => {
    if (!creditPlanNew || !creditPlanNow) return []
    const out: number[] = []
    let deltaSoFar = 0
    for (let i = 0; i < Math.min(cycles.length, CREDIT_BARS); i++) {
      const wasPay = creditPlanNow.lines[i]?.paymentCents ?? 0
      const nowPay = creditPlanNew.lines[i]?.paymentCents ?? 0
      deltaSoFar += (nowPay - wasPay)
      out.push((cycles[i]?.committedClosingBalanceCents ?? 0) - deltaSoFar)
    }
    return out
  })()

  const creditWorstBank = creditBankSeries.length ? Math.min(...creditBankSeries) : 0
  const creditWorstIdx  = creditBankSeries.indexOf(creditWorstBank)
  const creditBaseYear  = baseYearOf(cycles)

  /* ── savings actions ──────────────────────────────────────────────
   * Unlike a credit payment there is no due date — you can move savings any
   * day of the cycle — so "set aside" is offered straight away rather than
   * waiting for a date to pass.
   */
  async function toggleSetAside(goalId: string) {
    setSavBusy(true)
    try {
      if (isSetAside(goalId)) {
        await unconfirmSavingsContribution(goalId, activeCycle.startDate)
      } else {
        await confirmSavingsContribution(goalId, accountId, activeCycle.startDate)
      }
      reload()
    } catch (e: any) { alert('Could not update: ' + e.message) }
    finally { setSavBusy(false) }
  }

  function openSavAdjust(goal: any) {
    const line = savingsLines.find((l: any) => l.goalId === goal.id)
    setSavAdjAmount(String((line?.amountCents ?? goal.per_cycle_cents) / 100))
    setSavAdjScope('once')
    setSavAdjust(goal)
  }

  async function saveSavAdjust() {
    if (!savAdjust) return
    const cents = Math.max(0, Math.round(parseFloat(savAdjAmount || '0') * 100))
    setSavBusy(true)
    try {
      if (savAdjScope === 'always') {
        // New standing amount. Clear this cycle's exception too, or the old
        // one-off would override the plan you just set.
        await updateSavingsGoal(savAdjust.id, { per_cycle_cents: cents })
        await clearSavingsOverride(savAdjust.id, activeCycle.startDate)
      } else if (cents === savAdjust.per_cycle_cents) {
        await clearSavingsOverride(savAdjust.id, activeCycle.startDate)
      } else {
        await setSavingsOverride(savAdjust.id, accountId, activeCycle.startDate, cents)
      }
      setSavAdjust(null); reload()
    } catch (e: any) { alert('Could not save: ' + e.message) }
    finally { setSavBusy(false) }
  }

  function openSavFix(goal: any) {
    setSavFixAmount(String(savedSoFar(goal.id) / 100))
    setSavFixTotal(goal)
  }

  async function saveSavFix() {
    if (!savFixTotal) return
    const cents = Math.max(0, Math.round(parseFloat(savFixAmount || '0') * 100))
    setSavBusy(true)
    try {
      // A correction is a statement about reality, so it wins over the ticks.
      await updateSavingsGoal(savFixTotal.id, {
        adjusted_total_cents: cents,
        adjusted_at: new Date().toISOString(),
      })
      setSavFixTotal(null); setSavTarget(null); reload()
    } catch (e: any) { alert('Could not save: ' + e.message) }
    finally { setSavBusy(false) }
  }

  async function stopSaving(goal: any) {
    setSavBusy(true)
    try {
      await updateSavingsGoal(goal.id, { status: 'cancelled' })
      setSavTarget(null); reload()
    } catch (e: any) { alert('Could not stop: ' + e.message) }
    finally { setSavBusy(false) }
  }

  async function completeGoal(goal: any) {
    setSavBusy(true)
    try {
      await updateSavingsGoal(goal.id, { status: 'completed' })
      setSavTarget(null); reload()
    } catch (e: any) { alert('Could not close: ' + e.message) }
    finally { setSavBusy(false) }
  }

  function openCreditAdjust() {
    setAdjExtra(creditExtraCents)
    setAdjScope('once')
    setAdjOpen(true)
  }

  async function saveCreditAdjust() {
    if (!rawCredit) return
    setAdjSaving(true)
    try {
      if (adjScope === 'always') {
        // New standing amount. Clear this cycle's exception too, otherwise the
        // old one-off would override the plan you just set.
        await updateCreditStrategyExtra(rawCredit.id, adjExtra)
        await clearCreditExtraOverride(rawCredit.id, activeCycle.startDate)
      } else if (adjExtra === standingExtra) {
        // Back in line with the plan — drop the exception rather than storing
        // a copy of a number that already lives on the plan.
        await clearCreditExtraOverride(rawCredit.id, activeCycle.startDate)
      } else {
        await setCreditExtraOverride(rawCredit.id, accountId, activeCycle.startDate, adjExtra)
      }
      setAdjOpen(false)
      reload()
    } catch (e: any) {
      alert('Could not save: ' + e.message)
    } finally { setAdjSaving(false) }
  }

  async function markCreditPaid() {
    if (!rawCredit) return
    try {
      await confirmCreditPayment(rawCredit.id, accountId, activeCycle.startDate)
      reload()
    } catch (e: any) { alert('Could not confirm: ' + e.message) }
  }

  async function undoCreditPaid() {
    if (!rawCredit) return
    try {
      await unconfirmCreditPayment(rawCredit.id, activeCycle.startDate)
      reload()
    } catch (e: any) { alert('Could not undo: ' + e.message) }
  }

  const aboveFloor   = activeCycle.committedClosingBalanceCents - floorCents
  const status       = cycleStatus(activeIdx)
  const editAmountCents = Math.round(parseFloat(editAmount || '0') * 100)
  const varAmountCents  = Math.round(parseFloat(varAmount  || '0') * 100)

  // NEW — Available-to-spend carousel card calculations
  const fixedOccurrences  = buildFixedOccurrences()
  const nextPayments      = fixedOccurrences.slice(0, 3)
  const budgetSpentSoFarCents = budgetCards.reduce(
    (sum, c) => sum + entriesForExpenseInCycle(c.expenseId).reduce((s: number, e: any) => s + e.amount_cents, 0),
    0
  )
  // Built from the engine's own committedClosingBalanceCents (which already correctly
  // nets every fixed/lay-by payment — past and future — plus the full estimate total)
  // rather than recomputing fixed-remaining by occurrence date, which under-subtracted
  // any fixed/lay-by payment that had already happened earlier in the cycle.
  // We add back the unspent portion of the budget baseline, since "available to spend"
  // only counts budget spend actually logged, not the full baseline.
  // availableToSpendCents needs no change for credit: committedClosingBalanceCents
  // already has the card payment netted out by the engine, so the headline
  // number is correct the moment a strategy is committed.
  const availableToSpendCents = activeCycle.committedClosingBalanceCents + (budgetTotalCents - budgetSpentSoFarCents)
  const daysToNextCycle = daysUntil(addOneDay(activeCycle.endDate))

  const cycleTotalDaysNum = Math.max(1, Math.round(
    (parseDate(activeCycle.endDate).getTime() - parseDate(activeCycle.startDate).getTime()) / 86400000
  ) + 1)
  const cycleDayNum = Math.min(cycleTotalDaysNum, Math.max(1, Math.round(
    (parseDate(today()).getTime() - parseDate(activeCycle.startDate).getTime()) / 86400000
  ) + 1))
  const cycleDayPct = Math.min(100, Math.round((cycleDayNum / cycleTotalDaysNum) * 100))

  const budgetPctRaw = budgetTotalCents > 0 ? Math.round((budgetSpentSoFarCents / budgetTotalCents) * 100) : 0
  const budgetPctClamped = Math.min(100, budgetPctRaw)
  const budgetRingColor = budgetPctRaw >= 100 ? 'var(--floor)' : budgetPctRaw >= 80 ? 'var(--warn)' : 'var(--pos)'

  const OUTER_R = 25, OUTER_C = 2 * Math.PI * OUTER_R
  const INNER_R = 17, INNER_C = 2 * Math.PI * INNER_R
  const outerDashoffset = OUTER_C * (1 - cycleDayPct / 100)
  const innerDashoffset = INNER_C * (1 - budgetPctClamped / 100)

  const certIconBase: CSSProperties = {
    width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
    fontSize: 15, fontWeight: 700, flex: '0 0 auto',
    background: 'var(--pos-s)', color: 'var(--pos)',
  }

  // ── render ────────────────────────────────────────────────────────
  return (
    <>
      <div className="scrollarea">

        {variant === 'cycle' && (
          <div className="cyc-carousel-wrap">
            <div className="cyc-carousel-label">This cycle · at a glance</div>
            <div className="cyc-carousel" ref={carouselRef} onScroll={handleCarouselScroll}>

              <div className="cyc-card">
                <div className="cyc-card-hdr">
                  <div className="cyc-card-title next">Next payments</div>
                </div>
                {nextPayments.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--mut)' }}>Nothing scheduled this cycle.</div>
                )}
                {nextPayments.map((p, i) => (
                  <div className="np-row" key={i}>
                    <div className="np-ic" style={{
                      background: p.isLayby ? 'var(--event-s)' : 'var(--acc-s)',
                      color: p.isLayby ? 'var(--event)' : 'var(--acc)',
                    }}>
                      <ExpenseIcon name={p.icon} size={16} />
                    </div>
                    <div className="np-tx">
                      <div className="np-nm">{p.name}</div>
                      <div className="np-dt">{fmtDate(p.date)} · {p.subLabel}</div>
                    </div>
                    <div className="np-amt">{fmt(p.amountCents, false)}</div>
                  </div>
                ))}
              </div>

              <div className="cyc-card ring-corner">
                <div className="cyc-card-hdr">
                  <div className="cyc-card-title spend">Available to spend</div>
                </div>
                <svg className="ring-svg-dual" width="58" height="58" viewBox="0 0 58 58">
                  <circle className="ring-track" cx="29" cy="29" r={OUTER_R} strokeWidth="3" />
                  <circle className="ring-fill cyc" cx="29" cy="29" r={OUTER_R} strokeWidth="3"
                    strokeDasharray={OUTER_C} strokeDashoffset={outerDashoffset} />
                  <circle className="ring-track" cx="29" cy="29" r={INNER_R} strokeWidth="6" />
                  <circle className="ring-fill" cx="29" cy="29" r={INNER_R} strokeWidth="6"
                    style={{ stroke: budgetRingColor }}
                    strokeDasharray={INNER_C} strokeDashoffset={innerDashoffset} />
                </svg>
                <div className="rs-hero">{fmt(availableToSpendCents, false)}</div>
                <div className="rs-sub">next cycle in {daysToNextCycle} days</div>
                <div className="rs-breakdown">
                  <div className="rs-line">
                    <div className="rs-dot" style={{ background: budgetRingColor }} />
                    <div className="rs-line-lbl">Budget tracked</div>
                    <div className="rs-line-val">{fmt(budgetSpentSoFarCents, false)} of {fmt(budgetTotalCents, false)}</div>
                  </div>
                </div>
              </div>

            </div>
            <div className="cyc-carousel-dots">
              <div className={`cyc-dot${activeCarouselDot === 0 ? ' active' : ''}`} />
              <div className={`cyc-dot${activeCarouselDot === 1 ? ' active' : ''}`} />
            </div>
          </div>
        )}

        {variant === 'forecast' && (
          <>
            <div className="horizon">
              {([[6, '3 months'], [13, '6 months'], [26, '12 months']] as [number, string][]).map(
                ([n, label]) => (
                  <button key={n}
                    className={horizonCycles === n ? 'on' : ''}
                    onClick={() => setHorizonCycles(n)}>
                    {label}<small>{n} cycles</small>
                  </button>
                ))}
            </div>

            <div className="graphwrap">
              <div className="graph-cap">
                <span>Projected close · {cycles.length} cycles</span>
                <span>{monthStart} → {monthEnd}</span>
              </div>
              {cycles.length > farFromIdx + 1 && (
                <div className="horizon-note">
                  Solid to {cycles[farFromIdx] ? fmtDate(cycles[farFromIdx].startDate) : 'about 3 months'} ·
                  faded after that, where the projection is only today's income and expenses carried forward
                </div>
              )}
              <svg className="proj" viewBox="0 0 340 152" aria-label="Balance projection">
                <line className="axln" x1={xLeft} y1={gTop} x2={xLeft} y2={gBot} />
                <line className="axln" x1={xLeft} y1={gBot} x2={xRight} y2={gBot} />
                {ticks.map(tv => (
                  <g key={tv}>
                    {tv !== minTick && (
                      <line className={tv === 0 && minTick < 0 ? 'axln' : 'gridln'}
                        x1={xLeft} y1={yFor(tv)} x2={xRight} y2={yFor(tv)} />
                    )}
                    <text className="axtx" x={xLeft - 4} y={yFor(tv) + 3} textAnchor="end">{fmtAxis(tv)}</text>
                  </g>
                ))}
                {floorCents > 0 && <>
                  <line className="floorln" x1={xLeft} y1={fY} x2={xRight} y2={fY} />
                  <text className="floortx" x={xLeft + 4} y={fY - 4}>{fmt(floorCents,false)} FLOOR</text>
                </>}
                <path className="area" d={`M${pts[0][0]},${pts[0][1]} ${pts.map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} L${pts[pts.length-1][0]},${zeroY} L${pts[0][0]},${zeroY} Z`} />
                <polyline className="pastln" points={pts.slice(0, splitIdx+1).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
                <polyline className="futln"
                  points={pts.slice(splitIdx, Math.max(splitIdx + 1, Math.min(farFromIdx + 1, pts.length)))
                    .map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
                {pts.length > farFromIdx + 1 && (
                  <polyline className="futln far"
                    points={pts.slice(farFromIdx).map((p:number[]) => `${p[0]},${p[1]}`).join(' ')} />
                )}
                {pts.map((p:number[], i:number) => {
                  const s = cycleStatus(i)
                  const isLow = s==='low', isPast = s==='past', isActive = i===activeIdx
                  const isFar = i > farFromIdx
                  // At 27 cycles the dots sit about 12px apart, so past the
                  // boundary only every second one is drawn.
                  if (isFar && !isActive && (i - farFromIdx) % 2 !== 0) return null
                  return (
                    <g key={i} onClick={() => setActiveIdx(i)} style={{ cursor:'pointer' }}>
                      {isActive && <circle className={`focusring${isLow?' low':''}`} cx={p[0]} cy={p[1]} r="8" />}
                      <circle className={`wp${isPast?' past':''}${isLow?' low':''}${isFar?' far':''}`}
                        cx={p[0]} cy={p[1]} r={isFar ? 3.4 : 4.2} />
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
                    className={`pill${s==='low'?' low':''}${s==='past'?' past':''}${i===activeIdx?' active':''}${i > farFromIdx ? ' far' : ''}`}
                    onClick={() => setActiveIdx(i)}
                  >
                    <div className="pd">{fmtDate(c.startDate)}</div>
                    <div className="pe">{fmt(c.committedClosingBalanceCents,false)}</div>
                    <div className="ps">{s==='now' ? 'this cycle' : `→ ${fmtDate(c.endDate)}`}</div>
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div className="cyc">
          <div className="cyc-h">
            <div className="ttl">{fmtDate(activeCycle.startDate)} – {fmtDate(activeCycle.endDate)}</div>
            <div className={`stt ${status==='past'?'frozen':status==='overdue'?'low':status}`}>
              {status==='now'?'Current':status==='past'?'Closed':status==='overdue'?'Needs closing':status==='low'?'Near floor':'Forecast'}
            </div>
          </div>
          {variant === 'forecast' && activeIdx !== currentIdx && (
            <button className="back-to-now" onClick={() => setActiveIdx(currentIdx)}>
              ← back to current cycle
            </button>
          )}
          <div className="carry">
            <span className="o">opens <b>{fmt(activeCycle.openingBalanceCents,false)}</b></span>
            <span className="arr">→</span>
            <span className="c">closes <b>{fmt(activeCycle.committedClosingBalanceCents,false)}</b></span>
          </div>
          {floorCents > 0 ? (
            <div className={`nudge${aboveFloor>=0?' ok':''}`}>
              {aboveFloor>=0
                ? <><b>{fmt(aboveFloor,false)}</b> above your floor {status==='past'?'that cycle':'this cycle'}.</>
                : <>{status==='past'?'Closed':'Closes'} <b>{fmt(Math.abs(aboveFloor),false)}</b> below your floor.</>}
            </div>
          ) : activeCycle.committedClosingBalanceCents < 0 ? (
            <div className="nudge">
              {status==='past'?'Closed':status==='overdue'?'Would close':'Closes'} <b>{fmt(Math.abs(activeCycle.committedClosingBalanceCents),false)}</b> negative {status==='past'?'that cycle':'this cycle'}.
            </div>
          ) : null}
        </div>

        {incomeCards.length > 0 && (
          <>
            <div className="section-hdr sh-inc tappable" onClick={() => toggleSec('income')}>
              <span className="sh-label">Money in</span>
              <span className="sh-right">
                <span className="sh-total">+{fmt(incomeTotalCents, false)}</span>
                <span className={`chv${openSecs.income ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.income && (
              <div className="cards">
                {incomeCards.map((cd, i) => (
                  <div key={'inc'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      if (cd.oneOff) {
                        setOneOffError(''); setOneOffName(cd.name)
                        setOneOffAmt(String(cd.totalCents / 100))
                        setOneOffCertain(!(cd.isPotential ?? true))
                        setOneOffItem(cd)
                      } else {
                        openIncomeEdit(cd)
                      }
                    }}
                  >
                    <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                    <div className="tx">
                      <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                      <div className="dt">{cd.detail}</div>
                      <div className="act-row"><span className="act">{cd.oneOff ? 'manage →' : 'edit →'}</span></div>
                    </div>
                    <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {fixedCards.length > 0 && (
          <>
            <div className="section-hdr sh-fix tappable" onClick={() => toggleSec('fixed')}>
              <span className="sh-label">Fixed expenses</span>
              <span className="sh-right">
                <span className="sh-total">−{fmt(fixedTotalCents, false)}</span>
                <span className={`chv${openSecs.fixed ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.fixed && (
              <div className="cards">
                {fixedCards.map((cd, i) => (
                  <div key={'fix'+i} className={`card${cd.dashed?' dashed':''}${cd.ghost?' ghost':''}`}
                    style={cd.oneOff ? { cursor: 'pointer' } : undefined}
                    onClick={cd.oneOff ? () => {
                      setOneOffError(''); setOneOffName(cd.name)
                      setOneOffAmt(String(cd.totalCents / 100))
                      setOneOffCertain(false)
                      setOneOffItem(cd)
                    } : undefined}
                  >
                    <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                    <div className="tx">
                      <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                      <div className="dt">{cd.detail}</div>
                      <div className="act-row">
                        {cd.act === 'edit' && <span className="act" onClick={() => openEdit(cd)}>edit →</span>}
                        {cd.act === 'oneoff' && <span className="act">manage →</span>}
                        {cd.laybyPct != null && (
                          <div className="exp-prog" style={{ flex: 1, marginTop: 0 }}>
                            <div className="fill" style={{ width: cd.laybyPct + '%', background: 'var(--event)' }} />
                          </div>
                        )}
                      </div>
                    </div>
                    <div className={`vl ${cd.valueClass}`}>{cd.value}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {showSavings && (
          <>
            <div className="section-hdr sh-sav tappable" onClick={() => toggleSec('savings')}>
              <span className="sh-label">Savings</span>
              <span className="sh-right">
                <span className="sh-total">−{fmt(savingsTotalCents, false)}</span>
                <span className={`chv${openSecs.savings ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.savings && (
              <div className="cards">
                {savingsLines.map((line: any) => {
                  const goal = goalRow(line.goalId)
                  if (!goal) return null
                  const done   = isSetAside(line.goalId)
                  const saved  = savedSoFar(line.goalId)
                  const target = goal.target_cents
                  const plan   = planSaysBy(line.goalId)
                  const pct     = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0
                  const planPct = target > 0 ? Math.min(100, Math.round((plan  / target) * 100)) : 0
                  const behind  = plan - saved
                  return (
                    <div key={line.goalId} className="card" onClick={() => setSavTarget(goal)}>
                      <div className="ic sav">◷</div>
                      <div className="tx">
                        <div className="nm">
                          {goal.name}
                          {done
                            ? <span className="chip sav-ok">set aside ✓</span>
                            : <span className="chip sav-pend">not yet</span>}
                          {behind > 0 && !done && <span className="chip sav-behind">behind</span>}
                          {line.isOverride && <span className="chip drv">this cycle only</span>}
                        </div>
                        <div className="dt">
                          {fmt(saved, false)} of {fmt(target, false)} · {fmt(line.amountCents, false)} this cycle
                          {behind > 0 && <> · <b style={{ color: 'var(--warn)' }}>{fmt(behind, false)} behind plan</b></>}
                        </div>
                        <div className="act-row">
                          {/* The tick on the bar is where the plan says you should be.
                              The gap between it and the green is the honest part. */}
                          <div className="exp-prog sav-prog" style={{ flex: 1, marginTop: 0 }}>
                            <div className="fill" style={{ width: pct + '%', background: 'var(--pos)' }} />
                            {planPct > 0 && planPct < 100 && (
                              <div className="plan-tick" style={{ left: planPct + '%' }} />
                            )}
                          </div>
                          <button className="act" type="button"
                            style={{ color: done ? 'var(--mut)' : 'var(--pos)' }}
                            disabled={savBusy}
                            onClick={e => { e.stopPropagation(); toggleSetAside(line.goalId) }}>
                            {done ? 'undo' : 'set aside →'}
                          </button>
                        </div>
                      </div>
                      <div className="vl">−{fmt(line.amountCents, false)}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {showCredit && (
          <>
            <div className="section-hdr sh-crd tappable" onClick={() => toggleSec('credit')}>
              <span className="sh-label">Credit payments</span>
              <span className="sh-right">
                <span className="sh-total">−{fmt(creditPaymentCents, false)}</span>
                <span className={`chv${openSecs.credit ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.credit && (
              <div className="cards">
                <div className="card">
                  <div className="ic crd">▭</div>
                  <div className="tx">
                    <div className="nm">
                      {rawCredit?.name ?? 'Credit card'}
                      {creditState === 'paid'
                        ? <span className="chip pd">paid ✓</span>
                        : creditState === 'due'
                          ? <span className="chip due">not confirmed</span>
                          : <span className="chip drv">planned</span>}
                      {creditExtraCents !== standingExtra && creditState !== 'paid' && (
                        <span className="chip drv">this cycle only</span>
                      )}
                    </div>
                    <div className="dt">
                      min {fmt(creditMinimumCents, false)}
                      {creditExtraCents > 0 && <> + extra {fmt(creditExtraCents, false)}</>}
                      {' · '}{fmt(creditLeftCents, false)} left
                      {creditDueDate && <> · due {fmtDate(creditDueDate)}</>}
                    </div>
                    <div className="act-row">
                      <div className="exp-prog" style={{ flex: 1, marginTop: 0 }}>
                        <div className="fill" style={{ width: creditPct + '%', background: 'var(--credit)' }} />
                      </div>
                      {creditState === 'before' && (
                        <button className="act" type="button" onClick={openCreditAdjust}>adjust →</button>
                      )}
                      {creditState === 'due' && (
                        <button className="act" type="button" style={{ color: 'var(--floor)' }} onClick={markCreditPaid}>confirm →</button>
                      )}
                      {creditState === 'paid' && (
                        <button className="act" type="button" style={{ color: 'var(--mut)' }} onClick={undoCreditPaid}>undo</button>
                      )}
                    </div>
                  </div>
                  <div className="vl">−{fmt(creditPaymentCents, false)}</div>
                </div>
              </div>
            )}
          </>
        )}

        {varCards.length > 0 && (
          <>
            <div className="section-hdr sh-var tappable" onClick={() => toggleSec('var')}>
              <span className="sh-label">Estimates</span>
              <span className="sh-right">
                <span className="sh-total">−{fmt(varTotalCents, false)}</span>
                <span className={`chv${openSecs.var ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.var && (
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
            )}
          </>
        )}

        {budgetCards.length > 0 && (
          <>
            <div className="section-hdr sh-bud tappable" onClick={() => toggleSec('budget')}>
              <span className="sh-label">Budget</span>
              <span className="sh-right">
                <span className="sh-total">−{fmt(budgetTotalCents, false)}</span>
                <span className={`chv${openSecs.budget ? ' up' : ''}`}>▾</span>
              </span>
            </div>
            {openSecs.budget && baselineAdvice.length > 0 && (
              <div className="cards" style={{ paddingBottom: 0 }}>
                {baselineAdvice.map(b => (
                  <div key={'bl' + b.expenseId} className="baseline-tip">
                    <div className="bt-ic">◷</div>
                    <div className="bt-tx">
                      <div className="bt-n">{b.name} is set higher than you spend</div>
                      <div className="bt-d">
                        Budgeted <b>{fmt(b.baselineCents, false)}</b>, averaged{' '}
                        <b>{fmt(b.averageCents, false)}</b> over {b.cyclesCounted} closed cycles.
                        The forecast assumes the full {fmt(b.baselineCents, false)} every cycle,
                        so it reads tighter than it is.
                      </div>
                    </div>
                    <button className="bt-x"
                      onClick={() => setDismissedBaseline(d => [...d, b.expenseId])}
                      aria-label="Dismiss">×</button>
                  </div>
                ))}
              </div>
            )}
            {openSecs.budget && (
              <div className="cards">
                {budgetCards.map((cd, i) => {
                  const entries = entriesForExpenseInCycle(cd.expenseId)
                  const spent = entries.reduce((s, e) => s + e.amount_cents, 0)
                  const rawPct = cd.totalCents > 0 ? Math.round((spent / cd.totalCents) * 100) : 0
                  const pct = Math.min(100, rawPct)
                  const barState = rawPct >= 100 ? 'over' : rawPct >= 80 ? 'warn' : ''
                  const quickAddOpen = openQuickAdd === cd.expenseId
                  return (
                    <div key={'bud'+i} className="budg-card">
                      <div className="budg-top" onClick={() => openLog(cd)}>
                        <div className={`ic ${cd.displayIconClass ?? cd.iconClass}`}>{cd.iconSvg ? <ExpenseIcon name={cd.iconSvg} size={20} /> : cd.icon}</div>
                        <div className="budg-tx">
                          <div className="nm">{cd.name}{cd.chips.map(([cls, label]: string[], j: number) => (<span key={j} className={`chip ${cls}`} style={chipStyle(cls)}>{label}</span>))}</div>
                          <div className="budg-sofar"><b>{fmt(spent, false)}</b> of {fmt(cd.totalCents, false)}</div>
                          <div className="budg-barwrap"><div className={`budg-bar ${barState}`} style={{ width: pct + '%' }} /></div>
                        </div>
                        <button className={`budg-plus${quickAddOpen ? ' on' : ''}`} onClick={e => { e.stopPropagation(); toggleQuickAdd(cd.expenseId) }}>{quickAddOpen ? '×' : '+'}</button>
                      </div>
                      <div className={`budg-quickadd${quickAddOpen ? ' on' : ''}`}>
                        <div className="budg-qa-inner">
                          <span className="pre">{sym}</span>
                          <input
                            type="number" inputMode="decimal" placeholder="0.00"
                            value={quickAddAmount} onChange={e => setQuickAddAmount(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onKeyDown={e => { if (e.key === 'Enter') saveQuickAdd(cd.expenseId) }}
                          />
                          <button className="budg-qa-save" onClick={e => { e.stopPropagation(); saveQuickAdd(cd.expenseId) }}>Add</button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {status !== 'past' && (
          <div style={{ padding:'14px 16px 0' }}>
            <button className="addbtn" onClick={openAddToCycle}>+ Add to this cycle</button>
          </div>
        )}

        {(status === 'now' || status === 'overdue') && (
          <>
            <button className="closebtn" onClick={openClose}>
              {status === 'overdue' ? 'Close this overdue cycle →' : 'Close this cycle →'}
            </button>
            <div className="closehint">
              {status === 'overdue'
                ? 'This cycle ended already — closing it locks in your real balance and starts the next one.'
                : "Confirms the real balance that becomes next cycle's opening."}
            </div>
          </>
        )}

      </div>

      {/* ═══ OVERLAY 1 — Edit scope ═══ */}
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
                <button className="pri" style={{ opacity: editScope ? 1 : 0.4, cursor: editScope ? 'pointer' : 'default' }}
                  onClick={() => { if (editScope) setEditStep(1) }}>Next →</button>
              </div>
            </>}
            {editStep === 1 && <>
              <h3>New amount</h3>
              <p className="sd">{editScope === 'occurrence' ? 'One-off — reverts to original next cycle.' : `Permanent from ${fmtDate(activeCycle.startDate)} onward.`}</p>
              <div className="field">
                <label>{editCard.name} — currently {editCard.unitCents ? fmt(editCard.unitCents, false) : '—'}</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
                </div>
              </div>
              {editError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{editError}</p>}
              <div className="navrow">
                <button onClick={() => setEditStep(0)}>Back</button>
                <button className="pri" style={{ opacity: editAmountCents > 0 && !editSaving ? 1 : 0.4 }} onClick={applyEdit}>
                  {editSaving ? 'Saving…' : `Apply ${editAmountCents > 0 ? fmt(editAmountCents, false) : ''}`}
                </button>
              </div>
            </>}
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 2 — Confirm variable ═══ */}
      {varCard && (
        <div className="ov" onClick={() => setVarCard(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setVarCard(null)}>×</button>
            <div className="grab" />
            <h3>Confirm {varCard.name.toLowerCase()}</h3>
            <p className="sd">Lock in the real figure — this cycle stops being an estimate. Next cycle reverts to the estimate.</p>
            <div className="field">
              <label>Actual amount for this cycle</label>
              <div className="inrow"><span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={varAmount} onChange={e => setVarAmount(e.target.value)} />
              </div>
              {varCard.estimatedCents > 0 && <p className="hint">Was estimated at {fmt(varCard.estimatedCents, false)}.</p>}
            </div>
            {varError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{varError}</p>}
            <div className="navrow">
              <button onClick={() => setVarCard(null)}>Cancel</button>
              <button className="pri" style={{ opacity: varAmountCents > 0 && !varSaving ? 1 : 0.4 }} onClick={applyConfirm}>
                {varSaving ? 'Saving…' : `Confirm ${varAmountCents > 0 ? fmt(varAmountCents, false) : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 2b — Edit income (salary / job change) ═══ */}
      {incomeEditItem && (
        <div className="ov" onClick={() => setIncomeEditItem(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setIncomeEditItem(null)}>×</button>
            <div className="grab" />
            {incomeEditStep === 0 && <>
              <h3>Change {incomeEditItem.name.toLowerCase()}</h3>
              <p className="sd">Only matters if you're changing the amount — skip this if you're just updating frequency or payday.</p>
              <div className={`opt${incomeEditScope==='occurrence'?' sel':''}`} onClick={() => setIncomeEditScope('occurrence')}>
                <div className="ot">Just this occurrence</div>
                <div className="os">A one-off override for this cycle only. Reverts next cycle.</div>
              </div>
              <div className={`opt${incomeEditScope==='forward'?' sel':''}`} onClick={() => setIncomeEditScope('forward')}>
                <div className="ot">From this date onward</div>
                <div className="os">Permanent — matches a raise or new job.</div>
              </div>
              <div className="navrow">
                <button className="pri" onClick={() => setIncomeEditStep(1)}>Next →</button>
              </div>
            </>}
            {incomeEditStep === 1 && <>
              <h3>Amount, frequency &amp; payday</h3>
              <p className="sd">
                {incomeEditScope === 'occurrence' ? 'Amount is one-off — reverts next cycle.' : 'Amount change is permanent.'}
                {' '}Frequency and payday always apply from your next cycle onward.
              </p>
              <div className="field">
                <label>Amount — currently {fmt(incomeEditItem.unitCents, false)}</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={incomeEditAmount} onChange={e => setIncomeEditAmount(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>Frequency</label>
                <div className="freq-picker">
                  {(['weekly','fortnightly','monthly','annually'] as const).map(f => (
                    <button key={f} className={`freq-opt${incomeEditFrequency === f ? ' sel' : ''}`} onClick={() => setIncomeEditFrequency(f)}>
                      {f === 'weekly' ? 'Weekly' : f === 'fortnightly' ? 'Fortnightly' : f === 'monthly' ? 'Monthly' : 'Annually'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Payday (anchor date)</label>
                <div className="inrow">
                  <input type="date" value={incomeEditAnchor} onChange={e => setIncomeEditAnchor(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }} />
                </div>
              </div>
              {incomeEditError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{incomeEditError}</p>}
              <div className="navrow">
                <button onClick={() => setIncomeEditStep(0)}>Back</button>
                <button className="pri" style={{ opacity: incomeEditSaving ? 0.6 : 1 }} onClick={applyIncomeEdit}>
                  {incomeEditSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </>}
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 3 — Close ritual ═══ */}
      {closeOpen && (
        <div className="ov" onClick={() => setCloseOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setCloseOpen(false)}>×</button>
            <div className="grab" />
            <div className="steps">{[0,1,2,3].map(i => <div key={i} className={`s${i <= closeStep ? ' done' : ''}`} />)}</div>
            {closeStep === 0 && <>
              <h3>Confirm what varied</h3>
              <p className="sd">Only the items estimated in advance — enter what actually arrived.</p>
              {varExpensesInCycle.length === 0
                ? <div className="skipnote">No variable expenses this cycle.</div>
                : varExpensesInCycle.map(e => (
                    <div key={e.id} className="field">
                      <label>{e.name} — estimated {fmt(e.estimatedCents, false)}</label>
                      <div className="inrow"><span className="pre">{sym}</span>
                        <input type="number" inputMode="decimal" value={closeVarActuals[e.id] || ''}
                          onChange={ev => setCloseVarActuals(p => ({ ...p, [e.id]: ev.target.value }))} />
                      </div>
                    </div>
                  ))
              }
              <div className="skipnote"><b>Budget items skipped on purpose.</b> The real balance is the check.</div>
            </>}
            {closeStep === 1 && <>
              <h3>Has your next pay landed?</h3>
              <p className="sd">Pay arrives the night before a cycle starts. If it's already in the balance you're about to enter, it belongs to the next cycle — not this one.</p>
              <div className={`opt${closePayLanded === false ? ' sel' : ''}`} onClick={() => setClosePayLanded(false)}>
                <div className="ot">Not yet</div>
                <div className="os">The balance you enter is used as-is.</div>
              </div>
              <div className={`opt${closePayLanded === true ? ' sel' : ''}`} onClick={() => setClosePayLanded(true)}>
                <div className="ot">Yes — it's already in there</div>
                <div className="os">Held back so the next cycle opens before pay, then counted as income on payday.</div>
              </div>
              {closePayLanded === true && (
                <div className="field">
                  <label>Amount that landed{primaryIncome ? ` — ${primaryIncome.name}` : ''}</label>
                  <div className="inrow"><span className="pre">{sym}</span>
                    <input type="number" inputMode="decimal" value={closePayAmount} onChange={e => setClosePayAmount(e.target.value)} />
                  </div>
                  <p className="hint">Defaults to your scheduled pay. Change it if the deposit differed.</p>
                </div>
              )}
            </>}
            {closeStep === 2 && <>
              <h3>Your real balance</h3>
              <p className="sd">Whatever your bank says wins — it becomes next cycle's opening balance.</p>
              <div className="field">
                <label>Actual balance right now</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={closeRealBalance} onChange={e => setCloseRealBalance(e.target.value)} placeholder="0.00" />
                </div>
                <p className="hint">We projected {fmt(activeCycle.committedClosingBalanceCents, false)}.</p>
                 {payLandedCents > 0 && closeRealCents > 0 && (
                  <p className="hint">Less {fmt(payLandedCents, false)} pay → next cycle opens at {fmt(adjustedRealCents, false)}.</p>
                )}
              </div>
            </>}
            {closeStep === 3 && <>
              <h3>Reconcile & close</h3>
              <p className="sd">The gap between forecast and reality.</p>
              <div className="recline"><span>Projected close</span><b>{fmt(activeCycle.committedClosingBalanceCents, false)}</b></div>
              {confirmedVarTotalCents > 0 && <div className="recline"><span>Confirmed variables</span><b>−{fmt(confirmedVarTotalCents, false)}</b></div>}
             <div className="recline"><span>Your real balance</span><b>{closeRealCents > 0 ? fmt(closeRealCents, false) : '—'}</b></div>
              {payLandedCents > 0 && <div className="recline"><span>Pay held for next cycle</span><b>−{fmt(payLandedCents, false)}</b></div>}
              <div className="recline"><span>Next cycle opens at</span><b>{fmt(adjustedRealCents, false)}</b></div>
              <div className={`recline${unaccountedCents >= 0 ? ' res' : ''}`}>
                <span>Unaccounted</span>
                <b>{unaccountedCents >= 0 ? '+' : '−'}{fmt(Math.abs(unaccountedCents), false)}</b>
              </div>
              <div className="skipnote" style={{ marginTop:13 }}>
                {unaccountedCents >= 0 ? 'Closing above forecast — expected when baselines run conservative.' : 'Closing below forecast — spent a little more than projected.'}
              </div>
            </>}
            {closeFrozen
              ? <div style={{ textAlign:'center', padding:'24px 0', fontFamily:"'Space Grotesk',sans-serif", fontSize:18, fontWeight:600, color:'var(--pos)' }}>✓ Cycle frozen</div>
              : <div className="navrow">
                  {closeStep > 0 && <button onClick={() => setCloseStep(s => s - 1)}>Back</button>}
                  {closeStep < 3
                    ? <button className="pri"
                        style={{ opacity: closeStep === 1 && closePayLanded === null ? 0.4 : 1 }}
                        onClick={() => { if (!(closeStep === 1 && closePayLanded === null)) setCloseStep(s => s + 1) }}>Next</button>
                    : <button className="pri" style={{ opacity: closeRealCents > 0 && !closeSaving ? 1 : 0.4 }} onClick={applyFreeze}>
                        {closeSaving ? 'Freezing…' : 'Freeze & start next cycle'}
                      </button>
                  }
                </div>
            }
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 4 — Add to this cycle ═══ */}
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
              <div className="field"><label>What's it for?</label>
                <div className="inrow"><input type="text" value={oneoffName} onChange={e => setOneoffName(e.target.value)} placeholder="e.g. Car registration" /></div>
              </div>
              <div className="field"><label>Amount</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={oneoffAmount} onChange={e => setOneoffAmount(e.target.value)} placeholder="0" />
                </div>
              </div>
              <div className="field"><label>Date</label>
                <div className="inrow">
                  <input type="date" value={oneoffDate} onChange={e => setOneoffDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }} />
                </div>
                <p className="hint">Defaults to the start of this cycle.</p>
              </div>
              {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{addError}</p>}
              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
                <button className="pri" onClick={saveOneOff} style={{ opacity: addSaving ? 0.6 : 1 }}>{addSaving ? 'Saving…' : 'Add expense'}</button>
              </div>
            </>}
            {addStep === 1 && addType === 'income' && <>
              <h3>Money coming in</h3>
              <p className="sd">A one-off amount landing in this cycle.</p>
              <div className="field"><label>What is it?</label>
                <div className="inrow"><input type="text" value={incomeName} onChange={e => setIncomeName(e.target.value)} placeholder="e.g. Tax return" /></div>
              </div>
              <div className="field"><label>Amount</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)} placeholder="0" />
                </div>
              </div>
              <div className="field"><label>Date</label>
                <div className="inrow">
                  <input type="date" value={incomeDate} onChange={e => setIncomeDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }} />
                </div>
              </div>
              <div className="field" style={{ marginBottom: 4 }}><label>How sure is it?</label></div>
              <div className={`opt${!incomeCertain ? ' sel' : ''}`} onClick={() => setIncomeCertain(false)} style={{ display:'flex', gap:11, alignItems:'flex-start' }}>
                <div style={{ ...certIconBase, border: '1.5px dashed var(--pos)' }}>?</div>
                <div><div className="ot">Not certain yet</div><div className="os">Shown on the cycle, but kept out of your forecast until it lands.</div></div>
              </div>
              <div className={`opt${incomeCertain ? ' sel' : ''}`} onClick={() => setIncomeCertain(true)} style={{ display:'flex', gap:11, alignItems:'flex-start' }}>
                <div style={certIconBase}>✓</div>
                <div><div className="ot">Confirmed</div><div className="os">Counts toward your projected balance, same as your pay.</div></div>
              </div>
              {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{addError}</p>}
              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
                <button className="pri" onClick={saveIncome} style={{ opacity: addSaving ? 0.6 : 1 }}>{addSaving ? 'Saving…' : 'Add income'}</button>
              </div>
            </>}
            {addStep === 1 && addType === 'layby' && <>
              <h3>Lay-by or instalment</h3>
              <p className="sd">A fixed total, split into equal payments. Stops itself once paid off.</p>
              <div className="field"><label>What's it for?</label>
                <div className="inrow"><input type="text" value={laybyName} onChange={e => setLaybyName(e.target.value)} placeholder="e.g. Winter coat" /></div>
              </div>
              <div className="field"><label>Total</label>
                <div className="inrow"><span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={laybyTotal} onChange={e => setLaybyTotal(e.target.value)} placeholder="0" />
                </div>
              </div>
              <div className="field"><label>Pay every</label>
                <div className="freq-picker">
                  {(['weekly','fortnightly','monthly','annually'] as const).map(f => (
                    <button key={f} className={`freq-opt${laybyFrequency === f ? ' sel' : ''}`} onClick={() => setLaybyFrequency(f)}>
                      {f === 'weekly' ? 'Weekly' : f === 'fortnightly' ? 'Fortnightly' : f === 'monthly' ? 'Monthly' : 'Annually'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field"><label>Payments</label>
                <div className="inrow"><input type="number" inputMode="numeric" value={laybyPayments} onChange={e => setLaybyPayments(e.target.value)} placeholder="4" /></div>
              </div>
              <div className="field"><label>First payment</label>
                <div className="inrow">
                  <input type="date" value={laybyFirstDate} onChange={e => setLaybyFirstDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }} />
                </div>
              </div>
              {laybyCountNum > 0 && laybyTotalCents > 0 && laybyFirstDate && (
                <div className="skipnote">
                  <b>{fmt(laybyPerPaymentCents, false)}</b> per payment × {laybyCountNum}
                  {laybyRemainderCents !== 0 && <> (last payment {fmt(laybyPerPaymentCents + laybyRemainderCents, false)}, absorbs rounding)</>}
                  <br />First {fmtDate(laybyDates[0])} · last {fmtDate(laybyEndDate)}
                </div>
              )}
              {addError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{addError}</p>}
              <div className="navrow">
                <button onClick={() => setAddStep(0)}>Back</button>
                <button className="pri" onClick={saveLayby} style={{ opacity: laybySaving ? 0.6 : 1 }}>{laybySaving ? 'Saving…' : 'Add lay-by'}</button>
              </div>
            </>}
            {addStep === 2 && addType === 'layby' && laybyResult && <>
              <h3>Lay-by added</h3>
              <p className="sd">{laybyResult.name} is now tracked across {laybyResult.count} cycles.</p>
              <div className="recline"><span>Total</span><b>{fmt(laybyResult.totalCents)}</b></div>
              <div className="recline"><span>Per payment</span><b>{fmt(laybyResult.perPaymentCents)}</b></div>
              <div className="recline res"><span>Paid off by</span><b>{fmtDate(laybyResult.endDate)}</b></div>
              <div className="navrow"><button className="pri" onClick={() => { closeAddSheet(); reload() }}>Done</button></div>
            </>}
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 5 — Budget spend log ═══ */}
      {logItem && (
        <div className="ov" onClick={closeLog}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={closeLog}>×</button>
            <div className="grab" />
            <h3>{logItem.name}</h3>
            <p className="sd">This cycle · {fmtDate(activeCycle.startDate)} – {fmtDate(activeCycle.endDate)}</p>
            {entriesForExpenseInCycle(logItem.expenseId).length === 0
              ? <div className="skipnote">No spend logged yet this cycle.</div>
              : entriesForExpenseInCycle(logItem.expenseId).map((entry: any) =>
                  editingEntryId === entry.id ? (
                    <div key={entry.id} className="entry-row">
                      <input className="entry-edit-label" value={editEntryLabel} onChange={e => setEditEntryLabel(e.target.value)} />
                      <input className="entry-edit-amount" type="number" inputMode="decimal" value={editEntryAmount} onChange={e => setEditEntryAmount(e.target.value)} />
                      <span className="entry-save" onClick={() => saveEditEntry(entry)}>save</span>
                    </div>
                  ) : (
                    <div key={entry.id} className="entry-row">
                      <div className="entry-date">{fmtDate(entry.spent_date)}</div>
                      <div className="entry-label" onClick={() => startEditEntry(entry)}>{entry.label}</div>
                      <div className="entry-amount" onClick={() => startEditEntry(entry)}>{fmt(entry.amount_cents, false)}</div>
                      <span className="entry-del" onClick={() => deleteEntry(entry)}>✕</span>
                    </div>
                  )
                )
            }
            <div className="recline" style={{ marginTop: 4 }}>
              <span>Total logged</span>
              <b>{fmt(entriesForExpenseInCycle(logItem.expenseId).reduce((s: number, e: any) => s + e.amount_cents, 0), false)}</b>
            </div>
          </div>
        </div>
      )}

      {/* ═══ OVERLAY 6 — One-off management ═══ */}
      {oneOffItem && (
        <div className="ov" onClick={() => setOneOffItem(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setOneOffItem(null)}>×</button>
            <div className="grab" />
            <h3>{oneOffItem.oneOffKind === 'income' ? 'Money coming in' : 'One-off expense'}</h3>
            <p className="sd">{oneOffItem.oneOffDateStr} · one-off</p>
            <div className="field"><label>What is it?</label>
              <div className="inrow"><input type="text" value={oneOffName} onChange={e => setOneOffName(e.target.value)} /></div>
            </div>
            <div className="field"><label>Amount</label>
              <div className="inrow"><span className="pre">{sym}</span>
                <input type="number" inputMode="decimal" value={oneOffAmt} onChange={e => setOneOffAmt(e.target.value)} />
              </div>
            </div>
            {oneOffItem.oneOffKind === 'income' && <>
              <div className="field" style={{ marginBottom: 4 }}><label>How sure is it?</label></div>
              <div className={`opt${!oneOffCertain ? ' sel' : ''}`} onClick={() => setOneOffCertain(false)} style={{ display:'flex', gap:11, alignItems:'flex-start' }}>
                <div style={{ ...certIconBase, border: '1.5px dashed var(--pos)' }}>?</div>
                <div><div className="ot">Not certain yet</div><div className="os">Kept out of your forecast until it lands.</div></div>
              </div>
              <div className={`opt${oneOffCertain ? ' sel' : ''}`} onClick={() => setOneOffCertain(true)} style={{ display:'flex', gap:11, alignItems:'flex-start' }}>
                <div style={certIconBase}>✓</div>
                <div><div className="ot">Confirmed</div><div className="os">Counts toward your projected balance.</div></div>
              </div>
            </>}
            {oneOffError && <p style={{ color:'var(--floor)', fontSize:13, marginTop:8, marginBottom:0 }}>{oneOffError}</p>}
            <div className="navrow">
              <button onClick={() => setOneOffItem(null)}>Cancel</button>
              <button className="pri" onClick={saveOneOffEdits} style={{ opacity: oneOffSaving ? 0.6 : 1 }}>
                {oneOffSaving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
            <button onClick={deleteOneOff} style={{
              display:'block', width:'100%', marginTop:12, padding:'10px',
              background:'none', border:'none', cursor:'pointer',
              color:'var(--floor)', fontSize:13, fontWeight:600,
              fontFamily:"'Space Grotesk',sans-serif",
              opacity: oneOffDeleting ? 0.6 : 1,
            }}>
              {oneOffDeleting ? 'Removing…' : oneOffItem.oneOffKind === 'income' ? 'Delete this income' : 'Delete this expense'}
            </button>
          </div>
        </div>
      )}

      {/* ── adjust the credit top-up ── */}
      {adjOpen && creditModel && (
        <div className="ov" onClick={e => { if (e.target === e.currentTarget) setAdjOpen(false) }}>
          <div className="sheet">
            <button className="xbtn" onClick={() => setAdjOpen(false)}>×</button>
            <div className="grab" />
            <h3>Adjust your payment</h3>
            <p className="sd">
              The minimum is set by your card agreement. Anything above it is your choice,
              and it moves when the card is paid off.
            </p>

            <div className="cr-locked">
              <div className="cl-ic">🔒</div>
              <div className="cl-tx">
                <div className="cl-n">Minimum due</div>
                <div className="cl-d">
                  {creditPlanNew?.lines[0]?.minimumCents
                    ? <>due {creditDueDate ? fmtDate(creditDueDate) : 'this cycle'}</>
                    : <>none due this cycle</>}
                </div>
              </div>
              <div className="cl-v">{fmt(creditPlanNew?.lines[0]?.minimumCents ?? 0, false)}</div>
            </div>

            {/* How much, and for how long — one decision, so one box. Split
                across a scroll, toggling the scope changed numbers you could
                not see. */}
            <div className="cr-ctrl">
              <div className="cr-dial-top">
                <span className="l">Extra on top</span>
                <span className="v">{fmt(adjExtra, false)}</span>
              </div>
              <input type="range" min={0} max={Math.max(aboveFloor + creditExtraCents, 1000)} step={500}
                value={Math.min(adjExtra, Math.max(aboveFloor + creditExtraCents, 1000))}
                onChange={e => setAdjExtra(parseInt(e.target.value, 10))} />
              <div className="cr-dial-ends">
                <span>{fmt(0, false)}</span>
                <span>{fmt(Math.max(aboveFloor + creditExtraCents, 0), false)} spare</span>
              </div>

              <div className="cr-scope">
                <button className={adjScope === 'once' ? 'on' : ''} onClick={() => setAdjScope('once')}>
                  Just this cycle<small>one-off change</small>
                </button>
                <button className={adjScope === 'always' ? 'on' : ''} onClick={() => setAdjScope('always')}>
                  From now on<small>changes your plan</small>
                </button>
              </div>
            </div>

            {/* What the change actually does. The payoff date moving is half of
                it; what the slower payoff costs is the other half, and it was
                missing entirely. */}
            <div className="cr-pair">
              <div className="cr-po card-side">
                <div className="k">Card cleared</div>
                <div className="v">
                  {creditPlanNew?.cyclesToPayoff
                    ? cycleDateLabel(
                        formatDate(addDays(parseDate(activeCycle.startDate),
                          creditPlanNew.cyclesToPayoff * creditCycleDays)), creditBaseYear)
                    : 'Never'}
                </div>
                <div className="d">
                  {creditPlanNew?.cyclesToPayoff
                    ? <>{creditPlanNew.cyclesToPayoff} cycles</>
                    : <>never gets ahead of interest</>}
                </div>
              </div>
              {(() => {
                const diff = (creditPlanNew?.totalInterestCents ?? 0) - (creditPlanNow?.totalInterestCents ?? 0)
                // Red only when the change costs you. It used to be red always,
                // including when it read "same as now", so it meant nothing.
                const tone = Math.abs(diff) < 100 ? '' : diff > 0 ? ' worse' : ' better'
                return (
                  <div className={`cr-po cost${tone}`}>
                    <div className="k">Interest</div>
                    <div className="v">{fmt(creditPlanNew?.totalInterestCents ?? 0, false)}</div>
                    <div className="d">
                      {Math.abs(diff) < 100
                        ? 'same as now'
                        : (diff > 0 ? '+' : '−') + fmt(Math.abs(diff), false) + ' vs now'}
                    </div>
                  </div>
                )
              })()}
            </div>

            {/* account balance, cycle by cycle */}
            <div className="cr-chart-k" style={{ marginTop: 15 }}>
              <span>Your account, each cycle</span>
              <span>lowest {fmt(creditWorstBank, false)}</span>
            </div>
            <div className="cr-bars">
              {(() => {
                const top = Math.max(...creditBankSeries, floorCents * 1.4, 1)
                return <>
                  {creditBankSeries.map((v, i) => {
                    const cls = v < 0 ? 'breach' : v < floorCents ? 'low' : ''
                    // Every label would collide at this width, so date every third.
                    const showLabel = i % 3 === 0 || i === creditBankSeries.length - 1
                    return (
                      <div key={i} className={`cr-bar ${cls}`}
                        style={{ height: Math.max((Math.max(v, 0) / top) * 44, 3) + 'px' }}>
                        {showLabel && (
                          <span className="cr-bx">
                            {cycles[i] ? cycleTickLabel(cycles[i].startDate, creditBaseYear) : ''}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {/* Without this the colours mean nothing — "lowest $441" on a
                      row of identical green bars says nothing about the floor. */}
                  {floorCents > 0 && (
                    <div className="cr-floor" style={{ bottom: (16 + (floorCents / top) * 44) + 'px' }}>
                      <span>floor {fmt(floorCents, false)}</span>
                    </div>
                  )}
                </>
              })()}
            </div>
            <div className="cr-beyond">
              {creditPlanNew?.cyclesToPayoff && creditPlanNew.cyclesToPayoff > creditBankSeries.length
                ? <>showing {creditBankSeries.length} cycles · this payment continues for{' '}
                    {creditPlanNew.cyclesToPayoff - creditBankSeries.length} more</>
                : <>showing every cycle until the card clears</>}
            </div>

            {creditWorstBank < floorCents ? (
              <div className="cr-warn">
                <b>The cycle starting {cycles[creditWorstIdx] ? cycleDateLabel(cycles[creditWorstIdx].startDate, creditBaseYear) : '—'} drops to {fmt(creditWorstBank, false)}</b>
                {creditWorstBank < 0
                  ? <> — that would overdraw the account.</>
                  : <>, under your {fmt(floorCents, false)} floor.</>}
                {' '}Paying this much clears the card sooner, but a later cycle carries the cost.
              </div>
            ) : (
              <div className="cr-ok">
                Every cycle stays above your floor — lowest is <b>{fmt(creditWorstBank, false)}</b>
                {' '}in the cycle starting {cycles[creditWorstIdx] ? cycleDateLabel(cycles[creditWorstIdx].startDate, creditBaseYear) : '—'}.
              </div>
            )}

            <div className="navrow">
              <button onClick={() => setAdjOpen(false)}>Cancel</button>
              <button className="pri" style={{ background: 'var(--credit)' }}
                onClick={saveCreditAdjust} disabled={adjSaving}>
                {adjSaving ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── goal detail ── */}
      {savTarget && (() => {
        const g = savTarget
        const saved  = savedSoFar(g.id)
        const target = g.target_cents
        const plan   = planSaysBy(g.id)
        const pct     = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0
        const planPct = target > 0 ? Math.min(100, Math.round((plan  / target) * 100)) : 0
        const remaining = Math.max(0, target - saved)
        const reached = remaining <= 0

        // One box per cycle: ticked, missed, this one, still to come. A plain
        // expense cannot tell you which cycles actually happened — this can.
        const steps: { start: string; state: 'ok' | 'miss' | 'now' | 'todo' }[] = []
        for (let i = 0; i < Math.min(g.cycles_total + 6, 14); i++) {
          const d = addDays(parseDate(g.start_cycle_start), i * 14)
          const iso = formatDate(d)
          const ticked = savingsDone.some((c: any) => c.savings_goal_id === g.id && c.cycle_start === iso)
          const isNow = iso === activeCycle.startDate
          const past  = iso < activeCycle.startDate
          steps.push({ start: iso, state: ticked ? 'ok' : isNow ? 'now' : past ? 'miss' : 'todo' })
        }
        const missed = steps.filter(x => x.state === 'miss').length
        const ticks  = steps.filter(x => x.state === 'ok').length

        return (
          <div className="ov" onClick={e => { if (e.target === e.currentTarget) setSavTarget(null) }}>
            <div className="sheet">
              <button className="xbtn" onClick={() => setSavTarget(null)}>×</button>
              <div className="grab" />
              <h3>{g.name}</h3>
              <p className="sd">
                Saving {fmt(target, false)} · {fmt(g.per_cycle_cents, false)} a cycle ·
                started {fmtDate(g.start_cycle_start)}
              </p>

              <div className="sav-hero">
                <div className="sh-top">
                  <div>
                    <div className="sh-k">Set aside</div>
                    <div className="sh-v" style={reached ? { color: 'var(--pos)' } : undefined}>
                      {fmt(saved, false)} <small>of {fmt(target, false)}</small>
                    </div>
                  </div>
                  <div className="sh-r">
                    {reached
                      ? <span className="chip sav-ready">ready to buy</span>
                      : <>
                          <div className="v">{fmt(remaining, false)}</div>
                          <div className="l">still to go</div>
                        </>}
                  </div>
                </div>
                <div className="sav-bar">
                  <div className="fill" style={{ width: pct + '%' }} />
                  {planPct > 0 && planPct < 100 && (
                    <div className="plan-tick" style={{ left: planPct + '%' }} />
                  )}
                </div>
                {!reached && plan > saved && (
                  <div className="sav-legend">
                    the plan says {fmt(plan, false)} by now — you are {fmt(plan - saved, false)} behind
                  </div>
                )}
              </div>

              <div className="sav-tl-k">
                <span>Each cycle</span>
                <span>{ticks} set aside{missed > 0 && <> · {missed} missed</>}</span>
              </div>
              <div className="sav-tl">
                {steps.map(step => (
                  <div key={step.start} className="sav-step">
                    <div className={`sav-dot ${step.state}`}>
                      {step.state === 'ok' ? '✓' : step.state === 'miss' ? '–' : step.state === 'now' ? '·' : ''}
                    </div>
                    <div className="sav-when">{cycleTickLabel(step.start, baseYearOf(cycles))}</div>
                  </div>
                ))}
              </div>

              {reached ? (
                <>
                  <button className="addbtn" style={{ background: 'var(--pos)', color: '#fff', borderStyle: 'solid', marginTop: 16 }}
                    disabled={savBusy} onClick={() => completeGoal(g)}>
                    Mark as bought
                  </button>
                  <p className="hint" style={{ marginTop: 8 }}>
                    The money already left your spendable balance as you saved it, so buying this
                    changes nothing in the forecast — that is what the savings were for.
                  </p>
                </>
              ) : (
                <div className="sav-acts">
                  <div className="sav-act" onClick={() => { setSavTarget(null); openSavAdjust(g) }}>
                    <div className="sa-ic">±</div>
                    <div className="sa-tx">
                      <div className="n">Change the amount</div>
                      <div className="d">this cycle only, or from now on</div>
                    </div>
                    <div className="sa-go">→</div>
                  </div>
                  <div className="sav-act" onClick={() => { setSavTarget(null); openSavFix(g) }}>
                    <div className="sa-ic">=</div>
                    <div className="sa-tx">
                      <div className="n">Correct the total</div>
                      <div className="d">if you dipped into it, or put extra in</div>
                    </div>
                    <div className="sa-go">→</div>
                  </div>
                  <div className="sav-act danger" onClick={() => stopSaving(g)}>
                    <div className="sa-ic">×</div>
                    <div className="sa-tx">
                      <div className="n">Stop saving for this</div>
                      <div className="d">keeps what is set aside, removes future cycles</div>
                    </div>
                    <div className="sa-go">→</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── change the amount ── */}
      {savAdjust && (() => {
        const cents = Math.max(0, Math.round(parseFloat(savAdjAmount || '0') * 100))
        const saved = savedSoFar(savAdjust.id)
        const left  = Math.max(0, savAdjust.target_cents - saved)
        const after = Math.max(0, left - cents)
        const restCycles = cents > 0 ? Math.ceil(after / Math.max(savAdjust.per_cycle_cents, 1)) : 0
        const allCycles  = cents > 0 ? Math.ceil(left / cents) : 0
        return (
          <div className="ov" onClick={e => { if (e.target === e.currentTarget) setSavAdjust(null) }}>
            <div className="sheet">
              <button className="xbtn" onClick={() => setSavAdjust(null)}>×</button>
              <div className="grab" />
              <h3>Change the amount</h3>
              <p className="sd">What you set aside for {savAdjust.name}.</p>

              <div className="field">
                <label>Each cycle</label>
                <div className="inrow">
                  <span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={savAdjAmount}
                    onChange={e => setSavAdjAmount(e.target.value)} />
                </div>
              </div>

              <div className="cr-scope">
                <button className={savAdjScope === 'once' ? 'on' : ''} onClick={() => setSavAdjScope('once')}>
                  Just this cycle<small>back to {fmt(savAdjust.per_cycle_cents, false)} after</small>
                </button>
                <button className={savAdjScope === 'always' ? 'on' : ''} onClick={() => setSavAdjScope('always')}>
                  From now on<small>changes the plan</small>
                </button>
              </div>

              <div className="sav-diff">
                {savAdjScope === 'once' ? (
                  <>
                    <div className="row"><span className="l">This cycle</span><span className="v">{fmt(cents, false)}</span></div>
                    <div className="row"><span className="l">Then back to</span><span className="v">{fmt(savAdjust.per_cycle_cents, false)}</span></div>
                    <div className="row"><span className="l">Cycles left after that</span><span className="v">{restCycles}</span></div>
                  </>
                ) : (
                  <>
                    <div className="row"><span className="l">Every cycle from now</span><span className="v">{fmt(cents, false)}</span></div>
                    <div className="row"><span className="l">Still to save</span><span className="v">{fmt(left, false)}</span></div>
                    <div className="row"><span className="l">Cycles left</span><span className="v">{cents > 0 ? allCycles : '—'}</span></div>
                  </>
                )}
              </div>

              <div className="navrow">
                <button onClick={() => setSavAdjust(null)}>Cancel</button>
                <button className="pri" style={{ background: 'var(--pos)' }}
                  onClick={saveSavAdjust} disabled={savBusy}>
                  {savBusy ? 'Saving…' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── correct the total ── */}
      {savFixTotal && (() => {
        const cents = Math.max(0, Math.round(parseFloat(savFixAmount || '0') * 100))
        const ticked = savingsDone.filter((c: any) => c.savings_goal_id === savFixTotal.id).length
        const byTicks = ticked * savFixTotal.per_cycle_cents
        const delta = cents - byTicks
        const left = Math.max(0, savFixTotal.target_cents - cents)
        const cyclesLeft = Math.ceil(left / Math.max(savFixTotal.per_cycle_cents, 1))
        return (
          <div className="ov" onClick={e => { if (e.target === e.currentTarget) setSavFixTotal(null) }}>
            <div className="sheet">
              <button className="xbtn" onClick={() => setSavFixTotal(null)}>×</button>
              <div className="grab" />
              <h3>Correct the total</h3>
              <p className="sd">
                For when what is actually set aside does not match what you ticked. This is about
                the past — changing what you save from here is a different thing.
              </p>

              <div className="field">
                <label>Actually set aside</label>
                <div className="inrow">
                  <span className="pre">{sym}</span>
                  <input type="number" inputMode="decimal" value={savFixAmount}
                    onChange={e => setSavFixAmount(e.target.value)} />
                </div>
                <p className="hint">
                  You ticked {ticked} {ticked === 1 ? 'cycle' : 'cycles'}, totalling {fmt(byTicks, false)}.
                  {delta < 0 && <> Setting {fmt(cents, false)} records that {fmt(-delta, false)} was used.</>}
                  {delta > 0 && <> Setting {fmt(cents, false)} records {fmt(delta, false)} extra put in.</>}
                  {delta === 0 && <> That matches.</>}
                </p>
              </div>

              <div className="sav-diff">
                <div className="row"><span className="l">Still to save</span><span className="v">{fmt(left, false)}</span></div>
                <div className="row">
                  <span className="l">At {fmt(savFixTotal.per_cycle_cents, false)} a cycle</span>
                  <span className="v">{cyclesLeft} more {cyclesLeft === 1 ? 'cycle' : 'cycles'}</span>
                </div>
              </div>

              <div className="navrow">
                <button onClick={() => setSavFixTotal(null)}>Cancel</button>
                <button className="pri" style={{ background: 'var(--pos)' }}
                  onClick={saveSavFix} disabled={savBusy}>
                  {savBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}