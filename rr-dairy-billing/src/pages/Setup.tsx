import { useState } from 'react'
import { useApp } from '../state'
import { CloudSignIn } from '../components/CloudSignIn'
import { fetchSnapshot, hydrateFromSnapshot } from '../lib/cloud'
import { createLocalStore } from '../db/localSetup'
import { db } from '../db'
import { Segmented } from '../components/ui'

/**
 * First launch on a new device. Two ways in:
 *  • Start on this device — no server needed; the shop works fully offline and can be linked to a server later.
 *  • Sign in to a server — downloads an existing store from the cloud backend.
 */
export default function Setup() {
  const { finishSetup, login, loginWithToken, toast } = useApp()
  const [mode, setMode] = useState<'local' | 'cloud'>('local')
  const [f, setF] = useState({ storeName: '', ownerName: '', pin: '', demo: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function startLocal(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const owner = await createLocalStore(f)
      const user = (await db.users.get(owner.id))!
      finishSetup()
      login(user, f.pin)
      toast(`Welcome, ${user.name.split(' ')[0]}`, 'ok')
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row gap-6" style={{ marginBottom: 18 }}>
          <div className="brand-mark">RD</div>
          <div>
            <h1 style={{ fontSize: 18 }}>Welcome to RR Dairy</h1>
            <div className="small muted">{mode === 'local' ? 'Set up your shop on this device' : 'Sign in to load your store onto this device'}</div>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Segmented value={mode} options={[{ value: 'local', label: 'Start on this device' }, { value: 'cloud', label: 'Sign in to a server' }]} onChange={setMode} />
        </div>

        {mode === 'local' ? (
          <form onSubmit={startLocal} style={{ display: 'grid', gap: 12 }}>
            <label className="field">Shop name
              <input className="input input-lg" required autoFocus placeholder="e.g. Shree Dairy" value={f.storeName} onChange={(e) => setF({ ...f, storeName: e.target.value })} />
            </label>
            <label className="field">Owner name
              <input className="input input-lg" required value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
            </label>
            <label className="field">4-digit PIN (used to unlock the app)
              <input className="input input-lg num" required inputMode="numeric" type="password" maxLength={4} pattern="\d{4}" autoComplete="new-password" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="checkbox"><input type="checkbox" checked={f.demo} onChange={(e) => setF({ ...f, demo: e.target.checked })} /> Fill with sample dairy data so I can look around</label>
            {error && <div className="small" role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
            <button className="btn btn-primary" style={{ height: 44 }} disabled={busy}>{busy ? 'Setting up…' : 'Start'}</button>
            <div className="tiny muted center">No account or server needed. Data stays in this browser. You can connect a server later in Settings.</div>
          </form>
        ) : (
        <CloudSignIn
          submitLabel="Sign in & load my store"
          onError={() => undefined}
          onSignedIn={async (result, apiUrl) => {
            const snapshot = await fetchSnapshot(apiUrl, result.token)
            await hydrateFromSnapshot(apiUrl, snapshot)
            finishSetup()
            loginWithToken(result.user.id, apiUrl, result.store.id, result.token)
            toast(`Welcome, ${result.user.name.split(' ')[0]}`, 'ok')
          }}
        />
        )}

        {mode === 'cloud' && <div className="tiny muted center" style={{ marginTop: 16 }}>
          Billing keeps working offline after this — changes upload automatically when you're back online.
        </div>}
      </div>
    </div>
  )
}
