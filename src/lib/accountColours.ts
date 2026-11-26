import type { Account } from './AccountContext'

/** The six account colours (agreed 27 Nov), in the order the colour row shows them. */
export const ACCOUNT_COLOURS = ['Blue', 'Indigo', 'Rose', 'Olive', 'Sand', 'Slate'] as const
export function colourOf(a: Pick<Account, 'colour'>, i = 0): number {
  return a.colour != null && a.colour >= 0 && a.colour < ACCOUNT_COLOURS.length ? a.colour : i % ACCOUNT_COLOURS.length
}
