import { useRef } from 'react'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { occurrencesOf, nthOccurrence } from '../engine/index'

/**
 * Approved controls shared by the new-look sheets. Each one is in the design
 * system's Controls list; a sheet copies these rather than drawing its own.
 */

/* ── Text field: a name or label (signed off 16 Nov) ─────────────────── */
export function TextField({ value, onChange, placeholder, label, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; label: string; autoFocus?: boolean
}) {
  return <input className="rw-field" type="text" aria-label={label} placeholder={placeholder}
    autoFocus={autoFocus} value={value} onChange={e => onChange(e.target.value)} />
}

/* ── Stepper: a count. Small square buttons in a grey pill ───────────── */
export function Stepper({ value, onChange, min = 1, max = 99, label }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; label: string
}) {
  return (
    <span className="rw-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <b aria-live="polite">{value}</b>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </span>
  )
}

/* ── Segmented control: one of a few. Grey track, selected white ─────── */
export function Segmented<T extends string>({ options, value, onChange, small }: {
  options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void; small?: boolean
}) {
  return (
    <div className={`rw-seg flush${small ? ' sm' : ''}`} role="radiogroup">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

/* ── Date chips: any date from today on ──────────────────────────────────
 * Today, the next three pay dates, and Custom (any date, from the phone's
 * own date picker). Two lines: the date, then what it is. Pick a start;
 * never a start and an end in one place. */
// The year only when it's more than about 11 months away (design system).
const chipDate = (d: string) => {
  const x = parseDate(d), far = (x.getTime() - Date.now()) / 864e5 > 330
  return x.toLocaleDateString('en-NZ', far ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
}

export function DateChips({ value, onChange, today, payDates, min, label, tagFor }: {
  value: string; onChange: (d: string) => void; today: string; payDates: string[]; min?: string; label: string
  // The second line for each date, where "today" / "payday" isn't right.
  tagFor?: (d: string, i: number) => string
}) {
  const input = useRef<HTMLInputElement>(null)
  const floor = min && min > today ? min : today
  const opts: { d: string; tag: string }[] = []
  if (floor === today) opts.push({ d: today, tag: 'today' })
  else opts.push({ d: floor, tag: 'first date' })
  for (const p of payDates) if (p > floor && opts.length < 4 && !opts.some(o => o.d === p)) opts.push({ d: p, tag: 'payday' })
  if (tagFor) opts.forEach((o, i) => { o.tag = tagFor(o.d, i) })
  const custom = !opts.some(o => o.d === value)
  return (
    <div className="rw-dchips" role="group" aria-label={label}>
      {opts.map(o => (
        <button key={o.d} type="button" className={value === o.d ? 'on' : ''} onClick={() => onChange(o.d)}>
          <b>{chipDate(o.d)}</b><span>{o.tag}</span>
        </button>
      ))}
      <label className={`rw-dchip-custom${custom ? ' on' : ''}`}>
        <b>{custom ? chipDate(value) : 'Custom'}</b><span>any date</span>
        <input ref={input} type="date" min={floor} value={value} aria-label={`${label}: any date`}
          onChange={e => { if (e.target.value && e.target.value >= floor) onChange(e.target.value) }} />
      </label>
    </div>
  )
}

/* ── How often something repeats, and when it starts and ends ─────────── */
export type How = 'once' | 'weekly' | 'fortnightly' | 'monthly' | 'annually' | 'custom'
export type Unit = 'daily' | 'weekly' | 'monthly' | 'annually'
export interface Schedule {
  how: How
  n: number                 // Custom: every n units
  unit: Unit
  first: string             // first payment (Once: the date)
  ends: 'never' | 'date' | 'count'
  endDate: string
  count: number
}

export function newSchedule(first: string): Schedule {
  return { how: 'monthly', n: 3, unit: 'monthly', first, ends: 'never', endDate: formatDate(addDays(parseDate(first), 182)), count: 4 }
}

/** The schedule as stored: frequency, every N, anchor and last date. */
export function ruleOf(s: Schedule) {
  const frequency = s.how === 'custom' ? s.unit : s.how
  const everyN = s.how === 'custom' ? Math.max(1, s.n) : 1
  let endDate: string | null = null
  if (s.how !== 'once' && s.ends === 'date') endDate = s.endDate
  if (s.how !== 'once' && s.ends === 'count') {
    endDate = formatDate(nthOccurrence(parseDate(s.first), frequency as any, everyN, Math.max(1, s.count) - 1))
  }
  return { frequency, everyN, anchorDate: s.first, endDate }
}

/** The next few dates it lands on. */
export function nextDates(s: Schedule, from: string, count = 3): string[] {
  const r = ruleOf(s)
  const item: any = { id: 'x', anchorDate: r.anchorDate, frequency: r.frequency, everyN: r.everyN, endDate: r.endDate ?? undefined, amountCents: 0 }
  return occurrencesOf(item, from, formatDate(addDays(parseDate(from), 3 * 366))).slice(0, count)
}

const HOW: { value: How; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' }, { value: 'annually', label: 'Yearly' }, { value: 'custom', label: 'Custom' },
]
const ord = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }

export function ScheduleFields({ value: s, onChange, today, payDates, min, firstLabel, repeatOnly }: {
  value: Schedule; onChange: (s: Schedule) => void; today: string; payDates: string[]; min?: string; firstLabel?: string
  // Changing how often something repeats: no Once, and no end here (Stop does that).
  repeatOnly?: boolean
}) {
  const set = (p: Partial<Schedule>) => onChange({ ...s, ...p })
  const next = nextDates(s, s.first)
  const day = parseDate(s.first).getDate()
  return (
    <>
      <div className="rw-lab">How often</div>
      <div className="rw-chips">
        {HOW.filter(h => !repeatOnly || h.value !== 'once').map(h => <button key={h.value} type="button" className={s.how === h.value ? 'on' : ''} onClick={() => set({ how: h.value })}>{h.label}</button>)}
      </div>
      {s.how === 'custom' && (
        <>
          <div className="rw-every">Every <Stepper value={s.n} onChange={n => set({ n })} label="Every how many" /></div>
          <Segmented small value={s.unit} onChange={unit => set({ unit })} options={[
            { value: 'daily', label: s.n === 1 ? 'day' : 'days' }, { value: 'weekly', label: s.n === 1 ? 'week' : 'weeks' },
            { value: 'monthly', label: s.n === 1 ? 'month' : 'months' }, { value: 'annually', label: s.n === 1 ? 'year' : 'years' }]} />
        </>
      )}

      <div className="rw-lab">{s.how === 'once' ? 'Date' : firstLabel ?? 'First payment'}</div>
      <DateChips value={s.first} onChange={first => set({ first })} today={today} payDates={payDates} min={min} label={s.how === 'once' ? 'Date' : 'First payment'} />
      {(s.how === 'monthly' || (s.how === 'custom' && s.unit === 'monthly')) && day > 28 && (
        <div className="rw-hint">In shorter months it falls on the last day, then back to the {ord(day)}.</div>
      )}

      {s.how !== 'once' && !repeatOnly && (
        <>
          <div className="rw-lab">Ends</div>
          <Segmented value={s.ends} onChange={ends => set({ ends })} options={[
            { value: 'never', label: 'Never' }, { value: 'date', label: 'On a date' }, { value: 'count', label: 'After a number' }]} />
          {s.ends === 'date' && (
            <>
              <div className="rw-sd" style={{ marginTop: 8 }}>Last payment on or before</div>
              <DateChips value={s.endDate} onChange={endDate => set({ endDate })} today={today} payDates={payDates} min={s.first} label="Last payment" />
            </>
          )}
          {s.ends === 'count' && (
            <div className="rw-every">Number of payments <Stepper value={s.count} onChange={count => set({ count })} label="Number of payments" max={240} /></div>
          )}
        </>
      )}

      <div className="rw-next">
        {next.length ? <>Next: {next.map(d => chipDate(d)).join(' · ')}{s.how !== 'once' && next.length === 3 ? ' …' : ''}</> : 'No payments in the next three years.'}
      </div>
    </>
  )
}
