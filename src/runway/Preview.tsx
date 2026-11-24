import { useRef, useState } from 'react'
import { parseDate } from '../engine/dates'
import { KeyDone, KeyLands } from './LegendKeys'
import { underFloor, overdrawn } from '../engine/floor'

/**
 * The universal preview: what a change does to each payday. One component
 * for every place a change alters what goes out (budget, card payment, BNPL,
 * savings, a bill, Can I afford it?), so they all read the same way.
 *
 *   faint line = as it is now · mint line = with the change · dashed = floor
 *   dots on paydays under the floor (near-floor) or below $0 (under-floor)
 *   tiles: Lowest · This cycle · By the last payday shown
 *   a warning only when the change makes the lowest payday worse
 */
export interface PreviewStats {
  lowestCents: number
  lowestIdx: number
  level: 'ok' | 'near' | 'under'
  /** The change takes a payday lower than it already was, under the floor. */
  worse: boolean
}

export function previewStats(nowCents: number[], newCents: number[], floorCents: number): PreviewStats {
  const lowestCents = newCents.length ? Math.min(...newCents) : 0
  const lowestIdx = newCents.indexOf(lowestCents)
  const nowLow = nowCents.length ? Math.min(...nowCents) : 0
  const level = overdrawn(lowestCents) ? 'under' : underFloor(lowestCents, floorCents) ? 'near' : 'ok'
  return { lowestCents, lowestIdx, level, worse: level !== 'ok' && lowestCents < nowLow }
}

const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })

export default function Preview({ nowCents, newCents, payDates, floorCents, money, ticks = [], title, done, doneLabel = 'card cleared', third, tilesFirst }: {
  nowCents: number[]
  newCents: number[]
  payDates: string[]           // the payday each closing balance is "before"
  floorCents: number
  money: (cents: number) => string
  // When the item lands: positions in payday units (1.5 = halfway between
  // the second and third paydays). Drawn as ticks on the axis.
  ticks?: number[]
  title?: string
  // Where something finishes (a card cleared): a ringed tick on the new line,
  // a faint ring where it would have finished as things stand. Payday indexes.
  done?: { now: number | null; next: number | null }
  // What the ✓ means: a card cleared, or a savings goal saved.
  doneLabel?: string
  // The third tile, when the change has a better one than "By <date>".
  third?: { k: string; v: string; d: string; cls?: string }
  // Tiles and the warning above the chart: for a sheet whose answer must be
  // in view right under its input (the card payment).
  tilesFirst?: boolean
}) {
  const n = newCents.length
  // Drag across to read any payday, as on the runway and Forecast.
  const svgRef = useRef<SVGSVGElement>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  if (!n) return null
  const st = previewStats(nowCents, newCents, floorCents)
  const all = [...nowCents, ...newCents, floorCents, 0]
  let mx = Math.max(...all), mn = Math.min(...all)
  mx += (mx - mn) * 0.08 || 100
  const W = 300, H = 124, X0 = 8, X1 = W - 8, T = 12, B = H - 20
  const X = (i: number) => X0 + i * (X1 - X0) / Math.max(1, n - 1)
  const Y = (c: number) => B - (c - mn) / (mx - mn) * (B - T)
  const line = (a: number[]) => a.map((c, i) => `${X(i)},${Y(c)}`).join(' ')
  const below0 = newCents.some(c => c < 0)
  const axis = n <= 1 ? [0] : [0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1]
  const d0 = newCents[0] - (nowCents[0] ?? newCents[0])
  const dN = newCents[n - 1] - (nowCents[n - 1] ?? newCents[n - 1])
  const signed = (c: number) => Math.round(c / 100) === 0 ? money(0) : (c > 0 ? '+' : '') + money(c)

  return (
    <div className={tilesFirst ? 'rw-pv-set first' : 'rw-pv-set'}>
      <div className="rw-card rw-pv">
        <div className="rw-pv-k">
          <span>{title ?? 'Left before each payday'}</span>
        </div>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Left before each payday, now and with this change" className="rw-pv-svg"
          onPointerMove={e => {
            const r = svgRef.current!.getBoundingClientRect()
            const x = (e.clientX - r.left) / r.width * W
            setScrub(Math.max(0, Math.min(n - 1, Math.round((x - X0) / (X1 - X0) * Math.max(1, n - 1)))))
          }}
          onPointerLeave={() => setScrub(null)} onPointerCancel={() => setScrub(null)}>
          {below0 && <>
            <rect x={X0} y={Y(0)} width={X1 - X0} height={Math.max(0, B - Y(0))} fill="var(--rw-under-floor)" opacity=".07" />
            <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-under-floor)" strokeWidth="1.2" />
          </>}
          {!below0 && mn < 0 && <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-hairline)" />}
          <line x1={X0} x2={X1} y1={Y(floorCents)} y2={Y(floorCents)} stroke="var(--rw-under-floor)" strokeDasharray="3 3" />
          <polyline points={line(nowCents)} fill="none" stroke="var(--rw-ink)" strokeOpacity=".5" strokeWidth="2" strokeLinejoin="round" />
          <polyline points={line(newCents)} fill="none" stroke="var(--rw-line)" strokeWidth="2.4" strokeLinejoin="round" />
          {newCents.map((c, i) => underFloor(c, floorCents)
            ? <circle key={i} cx={X(i)} cy={Y(c)} r="3.4" fill={c < 0 ? 'var(--rw-under-floor)' : 'var(--rw-near-floor)'} />
            : null)}
          {done?.now != null && done.now !== done.next && done.now < n && (
            <circle cx={X(done.now)} cy={Y(nowCents[done.now])} r="4.5" fill="var(--rw-surface)" stroke="var(--rw-ink)" strokeWidth="1.4" opacity=".45" />
          )}
          {done?.next != null && done.next < n && (() => {
            const cx = X(done.next), cy = Y(newCents[done.next])
            return <g><circle cx={cx} cy={cy} r="6" fill="var(--rw-line)" stroke="var(--rw-surface)" strokeWidth="2" />
              <path d={`M${cx - 2.6} ${cy}l1.8 1.9 3.4-3.6`} fill="none" stroke="var(--rw-surface)" strokeWidth="1.6" strokeLinecap="round" /></g>
          })()}
          {ticks.filter(f => f >= 0 && f <= n - 1).map((f, k) => (
            <line key={'t' + k} x1={X(f)} x2={X(f)} y1={T} y2={B} stroke="var(--rw-ink)" strokeWidth="1.2" strokeDasharray="2 3" opacity=".45" />
          ))}
          {scrub != null && (() => {
            const sx = X(scrub), left = scrub > (n - 1) / 2
            const was = nowCents[scrub]
            const label = `${short(payDates[scrub])} · ${money(newCents[scrub])}${was != null && Math.round((was - newCents[scrub]) / 100) !== 0 ? ` · was ${money(was)}` : ''}`
            const w = label.length * 5.6 + 10
            return <g pointerEvents="none">
              <line x1={sx} x2={sx} y1={T} y2={B} stroke="var(--rw-ink)" opacity=".3" />
              <circle cx={sx} cy={Y(newCents[scrub])} r="4" fill="var(--rw-surface)" stroke="var(--rw-ink)" strokeWidth="2" />
              <rect x={left ? sx - w - 4 : sx + 4} y={T - 2} width={w} height="15" rx="4" fill="var(--rw-surface)" opacity=".94" />
              <text x={left ? sx - 9 : sx + 9} y={T + 9} fontSize="10" fontWeight="700" fill="var(--rw-ink)" textAnchor={left ? 'end' : 'start'}>{label}</text>
            </g>
          })()}
          {axis.map((i, k) => (
            <text key={k} x={X(i)} y={B + 14} fontSize="8.5" fill="var(--rw-muted)" fontWeight="600"
              textAnchor={k === 0 ? 'start' : k === axis.length - 1 ? 'end' : 'middle'}>{short(payDates[i])}</text>
          ))}
        </svg>
        {/* One legend row under the chart, as on Forecast and the card chart. */}
        <div className="rw-legend">
          <span><i className="ln" style={{ borderTopColor: 'var(--rw-ink)', opacity: .5 }} />now</span>
          <span><i className="ln" />new</span>
          <span><i className="fl" />floor</span>
          {ticks.some(f => f >= 0 && f <= n - 1) && <span><KeyLands />when it lands</span>}
          {done?.next != null && <span><KeyDone />{doneLabel}</span>}
        </div>
      </div>

      <div className="rw-tiles">
        <div className={`rw-tile${st.level === 'under' ? ' out' : ''}`}>
          <div className="k">{st.level === 'under' ? 'Overdrawn' : 'Lowest'}</div>
          <div className={`v ${st.level}`}>{money(st.lowestCents)}</div>
          <div className="d">before pay {short(payDates[st.lowestIdx])}</div>
        </div>
        <div className="rw-tile">
          <div className="k">This cycle</div>
          <div className="v">{signed(d0)}</div>
          <div className="d">before pay {short(payDates[0])}</div>
        </div>
        {third ? (
          <div className="rw-tile">
            <div className="k">{third.k}</div>
            <div className="v">{third.v}</div>
            <div className={`d ${third.cls ?? ''}`}>{third.d}</div>
          </div>
        ) : (
          <div className="rw-tile">
            <div className="k">By {short(payDates[n - 1])}</div>
            <div className="v">{signed(dN)}</div>
            <div className="d">compared with now</div>
          </div>
        )}
      </div>

      {st.worse && (st.level === 'under'
        ? <div className="rw-warn-ban under"><span className="i">!</span>
            <span>You’d be <b>{money(-st.lowestCents)} overdrawn</b> before pay {short(payDates[st.lowestIdx])}.</span></div>
        : <div className="rw-warn-ban near">
            <span>Before pay {short(payDates[st.lowestIdx])} dips <b>{money(floorCents - st.lowestCents)}</b> into your floor. You’d still have {money(st.lowestCents)}.</span></div>)}
    </div>
  )
}
