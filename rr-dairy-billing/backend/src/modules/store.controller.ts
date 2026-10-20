import { Body, Controller, Get, NotFoundException, Post, Put } from '@nestjs/common'
import { DbService } from '../db/db.service'
import { body, partialUpdate, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'

export function storeRow(s: Record<string, any>) {
  return {
    id: s.id, name: s.name, tagline: s.tagline, address: s.address, city: s.city, phone: s.phone, email: s.email,
    gstin: s.gstin, invoicePrefix: s.invoice_prefix, nextInvoiceNo: s.next_invoice_no, slabs: s.slabs,
    priceIncludesTax: s.price_includes_tax, receiptWidth: s.receipt_width, returnPolicy: s.return_policy,
    footerNote: s.footer_note, loyaltyEarnPct: Number(s.loyalty_earn_pct), loyaltyRedeemValue: Number(s.loyalty_redeem_value),
    maxCashierDiscountPct: Number(s.max_cashier_discount_pct), lowStockDefault: s.low_stock_default, plan: s.plan,
    receiptShowTax: s.receipt_show_tax, receiptShowHsn: s.receipt_show_hsn,
    receiptShowSavings: s.receipt_show_savings, receiptShowLoyalty: s.receipt_show_loyalty,
  }
}

@Controller('store')
export class StoreController {
  constructor(private readonly db: DbService) {}

  @Get()
  async show(@Auth() c: Claims) {
    const s = await this.db.one('SELECT * FROM stores WHERE id = :id', { id: c.storeId })
    if (!s) throw new NotFoundException('Store not found')
    return storeRow(s)
  }

  @Perm('settings') @Put()
  async update(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw)
    const u = partialUpdate('stores', b, {
      name: 'name', tagline: 'tagline', address: 'address', city: 'city', phone: 'phone', email: 'email', gstin: 'gstin',
      invoicePrefix: 'invoice_prefix', nextInvoiceNo: 'next_invoice_no', priceIncludesTax: 'price_includes_tax',
      receiptWidth: 'receipt_width', returnPolicy: 'return_policy', footerNote: 'footer_note',
      loyaltyEarnPct: 'loyalty_earn_pct', loyaltyRedeemValue: 'loyalty_redeem_value',
      maxCashierDiscountPct: 'max_cashier_discount_pct', lowStockDefault: 'low_stock_default', slabs: 'slabs',
      receiptShowTax: 'receipt_show_tax', receiptShowHsn: 'receipt_show_hsn',
      receiptShowSavings: 'receipt_show_savings', receiptShowLoyalty: 'receipt_show_loyalty',
    }, 'id = :id', { id: c.storeId }, { slabs: (v) => JSON.stringify(v) })
    if (u) await this.db.query(u.sql.replace(' WHERE', ', updated_at = now() WHERE'), u.params)
    return this.show(c)
  }

  /**
   * Owner-only wipe of every customer and bill (sales and returns) for this store, e.g. to clear test data before
   * going live. Stock sold or returned through those bills is put back, and the next invoice number restarts at 1.
   */
  @Perm('settings') @Post('clear-sales-data')
  async clearSalesData(@Auth() c: Claims) {
    return this.db.tx(async (q) => {
      await q.query(
        `UPDATE variants v SET stock = v.stock - m.total
           FROM (SELECT variant_id, SUM(qty) AS total FROM stock_moves
                  WHERE store_id = :id AND type IN ('sale','return') GROUP BY variant_id) m
          WHERE v.id = m.variant_id AND v.store_id = :id`, { id: c.storeId })
      await q.query(`DELETE FROM stock_moves WHERE store_id = :id AND type IN ('sale','return')`, { id: c.storeId })
      const bills = await q.query('DELETE FROM bills WHERE store_id = :id RETURNING id', { id: c.storeId })
      const customers = await q.query('DELETE FROM customers WHERE store_id = :id RETURNING id', { id: c.storeId })
      await q.query('UPDATE stores SET next_invoice_no = 1, updated_at = now() WHERE id = :id', { id: c.storeId })
      return { ok: true, bills: bills.length, customers: customers.length }
    })
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly db: DbService) {}

  /** Idempotent upsert — the sync client pushes the whole (static) category list once per login. */
  @Post()
  async upsert(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'name'])
    await this.db.query(
      `INSERT INTO categories (id, store_id, name, category_group) VALUES (:id, :storeId, :name, :grp)
       ON CONFLICT (store_id, id) DO UPDATE SET name = EXCLUDED.name, category_group = EXCLUDED.category_group`,
      { id: b.id, storeId: c.storeId, name: b.name, grp: b.group ?? '' })
    return { ok: true, id: b.id }
  }

  @Get()
  async list(@Auth() c: Claims) {
    const rows = await this.db.query('SELECT * FROM categories WHERE store_id = :s ORDER BY category_group, name', { s: c.storeId })
    return rows.map((r) => ({ id: r.id, name: r.name, group: r.category_group }))
  }
}
