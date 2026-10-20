import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { DbService, Queryable, Row } from '../db/db.service'
import { body, num, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'
import { consumeLotsFefo } from './dairy.controller'

const newId = () => randomBytes(12).toString('hex')

export const billRow = (b: Row) => ({
  id: b.id, no: b.no, date: b.date, customerId: b.customer_id, grossMrp: b.gross_mrp, itemDiscount: b.item_discount,
  billDiscountType: b.bill_discount_type, billDiscountValue: b.bill_discount_value, billDiscount: b.bill_discount,
  coupon: b.coupon, subtotal: b.subtotal, taxableTotal: b.taxable_total, cgstTotal: b.cgst_total, sgstTotal: b.sgst_total,
  taxTotal: b.tax_total, roundOff: b.round_off, total: b.total, paid: b.paid, changeDue: b.change_due,
  loyaltyEarned: b.loyalty_earned, loyaltyRedeemed: b.loyalty_redeemed, creditUsed: b.credit_used,
  cashierId: b.cashier_id, status: b.status, refundOfBillId: b.refund_of_bill_id ?? undefined,
  refundAmount: b.refund_amount ?? undefined, notes: b.notes ?? '',
})
export const itemRow = (i: Row) => ({
  variantId: i.variant_id, sku: i.sku, barcode: i.barcode, name: i.name, size: i.size, color: i.color, hsn: i.hsn,
  qty: i.qty, mrp: i.mrp, price: i.price, discountType: i.discount_type, discountValue: i.discount_value,
  discountAmount: i.discount_amount, net: i.net, taxable: i.taxable, taxRate: i.tax_rate, cgst: i.cgst, sgst: i.sgst,
  lineTotal: i.line_total, returnedQty: i.returned_qty, priceOverridden: i.price_overridden,
})
export const payRow = (p: Row) => ({ mode: p.mode, amount: p.amount, ...(p.ref ? { ref: p.ref } : {}) })

/** Attaches items + payments to a set of bill rows with two queries total (not 2 per bill). */
export async function hydrateBills(q: Queryable, bills: Row[]) {
  if (!bills.length) return []
  const ids = bills.map((b) => b.id)
  const items = await q.query('SELECT * FROM bill_items WHERE bill_id = ANY(:ids) ORDER BY id', { ids })
  const pays = await q.query('SELECT * FROM bill_payments WHERE bill_id = ANY(:ids) ORDER BY id', { ids })
  return bills.map((b) => ({
    ...billRow(b),
    items: items.filter((i) => i.bill_id === b.id).map(itemRow),
    payments: pays.filter((p) => p.bill_id === b.id).map(payRow),
  }))
}

/** Shared by a normal sale and a return's credit note: one bill row + its items + its payments. */
async function insertBill(q: Queryable, storeId: string, b: Row) {
  await q.query(
    `INSERT INTO bills (id, store_id, no, date, customer_id, gross_mrp, item_discount, bill_discount_type, bill_discount_value,
       bill_discount, coupon, subtotal, taxable_total, cgst_total, sgst_total, tax_total, round_off, total, paid, change_due,
       loyalty_earned, loyalty_redeemed, credit_used, cashier_id, status, refund_of_bill_id, refund_amount, notes)
     VALUES (:id, :storeId, :no, :date, :customerId, :grossMrp, :itemDiscount, :bdType, :bdValue, :bd, :coupon, :subtotal,
       :taxable, :cgst, :sgst, :tax, :roundOff, :total, :paid, :changeDue, :earned, :redeemed, :creditUsed, :cashierId,
       :status, :refundOf, :refundAmount, :notes)`,
    { id: b.id, storeId, no: b.no, date: b.date, customerId: b.customerId || null, grossMrp: num(b.grossMrp),
      itemDiscount: num(b.itemDiscount), bdType: b.billDiscountType ?? 'amt', bdValue: num(b.billDiscountValue),
      bd: num(b.billDiscount), coupon: b.coupon ?? '', subtotal: num(b.subtotal), taxable: num(b.taxableTotal),
      cgst: num(b.cgstTotal), sgst: num(b.sgstTotal), tax: num(b.taxTotal), roundOff: num(b.roundOff), total: num(b.total),
      paid: num(b.paid), changeDue: num(b.changeDue), earned: num(b.loyaltyEarned), redeemed: num(b.loyaltyRedeemed),
      creditUsed: num(b.creditUsed), cashierId: b.cashierId ?? '', status: b.status, refundOf: b.refundOfBillId ?? null,
      refundAmount: b.refundAmount ?? null, notes: b.notes ?? '' })

  for (const i of b.items as Row[]) {
    await q.query(
      `INSERT INTO bill_items (bill_id, variant_id, sku, barcode, name, size, color, hsn, qty, mrp, price, discount_type,
         discount_value, discount_amount, net, taxable, tax_rate, cgst, sgst, line_total, returned_qty, price_overridden)
       VALUES (:billId, :variantId, :sku, :barcode, :name, :size, :color, :hsn, :qty, :mrp, :price, :dType, :dValue, :dAmount,
         :net, :taxable, :taxRate, :cgst, :sgst, :lineTotal, :returnedQty, :overridden)`,
      { billId: b.id, variantId: i.variantId, sku: i.sku, barcode: i.barcode, name: i.name, size: i.size, color: i.color,
        hsn: i.hsn ?? '', qty: num(i.qty), mrp: num(i.mrp), price: num(i.price), dType: i.discountType ?? 'amt',
        dValue: num(i.discountValue), dAmount: num(i.discountAmount), net: num(i.net), taxable: num(i.taxable),
        taxRate: num(i.taxRate), cgst: num(i.cgst), sgst: num(i.sgst), lineTotal: num(i.lineTotal),
        returnedQty: num(i.returnedQty), overridden: !!i.priceOverridden })
  }
  for (const p of b.payments as Row[]) {
    await q.query('INSERT INTO bill_payments (bill_id, mode, amount, ref) VALUES (:billId, :mode, :amount, :ref)',
      { billId: b.id, mode: p.mode, amount: num(p.amount), ref: p.ref ?? null })
  }
}

const MOVE = `INSERT INTO stock_moves (id, store_id, variant_id, qty, type, ref, reason, at, user_id)
  VALUES (:id, :storeId, :variantId, :qty, :type, :ref, :reason, :at, :userId)`

@Controller('bills')
export class BillsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Auth() c: Claims, @Query('from') from?: string, @Query('to') to?: string) {
    const rows = await this.db.query(
      `SELECT * FROM bills WHERE store_id = :s AND (:from::bigint IS NULL OR date >= :from::bigint)
         AND (:to::bigint IS NULL OR date <= :to::bigint) ORDER BY date DESC LIMIT 1000`,
      { s: c.storeId, from: from || null, to: to || null })
    return hydrateBills(this.db, rows)
  }

  @Get(':id')
  async show(@Auth() c: Claims, @Param('id') id: string) {
    const bill = await this.db.one('SELECT * FROM bills WHERE id = :id AND store_id = :s', { id, s: c.storeId })
    if (!bill) throw new NotFoundException('Bill not found')
    return (await hydrateBills(this.db, [bill]))[0]
  }

  /**
   * Stores a bill exactly as the client computed and printed it — tax/discount
   * math is NOT recomputed here. That matches today's model (the counter's own
   * machine backing itself up); recomputing becomes mandatory the day a third
   * party can write bills.
   */
  @Perm('pos') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'date', 'items', 'payments', 'total', 'status'])
    b.cashierId = b.cashierId || c.sub
    try {
      await this.db.tx(async (q) => {
        await insertBill(q, c.storeId, b)
        if (b.status === 'held') return
        for (const i of b.items as Row[]) {
          await q.query('UPDATE variants SET stock = stock - :qty WHERE id = :id AND store_id = :s', { qty: num(i.qty), id: i.variantId, s: c.storeId })
          await q.query(MOVE, { id: newId(), storeId: c.storeId, variantId: i.variantId, qty: -num(i.qty), type: 'sale',
            ref: b.no, reason: 'Sale', at: b.date, userId: c.sub })
          // Dairy: draw the quantity from the lot that expires first (a refund bill puts nothing back into a lot).
          if (!b.refundOfBillId) await consumeLotsFefo(q, c.storeId, i.variantId as string, num(i.qty), num(b.date, Date.now()))
        }
        if (b.customerId) {
          await q.query(
            `UPDATE customers SET loyalty_points = loyalty_points + :earn - :redeem, store_credit = store_credit - :credit
             WHERE id = :id AND store_id = :s`,
            { earn: num(b.loyaltyEarned), redeem: num(b.loyaltyRedeemed), credit: num(b.creditUsed), id: b.customerId, s: c.storeId })
        }
      })
    } catch (e) { pgToHttp(e, 'Could not save bill', 'Bill already synced') }
    return { ok: true, id: b.id }
  }

  /**
   * Body: the credit-note bill as the client built it (negative totals, status
   * "returned"). Flips stock direction, bumps returned_qty on the original's
   * lines, and refuses to return more than is left on a line (rows are locked
   * so concurrent returns can't both pass the same stale check).
   */
  @Perm('pos') @Post(':id/return')
  async processReturn(@Auth() c: Claims, @Param('id') originalId: string, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'date', 'items', 'payments', 'total'])
    const payments = b.payments as Row[]
    const refundMode = payments[0]?.mode === 'credit' ? 'credit' : 'cash'
    try {
      await this.db.tx(async (q) => {
        // A retried push after a lost response must read as "already done", not as an over-return.
        if (await q.one('SELECT 1 FROM bills WHERE id = :id', { id: b.id })) throw new ConflictException('Return already synced')
        const original = await q.one('SELECT * FROM bills WHERE id = :id AND store_id = :s FOR UPDATE', { id: originalId, s: c.storeId })
        if (!original) throw new Error('Original bill not found')

        for (const i of b.items as Row[]) {
          const row = await q.one('SELECT qty, returned_qty FROM bill_items WHERE bill_id = :b AND variant_id = :v FOR UPDATE',
            { b: originalId, v: i.variantId })
          if (!row) throw new Error(`Variant ${i.variantId} is not on the original bill`)
          const remaining = row.qty - row.returned_qty
          if (num(i.qty) > remaining) throw new Error(`Only ${remaining} of ${i.sku} left to return, asked for ${i.qty}`)
        }

        b.status = 'returned'
        b.refundOfBillId = originalId
        b.refundAmount = Math.abs(num(b.total))
        b.cashierId = b.cashierId || c.sub
        await insertBill(q, c.storeId, b)

        for (const i of b.items as Row[]) {
          await q.query('UPDATE variants SET stock = stock + :qty WHERE id = :id AND store_id = :s', { qty: num(i.qty), id: i.variantId, s: c.storeId })
          await q.query(MOVE, { id: newId(), storeId: c.storeId, variantId: i.variantId, qty: num(i.qty), type: 'return',
            ref: b.no, reason: `Return vs ${original.no}`, at: b.date, userId: c.sub })
          await q.query('UPDATE bill_items SET returned_qty = returned_qty + :qty WHERE bill_id = :b AND variant_id = :v',
            { qty: num(i.qty), b: originalId, v: i.variantId })
        }

        const left = await q.one('SELECT count(*)::int AS n FROM bill_items WHERE bill_id = :id AND returned_qty < qty', { id: originalId })
        await q.query('UPDATE bills SET status = :status WHERE id = :id AND store_id = :s',
          { status: left && left.n === 0 ? 'returned' : 'partial-return', id: originalId, s: c.storeId })

        if (refundMode === 'credit' && original.customer_id) {
          await q.query('UPDATE customers SET store_credit = store_credit + :amt WHERE id = :id AND store_id = :s',
            { amt: b.refundAmount, id: original.customer_id, s: c.storeId })
        }
      })
    } catch (e) { pgToHttp(e, 'Could not process return', 'Return already synced') }
    return { ok: true, id: b.id }
  }
}
