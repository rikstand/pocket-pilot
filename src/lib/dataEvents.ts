import { useEffect, useRef } from 'react'

/**
 * Something saved data that other screens show. A sheet opened from the tab
 * bar can save while the Cycle screen sits underneath; this tells it to load
 * again, without remounting it (which would lose its scroll and open rows).
 */
const EVENT = 'pp-data-changed'

export function notifyDataChanged() {
  window.dispatchEvent(new Event(EVENT))
}

export function useDataChanged(onChange: () => void) {
  const fn = useRef(onChange)
  useEffect(() => { fn.current = onChange })
  useEffect(() => {
    const h = () => fn.current()
    window.addEventListener(EVENT, h)
    return () => window.removeEventListener(EVENT, h)
  }, [])
}
