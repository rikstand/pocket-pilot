import { useEffect, useState } from 'react'

/**
 * The new look ("Runway") sits behind a switch until the launch branch makes
 * it the only one. The switch is kept on this device only: the launch branch
 * deletes it, so it never needs to live in the account.
 */
const KEY = 'pp.look'
const EVENT = 'pp-look-change'

function read(): boolean {
  try { return localStorage.getItem(KEY) === 'runway' } catch { return false }
}

export function setNewLook(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, 'runway')
    else localStorage.removeItem(KEY)
  } catch { /* private mode: the switch just won't stick */ }
  window.dispatchEvent(new Event(EVENT))
}

/** Whether the new look is on, kept in step across every component using it. */
export function useNewLook(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read)
  useEffect(() => {
    const sync = () => setOn(read())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return [on, setNewLook]
}
