import { db } from '../db'
import type { SyncEntity } from '../db/types'

/** `pin` is empty for sessions that came from the web (email/password) login or a restored token — those can't silently re-authenticate. */
interface SyncCreds { apiUrl: string; storeId: string; userId: string; pin: string }

const SESSION_STORE = 'rr_sync_session'

function saveSession() {
  if (!creds || !token) return
  try { localStorage.setItem(SESSION_STORE, JSON.stringify({ token, apiUrl: creds.apiUrl, storeId: creds.storeId })) } catch { /* private mode */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_STORE) } catch { /* private mode */ }
}

/** Reads a claim out of a token that this app already holds (the server signed it; nothing here trusts it for access). */
function tokenClaim(t: string | null, claim: string): unknown {
  if (!t) return undefined
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))[claim] } catch { return undefined }
}

function setToken(t: string | null) {
  token = t
  setState({ superAdmin: tokenClaim(t, 'sa') === true })
}

function tokenExpired(t: string): boolean {
  try {
    const exp = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp as number
    return !exp || exp * 1000 < Date.now() + 60_000
  } catch {
    return true
  }
}

let token: string | null = null
let creds: SyncCreds | null = null
let flushing = false
let timer: ReturnType<typeof setInterval> | null = null

export type SyncListener = (state: SyncState) => void
export interface SyncState {
  online: boolean
  authenticated: boolean
  pending: number
  lastError: string | null
  lastSyncedAt: number | null
  /** When the oldest change still waiting to upload was made — how long data has been unprotected. */
  oldestPendingAt: number | null
  /** Changes the server refused for good (bad data) and that were set aside so the rest could continue. */
  rejected: number
  /** The signed-in cloud account is the developer / support account (a claim in the token, set only in the database). */
  superAdmin: boolean
}

let state: SyncState = { online: navigator.onLine, authenticated: false, pending: 0, lastError: null, lastSyncedAt: null, oldestPendingAt: null, rejected: 0, superAdmin: false }
const listeners = new Set<SyncListener>()

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l(state))
}

export function onSyncStateChange(listener: SyncListener): () => void {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export function getSyncState(): SyncState {
  return state
}

/** Called once at login, with the credentials the user already typed for the local PIN check — no second login screen. Silently does nothing if sync isn't configured for this store. */
export async function configureSync(apiUrl: string, storeId: string, userId: string, pin: string) {
  if (!apiUrl || !storeId) {
    creds = null
    setToken(null)
    setState({ authenticated: false })
    return
  }
  creds = { apiUrl: apiUrl.replace(/\/$/, ''), storeId, userId, pin }
  if (await authenticate()) await pushCategories()
  void flush()
}

/** Signed in through the web login: the server already issued a token, there is no PIN to re-authenticate with later. */
export async function configureSyncWithToken(apiUrl: string, storeId: string, newToken: string) {
  creds = { apiUrl: apiUrl.replace(/\/$/, ''), storeId, userId: '', pin: '' }
  setToken(newToken)
  saveSession()
  setState({ authenticated: true, lastError: null })
  await pushCategories()
  void flush()
}

/**
 * After a reload or app restart the in-memory token is gone but the person is still "logged in" locally —
 * pick the saved token back up so background sync keeps working without another sign-in.
 */
export function restoreSync(apiUrl: string, storeId: string) {
  if (creds || !apiUrl || !storeId) return
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_STORE) ?? 'null') as { token: string; apiUrl: string; storeId: string } | null
    if (!saved || saved.storeId !== storeId || saved.apiUrl !== apiUrl.replace(/\/$/, '') || tokenExpired(saved.token)) return
    creds = { apiUrl: saved.apiUrl, storeId, userId: '', pin: '' }
    setToken(saved.token)
    setState({ authenticated: true, lastError: null })
    void flush()
  } catch { /* corrupt entry — ignore, next login replaces it */ }
}

/**
 * Categories are static reference data picked from a dropdown, not created
 * at runtime, so there's no outbox hook for them (see db/syncHooks.ts) —
 * they're pushed once per login instead, as an idempotent upsert. Without
 * this, the first product a store syncs would 409 forever on a
 * category_id foreign key the backend has never seen, jamming the whole
 * outbox behind it (the queue is strictly ordered and stops at the first
 * failure).
 */
async function pushCategories() {
  if (!creds || !token) return
  try {
    const cats = await db.categories.toArray()
    for (const c of cats) {
      await fetch(`${creds.apiUrl}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: c.id, name: c.name, group: c.group }),
      })
    }
  } catch {
    // Best-effort — if a category genuinely failed to land, the product
    // sync that references it will surface a real, visible error next.
  }
}

export function stopSync() {
  creds = null
  setToken(null)
  clearSession()
  if (timer) clearInterval(timer)
  timer = null
  setState({ authenticated: false, online: navigator.onLine })
}

async function authenticate(): Promise<boolean> {
  if (!creds) return false
  if (!creds.pin) {
    setState({ authenticated: false, lastError: 'Cloud session expired — sign in again' })
    return false
  }
  try {
    const res = await fetch(`${creds.apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: creds.storeId, userId: creds.userId, pin: creds.pin }),
    })
    if (!res.ok) {
      setState({ authenticated: false, lastError: `Sign-in to cloud backup failed (${res.status})` })
      return false
    }
    const data = await res.json()
    setToken(data.token)
    saveSession()
    setState({ authenticated: true, lastError: null })
    return true
  } catch {
    setState({ authenticated: false, online: false, lastError: 'Cloud backup unreachable' })
    return false
  }
}

/** Milliseconds until the saved cloud token expires (0 if unreadable or already expired). */
function tokenLifeMs(t: string): number {
  try {
    const exp = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp as number
    return Math.max(0, exp * 1000 - Date.now())
  } catch {
    return 0
  }
}

/**
 * A counter left open all day would otherwise lose its cloud connection when the token expires (12 hours) —
 * after which nothing uploads. While the token is still valid, quietly swap it for a fresh one.
 */
async function refreshTokenIfNeeded(): Promise<void> {
  if (!creds || !token || !navigator.onLine) return
  if (tokenLifeMs(token) > 3 * 3_600_000) return
  try {
    const res = await fetch(`${creds.apiUrl}/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return
    const data = await res.json() as { token?: string }
    if (data.token) { setToken(data.token); saveSession() }
  } catch { /* offline right now — try again next tick */ }
}

/** True when this device is signed in to the cloud and online, so a backup upload can go through. */
export function isCloudReady(): boolean {
  return !!creds && !!token && navigator.onLine
}

/** An authenticated call to the cloud API (re-signs in once if the token was rejected). Throws if not connected. */
export async function cloudRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!creds) throw new Error('Not connected to the cloud')
  if (!token && !(await authenticate())) throw new Error(state.lastError ?? 'Not signed in to the cloud')
  const go = () => fetch(`${creds!.apiUrl}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } })
  let res = await go()
  if (res.status === 401 && (await authenticate())) res = await go()
  return res
}

/** Push everything waiting right now (the "Sync now" button). */
export async function syncNow(): Promise<SyncState> {
  await refreshTokenIfNeeded()
  await flush()
  return getSyncState()
}

const ENDPOINT: Record<SyncEntity, { method: string; path: string | ((p: Record<string, unknown>) => string) }> = {
  bill: { method: 'POST', path: '/bills' },
  billReturn: { method: 'POST', path: (p) => `/bills/${p.refundOfBillId}/return` },
  customer: { method: 'POST', path: '/customers' },
  customerUpdate: { method: 'PUT', path: (p) => `/customers/${p.id}` },
  product: { method: 'POST', path: '/products' },
  productUpdate: { method: 'PUT', path: (p) => `/products/${p.id}` },
  variant: { method: 'POST', path: '/variants' },
  variantUpdate: { method: 'PUT', path: (p) => `/variants/${p.id}` },
  expense: { method: 'POST', path: '/expenses' },
  stockAdjust: { method: 'POST', path: '/stock/adjust' },
  storeUpdate: { method: 'PUT', path: '/store' },
  user: { method: 'POST', path: '/users' },
  userUpdate: { method: 'PUT', path: (p) => `/users/${p.id}` },
  supplier: { method: 'POST', path: '/suppliers' },
  supplierUpdate: { method: 'PUT', path: (p) => `/suppliers/${p.id}` },
  purchase: { method: 'POST', path: '/purchases' },
  session: { method: 'POST', path: '/sessions' },
  sessionUpdate: { method: 'PUT', path: (p) => `/sessions/${p.id}` },
  // Dairy. Every record carries its client-generated id, which is also its idempotency key: a retried upload that
  // already landed answers 409 and is treated as done (see flush below).
  farmer: { method: 'POST', path: '/dairy/farmers' },
  farmerUpdate: { method: 'PUT', path: (p) => `/dairy/farmers/${p.id}` },
  rateChart: { method: 'POST', path: '/dairy/rate-charts' },
  collection: { method: 'POST', path: '/dairy/collections' },
  collectionDecision: { method: 'POST', path: (p) => `/dairy/collections/${p.id}/decision` },
  ledgerEntry: { method: 'POST', path: '/dairy/farmer-ledger' },
  settlement: { method: 'POST', path: '/dairy/settlements' },
  lot: { method: 'POST', path: '/dairy/lots' },
  batch: { method: 'POST', path: '/dairy/production/batches' },
  batchComplete: { method: 'POST', path: (p) => `/dairy/production/batches/${p.id}/complete` },
  delivery: { method: 'POST', path: '/dairy/deliveries' },
  deliveryUpdate: { method: 'PUT', path: (p) => `/dairy/deliveries/${p.id}` },
  wastage: { method: 'POST', path: '/dairy/wastage' },
  wastageDecision: { method: 'POST', path: (p) => `/dairy/wastage/${p.id}/decision` },
}

/** Statuses that mean "this exact request will never be accepted" (as opposed to a server hiccup, rate limit or expired sign-in). */
const PERMANENT = new Set([400, 403, 404, 405, 410, 413, 422])
/** A permanently-refused change is retried this many times before it is set aside. */
const MAX_ATTEMPTS = 3

/** A staff PIN only has to sit in the queue until the server has it. */
function withoutPin(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('pin' in payload)) return payload
  const { pin: _pin, ...rest } = payload as Record<string, unknown>
  return rest
}

/** Puts every set-aside change back in the queue (the "Retry" button, after the cause has been fixed). */
export async function retryRejected(): Promise<void> {
  await db.outbox.where('synced').equals(2).modify({ synced: 0, attempts: 0 })
  await flush()
}

/**
 * Pushes queued rows to the backend in order — a product must arrive before
 * its variants, an item's variant before the bill that sells it. A server
 * hiccup, lost connection or expired sign-in stops the queue right there so
 * nothing is skipped or reordered; it picks up again on the next tick. A
 * change the server refuses for good (bad data) is retried a few times and
 * then set aside (synced = 2) so one bad row cannot hold up every sale behind
 * it — it stays visible in the safety banner and can be retried. Single-device
 * model: no conflict resolution here, just "eventually everything that
 * happened locally reaches the server," which is all a single writer needs.
 */
export async function flush(): Promise<void> {
  if (flushing || !creds) return
  if (!navigator.onLine) { setState({ online: false }); return }

  flushing = true
  try {
    if (!token && !(await authenticate())) return

    for (;;) {
      const batch = await db.outbox.where('synced').equals(0).sortBy('id')
      setState({
        pending: batch.length, online: true, oldestPendingAt: batch[0]?.createdAt ?? null,
        rejected: await db.outbox.where('synced').equals(2).count(),
      })
      if (!batch.length) break

      const entry = batch[0]
      const def = ENDPOINT[entry.entity]
      const path = typeof def.path === 'function' ? def.path(entry.payload as Record<string, unknown>) : def.path

      let res: Response
      try {
        res = await fetch(`${creds.apiUrl}${path}`, {
          method: def.method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(entry.payload),
        })
      } catch {
        setState({ online: false, lastError: 'Cloud backup unreachable' })
        break
      }

      if (res.status === 401) {
        // Token expired mid-session — re-authenticate once and retry this same entry.
        if (await authenticate()) continue
        break
      }

      if (!res.ok && res.status !== 409) {
        // 409 (already exists) is treated as success below — a retried
        // entry from a previous partial flush shouldn't jam the queue
        // forever.
        const body = await res.text().catch(() => '')
        const attempts = entry.attempts + 1
        const lastError = `${res.status} ${body}`.slice(0, 300)
        if (PERMANENT.has(res.status) && attempts >= MAX_ATTEMPTS) {
          await db.outbox.update(entry.id!, { synced: 2, attempts, lastError })
          setState({ lastError: `A ${entry.entity} change was refused by the cloud (${res.status}) and set aside` })
          continue
        }
        // Anything else (server error, rate limit, or a refusal still being retried) stops here so order is preserved.
        await db.outbox.update(entry.id!, { attempts, lastError })
        setState({ lastError: `Sync stalled on ${entry.entity} (${res.status})` })
        break
      }

      await db.outbox.update(entry.id!, { synced: 1, payload: withoutPin(entry.payload) })
      setState({ lastSyncedAt: Date.now(), lastError: null })
    }
  } finally {
    flushing = false
  }
}

let kickTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Called right after a new outbox row is queued. Debounced so a bill that
 * writes several rows in one transaction (or a bulk CSV import) coalesces
 * into a single flush instead of firing once per row.
 */
export function kickSync() {
  if (kickTimer) clearTimeout(kickTimer)
  kickTimer = setTimeout(() => void flush(), 600)
}

/** Starts the background loop — periodic flush plus an immediate one whenever the browser comes back online. */
export function startSyncLoop() {
  if (timer) return
  timer = setInterval(() => { void refreshTokenIfNeeded().then(() => flush()) }, 30_000)
  window.addEventListener('online', () => { setState({ online: true }); void flush() })
  window.addEventListener('offline', () => setState({ online: false }))
}
