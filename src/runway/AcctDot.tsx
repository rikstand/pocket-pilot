import { colourOf, type Account } from '../lib/AccountContext'

/** An account's letter on its colour (agreed 27 Nov). `i` is its place in the
 *  full list, for an account saved before colours existed. */
export default function AcctDot({ account, i = 0, name, size }: { account: Pick<Account, 'colour' | 'name'>; i?: number; name?: string; size?: 'sm' | 'lg' }) {
  const n = (name ?? account.name).trim() || '?'
  return <span className={`rw-dot rw-acct rw-acct-${colourOf(account, i)}${size ? ` ${size}` : ''}`} aria-hidden="true">{n.charAt(0).toUpperCase()}</span>
}
