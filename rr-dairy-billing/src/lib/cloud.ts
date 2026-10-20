import { db } from '../db'
import { withSyncPaused } from '../db/syncHooks'
import type {
  Bill, Category, Collection, Customer, DaySession, Delivery, Expense, Farmer, LedgerEntry, Lot, Product, ProductionBatch,
  Purchase, RateChart, Settlement, StockMove, StoreSettings, Supplier, User, Variant, Wastage,
} from '../db/types'

/** Where the installed desktop app talks to when the build was not given its own address. */
const PRODUCTION_API_URL = 'https://rr-dairy-billing.vercel.app/api'

/** True inside the packaged desktop app (its pages are served from tauri.localhost / tauri://localhost). */
function insideDesktopApp(): boolean {
  if (typeof window === 'undefined') return false
  const { protocol, hostname } = window.location
  return protocol === 'tauri:' || /(^|\.)tauri\.localhost$/.test(hostname) || !!(window as unknown as { isTauri?: boolean }).isTauri
}

/**
 * The server the app signs in to — people are never asked for it. A build can set its own (VITE_API_URL, which is
 * how the hosted site uses its own `/api`); otherwise the installed desktop app uses the production server.
 * Left empty only in local development, where the sign-in screen asks.
 */
export const DEFAULT_API_URL: string = ((import.meta.env.VITE_API_URL ?? '') || (insideDesktopApp() ? PRODUCTION_API_URL : '')).replace(/\/$/, '')

export interface WebLoginResult {
  token: string
  user: { id: string; name: string; role: User['role']; storeId: string }
  store: { id: string; name: string }
}

/** What `GET /sync/snapshot` returns — one consistent copy of a store. */
export interface Snapshot {
  serverTime: number
  store: (Omit<StoreSettings, 'id' | 'syncApiUrl' | 'syncStoreId'> & { id: string; plan: string }) | null
  users: Array<{ id: string; name: string; role: User['role']; active: boolean }>
  categories: Category[]
  products: Product[]
  variants: Variant[]
  customers: Customer[]
  bills: Bill[]
  suppliers: Supplier[]
  purchases: Purchase[]
  moves: StockMove[]
  expenses: Expense[]
  sessions: DaySession[]
  // Dairy — absent when talking to an older server.
  farmers?: Farmer[]
  rateCharts?: RateChart[]
  collections?: Collection[]
  ledger?: LedgerEntry[]
  settlements?: Settlement[]
  lots?: Lot[]
  batches?: ProductionBatch[]
  deliveries?: Delivery[]
  wastage?: Wastage[]
}

export class CloudError extends Error {
  constructor(message: string, readonly status = 0) { super(message) }
}

async function call<T>(apiUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch {
    throw new CloudError('Cannot reach the server — check the internet connection and the API address')
  }
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error
    throw new CloudError(msg ?? `Server error (${res.status})`, res.status)
  }
  return data as T
}

export const webLogin = (apiUrl: string, email: string, password: string) =>
  call<WebLoginResult>(apiUrl, '/auth/web-login', { method: 'POST', body: JSON.stringify({ email, password }) })

export const fetchSnapshot = (apiUrl: string, token: string) =>
  call<Snapshot>(apiUrl, '/sync/snapshot', { headers: { Authorization: `Bearer ${token}` } })

export type PinCheck = 'ok' | 'wrong' | 'locked' | 'offline'

/** Verifies a staff PIN against the server — used when this device doesn't know the PIN yet (staff downloaded from the cloud). */
export async function verifyPinOnline(apiUrl: string, storeId: string, userId: string, pin: string): Promise<PinCheck> {
  try {
    await call(apiUrl, '/auth/login', { method: 'POST', body: JSON.stringify({ storeId, userId, pin }) })
    return 'ok'
  } catch (e) {
    if (!(e instanceof CloudError) || e.status === 0) return 'offline'
    return e.status === 429 ? 'locked' : 'wrong'
  }
}

const DEFAULT_LOCAL: Pick<StoreSettings, 'printerMode' | 'printerSerialPath' | 'printerBaud' | 'printerHost' | 'printerPort'
  | 'labelWidthMm' | 'labelHeightMm' | 'labelsAcross' | 'labelGapMm'> = {
  printerMode: 'browser', printerSerialPath: '', printerBaud: 9600, printerHost: '', printerPort: 9100,
  labelWidthMm: 50, labelHeightMm: 38, labelsAcross: 1, labelGapMm: 0,
}

/**
 * Replaces everything in the local database with a store snapshot. Used only
 * for first-time setup of a device (empty database) — never while there are
 * unsynced local writes, which this would discard.
 */
export async function hydrateFromSnapshot(apiUrl: string, snap: Snapshot) {
  if (!snap.store) throw new CloudError('This account has no store')
  const { id: storeId, plan: _plan, ...store } = snap.store
  const settings: StoreSettings = { ...DEFAULT_LOCAL, ...store, id: 'store', syncApiUrl: apiUrl.replace(/\/$/, ''), syncStoreId: storeId }

  await withSyncPaused(() => db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
    await db.settings.add(settings)
    // PINs never leave the server; '' means "verify online the first time" (see Login).
    await db.users.bulkAdd(snap.users.map((u) => ({ ...u, pin: '' })))
    await db.categories.bulkAdd(snap.categories)
    await db.products.bulkAdd(snap.products)
    await db.variants.bulkAdd(snap.variants)
    await db.customers.bulkAdd(snap.customers)
    await db.bills.bulkAdd(snap.bills)
    await db.suppliers.bulkAdd(snap.suppliers)
    await db.purchases.bulkAdd(snap.purchases)
    await db.moves.bulkAdd(snap.moves)
    await db.expenses.bulkAdd(snap.expenses)
    await db.sessions.bulkAdd(snap.sessions)
    await db.farmers.bulkAdd(snap.farmers ?? [])
    await db.rateCharts.bulkAdd(snap.rateCharts ?? [])
    await db.collections.bulkAdd(snap.collections ?? [])
    await db.ledger.bulkAdd(snap.ledger ?? [])
    await db.settlements.bulkAdd(snap.settlements ?? [])
    await db.lots.bulkAdd(snap.lots ?? [])
    await db.batches.bulkAdd(snap.batches ?? [])
    await db.deliveries.bulkAdd(snap.deliveries ?? [])
    await db.wastage.bulkAdd(snap.wastage ?? [])
  }))
}

/** True when the local database holds writes the server has not acknowledged yet. */
export async function hasUnsyncedWork(): Promise<boolean> {
  return (await db.outbox.where('synced').anyOf(0, 2).count()) > 0
}

/** Adds staff the server knows about but this device doesn't (e.g. hired from another device). Existing local users are left untouched. */
export async function mergeStaffFromCloud(apiUrl: string, storeId: string) {
  const staff = await call<Array<{ id: string; name: string; role: User['role']; active: boolean }>>(
    apiUrl, `/users?storeId=${encodeURIComponent(storeId)}`)
  const have = new Set((await db.users.toArray()).map((u) => u.id))
  const missing = staff.filter((u) => !have.has(u.id)).map((u) => ({ ...u, pin: '' }))
  if (missing.length) await withSyncPaused(() => db.users.bulkAdd(missing))
}
