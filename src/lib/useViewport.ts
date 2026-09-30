import { useEffect, useState } from 'react'

/**
 * Which layout to render. Width alone decides it — 1024px and up is desktop,
 * iPad in landscape included. Most of the difference is CSS; this hook is only
 * for the places where the markup itself changes (the rail instead of the
 * bottom nav, and later the two-column Cycle and Forecast pages).
 */
export const DESKTOP_QUERY = '(min-width: 1024px)'

export type Viewport = 'mobile' | 'desktop'

function current(): Viewport {
  if (typeof window === 'undefined' || !window.matchMedia) return 'mobile'
  return window.matchMedia(DESKTOP_QUERY).matches ? 'desktop' : 'mobile'
}

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(current)

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => setVp(mq.matches ? 'desktop' : 'mobile')
    onChange()
    // addListener is the only form Safari 13 and earlier understand.
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [])

  return vp
}
