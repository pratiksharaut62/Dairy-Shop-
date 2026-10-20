import { db } from '../db'
import { cloudRequest, getSyncState, isCloudReady, onSyncStateChange } from './sync'
import { getBackupState, getDeviceName, onBackupStateChange } from './backup'
import { isDesktop } from './tauri'

/**
 * Tells the cloud how this device's sync and backups are doing. The shop's PC is not reachable by us, so this is how
 * a stuck queue, a refused change or a failing backup becomes visible to the people who can fix it (the Diagnostics
 * screen, super admin only). Counters, error text and entity names only — never bill contents.
 *
 * Reports go out every 10 minutes, and straight away (at most every 30 s) when something starts or stops failing.
 */
const EVERY_MS = 10 * 60_000
const MIN_GAP_MS = 30_000

let started = false
let lastSentAt = 0
let lastSignature = ''
let version: string | null = null

async function appVersion(): Promise<string> {
  if (version) return version
  try {
    if (isDesktop()) version = (await (await import('@tauri-apps/api/app')).getVersion()) || 'desktop'
    else version = 'web'
  } catch { version = 'unknown' }
  return version
}

/** What matters for deciding whether to report early: new/cleared problems, not every counter tick. */
function signature(): string {
  const s = getSyncState(), b = getBackupState()
  return JSON.stringify([s.rejected, s.authenticated, s.pending > 0 && !!s.oldestPendingAt && Date.now() - s.oldestPendingAt > 10 * 60_000,
    b.cloud.error, b.local.error])
}

async function send(): Promise<void> {
  if (!isCloudReady()) return
  const s = getSyncState(), b = getBackupState()
  const rejects = await db.outbox.where('synced').equals(2).limit(10).toArray()
  lastSentAt = Date.now()
  lastSignature = signature()
  try {
    await cloudRequest('/device-health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: getDeviceName(), appVersion: await appVersion(), platform: isDesktop() ? 'desktop' : 'web',
        sync: { online: s.online, authenticated: s.authenticated, pending: s.pending, oldestPendingAt: s.oldestPendingAt, rejected: s.rejected, lastSyncedAt: s.lastSyncedAt, lastError: s.lastError },
        backup: { cloudOkAt: b.cloud.okAt, cloudError: b.cloud.error, localOkAt: b.local.okAt, localError: b.local.error, encrypted: b.local.encrypted, drive: b.local.drive },
        rejects: rejects.map((r) => ({ entity: r.entity, attempts: r.attempts, error: r.lastError ?? '', at: r.createdAt })),
      }),
    })
  } catch { /* offline or server unreachable — the next report will carry the same facts */ }
}

function maybeSendEarly() {
  if (Date.now() - lastSentAt < MIN_GAP_MS) return
  if (signature() !== lastSignature) void send()
}

/** Safe to call repeatedly. */
export function startHealthReporting() {
  if (started) return
  started = true
  onSyncStateChange(maybeSendEarly)
  onBackupStateChange(maybeSendEarly)
  setInterval(() => void send(), EVERY_MS)
  setTimeout(() => void send(), 20_000)
}
