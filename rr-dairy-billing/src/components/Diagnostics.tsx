import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { Empty } from './ui'
import { Refresh } from './icons'
import { useApp } from '../state'
import { cloudRequest, retryRejected } from '../lib/sync'
import { ago, useBackupState, useNow } from '../lib/useBackup'
import type { OutboxEntry } from '../db/types'

interface DeviceRow {
  deviceId: string; reportedAt: string; firstSeen: string; flags: string[]; appVersion?: string; platform?: string; role?: string
  sync?: { pending?: number; rejected?: number; lastSyncedAt?: number; lastError?: string | null; online?: boolean; authenticated?: boolean }
  backup?: { cloudOkAt?: number; cloudError?: string | null; localOkAt?: number; localError?: string | null; encrypted?: boolean; drive?: string | null }
  rejects?: Array<{ entity: string; attempts: number; error: string; at: number }>
}
interface StoreRow {
  id: string; name: string; plan: string; billCount: number; lastBillAt: number | null
  lastBackupAt: string | null; lastAutoBackupAt: string | null; flags: string[]; devices: DeviceRow[]
}

const FLAG_TEXT: Record<string, { text: string; bad: boolean }> = {
  never_backed_up: { text: 'Has sales but no cloud backup ever', bad: true },
  backup_stale: { text: 'Sales since the last backup, which is over a day old', bad: true },
  no_device_reports: { text: 'Has sales but no device has reported health', bad: false },
  silent: { text: 'Not reported recently', bad: false },
  rejected_changes: { text: 'Changes refused by the cloud', bad: true },
  stuck_queue: { text: 'Changes waiting over 10 min', bad: true },
  signed_out: { text: 'Cloud sign-in expired', bad: true },
  cloud_backup_failing: { text: 'Cloud backup failing', bad: true },
  local_backup_failing: { text: 'PC backup failing', bad: true },
}

const when = (ms: number | null | undefined, now: number) => (ms ? ago(ms, now) : 'never')

function Flags({ flags }: { flags: string[] }) {
  if (!flags.length) return <span className="badge badge-ok">Healthy</span>
  return <>{flags.map((f) => <span key={f} className={`badge ${FLAG_TEXT[f]?.bad ? 'badge-danger' : 'badge-warn'}`} style={{ marginRight: 4 }}>{FLAG_TEXT[f]?.text ?? f}</span>)}</>
}

/** Developer / support view: this device's refused changes in detail, and the health of every store's devices. */
export function Diagnostics() {
  const { toast } = useApp()
  const now = useNow()
  const b = useBackupState()
  const rejected = useLiveQuery(() => db.outbox.where('synced').equals(2).toArray(), [], [] as OutboxEntry[]) ?? []
  const [stores, setStores] = useState<StoreRow[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await cloudRequest('/admin/overview')
      if (!res.ok) throw new Error(res.status === 403 ? 'This account is not a super admin' : `Could not load (${res.status})`)
      setStores(((await res.json()) as { stores: StoreRow[] }).stores)
      setError('')
    } catch (e) { setError((e as Error).message); setStores(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <>
      <section className="card">
        <div className="card-head"><h2>All stores</h2><button className="btn btn-sm" disabled={loading} onClick={() => void load()}><Refresh size={14} /> Refresh</button></div>
        {error ? <div className="small muted" style={{ padding: 16 }}>{error}</div>
          : stores === null ? <div className="small muted" style={{ padding: 16 }}>Loading…</div>
          : !stores.length ? <Empty title="No stores yet" />
          : (
            <div className="table-wrap">
              {stores.map((s) => (
                <div key={s.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <div><span className="bold">{s.name}</span> <span className="small muted mono">{s.id} · {s.plan}</span></div>
                    <div><Flags flags={s.flags} /></div>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {s.billCount.toLocaleString('en-IN')} bills · last sale {when(s.lastBillAt, now)} · last cloud backup {when(s.lastBackupAt ? new Date(s.lastBackupAt).getTime() : null, now)}
                  </div>
                  {!s.devices.length ? <div className="small muted" style={{ marginTop: 8 }}>No device has reported yet (needs the latest app version).</div> : (
                    <table className="tbl" style={{ marginTop: 8 }}>
                      <thead><tr><th>Device</th><th>Reported</th><th>Version</th><th className="num">Waiting</th><th className="num">Refused</th><th>Backups</th><th>Status</th></tr></thead>
                      <tbody>
                        {s.devices.map((d) => (
                          <tr key={d.deviceId}>
                            <td className="mono">{d.deviceId}</td>
                            <td>{ago(new Date(d.reportedAt).getTime(), now)}</td>
                            <td>{d.appVersion ?? '—'}</td>
                            <td className="num">{d.sync?.pending ?? 0}</td>
                            <td className="num">{d.sync?.rejected ?? 0}</td>
                            <td className="small">
                              cloud {when(d.backup?.cloudOkAt, now)}{d.backup?.cloudError ? ` — ${d.backup.cloudError}` : ''}<br />
                              PC {when(d.backup?.localOkAt, now)}{d.backup?.localError ? ` — ${d.backup.localError}` : ''}
                            </td>
                            <td><Flags flags={d.flags} />
                              {d.rejects?.map((r, i) => <div key={i} className="small muted" style={{ marginTop: 4 }}>{r.entity} ×{r.attempts}: {r.error}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>This device</h2>
          {rejected.length > 0 && <button className="btn btn-sm" onClick={() => void retryRejected().then(() => toast('Re-queued the refused changes', 'ok'))}>Retry refused changes</button>}
        </div>
        <div className="card-body">
          <div className="small muted">
            Cloud backup: {when(b.cloud.okAt, now)}{b.cloud.error ? ` — ${b.cloud.error}` : ''} · PC backup: {when(b.local.okAt, now)}{b.local.error ? ` — ${b.local.error}` : ''}
          </div>
          {!rejected.length ? <div className="small" style={{ marginTop: 10 }}>No refused changes on this device.</div> : (
            <table className="tbl" style={{ marginTop: 10 }}>
              <thead><tr><th>Change</th><th className="num">Tries</th><th>Made</th><th>Why the cloud refused it</th></tr></thead>
              <tbody>
                {rejected.map((r) => (
                  <tr key={r.id}>
                    <td className="bold">{r.entity}</td><td className="num">{r.attempts}</td>
                    <td className="muted">{ago(r.createdAt, now)}</td><td className="small" style={{ wordBreak: 'break-word' }}>{r.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  )
}
