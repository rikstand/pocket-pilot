import { useEffect, useMemo, useState } from 'react'
import Sheet from './Sheet'
import { projectFromRows, toEngineExpenses, type ForecastResult } from '../lib/forecast'
import { getCycleActuals } from '../lib/repository'
import { versionForDate } from '../lib/versions'
import { occurrencesOf } from '../engine/index'
import { parseDate, formatDate, addDays } from '../engine/dates'
import { useDataChanged } from '../lib/dataEvents'
import { describeCycle } from './cycleRecord'
import type { BudgetRow } from './CycleView'
import {
  TYPE_ORDER, TYPE_NAME, splitOfProjected, splitOfClosed, averageSplit, outOf,
  movesOf, averageMoves, hasForecast, type TypeKey, type Split,
} from '../lib/insights'

/**
 * Release 7, Journey 7: By type on the Cycle screen. Where each pay goes,
 * how spending compared with the forecast, and this cycle's items by type
 * with section totals. Built only from data the app already has.
 *
 * Chart rule (design system, 25 Nov 2026): every chart in a card is drawn
 * 300 wide and scales with the card, so its text is the same size as every
 * other chart's.
 */

export const TYPE_COLOUR: Record<TypeKey, string> = {
  fixed: 'var(--rw-t-fixed)', budgets: 'var(--rw-t-budgets)', estimates: 'var(--rw-t-est)',
  bnpl: 'var(--rw-bnpl)', savings: 'var(--rw-line)', card: 'var(--rw-credit)',
}
const shift = (d: string, n: number) => formatDate(addDays(parseDate(d), n))
const short = (d: string) => parseDate(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
const HISTORY = 6        // closed cycles looked back on
const AHEAD = 6          // cycles looked forward to on the columns

export interface CommittedRow { key: string; type: TypeKey; name: string; sub: string; cents: number; onOpen?: () => void }
export interface EstimateRow { id: string; name: string; sub: string; cents: number; usual: number | null; onOpen: () => void }

interface Props {
  rows: ForecastResult
  accountId: string
  cycleStart: string
  floorCents: number
  money: (c: number) => string
  committed: CommittedRow[]
  estimates: EstimateRow[]
  budgets: BudgetRow[]
  pace: number                       // how far through the cycle, 0–1
  spare: boolean                     // the card plan takes whatever's spare
}

/** BNPL payments in a cycle, each at its own dated amount (the engine counts them as fixed). */
function bnplIn(rows: ForecastResult, start: string, end: string): number {
  let t = 0
  for (const r of rows.expenseRows) {
    if (!r.lay_by_id) continue
    for (const d of occurrencesOf(toEngineExpenses([r])[0], start, end)) t += versionForDate(r.expense_amount_versions, d)?.amount_cents ?? 0
  }
  return t
}

function useInsights(rows: ForecastResult, accountId: string, cycleStart: string, floorCents: number) {
  const [actuals, setActuals] = useState<any[]>([])
  function load() { getCycleActuals(accountId).then(a => setActuals(a ?? [])).catch(() => setActuals([])) }
  useEffect(load, [accountId])
  useDataChanged(load)

  return useMemo(() => {
    // The year ahead from this cycle: "a pay, on average".
    const proj = projectFromRows(rows, floorCents, 60)
    const k0 = Math.max(0, proj.findIndex(c => c.startDate === cycleStart))
    const yearEnd = shift(cycleStart, 365)
    const ahead = proj.slice(k0).filter(c => c.startDate < yearEnd)
    const aheadSplits = ahead.map(c => splitOfProjected(c, bnplIn(rows, c.startDate, c.endDate)))
    const avg = averageSplit(aheadSplits)

    const closed = (rows.storedCycles ?? []).filter((c: any) => c.is_closed && c.start_date < cycleStart)
    const lastClosed = closed.slice(-HISTORY)
    const cols = [
      ...lastClosed.map((c: any) => ({ start: c.start_date, end: c.end_date, s: splitOfClosed(describeCycle(c, rows, actuals)), when: 'past' as const })),
      ...ahead.slice(0, AHEAD + 1).map((c, i) => ({ start: c.startDate, end: c.endDate, s: aheadSplits[i], when: i === 0 ? 'now' as const : 'next' as const })),
    ]

    const withFc = closed.filter(hasForecast).slice(-HISTORY)
    const per = withFc.map((c: any) => ({ start: c.start_date as string, ...movesOf(c, describeCycle(c, rows, actuals)) }))
    return { avg, cols, moves: per, moveRows: averageMoves(per) }
  }, [rows, actuals, cycleStart, floorCents])
}

/* ── pieces ── */
function PayBar({ s, money }: { s: Split; money: (c: number) => string }) {
  const types = TYPE_ORDER.filter(k => s[k] > 0)
  const tot = outOf(s), mx = Math.max(s.pay, tot, 1) * 1.04
  const X = (v: number) => 4 + v / mx * 292
  let x = 0
  const px = X(s.pay)
  return (
    <svg viewBox="0 0 300 56" className="rw-bt-svg" role="img"
      aria-label={`A pay of ${money(s.pay)}: ${types.map(k => `${TYPE_NAME[k]} ${money(s[k])}`).join(', ')}`}>
      <defs><pattern id="rw-bt-hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="2.5" height="5" fill="var(--rw-under-floor)" opacity=".55" /></pattern></defs>
      {types.map(k => { const r = <rect key={k} x={X(x) + .5} y={10} width={Math.max(0, X(x + s[k]) - X(x) - 1)} height={22} fill={TYPE_COLOUR[k]} />; x += s[k]; return r })}
      {tot > s.pay && <rect x={px} y={10} width={X(tot) - px} height={22} fill="url(#rw-bt-hatch)" />}
      <line x1={px} x2={px} y1={4} y2={38} stroke="var(--rw-ink)" strokeWidth="2" />
      <text x={px} y={52} fontSize="11" fontWeight="700" textAnchor={px > 260 ? 'end' : px < 40 ? 'start' : 'middle'} fill="var(--rw-ink)">pay {money(s.pay)}</text>
    </svg>
  )
}

function KeyGrid({ s, money }: { s: Split; money: (c: number) => string }) {
  return <div className="rw-bt-kg">{TYPE_ORDER.filter(k => s[k] > 0).map(k =>
    <span key={k}><em style={{ background: TYPE_COLOUR[k] }} />{TYPE_NAME[k]}<b>{money(s[k])}</b></span>)}</div>
}

/** One bar per closed cycle: up = spent less than the forecast, down = more. */
function Diverge({ d, labels, money }: { d: number[]; labels: string[]; money: (c: number) => string }) {
  const n = d.length, up = Math.max(0, ...d.map(v => -v)), dn = Math.max(0, ...d.map(v => v))
  const span = 84, top = 14, labBelow = dn > 0 ? 15 : 0, scale = span / Math.max(1, up + dn)
  const mid = top + up * scale, h = mid + dn * scale + labBelow + 18, bw = 288 / n * .6
  const X = (i: number) => 6 + (i + .5) * 288 / n
  return (
    <svg viewBox={`0 0 300 ${h}`} className="rw-bt-svg" role="img"
      aria-label={d.map((v, i) => `${labels[i]}: spent ${money(Math.abs(v))} ${v > 0 ? 'more' : 'less'}`).join(', ')}>
      <line x1={6} x2={294} y1={mid} y2={mid} stroke="var(--rw-ink)" opacity=".3" />
      {d.map((v, i) => {
        const len = Math.max(2, Math.abs(v) * scale), more = v > 0, y = more ? mid : mid - len
        return <g key={i}>
          <rect x={X(i) - bw / 2} y={y} width={bw} height={len} rx="2" fill={more ? 'var(--rw-near-floor)' : 'var(--rw-good)'} />
          <text x={X(i)} y={more ? mid + len + 12 : y - 4} fontSize="11" fontWeight="700" textAnchor="middle"
            fill={more ? 'var(--rw-near-floor-text)' : 'var(--rw-good)'}>{money(Math.abs(v))}</text>
          <text x={X(i)} y={h - 3} fontSize="11" fontWeight="600" textAnchor="middle" fill="var(--rw-muted)">{labels[i]}</text>
        </g>
      })}
    </svg>
  )
}
const DivKey = () => <div className="rw-bt-kg"><span><em style={{ background: 'var(--rw-good)' }} />spent less</span>
  <span><em style={{ background: 'var(--rw-near-floor)' }} />spent more</span></div>

function Squares({ h }: { h: ('o' | 'u')[] }) {
  return <span className="rw-bt-sq" role="img" aria-label={`Last ${h.length} cycles: ${h.filter(x => x === 'o').length} over budget`}>
    {h.map((x, i) => <i key={i} className={x} />)}</span>
}

const leftWords = (left: number, money: (c: number) => string) => left < 0 ? `${money(-left)} over` : `${money(left)} left`

/* ── the page ── */
export default function ByType(p: Props) {
  const { money } = p
  const ins = useInsights(p.rows, p.accountId, p.cycleStart, p.floorCents)
  const [sheet, setSheet] = useState<'pay' | 'acc' | null>(null)
  const left = ins.avg.pay - outOf(ins.avg)
  const n = ins.moves.length, enough = n >= 3
  const d = ins.moves.map(m => m.moved)
  const committedTotal = p.committed.reduce((t, r) => t + r.cents, 0)
  const budgetSpent = p.budgets.reduce((t, b) => t + b.spentCents, 0)
  const budgetPlanned = p.budgets.reduce((t, b) => t + b.plannedCents, 0)

  return <>
    <button type="button" className="rw-bt-card" onClick={() => setSheet('pay')}>
      <div className="rw-bt-t"><span className="rw-pv-k">Where each pay goes</span><span className="rw-chev">›</span></div>
      <div className="rw-bt-big"><b className={left < 0 ? 'w' : ''}>{leftWords(left, money)}</b><span>a pay, on average</span></div>
      <PayBar s={ins.avg} money={money} /><KeyGrid s={ins.avg} money={money} />
    </button>

    {enough ? (
      <button type="button" className="rw-bt-card" onClick={() => setSheet('acc')}>
        <div className="rw-bt-t"><span className="rw-pv-k">Spending vs forecast</span><span className="rw-chev">›</span></div>
        <div className="rw-bt-big"><b className={ins.moveRows.avg > 0 ? 'w' : 'g'}>
          {ins.moveRows.avg > 0 ? `${money(ins.moveRows.avg)} more` : `${money(-ins.moveRows.avg)} less`}</b><span>a cycle, last {n}</span></div>
        <Diverge d={d} labels={ins.moves.map(m => short(m.start))} money={money} /><DivKey />
      </button>
    ) : <div className="rw-bt-empty"><b>Spending vs forecast</b> · after 3 closed cycles · {n} so far</div>}

    {p.committed.length > 0 && <>
      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Committed this cycle</span><span>{money(committedTotal)}</span></div>
      <div className="rw-group">
        {p.committed.map(r => {
          const body = <>
            <span className="rw-bt-dot" style={{ background: TYPE_COLOUR[r.type] }} aria-hidden="true" />
            <div className="rw-tx"><div className="rw-row-name">{r.name}</div><div className="rw-sub">{r.sub}</div></div>
            <div className="rw-am">{money(r.cents)}</div>{r.onOpen && <span className="rw-chev">›</span>}</>
          return r.onOpen
            ? <button key={r.key} type="button" className="rw-row" onClick={r.onOpen}>{body}</button>
            : <div key={r.key} className="rw-row static">{body}</div>
        })}
      </div>
    </>}

    {p.estimates.length > 0 && <>
      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Estimates</span>
        <span>~{money(p.estimates.reduce((t, e) => t + e.cents, 0))}</span></div>
      <div className="rw-group">
        {p.estimates.map(e => {
          const off = e.usual != null && Math.abs(e.usual - e.cents) >= 1000
          return (
            <button key={e.id} type="button" className="rw-row" onClick={e.onOpen}>
              <span className="rw-bt-dot" style={{ background: TYPE_COLOUR.estimates }} aria-hidden="true" />
              <div className="rw-tx"><div className="rw-row-name">{e.name}</div>
                <div className="rw-sub">{e.sub}{off ? <> · <span className="rw-warn">usually {money(e.usual!)}</span></> : null}</div></div>
              <div className="rw-am">~{money(e.cents)}</div><span className="rw-chev">›</span>
            </button>
          )
        })}
      </div>
    </>}

    {p.budgets.length > 0 && <>
      <div role="heading" aria-level={2} className="rw-dl"><span className="rw-dl-k">Budgets</span>
        <span>{money(budgetSpent)} of {money(budgetPlanned)}</span></div>
      <div className="rw-group rw-bt-budg">
        {p.budgets.map(b => {
          const pct = b.plannedCents > 0 ? b.spentCents / b.plannedCents : 0
          return (
            <button key={b.id} type="button" className="rw-row rw-bt-bud" onClick={b.onOpen}>
              <div className="rw-tx">
                <div className="rw-row-name rw-bt-sp"><span>{b.name}</span>{b.history && b.history.length >= 3 && <Squares h={b.history} />}</div>
                <div className="rw-pb" aria-hidden="true">
                  <i className={pct > p.pace + 0.1 ? 'ahead' : ''} style={{ width: Math.min(100, pct * 100) + '%' }} />
                  <b style={{ left: p.pace * 100 + '%' }} />
                </div>
              </div>
              <div className="rw-am">{money(b.spentCents)}<small>of {money(b.plannedCents)}</small></div>
            </button>
          )
        })}
      </div>
    </>}

    {sheet === 'pay' && <PaySheet cols={ins.cols} avg={ins.avg} spare={p.spare} money={money} onClose={() => setSheet(null)} />}
    {sheet === 'acc' && <AccSheet ins={ins} money={money} budgets={p.budgets} estimates={p.estimates} onClose={() => setSheet(null)} />}
  </>
}

/* ── Where each pay goes: one column per pay, past and ahead ── */
function PaySheet({ cols, avg, spare, money, onClose }: {
  cols: { start: string; end: string; s: Split; when: 'past' | 'now' | 'next' }[]; avg: Split; spare: boolean
  money: (c: number) => string; onClose: () => void
}) {
  const nowIdx = Math.max(0, cols.findIndex(c => c.when === 'now'))
  const [col, setCol] = useState(nowIdx)
  const n = cols.length, H = 144
  const mx = Math.max(...cols.map(c => Math.max(outOf(c.s), c.s.pay)), 1) * 1.15
  const X = (i: number) => 8 + (i + .5) * 284 / Math.max(n, 7), Y = (v: number) => H - 16 - v / mx * (H - 28)
  const bw = Math.min(14, 284 / Math.max(n, 7) * .6)
  const sel = cols[col], selLeft = sel ? sel.s.pay - outOf(sel.s) : 0
  const types = TYPE_ORDER.filter(k => avg[k] > 0 || cols.some(c => c.s[k] > 0))
  return (
    <Sheet onClose={onClose}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div><h2 className="rw-sheet-title">Where each pay goes</h2>
        <div className="rw-sd">Past cycles, this one and the next {AHEAD}</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="rw-card">
        <svg viewBox={`0 0 300 ${H}`} className="rw-bt-svg" role="img" aria-label="Each pay, by type">
          {cols.map((c, i) => {
            let base = 0
            return <g key={c.start} onClick={() => setCol(i)} style={{ cursor: 'pointer' }}>
              {TYPE_ORDER.map(k => { const v = c.s[k]; if (v <= 0) return null
                const r = <rect key={k} x={X(i) - bw / 2} y={Y(base + v)} width={bw} height={Y(base) - Y(base + v)} fill={TYPE_COLOUR[k]} opacity={c.when === 'next' ? .55 : 1} />
                base += v; return r })}
              {i === col && <rect x={X(i) - bw / 2 - 2} y={Y(base) - 2} width={bw + 4} height={Y(0) - Y(base) + 2} fill="none" stroke="var(--rw-ink)" strokeWidth="1.5" rx="2" />}
              {(i === nowIdx || (i - nowIdx) % 3 === 0 || i === n - 1) && <text x={X(i)} y={H - 3} fontSize="11" textAnchor="middle"
                fontWeight={i === nowIdx ? 700 : 600} fill={i === nowIdx ? 'var(--rw-ink)' : 'var(--rw-muted)'}>{i === nowIdx ? 'now' : short(c.start)}</text>}
              <rect x={X(i) - 284 / Math.max(n, 7) / 2} y={0} width={284 / Math.max(n, 7)} height={H} fill="transparent" />
            </g>
          })}
          {/* Each pay's own amount: a mark across its column, since pay can differ from pay to pay. */}
          {cols.map((c, i) => <line key={'p' + c.start} x1={X(i) - bw / 2 - 3} x2={X(i) + bw / 2 + 3} y1={Y(c.s.pay)} y2={Y(c.s.pay)}
            stroke="var(--rw-ink)" strokeWidth="2" pointerEvents="none" />)}
          {sel && <text x={Math.min(260, Math.max(40, X(col)))} y={Math.max(11, Y(Math.max(sel.s.pay, outOf(sel.s))) - 6)} fontSize="11" fontWeight="700"
            textAnchor="middle" fill="var(--rw-ink)" pointerEvents="none">pay {money(sel.s.pay)}</text>}
        </svg>
        {sel && <>
          <div className="rw-bt-cr"><b>{sel.when === 'now' ? 'This cycle' : `${short(sel.start)} – ${short(sel.end)}`}</b>
            <span className={selLeft < 0 ? 'w' : 'g'}>{selLeft < 0 ? `${money(-selLeft)} over pay` : `${money(selLeft)} left`}</span></div>
          <div className="rw-bt-kg">{types.map(k => <span key={k}><em style={{ background: TYPE_COLOUR[k] }} />{TYPE_NAME[k]}<b>{money(sel.s[k])}</b></span>)}</div>
        </>}
      </div>
      <div className="rw-card">
        <div className="rw-pv-k"><span>Share of your pay</span><span>on average</span></div>
        {types.map(k => <div key={k} className="rw-bt-hb"><span>{TYPE_NAME[k]}</span>
          <span className="rw-bt-hbb"><i style={{ width: Math.min(100, avg.pay ? avg[k] / avg.pay * 100 : 0) + '%', background: TYPE_COLOUR[k] }} /></span>
          <b>{avg.pay ? Math.round(avg[k] / avg.pay * 100) : 0}%</b></div>)}
        {(() => { const l = avg.pay - outOf(avg)
          return <div className="rw-bt-hb"><span>{l < 0 ? 'Over pay' : 'Left'}</span>
            <span className="rw-bt-hbb"><i style={{ width: Math.min(100, avg.pay ? Math.abs(l) / avg.pay * 100 : 0) + '%', background: l < 0 ? 'var(--rw-near-floor)' : 'var(--rw-hairline)' }} /></span>
            <b className={l < 0 ? 'w' : ''}>{avg.pay ? Math.round(Math.abs(l) / avg.pay * 100) : 0}%</b></div> })()}
      </div>
      <div className="rw-hint">Averaged over the next year. Past pays show what was logged.{spare ? ' On “whatever’s spare” the card takes what’s left until it’s clear.' : ''}</div>
      <div className="rw-ctas"><button type="button" className="rw-cta" onClick={onClose}>Close</button></div>
    </Sheet>
  )
}

/* ── Spending vs forecast, and what moved it ── */
function AccSheet({ ins, money, budgets, estimates, onClose }: {
  ins: ReturnType<typeof useInsights>; money: (c: number) => string
  budgets: BudgetRow[]; estimates: EstimateRow[]; onClose: () => void
}) {
  const n = ins.moves.length, { avg, rows } = ins.moveRows
  const mx = Math.max(...rows.map(r => Math.abs(r.v)), 1)
  const go = (id: string, kind: string) => kind === 'budget' ? budgets.find(b => b.id === id)?.onOpen
    : kind === 'estimate' ? estimates.find(e => e.id === id)?.onOpen : undefined
  return (
    <Sheet onClose={onClose}>
      <div className="rw-grab" />
      <div className="rw-sh-h"><div><h2 className="rw-sheet-title">Spending vs forecast</h2><div className="rw-sd">Last {n} closed cycles</div></div>
        <button type="button" className="rw-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="rw-card"><Diverge d={ins.moves.map(m => m.moved)} labels={ins.moves.map(m => short(m.start))} money={money} /><DivKey /></div>
      <div className="rw-card rw-bt-mv">
        <div className="rw-pv-k">What moved it, a cycle</div>
        <div className="rw-bt-mvh" aria-hidden="true"><span /><span className="rw-bt-ax"><span>more</span><span>less</span></span><span /></div>
        {rows.map(r => {
          const more = r.v > 0, w = Math.abs(r.v) / mx * 50, open = go(r.id, r.kind)
          const body = <>
            <span className="rw-bt-mvn">{r.name}<small>{r.kind === 'unlogged' ? 'bank vs app' : r.kind}</small></span>
            <span className="rw-bt-dv"><i style={{ [more ? 'right' : 'left']: '50%', width: w + '%', background: more ? 'var(--rw-near-floor)' : 'var(--rw-good)' }} /></span>
            <span className={`rw-bt-mvv ${more ? 'w' : 'g'}`}>{money(Math.abs(r.v))} {more ? 'more' : 'less'}</span></>
          return open ? <button key={r.id} type="button" className="rw-bt-mvr" onClick={() => { onClose(); open() }}>{body}</button>
            : <div key={r.id} className="rw-bt-mvr">{body}</div>
        })}
        <div className="rw-bt-mvr tot"><span className="rw-bt-mvn" style={{ gridColumn: '1 / 3' }}>Average a cycle</span>
          <span className={`rw-bt-mvv ${avg > 0 ? 'w' : 'g'}`}>{money(Math.abs(avg))} {avg > 0 ? 'more' : 'less'}</span></div>
      </div>
      <div className="rw-ctas"><button type="button" className="rw-cta" onClick={onClose}>Close</button></div>
    </Sheet>
  )
}
