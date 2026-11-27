import { useRef, type ReactNode } from 'react'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { occurrencesOf, nthOccurrence } from '../engine/index'
import { dateLocale } from '../lib/dateFormat'

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

/* ── Date chips: one row, at most three dates and Other ─────────────────
 * Agreed 24 Nov 2026 (mock pp-savings-by-date-6b, 3.1): the Segmented
 * control's track with four equal slots. The first date (today, or `min`),
 * then pay dates, then Other, which opens the phone's own date picker. A date
 * from Other, or one set elsewhere (a slider), sits in the Other slot and
 * stays selected. Two short lines per slot: the date, then what it is; the
 * full wording is read out. When text is large the row splits into two per
 * line. Pick a start; never a start and an end in one place. */
// No weekday; the year only when it's more than about 11 months away (design system).
const chipDate = (d: string) => {
  const x = parseDate(d), far = (x.getTime() - Date.now()) / 864e5 > 330
  const dm = x.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
  return far ? `${dm} ’${String(x.getFullYear()).slice(2)}` : dm
}
const CHIP_SAYS: Record<string, string> = { earliest: 'earliest date that fits', 'too soon': 'too soon, a payday goes under your floor' }
const chipTone = (tag: string) => tag === 'earliest' ? ' good' : tag === 'too soon' ? ' near' : ''

export function DateChips({ value, onChange, today, payDates, min, otherMin, keep, label, tagFor }: {
  value: string; onChange: (d: string) => void; today: string; payDates: string[]; min?: string; label: string
  // Other may go earlier than the first slot (a date that's too soon is still allowed).
  otherMin?: string
  // A date that must keep its slot when there are more than three (the earliest that fits).
  keep?: string | null
  // The second line for each date, where "today" / "payday" isn't right. Keep it to a word or two.
  tagFor?: (d: string, i: number) => string
}) {
  const input = useRef<HTMLInputElement>(null)
  const floor = min && min > today ? min : today
  let opts: { d: string; tag: string }[] = [{ d: floor, tag: floor === today ? 'today' : 'first date' }]
  for (const p of payDates) if (p > floor && !opts.some(o => o.d === p)) opts.push({ d: p, tag: 'payday' })
  if (opts.length > 3) {
    const kept = keep ? opts.find((o, i) => i > 2 && o.d === keep) : null
    opts = kept ? [...opts.slice(0, 2), kept] : opts.slice(0, 3)
  }
  if (tagFor) opts.forEach((o, i) => { o.tag = tagFor(o.d, i) })
  const other = !!value && !opts.some(o => o.d === value)
  const otherTag = other && tagFor ? tagFor(value, 3) : 'other'
  const pickMin = otherMin && otherMin < floor ? otherMin : floor
  return (
    <div className="rw-dchips-w">
      <div className="rw-dchips" role="radiogroup" aria-label={label}>
        {opts.map(o => (
          <button key={o.d} type="button" role="radio" aria-checked={value === o.d} className={value === o.d ? 'on' : ''}
            aria-label={`${chipDate(o.d)}, ${CHIP_SAYS[o.tag] ?? o.tag}`} onClick={() => onChange(o.d)}>
            <b>{chipDate(o.d)}</b><span className={chipTone(o.tag)}>{o.tag}</span>
          </button>
        ))}
        <label className={`rw-dchip-custom${other ? ' on' : ''}`}>
          <b>{other ? chipDate(value) : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M16 3v4M8 3v4M4 11h16" /></svg>}</b>
          <span className={other ? chipTone(otherTag) : ''}>{other ? otherTag : 'other'}</span>
          <input ref={input} type="date" min={pickMin} value={value}
            aria-label={other ? `${label}: ${chipDate(value)}, ${CHIP_SAYS[otherTag] ?? otherTag}. Pick another date` : `${label}: another date`}
            onChange={e => { if (e.target.value && e.target.value >= pickMin) onChange(e.target.value) }} />
        </label>
      </div>
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

export function ScheduleFields({ value: s, onChange, today, payDates, min, firstLabel, repeatOnly, afterHow, howOnly }: {
  value: Schedule; onChange: (s: Schedule) => void; today: string; payDates: string[]; min?: string; firstLabel?: string
  // Changing how often something repeats: no Once, and no end here (Stop does that).
  repeatOnly?: boolean
  // Shown straight after How often (the + sheet's "money were tight?" question).
  afterHow?: ReactNode
  // How often only: the rest isn't needed (it's going on the Wishlist instead).
  howOnly?: boolean
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

      {afterHow}
      {!howOnly && <>
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
      </>}
    </>
  )
}
