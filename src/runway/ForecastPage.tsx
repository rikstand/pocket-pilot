import { useRef, useState } from 'react'
import Sheet, { reportError } from './Sheet'
import { parseDate, formatDate, addMonths } from '../engine/dates'
import { useToast } from './toastContext'
import { Segmented } from './controls'
import { KeyUnder, KeyDone } from './LegendKeys'
import { underFloor, overdrawn } from '../engine/floor'

/**
 * Journey 6: the Forecast tab in the new look. One point per payday: what's
 * left in the account just before that pay lands, after the cycle's items,
 * budgets, card and savings. The range is real months counted along the pay
 * schedule, so weekly, fortnightly and monthly pay all read the same way.
 *
 * A payday under the floor gets a marker. Its label is the cost behind it,
 * worked out: the biggest cost in that cycle that doesn't come every cycle,
 * else the biggest cost that isn't a budget. "Let it dip" is kept per
 * expense per cycle (accepted_dips), so a dip caused by the card can't be.
 */

export interface ForecastPoint {
  idx: number                 // the cycle's index on the Dashboard, to open it
  start: string
  end: string
  payDate: string             // the payday this balance is "before"
  closeCents: number
  driver: { name: string; expenseId: string | null; cents: number; date: string; irregular: boolean } | null
  accepted: boolean           // a dip you said yes to in this cycle
}

interface Props {
  points: ForecastPoint[]     // every projected cycle, oldest first
  floorCents: number
  today: string
  payWord: string             // 'weekly', 'fortnightly', 'monthly' or ''
  card: { name: string; paidOffIdx: number | null } | null   // index into points
  money: (cents: number) => string
  onOpen: (idx: number) => void
  onLetDip: (expenseId: string, cycleStart: string) => Promise<void>
  onUndoDip: (expenseId: string, cycleStart: string) => Promise<void>
}

const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const day = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
const monthYear = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' })
const monShort = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'short' })
const monYr = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })

type Level = 'ok' | 'near' | 'under' | 'chosen'

export default function ForecastPage(p: Props) {
  const toast = useToast()
  const [months, setMonths] = useState<3 | 6 | 12>(6)
  const [sheet, setSheet] = useState<{ kind: 'how' } | { kind: 'dip'; k: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const { money } = p

  const limit = formatDate(addMonths(parseDate(p.today), months))
  const shown = p.points.filter(x => x.payDate <= limit)
  const pts = shown.length ? shown : p.points.slice(0, 1)
  const n = pts.length
  const vals = pts.map(x => x.closeCents)
  const level = (x: ForecastPoint): Level =>
    underFloor(x.closeCents, p.floorCents) && x.accepted ? 'chosen' : overdrawn(x.closeCents) ? 'under' : underFloor(x.closeCents, p.floorCents) ? 'near' : 'ok'
  const lowIdx = vals.indexOf(Math.min(...vals))
  const low = pts[lowIdx]
  const last = pts[n - 1]
  const nextOutside = p.points.findIndex((x, i) => i >= n && x.closeCents < p.floorCents && !x.accepted)
  const paidOff = p.card?.paidOffIdx ?? null

  // Back above the floor: the first payday after k that is.
  const backAbove = (k: number) => p.points.find((x, i) => i > k && x.closeCents >= p.floorCents) ?? null

  async function letDip(k: number) {
    const x = p.points[k]
    if (!x.driver?.expenseId || busy) return
    setBusy(true)
    try {
      await p.onLetDip(x.driver.expenseId, x.start)
      setSheet(null)
      toast(`${short(x.payDate)}: your choice. It stays marked, without the warning.`, {
        undo: () => p.onUndoDip(x.driver!.expenseId!, x.start),
      })
    } catch (e: any) { reportError('That didn’t save.', e) }
    finally { setBusy(false) }
  }
  async function undoDip(k: number) {
    const x = p.points[k]
    if (!x.driver?.expenseId || busy) return
    setBusy(true)
    try { await p.onUndoDip(x.driver.expenseId, x.start); setSheet(null) }
    catch (e: any) { reportError('That wasn’t undone.', e) }
    finally { setBusy(false) }
  }

  // The list, grouped by the month of each payday.
  const groups: { label: string; rows: ForecastPoint[] }[] = []
  for (const x of pts) {
    const label = monthYear(x.payDate)
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, rows: [] })
    groups[groups.length - 1].rows.push(x)
  }

  return (
    <div className="rw-page">
      <div className="rw-page-head">
        <h1 className="rw-page-title">Forecast</h1>
        <div className="rw-sd">What's left in your account just before each {p.payWord ? `${p.payWord} ` : ''}pay</div>
      </div>
      <div style={{ margin: '10px 12px 0' }}>
        <Segmented value={String(months)} onChange={v => setMonths(Number(v) as 3 | 6 | 12)}
          options={[{ value: '3', label: '3 months' }, { value: '6', label: '6 months' }, { value: '12', label: '12 months' }]} />
      </div>

      <div className="rw-fc-chart">
        <div className="rw-fc-ct"><span>Before each payday</span>
          <span className="rw-fc-ct-r">
            {nextOutside >= 0 && (
              <button type="button" className="rw-fc-edge" onClick={() => setSheet({ kind: 'dip', k: nextOutside })}>! {short(p.points[nextOutside].payDate)} ›</button>
            )}
            <button type="button" className="rw-qm" aria-label="How to read this" onClick={() => setSheet({ kind: 'how' })}>?</button>
          </span></div>
        <Chart pts={pts} floorCents={p.floorCents} level={level} paidOff={paidOff != null && paidOff < n ? paidOff : null}
          money={money} onOpen={k => p.onOpen(pts[k].idx)} onMarker={k => setSheet({ kind: 'dip', k })} />
        <div className="rw-legend">
          <span><i className="ln" />left before pay</span>
          <span><i className="fl" />floor {money(p.floorCents)}</span>
          <span><KeyUnder />under floor</span>
          {p.card && <span><KeyDone />card paid off</span>}
        </div>
      </div>

      <div className={`rw-tiles rw-fc-tiles${p.card ? '' : ' two'}`}>
        <div className="rw-tile"><div className="k">Lowest</div>
          <div className={`v ${lvlClass(level(low))}`}>{money(low.closeCents)}</div><div className="d">before pay {short(low.payDate)}</div></div>
        <div className="rw-tile"><div className="k">In {months} months</div>
          <div className={`v ${lvlClass(level(last))}`}>{money(last.closeCents)}</div><div className="d">before pay {short(last.payDate)}</div></div>
        {p.card && (
          <div className="rw-tile"><div className="k">Card paid off</div>
            <div className="v">{paidOff == null ? 'Later' : monYr(p.points[paidOff].payDate)}</div>
            <div className="d">{paidOff == null ? 'past what’s forecast' : paidOff < n ? '✓ on the chart' : 'past this view'}</div></div>
        )}
      </div>

      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Left before each payday</span><span>tap to open</span></div>
      {groups.map(g => (
        <div key={g.label}>
          <div role="heading" aria-level={2} className="rw-fc-mh">{g.label}</div>
          <div className="rw-group">
            {g.rows.map(x => {
              const lv = level(x)
              return (
                <button key={x.start} type="button" className="rw-row" onClick={() => p.onOpen(x.idx)}>
                  <div className="rw-tx"><div className="rw-row-name">{day(x.payDate)}
                    {lv !== 'ok' && <span className={`rw-fc-pill ${lv}`}>{lv === 'chosen' ? 'your choice' : `${lv === 'under' ? 'Overdrawn' : 'Under floor'}${x.driver?.name ? ' · ' + x.driver.name : ''}`}</span>}
                  </div></div>
                  <div className={`rw-am ${lvlClass(lv)}`}>{money(x.closeCents)}</div>
                  <span className="rw-chev">›</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div style={{ height: 16 }} />

      {sheet && (
        <Sheet onClose={() => setSheet(null)} busy={busy}>
            <div className="rw-grab" />
            {sheet.kind === 'how' ? <>
              <div className="rw-sh-h"><h2 className="rw-sheet-title">How to read this</h2>
                <button type="button" className="rw-x" aria-label="Close" onClick={() => setSheet(null)}>×</button></div>
              <div className="rw-fc-how">
                <p>Each point is <b>what's left in your account just before your pay lands</b>, after that cycle's items, budgets, card and savings come out.</p>
                <p>Your pay then lifts it again, so the <b>lowest</b> point is the one to watch.</p>
                <p>The dashed line is your floor: the amount you want to keep for surprises. A <b>!</b> marks a payday under it.</p>
              </div>
            </> : (() => {
              const x = p.points[sheet.k]
              const d = x.driver
              const back = backAbove(sheet.k)
              const by = p.floorCents - x.closeCents
              return <>
                <div className="rw-sh-h"><div>
                  <h2 className="rw-sheet-title">{d ? d.name : `Before pay ${short(x.payDate)}`}</h2>
                  {d && <div className="rw-sd">{money(d.cents)} on {short(d.date)}{d.irregular ? ' · not every cycle' : ''} · biggest cost in this cycle</div>}
                </div>
                  <button type="button" className="rw-x" aria-label="Close" onClick={() => setSheet(null)}>×</button></div>
                {x.accepted ? (
                  <div className="rw-note">
                    <b>Your choice.</b> {money(x.closeCents)} left before pay on {short(x.payDate)}, using {money(by)} of your floor.
                    {back ? <> Back above it before pay on <b>{short(back.payDate)}</b>.</> : null}
                  </div>
                ) : (
                  <div className={`rw-warn-ban ${x.closeCents < 0 ? 'under' : 'near'}`}>
                    <span><b>{money(by)} under your floor</b> before pay on {short(x.payDate)} ({money(x.closeCents)} left).
                      {back ? <> Back above it before pay on {short(back.payDate)}.</> : null}</span>
                  </div>
                )}
                <div className="rw-ctas">
                  {x.accepted
                    ? <button type="button" className="rw-cta sec" disabled={busy} onClick={() => undoDip(sheet.k)}>Undo</button>
                    : d?.expenseId
                      ? <button type="button" className="rw-cta sec" disabled={busy} onClick={() => letDip(sheet.k)}>Let it dip</button>
                      : null}
                  <button type="button" className="rw-cta" onClick={() => { setSheet(null); p.onOpen(x.idx) }}>Open this cycle</button>
                </div>
                {!x.accepted && <div className="rw-hint">In the cycle you can change an amount for that cycle only.</div>}
              </>
            })()}
        </Sheet>
      )}
    </div>
  )
}

const lvlClass = (l: Level) => l === 'ok' ? '' : l === 'chosen' ? 'chosen' : l

/* ── the chart: one point per payday ─────────────────────────────── */
function Chart({ pts, floorCents, level, paidOff, money, onOpen, onMarker }: {
  pts: ForecastPoint[]; floorCents: number; level: (x: ForecastPoint) => Level; paidOff: number | null
  money: (c: number) => string; onOpen: (k: number) => void; onMarker: (k: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const W = 340, H = 180, X0 = 18, X1 = W - 18, T = 34, B = H - 22
  const n = pts.length
  const v = pts.map(x => x.closeCents)
  const lo = Math.min(floorCents, ...v), hi = Math.max(floorCents, ...v)
  const pad = Math.max((hi - lo) * 0.12, 5000)
  const mn = lo - pad, mx = hi + pad
  const X = (i: number) => n === 1 ? (X0 + X1) / 2 : X0 + i * (X1 - X0) / (n - 1)
  const Y = (c: number) => B - (c - mn) / (mx - mn) * (B - T)
  const line = v.map((c, i) => `${X(i)},${Y(c)}`).join(' ')
  const col = (l: Level) => l === 'under' ? 'var(--rw-under-floor)' : l === 'near' ? 'var(--rw-near-floor)' : l === 'chosen' ? 'var(--rw-muted)' : 'var(--rw-line)'

  // Month labels, thinned when there are many.
  // One label per month where they fit, else every second or third month,
  // evenly. A first month with only a few days left gives way to the next.
  let months: { i: number; t: string }[] = []
  pts.forEach((x, i) => {
    const m = monShort(x.payDate)
    if (!months.length || months[months.length - 1].t !== m) months.push({ i, t: m })
  })
  if (months.length > 1 && X(months[1].i) - X(months[0].i) < 30) months = months.slice(1)
  const gap = months.length > 1 ? (X(months[months.length - 1].i) - X(months[0].i)) / (months.length - 1) : 99
  const step = Math.max(1, Math.ceil(30 / gap))
  const labels = months

  // Under-floor paydays, clustered when their markers would touch.
  const under = pts.map((x, i) => (level(x) !== 'ok' ? i : -1)).filter(i => i >= 0)
  const clusters: number[][] = []
  for (const i of under) {
    const g = clusters[clusters.length - 1]
    if (g && X(i) - X(g[g.length - 1]) < 20) g.push(i); else clusters.push([i])
  }
  const loI = v.indexOf(Math.min(...v))

  function idxAt(clientX: number) {
    const r = svgRef.current!.getBoundingClientRect()
    const x = (clientX - r.left) / r.width * W
    return Math.max(0, Math.min(n - 1, Math.round((x - X0) / (X1 - X0) * (n - 1))))
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="rw-fc-svg" role="img" aria-label="Left before each payday"
      onPointerMove={e => setScrub(idxAt(e.clientX))} onPointerLeave={() => setScrub(null)}
      onClick={e => onOpen(idxAt(e.clientX))}>
      <rect x={X0} y={Y(floorCents)} width={X1 - X0} height={Math.max(0, B - Y(floorCents))} fill="var(--rw-near-floor)" opacity=".06" />
      <line x1={X0} x2={X1} y1={Y(floorCents)} y2={Y(floorCents)} stroke="var(--rw-under-floor)" strokeDasharray="3 3" strokeWidth="1" />
      {mn < 0 && <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-hairline)" strokeWidth="1" />}
      <polygon points={`${line} ${X(n - 1)},${B} ${X0},${B}`} fill="var(--rw-line)" opacity=".08" />
      <polyline points={line} fill="none" stroke="var(--rw-line)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      {n <= 14 && v.map((c, i) => level(pts[i]) === 'ok' && <circle key={i} cx={X(i)} cy={Y(c)} r="2.2" fill="var(--rw-line)" />)}
      {labels.filter((_, j) => j % step === 0).map(l => (
        <text key={l.i} x={X(l.i)} y={B + 15} fontSize="9" textAnchor="middle" fill="var(--rw-muted)" fontWeight="600">{l.t}</text>
      ))}
      {!under.includes(loI) && <>
        <circle cx={X(loI)} cy={Y(v[loI])} r="4" fill="var(--rw-line)" stroke="var(--rw-surface)" strokeWidth="1.5" />
        <text x={X(loI)} y={Y(v[loI]) + 16} fontSize="10" fontWeight="700" textAnchor="middle" fill="var(--rw-ink)">{money(v[loI])}</text>
      </>}
      {clusters.map(g => {
        const k = g.reduce((a, b) => (v[b] < v[a] ? b : a))
        const c = col(level(pts[k]))
        const px = X(k), py = Y(v[k])
        return (
          <g key={k}>
            {g.map(z => <circle key={z} cx={X(z)} cy={Y(v[z])} r="3.5" fill={col(level(pts[z]))} stroke="var(--rw-surface)" strokeWidth="1.5" />)}
            <text x={px} y={py + 16} fontSize="10" fontWeight="700" textAnchor="middle" fill={c}>{money(v[k])}</text>
            <g style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onMarker(k) }}
              role="button" aria-label={`Under your floor before pay ${short(pts[k].payDate)}`}>
              <line x1={px} x2={px} y1={T - 6} y2={py - 5} stroke={c} strokeWidth="1.2" strokeDasharray="2 2" />
              <circle cx={px} cy={T - 13} r="9" fill={c} />
              <text x={px} y={T - 9.5} fontSize={g.length > 1 ? 10 : 11} fontWeight="800" textAnchor="middle" className="rw-mk" fill={c === 'var(--rw-near-floor)' ? '#0e1116' : '#fff'}>{g.length > 1 ? g.length : '!'}</text>
            </g>
          </g>
        )
      })}
      {paidOff != null && (() => {
        const cx = X(paidOff), cy = Y(v[paidOff])
        return <g><circle cx={cx} cy={cy} r="6" fill="var(--rw-line)" stroke="var(--rw-surface)" strokeWidth="2" />
          <path d={`M${cx - 2.6} ${cy}l1.8 1.9 3.4-3.6`} fill="none" stroke="var(--rw-surface)" strokeWidth="1.6" strokeLinecap="round" /></g>
      })()}
      {scrub != null && (() => {
        const sx = X(scrub), left = scrub > n / 2
        return <g pointerEvents="none">
          <line x1={sx} x2={sx} y1={T} y2={B} stroke="var(--rw-ink)" opacity=".3" />
          <circle cx={sx} cy={Y(v[scrub])} r="4" fill="var(--rw-surface)" stroke="var(--rw-ink)" strokeWidth="2" />
          <text x={sx + (left ? -7 : 7)} y={T + 8} fontSize="10" fontWeight="700" fill="var(--rw-ink)" textAnchor={left ? 'end' : 'start'}>
            {short(pts[scrub].payDate)} · {money(v[scrub])}</text>
        </g>
      })()}
    </svg>
  )
}
