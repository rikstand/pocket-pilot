/**
 * The rules check (Rules register, 27 Nov 2026). Every rule marked "Auto" in the
 * register is tested here, so `npm test` stops a broken rule before `save`.
 * Each test names its rule ID. A known break that is already in the live app sits
 * in KNOWN with the register's finding ID: the test lists it but only fails on new
 * ones, and the list shrinks as findings are fixed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const rel = (p: string) => relative(ROOT, p).split('\\').join('/')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const ALL = walk(SRC).filter(p => /\.(tsx?|css)$/.test(p) && !/\.test\.ts$/.test(p))
const CODE = ALL.filter(p => /\.tsx?$/.test(p))
const NEW_LOOK = CODE.filter(p => rel(p).startsWith('src/runway/'))
const read = (p: string) => readFileSync(p, 'utf8')
const CSS = read(join(SRC, 'runway.css'))

/** Code without its comments, so a rule written in a comment never trips its own check. */
const stripComments = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))   // keep the line count
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
/** What a person can read: string literals and JSX text, comments removed. */
function visibleText(src: string): string[] {
  const s = stripComments(src)
  const out: string[] = []
  for (const m of s.matchAll(/'([^'\n\\]*(?:\\.[^'\n\\]*)*)'|"([^"\n\\]*(?:\\.[^"\n\\]*)*)"|`([^`]*)`/g)) out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '))
  for (const m of s.matchAll(/(?<![=\-])>([^<>{}=]*[A-Za-z][^<>{}=]*)</g)) out.push(m[1])
  return out
}
/** file:line for each match, so a failure points at the spot. */
function where(p: string, re: RegExp): string[] {
  const lines = stripComments(read(p)).split('\n')
  return lines.flatMap((l, i) => (re.test(l) ? [`${rel(p)}:${i + 1}`] : []))
}

/** Known breaks already in the live app, by finding ID (Rules register › Findings). */
const KNOWN: Record<string, string[]> = {
  // F1: Plan › Credit and Forecast charts are drawn 340 wide, so their text renders smaller than other charts.
  T2: ['src/runway/CreditPlan.tsx', 'src/runway/ForecastPage.tsx'],
  // F2: one old-look salary save in Dashboard still writes to the database directly.
  S2: ['src/Dashboard.tsx'],
}
const known = (id: string, file: string) => (KNOWN[id] ?? []).some(k => file.startsWith(k))

describe('Brand', () => {
  it('B2: the logo is the 10 Nov mark, exactly', () => {
    const MARK = '12,58 25,49 38,54 50,38 62,45 71,67 81,60 88,46'
    const w = read(join(SRC, 'runway/Welcome.tsx'))
    expect(w).toContain(`'${MARK}'`)
    // Any other copy of the mark's line must be the same points.
    for (const p of NEW_LOOK) for (const m of read(p).matchAll(/'(12,58 [0-9, ]+)'/g)) expect(`${rel(p)}: ${m[1]}`).toBe(`${rel(p)}: ${MARK}`)
  })
  it('B4: loading waits 0.4 seconds before showing anything', () => {
    const w = read(join(SRC, 'runway/Welcome.tsx'))
    expect((w.match(/setTimeout\([\s\S]{0,60}?,\s*400\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
  it('B5: six account colours, none a warning, brand, card or BNPL colour', () => {
    const acct = [...CSS.matchAll(/--rw-acct-(\d): (#[0-9a-f]{6})/gi)].map(m => m[2].toLowerCase())
    expect(acct).toHaveLength(6)
    const taken = [...CSS.matchAll(/--rw-(?:near-floor|under-floor|line|credit|bnpl): (#[0-9a-f]{6})/gi)].map(m => m[1].toLowerCase())
    for (const c of acct) expect(taken).not.toContain(c)
  })
})

describe('Type and layout', () => {
  it('T1: new-look styles set no fixed pixel font sizes', () => {
    const css = stripComments(CSS)
    const bad = css.split('\n').map((l, i) => [l, i + 1] as const)
      .filter(([l]) => /font(-size)?\s*:[^;]*\b\d+(\.\d+)?px/.test(l))
      // Allowed: the 16px no-zoom minimum, caps that stop a token growing past a size (min(token, Npx)),
      // and the old screens' body size inside the shell.
      .filter(([l]) => !/max\(16px/.test(l) && !/min\(calc\(\d+ \* var\(--rw-u\)\), \d+px\)/.test(l) && !/body\.is-runway/.test(l))
      .map(([, n]) => `src/runway.css:${n}`)
    const inline = NEW_LOOK.flatMap(p => where(p, /style=\{\{[^}]*fontSize/))
    expect([...bad, ...inline]).toEqual([])
  })
  it('T1: chart text always takes the chart size, whatever a chart sets', () => {
    expect(CSS).toMatch(/\.rw svg text:not\(\.rw-mk\) \{ font-size: var\(--rw-chart\); \}/)
  })
  it('T2: charts are drawn 300 wide', () => {
    const bad = NEW_LOOK.flatMap(p => {
      const s = stripComments(read(p))
      const consts = [...s.matchAll(/\bW = (\d+)/g)].map(m => +m[1]).filter(w => w !== 300)
      const lits = [...s.matchAll(/viewBox[=:]\s*[{"'`]+0 0 (\d+) /g)].map(m => +m[1]).filter(w => w >= 150 && w !== 300 && w !== 375)
      return consts.length || lits.length ? [rel(p)] : []
    })
    expect(bad.filter(f => !known('T2', f))).toEqual([])
  })
  it('T3: every field in the new look is 16px or more (no zoom on iPhone)', () => {
    expect(CSS).toMatch(/\.rw :is\(input:not\(\[type=range\]\)[^{]*\{\s*font-size: max\(16px/)
    expect(CSS).not.toMatch(/\.rw :is\(\.rw-page, \.rw-sheet\) :is\(input/)
  })
})

describe('Controls and sheets', () => {
  it('C2: no calendar-only date fields; only the Custom chip opens the phone’s picker', () => {
    const bad = NEW_LOOK.filter(p => !p.endsWith('controls.tsx')).flatMap(p => where(p, /type="date"/))
    expect(bad).toEqual([])
  })
  it('C5: failed saves go through the sheet error line, never a browser alert', () => {
    expect(NEW_LOOK.flatMap(p => where(p, /\balert\(/))).toEqual([])
  })
})

describe('Wording', () => {
  const textOf = (p: string) => visibleText(read(p)).join('\n')
  it('W1: “expense”, never “bill”', () => {
    expect(NEW_LOOK.filter(p => /\bbills?\b/i.test(textOf(p))).map(rel)).toEqual([])
  })
  it('W5: no jargon, and nothing called “annual”', () => {
    expect(NEW_LOOK.filter(p => /\b(smoothing|annual|pts)\b/i.test(textOf(p))).map(rel)).toEqual([])
  })
  it('W6: nothing tied to one person’s pay timing', () => {
    expect(CODE.filter(p => /lands tonight/i.test(textOf(p))).map(rel)).toEqual([])
  })
  it('W7: no real email addresses in the code', () => {
    const bad = ALL.flatMap(p => [...read(p).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)]
      .map(m => m[0]).filter(e => !/@example\.(com|org)$/.test(e)).map(e => `${rel(p)}: ${e}`))
    expect(bad).toEqual([])
  })
})

describe('Numbers and dates', () => {
  it('N4: calendar dates never go through toISOString', () => {
    expect(CODE.flatMap(p => where(p, /toISOString\(\)\s*\.\s*(slice|split|substring)/))).toEqual([])
  })
})

describe('Accessibility', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  it('A2: each account colour passes 4.5:1 behind its white letter', () => {
    for (const m of CSS.matchAll(/--rw-acct-(\d): (#[0-9a-f]{6})/gi)) {
      const ratio = (1 + 0.05) / (lum(m[2]) + 0.05)
      expect(`acct-${m[1]} ${ratio.toFixed(2)}`).toBe(`acct-${m[1]} ${Math.max(ratio, 4.5).toFixed(2)}`)
    }
  })
  it('A4: every new-look animation stops when the phone asks for reduced motion', () => {
    const css = stripComments(CSS)
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')
    const outside = css.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, '')
    const animated = [...outside.matchAll(/([^{}]+)\{[^}]*\banimation\s*:(?!\s*none)[^;}]+/g)]
      .map(m => (m[1].match(/\.(rw-[a-z0-9-]+)/g) ?? []).pop()).filter((c): c is string => !!c)
    const missing = [...new Set(animated)].filter(c => !reduced.includes(c) && !/prefers-reduced-motion[\s\S]{0,400}animation:\s*none\s*!important/.test(css))
    expect(missing).toEqual([])
  })
})

describe('Data and safety', () => {
  it('S2: saves go through lib/repository, not straight to the database from a screen', () => {
    const bad = CODE.filter(p => !rel(p).startsWith('src/lib/'))
      .filter(p => /supabase\s*\.\s*from\([^)]*\)[\s\S]{0,200}?\.(insert|update|delete|upsert)\(/.test(stripComments(read(p))))
      .map(rel)
    expect(bad.filter(f => !known('S2', f))).toEqual([])
  })
  it('KNOWN lists only breaks that still exist', () => {
    // When a finding is fixed, its entry must come out of KNOWN, so the list never goes stale.
    for (const f of KNOWN.T2) {
      const s = stripComments(read(join(ROOT, f)))
      expect(`${f}: ${/\bW = (?!300\b)\d+/.test(s)}`).toBe(`${f}: true`)
    }
    for (const f of KNOWN.S2) expect(`${f}: ${/supabase\s*\.\s*from\(/.test(stripComments(read(join(ROOT, f))))}`).toBe(`${f}: true`)
  })
})
