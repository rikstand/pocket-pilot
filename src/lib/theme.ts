import { useEffect, useState } from 'react'

/**
 * Light, Dark or Match my phone (agreed for release 8). Kept on this device:
 * index.html reads the same key before the app starts, so a dark phone never
 * flashes white.
 */
export type ThemePref = 'light' | 'dark' | 'auto'
const KEY = 'pp.theme'
const EVENT = 'pp-theme-change'

export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'auto' ? v : 'light' } catch { return 'light' }
}
const phoneIsDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
export const resolveTheme = (p: ThemePref, phoneDark = phoneIsDark()): 'light' | 'dark' => p === 'auto' ? (phoneDark ? 'dark' : 'light') : p

function apply(p: ThemePref) {
  const t = resolveTheme(p)
  document.documentElement.setAttribute('data-theme', t)
  document.body.setAttribute('data-theme', t)
}

export function setTheme(p: ThemePref) {
  try { localStorage.setItem(KEY, p) } catch { /* private mode: it just won't stick */ }
  apply(p)
  window.dispatchEvent(new Event(EVENT))
}

/** The chosen theme and whether the app is dark right now, following the phone on "auto". */
export function useTheme(): { pref: ThemePref; dark: boolean; set: (p: ThemePref) => void } {
  const [pref, setPref] = useState(readTheme)
  const [phoneDark, setPhoneDark] = useState(phoneIsDark)
  useEffect(() => {
    const sync = () => setPref(readTheme())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    const onPhone = () => { setPhoneDark(!!mq?.matches); if (readTheme() === 'auto') apply('auto') }
    mq?.addEventListener('change', onPhone)
    apply(readTheme())
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
      mq?.removeEventListener('change', onPhone)
    }
  }, [])
  return { pref, dark: resolveTheme(pref, phoneDark) === 'dark', set: setTheme }
}
