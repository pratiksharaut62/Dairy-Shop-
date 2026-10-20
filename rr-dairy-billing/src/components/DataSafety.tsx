import { useCallback, useEffect, useState } from 'react'
import { Confirm, Empty, Modal, Segmented } from './ui'
import { Download, Refresh, HistoryIcon } from './icons'
import { useApp } from '../state'
import { isDesktop, pickBackupFolder, saveBackup } from '../lib/tauri'
import { retryRejected, syncNow } from '../lib/sync'
import {
  INTERVALS, backupNow, disableFileProtection, enableFileProtection, fetchCloudBackup, getFileRecoveryKey, listCloudBackups,
  restoreBackup, setBackupDrive, setBackupFolder, setIntervalMin,
  type BackupPayload, type CloudBackupInfo, type IntervalMin,
} from '../lib/backup'
import { ago, useBackupState, useNow } from '../lib/useBackup'

type Level = 'ok' | 'warn' | 'bad' | 'off'
const BADGE: Record<Level, string> = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-danger', off: '' }
const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)

/** What the person needs to know about their data — is it safe, where is it, when did it last go anywhere. */
export function DataSafety() {
  const { settings, sync, toast, can } = useApp()
  const b = useBackupState()
  const now = useNow()
  const linked = !!settings?.syncApiUrl
  const [busy, setBusy] = useState(false)
  const [backups, setBackups] = useState<CloudBackupInfo[] | null>(null)
  const [listError, setListError] = useState('')
  const [restoring, setRestoring] = useState<{ info: CloudBackupInfo; payload: BackupPayload } | null>(null)
  const [loadingRestore, setLoadingRestore] = useState<number | null>(null)
  const desktop = isDesktop()
  const intervalMs = b.intervalMin * 60_000
  // Recovery key dialog: 'new' right after turning protection on (must be acknowledged), 'view' to look at it again.
  const [keyDialog, setKeyDialog] = useState<{ mode: 'new' | 'view'; key: string } | null>(null)
  const [keySaved, setKeySaved] = useState(false)

  async function chooseFolder() {
    try {
      const dir = await pickBackupFolder()
      if (!dir) return
      setBackupFolder(dir)
      toast(`Backups will be saved to ${dir}`, 'ok')
      void backupNow()
    } catch (e) {
      toast(String((e as Error)?.message ?? e), 'err')
    }
  }

  function turnProtectionOn() {
    try { setKeySaved(false); setKeyDialog({ mode: 'new', key: enableFileProtection() }) }
    catch (e) { toast((e as Error).message, 'err') }
  }
  function closeKeyDialog() {
    // Closing the first-time dialog without confirming means the key was never kept: undo, so no files are locked with a key nobody has.
    if (keyDialog?.mode === 'new' && !keySaved) { disableFileProtection(); toast('File protection was not turned on — save the key first') }
    setKeyDialog(null)
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(keyDialog?.key ?? ''); toast('Recovery key copied', 'ok') } catch { toast('Could not copy — select the key and copy it by hand', 'err') }
  }
  async function saveKeyFile() {
    const text = `RR Dairy — backup recovery key\r\n\r\n${keyDialog?.key}\r\n\r\nThis key opens the backup files in ${b.local.customDir || 'Documents\\RR Dairy Backups'}.\r\nKeep it somewhere other than this computer.\r\n`
    const res = await saveBackup(text, 'rr-dairy-recovery-key.txt')
    if (res.ok) toast('Recovery key saved — keep that file off this computer', 'ok')
  }

  const refreshList = useCallback(async () => {
    if (!linked || !sync.authenticated) { setBackups(null); return }
    try { setBackups(await listCloudBackups()); setListError('') } catch (e) { setListError((e as Error).message); setBackups(null) }
  }, [linked, sync.authenticated])
  useEffect(() => { void refreshList() }, [refreshList, b.cloud.uploadedAt])

  // ---- Status of each layer ----
  const pendingAge = sync.oldestPendingAt ? now - sync.oldestPendingAt : 0
  const live: { level: Level; text: string } =
    !linked ? { level: 'bad', text: 'Not connected — changes stay on this device only' }
    : !sync.authenticated ? { level: 'bad', text: 'Paused — sign in again to resume' }
    : !sync.online ? { level: 'warn', text: `Offline — ${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting` }
    : sync.pending > 0 ? { level: pendingAge > 10 * 60_000 ? 'warn' : 'ok', text: `${sync.pending} change${sync.pending === 1 ? '' : 's'} uploading${sync.oldestPendingAt ? ` (oldest ${ago(sync.oldestPendingAt, now)})` : ''}` }
    : sync.rejected > 0 && sync.superAdmin ? { level: 'warn', text: `${sync.rejected} change${sync.rejected === 1 ? '' : 's'} refused by the cloud and set aside — still in the full backups` }
    : { level: 'ok', text: sync.lastSyncedAt ? `Up to date · last sent ${ago(sync.lastSyncedAt, now)}` : 'Up to date' }

  const cloud: { level: Level; text: string } =
    !linked ? { level: 'off', text: 'Needs a cloud connection' }
    : b.cloud.blocked ? { level: 'off', text: 'Only the owner or a manager can create cloud backups' }
    : b.cloud.error ? { level: 'bad', text: b.cloud.error }
    : !b.cloud.okAt ? { level: 'warn', text: 'No backup made yet' }
    : now - b.cloud.okAt > intervalMs * 3 + 60_000 ? { level: 'warn', text: `Last confirmed ${ago(b.cloud.okAt, now)} — overdue` }
    : { level: 'ok', text: `Confirmed ${ago(b.cloud.okAt, now)}${b.cloud.uploadedAt ? ` · last upload ${ago(b.cloud.uploadedAt, now)} (${kb(b.cloud.size)})` : ''}` }

  const disk: { level: Level; text: string } =
    !desktop ? { level: 'off', text: 'Available in the desktop app' }
    : b.local.error ? { level: 'bad', text: b.local.error }
    : !b.local.okAt ? { level: 'warn', text: 'No backup file made yet' }
    : now - b.local.okAt > intervalMs * 3 + 60_000 ? { level: 'warn', text: `Last confirmed ${ago(b.local.okAt, now)} — overdue` }
    : { level: 'ok', text: `Confirmed ${ago(b.local.okAt, now)}${b.local.file ? ` · ${b.local.file}` : ''}${b.local.encrypted ? ' · locked' : ''}` }

  const overall: Level = [live, cloud, disk].some((r) => r.level === 'bad' && r !== (desktop ? undefined : disk)) ? 'bad'
    : [live, cloud, disk].some((r) => r.level === 'warn') ? 'warn' : 'ok'

  async function doBackup() {
    setBusy(true)
    try {
      if (linked && sync.authenticated) await syncNow()
      const results = await backupNow()
      const failed = results.filter((r) => !r.ok)
      if (!results.length) toast('A backup is already running')
      else if (failed.length) toast(failed.map((r) => `${r.where}: ${r.message}`).join(' · '), 'err')
      else toast(results.map((r) => `${r.where}: ${r.message}`).join(' · '), 'ok')
      await refreshList()
    } finally { setBusy(false) }
  }

  async function prepareRestore(info: CloudBackupInfo) {
    setLoadingRestore(info.id)
    try { setRestoring({ info, payload: await fetchCloudBackup(info) }) }
    catch (e) { toast((e as Error).message, 'err') }
    finally { setLoadingRestore(null) }
  }

  async function doRestore() {
    if (!restoring) return
    try {
      await restoreBackup(restoring.payload)
      toast('Backup restored — reloading', 'ok')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) { toast((e as Error).message, 'err') }
  }

  const rows: Array<{ label: string; hint: string; r: { level: Level; text: string }; action?: React.ReactNode }> = [
    { label: 'Live sync to the cloud', hint: 'Every sale, stock change and edit is sent as it happens', r: live,
      action: linked && sync.authenticated
        ? <button className="btn btn-sm" onClick={() => void (sync.superAdmin && sync.rejected > 0 && !sync.pending ? retryRejected() : syncNow())}><Refresh size={14} /> {sync.superAdmin && sync.rejected > 0 && !sync.pending ? 'Retry' : 'Sync now'}</button>
        : undefined },
    { label: 'Full cloud backup', hint: 'A complete copy of everything, kept in versions you can restore', r: cloud },
    { label: 'Backup on this computer', hint: desktop ? (b.local.folder || 'Documents\\RR Dairy Backups') : 'Saves to a folder on this PC', r: disk },
    { label: 'Protected storage', hint: 'Asks the system never to clear this app\'s data on its own',
      r: b.persisted === true ? { level: 'ok', text: 'Granted' } : b.persisted === false ? { level: 'warn', text: 'Not guaranteed — keep backups current' } : { level: 'off', text: 'Not supported here' } },
  ]

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Data safety</h2>
          <span className={`badge ${BADGE[overall]}`}>{overall === 'ok' ? 'Protected' : overall === 'warn' ? 'Needs attention' : 'At risk'}</span>
        </div>
        <div className="card-body">
          <table className="tbl">
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td style={{ width: '34%' }}><div className="bold">{row.label}</div><div className="small muted" style={{ wordBreak: 'break-word' }}>{row.hint}</div></td>
                  <td><span className={`badge ${BADGE[row.r.level]}`}>{row.r.level === 'ok' ? '✓' : row.r.level === 'off' ? '–' : '!'}</span> <span style={{ marginLeft: 6, wordBreak: 'break-word' }}>{row.r.text}</span></td>
                  <td className="right">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 12 }}>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              <span className="bold">Back up every</span>
              <Segmented value={String(b.intervalMin)} options={INTERVALS.map((n) => ({ value: String(n), label: n === 60 ? '1 hour' : `${n} min` }))}
                onChange={(v) => setIntervalMin(Number(v) as IntervalMin)} />
              <span className="small muted">Only when something has changed.</span>
            </div>
            <button className="btn btn-primary btn-lg" disabled={busy || b.running} onClick={() => void doBackup()}>
              <Download size={15} /> {busy || b.running ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        </div>
      </section>

      {desktop && can('settings') && (
        <section className="card">
          <div className="card-head"><h2>Backup files on this computer</h2></div>
          <div className="card-body">
            <div className="row between" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 320px' }}>
                <label className="checkbox">
                  <input type="checkbox" checked={b.local.encrypted} onChange={(e) => (e.target.checked ? turnProtectionOn() : disableFileProtection())} />
                  <b>Lock the backup files</b>
                </label>
                <div className="small muted" style={{ marginTop: 6 }}>
                  Backup files hold every customer's phone number and all sales. Locked files can't be read by anyone who copies them
                  (for example through OneDrive or a USB stick) without the recovery key. <b>Keep the key somewhere other than this computer</b> —
                  it is the only way into the files if this computer is lost. New files are locked; older ones stay as they were.
                </div>
              </div>
              {b.local.encrypted && (
                <button className="btn btn-sm" onClick={() => setKeyDialog({ mode: 'view', key: getFileRecoveryKey() })}>Show recovery key</button>
              )}
            </div>

            <div className="row between" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 18 }}>
              <div style={{ flex: '1 1 320px' }}>
                <div className="bold">Backup folder</div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  Where the backup files are saved. Currently <b>{b.local.customDir || 'Documents\\RR Dairy Backups'}</b>.
                  Pick a folder that is not on the same disk as the shop's data if you can (another drive, or a synced folder such as OneDrive).
                </div>
              </div>
              <div className="row gap-6 wrap">
                <button className="btn" onClick={() => void chooseFolder()}>Choose folder…</button>
                {b.local.customDir && <button className="btn" onClick={() => { setBackupFolder(''); toast('Backups go back to Documents') }}>Use default</button>}
              </div>
            </div>

            <div className="row between" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 18 }}>
              <div style={{ flex: '1 1 320px' }}>
                <div className="bold">Second copy on another drive</div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  A USB stick or second disk. A folder called "RR Dairy Backups" is created on it, and every backup is written there too.
                  Keep it plugged in — if it's removed you'll see a warning. Useful when this computer's own disk is nearly full.
                </div>
              </div>
              <select className="select" style={{ width: 150 }} aria-label="Second copy drive" value={b.local.drive}
                onChange={(e) => { setBackupDrive(e.target.value); if (e.target.value) toast(`Backups will also be saved to drive ${e.target.value}:`) }}>
                <option value="">None</option>
                {'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => <option key={l} value={l}>Drive {l}:</option>)}
              </select>
            </div>
          </div>
        </section>
      )}

      {linked && (
        <section className="card">
          <div className="card-head">
            <h2>Cloud backups</h2>
            <button className="btn btn-sm" onClick={() => void refreshList()}><Refresh size={14} /> Refresh</button>
          </div>
          {listError ? <div className="small muted" style={{ padding: 16 }}>{listError}</div>
            : backups === null ? <div className="small muted" style={{ padding: 16 }}>{sync.authenticated ? 'Loading…' : 'Sign in to the cloud to see your backups.'}</div>
            : !backups.length ? <Empty icon={<HistoryIcon size={24} />} title="No cloud backups yet" hint="The first one is made a few seconds after you sign in, or press Back up now." />
            : (
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Saved</th><th>From</th><th>Contents</th><th className="num">Size</th><th /></tr></thead>
                  <tbody>
                    {backups.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <div className="bold">{new Date(x.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                          <div className="small muted">{ago(new Date(x.createdAt).getTime(), now)}{x.kind === 'manual' && ' · manual'}</div>
                        </td>
                        <td className="muted">{x.device || '—'}</td>
                        <td className="small">{(['bills', 'customers', 'variants'] as const).map((k) => `${(x.counts[k] ?? 0).toLocaleString('en-IN')} ${k}`).join(' · ')}</td>
                        <td className="num muted">{kb(x.sizeBytes)}</td>
                        <td className="right">
                          {can('settings') && <button className="btn btn-sm" disabled={loadingRestore === x.id} onClick={() => void prepareRestore(x)}>{loadingRestore === x.id ? 'Checking…' : 'Restore'}</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      )}

      <Modal open={!!keyDialog} title={keyDialog?.mode === 'new' ? 'Save your recovery key' : 'Recovery key'} onClose={closeKeyDialog}
        footer={keyDialog?.mode === 'new'
          ? <><button className="btn" onClick={closeKeyDialog}>Cancel</button><button className="btn btn-primary btn-lg" disabled={!keySaved} onClick={() => { setKeyDialog(null) }}>Done — backup files are locked</button></>
          : <button className="btn btn-primary" onClick={closeKeyDialog}>Close</button>}>
        <div className="dim" style={{ marginBottom: 12 }}>
          Backup files in <b>{b.local.customDir || 'Documents\\RR Dairy Backups'}</b> are locked with this key. To restore one (Settings → Data → Restore from file) you will type it in.
          Without it a locked file cannot be opened by anyone, including us.
        </div>
        <div className="mono bold" style={{ fontSize: 17, letterSpacing: '.04em', padding: '14px 16px', background: 'var(--surface-2, #f3f4f6)', borderRadius: 10, border: '1px solid var(--line)', userSelect: 'all', wordBreak: 'break-all' }}>
          {keyDialog?.key}
        </div>
        <div className="row gap-6 wrap" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void copyKey()}>Copy</button>
          <button className="btn" onClick={() => void saveKeyFile()}>Save as a file…</button>
        </div>
        {keyDialog?.mode === 'new' && (
          <label className="checkbox" style={{ marginTop: 16 }}>
            <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)} />
            I have saved this key somewhere other than this computer (phone, email to myself, or on paper)
          </label>
        )}
      </Modal>

      <Confirm open={!!restoring} title="Restore this backup?" danger confirmLabel="Restore backup"
        message={restoring && (
          <>
            This replaces <strong>everything on this device</strong> with the backup saved on{' '}
            <strong>{new Date(restoring.info.createdAt).toLocaleString('en-IN')}</strong>:{' '}
            {(['bills', 'customers', 'variants', 'expenses'] as const).map((k) => `${(restoring.info.counts[k] ?? 0).toLocaleString('en-IN')} ${k}`).join(', ')}.
            Anything entered after that time and not yet uploaded will be lost. Staff keep their current PINs.
          </>
        )}
        onConfirm={() => void doRestore()} onClose={() => setRestoring(null)} />
    </>
  )
}
