// money.ts — one place that knows how to show an amount.
//
// Before this existed, every screen had its own copy of a formatting function
// with the dollar sign written straight into it. The account's currency was
// saved correctly but never read, so a South African Rand account showed
// dollars on every screen.
//
// Anything that displays an amount should use formatMoney() from here.

export interface Currency {
  code: string
  label: string
  symbol: string
  /** Most currencies have 100 minor units; yen and won have none. */
  decimals: number
}

export const CURRENCIES: Currency[] = [
  { code: 'NZD', label: 'New Zealand Dollar', symbol: '$',    decimals: 2 },
  { code: 'AUD', label: 'Australian Dollar',  symbol: '$',    decimals: 2 },
  { code: 'USD', label: 'US Dollar',          symbol: '$',    decimals: 2 },
  { code: 'GBP', label: 'British Pound',      symbol: '£',    decimals: 2 },
  { code: 'EUR', label: 'Euro',               symbol: '€',    decimals: 2 },
  { code: 'CAD', label: 'Canadian Dollar',    symbol: '$',    decimals: 2 },
  { code: 'SGD', label: 'Singapore Dollar',   symbol: '$',    decimals: 2 },
  { code: 'JPY', label: 'Japanese Yen',       symbol: '¥',    decimals: 0 },
  { code: 'ZAR', label: 'South African Rand', symbol: 'R',    decimals: 2 },
  { code: 'AED', label: 'UAE Dirham',         symbol: 'د.إ',  decimals: 2 },
  { code: 'INR', label: 'Indian Rupee',       symbol: '₹',    decimals: 2 },
  { code: 'MXN', label: 'Mexican Peso',       symbol: '$',    decimals: 2 },
  { code: 'BRL', label: 'Brazilian Real',     symbol: 'R$',   decimals: 2 },
  { code: 'CHF', label: 'Swiss Franc',        symbol: 'Fr',   decimals: 2 },
  { code: 'SEK', label: 'Swedish Krona',      symbol: 'kr',   decimals: 2 },
  { code: 'NOK', label: 'Norwegian Krone',    symbol: 'kr',   decimals: 2 },
  { code: 'DKK', label: 'Danish Krone',       symbol: 'kr',   decimals: 2 },
  { code: 'HKD', label: 'Hong Kong Dollar',   symbol: '$',    decimals: 2 },
  { code: 'KRW', label: 'South Korean Won',   symbol: '₩',    decimals: 0 },
  { code: 'CNY', label: 'Chinese Yuan',       symbol: '¥',    decimals: 2 },
]

const FALLBACK = CURRENCIES[0]

/** Look up a currency by code. Unknown or missing codes fall back to NZD. */
export function currencyFor(code?: string | null): Currency {
  if (!code) return FALLBACK
  return CURRENCIES.find(c => c.code === code) ?? FALLBACK
}

/** Just the symbol — for the prefix inside an input box. */
export function currencySymbol(code?: string | null): string {
  return currencyFor(code).symbol
}

/**
 * Format an amount held in minor units (cents) for display.
 *
 * `showMinor` asks for the decimal part. Currencies that have no minor unit
 * ignore it, since "¥1,200.00" is wrong in a way "$1,200.00" is not.
 *
 * Grouping stays en-NZ so the thousands separator is consistent across the
 * app. Switching that per currency would change how numbers are punctuated
 * mid-session, which is more confusing than helpful here.
 */
export function formatMoney(
  cents: number,
  code?: string | null,
  showMinor = true
): string {
  const currency = currencyFor(code)
  const useMinor = showMinor && currency.decimals > 0
  const digits = useMinor ? currency.decimals : 0

  const amount = Math.abs(cents) / Math.pow(10, currency.decimals || 2)
  const str = amount.toLocaleString('en-NZ', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

  // Minus sign, not a hyphen — matches the rest of the app's typography.
  return (cents < 0 ? '−' : '') + currency.symbol + str
}

/**
 * Convenience for building a formatter bound to one account, so screens can
 * keep calling a short local fmt() without threading the code through every
 * call site.
 *
 *   const fmt = moneyFormatter(activeAccount?.currency_code)
 *   fmt(12345)        // "R123.45"
 *   fmt(12345, false) // "R123"
 */
export function moneyFormatter(code?: string | null) {
  return (cents: number, showMinor = true) => formatMoney(cents, code, showMinor)
}
