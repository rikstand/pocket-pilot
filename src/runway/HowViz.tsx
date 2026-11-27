import type { CSSProperties } from 'react'

/* Short animated explainers for How this works (approved 27 Nov, design system › How this works). One 300-wide picture per answer,
 * drawn with the app's own chart parts: the balance line, the dashed floor, type marks.
 * Plays once when the answer opens; "Play again" restarts it. Reduced motion shows the end. */
const d = (s: number, o?: number): CSSProperties => ({ ['--d' as any]: `${s}s`, ...(o != null ? { ['--o' as any]: `${o}s` } : {}) })
const P = (pts: number[][]) => pts.map(p => p.join(',')).join(' ')

export function HowViz({ k }: { k: string }) {
  if (k === 'cycle') {
    const n = 14, w = 240 / n
    return <svg className="rw-hv" viewBox="0 0 300 112" role="img" aria-label="A cycle fills day by day from one payday to the day before the next">
      <line x1="24" x2="24" y1="26" y2="72" className="rw-hv-tick" /><line x1="276" x2="276" y1="26" y2="72" className="rw-hv-tick" />
      <text x="24" y="18" textAnchor="start">payday</text><text x="276" y="18" textAnchor="end">next payday</text>
      {Array.from({ length: n }, (_, i) => <g key={i}>
        <rect x={30 + i * w} y="42" width={w - 3} height="14" rx="2.5" className="rw-hv-slot" />
        <rect x={30 + i * w} y="42" width={w - 3} height="14" rx="2.5" className="rw-hv-day rw-hv-in" style={d(0.2 + i * 0.12)} />
      </g>)}
      <g className="rw-hv-in" style={d(2.1)}>
        <path d="M30 80 V86 H267 V80" className="rw-hv-brk" /><text x="148" y="102" textAnchor="middle" className="rw-hv-b">one cycle</text>
      </g>
    </svg>
  }
  if (k === 'left') {
    const pts = [[24, 40], [44, 30], [64, 34], [84, 50], [104, 48], [124, 56], [144, 60], [164, 58], [184, 66], [204, 64], [224, 72], [244, 70], [264, 74]]
    return <svg className="rw-hv" viewBox="0 0 300 112" role="img" aria-label="The balance line falls across the cycle and ends at what's left before the next payday">
      <line x1="16" x2="284" y1="92" y2="92" className="rw-hv-floor" /><text x="16" y="106">floor</text>
      <line x1="276" x2="276" y1="20" y2="92" className="rw-hv-tick rw-hv-dash" /><text x="282" y="14" textAnchor="end">next payday</text>
      <polyline points={P(pts)} pathLength={100} className="rw-hv-line rw-hv-draw" style={d(0.1)} />
      <circle cx="264" cy="74" r="5.5" className="rw-hv-dot rw-hv-pop" style={d(1.5)} />
      <text x="254" y="60" textAnchor="end" className="rw-hv-b rw-hv-in" style={d(1.8)}>left before pay</text>
    </svg>
  }
  if (k === 'floor') {
    const pts = [[30, 44], [80, 58], [130, 78], [180, 50], [230, 104], [272, 58]]
    const cls = ['ok', 'ok', 'near', 'ok', 'under', 'ok']
    return <svg className="rw-hv" viewBox="0 0 300 120" role="img" aria-label="Paydays above the floor are fine, one under the floor turns amber, one under zero turns red">
      <line x1="16" x2="284" y1="70" y2="70" className="rw-hv-floor" /><text x="16" y="64">floor</text>
      <line x1="16" x2="284" y1="96" y2="96" className="rw-hv-zero" /><text x="284" y="92" textAnchor="end">$0</text>
      <polyline points={P(pts)} pathLength={100} className="rw-hv-line rw-hv-thin rw-hv-draw" style={d(0.1)} />
      {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="5" className={`rw-hv-pd ${cls[i]} rw-hv-pop`} style={d(1.1 + i * 0.25)} />)}
      <text x="140" y="88" className="rw-hv-b rw-hv-near rw-hv-in" style={d(1.8)}>under the floor</text>
      <text x="220" y="112" textAnchor="end" className="rw-hv-b rw-hv-under rw-hv-in" style={d(2.3)}>under $0</text>
    </svg>
  }
  if (k === 'spare') {
    const pts = [[24, 34], [64, 40], [104, 38], [144, 48], [184, 46], [224, 54], [250, 56]]
    return <svg className="rw-hv" viewBox="0 0 300 120" role="img" aria-label="Spare is the gap between what's left before pay and the floor. On whatever's spare, it goes to the card">
      <line x1="16" x2="284" y1="92" y2="92" className="rw-hv-floor" /><text x="16" y="106">floor</text>
      <polyline points={P(pts)} pathLength={100} className="rw-hv-line rw-hv-draw" style={d(0.1)} />
      <g>
        <rect x="244" y="56" width="12" height="36" rx="3" className="rw-hv-gap rw-hv-grow rw-hv-out" style={d(1.3, 3.2)} />
        <text x="236" y="78" textAnchor="end" className="rw-hv-b rw-hv-in rw-hv-out" style={d(1.6, 3.2)}>spare</text>
      </g>
      <polyline points="250,56 262,92" pathLength={100} className="rw-hv-line rw-hv-draw" style={d(3.2)} />
      <g className="rw-hv-slide" style={d(3.2)}><circle cx="250" cy="56" r="5.5" className="rw-hv-dot rw-hv-pop" style={d(1.1)} /></g>
      <g className="rw-hv-in" style={d(3.2)}>
        <rect x="270" y="62" width="12" height="12" rx="3" className="rw-hv-card" /><text x="276" y="56" textAnchor="middle">card</text>
        <text x="16" y="120" className="rw-hv-b">Whatever’s spare: it goes to the card</text>
      </g>
    </svg>
  }
  if (k === 'fits') {
    const pts = [[24, 48], [64, 56], [104, 52], [144, 64], [184, 60], [224, 70], [264, 58]]
    return <svg className="rw-hv" viewBox="0 0 300 120" role="img" aria-label="As the payment grows, every payday ahead moves down until the lowest one meets the floor. That amount is Fits">
      <text x="24" y="12">pay this cycle</text>
      <rect x="24" y="20" width="252" height="6" rx="3" className="rw-hv-track" />
      <rect x="24" y="20" width="150" height="6" rx="3" className="rw-hv-fill rw-hv-widen" style={d(0.4)} />
      <g className="rw-hv-thumb" style={d(0.4)}><circle cx="24" cy="23" r="7" className="rw-hv-knob" /></g>
      <text x="174" y="12" textAnchor="middle" className="rw-hv-b rw-hv-in" style={d(2.5)}>Fits</text>
      <line x1="16" x2="284" y1="92" y2="92" className="rw-hv-floor" /><text x="16" y="106">floor</text>
      <g className="rw-hv-lower" style={d(0.4)}>
        <polyline points={P(pts)} className="rw-hv-line rw-hv-thin" />
        {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" className={`rw-hv-pd ${i === 5 ? 'low' : 'ok'}`} />)}
      </g>
      <text x="272" y="118" textAnchor="end" className="rw-hv-b rw-hv-in" style={d(2.5)}>lowest payday meets the floor</text>
    </svg>
  }
  if (k === 'types') {
    return <svg className="rw-hv" viewBox="0 0 300 112" role="img" aria-label="Fixed amounts are the same each time. An estimate becomes the real figure when you confirm it. A budget fills as you log spending">
      <circle cx="20" cy="22" r="4.5" className="rw-hv-mk" /><text x="32" y="26">Fixed</text>
      {[0, 1, 2].map(i => <rect key={i} x={96 + i * 58} y="16" width="50" height="12" rx="3" className="rw-hv-fx rw-hv-in" style={d(0.2 + i * 0.3)} />)}
      <circle cx="20" cy="56" r="4" className="rw-hv-mk ring" /><text x="32" y="60">Estimate</text>
      <rect x="96" y="50" width="120" height="12" rx="3" className="rw-hv-est" />
      <rect x="96" y="50" width="130" height="12" rx="3" className="rw-hv-fx rw-hv-in" style={d(1.6)} />
      <text x="232" y="60" className="rw-hv-b rw-hv-in" style={d(1.8)}>confirmed</text>
      <rect x="15" y="86" width="10" height="6" rx="3" className="rw-hv-mk pill" /><text x="32" y="93">Budget</text>
      <rect x="96" y="84" width="180" height="12" rx="3" className="rw-hv-track" />
      <rect x="96" y="84" width="134" height="12" rx="3" className="rw-hv-fx rw-hv-steps" style={d(2.2)} />
      <line x1="246" x2="246" y1="80" y2="100" className="rw-hv-tick" />
      <text x="246" y="112" textAnchor="middle">budget</text>
    </svg>
  }
  // close
  const a = [[24, 40], [54, 48], [84, 46], [114, 56], [148, 62]], b = [[162, 72], [172, 32], [202, 38], [232, 46], [262, 44], [280, 52]]
  return <svg className="rw-hv" viewBox="0 0 300 112" role="img" aria-label="At the end of a cycle you enter your real balance; the next cycle starts from it">
    <polyline points={P(a)} pathLength={100} className="rw-hv-line rw-hv-thin rw-hv-draw" style={d(0.1)} />
    <circle cx="148" cy="62" r="5" className="rw-hv-fc rw-hv-pop rw-hv-out" style={d(0.9, 1.9)} />
    <text x="140" y="50" textAnchor="end" className="rw-hv-in rw-hv-out" style={d(1.0, 1.9)}>forecast</text>
    <circle cx="148" cy="72" r="5.5" className="rw-hv-dot2 rw-hv-pop" style={d(1.8)} />
    <text x="140" y="90" textAnchor="end" className="rw-hv-b rw-hv-in" style={d(2.0)}>your real balance</text>
    <line x1="155" x2="155" y1="16" y2="100" className="rw-hv-tick rw-hv-dash rw-hv-in" style={d(2.3)} />
    <text x="155" y="110" textAnchor="middle" className="rw-hv-in" style={d(2.3)}>close</text>
    <polyline points={P(b)} pathLength={100} className="rw-hv-line rw-hv-thin rw-hv-draw rw-hv-next" style={d(2.6)} />
    <text x="284" y="20" textAnchor="end" className="rw-hv-in" style={d(3.2)}>next cycle</text>
  </svg>
}
