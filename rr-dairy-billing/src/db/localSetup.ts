import { db } from './index'
import { withSyncPaused } from './syncHooks'
import { nextBarcode } from './ops'
import { addFarmerEntry, completeBatch, createDelivery, createFarmer, createRateChart, receiveLot, saveCollection, startBatch } from './dairy'
import { hashPin } from '../lib/pin'
import { DEFAULT_SLABS } from '../lib/gst'
import { generateGrid } from '../lib/milkRate'
import { skuFor } from '../lib/variantLabel'
import { id } from '../lib/id'
import { DAY } from '../lib/dates'
import type { Category, Product, StoreSettings, User, Variant } from './types'

/** The same category ids the backend provisions, so a device started here can later be linked to a server without remapping. */
export const DAIRY_CATEGORIES: Category[] = [
  { id: 'cat_milk', name: 'Milk', group: 'Milk' }, { id: 'cat_flavmilk', name: 'Flavoured Milk', group: 'Milk' }, { id: 'cat_cream', name: 'Cream', group: 'Milk' },
  { id: 'cat_curd', name: 'Curd', group: 'Cultured' }, { id: 'cat_buttermilk', name: 'Buttermilk & Lassi', group: 'Cultured' },
  { id: 'cat_paneer', name: 'Paneer', group: 'Fats' }, { id: 'cat_cheese', name: 'Cheese', group: 'Fats' },
  { id: 'cat_butter', name: 'Butter', group: 'Fats' }, { id: 'cat_ghee', name: 'Ghee', group: 'Fats' },
  { id: 'cat_sweets', name: 'Sweets', group: 'Sweets & frozen' }, { id: 'cat_icecream', name: 'Ice Cream', group: 'Sweets & frozen' },
  { id: 'cat_other', name: 'Other', group: 'Other' }, { id: 'cat_rawmilk', name: 'Raw Milk', group: 'Raw material' },
]

export interface LocalStoreInput { storeName: string; ownerName: string; pin: string; demo: boolean }

/**
 * Starts a store on this device alone — no server, no sign-in. Everything works offline exactly as it does for a
 * cloud-linked store; syncApiUrl stays blank, so nothing is uploaded until a server is connected in Settings.
 */
export async function createLocalStore(input: LocalStoreInput): Promise<User> {
  if (!input.storeName.trim()) throw new Error('Enter the shop name.')
  if (!input.ownerName.trim()) throw new Error('Enter the owner name.')
  if (!/^\d{4}$/.test(input.pin)) throw new Error('The PIN must be exactly 4 digits.')

  const owner: User = { id: id('usr'), name: input.ownerName.trim(), role: 'owner', pin: await hashPin(input.pin), active: true }
  const settings: StoreSettings = {
    id: 'store', name: input.storeName.trim(), tagline: 'Fresh from the farm', address: '', city: '', phone: '', email: '', gstin: '',
    invoicePrefix: 'INV-', nextInvoiceNo: 1, slabs: DEFAULT_SLABS, priceIncludesTax: true, receiptWidth: '80mm',
    returnPolicy: 'Dairy products can be returned only if unopened, within the printed expiry and with the bill.',
    footerNote: 'Thank you! Fresh from the farm — visit again.', loyaltyEarnPct: 1, loyaltyRedeemValue: 1, maxCashierDiscountPct: 10, lowStockDefault: 5,
    syncApiUrl: '', syncStoreId: '',
    printerMode: 'browser', printerSerialPath: '', printerBaud: 9600, printerHost: '', printerPort: 9100,
    labelWidthMm: 50, labelHeightMm: 38, labelsAcross: 1, labelGapMm: 0,
  }

  await withSyncPaused(async () => {
    await db.transaction('rw', db.tables, async () => {
      for (const t of db.tables) await t.clear()
      await db.settings.add(settings)
      await db.users.add(owner)
      await db.categories.bulkAdd(DAIRY_CATEGORIES)
    })
    if (input.demo) await seedDemo(owner.id)
  })
  return owner
}

type Pack = [size: string, cost: number, mrp: number, price: number, opening: number]
// style, name, category, unit, shelf life (days), GST %, packs. Opening 0 = stock arrives through lots / production below.
const DEMO_PRODUCTS: Array<[string, string, string, string, number, number, Pack[]]> = [
  ['ML-101', 'Toned Milk', 'cat_milk', 'L', 3, 0, [['500 ml', 23, 27, 26, 60], ['1 L', 45, 54, 52, 40]]],
  ['ML-102', 'Full Cream Milk', 'cat_milk', 'L', 3, 0, [['500 ml', 29, 35, 33, 50], ['1 L', 57, 68, 65, 30]]],
  ['CD-101', 'Fresh Curd', 'cat_curd', 'pcs', 7, 5, [['400 g', 24, 40, 36, 0], ['1 kg', 55, 85, 78, 0]]],
  ['PN-101', 'Fresh Paneer', 'cat_paneer', 'kg', 7, 5, [['200 g', 55, 90, 82, 0], ['500 g', 135, 215, 199, 0]]],
  ['BT-101', 'Table Butter', 'cat_butter', 'pcs', 90, 12, [['100 g', 48, 62, 58, 35], ['500 g', 225, 290, 275, 12]]],
  ['GH-101', 'Cow Ghee', 'cat_ghee', 'pcs', 270, 12, [['500 ml', 330, 420, 399, 20], ['1 L', 640, 810, 770, 4]]],
  ['BM-101', 'Masala Buttermilk', 'cat_buttermilk', 'pcs', 5, 5, [['200 ml', 7, 15, 12, 45]]],
]
const FARMERS: Array<[string, string]> = [['Ramesh Pawar', 'Wagholi'], ['Suresh Jadhav', 'Lohegaon'], ['Sunita Shinde', 'Kesnand'], ['Ganesh Kale', 'Shikrapur'], ['Lata More', 'Ranjangaon']]

async function seedDemo(userId: string) {
  const now = Date.now()
  const variants = new Map<string, Variant>() // "style|size" -> variant

  for (const [style, name, categoryId, unit, shelf, gst, packs] of DEMO_PRODUCTS) {
    const p: Product = { id: id('prd'), styleCode: style, name, categoryId, brand: 'RR Dairy', fabric: '', season: '', hsn: '0401', unit, shelfLifeDays: shelf, taxRate: gst, active: true, createdAt: now }
    await db.products.add(p)
    for (const [size, cost, mrp, price, opening] of packs) {
      const v: Variant = { id: id('var'), productId: p.id, sku: skuFor(style, '', size), barcode: await nextBarcode(), size, color: '', cost, mrp, price, stock: opening, reorderLevel: 8 }
      await db.variants.add(v)
      if (opening > 0) await db.moves.add({ id: id('mv'), variantId: v.id, qty: opening, type: 'opening', ref: 'Opening stock', reason: 'Sample data', at: now, userId })
      variants.set(`${style}|${size}`, v)
    }
  }

  // Farmers and a cow-milk rate chart that took effect ten days ago.
  const farmerIds: string[] = []
  for (const [name, village] of FARMERS) {
    const f = await createFarmer({ code: '', name, phone: '', village, address: '', milkType: 'cow', payoutDetails: '', openingBalance: 0 }, userId).catch(async () => undefined)
    if (f) farmerIds.push(f.id)
  }
  await createRateChart({
    name: 'Cow — sample chart', milkType: 'cow', effectiveFrom: now - 10 * DAY,
    slabs: generateGrid({ fatFrom: 3, fatTo: 6, fatStep: 0.5, snfFrom: 8, snfTo: 9.5, snfStep: 0.5, baseRate: 28, perFatPoint: 0.5, perSnfPoint: 0.3 }),
  }, userId)

  // Milk collected 3 h, 15 h and 27 h ago — the oldest batch has already passed its one-day shelf life, so the expiry alerts have something to show.
  let n = 0
  for (const hoursAgo of [27, 15, 3]) {
    for (const fid of farmerIds) {
      n++
      const at = now - hoursAgo * 3_600_000
      await saveCollection({
        farmerId: fid, date: at, session: new Date(at).getHours() < 14 ? 'morning' : 'evening', milkType: 'cow',
        qtyL: 12 + ((n * 7) % 30), fat: 3.6 + ((n * 3) % 20) / 10, snf: 8.1 + ((n * 2) % 12) / 10, note: '',
      }, userId, true)
    }
  }
  if (farmerIds[0]) await addFarmerEntry(farmerIds[0], 'advance', 500, 'Cattle feed advance', userId)

  // A paneer batch from the fresher milk.
  const fresh = (await db.lots.where('source').equals('collection').toArray()).filter((l) => l.expiresAt && l.expiresAt > now && l.available > 0).slice(0, 3)
  const paneer = variants.get('PN-101|500 g')
  if (fresh.length && paneer) {
    const b = await startBatch(fresh.map((l) => ({ lotId: l.id, qty: Math.min(10, l.available) })), 'Sample paneer batch', userId)
    await completeBatch(b.id, [{ variantId: paneer.id, qty: 18 }, { variantId: variants.get('PN-101|200 g')!.id, qty: 25 }], true, 'Firm, good texture', userId)
  }

  // Packaged curd received with expiry dates: one fresh, one close to expiry, one already expired.
  const curd400 = variants.get('CD-101|400 g'), curd1k = variants.get('CD-101|1 kg')
  if (curd400 && curd1k) {
    await receiveLot({ variantId: curd400.id, qty: 40, lotNo: 'CURD-A', producedAt: now - DAY, expiresAt: now + 5 * DAY }, userId)
    await receiveLot({ variantId: curd1k.id, qty: 12, lotNo: 'CURD-B', producedAt: now - 6 * DAY, expiresAt: now + 0.6 * DAY }, userId)
    await receiveLot({ variantId: curd400.id, qty: 6, lotNo: 'CURD-OLD', producedAt: now - 9 * DAY, expiresAt: now - 0.5 * DAY }, userId)
  }

  await createDelivery({
    route: 'Morning route A', vehicle: 'MH-12 AB 1234', driver: 'Sanjay', scheduledAt: now, notes: 'Sample delivery',
    items: [{ variantId: variants.get('ML-101|500 ml')!.id, name: 'Toned Milk 500 ml', qty: 30, deliveredQty: 0 }],
  }, userId)
}
