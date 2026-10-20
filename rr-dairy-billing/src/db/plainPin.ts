/**
 * The cloud server wants the real 4 digits (it hashes them itself), but the local database only keeps a hash. The
 * Settings screen hands the typed PIN over here at the moment it is set, and the sync hook (db/syncHooks.ts) picks it
 * up for the one upload that needs it. It lives in memory for seconds and is never written to disk by this module.
 */
const pending = new Map<string, string>()

export function rememberPlainPin(userId: string, pin: string) {
  pending.set(userId, pin)
  setTimeout(() => pending.delete(userId), 60_000)
}

export function takePlainPin(userId: string): string | undefined {
  const pin = pending.get(userId)
  pending.delete(userId)
  return pin
}
