import { parseDate } from '../engine/dates'

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
  const level = lowestCents < 0 ? 'under' : lowestCents < floorCents ? 'near' : 'ok'
  return { lowestCents, lowestIdx, level, worse: level !== 'ok' && lowestCents < nowLow }
}

const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })

export default function Preview({ nowCents, newCents, payDates, floorCents, money, ticks = [] }: {
  nowCents: number[]
  newCents: number[]
  payDates: string[]           // the payday each closing balance is "before"
  floorCents: number
  money: (cents: number) => string
  // When the item lands: positions in payday units (1.5 = halfway between
  // the second and third paydays). Drawn as ticks on the axis.
  ticks?: number[]
}) {
  const n = newCents.length
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
    <>
      <div className="rw-card rw-pv">
        <div className="rw-pv-k">
          <span>Left before each payday</span>
          <span className="rw-pv-lg"><i className="gh" />now<i className="nw" />new<i className="fl" />floor</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Left before each payday, now and with this change">
          {below0 && <>
            <rect x={X0} y={Y(0)} width={X1 - X0} height={Math.max(0, B - Y(0))} fill="var(--rw-under-floor)" opacity=".07" />
            <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-under-floor)" strokeWidth="1.2" />
          </>}
          {!below0 && mn < 0 && <line x1={X0} x2={X1} y1={Y(0)} y2={Y(0)} stroke="var(--rw-hairline)" />}
          <line x1={X0} x2={X1} y1={Y(floorCents)} y2={Y(floorCents)} stroke="var(--rw-under-floor)" strokeDasharray="3 3" />
          <polyline points={line(nowCents)} fill="none" stroke="var(--rw-ink)" strokeOpacity=".28" strokeWidth="2" strokeLinejoin="round" />
          <polyline points={line(newCents)} fill="none" stroke="var(--rw-line)" strokeWidth="2.4" strokeLinejoin="round" />
          {newCents.map((c, i) => c < floorCents
            ? <circle key={i} cx={X(i)} cy={Y(c)} r="3.4" fill={c < 0 ? 'var(--rw-under-floor)' : 'var(--rw-near-floor)'} />
            : null)}
          {ticks.filter(f => f >= 0 && f <= n - 1).map((f, k) => (
            <line key={'t' + k} x1={X(f)} x2={X(f)} y1={B + 1} y2={B + 7} stroke="var(--rw-line)" strokeWidth="2.4" strokeLinecap="round" />
          ))}
          {axis.map((i, k) => (
            <text key={k} x={X(i)} y={B + 14} fontSize="8.5" fill="var(--rw-muted)" fontWeight="600"
              textAnchor={k === 0 ? 'start' : k === axis.length - 1 ? 'end' : 'middle'}>{short(payDates[i])}</text>
          ))}
        </svg>
        {ticks.some(f => f >= 0 && f <= n - 1) && <div className="rw-tkl"><i />when it lands</div>}
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
        <div className="rw-tile">
          <div className="k">By {short(payDates[n - 1])}</div>
          <div className="v">{signed(dN)}</div>
          <div className="d">compared with now</div>
        </div>
      </div>

      {st.worse && (st.level === 'under'
        ? <div className="rw-warn-ban under"><span className="i">!</span>
            <span>You’d be <b>{money(-st.lowestCents)} overdrawn</b> before pay {short(payDates[st.lowestIdx])}.</span></div>
        : <div className="rw-warn-ban near">
            <span>Before pay {short(payDates[st.lowestIdx])} dips <b>{money(floorCents - st.lowestCents)}</b> into your floor. You’d still have {money(st.lowestCents)}.</span></div>)}
    </>
  )
}
