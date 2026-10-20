import { db } from '../db'
import { withSyncPaused } from '../db/syncHooks'

/**
 * Staff PINs are never stored as typed. Each is kept as a salted PBKDF2-SHA-256 hash (`pbkdf2$rounds$salt$hash`),
 * so the local database and the backup files on this computer do not reveal anyone's PIN.
 *
 * Honest limit: a PIN is only 4 digits, so someone who copies the whole database can still try all 10,000 of them
 * offline. The hash stops PINs being read at a glance and stops them being reused on sight — it is not a substitute
 * for locking the PC (Windows password / BitLocker). Guessing at the counter itself is slowed by the lock-out below.
 */

const ROUNDS = 120_000
const enc = new TextEncoder()

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derive(pin: string, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: rounds, hash: 'SHA-256' }, key, 256))
}

export const isHashedPin = (stored: string) => stored.startsWith('pbkdf2$')
/** A PIN saved by an older version of the app, as the plain digits. */
export const isLegacyPin = (stored: string) => /^\d{4}$/.test(stored)

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${ROUNDS}$${toB64(salt)}$${toB64(await derive(pin, salt, ROUNDS))}`
}

/** True when `pin` matches what is stored (a hash, or the plain digits an older version saved). */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (!stored) return false
  if (isLegacyPin(stored)) return pin === stored
  if (!isHashedPin(stored)) return false
  try {
    const [, rounds, salt, hash] = stored.split('$')
    const got = await derive(pin, fromB64(salt), Number(rounds))
    const want = fromB64(hash)
    if (got.length !== want.length) return false
    let diff = 0
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]
    return diff === 0
  } catch {
    return false
  }
}

/**
 * Turns any plain PINs saved by an older version into hashes, and removes PINs left behind in the already-uploaded
 * part of the sync queue. Safe to run on every start.
 */
export async function migrateUserPins(): Promise<void> {
  for (const u of await db.users.toArray()) {
    if (!isLegacyPin(u.pin)) continue
    const pin = await hashPin(u.pin)
    await withSyncPaused(() => db.users.update(u.id, { pin }))
  }
  await db.outbox.where('entity').anyOf('user', 'userUpdate').filter((e) => e.synced === 1).modify((e) => {
    const p = e.payload as Record<string, unknown> | null
    if (p && typeof p === 'object' && 'pin' in p) { const { pin: _pin, ...rest } = p; e.payload = rest }
  })
}

/* ---------------------------------------------------------------- guessing at the counter */

const LOCK_KEY = 'kc_pin_lock'
type Locks = Record<string, { fails: number; until: number }>
const loadLocks = (): Locks => { try { return JSON.parse(localStorage.getItem(LOCK_KEY) ?? '{}') as Locks } catch { return {} } }
const saveLocks = (l: Locks) => { try { localStorage.setItem(LOCK_KEY, JSON.stringify(l)) } catch { /* private mode */ } }

/** Milliseconds this person must still wait before trying again (0 = free to try). */
export function lockedForMs(userId: string): number {
  return Math.max(0, (loadLocks()[userId]?.until ?? 0) - Date.now())
}

/** After 5 wrong PINs in a row the account waits 30 s, then 1 min, 2 min … up to 15 min. */
export function recordPinFailure(userId: string) {
  const locks = loadLocks()
  const fails = (locks[userId]?.fails ?? 0) + 1
  const wait = fails >= 5 ? Math.min(15 * 60_000, 30_000 * 2 ** (fails - 5)) : 0
  locks[userId] = { fails, until: wait ? Date.now() + wait : 0 }
  saveLocks(locks)
}

export function clearPinFailures(userId: string) {
  const locks = loadLocks()
  if (locks[userId]) { delete locks[userId]; saveLocks(locks) }
}

export const waitText = (ms: number) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`)
