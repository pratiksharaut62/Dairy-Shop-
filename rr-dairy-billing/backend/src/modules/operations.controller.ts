import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { DbService, Row } from '../db/db.service'
import { body, num, partialUpdate, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'

export const moveRow = (m: Row) => ({
  id: m.id, variantId: m.variant_id, qty: m.qty, type: m.type, ref: m.ref, reason: m.reason, at: m.at, userId: m.user_id,
})
export const expenseRow = (e: Row) => ({
  id: e.id, date: e.date, category: e.category, amount: e.amount, mode: e.mode, vendor: e.vendor, note: e.note,
  recurring: e.recurring, userId: e.user_id,
})
export const sessionRow = (s: Row) => ({
  id: s.id, openedAt: s.opened_at, openedBy: s.opened_by, openingCash: s.opening_cash,
  ...(s.closed_at != null ? { closedAt: s.closed_at } : {}), ...(s.closed_by != null ? { closedBy: s.closed_by } : {}),
  ...(s.counted_cash != null ? { countedCash: s.counted_cash } : {}), ...(s.expected_cash != null ? { expectedCash: s.expected_cash } : {}),
  ...(s.variance != null ? { variance: s.variance } : {}), ...(s.note != null ? { note: s.note } : {}),
})
export const purchaseRowsToJson = (purchases: Row[], items: Row[]) => purchases.map((p) => ({
  id: p.id, no: p.no, supplierId: p.supplier_id, date: p.date, invoiceRef: p.invoice_ref, total: p.total, paid: p.paid,
  notes: p.notes ?? '', userId: p.user_id,
  items: items.filter((i) => i.purchase_id === p.id).map((i) => ({ variantId: i.variant_id, qty: i.qty, cost: i.cost })),
}))

const MOVE = `INSERT INTO stock_moves (id, store_id, variant_id, qty, type, ref, reason, at, user_id)
  VALUES (:id, :storeId, :variantId, :qty, :type, :ref, :reason, :at, :userId)`

@Controller('stock')
export class StockController {
  constructor(private readonly db: DbService) {}

  @Perm('stock') @Get('moves')
  async moves(@Auth() c: Claims, @Query('variantId') variantId?: string) {
    const rows = await this.db.query(
      `SELECT * FROM stock_moves WHERE store_id = :s AND (:v::text IS NULL OR variant_id = :v::text) ORDER BY at DESC LIMIT 500`,
      { s: c.storeId, v: variantId || null })
    return rows.map(moveRow)
  }

  /** A signed delta plus a ledger row — mirrors moveStock() in src/db/ops.ts so the two never drift. */
  @Perm('stock') @Post('adjust')
  async adjust(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'variantId', 'qty', 'type', 'at'])
    try {
      await this.db.tx(async (q) => {
        const v = await q.one('SELECT id FROM variants WHERE id = :id AND store_id = :s FOR UPDATE', { id: b.variantId, s: c.storeId })
        if (!v) throw new Error('Unknown variant')
        await q.query(MOVE, { id: b.id, storeId: c.storeId, variantId: b.variantId, qty: num(b.qty), type: b.type,
          ref: b.ref ?? '', reason: b.reason ?? '', at: b.at, userId: c.sub })
        await q.query('UPDATE variants SET stock = stock + :qty WHERE id = :id AND store_id = :s', { qty: num(b.qty), id: b.variantId, s: c.storeId })
      })
    } catch (e) { pgToHttp(e, 'Could not adjust stock', 'Stock movement already synced') }
    return { ok: true }
  }
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly db: DbService) {}

  @Perm('expenses') @Get()
  async list(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM expenses WHERE store_id = :s ORDER BY date DESC LIMIT 1000', { s: c.storeId })).map(expenseRow)
  }

  @Perm('expenses') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'date', 'category', 'amount', 'mode'])
    try {
      await this.db.query(
        `INSERT INTO expenses (id, store_id, date, category, amount, mode, vendor, note, recurring, user_id)
         VALUES (:id, :storeId, :date, :category, :amount, :mode, :vendor, :note, :recurring, :userId)`,
        { id: b.id, storeId: c.storeId, date: b.date, category: b.category, amount: num(b.amount), mode: b.mode,
          vendor: b.vendor ?? '', note: b.note ?? '', recurring: !!b.recurring, userId: c.sub })
    } catch (e) { pgToHttp(e, 'Could not record expense', 'Expense already synced') }
    return { ok: true, id: b.id }
  }
}

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly db: DbService) {}

  @Perm('purchases') @Get()
  async list(@Auth() c: Claims) {
    const purchases = await this.db.query('SELECT * FROM purchases WHERE store_id = :s ORDER BY date DESC LIMIT 500', { s: c.storeId })
    const items = purchases.length
      ? await this.db.query('SELECT * FROM purchase_items WHERE purchase_id = ANY(:ids) ORDER BY id', { ids: purchases.map((p) => p.id) })
      : []
    return purchaseRowsToJson(purchases, items)
  }

  /** Mirrors receivePurchase() in src/db/ops.ts: GRN + lines, stock up, cost updated, one ledger row per line — one transaction. */
  @Perm('purchases') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'supplierId', 'date', 'items'])
    // The client sends userId: '' as often as a real id — never let that reach a NOT NULL column.
    const userId = (b.userId as string) || c.sub
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO purchases (id, store_id, no, supplier_id, date, invoice_ref, total, paid, notes, user_id)
           VALUES (:id, :storeId, :no, :supplierId, :date, :invoiceRef, :total, :paid, :notes, :userId)`,
          { id: b.id, storeId: c.storeId, no: b.no, supplierId: b.supplierId, date: b.date, invoiceRef: b.invoiceRef ?? '',
            total: num(b.total), paid: num(b.paid), notes: b.notes ?? '', userId })
        for (const it of b.items as Row[]) {
          await q.query('INSERT INTO purchase_items (purchase_id, variant_id, qty, cost) VALUES (:p, :v, :qty, :cost)',
            { p: b.id, v: it.variantId, qty: num(it.qty), cost: num(it.cost) })
          await q.query('UPDATE variants SET stock = stock + :qty WHERE id = :id AND store_id = :s', { qty: num(it.qty), id: it.variantId, s: c.storeId })
          if (num(it.cost) > 0) await q.query('UPDATE variants SET cost = :cost WHERE id = :id AND store_id = :s', { cost: num(it.cost), id: it.variantId, s: c.storeId })
          await q.query(MOVE, { id: randomBytes(12).toString('hex'), storeId: c.storeId, variantId: it.variantId, qty: num(it.qty),
            type: 'purchase', ref: b.no, reason: 'Goods received', at: b.date, userId })
        }
      })
    } catch (e) { pgToHttp(e, 'Could not record purchase', 'Purchase already synced') }
    return { ok: true, id: b.id }
  }
}

/** Cash-drawer day-open / day-close (Z-report) sessions. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly db: DbService) {}

  @Perm('reports') @Get()
  async list(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM day_sessions WHERE store_id = :s ORDER BY opened_at DESC LIMIT 200', { s: c.storeId })).map(sessionRow)
  }

  @Perm('reports') @Post()
  async open(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'openedAt'])
    try {
      await this.db.query(
        `INSERT INTO day_sessions (id, store_id, opened_at, opened_by, opening_cash)
         VALUES (:id, :storeId, :openedAt, :openedBy, :openingCash)`,
        { id: b.id, storeId: c.storeId, openedAt: b.openedAt, openedBy: b.openedBy || c.sub, openingCash: num(b.openingCash) })
    } catch (e) { pgToHttp(e, 'Could not open session', 'Session already synced') }
    return { ok: true, id: b.id }
  }

  /** Body carries whatever the day-close wrote locally: closedAt/closedBy/countedCash/expectedCash/variance/note. */
  @Perm('reports') @Put(':id')
  async close(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('day_sessions', body(raw), {
      closedAt: 'closed_at', closedBy: 'closed_by', countedCash: 'counted_cash', expectedCash: 'expected_cash', variance: 'variance', note: 'note',
    }, 'id = :id AND store_id = :storeId', { id, storeId: c.storeId })
    if (u) await this.db.query(u.sql, u.params)
    return { ok: true }
  }
}
