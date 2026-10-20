import { randomBytes } from 'crypto'
import * as bcrypt from 'bcryptjs'
import type { Queryable } from './db/db.service'

/** Same ids as the frontend's built-in category list (src/db/seed.ts) so the client's idempotent category push lines up. */
export const DEFAULT_CATEGORIES = [
  ['cat_milk', 'Milk', 'Milk'], ['cat_flavmilk', 'Flavoured Milk', 'Milk'], ['cat_cream', 'Cream', 'Milk'],
  ['cat_curd', 'Curd', 'Cultured'], ['cat_buttermilk', 'Buttermilk & Lassi', 'Cultured'],
  ['cat_paneer', 'Paneer', 'Fats'], ['cat_cheese', 'Cheese', 'Fats'], ['cat_butter', 'Butter', 'Fats'], ['cat_ghee', 'Ghee', 'Fats'],
  ['cat_sweets', 'Sweets', 'Sweets & frozen'], ['cat_icecream', 'Ice Cream', 'Sweets & frozen'],
  ['cat_other', 'Other', 'Other'], ['cat_rawmilk', 'Raw Milk', 'Raw material'],
] as const

export interface ProvisionInput {
  storeName: string
  ownerName: string
  ownerEmail: string
  password: string
  pin: string
  storeId?: string
  gstin?: string
  city?: string
  phone?: string
}

/** Creates one client's store, its owner login (PIN for the counter, email+password for the web) and the default categories. */
export async function provisionStore(q: Queryable, input: ProvisionInput) {
  if (!/^\d{4}$/.test(input.pin)) throw new Error('PIN must be exactly 4 digits')
  if (input.password.length < 8) throw new Error('Password must be at least 8 characters')
  const storeId = input.storeId ?? `store_${randomBytes(5).toString('hex')}`
  const ownerId = `usr_${randomBytes(5).toString('hex')}`

  await q.query(
    `INSERT INTO stores (id, name, gstin, city, phone, email, return_policy, footer_note, loyalty_earn_pct, loyalty_redeem_value, plan)
     VALUES (:id, :name, :gstin, :city, :phone, :email,
       'Dairy products can be returned only if unopened, within the printed expiry and with the bill. Chilled items need the cold chain kept.',
       'Thank you! Fresh from the farm — visit again.', 1, 1, 'active')`,
    { id: storeId, name: input.storeName, gstin: input.gstin ?? '', city: input.city ?? '', phone: input.phone ?? '', email: input.ownerEmail })
  await q.query(
    `INSERT INTO users (id, store_id, name, role, pin_hash, email, password_hash) VALUES (:id, :storeId, :name, 'owner', :pin, :email, :pass)`,
    { id: ownerId, storeId, name: input.ownerName, pin: await bcrypt.hash(input.pin, 10), email: input.ownerEmail, pass: await bcrypt.hash(input.password, 10) })
  for (const [id, name, group] of DEFAULT_CATEGORIES) {
    await q.query('INSERT INTO categories (id, store_id, name, category_group) VALUES (:id, :storeId, :name, :grp)', { id, storeId, name, grp: group })
  }
  return { storeId, ownerId }
}
