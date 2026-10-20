import { db } from './index'

/** True once this device holds a store (settings row). A new device has none and shows the sign-in screen. */
export async function isSeeded(): Promise<boolean> {
  return (await db.settings.count()) > 0
}
