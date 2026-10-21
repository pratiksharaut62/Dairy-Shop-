import { db } from './index'
import { withSyncPaused } from './syncHooks'
import { moveStock, nextBarcode, nextInvoiceNo, saveBill } from './ops'
import { addFarmerEntry, completeBatch, createDelivery, createFarmer, createRateChart, createSettlement, receiveLot, saveCollection, startBatch } from './dairy'
import { hashPin } from '../lib/pin'
import { DEFAULT_SLABS } from '../lib/gst'
import { generateGrid } from '../lib/milkRate'
import { skuFor } from '../lib/variantLabel'
import { id } from '../lib/id'
import { DAY } from '../lib/dates'
import { priceCart, type CartLine } from '../lib/cart'
import { DEMO_PINS } from '../lib/demo'
import type { Category, Customer, Payment, PayMode, Product, StoreSettings, User, Variant } from './types'

/** The same category ids the backend provisions, so a device started here can later be linked to a server without remapping. */
export const DAIRY_CATEGORIES: Category[] = [
  { id: 'cat_milk', name: 'Milk', group: 'Milk' }, { id: 'cat_flavmilk', name: 'Flavoured Milk', group: 'Milk' }, { id: 'cat_cream', name: 'Cream', group: 'Milk' },
  { id: 'cat_curd', name: 'Curd', group: 'Cultured' }, { id: 'cat_buttermilk', name: 'Buttermilk & Lassi', group: 'Cultured' },
  { id: 'cat_paneer', name: 'Paneer', group: 'Fats' }, { id: 'cat_cheese', name: 'Cheese', group: 'Fats' },
  { id: 'cat_butter', name: 'Butter', group: 'Fats' }, { id: 'cat_ghee', name: 'Ghee', group: 'Fats' },
  { id: 'cat_sweets', name: 'Sweets', group: 'Sweets & frozen' }, { id: 'cat_icecream', name: 'Ice Cream', group: 'Sweets & frozen' },
  { id: 'cat_other', name: 'Other', group: 'Other' }, { id: 'cat_rawmilk', name: 'Raw Milk', group: 'Raw material' },
]

/** `demoUsers` also adds a manager and a cashier with known PINs — only ever used by the public demo. */
export interface LocalStoreInput { storeName: string; ownerName: string; pin: string; demo: boolean; demoUsers?: boolean }

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
    id: 'store', name: input.storeName.trim(), tagline: 'Fresh from the farm', address: input.demo ? 'Main Road, Wagholi' : '', city: input.demo ? 'Pune' : '', phone: input.demo ? '98765 43210' : '', email: '', gstin: '',
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
      if (input.demoUsers) {
        await db.users.bulkAdd([
          { id: id('usr'), name: 'Sunita Patil', role: 'manager', pin: await hashPin(DEMO_PINS.manager), active: true },
          { id: id('usr'), name: 'Rahul Kamble', role: 'cashier', pin: await hashPin(DEMO_PINS.cashier), active: true },
        ])
      }
      await db.categories.bulkAdd(DAIRY_CATEGORIES)
    })
    if (input.demo) await seedDemo(owner.id)
  })
  return owner
}

type Pack = [size: string, cost: number, mrp: number, price: number, opening: number]
// style, name, category, unit, shelf life (days), GST %, packs. Opening 0 = stock arrives through lots / production below.
const DEMO_PRODUCTS: Array<[string, string, string, string, number, number, Pack[]]> = [
  ['ML-101', 'Toned Milk', 'cat_milk', 'L', 3, 0, [['500 ml', 23, 27, 26, 160], ['1 L', 45, 54, 52, 120]]],
  ['ML-102', 'Full Cream Milk', 'cat_milk', 'L', 3, 0, [['500 ml', 29, 35, 33, 110], ['1 L', 57, 68, 65, 80]]],
  ['FM-101', 'Chocolate Milk', 'cat_flavmilk', 'pcs', 7, 5, [['200 ml', 18, 30, 28, 70]]],
  ['CD-101', 'Fresh Curd', 'cat_curd', 'pcs', 7, 5, [['400 g', 24, 40, 36, 0], ['1 kg', 55, 85, 78, 0]]],
  ['BM-101', 'Masala Buttermilk', 'cat_buttermilk', 'pcs', 5, 5, [['200 ml', 7, 15, 12, 120]]],
  ['PN-101', 'Fresh Paneer', 'cat_paneer', 'kg', 7, 5, [['200 g', 55, 90, 82, 0], ['500 g', 135, 215, 199, 0]]],
  ['CH-101', 'Cheese Slices', 'cat_cheese', 'pcs', 60, 12, [['100 g', 62, 100, 90, 40]]],
  ['BT-101', 'Table Butter', 'cat_butter', 'pcs', 90, 12, [['100 g', 48, 62, 58, 90], ['500 g', 225, 290, 275, 24]]],
  ['GH-101', 'Cow Ghee', 'cat_ghee', 'pcs', 270, 12, [['500 ml', 330, 420, 399, 36], ['1 L', 640, 810, 770, 14]]],
  ['SW-101', 'Milk Peda', 'cat_sweets', 'kg', 7, 5, [['250 g', 95, 150, 140, 30], ['500 g', 185, 290, 270, 16]]],
  ['IC-101', 'Vanilla Ice Cream', 'cat_icecream', 'pcs', 180, 18, [['500 ml', 85, 140, 125, 28]]],
]

// name, village, usual litres per shift, usual fat %
const FARMERS: Array<[string, string, number, number]> = [
  ['Ramesh Pawar', 'Wagholi', 38, 4.6], ['Suresh Jadhav', 'Lohegaon', 26, 4.1], ['Sunita Shinde', 'Kesnand', 18, 3.9],
  ['Ganesh Kale', 'Shikrapur', 30, 4.4], ['Lata More', 'Ranjangaon', 14, 5.0], ['Dattatray Gaikwad', 'Wagholi', 22, 3.8],
]
const CUSTOMERS: Array<[string, string]> = [['Anita Deshmukh', '9822011101'], ['Prakash Joshi', '9822011102'], ['Meera Kulkarni', '9822011103'],
  ['Vikram Bhosale', '9822011104'], ['Sheetal Naik', '9822011105'], ['Hotel Annapurna', '9822011106']]

/** Same numbers every time, so the demo looks the same for every visitor. */
function seeded(seed: number) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647 }

async function seedDemo(userId: string) {
  const now = Date.now()
  const rnd = seeded(20260721)
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)]
  const variants = new Map<string, { v: Variant; name: string; hsn: string; gst: number }>() // "style|size"

  for (const [style, name, categoryId, unit, shelf, gst, packs] of DEMO_PRODUCTS) {
    const p: Product = { id: id('prd'), styleCode: style, name, categoryId, brand: 'Gokul', fabric: '', season: '', hsn: '0401', unit, shelfLifeDays: shelf, taxRate: gst, active: true, createdAt: now - 40 * DAY }
    await db.products.add(p)
    for (const [size, cost, mrp, price, opening] of packs) {
      const v: Variant = { id: id('var'), productId: p.id, sku: skuFor(style, '', size), barcode: await nextBarcode(), size, color: '', cost, mrp, price, stock: opening, reorderLevel: 10 }
      await db.variants.add(v)
      if (opening > 0) await db.moves.add({ id: id('mv'), variantId: v.id, qty: opening, type: 'opening', ref: 'Opening stock', reason: 'Sample data', at: now - 14 * DAY, userId })
      variants.set(`${style}|${size}`, { v, name, hsn: p.hsn, gst })
    }
  }

  // Farmers, a rate chart in force for the whole history, and 12 days of morning + evening collections.
  const farmerIds: string[] = []
  for (const [name, village] of FARMERS) {
    const f = await createFarmer({ code: '', name, phone: `98${String(20000000 + Math.floor(rnd() * 7999999))}`, village, address: '', milkType: 'cow', payoutDetails: '', openingBalance: 0 }, userId)
    farmerIds.push(f.id)
  }
  await createRateChart({
    name: 'Cow milk — standard chart', milkType: 'cow', effectiveFrom: now - 30 * DAY,
    slabs: generateGrid({ fatFrom: 3, fatTo: 6, fatStep: 0.5, snfFrom: 8, snfTo: 9.5, snfStep: 0.5, baseRate: 28, perFatPoint: 0.5, perSnfPoint: 0.3 }),
  }, userId)

  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
  const r1 = (n: number) => Math.round(n * 10) / 10
  const oldLots: string[] = []
  for (let d = 11; d >= 0; d--) {
    for (const [hour, session] of [[7, 'morning'], [18, 'evening']] as const) {
      for (const [i, fid] of farmerIds.entries()) {
        if (rnd() < 0.07) continue // a farmer who skipped this shift
        const at = new Date(now - d * DAY); at.setHours(hour, Math.floor(rnd() * 50), 0, 0)
        if (at.getTime() > now) continue
        const [, , usual, fatBase] = FARMERS[i]
        const c = await saveCollection({
          farmerId: fid, date: at.getTime(), session, milkType: 'cow', qtyL: Math.round(usual * (session === 'morning' ? 1.1 : 0.9) * (0.85 + rnd() * 0.3) * 10) / 10,
          fat: r1(clamp(fatBase + (rnd() - 0.5) * 0.7, 3.2, 5.8)), snf: r1(clamp(8.4 + (rnd() - 0.5) * 0.9, 8.1, 9.3)), note: '',
        }, userId, true)
        if (now - at.getTime() >= DAY - 60_000) oldLots.push(`lot_${c.id}`)
      }
    }
  }
  // Milk older than a day has been processed or dispatched — take it out of stock so only fresh milk is on hand.
  for (const lotId of oldLots) {
    const lot = await db.lots.get(lotId)
    if (!lot || lot.available <= 0) continue
    await moveStock(lot.variantId, -lot.available, 'production', 'Processed', 'Processed / dispatched (sample)', userId)
    await db.lots.update(lotId, { available: 0 })
  }

  // One farmer paid for the last cycle, another has taken an advance.
  await createSettlement({ farmerId: farmerIds[0], from: now - 12 * DAY, to: now - 3 * DAY, paid: 4000, mode: 'upi', ref: 'UPI/2026/0412', notes: 'Cycle payment' }, userId)
  await createSettlement({ farmerId: farmerIds[3], from: now - 12 * DAY, to: now - 3 * DAY, paid: 2500, mode: 'cash', ref: '', notes: 'Cycle payment' }, userId)
  await addFarmerEntry(farmerIds[1], 'advance', 1500, 'Cattle feed advance', userId)
  await addFarmerEntry(farmerIds[4], 'deduction', 300, 'Vet charges', userId)

  // Paneer from the freshest milk.
  const fresh = (await db.lots.where('source').equals('collection').toArray()).filter((l) => l.expiresAt && l.expiresAt > now && l.available > 0)
    .sort((a, b) => b.available - a.available).slice(0, 3)
  const pn5 = variants.get('PN-101|500 g')?.v, pn2 = variants.get('PN-101|200 g')?.v
  if (fresh.length && pn5 && pn2) {
    const b = await startBatch(fresh.map((l) => ({ lotId: l.id, qty: Math.min(14, l.available) })), 'Paneer — vat 1', userId)
    await completeBatch(b.id, [{ variantId: pn5.id, qty: 22 }, { variantId: pn2.id, qty: 30 }], true, 'Firm, good texture', userId)
  }

  // Packaged curd with expiry dates: one fresh, one close to expiry, one already expired.
  const c4 = variants.get('CD-101|400 g')?.v, c1 = variants.get('CD-101|1 kg')?.v
  if (c4 && c1) {
    await receiveLot({ variantId: c4.id, qty: 60, lotNo: 'CURD-A', producedAt: now - DAY, expiresAt: now + 5 * DAY }, userId)
    await receiveLot({ variantId: c1.id, qty: 14, lotNo: 'CURD-B', producedAt: now - 6 * DAY, expiresAt: now + 0.6 * DAY }, userId)
    await receiveLot({ variantId: c4.id, qty: 6, lotNo: 'CURD-OLD', producedAt: now - 9 * DAY, expiresAt: now - 0.5 * DAY }, userId)
  }

  // Customers and two weeks of counter sales.
  const customers: Customer[] = CUSTOMERS.map(([name, phone], i) => ({
    id: id('cus'), name, phone, email: '', dob: '', anniversary: '', address: '', gstin: '', loyaltyPoints: 0, storeCredit: 0, createdAt: now - (20 - i) * DAY, notes: '',
  }))
  await db.customers.bulkAdd(customers)

  const sellable = ['ML-101|500 ml', 'ML-101|500 ml', 'ML-101|1 L', 'ML-102|500 ml', 'ML-102|1 L', 'BM-101|200 ml', 'BM-101|200 ml', 'FM-101|200 ml', 'CD-101|400 g',
    'PN-101|200 g', 'PN-101|500 g', 'BT-101|100 g', 'BT-101|500 g', 'GH-101|500 ml', 'GH-101|1 L', 'SW-101|250 g', 'IC-101|500 ml', 'CH-101|100 g']
  const stamps: number[] = []
  for (let d = 13; d >= 0; d--) {
    const n = d === 0 ? 5 : 2 + Math.floor(rnd() * 4)
    for (let k = 0; k < n; k++) { const t = new Date(now - d * DAY); t.setHours(8 + Math.floor(rnd() * 12), Math.floor(rnd() * 60), 0, 0); if (t.getTime() <= now) stamps.push(t.getTime()) }
  }
  stamps.sort((a, b) => a - b)
  const settings = (await db.settings.get('store'))!
  for (const at of stamps) {
    const lines: CartLine[] = []
    for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
      const hit = variants.get(pick(sellable)); if (!hit || lines.some((l) => l.variantId === hit.v.id)) continue
      const live = await db.variants.get(hit.v.id)
      const qty = 1 + Math.floor(rnd() * 3)
      if (!live || live.stock < qty + 3) continue
      lines.push({ variantId: hit.v.id, productId: hit.v.productId, sku: hit.v.sku, barcode: hit.v.barcode, name: hit.name, size: hit.v.size, color: '', hsn: hit.hsn,
        mrp: hit.v.mrp, price: hit.v.price, qty, stock: live.stock, discountType: 'pct', discountValue: 0, cost: hit.v.cost, taxRate: hit.gst })
    }
    if (!lines.length) continue
    const t = priceCart(lines, 'pct', 0, settings.slabs, settings.priceIncludesTax)
    const r = rnd()
    const mode: PayMode = r < 0.45 ? 'cash' : r < 0.85 ? 'upi' : 'card'
    const payments: Payment[] = [{ mode, amount: t.total }]
    const customer = rnd() < 0.6 ? pick(customers) : null
    await saveBill({
      no: await nextInvoiceNo(), date: at, customerId: customer?.id ?? null, items: t.items, grossMrp: t.grossMrp, itemDiscount: t.itemDiscount,
      billDiscountType: 'pct', billDiscountValue: 0, billDiscount: t.billDiscount, coupon: '', subtotal: t.subtotal, taxableTotal: t.taxableTotal,
      cgstTotal: t.cgstTotal, sgstTotal: t.sgstTotal, taxTotal: t.taxTotal, roundOff: t.roundOff, total: t.total, payments, paid: t.total, changeDue: 0,
      loyaltyEarned: customer ? Math.floor((t.total * settings.loyaltyEarnPct) / 100) : 0, loyaltyRedeemed: 0, creditUsed: 0, cashierId: userId, status: 'paid', notes: '',
    })
  }

  // A few running costs so the profit view has something to subtract.
  for (const [daysAgo, category, amount, vendor] of [[12, 'Rent', 18000, 'Landlord'], [9, 'Electricity', 4200, 'MSEDCL'], [7, 'Transport', 3100, 'Milk van fuel'],
    [4, 'Packaging', 2600, 'Pouch supplier'], [2, 'Salary', 22000, 'Staff']] as Array<[number, string, number, string]>) {
    await db.expenses.add({ id: id('exp'), date: now - daysAgo * DAY, category, amount, mode: 'cash', vendor, note: '', recurring: false, userId })
  }

  // Deliveries: one out on the road, one packed for tomorrow's round.
  const milk = variants.get('ML-101|500 ml')!.v, curd = variants.get('CD-101|400 g')?.v ?? milk
  await createDelivery({ route: 'Morning route A', vehicle: 'MH-12 AB 1234', driver: 'Sanjay', scheduledAt: now, notes: '', items: [{ variantId: milk.id, name: 'Toned Milk 500 ml', qty: 40, deliveredQty: 0 }] }, userId)
  await createDelivery({ customerId: customers[5].id, route: 'Hotel supply', vehicle: 'MH-12 CD 5678', driver: 'Ajay', scheduledAt: now + DAY, notes: 'Daily hotel order', items: [{ variantId: curd.id, name: 'Fresh Curd 400 g', qty: 24, deliveredQty: 0 }, { variantId: milk.id, name: 'Toned Milk 500 ml', qty: 30, deliveredQty: 0 }] }, userId)
}

/** Wipes this browser's copy of the demo; the page reloads and builds a fresh sample dairy. */
export async function resetDemo(): Promise<void> {
  await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear() })
  window.location.reload()
}
