import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { upsertProfile } from './lib/repository'

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

interface ExpenseDraft {
  id: string  // temp client-side id
  name: string
  amountCents: number
  frequency: Frequency
  anchorDate: string
  mode: Mode
}

function fmt(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function SetupPage({ userId, onComplete }: { userId: string; onComplete: () => void }) {
  const [step,     setStep]     = useState(0)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [darkMode, setDarkMode] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')

  // step 1 — income
  const [displayName,     setDisplayName]     = useState('')
  const [incomeName,      setIncomeName]      = useState('Salary')
  const [incomeAmount,    setIncomeAmount]    = useState('')
  const [incomeFrequency, setIncomeFrequency] = useState<Frequency>('fortnightly')
  const [incomeAnchor,    setIncomeAnchor]    = useState('')

  // step 2 — recurring expenses
  const [expenses,  setExpenses]  = useState<ExpenseDraft[]>([])
  const [expSheet,  setExpSheet]  = useState(false)
  const [expEditId, setExpEditId] = useState<string | null>(null)
  const [expName,   setExpName]   = useState('')
  const [expAmount, setExpAmount] = useState('')
  const [expFreq,   setExpFreq]   = useState<Frequency>('monthly')
  const [expAnchor, setExpAnchor] = useState('')
  const [expMode,   setExpMode]   = useState<Mode>('fixed')
  const [expError,  setExpError]  = useState('')

  // step 3 — safety net
  const [openingBalance, setOpeningBalance] = useState('')
  const [safetyFloor,    setSafetyFloor]    = useState('500')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  // ── expense sheet ──
  function openAddExpense() {
    setExpEditId(null)
    setExpName(''); setExpAmount(''); setExpFreq('monthly'); setExpAnchor(''); setExpMode('fixed')
    setExpError(''); setExpSheet(true)
  }
  function openEditExpense(e: ExpenseDraft) {
    setExpEditId(e.id)
    setExpName(e.name)
    setExpAmount(String(e.amountCents / 100))
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

  // ── step nav ──
  function canAdvance(): boolean {
    if (step === 0) return !!(displayName.trim() && incomeName.trim() && incomeAmount && incomeAnchor)
    if (step === 1) return true   // can skip with no expenses
    if (step === 2) return !!openingBalance
    return true
  }

  // ── final save (DB writes) ──
  async function handleFinish() {
    setSaving(true); setError('')
    try {
      // 1. profile
      const floorCents = safetyFloor ? Math.round(parseFloat(safetyFloor) * 100) : 0
      await upsertProfile(userId, displayName, floorCents)

      // 2. income source + version
      const { data: incomeSource, error: e1 } = await supabase
        .from('income_sources')
        .insert({
          profile_id: userId, name: incomeName.trim(),
          frequency: incomeFrequency, anchor_date: incomeAnchor,
          is_primary: true,
        })
        .select().single()
      if (e1) throw e1
      const { error: e2 } = await supabase
        .from('income_amount_versions')
        .insert({
          income_source_id: incomeSource.id,
          amount_cents: Math.round(parseFloat(incomeAmount) * 100),
          effective_from: incomeAnchor,
        })
      if (e2) throw e2

      // 3. expenses + versions
      for (const exp of expenses) {
        const { data: row, error: e3 } = await supabase
          .from('expenses')
          .insert({
            profile_id: userId, name: exp.name,
            frequency: exp.frequency, anchor_date: exp.anchorDate, mode: exp.mode,
          })
          .select().single()
        if (e3) throw e3
        const { error: e4 } = await supabase
          .from('expense_amount_versions')
          .insert({
            expense_id: row.id, amount_cents: exp.amountCents, effective_from: exp.anchorDate,
          })
        if (e4) throw e4
      }

      // 4. first cycle
      const start = new Date(incomeAnchor)
      const end   = new Date(start)
      if      (incomeFrequency === 'weekly')      end.setDate(end.getDate() + 6)
      else if (incomeFrequency === 'fortnightly') end.setDate(end.getDate() + 13)
      else if (incomeFrequency === 'monthly')   { end.setMonth(end.getMonth() + 1); end.setDate(end.getDate() - 1) }
      else                                      { end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1) }

      const { error: e5 } = await supabase
        .from('cycles')
        .insert({
          profile_id: userId,
          start_date: start.toISOString().split('T')[0],
          end_date:   end.toISOString().split('T')[0],
          opening_balance_cents: Math.round(parseFloat(openingBalance) * 100),
        })
      if (e5) throw e5

      onComplete()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const totalSteps = 4

  // ── render ──
  return (
    <div className="app">

      <div className="appbar">
        <div className="nm">Set up Pocket<b>Pilot</b></div>
        <button className="tgl" onClick={() => setDarkMode(d => !d)}>
          <span>{darkMode ? '☀' : '☾'}</span>
          <span className="lab">{darkMode ? 'LIGHT' : 'DARK'}</span>
        </button>
      </div>

      {/* progress */}
      <div className="setup-prog">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div key={i} className={`s${i <= step ? ' done' : ''}`} />
        ))}
      </div>

      <div className="scrollarea">

        {/* ── STEP 0: income ── */}
        {step === 0 && (
          <div className="setup-body">
            <div className="stepk">Step 1 of 4</div>
            <div className="steph">What's coming in?</div>
            <div className="steps-sub">Your reliable income — the foundation everything's projected from.</div>

            <div className="field">
              <label>Your name</label>
              <div className="inrow">
                <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Rick" />
              </div>
            </div>
            <div className="field">
              <label>Income name</label>
              <div className="inrow">
                <input type="text" value={incomeName} onChange={e => setIncomeName(e.target.value)} placeholder="e.g. Salary" />
              </div>
            </div>
            <div className="field">
              <label>Amount per pay</label>
              <div className="inrow">
                <span className="pre">$</span>
                <input type="number" inputMode="decimal" value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="field">
              <label>How often</label>
              <div className="freq-picker">
                {FREQUENCIES.filter(f => f !== 'once').map(f => (
                  <button key={f}
                    className={`freq-opt${incomeFrequency === f ? ' sel' : ''}`}
                    onClick={() => setIncomeFrequency(f)}
                  >
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
              <b>Bonuses, tax returns, gig work?</b> Don't add those here. You'll add them to a cycle when you know they're coming.
            </div>
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
                      <div className="nm">
                        {e.name}
                        <span className={`chip ${m.chip}`}>{m.chipLabel}</span>
                      </div>
                      <div className="dt">{fmt(e.amountCents)} · {e.frequency}</div>
                      <div className="act-row">
                        <span className="act" onClick={() => openEditExpense(e)}>edit →</span>
                      </div>
                    </div>
                    <div className="vl">−{fmt(e.amountCents)}</div>
                  </div>
                )
              })}
            </div>

            <button className="addbtn" style={{ marginTop:9 }} onClick={openAddExpense}>+ Add expense</button>

            <div className="skipnote" style={{ marginTop:14 }}>
              <b>You can skip this</b> and add expenses later from the Expenses page. But the more you add now, the more useful the dashboard will be on day one.
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
                <span className="pre">$</span>
                <input type="number" inputMode="decimal" value={openingBalance} onChange={e => setOpeningBalance(e.target.value)} placeholder="0" />
              </div>
              <p className="hint">What's actually in your account right now. This becomes the starting point.</p>
            </div>

            <div className="field" style={{ marginTop:18 }}>
              <label>Safety floor</label>
              <div className="inrow">
                <span className="pre">$</span>
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
                <div className="ic inc">↓</div>
                <div className="tx">
                  <div className="nm">{incomeName}</div>
                  <div className="dt">{incomeFrequency} · next {incomeAnchor}</div>
                  <div className="act-row" />
                </div>
                <div className="vl pos">+{fmt(Math.round(parseFloat(incomeAmount || '0') * 100))}</div>
              </div>

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
              <b>What's not here:</b> bonuses, one-offs, lay-bys. You'll add those from a cycle, whenever they come up.
            </div>
          </div>
        )}

      </div>

      {/* footer nav */}
      <div className="setup-footer">
        {step > 0 && <button onClick={() => setStep(s => s - 1)}>Back</button>}
        {step < totalSteps - 1
          ? (
            <button className="pri"
              style={{ opacity: canAdvance() ? 1 : 0.4, cursor: canAdvance() ? 'pointer' : 'default' }}
              onClick={() => { if (canAdvance()) setStep(s => s + 1) }}
            >
              Continue →
            </button>
          )
          : (
            <button className="pri"
              style={{ opacity: saving ? 0.6 : 1 }}
              onClick={handleFinish}
            >
              {saving ? 'Saving…' : 'Finish'}
            </button>
          )
        }
      </div>

      {/* expense sheet */}
      {expSheet && (
        <div className="ov" onClick={() => setExpSheet(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setExpSheet(false)}>×</button>
            <div className="grab" />
            <h3>{expEditId ? `Edit ${expName}` : 'Add expense'}</h3>
            <p className="sd">What goes out on a regular schedule?</p>

            <p style={{ fontSize:12, color:'var(--mut)', fontWeight:500, marginBottom:8 }}>
              How does this cost behave?
            </p>
            <div className={`modeopt${expMode === 'fixed' ? ' sel' : ''}`} onClick={() => setExpMode('fixed')}>
              <div className="mi ic fix">▤</div>
              <div>
                <div className="mt">Exact amount</div>
                <div className="ms">Same every time.</div>
                <div className="me">e.g. rent, insurance, subscriptions</div>
              </div>
            </div>
            <div className={`modeopt${expMode === 'variable' ? ' sel' : ''}`} onClick={() => setExpMode('variable')}>
              <div className="mi ic var">~</div>
              <div>
                <div className="mt">Varies — I'll confirm</div>
                <div className="ms">Set an estimate. Confirm the real figure when the bill arrives.</div>
                <div className="me">e.g. power, water</div>
              </div>
            </div>
            <div className={`modeopt${expMode === 'budget' ? ' sel' : ''}`} onClick={() => setExpMode('budget')}>
              <div className="mi ic base">≈</div>
              <div>
                <div className="mt">Just a budget</div>
                <div className="ms">A conservative number you won't itemise.</div>
                <div className="me">e.g. groceries, fuel, eating out</div>
              </div>
            </div>

            <div className="field" style={{ marginTop:6 }}>
              <label>Name</label>
              <div className="inrow"><input type="text" value={expName} onChange={e => setExpName(e.target.value)} placeholder="e.g. Rent" /></div>
            </div>
            <div className="field">
              <label>{expMode === 'variable' ? 'Estimated amount' : 'Amount'}</label>
              <div className="inrow">
                <span className="pre">$</span>
                <input type="number" inputMode="decimal" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="field">
              <label>Frequency</label>
              <div className="freq-picker">
                {FREQUENCIES.map(f => (
                  <button key={f}
                    className={`freq-opt${expFreq === f ? ' sel' : ''}`}
                    onClick={() => setExpFreq(f)}
                  >
                    {FREQ_LABELS[f]}
                  </button>
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
              <button className="pri" onClick={saveExpense}>
                {expEditId ? 'Save changes' : 'Add'}
              </button>
            </div>

            {expEditId && (
              <button
                onClick={() => removeExpense(expEditId)}
                style={{
                  display:'block', width:'100%', marginTop:12, padding:'10px',
                  background:'none', border:'none', cursor:'pointer',
                  color:'var(--floor)', fontSize:13, fontWeight:600,
                  fontFamily:"'Space Grotesk',sans-serif",
                }}
              >
                Remove this expense
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  )
}