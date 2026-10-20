import { exportBackup, importBackup, db } from '../db'
import { withSyncPaused } from '../db/syncHooks'
import { cloudRequest, flush, isCloudReady } from './sync'
import { isDesktop } from './tauri'
import { KEY_ITERATIONS, encryptText, formatRecoveryKey, makeRecoveryKey } from './crypto'

/**
 * Backups, in two independent layers behind the normal change-by-change sync (lib/sync.ts):
 *
 *   1. CLOUD — every N minutes (5 / 15 / 60) a complete, compressed copy of everything on this device is uploaded
 *      to the cloud database, but only if something changed since the last upload. Staff PINs are never included.
 *   2. THIS COMPUTER (desktop app) — on the same schedule, a backup file is written to Documents\RR Dairy
 *      Backups (and, if chosen, a second copy on another drive such as a USB stick), written safely (temp file →
 *      verified → renamed) and rotated so the folder cannot fill the disk. The files can be encrypted with a
 *      recovery key the owner keeps. One last save of both also happens when the window is closed.
 *
 * Either layer alone survives most accidents; together they survive the rest (a wiped browser profile, a dead
 * disk, a stolen PC, an internet outage lasting days).
 */

export type IntervalMin = 5 | 15 | 60
export const INTERVALS: IntervalMin[] = [5, 15, 60]

export interface BackupPayload { version?: number; exportedAt?: number; data: Record<string, unknown[]> }

export interface BackupState {
  intervalMin: IntervalMin
  running: boolean
  /** Whether the system promised not to clear this app's stored data on its own (null = unknown / unsupported). */
  persisted: boolean | null
  cloud: { okAt: number; uploadedAt: number; size: number; error: string | null; blocked: boolean }
  local: { supported: boolean; okAt: number; file: string; folder: string; error: string | null; encrypted: boolean; drive: string; customDir: string }
  nextCloudAt: number
  nextLocalAt: number
}

interface Prefs {
  intervalMin: IntervalMin
  device: string
  cloudSum: string; cloudOkAt: number; cloudUploadedAt: number; cloudSize: number
  localSum: string; localOkAt: number; localFile: string; localFolder: string
  /** Optional second location: a drive letter such as "E" (a USB stick or second disk). Empty = none. */
  driveLetter: string
  /** Folder chosen in Settings for the backup files on this computer. Empty = Documents\\RR Dairy Backups. */
  customDir: string
  /** Backup files on this computer are encrypted with the recovery key kept in FILE_KEY. */
  encryptFiles: boolean
}

const PREFS_KEY = 'kc_backup_prefs'
const FOLDER = 'RR Dairy Backups'
const KEEP_AUTO = 24
const KEEP_DAILY = 30
const COUNT_KEYS = ['products', 'variants', 'bills', 'customers', 'expenses', 'purchases', 'suppliers', 'audit'] as const

function loadPrefs(): Prefs {
  const fresh: Prefs = {
    intervalMin: 15, device: `${isDesktop() ? 'Desktop' : 'Browser'}-${Math.random().toString(36).slice(2, 6)}`,
    cloudSum: '', cloudOkAt: 0, cloudUploadedAt: 0, cloudSize: 0, localSum: '', localOkAt: 0, localFile: '', localFolder: '',
    driveLetter: '', customDir: '', encryptFiles: false,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null
    return saved ? { ...fresh, ...saved } : fresh
  } catch {
    return fresh
  }
}
let prefs = loadPrefs()
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* private mode */ } }

let cloudTryAt = 0
let localTryAt = 0
let state: BackupState = {
  intervalMin: prefs.intervalMin, running: false, persisted: null,
  cloud: { okAt: prefs.cloudOkAt, uploadedAt: prefs.cloudUploadedAt, size: prefs.cloudSize, error: null, blocked: false },
  local: { supported: false, okAt: prefs.localOkAt, file: prefs.localFile, folder: prefs.localFolder, error: null, encrypted: prefs.encryptFiles, drive: prefs.driveLetter, customDir: prefs.customDir },
  nextCloudAt: 0, nextLocalAt: 0,
}
state.local.supported = isDesktop()

const listeners = new Set<(s: BackupState) => void>()
type Patch = Omit<Partial<BackupState>, 'cloud' | 'local'> & { cloud?: Partial<BackupState['cloud']>; local?: Partial<BackupState['local']> }
function setState(patch: Patch) {
  state = {
    ...state, ...patch,
    cloud: { ...state.cloud, ...(patch.cloud ?? {}) },
    local: { ...state.local, ...(patch.local ?? {}) },
  }
  listeners.forEach((l) => l(state))
}
export function onBackupStateChange(l: (s: BackupState) => void): () => void { listeners.add(l); l(state); return () => listeners.delete(l) }
export const getBackupState = () => state
/** This installation's short name (`Desktop-ab12`), kept in local storage — used to tell devices apart in cloud backups and health reports. */
export const getDeviceName = () => prefs.device

const everyMs = () => prefs.intervalMin * 60_000
function schedule() {
  setState({
    nextCloudAt: cloudTryAt ? cloudTryAt + everyMs() : Date.now(),
    nextLocalAt: localTryAt ? localTryAt + everyMs() : Date.now(),
  })
}

export function setIntervalMin(n: IntervalMin) {
  prefs.intervalMin = n
  savePrefs()
  setState({ intervalMin: n })
  schedule()
}

/* ---------------------------------------------------------------- building a snapshot */

const enc = new TextEncoder()

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

interface Snapshot { text: string; sum: string; counts: Record<string, number> }

/**
 * Everything on this device as one JSON document. `sum` fingerprints the data alone (not the timestamp), so an
 * unchanged database is recognised and not uploaded or written again.
 */
async function snapshot(opts: { stripPins: boolean }): Promise<Snapshot> {
  const dump = await exportBackup()
  const data: Record<string, unknown[]> = { ...dump.data }
  if (opts.stripPins && Array.isArray(data.users)) {
    data.users = (data.users as Array<Record<string, unknown>>).map((u) => Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'pin')))
  }
  const dataText = JSON.stringify(data)
  const counts: Record<string, number> = {}
  for (const k of COUNT_KEYS) counts[k] = Array.isArray(data[k]) ? data[k].length : 0
  return {
    text: `{"version":1,"exportedAt":${Date.now()},"data":${dataText}}`,
    sum: await sha256Hex(dataText),
    counts,
  }
}

/** A downloaded cloud backup is rejected unless its contents hash to what was recorded at upload time. */
async function verified(text: string, expectedSum: string | null): Promise<BackupPayload> {
  const payload = JSON.parse(text) as BackupPayload
  if (!payload?.data || typeof payload.data !== 'object') throw new Error('That backup is not readable')
  if (expectedSum && (await sha256Hex(JSON.stringify(payload.data))) !== expectedSum) throw new Error('That backup failed its integrity check — it may be damaged')
  return payload
}

/* ---------------------------------------------------------------- cloud */

export interface CloudBackupInfo {
  id: number; createdAt: string; createdBy: string | null; device: string; kind: 'auto' | 'manual'
  checksum: string; sizeBytes: number; rawBytes: number; counts: Record<string, number>
}

export async function backupToCloud(opts: { manual?: boolean } = {}): Promise<{ ok: boolean; skipped?: boolean; message: string }> {
  if (!isCloudReady()) {
    const message = 'Not connected to the cloud — sign in to back up'
    setState({ cloud: { error: message } })
    return { ok: false, message }
  }
  try {
    const snap = await snapshot({ stripPins: true })
    if (!opts.manual && snap.sum === prefs.cloudSum) {
      prefs.cloudOkAt = Date.now(); savePrefs()
      setState({ cloud: { okAt: prefs.cloudOkAt, error: null } })
      return { ok: true, skipped: true, message: 'Cloud copy is already up to date' }
    }
    const gz = await gzip(snap.text)
    const res = await cloudRequest('/backups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream', 'X-Checksum': snap.sum, 'X-Device': prefs.device,
        'X-Kind': opts.manual ? 'manual' : 'auto', 'X-Counts': JSON.stringify(snap.counts), 'X-Raw-Bytes': String(snap.text.length),
      },
      body: gz as BodyInit,
    })
    if (res.status === 403) {
      const message = 'This sign-in can\'t create cloud backups — only the owner or a manager can'
      setState({ cloud: { error: message, blocked: true } })
      return { ok: false, message }
    }
    if (res.status === 413) {
      const message = 'The backup is too large for the cloud to accept — contact support (the hosting plan\'s upload limit has been reached)'
      setState({ cloud: { error: message } })
      return { ok: false, message }
    }
    if (!res.ok) {
      const message = `Cloud backup failed (${res.status})`
      setState({ cloud: { error: message } })
      return { ok: false, message }
    }
    const now = Date.now()
    prefs = { ...prefs, cloudSum: snap.sum, cloudOkAt: now, cloudUploadedAt: now, cloudSize: gz.length }
    savePrefs()
    setState({ cloud: { okAt: now, uploadedAt: now, size: gz.length, error: null, blocked: false } })
    return { ok: true, message: `Cloud backup saved (${(gz.length / 1024).toFixed(0)} KB)` }
  } catch (e) {
    const message = navigator.onLine ? `Cloud backup failed: ${(e as Error).message}` : 'No internet connection — will retry'
    setState({ cloud: { error: message } })
    return { ok: false, message }
  }
}

export async function listCloudBackups(): Promise<CloudBackupInfo[]> {
  const res = await cloudRequest('/backups')
  if (!res.ok) throw new Error(res.status === 403 ? 'Only the owner or a manager can see cloud backups' : `Could not load backups (${res.status})`)
  return res.json()
}

export async function fetchCloudBackup(info: CloudBackupInfo): Promise<BackupPayload> {
  const res = await cloudRequest(`/backups/${info.id}`)
  if (!res.ok) throw new Error(res.status === 403 ? 'Only the owner can restore from a cloud backup' : `Could not download the backup (${res.status})`)
  const text = await gunzip(await res.arrayBuffer())
  return verified(text, info.checksum)
}

/**
 * Replaces everything on this device with the backup. Staff PINs are not stored in cloud backups, so each person
 * keeps the PIN already on this device (anyone new simply signs in through the cloud once).
 */
export async function restoreBackup(payload: BackupPayload): Promise<void> {
  const local = await db.users.toArray()
  if (Array.isArray(payload.data.users)) {
    payload.data.users = (payload.data.users as Array<Record<string, unknown>>).map((u) => ({
      ...u, pin: (u.pin as string | undefined) ?? local.find((x) => x.id === u.id)?.pin ?? '',
    }))
  }
  // A restore is not "new activity": don't queue every restored row for upload.
  await withSyncPaused(() => importBackup(payload))
  // Forget what we believed was already backed up, so the next schedule re-checks against the restored data.
  prefs = { ...prefs, cloudSum: '', localSum: '' }
  savePrefs()
}

/* ---------------------------------------------------------------- this computer (desktop app) */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
const hms = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/* --- the key that locks the backup files on this computer --- */

const FILE_KEY = 'kc_backup_filekey'
const readFileKey = (): string => { try { return localStorage.getItem(FILE_KEY) ?? '' } catch { return '' } }

/** The recovery key in the form the owner writes down — empty when file protection is off. */
export function getFileRecoveryKey(): string {
  const k = readFileKey()
  return prefs.encryptFiles && k ? formatRecoveryKey(k) : ''
}

/**
 * Locks the backup files written to this computer. The key stays here so unattended backups can use it; the owner
 * is shown it to keep elsewhere, because it is the only way into the files if this computer is lost.
 */
export function enableFileProtection(): string {
  const key = readFileKey() || makeRecoveryKey()
  try { localStorage.setItem(FILE_KEY, key) } catch { throw new Error('This computer would not let the app keep the key') }
  prefs = { ...prefs, encryptFiles: true, localSum: '' }
  savePrefs()
  setState({ local: { encrypted: true } })
  return formatRecoveryKey(key)
}

export function disableFileProtection() {
  prefs = { ...prefs, encryptFiles: false, localSum: '' }
  savePrefs()
  setState({ local: { encrypted: false } })
}

/** A second place for the backup files — "E" for a USB stick or second disk, '' for none. */
export function setBackupDrive(letter: string) {
  const l = /^[D-Z]$/i.test(letter) ? letter.toUpperCase() : ''
  prefs = { ...prefs, driveLetter: l, localSum: '' }
  savePrefs()
  setState({ local: { drive: l } })
}

/** Where the backup files on this computer go. '' puts them back in Documents\\RR Dairy Backups. */
export function setBackupFolder(path: string) {
  prefs = { ...prefs, customDir: path, localSum: '' }
  savePrefs()
  setState({ local: { customDir: path } })
}

type FsApi = typeof import('@tauri-apps/plugin-fs')
/** A folder to write into: relative to a well-known folder (Documents), or an absolute path on another drive. */
interface Target { label: string; dir: string; base?: number }

function plainReason(e: unknown): string {
  const m = String((e as Error)?.message ?? e)
  if (/os error 112|no space|disk full/i.test(m)) return 'the disk is full'
  if (/os error 5\b|access is denied|not allowed|scope|permission/i.test(m)) return 'the app is not allowed to write there'
  if (/os error (2|3|21)\b|cannot find|not found|no such/i.test(m)) return 'the folder or drive was not found'
  if (/os error 19\b|write.protected/i.test(m)) return 'the drive is write-protected'
  return m
}

/** Writes one backup (and today's "daily" copy) into a target folder and trims old files there. */
async function writeBackupTo(fs: FsApi, t: Target, file: string, daily: string, body: string): Promise<void> {
  const o = t.base === undefined ? {} : { baseDir: t.base }
  const join = (name: string) => `${t.dir}${t.base === undefined ? '\\' : '/'}${name}`
  await fs.mkdir(t.dir, { ...o, recursive: true })

  // Write to a temp name, read it back to prove it is complete, then rename into place: a power cut or crash
  // mid-write can never leave a half-written file that looks like a good backup.
  const writeSafely = async (name: string) => {
    const tmp = join(`${name}.tmp`)
    await fs.writeTextFile(tmp, body, o)
    const back = await fs.readTextFile(tmp, o)
    if (back.length !== body.length) throw new Error('The saved file did not match — is the disk full?')
    await fs.rename(tmp, join(name), { oldPathBaseDir: t.base, newPathBaseDir: t.base })
  }
  await writeSafely(file)
  await writeSafely(daily)

  // Keep the newest 24 automatic files and the last 30 days' daily files; clear any stray temp files.
  const entries = (await fs.readDir(t.dir, o)).map((e) => e.name)
  const drop = [
    ...entries.filter((n) => /^auto-\d{8}-\d{6}\.json$/.test(n)).sort().reverse().slice(KEEP_AUTO),
    ...entries.filter((n) => /^daily-\d{8}\.json$/.test(n)).sort().reverse().slice(KEEP_DAILY),
    ...entries.filter((n) => n.endsWith('.tmp')),
  ]
  for (const n of drop) await fs.remove(join(n), o).catch(() => undefined)
}

export async function backupToDisk(opts: { manual?: boolean } = {}): Promise<{ ok: boolean; skipped?: boolean; message: string }> {
  if (!isDesktop()) return { ok: false, message: 'Backups to this computer are available in the desktop app' }
  try {
    const snap = await snapshot({ stripPins: false })
    // The fingerprint also covers where and how the files are written, so changing either triggers a fresh write.
    const mark = `${snap.sum}|${prefs.encryptFiles ? 'e' : 'p'}|${prefs.driveLetter}|${prefs.customDir}`
    if (!opts.manual && mark === prefs.localSum) {
      prefs.localOkAt = Date.now(); savePrefs()
      setState({ local: { okAt: prefs.localOkAt, error: null } })
      return { ok: true, skipped: true, message: 'Backup on this computer is already up to date' }
    }

    let body = snap.text
    if (prefs.encryptFiles) {
      const key = readFileKey()
      if (!key) throw new Error('the key that protects the backup files is missing — open Settings → Data and turn file protection off and on again')
      body = await encryptText(snap.text, key, KEY_ITERATIONS)
    }

    const fs = await import('@tauri-apps/plugin-fs')
    const targets: Target[] = []
    if (prefs.customDir) {
      // A folder picked in Settings is only allowed for the run it was picked in, so allow it again before writing.
      const { allowBackupFolder } = await import('./tauri')
      await allowBackupFolder(prefs.customDir)
      targets.push({ label: prefs.customDir, dir: prefs.customDir })
    } else {
      targets.push({ label: 'Documents', dir: FOLDER, base: fs.BaseDirectory.Document })
    }
    if (prefs.driveLetter) targets.push({ label: `Drive ${prefs.driveLetter}:`, dir: `${prefs.driveLetter}:\\${FOLDER}` })

    const now = new Date()
    const file = `auto-${ymd(now)}-${hms(now)}.json`
    const daily = `daily-${ymd(now)}.json`
    const saved: string[] = []
    const failed: string[] = []
    for (const t of targets) {
      try { await writeBackupTo(fs, t, file, daily, body); saved.push(t.label) } catch (e) { failed.push(`${t.label}: ${plainReason(e)}`) }
    }

    let folder = prefs.localFolder
    try {
      const path = await import('@tauri-apps/api/path')
      folder = prefs.customDir || await path.join(await path.documentDir(), FOLDER)
      if (prefs.driveLetter) folder += `  +  ${prefs.driveLetter}:\\${FOLDER}`
    } catch { /* display only */ }

    if (saved.length) {
      prefs = { ...prefs, localSum: failed.length ? '' : mark, localOkAt: Date.now(), localFile: file, localFolder: folder }
      savePrefs()
    }
    if (failed.length) {
      // The reason alone — the banner and the status row supply the "Backup to this computer failed" heading.
      const reason = saved.length ? `Saved to ${saved.join(', ')}, but not to ${failed.join(' · ')}` : failed.join(' · ')
      setState({ local: saved.length ? { okAt: prefs.localOkAt, file, folder, error: reason } : { error: reason } })
      return { ok: false, message: `Backup to this computer ${saved.length ? 'only partly worked' : 'failed'}: ${reason}` }
    }
    setState({ local: { okAt: prefs.localOkAt, file, folder, error: null } })
    return { ok: true, message: `Saved ${file}${targets.length > 1 ? ` to ${saved.join(' and ')}` : ''}` }
  } catch (e) {
    const reason = plainReason(e)
    setState({ local: { error: reason } })
    return { ok: false, message: `Backup to this computer failed: ${reason}` }
  }
}

/* ---------------------------------------------------------------- schedule */

let timer: ReturnType<typeof setInterval> | null = null
let visibilityBound = false
let closeBound = false

/** Resolves once no scheduled/manual backup is mid-run (so a close-time backup never collides with one). */
async function waitIdle() {
  while (state.running) await new Promise((r) => setTimeout(r, 100))
}

/**
 * One last save as the app is closing: the backup file on this computer first (instant), then whatever is still
 * waiting for the cloud. Capped so closing the window can never hang on a slow connection.
 */
export async function backupOnClose(maxMs = 6000): Promise<void> {
  const work = (async () => {
    await waitIdle()
    setState({ running: true })
    try {
      if (isDesktop()) await backupToDisk()
      if (isCloudReady()) await Promise.all([flush(), backupToCloud()])
    } finally {
      setState({ running: false })
    }
  })().catch(() => undefined)
  await Promise.race([work, new Promise((r) => setTimeout(r, maxMs))])
}

/** Desktop only: intercept the window closing, make the last backup, then really close. */
async function bindCloseBackup() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    let closing = false
    await win.onCloseRequested(async (event) => {
      if (closing) return
      closing = true
      event.preventDefault()
      await backupOnClose()
      try { await win.destroy() } catch { await win.close() }
    })
  } catch {
    closeBound = false // not inside the desktop shell, or the window API was refused — try again next start
  }
}

async function tick(soon = false) {
  if (state.running) return
  const now = Date.now()
  const gap = soon ? 60_000 : everyMs()
  const cloudDue = isCloudReady() && !state.cloud.blocked && now - cloudTryAt >= gap
  const localDue = isDesktop() && now - localTryAt >= gap
  if (!cloudDue && !localDue) return
  setState({ running: true })
  try {
    // Local first: it works with no internet and no sign-in, so it is the one that must never be skipped.
    if (localDue) {
      const r = await backupToDisk()
      // After a failure retry sooner than a full interval, but not in a tight loop.
      localTryAt = r.ok ? Date.now() : Date.now() - Math.max(0, everyMs() - Math.min(everyMs(), 5 * 60_000))
    }
    if (cloudDue) {
      const r = await backupToCloud()
      cloudTryAt = r.ok ? Date.now() : Date.now() - Math.max(0, everyMs() - Math.min(everyMs(), 5 * 60_000))
    }
  } finally {
    setState({ running: false })
    schedule()
  }
}

/** Run now and then on the chosen schedule. Safe to call repeatedly. */
export function startBackupScheduler() {
  void requestPersistence()
  setState({ cloud: { blocked: false } })
  if (isDesktop() && !closeBound) { closeBound = true; void bindCloseBackup() }
  if (!timer) timer = setInterval(() => void tick(), 30_000)
  setTimeout(() => void tick(), 15_000)
  if (!visibilityBound) {
    visibilityBound = true
    // Switching away or minimising is a natural moment to save: do it if the last backup is over a minute old.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void tick(true) })
  }
  schedule()
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

/** The "Back up now" button: both layers, ignoring the schedule and the unchanged-data shortcut. */
export async function backupNow(): Promise<Array<{ where: string; ok: boolean; message: string }>> {
  if (state.running) return []
  setState({ running: true, cloud: { blocked: false } })
  const out: Array<{ where: string; ok: boolean; message: string }> = []
  try {
    if (isDesktop()) { const r = await backupToDisk({ manual: true }); localTryAt = Date.now(); out.push({ where: 'This computer', ...r }) }
    if (isCloudReady()) { const r = await backupToCloud({ manual: true }); cloudTryAt = Date.now(); out.push({ where: 'Cloud', ...r }) }
    else out.push({ where: 'Cloud', ok: false, message: 'Not connected to the cloud' })
  } finally {
    setState({ running: false })
    schedule()
  }
  return out
}

/**
 * Asks the system not to clear this app's stored data on its own when disk space runs low. Browsers and web views
 * can evict "best effort" storage; a billing database must not be treated as disposable.
 */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) { setState({ persisted: null }); return null }
    const already = await navigator.storage.persisted()
    const ok = already || (await navigator.storage.persist())
    setState({ persisted: ok })
    return ok
  } catch {
    setState({ persisted: null })
    return null
  }
}
