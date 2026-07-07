import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { upsertProfile, createAccount } from './lib/repository'

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'annually', 'once'] as const
type Frequency = typeof FREQUENCIES[number]
type Mode      = 'fixed' | 'variable' | 'budget'

const FREQ_LABELS: Record<Frequency, string> = {
  weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly',
  annually: 'Annually', once: 'Once',
}

const MODE_META: Record<Mode, { icon: string; iconClass: string; chip: string; chipLabel: string }> = {
  fixed:    { icon: '▤', iconClass: 'fix',  chip: 'lock', chipLabel: 'fixed'    },
  variable: { icon: '~', iconClass: 'var',  chip: 'est',  chipLabel: 'estimate' },
  budget:   { icon: '≈', iconClass: 'base', chip: 'bl',   chipLabel: 'baseline' },
}

const CURRENCIES = [
  { code: 'NZD', label: 'New Zealand Dollar', symbol: '$' },
  { code: 'AUD', label: 'Australian Dollar',  symbol: '$' },
  { code: 'USD', label: 'US Dollar',          symbol: '$' },
  { code: 'GBP', label: 'British Pound',      symbol: '£' },
  { code: 'EUR', label: 'Euro',               symbol: '€' },
  { code: 'CAD', label: 'Canadian Dollar',    symbol: '$' },
  { code: 'SGD', label: 'Singapore Dollar',   symbol: '$' },
  { code: 'JPY', label: 'Japanese Yen',       symbol: '¥' },
  { code: 'ZAR', label: 'South African Rand', symbol: 'R' },
  { code: 'AED', label: 'UAE Dirham',         symbol: 'د.إ' },
  { code: 'INR', label: 'Indian Rupee',       symbol: '₹' },
  { code: 'MXN', label: 'Mexican Peso',       symbol: '$' },
  { code: 'BRL', label: 'Brazilian Real',     symbol: 'R$' },
  { code: 'CHF', label: 'Swiss Franc',        symbol: 'Fr' },
  { code: 'SEK', label: 'Swedish Krona',      symbol: 'kr' },
  { code: 'NOK', label: 'Norwegian Krone',    symbol: 'kr' },
  { code: 'DKK', label: 'Danish Krone',       symbol: 'kr' },
  { code: 'HKD', label: 'Hong Kong Dollar',   symbol: '$' },
  { code: 'KRW', label: 'South Korean Won',   symbol: '₩' },
  { code: 'CNY', label: 'Chinese Yuan',       symbol: '¥' },
]

interface ExpenseDraft {
  id: string
  name: string
  amountCents: number
  frequency: Frequency
  anchorDate: string
  mode: Mode
}

function fmt(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function SetupPage({
  userId,
  onComplete,
  onCancel,
  isFirstRun = true,
}: {
  userId: string
  onComplete: () => void
  onCancel?: () => void
  isFirstRun?: boolean
}) {
  const [step,     setStep]     = useState(0)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [darkMode, setDarkMode] = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'
  )

  // step 0 — account + identity
  const [accountName,     setAccountName]     = useState('My Account')
  const [currencyCode,    setCurrencyCode]    = useState('NZD')
  const [currencySheet,   setCurrencySheet]   = useState(false)
  const [displayName,     setDisplayName]     = useState('')

  // income — optional
  const [skipIncome,      setSkipIncome]      = useState(false)
  const [incomeName,      setIncomeName]      = useState('Salary')
  const [incomeAmount,    setIncomeAmount]    = useState('')
  const [incomeFrequency, setIncomeFrequency] = useState<Frequency>('fortnightly')
  const [incomeAnchor,    setIncomeAnchor]    = useState('')

  // fallback cycle start when income skipped
  const [cycleStartDate,  setCycleStartDate]  = useState('')

  // step 1 — recurring expenses
  const [expenses,  setExpenses]  = useState<ExpenseDraft[]>([])
  const [expSheet,  setExpSheet]  = useState(false)
  const [expEditId, setExpEditId] = useState<string | null>(null)
  const [expName,   setExpName]   = useState('')
  const [expAmount, setExpAmount] = useState('')
  const [expFreq,   setExpFreq]   = useState<Frequency>('monthly')
  const [expAnchor, setExpAnchor] = useState('')
  const [expMode,   setExpMode]   = useState<Mode>('fixed')
  const [expError,  setExpError]  = useState('')

  // step 2 — safety net
  const [openingBalance, setOpeningBalance] = useState('')
  const [safetyFloor,    setSafetyFloor]    = useState('500')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  const selectedCurrency = CURRENCIES.find(c => c.code === currencyCode) ?? CURRENCIES[0]

  function openAddExpense() {
    setExpEditId(null)
    setExpName(''); setExpAmount(''); setExpFreq('monthly')
    setExpAnchor(''); setExpMode('fixed'); setExpError('')
    setExpSheet(true)
  }
  function openEditExpense(e: ExpenseDraft) {
    setExpEditId(e.id)
    setExpName(e.name); setExpAmount(String(e.amountCents / 100))
    setExpFreq(e.frequency); setExpAnchor(e.anchorDate); setExpMode(e.mode)
    setExpError(''); setExpSheet(true)
  }
  function saveExpense() {
    if (!expName.trim() || !expAmount || !expAnchor) {
      setExpError('Name, amount and date are required.'); return
    }
    const draft: ExpenseDraft = {
      id: expEditId ?? crypto.randomUUID(),
      name: expName.trim(),
      amountCents: Math.round(parseFloat(expAmount) * 100),
      frequency: expFreq, anchorDate: expAnchor, mode: expMode,
    }
    if (expEditId) {
      setExpenses(prev => prev.map(e => e.id === expEditId ? draft : e))
    } else {
      setExpenses(prev => [...prev, draft])
    }
    setExpSheet(false)
  }
  function removeExpense(id: string) {
    setExpenses(prev => prev.filter(e => e.id !== id))
    setExpSheet(false)
  }

  function canAdvance(): boolean {
    if (step === 0) {
      const nameOk   = accountName.trim().length > 0
      const personOk = isFirstRun ? displayName.trim().length > 0 : true
      const incomeOk = skipIncome
        ? cycleStartDate.length > 0
        : incomeName.trim().length > 0 && incomeAmount.length > 0 && incomeAnchor.length > 0
      return nameOk && personOk && incomeOk
    }
    if (step === 1) return true
    if (step === 2) return openingBalance.length > 0
    return true
  }

  async function handleFinish() {
    setSaving(true); setError('')
    try {
      if (isFirstRun) {
        await upsertProfile(userId, displayName)
      }

      const floorCents   = safetyFloor ? Math.round(parseFloat(safetyFloor) * 100) : 0
      const openingCents = Math.round(parseFloat(openingBalance) * 100)
      const account      = await createAccount(userId, accountName.trim(), currencyCode, openingCents, floorCents)
      const accountId    = account.id

      if (!skipIncome) {
        const { data: incomeSource, error: e1 } = await supabase
          .from('income_sources')
          .insert({
            profile_id:  userId,
            account_id:  accountId,
            name:        incomeName.trim(),
            frequency:   incomeFrequency,
            anchor_date: incomeAnchor,
            is_primary:  true,
          })
          .select().single()
        if (e1) throw e1
        const { error: e2 } = await supabase
          .from('income_amount_versions')
          .insert({
            income_source_id: incomeSource.id,
            amount_cents:     Math.round(parseFloat(incomeAmount) * 100),
            effective_from:   incomeAnchor,
          })
        if (e2) throw e2
      }

      for (const exp of expenses) {
        const { data: row, error: e3 } = await supabase
          .from('expenses')
          .insert({
            profile_id:  userId,
            account_id:  accountId,
            name:        exp.name,
            frequency:   exp.frequency,
            anchor_date: exp.anchorDate,
            mode:        exp.mode,
          })
          .select().single()
        if (e3) throw e3
        const { error: e4 } = await supabase
          .from('expense_amount_versions')
          .insert({ expense_id: row.id, amount_cents: exp.amountCents, effective_from: exp.anchorDate })
        if (e4) throw e4
      }

      const cycleAnchor = skipIncome ? cycleStartDate : incomeAnchor
      const start = new Date(cycleAnchor)
      const end   = new Date(start)
      if (!skipIncome) {
        if      (incomeFrequency === 'weekly')      end.setDate(end.getDate() + 6)
        else if (incomeFrequency === 'fortnightly') end.setDate(end.getDate() + 13)
        else if (incomeFrequency === 'monthly')   { end.setMonth(end.getMonth() + 1); end.setDate(end.getDate() - 1) }
        else                                      { end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1) }
      } else {
        end.setDate(end.getDate() + 13)
      }

      const { error: e5 } = await supabase
        .from('cycles')
        .insert({
          profile_id:            userId,
          account_id:            accountId,
          start_date:            start.toISOString().split('T')[0],
          end_date:              end.toISOString().split('T')[0],
          opening_balance_cents: openingCents,
        })
      if (e5) throw e5

      onComplete()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const totalSteps = 4

  return (
    <div className="app">
      <div className="appbar">
        {!isFirstRun && onCancel && (
          <button className="hb" onClick={onCancel} aria-label="Cancel">×</button>
        )}
        <div className="nm">Set up Pocket<b>Pilot</b></div>
        <button className="tgl" onClick={() => setDarkMode(d => !d)}>
          <span>{darkMode ? '☀' : '☾'}</span>
          <span className="lab">{darkMode ? 'LIGHT' : 'DARK'}</span>
        </button>
      </div>

      <div className="setup-prog">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div key={i} className={`s${i <= step ? ' done' : ''}`} />
        ))}
      </div>

      <div className="scrollarea">

        {/* ── STEP 0 ── */}
        {step === 0 && (
          <div className="setup-body">
            <div className="stepk">Step 1 of 4</div>
            <div className="steph">{isFirstRun ? 'Set up your account' : 'New account'}</div>
            <div className="steps-sub">
              {isFirstRun
                ? 'Name this account, pick its currency, then tell us about your income.'
                : 'Each account has its own currency and pay cycle.'}
            </div>

            <div className="field">
              <label>Account name</label>
              <div className="inrow">
                <input
                  type="text" value={accountName}
                  onChange={e => setAccountName(e.target.value)}
                  placeholder="e.g. Everyday, Joint, UK Account"
                />
              </div>
              <p className="hint">You can add more accounts later — each gets its own currency and pay cycle.</p>
            </div>

            <div className="field">
              <label>Currency</label>
              <div
                className="inrow"
                style={{ cursor: 'pointer', justifyContent: 'space-between' }}
                onClick={() => setCurrencySheet(true)}
              >
                <span style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, color:'var(--ink)' }}>
                  {selectedCurrency.code}
                </span>
                <span style={{ color:'var(--mut)', fontSize:14 }}>
                  {selectedCurrency.label} ▾
                </span>
              </div>
            </div>

            {isFirstRun && (
              <div className="field">
                <label>Your name</label>
                <div className="inrow">
                  <input
                    type="text" value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="e.g. Rick"
                  />
                </div>
              </div>
            )}

            {/* ── income toggle ── */}
            <div style={{
  display:'flex', alignItems:'flex-start', gap:14,
  margin:'20px 0 10px', padding:'14px 16px',
  background:'var(--card)', borderRadius:12,
  border:'1px solid var(--line2)',
  textAlign:'left',
}}>
  <div style={{ flex:1, minWidth:0 }}>
    <div style={{
      fontFamily:"'Space Grotesk',sans-serif", fontSize:14,
      fontWeight:600, color:'var(--ink)', marginBottom:4,
      textAlign:'left',
    }}>
      Regular income
    </div>
    <div style={{
      fontSize:12, color:'var(--mut)', lineHeight:1.5,
      textAlign:'left',
    }}>
      Turn off if your income varies — you'll add it to each cycle manually.
    </div>
  </div>
              <div
                onClick={() => setSkipIncome(s => !s)}
                style={{
                  width:44, height:26, borderRadius:13, cursor:'pointer', flexShrink:0,
                  background: skipIncome ? 'var(--line)' : 'var(--acc)',
                  position:'relative', transition:'background .2s', marginTop:2,
                }}
              >
                <div style={{
                  position:'absolute', top:3,
                  left: skipIncome ? 3 : 19,
                  width:20, height:20, borderRadius:'50%',
                  background:'#fff', transition:'left .2s',
                }} />
              </div>
            </div>

            {!skipIncome && (
              <>
                <div className="field">
                  <label>Income name</label>
                  <div className="inrow">
                    <input type="text" value={incomeName} onChange={e => setIncomeName(e.target.value)} placeholder="e.g. Salary" />
                  </div>
                </div>
                <div className="field">
                  <label>Amount per pay</label>
                  <div className="inrow">
                    <span className="pre">{selectedCurrency.symbol}</span>
                    <input type="number" inputMode="decimal" value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)} placeholder="0" />
                  </div>
                </div>
                <div className="field">
                  <label>How often</label>
                  <div className="freq-picker">
                    {FREQUENCIES.filter(f => f !== 'once').map(f => (
                      <button key={f} className={`freq-opt${incomeFrequency === f ? ' sel' : ''}`} onClick={() => setIncomeFrequency(f)}>
                        {FREQ_LABELS[f]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Next pay date</label>
                  <div className="inrow">
                    <input type="date" value={incomeAnchor} onChange={e => setIncomeAnchor(e.target.value)}
                      style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                    />
                  </div>
                  <p className="hint">The date your next pay lands — the engine repeats from there.</p>
                </div>
                <div className="skipnote">
                  <b>Bonuses, tax returns, gig work?</b> Don't add those here — add them to a cycle when they're coming.
                </div>
              </>
            )}

            {skipIncome && (
              <div className="field">
                <label>First cycle start date</label>
                <div className="inrow">
                  <input type="date" value={cycleStartDate} onChange={e => setCycleStartDate(e.target.value)}
                    style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                  />
                </div>
                <p className="hint">Your first fortnightly cycle starts here. You can adjust cycles later.</p>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 1: expenses ── */}
        {step === 1 && (
          <div className="setup-body">
            <div className="stepk">Step 2 of 4</div>
            <div className="steph">What goes out regularly?</div>
            <div className="steps-sub">Tap "mode" on any expense — that one choice is what makes the whole app behave correctly.</div>

            <div className="cards" style={{ padding:0 }}>
              {expenses.length === 0 && (
                <p style={{ textAlign:'center', color:'var(--mut)', padding:'16px 0', fontSize:13 }}>
                  No expenses yet — add some below, or skip and add later.
                </p>
              )}
              {expenses.map(e => {
                const m = MODE_META[e.mode]
                return (
                  <div key={e.id} className={`card${e.mode === 'variable' ? ' dashed' : ''}`}>
                    <div className={`ic ${m.iconClass}`}>{m.icon}</div>
                    <div className="tx">
                      <div className="nm">{e.name}<span className={`chip ${m.chip}`}>{m.chipLabel}</span></div>
                      <div className="dt">{fmt(e.amountCents)} · {e.frequency}</div>
                      <div className="act-row"><span className="act" onClick={() => openEditExpense(e)}>edit →</span></div>
                    </div>
                    <div className="vl">−{fmt(e.amountCents)}</div>
                  </div>
                )
              })}
            </div>

            <button className="addbtn" style={{ marginTop:9 }} onClick={openAddExpense}>+ Add expense</button>

            <div className="skipnote" style={{ marginTop:14 }}>
              <b>You can skip this</b> and add expenses later from the Expenses page.
            </div>
          </div>
        )}

        {/* ── STEP 2: safety net ── */}
        {step === 2 && (
          <div className="setup-body">
            <div className="stepk">Step 3 of 4</div>
            <div className="steph">Your safety net</div>
            <div className="steps-sub">Two numbers — both conservative by design so your forecast never flatters you.</div>

            <div className="field">
              <label>Current account balance</label>
              <div className="inrow">
                <span className="pre">{selectedCurrency.symbol}</span>
                <input type="number" inputMode="decimal" value={openingBalance} onChange={e => setOpeningBalance(e.target.value)} placeholder="0" />
              </div>
              <p className="hint">What's actually in your account right now. This becomes the starting point.</p>
            </div>

            <div className="field" style={{ marginTop:18 }}>
              <label>Safety floor</label>
              <div className="inrow">
                <span className="pre">{selectedCurrency.symbol}</span>
                <input type="number" inputMode="decimal" value={safetyFloor} onChange={e => setSafetyFloor(e.target.value)} placeholder="0" />
              </div>
              <p className="hint">We'll warn you when a cycle is projected to close near this.</p>
            </div>
          </div>
        )}

        {/* ── STEP 3: review ── */}
        {step === 3 && (
          <div className="setup-body">
            <div className="stepk">Step 4 of 4</div>
            <div className="steph">You're set</div>
            <div className="steps-sub">Here's what Pocket Pilot will project from.</div>

            <div className="cards" style={{ padding:0 }}>
              <div className="card">
                <div className="ic fix">▤</div>
                <div className="tx">
                  <div className="nm">{accountName}</div>
                  <div className="dt">{selectedCurrency.code} · {selectedCurrency.label}</div>
                  <div className="act-row" />
                </div>
              </div>
              {!skipIncome && (
                <div className="card">
                  <div className="ic inc">↓</div>
                  <div className="tx">
                    <div className="nm">{incomeName}</div>
                    <div className="dt">{incomeFrequency} · next {incomeAnchor}</div>
                    <div className="act-row" />
                  </div>
                  <div className="vl pos">+{fmt(Math.round(parseFloat(incomeAmount || '0') * 100))}</div>
                </div>
              )}
              {skipIncome && (
                <div className="card">
                  <div className="ic var">~</div>
                  <div className="tx">
                    <div className="nm">Variable income</div>
                    <div className="dt">Add per cycle as it arrives</div>
                    <div className="act-row" />
                  </div>
                </div>
              )}
              <div className="card">
                <div className="ic fix">▤</div>
                <div className="tx">
                  <div className="nm">{expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}</div>
                  <div className="dt">
                    {expenses.filter(e => e.mode === 'fixed').length} fixed · {expenses.filter(e => e.mode === 'variable').length} variable · {expenses.filter(e => e.mode === 'budget').length} budget
                  </div>
                  <div className="act-row" />
                </div>
              </div>
              <div className="card">
                <div className="ic base">⚑</div>
                <div className="tx">
                  <div className="nm">Floor set</div>
                  <div className="dt">nudges fire near {fmt(Math.round(parseFloat(safetyFloor || '0') * 100))}</div>
                  <div className="act-row" />
                </div>
              </div>
            </div>

            {error && <p style={{ color:'var(--floor)', fontSize:13, marginTop:12 }}>{error}</p>}

            <div className="skipnote" style={{ marginTop:14 }}>
              <b>What's not here:</b> bonuses, one-offs, lay-bys. You'll add those from a cycle.
            </div>
          </div>
        )}

      </div>

      {/* footer nav */}
      <div className="setup-footer">
        {step > 0
          ? <button onClick={() => setStep(s => s - 1)}>Back</button>
          : (!isFirstRun && onCancel)
            ? <button onClick={onCancel}>Cancel</button>
            : <div />
        }
        {step < totalSteps - 1
          ? (
            <button
              className="pri"
              style={{ opacity: canAdvance() ? 1 : 0.4, cursor: canAdvance() ? 'pointer' : 'default' }}
              onClick={() => { if (canAdvance()) setStep(s => s + 1) }}
            >
              Continue →
            </button>
          )
          : (
            <button className="pri" style={{ opacity: saving ? 0.6 : 1 }} onClick={handleFinish}>
              {saving ? 'Saving…' : 'Finish'}
            </button>
          )
        }
      </div>

      {/* ── expense sheet ── */}
      {expSheet && (
        <div className="ov" onClick={() => setExpSheet(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setExpSheet(false)}>×</button>
            <div className="grab" />
            <h3>{expEditId ? `Edit ${expName}` : 'Add expense'}</h3>
            <p className="sd">What goes out on a regular schedule?</p>
            <p style={{ fontSize:12, color:'var(--mut)', fontWeight:500, marginBottom:8 }}>How does this cost behave?</p>
            <div className={`modeopt${expMode === 'fixed' ? ' sel' : ''}`} onClick={() => setExpMode('fixed')}>
              <div className="mi ic fix">▤</div>
              <div><div className="mt">Exact amount</div><div className="ms">Same every time.</div><div className="me">e.g. rent, insurance, subscriptions</div></div>
            </div>
            <div className={`modeopt${expMode === 'variable' ? ' sel' : ''}`} onClick={() => setExpMode('variable')}>
              <div className="mi ic var">~</div>
              <div><div className="mt">Varies — I'll confirm</div><div className="ms">Set an estimate. Confirm the real figure when the bill arrives.</div><div className="me">e.g. power, water</div></div>
            </div>
            <div className={`modeopt${expMode === 'budget' ? ' sel' : ''}`} onClick={() => setExpMode('budget')}>
              <div className="mi ic base">≈</div>
              <div><div className="mt">Just a budget</div><div className="ms">A conservative number you won't itemise.</div><div className="me">e.g. groceries, fuel, eating out</div></div>
            </div>
            <div className="field" style={{ marginTop:6 }}>
              <label>Name</label>
              <div className="inrow"><input type="text" value={expName} onChange={e => setExpName(e.target.value)} placeholder="e.g. Rent" /></div>
            </div>
            <div className="field">
              <label>{expMode === 'variable' ? 'Estimated amount' : 'Amount'}</label>
              <div className="inrow">
                <span className="pre">{selectedCurrency.symbol}</span>
                <input type="number" inputMode="decimal" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="field">
              <label>Frequency</label>
              <div className="freq-picker">
                {FREQUENCIES.map(f => (
                  <button key={f} className={`freq-opt${expFreq === f ? ' sel' : ''}`} onClick={() => setExpFreq(f)}>{FREQ_LABELS[f]}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Anchor date</label>
              <div className="inrow">
                <input type="date" value={expAnchor} onChange={e => setExpAnchor(e.target.value)}
                  style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                />
              </div>
            </div>
            {expError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:8 }}>{expError}</p>}
            <div className="navrow">
              <button onClick={() => setExpSheet(false)}>Cancel</button>
              <button className="pri" onClick={saveExpense}>{expEditId ? 'Save changes' : 'Add'}</button>
            </div>
            {expEditId && (
              <button onClick={() => removeExpense(expEditId)} style={{
                display:'block', width:'100%', marginTop:12, padding:'10px',
                background:'none', border:'none', cursor:'pointer',
                color:'var(--floor)', fontSize:13, fontWeight:600,
                fontFamily:"'Space Grotesk',sans-serif",
              }}>Remove this expense</button>
            )}
          </div>
        </div>
      )}

      {/* ── currency sheet ── */}
      {currencySheet && (
        <div className="ov" onClick={() => setCurrencySheet(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setCurrencySheet(false)}>×</button>
            <div className="grab" />
            <h3>Currency</h3>
            <p className="sd">Pick the currency for this account.</p>
            <div style={{ overflowY:'auto', flex:'1 1 auto' }}>
              {CURRENCIES.map(c => (
                <div
                  key={c.code}
                  onClick={() => { setCurrencyCode(c.code); setCurrencySheet(false) }}
                  style={{
                    display:'flex', alignItems:'center', justifyContent:'space-between',
                    padding:'13px 4px', borderBottom:'1px solid var(--line2)', cursor:'pointer',
                  }}
                >
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <span style={{
                      fontFamily:"'JetBrains Mono',monospace", fontSize:12, fontWeight:600,
                      color: c.code === currencyCode ? 'var(--acc)' : 'var(--mut)', width:36,
                    }}>
                      {c.code}
                    </span>
                    <span style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:14, color:'var(--ink)' }}>
                      {c.label}
                    </span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ color:'var(--mut)', fontSize:14 }}>{c.symbol}</span>
                    {c.code === currencyCode && <span style={{ color:'var(--acc)', fontSize:14 }}>✓</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}