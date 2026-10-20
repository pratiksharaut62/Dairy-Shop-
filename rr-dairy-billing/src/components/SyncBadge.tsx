import { useApp } from '../state'
import { CheckCircle, AlertIcon, RotateIcon } from './icons'

const fmtAgo = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

/**
 * Purposeful, not decorative: this is the one place in the UI that answers
 * "is this counter actually backed up right now?" — configured (has an API
 * URL) vs connected (authenticated) vs caught up (no pending rows) are three
 * different questions a shop owner genuinely asks.
 */
export function SyncBadge({ compact = false }: { compact?: boolean }) {
  const { settings, sync } = useApp()

  if (!settings?.syncApiUrl || !settings.syncStoreId) {
    return <span className="badge" title="Cloud sync isn't set up — Settings → Data">Local only</span>
  }
  if (!sync.online) {
    return <span className="badge badge-danger"><AlertIcon size={12} /> Offline{sync.pending > 0 ? ` · ${sync.pending} queued` : ''}</span>
  }
  if (!sync.authenticated) {
    return <span className="badge badge-warn"><AlertIcon size={12} /> Not signed in — log in again</span>
  }
  if (sync.pending > 0) {
    return <span className="badge badge-warn"><RotateIcon size={12} /> Syncing… {sync.pending} pending</span>
  }
  return (
    <span className="badge badge-ok" title={sync.lastSyncedAt ? `Last synced ${new Date(sync.lastSyncedAt).toLocaleString('en-IN')}` : undefined}>
      <CheckCircle size={12} /> {compact ? 'Synced' : `Synced${sync.lastSyncedAt ? ` · ${fmtAgo(sync.lastSyncedAt)}` : ''}`}
    </span>
  )
}
