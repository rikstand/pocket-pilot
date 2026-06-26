import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { getExpenses, getLayBys } from './lib/repository'
import { ExpenseIcon, guessIcon, iconLabel, ICON_GROUPS } from './lib/icons'

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'annually', 'once'] as const
type Frequency = typeof FREQUENCIES[number]
type Mode      = 'fixed' | 'variable' | 'budget'
type Sheet     = 'add' | 'edit' | null

const FREQ_LABELS: Record<Frequency, string> = {
  weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly',
  annually: 'Annually', once: 'Once',
}

const MODE_META: Record<Mode, { iconClass: string; chip: string; chipLabel: string; col: string; sft: string }> = {
  fixed:    { iconClass: 'fix',  chip: 'lock', chipLabel: 'fixed',    col: 'var(--acc)',  sft: 'var(--acc-s)' },
  variable: { iconClass: 'var',  chip: 'est',  chipLabel: 'estimate', col: 'var(--warn)', sft: 'var(--warn-s)' },
  budget:   { iconClass: 'base', chip: 'bl',   chipLabel: 'baseline', col: 'var(--mut)',  sft: 'var(--line2)' },
}

function fmt(cents: number) {
  return '$' + (Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function toFn(cents: number, freq: string): number {
  if (freq === 'weekly')      return cents * 2
  if (freq === 'fortnightly') return cents
  if (freq === 'monthly')     return Math.round(cents * 14 / 30.44)
  if (freq === 'annually')    return Math.round(cents * 14 / 365.25)
  return cents
}

const FREQ_SHORT: Record<string, string> = {
  weekly: 'wk', fortnightly: 'fn', monthly: 'mo', annually: 'yr', once: 'one-off',
}

function cycleDetail(cents: number, freq: string, isEstimate: boolean): string {
  const prefix = isEstimate ? '~' : ''
  const raw = prefix + fmt(cents)
  const abbr = FREQ_SHORT[freq] || freq
  if (freq === 'once') return `${raw} one-off`
  if (freq === 'fortnightly') return `${raw}/fn`
  const norm = prefix + fmt(toFn(cents, freq))
  return `${raw}/${abbr} → ${norm}/fn`
}

export default function ExpensesPage({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [expenses, setExpenses] = useState<any[]>([])
  const [layBys,   setLayBys]   = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [darkMode, setDarkMode] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [sheet,      setSheet]      = useState<Sheet>(null)
  const [editingExp, setEditingExp] = useState<any>(null)
  const [name,       setName]       = useState('')
  const [amount,     setAmount]     = useState('')
  const [frequency,  setFrequency]  = useState<Frequency>('monthly')
  const [anchorDate, setAnchorDate] = useState('')
  const [mode,       setMode]       = useState<Mode>('fixed')
  const [icon,       setIcon]       = useState('card')
  const [iconManual, setIconManual] = useState(false)
  const [formError,  setFormError]  = useState('')
  const [laybyExp,   setLaybyExp]   = useState<any>(null)
  const [galOpen,    setGalOpen]    = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (sheet === 'add' && !iconManual && name.trim()) {
      setIcon(guessIcon(name))
    }
  }, [name, sheet, iconManual])

  async function load() {
    setLoading(true)
    try {
      const [exps, lbs] = await Promise.all([getExpenses(userId), getLayBys(userId)])
      setExpenses(exps); setLayBys(lbs)
    } catch (e: any) { console.error(e) }
    finally { setLoading(false) }
  }

  function toggleSection(key: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function openAdd() {
    setName(''); setAmount(''); setAnchorDate('')
    setFrequency('monthly'); setMode('fixed')
    setIcon('card'); setIconManual(false)
    setFormError(''); setEditingExp(null); setSheet('add')
  }

  function openEdit(exp: any) {
    const v = (exp.expense_amount_versions ?? [])
      .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
    setName(exp.name)
    setAmount(v ? String(v.amount_cents / 100) : '')
    setFrequency(exp.frequency as Frequency)
    setAnchorDate(exp.anchor_date)
    setMode((exp.mode ?? 'fixed') as Mode)
    setIcon(exp.icon || guessIcon(exp.name))
    setIconManual(true)
    setFormError('')
    setEditingExp(exp)
    setSheet('edit')
  }

  function closeSheet() { setSheet(null); setEditingExp(null); setFormError(''); setGalOpen(false) }

  function chooseIcon(n: string) { setIcon(n); setIconManual(true); setGalOpen(false) }

  async function handleSave() {
    if (!name.trim() || !amount || !anchorDate) {
      setFormError('Name, amount and date are required.'); return
    }
    setSaving(true); setFormError('')
    try {
      if (sheet === 'add') {
        const { data: exp, error: e1 } = await supabase
          .from('expenses')
          .insert({ profile_id: userId, name: name.trim(), frequency, anchor_date: anchorDate, mode, icon })
          .select().single()
        if (e1) throw e1
        const { error: e2 } = await supabase
          .from('expense_amount_versions')
          .insert({ expense_id: exp.id, amount_cents: Math.round(parseFloat(amount) * 100), effective_from: anchorDate })
        if (e2) throw e2
      } else {
        const { error: e1 } = await supabase
          .from('expenses')
          .update({ name: name.trim(), frequency, anchor_date: anchorDate, mode, icon })
          .eq('id', editingExp.id)
        if (e1) throw e1
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

  async function handleDeleteLayby(exp: any) {
    try {
      await supabase.from('expenses').update({ is_active: false }).eq('id', exp.id)
      if (exp.lay_by_id) {
        await supabase.from('lay_bys').update({ is_active: false }).eq('id', exp.lay_by_id)
      }
      setLaybyExp(null); await load()
    } catch (e: any) { console.error(e) }
  }

  async function handleDelete(id: string) {
    try {
      await supabase.from('expenses').update({ is_active: false }).eq('id', id)
      closeSheet(); await load()
    } catch (e: any) { setFormError(e.message) }
  }

  // ── group expenses ──────────────────────────────────────────────
  const fixedExps  = expenses.filter(e => (e.mode ?? 'fixed') === 'fixed' && !e.lay_by_id)
  const varExps    = expenses.filter(e => e.mode === 'variable')
  const budgetExps = expenses.filter(e => e.mode === 'budget')
  const laybyExps  = expenses.filter(e => !!e.lay_by_id)

  function latestCents(exp: any): number {
    const v = (exp.expense_amount_versions ?? [])
      .sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]
    return v?.amount_cents ?? 0
  }

  function groupTotalFn(exps: any[]): number {
    return exps.reduce((sum, e) => sum + toFn(latestCents(e), e.frequency), 0)
  }

  const fixedTotal  = groupTotalFn(fixedExps)
  const varTotal    = groupTotalFn(varExps)
  const budgetTotal = groupTotalFn(budgetExps)
  const laybyTotal  = groupTotalFn(laybyExps)

  const m = sheet ? MODE_META[mode] : MODE_META['fixed']

  // ── render helpers ──────────────────────────────────────────────
  function renderRow(exp: any) {
    const cents    = latestCents(exp)
    const expMode  = (exp.mode ?? 'fixed') as Mode
    const em       = MODE_META[expMode]
    const expIcon  = exp.icon || guessIcon(exp.name)
    const isEstimate = expMode === 'variable'
    const fnCents  = toFn(cents, exp.frequency)

    let rightLabel = 'THIS CYCLE'
    if (isEstimate)            rightLabel = 'ESTIMATE'
    else if (expMode === 'budget') rightLabel = 'PER CYCLE'

    return (
      <div key={exp.id} className="exp-row" onClick={() => openEdit(exp)}>
        <div className="ri" style={{ background: em.sft, color: em.col }}>
          <ExpenseIcon name={expIcon} size={16} />
        </div>
        <div className="rm">
          <div className="rn">{exp.name}</div>
          <div className="rd">{cycleDetail(cents, exp.frequency, isEstimate)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="rv">−{fmt(fnCents)}</div>
          <div className="rf">{rightLabel}</div>
        </div>
      </div>
    )
  }

  function renderLaybyRow(exp: any) {
    const cents   = latestCents(exp)
    const expIcon = exp.icon || 'gift'
    const layby   = layBys.find((l: any) => l.id === exp.lay_by_id)

    const totalPayments = layby?.payments_total ?? 1
    const targetCents   = layby?.target_amount_cents ?? 0
    const todayStr      = new Date().toISOString().split('T')[0]
    const sortedVersions = [...(exp.expense_amount_versions ?? [])]
      .sort((a: any, b: any) => a.effective_from < b.effective_from ? -1 : 1)
    const paidCount = sortedVersions.filter((v: any) => v.effective_from <= todayStr).length
    const paidCents = sortedVersions
      .filter((v: any) => v.effective_from <= todayStr)
      .reduce((s: number, v: any) => s + v.amount_cents, 0)
    const remainingCents = Math.max(0, targetCents - paidCents)
    const progress = totalPayments > 0 ? Math.min(paidCount / totalPayments, 1) : 0

    return (
      <div key={exp.id} className="exp-row" onClick={() => setLaybyExp(exp)}>
        <div className="ri" style={{ background: 'var(--event-s)', color: 'var(--event)' }}>
          <ExpenseIcon name={expIcon} size={16} />
        </div>
        <div className="rm">
          <div className="rn">{exp.name}</div>
          <div className="rd">{paidCount} of {totalPayments} · {fmt(remainingCents)} left · {exp.frequency}</div>
          <div className="exp-prog"><div className="fill" style={{ width: `${Math.round(progress * 100)}%`, background: 'var(--event)' }} /></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="rv">−{fmt(cents)}</div>
          <div className="rf">PER PAYMENT</div>
        </div>
      </div>
    )
  }

  type SectionDef = { key: string; label: string; color: string; exps: any[]; total: number; isLayby?: boolean }
  const sections: SectionDef[] = [
    { key: 'fixed',    label: 'Fixed',     color: 'var(--acc)',   exps: fixedExps,  total: fixedTotal },
    { key: 'variable', label: 'Estimates', color: 'var(--warn)',  exps: varExps,    total: varTotal },
    { key: 'budget',   label: 'Budget',    color: 'var(--mut)',   exps: budgetExps, total: budgetTotal },
    { key: 'layby',    label: 'Lay-bys',   color: 'var(--event)', exps: laybyExps,  total: laybyTotal, isLayby: true },
  ].filter(s => s.exps.length > 0)

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

        {loading && <p style={{ padding: 24, color: 'var(--mut)' }}>Loading…</p>}

        {!loading && expenses.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--mut)', padding: '40px 24px', fontSize: 14 }}>
            No expenses yet — add one below.
          </p>
        )}

        {!loading && expenses.length > 0 && <>
          <div className="exp-sum" style={{ marginTop: 12 }}>
            {fixedTotal > 0  && <div style={{ flex: fixedTotal,  background: 'var(--acc)' }} />}
            {varTotal > 0    && <div style={{ flex: varTotal,    background: 'var(--warn)' }} />}
            {budgetTotal > 0 && <div style={{ flex: budgetTotal, background: 'var(--mut)' }} />}
            {laybyTotal > 0  && <div style={{ flex: laybyTotal,  background: 'var(--event)' }} />}
          </div>
          <div className="exp-sum-leg">
            {fixedTotal > 0  && <span><span className="dot" style={{ background: 'var(--acc)' }} />{fmt(fixedTotal)} fixed</span>}
            {varTotal > 0    && <span><span className="dot" style={{ background: 'var(--warn)' }} />{fmt(varTotal)} varies</span>}
            {budgetTotal > 0 && <span><span className="dot" style={{ background: 'var(--mut)' }} />{fmt(budgetTotal)} budget</span>}
            {laybyTotal > 0  && <span><span className="dot" style={{ background: 'var(--event)' }} />{fmt(laybyTotal)} lay-by</span>}
          </div>

          {sections.map(sec => {
            const isOpen = !collapsed.has(sec.key)
            return (
              <div key={sec.key} className="exp-sec">
                <div className="exp-sec-hd" onClick={() => toggleSection(sec.key)}>
                  <div className="lbl" style={{ color: sec.color }}>
                    {sec.label} <span className="cnt">{sec.exps.length}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="tot" style={{ color: sec.color }}>−{fmt(sec.total)}</span>
                    <span className={`chv${isOpen ? ' up' : ''}`}>▾</span>
                  </div>
                </div>
                {isOpen && (
                  <div className="exp-rows">
                    {sec.isLayby
                      ? sec.exps.map(exp => renderLaybyRow(exp))
                      : sec.exps.map(exp => renderRow(exp))
                    }
                  </div>
                )}
              </div>
            )
          })}
        </>}

        {!loading && (
          <div style={{ padding: '12px 16px 40px' }}>
            <button className="addbtn" onClick={openAdd}>+ Add expense</button>
          </div>
        )}

      </div>

      {/* ═══════════ ADD / EDIT SHEET ═══════════ */}
      {sheet && (
        <div className="ov" onClick={closeSheet}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={closeSheet}>×</button>
            <div className="grab" />

            <h3>{sheet === 'add' ? 'Add expense' : `Edit ${name}`}</h3>
            <p className="sd">
              {sheet === 'add' ? 'What goes out on a regular schedule?' : 'Update any field — amount changes create a new version from today.'}
            </p>

            <p style={{ fontSize: 12, color: 'var(--mut)', fontWeight: 500, marginBottom: 8 }}>
              How does this cost behave?
            </p>

            <div className={`modeopt${mode === 'fixed' ? ' sel' : ''}`} onClick={() => setMode('fixed')}>
              <div className="mi ic fix"><ExpenseIcon name={icon} size={18} /></div>
              <div>
                <div className="mt">Exact amount</div>
                <div className="ms">Same every time. If it changes, you set a new amount from a date.</div>
                <div className="me">e.g. rent, insurance, subscriptions</div>
              </div>
            </div>
            <div className={`modeopt${mode === 'variable' ? ' sel' : ''}`} onClick={() => setMode('variable')}>
              <div className="mi ic var"><ExpenseIcon name={icon} size={18} /></div>
              <div>
                <div className="mt">Varies — I'll confirm</div>
                <div className="ms">Set an estimate now. Enter the real figure when the bill arrives.</div>
                <div className="me">e.g. power, water</div>
              </div>
            </div>
            <div className={`modeopt${mode === 'budget' ? ' sel' : ''}`} onClick={() => setMode('budget')}>
              <div className="mi ic base"><ExpenseIcon name={icon} size={18} /></div>
              <div>
                <div className="mt">Just a budget</div>
                <div className="ms">A conservative number you won't itemise. Your real balance is the check.</div>
                <div className="me">e.g. groceries, fuel, eating out</div>
              </div>
            </div>

            <div className="field" style={{ marginTop: 6 }}>
              <label>Name</label>
              <div className="inrow">
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Power" />
              </div>
            </div>

            <div className="field">
              <label>Icon</label>
              <div className="iconrow" onClick={() => setGalOpen(true)}>
                <div className="sw" style={{ background: m.sft, color: m.col }}>
                  <ExpenseIcon name={icon} size={22} />
                </div>
                <div>
                  <div className="it">{iconLabel(icon)}</div>
                  <div className="is">{sheet === 'add' && !iconManual ? 'Auto-picked from name — tap to change' : 'Tap to change'}</div>
                </div>
                <div className="go">CHANGE</div>
              </div>
            </div>

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

            <div className="field">
              <label>Frequency</label>
              <div className="freq-picker">
                {FREQUENCIES.map(f => (
                  <button key={f} className={`freq-opt${frequency === f ? ' sel' : ''}`} onClick={() => setFrequency(f)}>
                    {FREQ_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Anchor date</label>
              <div className="inrow">
                <input
                  type="date" value={anchorDate} onChange={e => setAnchorDate(e.target.value)}
                  style={{ border: 'none', background: 'transparent', color: 'var(--ink)', fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 600, width: '100%', outline: 'none' }}
                />
              </div>
              <p className="hint">Any past date this expense falls on — the engine repeats from there.</p>
            </div>

            {formError && <p style={{ color: 'var(--floor)', fontSize: 13, marginBottom: 10 }}>{formError}</p>}

            <div className="navrow">
              <button onClick={closeSheet}>Cancel</button>
              <button className="pri" onClick={handleSave} style={{ opacity: saving ? 0.6 : 1, cursor: saving ? 'default' : 'pointer' }}>
                {saving ? 'Saving…' : sheet === 'add' ? 'Add expense' : 'Save changes'}
              </button>
            </div>

            {sheet === 'edit' && editingExp && (
              <button onClick={() => handleDelete(editingExp.id)} style={{
                display: 'block', width: '100%', marginTop: 12, padding: '10px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--floor)', fontSize: 13, fontWeight: 600,
                fontFamily: "'Space Grotesk',sans-serif",
              }}>
                Delete this expense
              </button>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ ICON GALLERY ═══════════ */}
      {galOpen && (
        <div className="ov" style={{ zIndex: 60 }} onClick={() => setGalOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setGalOpen(false)}>×</button>
            <div className="grab" />
            <h3>Choose an icon</h3>
            <p className="sd">Colour follows the expense's mode — just pick the shape.</p>
            <div style={{ overflowY: 'auto', flex: '1 1 auto' }}>
              {ICON_GROUPS.map(([group, names]) => (
                <div key={group}>
                  <div className="galgrp">{group}</div>
                  <div className="galgrid">
                    {names.map(n => (
                      <div key={n} className={`galcell${n === icon ? ' sel' : ''}`} onClick={() => chooseIcon(n)}>
                        <ExpenseIcon name={n} size={22} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ LAY-BY SHEET ═══════════ */}
      {laybyExp && (
        <div className="ov" onClick={() => setLaybyExp(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <button className="xbtn" onClick={() => setLaybyExp(null)}>×</button>
            <div className="grab" />
            <h3>{laybyExp.name}</h3>
            <p className="sd">This expense is part of a lay-by and can't be edited here. A full lay-by management view is coming.</p>
            <div className="recline"><span>Payment amount</span><b>{fmt((laybyExp.expense_amount_versions ?? []).sort((a: any, b: any) => a.effective_from > b.effective_from ? -1 : 1)[0]?.amount_cents ?? 0)}</b></div>
            <div className="recline"><span>Frequency</span><b>{laybyExp.frequency}</b></div>
            {laybyExp.end_date && <div className="recline"><span>Ends</span><b>{new Date(laybyExp.end_date + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</b></div>}
            <div className="navrow">
              <button onClick={() => setLaybyExp(null)}>Close</button>
            </div>
            <button onClick={() => handleDeleteLayby(laybyExp)} style={{
              display: 'block', width: '100%', marginTop: 12, padding: '10px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--floor)', fontSize: 13, fontWeight: 600,
              fontFamily: "'Space Grotesk',sans-serif",
            }}>
              Delete this lay-by
            </button>
          </div>
        </div>
      )}

    </div>
  )
}