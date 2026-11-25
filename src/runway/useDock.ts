import { useEffect, useRef, useState, type UIEvent } from 'react'

/**
 * The cycle dates and arrows float at the top of the page while it scrolls
 * (release 7), so another cycle is one tap away from anywhere on the page.
 *
 * Spread the result on the page that scrolls (.rw-page). `stuck` is true once
 * content is passing under the header, which then shows a hairline below it.
 * Opening another cycle (a new key) starts at its top, so its headline and
 * runway are the first thing seen.
 */
export function useDock(key: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  // Setting scrollTop fires a scroll event, which clears `stuck` too.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0
  }, [key])
  function onScroll(e: UIEvent<HTMLDivElement>) {
    const s = e.currentTarget.scrollTop > 2
    if (s !== stuck) setStuck(s)
  }
  return { ref, stuck, onScroll }
}
