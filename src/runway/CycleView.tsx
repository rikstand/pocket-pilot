import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseDate, addDays, formatDate } from '../engine/dates'
import type { Runway } from './runwaySeries'

/**
 * The Cycle screen in the new look (Journey 8): Hero E, the runway, and one
 * list ordered around today. It only draws: every number arrives from the
 * Dashboard, and every tap calls back into it, so the sheets behind each row
 * are today's sheets until their own journeys replace them.
 */

export type Mark = 'fixed' | 'estimate' | 'income' | 'savings' | 'credit' | 'bnpl'

export interface DayItem {
  key: string
  date: string
  name: string
  mark: Mark
  amountCents: number          // positive; isIn says which way
  isIn?: boolean
  estimate?: boolean           // shown with ~ until confirmed
  sub: string
  needs?: boolean              // date passed and still open
  needsText?: string           // "not confirmed", "not set aside"
  action?: { label: string; run: () => void }
  donePill?: string
  onOpen?: () => void
  payday?: boolean             // the pay that starts the next cycle
  progress?: number            // 0–1, a thin bar under the row (the card paid down)
}

export interface BudgetRow {
  id: string
  name: string
  spentCents: number
  plannedCents: number
  onOpen: () => void
  onPlus?: () => void
  plusOpen?: boolean
  flag?: 'over' | 'under' | null    // usually off (budget nudge)
  quickAdd?: ReactNode
}

interface Props {
  start: string
  end: string
  today: string
  payDate: string
  payName: string
  floorCents: number
  closingCents: number
  cardLine: { cents: number; name: string } | null
  runway: Runway
  items: DayItem[]
  budgets: BudgetRow[]
  showClose: boolean
  ended: boolean
  // Cycles that ended without being closed (Journey 10). Takes the close banner's place.
  catchUp?: { count: number; from: string; to: string; onOpen: () => void }
  onClose: () => void
  onForecast: () => void
  onPast?: () => void            // ‹ to closed cycles (Journey 10), when there are any
  // A future cycle opened from Forecast (Journey 6): ‹ › step between cycles,
  // and a way back to the Forecast page.
  forecastNav?: { onPrev?: () => void; onNext?: () => void; onBack: () => void }
  onAddToCycle: () => void
  byType: ReactNode
  money: (cents: number) => string
}

const day = (d: string, month = false) =>
  parseDate(d).toLocaleDateString('en-NZ', month
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { weekday: 'short', day: 'numeric' }).replace(',', '')
const nextDay = (d: string) => formatDate(addDays(parseDate(d), 1))
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/* ── type marks: 9px shapes, never icons ── */
function MarkShape({ mark }: { mark: Mark }) {
  const box = { className: 'rw-mark', viewBox: '0 0 10 10', 'aria-hidden': true }
  switch (mark) {
    case 'fixed':    return <svg {...box}><circle cx="5" cy="5" r="4" fill="var(--rw-muted)" /></svg>
    case 'estimate': return <svg {...box}><circle cx="5" cy="5" r="3.6" fill="none" stroke="var(--rw-muted)" strokeWidth="1.4" strokeDasharray="2 1.6" /></svg>
    case 'income':   return <svg {...box}><path d="M5 1v8M1.5 4.5L5 1l3.5 3.5" fill="none" stroke="var(--rw-good)" strokeWidth="1.6" /></svg>
    case 'savings':  return <svg {...box}><path d="M5 1L9 5L5 9L1 5Z" fill="var(--rw-line)" /></svg>
    case 'credit':   return <svg {...box}><rect x="1" y="1" width="8" height="8" rx="1.6" fill="var(--rw-credit)" /></svg>
    case 'bnpl':     return <svg {...box}><circle cx="5" cy="5" r="3.8" fill="none" stroke="var(--rw-bnpl)" strokeWidth="1.4" /><path d="M5 1.2A3.8 3.8 0 0 1 5 8.8Z" fill="var(--rw-bnpl)" /></svg>
  }
}

export default function CycleView(p: Props) {
  const [tab, setTab] = useState<'day' | 'type'>('day')
  const [earlyOpen, setEarlyOpen] = useState(false)
  const [allBudgets, setAllBudgets] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const { runway, today, money } = p

  const n = runway.days.length
  const todayIdx = runway.days.indexOf(today)            // -1 once the cycle has ended
  const tomorrow = nextDay(today)
  const balanceAfter = (date: string) => {
    const i = runway.days.indexOf(date)
    return i >= 0 ? runway.balances[i] : p.closingCents
  }

  /* ── hero E ── */
  const spare = p.closingCents - p.floorCents
  const level = p.closingCents < 0 ? 'under' : spare < 0 ? 'near' : 'ok'
  const heroValue = level === 'under' ? p.closingCents : spare
  const heroWords = level === 'under' ? 'overdrawn before pay' : level === 'near' ? 'into your floor before pay' : 'spare before pay'

  /* ── the list, ordered around today ── */
  const payRow: DayItem | null = p.payDate ? {
    key: 'payday', date: p.payDate, name: p.payName, mark: 'income', amountCents: 0, isIn: true,
    sub: 'Payday · starts the next cycle', payday: true,
  } : null
  const needs = p.items.filter(i => i.needs)
  const rest = p.items.filter(i => !i.needs)
  const todays = rest.filter(i => i.date === today)
  const tomorrows = rest.filter(i => i.date === tomorrow)
  const coming = rest.filter(i => i.date > tomorrow)
  const earlier = rest.filter(i => i.date < today)
  if (payRow) (payRow.date === tomorrow ? tomorrows : coming).push(payRow)
  const nextUp = p.items.filter(i => i.date > today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? payRow
  const inCycle = todayIdx >= 0

  const earlierIn = earlier.filter(i => i.isIn).reduce((s, i) => s + i.amountCents, 0)
  const earlierOut = earlier.filter(i => !i.isIn).reduce((s, i) => s + i.amountCents, 0)

  // A tap on a runway dot opens Earlier if needed and brings its row into view.
  function jump(date: string) {
    setTab('day')
    const target = p.items.find(i => i.date === date)
    if (!target) return
    if (!target.needs && target.date < today) setEarlyOpen(true)
    setFlash(target.key)
  }
  useEffect(() => {
    if (!flash) return
    const el = document.getElementById('rw-it-' + flash)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = window.setTimeout(() => setFlash(null), 1200)
    return () => window.clearTimeout(t)
  }, [flash, earlyOpen])

  function row(i: DayItem, mode: 'needs' | 'today' | 'up' | 'earlier') {
    const sub = mode === 'needs'
      ? <span className="rw-warn">{day(i.date)} · {i.needsText}</span>
      : mode === 'today' ? i.sub : `${day(i.date)} · ${i.sub}`
    const showAction = mode !== 'up' && i.date <= today
    const right = showAction && i.action
      ? <button type="button" className="rw-mini" onClick={e => { e.stopPropagation(); i.action!.run() }}>{i.action.label}</button>
      : showAction && i.donePill && mode === 'earlier'
        ? <span className="rw-pill good">{i.donePill}</span>
        : (
          <div className={`rw-am${i.isIn ? ' in' : ''}`}>
            {i.payday ? '' : <>{i.isIn ? '+' : ''}{i.estimate ? '~' : ''}{money(i.amountCents)}</>}
            {mode === 'up' && <small>{i.payday ? `${money(p.closingCents)} before` : `leaves ${money(balanceAfter(i.date))}`}</small>}
          </div>
        )
    return (
      <div key={i.key} id={'rw-it-' + i.key}
        className={`rw-row${mode === 'needs' ? ' needs' : ''}${mode === 'earlier' ? ' done' : ''}${flash === i.key ? ' flash' : ''}${i.onOpen ? '' : ' static'}`}
        role={i.onOpen ? 'button' : undefined} tabIndex={i.onOpen ? 0 : undefined}
        onClick={i.onOpen}>
        <MarkShape mark={i.mark} />
        <div className="rw-tx">
          <div className="rw-row-name">{i.name}</div>
          <div className="rw-sub">{sub}</div>
          {i.progress != null && <div className="rw-pb-row"><i style={{ width: Math.round(Math.min(1, Math.max(0, i.progress)) * 100) + '%' }} /></div>}
        </div>
        {right}
      </div>
    )
  }

  const daysLeft = inCycle ? n - 1 - todayIdx : 0
  const budgetSpent = p.budgets.reduce((s, b) => s + b.spentCents, 0)
  const budgetPlanned = p.budgets.reduce((s, b) => s + b.plannedCents, 0)
  const future = n > 0 && runway.days[0] > today      // a forecast cycle, opened from Forecast
  const pace = inCycle ? (todayIdx + 1) / n : future ? 0 : 1
  const shownBudgets = allBudgets ? p.budgets : p.budgets.slice(0, 3)

  return (
    <div className="rw-page">
      {/* ── which cycle ── */}
      {p.forecastNav ? <>
      <div className="rw-cnav">
        <button type="button" className="rw-cnav-b" aria-label="Earlier cycle" disabled={!p.forecastNav.onPrev} onClick={p.forecastNav.onPrev}>‹</button>
        <div className="rw-cnav-t">
          <b>{day(p.start)} – {day(p.end, true)}</b>
          <span>{inCycle ? `This cycle · day ${todayIdx + 1} of ${n} · ` : 'Forecast · '}{p.payName} {day(p.payDate)}</span>
        </div>
        <button type="button" className="rw-cnav-b" aria-label="Later cycle" disabled={!p.forecastNav.onNext} onClick={p.forecastNav.onNext}>›</button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 6 }}>
        <button type="button" className="rw-today" onClick={p.forecastNav.onBack}>Back to Forecast</button>
      </div>
      </> : <div className="rw-cnav">
        {p.onPast
          ? <button type="button" className="rw-cnav-b" aria-label="Earlier cycles" onClick={p.onPast}>‹</button>
          : <span className="rw-cnav-gap" />}
        <div className="rw-cnav-t">
          <b>{day(p.start)} – {day(p.end, true)}</b>
          <span>{inCycle ? `day ${todayIdx + 1} of ${n} · ` : 'ended · '}{p.payName} {day(p.payDate)}</span>
        </div>
        <button type="button" className="rw-cnav-b" aria-label="Next cycles (Forecast)" onClick={p.onForecast}>›</button>
      </div>}

      {/* ── hero E ── */}
      <div className="rw-hero-card">
        <div className={`rw-hero-v ${level}`}>{money(heroValue)}</div>
        <div className="rw-hero-k">{heroWords} · {day(p.payDate)}</div>
        {p.cardLine && p.cardLine.cents > 0 && (
          <div className="rw-hero-card-line">{money(p.cardLine.cents)} extra to {p.cardLine.name} this cycle</div>
        )}
        <div className="rw-hero-sub"><span>Before pay {day(p.payDate)}</span><b>{money(p.closingCents)}</b></div>
      </div>

      {p.catchUp ? (
        <div className="rw-ban warn">
          <span className="rw-ban-i">!</span>
          <span className="rw-ban-tx"><b>{p.catchUp.count === 1 ? '1 cycle wasn\u2019t closed' : `${p.catchUp.count} cycles weren\u2019t closed`}</b>
            <small>{short(p.catchUp.from)} – {short(p.catchUp.to)}</small></span>
          <button type="button" onClick={p.catchUp.onOpen}>Catch up</button>
        </div>
      ) : p.showClose && (
        <div className="rw-ban">
          <span className="rw-ban-i">✓</span>
          <span className="rw-ban-tx"><b>{p.ended ? 'This cycle has ended' : 'Last day of this cycle'}</b>
            <small>{p.payName} due {day(p.payDate)}</small></span>
          <button type="button" onClick={p.onClose}>Close</button>
        </div>
      )}

      {/* ── the runway ── */}
      <div className="rw-runway">
        <RunwayChart runway={runway} todayIdx={todayIdx} ended={p.ended} floorCents={p.floorCents} items={p.items}
          money={money} onDot={jump} />
      </div>

      <div className="rw-seg">
        <button type="button" className={tab === 'day' ? 'on' : ''} onClick={() => setTab('day')}>By day</button>
        <button type="button" className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>By type</button>
      </div>

      {tab === 'type' ? <div className="rw-bytype">{p.byType}</div> : (
        <>
          {needs.length > 0 && (
            <>
              <div className="rw-dl needs">Needs you<b>{needs.length}</b><span>from earlier this cycle</span></div>
              <div className="rw-group">{needs.map(i => row(i, 'needs'))}</div>
            </>
          )}

          {inCycle && (
            <>
              <div className="rw-dl today">Today · {day(today)}<span>leaves {money(balanceAfter(today))}</span></div>
              <div className="rw-group">
                {todays.length ? todays.map(i => row(i, 'today')) : (
                  <div className="rw-row static"><div className="rw-tx"><div className="rw-sub">
                    Nothing due today{nextUp ? <> · next <b className="rw-ink">{nextUp.name}</b> {day(nextUp.date)}</> : null}
                  </div></div></div>
                )}
              </div>
            </>
          )}

          {inCycle && tomorrows.length > 0 && (
            <>
              <div className="rw-dl">Tomorrow · {day(tomorrow)}<span>{tomorrow > p.end ? `${money(p.closingCents)} before pay` : `leaves ${money(balanceAfter(tomorrow))}`}</span></div>
              <div className="rw-group">{tomorrows.map(i => row(i, 'today'))}</div>
            </>
          )}

          {p.budgets.length > 0 && (
            <>
              <div className="rw-dl"><span className="rw-dl-k">Budgets</span>
                <span>{money(budgetSpent)} of {money(budgetPlanned)} · {future ? `${n} days` : daysLeft ? `${daysLeft} day${daysLeft > 1 ? 's' : ''} left` : 'last day'}</span></div>
              <div className="rw-group">
                {shownBudgets.map(b => {
                  const pct = b.plannedCents > 0 ? b.spentCents / b.plannedCents : 0
                  return (
                    <div key={b.id}>
                      <div className="rw-row" role="button" tabIndex={0} onClick={b.onOpen}>
                        <div className="rw-tx">
                          <div className="rw-row-name">{b.name}{b.flag && (
                            <span className={`rw-bdg ${b.flag}`} role="img" aria-label={`Usually ${b.flag} budget`}>{b.flag === 'under' ? '↓' : '↑'}</span>
                          )}</div>
                          <div className="rw-pb" aria-hidden="true">
                            <i className={pct > pace + 0.1 ? 'ahead' : ''} style={{ width: Math.min(100, pct * 100) + '%' }} />
                            <b style={{ left: pace * 100 + '%' }} />
                          </div>
                        </div>
                        <div className="rw-am">{money(b.spentCents)}<small>of {money(b.plannedCents)}</small></div>
                        {b.onPlus && (
                          <button type="button" className={`rw-plus${b.plusOpen ? ' on' : ''}`} aria-label={`Log spend · ${b.name}`}
                            onClick={e => { e.stopPropagation(); b.onPlus!() }}>{b.plusOpen ? '×' : '+'}</button>
                        )}
                      </div>
                      {b.plusOpen && b.quickAdd}
                    </div>
                  )
                })}
                {p.budgets.length > 3 && (
                  <button type="button" className="rw-row" onClick={() => setAllBudgets(a => !a)}>
                    <div className="rw-tx"><div className="rw-sub">{allBudgets ? 'Show fewer' : `${p.budgets.length - 3} more budget${p.budgets.length - 3 > 1 ? 's' : ''}`}</div></div>
                    <span className={`rw-chev${allBudgets ? ' open' : ''}`}>›</span>
                  </button>
                )}
              </div>
            </>
          )}

          {coming.length > 0 && (
            <>
              <div className="rw-dl">Coming up<span>{coming.length} item{coming.length > 1 ? 's' : ''}</span></div>
              <div className="rw-group">{coming.map(i => row(i, 'up'))}</div>
            </>
          )}

          {earlier.length > 0 && (
            <>
              <div className="rw-dl" style={{ paddingTop: 16 }}>Earlier this cycle<span>{earlier.length} item{earlier.length > 1 ? 's' : ''}</span></div>
              <div className="rw-group">
                <button type="button" className="rw-row" onClick={() => setEarlyOpen(o => !o)}>
                  <div className="rw-tx">
                    <div className="rw-row-name">{earlyOpen ? 'Hide' : 'Show'} earlier items</div>
                    <div className="rw-sub">{earlierIn ? `+${money(earlierIn)} in · ` : ''}{money(earlierOut)} out</div>
                  </div>
                  <span className={`rw-chev${earlyOpen ? ' open' : ''}`}>›</span>
                </button>
                {earlyOpen && earlier.map(i => row(i, 'earlier'))}
              </div>
            </>
          )}

          <div className="rw-group" style={{ marginTop: 16 }}>
            <button type="button" className="rw-row" onClick={p.onAddToCycle}>
              <div className="rw-tx">
                <div className="rw-row-name">Add to this cycle</div>
                <div className="rw-sub">A one-off, extra income or BNPL</div>
              </div>
              <span className="rw-chev">›</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/* ── the runway chart: one line, your balance each day ─────────────────
 * Solid up to today, dotted after. Floor dashed. The line is always mint and
 * never changes colour; warnings come only from the dots. */
function RunwayChart({ runway, todayIdx, ended, floorCents, items, money, onDot }: {
  runway: Runway; todayIdx: number; ended: boolean; floorCents: number; items: DayItem[]
  money: (c: number) => string; onDot: (date: string) => void
}) {
  const W = 300, H = 138, X0 = 14, X1 = W - 14, T = 20, B = H - 20
  const n = runway.days.length
  // Points: the start of the cycle, then the end of each day.
  const pts = [runway.openingCents, ...runway.balances]
  const lo = Math.min(...pts, floorCents, 0)
  const hi = Math.max(...pts, floorCents)
  const pad = (hi - lo) * 0.08 || 100
  const mn = lo - pad, mx = hi + pad
  const X = (k: number) => X0 + k * (X1 - X0) / n
  const Y = (c: number) => B - (c - mn) / (mx - mn) * (B - T)
  const solidTo = ended ? n : todayIdx + 1                       // point index of the end of today
  const line = (from: number, to: number) => pts.slice(from, to + 1).map((c, k) => `${X(from + k)},${Y(c)}`).join(' ')
  const below0 = pts.some(c => c < 0)
  // Drag across to read the balance at the end of any day (as on Forecast).
  // A tap on a dot still jumps to its item.
  const svgRef = useRef<SVGSVGElement>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const dayAt = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    const x = (clientX - r.left) / r.width * W
    return Math.max(0, Math.min(n - 1, Math.floor((x - X0) / (X1 - X0) * n)))
  }

  // One dot per day with something on it.
  const byDay = new Map<number, DayItem[]>()
  for (const it of items) {
    const i = runway.days.indexOf(it.date)
    if (i < 0) continue
    byDay.set(i, [...(byDay.get(i) ?? []), it])
  }

  return (
    <>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Your balance each day this cycle" className="rw-rw-svg"
        onPointerMove={e => setScrub(dayAt(e.clientX))} onPointerLeave={() => setScrub(null)} onPointerCancel={() => setScrub(null)}>
        <polygon points={`${line(0, n)} ${X(n)},${B} ${X0},${B}`} fill="var(--rw-line)" opacity=".07" />
        {below0 && <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-under-floor)" strokeWidth="1.2" />}
        <line x1={X0} x2={X1} y1={Y(floorCents)} y2={Y(floorCents)} stroke="var(--rw-under-floor)" strokeDasharray="3 3" />
        <polyline points={line(0, Math.max(0, solidTo))} fill="none" stroke="var(--rw-line)" strokeWidth="2.6" strokeLinejoin="round" />
        {solidTo < n && (
          <polyline points={line(Math.max(0, solidTo), n)} fill="none" stroke="var(--rw-line)" strokeWidth="2.2"
            strokeDasharray="1.5 4.5" strokeLinecap="round" />
        )}
        {todayIdx >= 0 && (
          <>
            <line x1={X(todayIdx + 0.5)} x2={X(todayIdx + 0.5)} y1={T - 6} y2={B} stroke="var(--rw-ink)" opacity=".18" />
            <text x={X(todayIdx + 0.5)} y={T - 8} fontSize="8.5" fontWeight="700" textAnchor="middle" fill="var(--rw-ink)" opacity=".7">today</text>
          </>
        )}
        {[...byDay.entries()].map(([i, its]) => {
          const needs = its.some(x => x.needs)
          const onlyIn = its.every(x => x.isIn)
          const big = its.reduce((s, x) => s + x.amountCents, 0) >= 30000
          const done = ended || i < todayIdx
          const fill = needs ? 'var(--rw-near-floor)' : onlyIn ? 'var(--rw-good)' : done ? 'var(--rw-line)' : 'var(--rw-surface)'
          return (
            <circle key={i} cx={X(i + 1)} cy={Y(runway.balances[i])} r={big ? 5 : 3.6} fill={fill}
              stroke={needs ? 'var(--rw-near-floor)' : 'var(--rw-line)'} strokeWidth="1.6"
              style={{ cursor: 'pointer' }} onClick={() => onDot(runway.days[i])}>
              <title>{its.map(x => x.name).join(', ')}</title>
            </circle>
          )
        })}
        <text x={X(n)} y={Y(pts[n]) - 9} fontSize="10" fontWeight="700" textAnchor="end" fill="var(--rw-ink)">{money(pts[n])}</text>
        {scrub != null && (() => {
          const sx = X(scrub + 1), left = scrub > n / 2
          const label = parseDate(runway.days[scrub]).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric' }).replace(',', '')
          return <g pointerEvents="none">
            <line x1={sx} x2={sx} y1={T} y2={B} stroke="var(--rw-ink)" opacity=".3" />
            <circle cx={sx} cy={Y(runway.balances[scrub])} r="4" fill="var(--rw-surface)" stroke="var(--rw-ink)" strokeWidth="2" />
            <rect x={left ? sx - 92 : sx + 4} y={T - 2} width="88" height="15" rx="4" fill="var(--rw-surface)" opacity=".92" />
            <text x={left ? sx - 7 : sx + 7} y={T + 9} fontSize="10" fontWeight="700" fill="var(--rw-ink)" textAnchor={left ? 'end' : 'start'}>
              {label} · {money(runway.balances[scrub])}</text>
          </g>
        })()}
        {runway.days.map((d, i) => (
          <text key={d} x={X(i + 0.5)} y={B + 13} fontSize="8.5" textAnchor="middle"
            fontWeight={i === todayIdx ? 700 : 500} fill={i === todayIdx ? 'var(--rw-ink)' : 'var(--rw-muted)'}>
            {LETTERS[parseDate(d).getDay()]}
          </text>
        ))}
      </svg>
      <div className="rw-legend">
        <span><i className="ln" />balance each day</span>
        <span><i className="fl" />floor {money(floorCents)}</span>
        <span><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="var(--rw-surface)" stroke="var(--rw-line)" strokeWidth="1.6" /></svg>to come</span>
        <span><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="var(--rw-near-floor)" /></svg>needs you</span>
      </div>
    </>
  )
}
