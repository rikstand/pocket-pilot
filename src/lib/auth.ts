import { supabase } from './supabase'
import { rememberEmail } from './authText'

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  rememberEmail(email)
  return data
}

/** A new account. The email link brings them back to this app. */
export async function signUpWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
  if (error) throw error
  rememberEmail(email)
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session
}

/** Forgot password: an email link that opens this app on "Set a new password". */
export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
  if (error) throw error
}

/** Sets the signed-in user's password (from the reset link, or Change password). */
export async function setPassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw error
}

/** Change password checks the current one first: signing in again with it
 *  either succeeds (same session, refreshed) or says it's wrong. */
export async function checkPassword(email: string, password: string): Promise<boolean> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (!error) return true
  if (/invalid login credentials/i.test(error.message)) return false
  throw error
}

export { MIN_PASSWORD, rememberedEmail, rememberEmail, forgetEmail, authMessage } from './authText'
