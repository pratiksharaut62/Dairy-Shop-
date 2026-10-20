import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { isSeeded } from './db/seed'
import { installSyncHooks } from './db/syncHooks'
import { migrateUserPins } from './lib/pin'
import { configureSync, configureSyncWithToken, getSyncState, onSyncStateChange, restoreSync, startSyncLoop, stopSync, type SyncState } from './lib/sync'
import type { Role, StoreSettings, User } from './db/types'
import { Check, Info, Warning } from './components/icons'

type ToastKind = 'info' | 'ok' | 'err'
interface ToastAction { label: string; run: () => void }
interface Toast { id: number; text: string; kind: ToastKind; action?: ToastAction }

interface AppState {
  ready: boolean
  /** True on a brand-new device: no local data yet, so the app asks the person to sign in to their cloud store. */
  needsSetup: boolean
  finishSetup: () => void
  user: User | null
  users: User[]
  settings: StoreSettings | null
  login: (u: User, pin: string) => void
  /** Web (email + password) sign-in: the server already vouched for this person, so there is no local PIN step. */
  loginWithToken: (userId: string, apiUrl: string, storeId: string, token: string) => void
  sync: SyncState
  logout: () => void
  toast: (text: string, kind?: ToastKind, action?: ToastAction) => void
  can: (perm: Permission) => boolean
}

/** Cashiers run the counter; managers run the floor; the owner sees the money. */
export type Permission =
  | 'pos' | 'inventory' | 'purchases' | 'stock' | 'customers'
  | 'expenses' | 'reports' | 'settings' | 'viewProfit' | 'deleteBill' | 'bigDiscount'
  // Dairy: enter milk collection · approve milk / manage rate charts · production · delivery · pay farmers · record / approve write-offs
  | 'collection' | 'quality' | 'production' | 'delivery' | 'settlement' | 'wastage' | 'approveWastage'

const MATRIX: Record<Role, Permission[]> = {
  owner: ['pos', 'inventory', 'purchases', 'stock', 'customers', 'expenses', 'reports', 'settings', 'viewProfit', 'deleteBill', 'bigDiscount',
    'collection', 'quality', 'production', 'delivery', 'settlement', 'wastage', 'approveWastage'],
  manager: ['pos', 'inventory', 'purchases', 'stock', 'customers', 'expenses', 'reports', 'bigDiscount',
    'collection', 'quality', 'production', 'delivery', 'settlement', 'wastage'],
  cashier: ['pos', 'customers', 'collection', 'delivery'],
}

const Ctx = createContext<AppState | null>(null)

const SESSION_KEY = 'rr_active_user'

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [userId, setUserId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY))
  const [toasts, setToasts] = useState<Toast[]>([])

  const [sync, setSync] = useState<SyncState>(getSyncState())

  useEffect(() => {
    ;(async () => {
      // No automatic demo data: a real client's first launch must never start with someone else's fake shop.
      if (!(await isSeeded())) setNeedsSetup(true)
      installSyncHooks()
      await migrateUserPins().catch((e) => console.error('PIN upgrade failed', e))
      startSyncLoop()
      setReady(true)
    })().catch((e) => {
      console.error(e)
      setReady(true)
    })
  }, [])

  useEffect(() => onSyncStateChange(setSync), [])

  const users = useLiveQuery(() => db.users.toArray(), [], [] as User[]) ?? []
  const settings = useLiveQuery(() => db.settings.get('store'), [], undefined) ?? null
  const user = users.find((u) => u.id === userId) ?? null

  // Reload/restart while signed in: keep background sync alive from the saved token.
  useEffect(() => {
    if (user && settings?.syncApiUrl && settings.syncStoreId) restoreSync(settings.syncApiUrl, settings.syncStoreId)
  }, [user, settings?.syncApiUrl, settings?.syncStoreId])

  const toast = useCallback((text: string, kind: ToastKind = 'info', action?: ToastAction) => {
    const t = { id: Date.now() + Math.random(), text, kind, action }
    setToasts((prev) => [...prev, t])
    // Toasts with a button stay long enough to actually reach it.
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), action ? 6000 : 2600)
  }, [])

  const login = useCallback((u: User, pin: string) => {
    localStorage.setItem(SESSION_KEY, u.id)
    setUserId(u.id)
    if (settings?.syncApiUrl && settings.syncStoreId) {
      void configureSync(settings.syncApiUrl, settings.syncStoreId, u.id, pin)
    }
  }, [settings])

  const loginWithToken = useCallback((id: string, apiUrl: string, storeId: string, token: string) => {
    localStorage.setItem(SESSION_KEY, id)
    setUserId(id)
    void configureSyncWithToken(apiUrl, storeId, token)
  }, [])

  const finishSetup = useCallback(() => setNeedsSetup(false), [])

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setUserId(null)
    stopSync()
  }, [])

  const can = useCallback(
    (perm: Permission) => (user ? MATRIX[user.role].includes(perm) : false),
    [user],
  )

  const value = useMemo<AppState>(
    () => ({ ready, needsSetup, finishSetup, user, users, settings: settings ?? null, login, loginWithToken, logout, toast, can, sync }),
    [ready, needsSetup, finishSetup, user, users, settings, login, loginWithToken, logout, toast, can, sync],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : t.kind === 'ok' ? 'ok' : ''}`}>
            {t.kind === 'ok' ? <Check size={15} /> : t.kind === 'err' ? <Warning size={15} /> : <Info size={15} />}
            {t.text}
            {t.action && (
              <button type="button" className="toast-action"
                onClick={() => { t.action!.run(); setToasts((prev) => prev.filter((x) => x.id !== t.id)) }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside AppProvider')
  return v
}
