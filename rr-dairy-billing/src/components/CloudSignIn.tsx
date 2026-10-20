import { useState } from 'react'
import { DEFAULT_API_URL, CloudError, webLogin, type WebLoginResult } from '../lib/cloud'

/**
 * Email + password sign-in against the cloud backend. Shared by first-run setup (downloads the store onto this
 * device) and the lock screen (signing back in on a device that is already linked).
 */
export function CloudSignIn({ initialApiUrl, submitLabel, onSignedIn, onError }: {
  initialApiUrl?: string
  submitLabel: string
  onSignedIn: (result: WebLoginResult, apiUrl: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [apiUrl, setApiUrl] = useState(initialApiUrl || DEFAULT_API_URL)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fixedUrl = !!DEFAULT_API_URL && apiUrl === DEFAULT_API_URL

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const url = apiUrl.trim().replace(/\/$/, '')
      const result = await webLogin(url, email.trim(), password)
      await onSignedIn(result, url)
    } catch (err) {
      const msg = err instanceof CloudError ? err.message : (err as Error).message || 'Sign-in failed'
      setError(msg)
      onError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      {!fixedUrl && (
        <label className="field">Server address
          <input className="input" required placeholder="https://…/api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </label>
      )}
      <label className="field">Email
        <input className="input input-lg" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">Password
        <input className="input input-lg" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
      <button className="btn btn-primary" style={{ height: 44 }} disabled={busy}>{busy ? 'Please wait…' : submitLabel}</button>
    </form>
  )
}
