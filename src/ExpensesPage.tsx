import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { getExpenses } from './lib/repository'

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'annually', 'once'] as const
type Frequency = typeof FREQUENCIES[number]
type Mode      = 'fixed' | 'variable' | 'budget'
type Sheet     = 'add' | 'edit' | null

const FREQ_LABELS: Record<Frequency, string> = {
  weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly',
  annually: 'Annually', once: 'Once',
}

const MODE_META: Record<Mode, { icon: string; iconClass: string; chip: string; chipLabel: string }> = {
  fixed:    { icon: '▤', iconClass: 'fix',  chip: 'lock', chipLabel: 'fixed'    },
  variable: { icon: '~', iconClass: 'var',  chip: 'est',  chipLabel: 'estimate' },
  budget:   { icon: '≈', iconClass: 'base', chip: 'bl',   chipLabel: 'baseline' },
}

function fmt(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function ExpensesPage({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [expenses, setExpenses] = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [darkMode, setDarkMode] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')

  // sheet state — shared fields for both add + edit
  const [sheet,      setSheet]      = useState<Sheet>(null)
  const [editingExp, setEditingExp] = useState<any>(null)
  const [name,       setName]       = useState('')
  const [amount,     setAmount]     = useState('')
  const [frequency,  setFrequency]  = useState<Frequency>('monthly')
  const [anchorDate, setAnchorDate] = useState('')
  const [mode,       setMode]       = useState<Mode>('fixed')
  const [formError,  setFormError]  = useState('')
  const [laybyExp,   setLaybyExp]   = useState<any>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try   { setExpenses(await getExpenses(userId)) }
    catch (e: any) { console.error(e) }
    finally { setLoading(false) }
  }

  // ── open add sheet ──
  function openAdd() {
    setName(''); setAmount(''); setAnchorDate('')
    setFrequency('monthly'); setMode('fixed'); setFormError('')
    setEditingExp(null); setSheet('add')
  }

  // ── open edit sheet ── pre-fill with existing data
  function openEdit(exp: any) {
    const v = (exp.expense_amount_versions ?? [])
      .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
    setName(exp.name)
    setAmount(v ? String(v.amount_cents / 100) : '')
    setFrequency(exp.frequency as Frequency)
    setAnchorDate(exp.anchor_date)
    setMode((exp.mode ?? 'fixed') as Mode)
    setFormError('')
    setEditingExp(exp)
    setSheet('edit')
  }

  function closeSheet() { setSheet(null); setEditingExp(null); setFormError('') }

  // ── save (add or edit) ──
  async function handleSave() {
    if (!name.trim() || !amount || !anchorDate) {
      setFormError('Name, amount and date are required.'); return
    }
    setSaving(true); setFormError('')
    try {
      if (sheet === 'add') {
        const { data: exp, error: e1 } = await supabase
          .from('expenses')
          .insert({ profile_id: userId, name: name.trim(), frequency, anchor_date: anchorDate, mode })
          .select().single()
        if (e1) throw e1
        const { error: e2 } = await supabase
          .from('expense_amount_versions')
          .insert({ expense_id: exp.id, amount_cents: Math.round(parseFloat(amount) * 100), effective_from: anchorDate })
        if (e2) throw e2
      } else {
        // update core fields
        const { error: e1 } = await supabase
          .from('expenses')
          .update({ name: name.trim(), frequency, anchor_date: anchorDate, mode })
          .eq('id', editingExp.id)
        if (e1) throw e1
        // insert new amount version if value changed
        const oldV = (editingExp.expense_amount_versions ?? [])
          .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
        const newCents = Math.round(parseFloat(amount) * 100)
        if (!oldV || oldV.amount_cents !== newCents) {
          const { error: e2 } = await supabase
            .from('expense_amount_versions')
            .insert({ expense_id: editingExp.id, amount_cents: newCents, effective_from: new Date().toISOString().split('T')[0] })
          if (e2) throw e2
        }
      }
      closeSheet(); await load()
    } catch (e: any) { setFormError(e.message) }
    finally { setSaving(false) }
  }

  // ── delete lay-by (soft-deletes both the expense AND the linked lay_bys row) ──
  async function handleDeleteLayby(exp: any) {
    try {
      await supabase.from('expenses').update({ is_active: false }).eq('id', exp.id)
      if (exp.lay_by_id) {
        await supabase.from('lay_bys').update({ is_active: false }).eq('id', exp.lay_by_id)
      }
      setLaybyExp(null); await load()
    } catch (e: any) { console.error(e) }
  }

  // ── delete regular expense ──
  async function handleDelete(id: string) {
    try {
      await supabase.from('expenses').update({ is_active: false }).eq('id', id)
      closeSheet(); await load()
    } catch (e: any) { setFormError(e.message) }
  }

  // ── render ────────────────────────────────────────────────────────
  return (
    <div className="app">

      <div className="appbar">
        <button className="back-btn" onClick={onBack}>← Dashboard</button>
        <div className="nm">Expenses</div>
        <button className="tgl" onClick={() => setDarkMode(d => !d)}>
          <span>{darkMode ? '☀' : '☾'}</span>
          <span className="lab">{darkMode ? 'LIGHT' : 'DARK'}</span>
        </button>
      </div>

      <div className="scrollarea">

        {loading && <p style={{ padding:24, color:'var(--mut)' }}>Loading…</p>}

        {!loading && (
          <div className="cards" style={{ paddingTop:16 }}>

            {expenses.length === 0 && (
              <p style={{ textAlign:'center', color:'var(--mut)', padding:'24px 0', fontSize:14 }}>
                No expenses yet — add one below.
              </p>
            )}

            {expenses.map(exp => {
              const m     = MODE_META[(exp.mode ?? 'fixed') as Mode]
              const v     = (exp.expense_amount_versions ?? [])
                .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
              const cents = v?.amount_cents ?? 0
              const isLayby = !!exp.lay_by_id

              return (
                <div key={exp.id} className={`card${exp.mode === 'variable' ? ' dashed' : ''}`}>
                  <div className={`ic ${isLayby ? 'evt' : m.iconClass}`}>{isLayby ? '◫' : m.icon}</div>
                  <div className="tx">
                    <div className="nm">
                      {exp.name}
                      {isLayby
                        ? <span className="chip" style={{ color:'var(--event)', borderColor:'var(--event)', background:'var(--event-s)' }}>lay-by</span>
                        : <span className={`chip ${m.chip}`}>{m.chipLabel}</span>
                      }
                    </div>
                    <div className="dt">
                      {isLayby
                        ? `${fmt(cents)}/payment · ${exp.frequency}${exp.end_date ? ' · ends ' + new Date(exp.end_date + 'T00:00:00').toLocaleDateString('en-NZ', { day:'numeric', month:'short' }) : ''}`
                        : `${fmt(cents)} · ${exp.frequency}${exp.category ? ` · ${exp.category}` : ''}`
                      }
                    </div>
                    <div className="act-row">
                      {isLayby
                        ? <span className="act" style={{ color:'var(--event)' }} onClick={() => setLaybyExp(exp)}>manage lay-by →</span>
                        : <span className="act" onClick={() => openEdit(exp)}>edit →</span>
                      }
                    </div>
                  </div>
                  <div className="vl">−{fmt(cents)}</div>
                </div>
              )
            })}

          </div>
        )}

        {!loading && (
          <div style={{ padding:'8px 16px 40px' }}>
            <button className="addbtn" onClick={openAdd}>+ Add expense</button>
          </div>
        )}

      </div>

      {/* ═══════════════════════════════════════════════════════════
          ADD / EDIT SHEET
          Same overlay for both — sheet prop drives title + behaviour.
          Edit sheet also has a delete option at the bottom.
          ═══════════════════════════════════════════════════════════ */}
      {sheet && (
        <div className="ov" onClick={closeSheet}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={closeSheet}>×</button>
            <div className="grab" />

            <h3>{sheet === 'add' ? 'Add expense' : `Edit ${name}`}</h3>
            <p className="sd">
              {sheet === 'add' ? 'What goes out on a regular schedule?' : 'Update any field — amount changes create a new version from today.'}
            </p>

            {/* ── mode picker ── */}
            <p style={{ fontSize:12, color:'var(--mut)', fontWeight:500, marginBottom:8 }}>
              How does this cost behave?
            </p>

            <div className={`modeopt${mode === 'fixed' ? ' sel' : ''}`} onClick={() => setMode('fixed')}>
              <div className="mi ic fix">▤</div>
              <div>
                <div className="mt">Exact amount</div>
                <div className="ms">Same every time. If it changes, you set a new amount from a date.</div>
                <div className="me">e.g. rent, insurance, subscriptions</div>
              </div>
            </div>
            <div className={`modeopt${mode === 'variable' ? ' sel' : ''}`} onClick={() => setMode('variable')}>
              <div className="mi ic var">~</div>
              <div>
                <div className="mt">Varies — I'll confirm</div>
                <div className="ms">Set an estimate now. Enter the real figure when the bill arrives.</div>
                <div className="me">e.g. power, water</div>
              </div>
            </div>
            <div className={`modeopt${mode === 'budget' ? ' sel' : ''}`} onClick={() => setMode('budget')}>
              <div className="mi ic base">≈</div>
              <div>
                <div className="mt">Just a budget</div>
                <div className="ms">A conservative number you won't itemise. Your real balance is the check.</div>
                <div className="me">e.g. groceries, fuel, eating out</div>
              </div>
            </div>

            {/* ── name ── */}
            <div className="field" style={{ marginTop:6 }}>
              <label>Name</label>
              <div className="inrow">
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Power" />
              </div>
            </div>

            {/* ── amount ── */}
            <div className="field">
              <label>{mode === 'variable' ? 'Estimated amount' : 'Amount'}</label>
              <div className="inrow">
                <span className="pre">$</span>
                <input type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
              </div>
              {mode === 'variable' && (
                <p className="hint">You'll confirm the real figure at close — this is the estimate the engine uses.</p>
              )}
            </div>

            {/* ── frequency — custom pill picker, no native select ── */}
            <div className="field">
              <label>Frequency</label>
              <div className="freq-picker">
                {FREQUENCIES.map(f => (
                  <button
                    key={f}
                    className={`freq-opt${frequency === f ? ' sel' : ''}`}
                    onClick={() => setFrequency(f)}
                  >
                    {FREQ_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            {/* ── anchor date ── */}
            <div className="field">
              <label>Anchor date</label>
              <div className="inrow">
                <input
                  type="date" value={anchorDate} onChange={e => setAnchorDate(e.target.value)}
                  style={{ border:'none', background:'transparent', color:'var(--ink)', fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, width:'100%', outline:'none' }}
                />
              </div>
              <p className="hint">Any past date this expense falls on — the engine repeats from there.</p>
            </div>

            {formError && <p style={{ color:'var(--floor)', fontSize:13, marginBottom:10 }}>{formError}</p>}

            <div className="navrow">
              <button onClick={closeSheet}>Cancel</button>
              <button
                className="pri"
                onClick={handleSave}
                style={{ opacity: saving ? 0.6 : 1, cursor: saving ? 'default' : 'pointer' }}
              >
                {saving ? 'Saving…' : sheet === 'add' ? 'Add expense' : 'Save changes'}
              </button>
            </div>

            {/* delete option — only shown when editing */}
            {sheet === 'edit' && editingExp && (
              <button
                onClick={() => handleDelete(editingExp.id)}
                style={{
                  display:'block', width:'100%', marginTop:12, padding:'10px',
                  background:'none', border:'none', cursor:'pointer',
                  color:'var(--floor)', fontSize:13, fontWeight:600,
                  fontFamily:"'Space Grotesk',sans-serif",
                }}
              >
                Delete this expense
              </button>
            )}

          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          LAY-BY SHEET — view details + delete
          ═══════════════════════════════════════════════════════════ */}
      {laybyExp && (
        <div className="ov" onClick={() => setLaybyExp(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setLaybyExp(null)}>×</button>
            <div className="grab" />
            <h3>{laybyExp.name}</h3>
            <p className="sd">This expense is part of a lay-by and can't be edited here. A full lay-by management view is coming.</p>
            <div className="recline"><span>Payment amount</span><b>{fmt((laybyExp.expense_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]?.amount_cents ?? 0)}</b></div>
            <div className="recline"><span>Frequency</span><b>{laybyExp.frequency}</b></div>
            {laybyExp.end_date && <div className="recline"><span>Ends</span><b>{new Date(laybyExp.end_date + 'T00:00:00').toLocaleDateString('en-NZ', { day:'numeric', month:'short', year:'numeric' })}</b></div>}
            <div className="navrow">
              <button onClick={() => setLaybyExp(null)}>Close</button>
            </div>
            <button
              onClick={() => handleDeleteLayby(laybyExp)}
              style={{
                display:'block', width:'100%', marginTop:12, padding:'10px',
                background:'none', border:'none', cursor:'pointer',
                color:'var(--floor)', fontSize:13, fontWeight:600,
                fontFamily:"'Space Grotesk',sans-serif",
              }}
            >
              Delete this lay-by
            </button>
          </div>
        </div>
      )}

    </div>
  )
}