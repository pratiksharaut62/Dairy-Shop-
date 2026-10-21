import { useState } from 'react'
import { useApp } from '../state'
import type { User } from '../db/types'
import { initialsOf } from '../components/ui'
import { ArrowLeft, Backspace } from '../components/icons'
import { CloudSignIn } from '../components/CloudSignIn'
import { mergeStaffFromCloud, verifyPinOnline } from '../lib/cloud'
import { withSyncPaused } from '../db/syncHooks'
import { db } from '../db'
import { IS_DEMO, DEMO_PINS } from '../lib/demo'
import { resetDemo } from '../db/localSetup'
import { clearPinFailures, hashPin, isLegacyPin, lockedForMs, recordPinFailure, verifyPin, waitText } from '../lib/pin'

const ROLE_NOTE: Record<string, string> = {
  owner: 'Full access — profit, settings, backups',
  manager: 'Floor operations — stock, purchases, reports',
  cashier: 'Billing counter only',
}

/** PIN login: fast enough to switch users between customers at a busy counter. */
export default function Login() {
  const { users, settings, login, loginWithToken, toast } = useApp()
  const [picked, setPicked] = useState<User | null>(null)
  const [pin, setPin] = useState('')
  const [emailMode, setEmailMode] = useState(false)
  const linked = !!settings?.syncApiUrl && !!settings.syncStoreId

  const welcome = (u: User) => toast(`Welcome, ${u.name.split(' ')[0]}`, 'ok')

  const submit = async (value: string) => {
    if (!picked) return
    const wait = lockedForMs(picked.id)
    if (wait > 0) { toast(`Too many wrong PINs — try again in ${waitText(wait)}`, 'err'); setPin(''); return }
    // Staff downloaded from the cloud have no local PIN yet: the first sign-in on this device is checked by the server, then remembered.
    if (!picked.pin && linked) {
      const check = await verifyPinOnline(settings!.syncApiUrl, settings!.syncStoreId, picked.id, value)
      if (check === 'ok') {
        const hashed = await hashPin(value)
        await withSyncPaused(() => db.users.update(picked.id, { pin: hashed }))
        clearPinFailures(picked.id)
        login(picked, value)
        welcome(picked)
        return
      }
      toast(check === 'offline' ? 'First sign-in on this device needs the internet' : check === 'locked' ? 'Too many wrong attempts — try again in 15 minutes' : 'Wrong PIN', 'err')
      setPin('')
      return
    }
    if (await verifyPin(value, picked.pin)) {
      clearPinFailures(picked.id)
      // A PIN saved as plain digits by an older version is upgraded to a hash on its first successful sign-in.
      if (isLegacyPin(picked.pin)) {
        const hashed = await hashPin(value)
        await withSyncPaused(() => db.users.update(picked.id, { pin: hashed }))
      }
      login(picked, value)
      welcome(picked)
    } else {
      recordPinFailure(picked.id)
      const left = lockedForMs(picked.id)
      toast(left > 0 ? `Wrong PIN — locked for ${waitText(left)}` : 'Wrong PIN', 'err')
      setPin('')
    }
  }

  const press = (digit: string) => {
    const next = (pin + digit).slice(0, 4)
    setPin(next)
    if (next.length === 4) setTimeout(() => void submit(next), 120)
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row gap-6" style={{ marginBottom: 18 }}>
          <div className="brand-mark">RD</div>
          <div>
            <h1 style={{ fontSize: 18 }}>{settings?.name ?? 'RR Dairy'}</h1>
            <div className="small muted">Billing & Inventory System</div>
          </div>
        </div>

        {IS_DEMO && !emailMode && (
          <div className="saved-banner" style={{ marginBottom: 12, fontSize: 12.5, alignItems: 'flex-start' }}>
            <div className="grow">
              <b>Live demo.</b> PINs — Owner <b>{DEMO_PINS.owner}</b> · Manager <b>{DEMO_PINS.manager}</b> · Cashier <b>{DEMO_PINS.cashier}</b>
              <div className="muted">Sample data, saved only in this browser.</div>
            </div>
            <button className="btn btn-sm" onClick={() => { if (window.confirm('Reset the demo to its original sample data?')) void resetDemo() }}>Reset</button>
          </div>
        )}

        {emailMode ? (
          <>
            <CloudSignIn
              initialApiUrl={settings?.syncApiUrl}
              submitLabel="Sign in"
              onError={() => undefined}
              onSignedIn={async (result, apiUrl) => {
                if (!linked || result.store.id !== settings!.syncStoreId) {
                  throw new Error("This device is linked to a different store. Sign in with that store's account, or use Settings → Data.")
                }
                await mergeStaffFromCloud(apiUrl, result.store.id).catch(() => undefined)
                loginWithToken(result.user.id, apiUrl, result.store.id, result.token)
                toast(`Welcome, ${result.user.name.split(' ')[0]}`, 'ok')
              }}
            />
            <div className="center" style={{ marginTop: 12 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setEmailMode(false)}><ArrowLeft size={14} /> Back to PIN login</button>
            </div>
          </>
        ) : !picked ? (
          <>
            <div className="small dim" style={{ marginBottom: 10 }}>Who's at the counter?</div>
            <div className="user-pick">
              {users.filter((u) => u.active).map((u) => (
                <button key={u.id} onClick={() => { setPicked(u); setPin('') }}>
                  <span className="avatar" style={{ background: 'var(--brand-50)', color: 'var(--brand-600)' }}>
                    {initialsOf(u.name)}
                  </span>
                  <span>
                    <span className="bold" style={{ display: 'block' }}>{u.name}</span>
                    <span className="tiny muted">{ROLE_NOTE[u.role]}</span>
                  </span>
                </button>
              ))}
            </div>
            {linked ? (
              <div className="center" style={{ marginTop: 14 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEmailMode(true)}>Sign in with email instead</button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="center">
              <div className="bold">{picked.name}</div>
              <div className="tiny muted">Enter 4-digit PIN</div>
            </div>
            <div className="pin-dots">
              {[0, 1, 2, 3].map((i) => <div key={i} className={`pin-dot ${i < pin.length ? 'on' : ''}`} />)}
            </div>
            <div className="pin-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} onClick={() => press(d)}>{d}</button>
              ))}
              <button onClick={() => { setPicked(null); setPin('') }} title="Back"><ArrowLeft size={18} /></button>
              <button onClick={() => press('0')}>0</button>
              <button onClick={() => setPin(pin.slice(0, -1))} title="Delete"><Backspace size={18} /></button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
