import { NavLink } from 'react-router-dom'
import { AlertIcon } from './icons'
import { useApp } from '../state'
import { isDesktop } from '../lib/tauri'
import { retryRejected, syncNow } from '../lib/sync'
import { backupNow } from '../lib/backup'
import { ago, useBackupState, useNow } from '../lib/useBackup'

const STUCK_MS = 10 * 60_000

/**
 * The one strip across the top that says "your data is not fully protected right now" — and why, and what to do.
 * It stays out of the way while everything is fine.
 */
export function SafetyBanner() {
  const { settings, sync, can, logout } = useApp()
  const b = useBackupState()
  const now = useNow()
  const linked = !!settings?.syncApiUrl

  let tone: 'warn' | 'danger' = 'warn'
  let text: React.ReactNode = null
  let action: React.ReactNode = null

  if (!linked) {
    text = <><b>Not connected to the cloud.</b> Your data is only on this device{isDesktop() ? ' (with backup files in Documents)' : ''}, so a lost or damaged computer means lost data.</>
    action = can('settings') ? <NavLink to="/settings" className="local-banner-link">Connect cloud backup</NavLink> : null
  } else if (!sync.authenticated) {
    tone = 'danger'
    text = <><b>Cloud backup is paused.</b> The sign-in expired, so new changes are not reaching the cloud. Your data is safe on this device.</>
    action = <button className="btn btn-sm" onClick={logout}>Sign in again</button>
  } else if (sync.pending > 0 && sync.oldestPendingAt && now - sync.oldestPendingAt > STUCK_MS) {
    tone = sync.online ? 'danger' : 'warn'
    text = <><b>{sync.pending} change{sync.pending === 1 ? ' hasn\'t' : 's haven\'t'} reached the cloud for {ago(sync.oldestPendingAt, now).replace(' ago', '')}.</b> {sync.online ? (sync.lastError ?? 'Trying again.') : 'No internet — they will upload as soon as you are back online.'}</>
    action = sync.online ? <button className="btn btn-sm" onClick={() => void syncNow()}>Sync now</button> : null
  } else if (sync.rejected > 0 && sync.superAdmin) {
    // Shop staff cannot act on this and it never affects billing, so only the support account is told.
    text = <><b>{sync.rejected} change{sync.rejected === 1 ? ' was' : 's were'} refused by the cloud and set aside.</b> Details are under Settings → Diagnostics. {sync.rejected === 1 ? 'It is' : 'They are'} still on this device and in the full backups.</>
    action = <button className="btn btn-sm" onClick={() => void retryRejected()}>Retry</button>
  } else if (b.cloud.error && !b.cloud.blocked) {
    text = <><b>Cloud backup didn't complete.</b> {b.cloud.error}</>
    action = <button className="btn btn-sm" disabled={b.running} onClick={() => void backupNow()}>Try again</button>
  } else if (isDesktop() && b.local.error) {
    text = <><b>Backup to this computer failed.</b> {b.local.error}</>
    action = <button className="btn btn-sm" disabled={b.running} onClick={() => void backupNow()}>Try again</button>
  }

  if (!text) return null
  return (
    <div className={`local-banner no-print ${tone === 'danger' ? 'danger' : ''}`} role="status">
      <AlertIcon size={15} />
      <span>{text}</span>
      {action}
    </div>
  )
}
