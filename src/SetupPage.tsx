import { useState } from 'react'
import { supabase } from './lib/supabase'
import { upsertProfile } from './lib/repository'

const frequencies = ['weekly', 'fortnightly', 'monthly', 'annually'] as const

export default function SetupPage({ userId, onComplete }: { userId: string, onComplete: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [incomeName, setIncomeName] = useState('')
  const [incomeAmount, setIncomeAmount] = useState('')
  const [incomeFrequency, setIncomeFrequency] = useState<typeof frequencies[number]>('fortnightly')
  const [anchorDate, setAnchorDate] = useState('')
  const [openingBalance, setOpeningBalance] = useState('')
  const [safetyFloor, setSafetyFloor] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    setError('')
    if (!displayName || !incomeName || !incomeAmount || !anchorDate || !openingBalance) {
      setError('Please fill in all required fields.')
      return
    }

    setLoading(true)
    try {
      // 1. Create profile
      await upsertProfile(
        userId,
        displayName,
        safetyFloor ? Math.round(parseFloat(safetyFloor) * 100) : 0
      )

      // 2. Create income source
      const { data: incomeSource, error: incomeError } = await supabase
        .from('income_sources')
        .insert({
          profile_id: userId,
          name: incomeName,
          frequency: incomeFrequency,
          anchor_date: anchorDate,
          is_primary: true,
        })
        .select()
        .single()
      if (incomeError) throw incomeError

      // 3. Create income amount version
      const { error: amountError } = await supabase
        .from('income_amount_versions')
        .insert({
          income_source_id: incomeSource.id,
          amount_cents: Math.round(parseFloat(incomeAmount) * 100),
          effective_from: anchorDate,
        })
      if (amountError) throw amountError

      // 4. Create the first cycle
      // We'll use the anchor date as the start of the first cycle
      // and opening balance as what's in the account right now
      const start = new Date(anchorDate)
      const end = new Date(start)
      if (incomeFrequency === 'weekly') end.setDate(end.getDate() + 6)
      else if (incomeFrequency === 'fortnightly') end.setDate(end.getDate() + 13)
      else if (incomeFrequency === 'monthly') { end.setMonth(end.getMonth() + 1); end.setDate(end.getDate() - 1) }
      else { end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1) }

      const { error: cycleError } = await supabase
        .from('cycles')
        .insert({
          profile_id: userId,
          start_date: start.toISOString().split('T')[0],
          end_date: end.toISOString().split('T')[0],
          opening_balance_cents: Math.round(parseFloat(openingBalance) * 100),
        })
      if (cycleError) throw cycleError

      onComplete()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const fieldStyle = {
    display: 'block', width: '100%', marginBottom: 12, padding: 8, fontSize: 16, boxSizing: 'border-box' as const
  }
  const labelStyle = { display: 'block', marginBottom: 4, fontWeight: 'bold' as const }

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h1 style={{ whiteSpace: 'nowrap' }}>Welcome to Pocket Pilot</h1>
      <p style={{ color: '#555', marginBottom: 24 }}>Let's get your account set up.</p>

      <label style={labelStyle}>Your name *</label>
      <input style={fieldStyle} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Alex" />

      <hr style={{ margin: '16px 0' }} />
      <h2 style={{ marginBottom: 16 }}>Primary Income</h2>

      <label style={labelStyle}>Income name *</label>
      <input style={fieldStyle} value={incomeName} onChange={e => setIncomeName(e.target.value)} placeholder="e.g. Salary" />

      <label style={labelStyle}>Amount (NZD) *</label>
      <input style={fieldStyle} type="number" value={incomeAmount} onChange={e => setIncomeAmount(e.target.value)} placeholder="e.g. 3200" />

      <label style={labelStyle}>Frequency *</label>
      <select style={fieldStyle} value={incomeFrequency} onChange={e => setIncomeFrequency(e.target.value as any)}>
        {frequencies.map(f => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
      </select>

      <label style={labelStyle}>Next pay date * <span style={{ fontWeight: 'normal', color: '#555' }}>(the date your next pay lands)</span></label>
      <input style={fieldStyle} type="date" value={anchorDate} onChange={e => setAnchorDate(e.target.value)} />

      <hr style={{ margin: '16px 0' }} />
      <h2 style={{ marginBottom: 16 }}>Starting Balance</h2>

      <label style={labelStyle}>Current account balance (NZD) *</label>
      <input style={fieldStyle} type="number" value={openingBalance} onChange={e => setOpeningBalance(e.target.value)} placeholder="e.g. 1500" />

      <label style={labelStyle}>Safety floor (NZD) <span style={{ fontWeight: 'normal', color: '#555' }}>— optional minimum you never want to go below</span></label>
      <input style={fieldStyle} type="number" value={safetyFloor} onChange={e => setSafetyFloor(e.target.value)} placeholder="e.g. 500" />

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={loading}
        style={{ width: '100%', padding: 12, fontSize: 16, marginTop: 8 }}
      >
        {loading ? 'Saving…' : 'Save and continue →'}
      </button>
    </div>
  )
}