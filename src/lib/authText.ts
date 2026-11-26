/* Sign-in words and the remembered email: kept apart from auth.ts so they load without Supabase (tests). */

export const MIN_PASSWORD = 8

/* The welcome screen remembers the last email signed in on this phone (agreed 27 Nov),
 * so a return visit only asks for the password. "Not you?" forgets it. */
const LAST = 'pp.lastEmail'
export function rememberedEmail(): string | null { try { return localStorage.getItem(LAST) } catch { return null } }
export function rememberEmail(email: string) { try { localStorage.setItem(LAST, email.trim()) } catch { /* private mode */ } }
export function forgetEmail() { try { localStorage.removeItem(LAST) } catch { /* private mode */ } }

/** Supabase's sign-in errors, in the app's words. */
export function authMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? '')
  if (/invalid login credentials/i.test(m)) return 'That email and password don’t match.'
  if (/email not confirmed/i.test(m)) return 'Open the link we emailed you first, then sign in.'
  if (/already registered|already been registered/i.test(m)) return 'There’s already an account with that email. Sign in instead.'
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute, then try again.'
  if (/password should be|weak password/i.test(m)) return 'Choose a longer password: at least 8 characters.'
  if (/failed to fetch|network/i.test(m)) return 'Couldn’t reach Pocket Pilot. Check your connection and try again.'
  return m || 'Something went wrong. Try again.'
}
