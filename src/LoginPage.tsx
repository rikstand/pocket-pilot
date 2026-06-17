import { useState } from 'react'
import { signInWithEmail, signUpWithEmail } from './lib/auth'

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    setError('')
    setLoading(true)
    try {
      if (isSignUp) {
        await signUpWithEmail(email, password)
        setError('Check your email to confirm your account, then sign in.')
      } else {
        await signInWithEmail(email, password)
        onLogin()
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '100px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ marginBottom: 24 }}>Pocket Pilot</h1>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={{ display: 'block', width: '100%', marginBottom: 12, padding: 8, fontSize: 16 }}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        style={{ display: 'block', width: '100%', marginBottom: 12, padding: 8, fontSize: 16 }}
      />
      {error && <p style={{ color: 'red', marginBottom: 12 }}>{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={loading}
        style={{ width: '100%', padding: 10, fontSize: 16, marginBottom: 12 }}
      >
        {loading ? 'Please wait…' : isSignUp ? 'Sign up' : 'Sign in'}
      </button>
      <button
        onClick={() => setIsSignUp(!isSignUp)}
        style={{ background: 'none', border: 'none', color: 'blue', cursor: 'pointer' }}
      >
        {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
      </button>
    </div>
  )
}