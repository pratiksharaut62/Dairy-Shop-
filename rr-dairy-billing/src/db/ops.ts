import { db, logAudit } from './index'
import { withStockSyncSuppressed, withSyncPaused } from './syncHooks'
import type { Bill, MoveType, Purchase, StoreSettings, Variant } from './types'
import { id, pad } from '../lib/id'
import { round2 } from '../lib/money'
import { makeBarcode } from '../lib/barcode'
import { consumeLotsFEFO, expiredQty } from './dairy'

export async function getSettings(): Promise<StoreSettings> {
  const s = await db.settings.get('store')
  if (!s) throw new Error('Store is not set up yet.')
  return s
}

/**
 * Every stock change goes through here so the ledger and the on-hand
 * number never drift. The `stock` write itself is sync-suppressed — every
 * move type already has its own server-side path that applies the same
 * change (see withStockSyncSuppressed's own comment in syncHooks.ts for
 * why that matters, not just why it's redundant).
 */
export async function moveStock(
  variantId: string, qty: number, type: MoveType, ref: string, reason: string, userId: string,
) {
  await db.transaction('rw', db.variants, db.moves, async () => {
    const v = await db.variants.get(variantId)
    if (!v) return
    await withStockSyncSuppressed(() => db.variants.update(variantId, { stock: v.stock + qty }))
    await db.moves.add({ id: id('mv'), variantId, qty, type, ref, reason, at: Date.now(), userId })
  })
}

export async function nextInvoiceNo(): Promise<string> {
  const s = await getSettings()
  const no = `${s.invoicePrefix}${pad(s.nextInvoiceNo, 4)}`
  await db.settings.update('store', { nextInvoiceNo: s.nextInvoiceNo + 1 })
  return no
}

export async function nextBarcode(): Promise<string> {
  const count = await db.variants.count()
  let n = count + 1
  // Skip any code already in use (re-imports, deleted variants).
  for (;;) {
    const code = makeBarcode(n)
    const clash = await db.variants.where('barcode').equals(code).first()
    if (!clash) return code
    n++
  }
}

export interface SaveBillInput extends Omit<Bill, 'id'> {}

export async function saveBill(input: SaveBillInput): Promise<Bill> {
  const bill: Bill = { ...input, id: id('bill') }

  // Dairy: expired lots are on the shelf but not sellable — stop the sale and point at the write-off.
  if (bill.status !== 'held' && !bill.refundOfBillId) {
    const wanted = new Map<string, number>()
    for (const item of bill.items) wanted.set(item.variantId, (wanted.get(item.variantId) ?? 0) + item.qty)
    for (const [variantId, qty] of wanted) {
      const [v, expired] = await Promise.all([db.variants.get(variantId), expiredQty(variantId)])
      if (v && expired > 0 && qty > v.stock - expired) {
        const name = bill.items.find((i) => i.variantId === variantId)?.name ?? 'An item'
        throw new Error(`${name}: ${expired} in stock has expired and cannot be sold. Write it off in Wastage first.`)
      }
    }
  }

  await db.bills.add(bill)

  if (bill.status !== 'held') {
    for (const item of bill.items) {
      await moveStock(item.variantId, -item.qty, 'sale', bill.no, 'Sale', bill.cashierId)
      if (!bill.refundOfBillId) await consumeLotsFEFO(item.variantId, item.qty)
    }
    if (bill.customerId) {
      const c = await db.customers.get(bill.customerId)
      if (c) {
        await db.customers.update(c.id, {
          loyaltyPoints: round2(c.loyaltyPoints + bill.loyaltyEarned - bill.loyaltyRedeemed),
          storeCredit: round2(c.storeCredit - bill.creditUsed),
        })
      }
    }
    await logAudit(bill.cashierId, 'BILL_CREATE', `${bill.no} — ₹${bill.total}`)
  }
  return bill
}

export async function deleteHeldBill(billId: string, userId: string) {
  const b = await db.bills.get(billId)
  if (!b || b.status !== 'held') return
  await db.bills.delete(billId)
  await logAudit(userId, 'HELD_BILL_DISCARD', b.no)
}

export interface ReturnLine { variantId: string; qty: number }

/**
 * Returns items against an existing bill: puts stock back, creates a negative
 * "credit note" bill, and refunds as cash or store credit.
 */
export async function processReturn(
  originalId: string,
  lines: ReturnLine[],
  refundMode: 'cash' | 'credit',
  userId: string,
): Promise<Bill> {
  const original = await db.bills.get(originalId)
  if (!original) throw new Error('Original bill not found.')

  const returned = original.items
    .map((it) => {
      const l = lines.find((x) => x.variantId === it.variantId)
      if (!l || l.qty <= 0) return null
      const qty = Math.min(l.qty, it.qty - it.returnedQty)
      if (qty <= 0) return null
      const factor = qty / it.qty
      return {
        ...it,
        qty,
        discountAmount: round2(it.discountAmount * factor),
        net: round2(it.net * factor),
        taxable: round2(it.taxable * factor),
        cgst: round2(it.cgst * factor),
        sgst: round2(it.sgst * factor),
        lineTotal: round2(it.lineTotal * factor),
        returnedQty: 0,
      }
    })
    .filter(Boolean) as Bill['items']

  if (!returned.length) throw new Error('Nothing selected to return.')

  const refund = round2(returned.reduce((s, i) => s + i.lineTotal, 0))
  const no = await nextInvoiceNo()
  const creditNote: Bill = {
    id: id('bill'),
    no: `CN-${no}`,
    date: Date.now(),
    customerId: original.customerId,
    items: returned,
    grossMrp: round2(returned.reduce((s, i) => s + i.mrp * i.qty, 0)),
    itemDiscount: round2(returned.reduce((s, i) => s + i.discountAmount, 0)),
    billDiscountType: 'amt',
    billDiscountValue: 0,
    billDiscount: 0,
    coupon: '',
    subtotal: refund,
    taxableTotal: round2(returned.reduce((s, i) => s + i.taxable, 0)),
    cgstTotal: round2(returned.reduce((s, i) => s + i.cgst, 0)),
    sgstTotal: round2(returned.reduce((s, i) => s + i.sgst, 0)),
    taxTotal: round2(returned.reduce((s, i) => s + i.cgst + i.sgst, 0)),
    roundOff: 0,
    total: -refund,
    payments: [{ mode: refundMode === 'cash' ? 'cash' : 'credit', amount: -refund }],
    paid: -refund,
    changeDue: 0,
    loyaltyEarned: 0,
    loyaltyRedeemed: 0,
    creditUsed: 0,
    cashierId: userId,
    status: 'returned',
    refundOfBillId: original.id,
    refundAmount: refund,
    notes: `Return against ${original.no}`,
  }

  await db.bills.add(creditNote)

  const updatedItems = original.items.map((it) => {
    const r = returned.find((x) => x.variantId === it.variantId)
    return r ? { ...it, returnedQty: it.returnedQty + r.qty } : it
  })
  const fullyReturned = updatedItems.every((it) => it.returnedQty >= it.qty)
  await db.bills.update(original.id, {
    items: updatedItems,
    status: fullyReturned ? 'returned' : 'partial-return',
  })

  for (const r of returned) {
    await moveStock(r.variantId, r.qty, 'return', creditNote.no, `Return vs ${original.no}`, userId)
  }

  if (refundMode === 'credit' && original.customerId) {
    const c = await db.customers.get(original.customerId)
    if (c) await db.customers.update(c.id, { storeCredit: round2(c.storeCredit + refund) })
  }

  await logAudit(userId, 'RETURN', `${creditNote.no} — refund ₹${refund} (${refundMode})`)
  return creditNote
}

export async function receivePurchase(p: Omit<Purchase, 'id' | 'no'>, userId: string) {
  const count = await db.purchases.count()
  // The GRN form never asks who's receiving stock — it's always whoever is
  // logged in — so `p.userId` is just an empty placeholder here, not the
  // real value; the caller's userId is the one that actually matters.
  const purchase: Purchase = { ...p, id: id('po'), no: `GRN-${pad(count + 1, 4)}`, userId }
  await db.purchases.add(purchase)
  for (const it of purchase.items) {
    await moveStock(it.variantId, it.qty, 'purchase', purchase.no, 'Goods received', userId)
    const v = await db.variants.get(it.variantId)
    if (v && it.cost > 0 && it.cost !== v.cost) await db.variants.update(v.id, { cost: it.cost })
  }
  await logAudit(userId, 'PURCHASE', `${purchase.no} — ₹${purchase.total}`)
  return purchase
}

export interface VariantView extends Variant {
  productName: string
  styleCode: string
  brand: string
  hsn: string
  categoryId: string
  unit: string
  taxRate?: number
}

/** Joins variants to their product — the shape every screen actually needs. */
export async function loadVariantViews(): Promise<VariantView[]> {
  const [variants, products] = await Promise.all([db.variants.toArray(), db.products.toArray()])
  const pmap = new Map(products.map((p) => [p.id, p]))
  // Archived products stay in history but drop out of every list used for selling and stock work.
  return variants.filter((v) => pmap.get(v.productId)?.active !== false).map((v) => {
    const p = pmap.get(v.productId)
    return {
      ...v,
      productName: p?.name ?? 'Unknown item',
      styleCode: p?.styleCode ?? '',
      brand: p?.brand ?? '',
      hsn: p?.hsn ?? '',
      categoryId: p?.categoryId ?? '',
      unit: p?.unit ?? '',
      taxRate: p?.taxRate,
    }
  })
}

export async function findByBarcode(code: string): Promise<VariantView | null> {
  const v = await db.variants.where('barcode').equals(code.trim()).first()
    ?? await db.variants.where('sku').equals(code.trim().toUpperCase()).first()
  if (!v) return null
  const p = await db.products.get(v.productId)
  return {
    ...v,
    productName: p?.name ?? 'Unknown item',
    styleCode: p?.styleCode ?? '',
    brand: p?.brand ?? '',
    hsn: p?.hsn ?? '',
    categoryId: p?.categoryId ?? '',
    unit: p?.unit ?? '',
    taxRate: p?.taxRate,
  }
}

/**
 * Deletes every customer and bill (sales and returns) on this device and puts the sold stock back, then restarts
 * invoice numbering at 1. Used to clear test data. Runs with sync paused so nothing is queued for upload, and the
 * rows still waiting in the outbox for the deleted records are dropped so they can't recreate them in the cloud.
 */
export async function clearSalesData(): Promise<{ bills: number; customers: number }> {
  return withSyncPaused(() => db.transaction('rw', [db.bills, db.customers, db.moves, db.variants, db.settings, db.outbox], async () => {
    const sold = await db.moves.where('type').anyOf('sale', 'return').toArray()
    const back = new Map<string, number>()
    for (const m of sold) back.set(m.variantId, (back.get(m.variantId) ?? 0) + m.qty)
    for (const [variantId, qty] of back) {
      const v = await db.variants.get(variantId)
      if (v) await db.variants.update(variantId, { stock: v.stock - qty })
    }
    await db.moves.bulkDelete(sold.map((m) => m.id))
    const bills = await db.bills.count()
    const customers = await db.customers.count()
    await db.bills.clear()
    await db.customers.clear()
    await db.outbox.where('entity').anyOf('bill', 'billReturn', 'customer', 'customerUpdate').delete()
    await db.settings.update('store', { nextInvoiceNo: 1 })
    return { bills, customers }
  }))
}
