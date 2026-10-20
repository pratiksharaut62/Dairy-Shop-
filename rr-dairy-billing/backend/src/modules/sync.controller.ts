import { Controller, Get } from '@nestjs/common'
import { DbService } from '../db/db.service'
import { Auth, Claims } from '../auth/permissions'
import { storeRow } from './store.controller'
import { productRow, variantRow } from './catalog.controller'
import { customerRow, supplierRow } from './people.controller'
import { hydrateBills } from './bills.controller'
import { batchRow, collectionRow, deliveryRow, farmerRow, ledgerRow, lotRow, rateChartRow, settlementRow, wastageRow } from './dairy.controller'
import { expenseRow, moveRow, purchaseRowsToJson, sessionRow } from './operations.controller'

/**
 * Cloud → device. The sync client already pushes local writes up through its
 * outbox; this is the other direction: a full, consistent snapshot of one store
 * so a new device (or the web app after a web login) can hydrate its local
 * database. Everything is scoped to the caller's store and role-filtered.
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly db: DbService) {}

  @Get('snapshot')
  async snapshot(@Auth() c: Claims) {
    const s = { s: c.storeId }
    const canSee = (perm: 'owner-manager' | 'all') => perm === 'all' || c.role !== 'cashier'

    // One REPEATABLE READ transaction so the snapshot is internally consistent even while bills are being posted.
    return this.db.tx(async (q) => {
      await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const store = await q.one('SELECT * FROM stores WHERE id = :s', s)
      // Sequential on purpose: a single transaction owns a single connection.
      const users = await q.query('SELECT id, name, role, active FROM users WHERE store_id = :s ORDER BY name', s)
      const categories = await q.query('SELECT * FROM categories WHERE store_id = :s', s)
      const products = await q.query('SELECT * FROM products WHERE store_id = :s', s)
      const variants = await q.query('SELECT * FROM variants WHERE store_id = :s', s)
      const customers = await q.query('SELECT * FROM customers WHERE store_id = :s', s)
      const bills = await hydrateBills(q, await q.query('SELECT * FROM bills WHERE store_id = :s ORDER BY date', s))
      const manager = canSee('owner-manager')
      const purchaseRows = manager ? await q.query('SELECT * FROM purchases WHERE store_id = :s ORDER BY date', s) : []
      const purchaseItems = purchaseRows.length
        ? await q.query('SELECT pi.* FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE p.store_id = :s ORDER BY pi.id', s) : []
      return {
        serverTime: Date.now(),
        store: store ? storeRow(store) : null,
        users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active })),
        categories: categories.map((r) => ({ id: r.id, name: r.name, group: r.category_group })),
        products: products.map(productRow),
        variants: variants.map(variantRow),
        customers: customers.map(customerRow),
        bills,
        suppliers: manager ? (await q.query('SELECT * FROM suppliers WHERE store_id = :s', s)).map(supplierRow) : [],
        purchases: purchaseRowsToJson(purchaseRows, purchaseItems),
        moves: manager ? (await q.query('SELECT * FROM stock_moves WHERE store_id = :s ORDER BY at', s)).map(moveRow) : [],
        expenses: manager ? (await q.query('SELECT * FROM expenses WHERE store_id = :s ORDER BY date', s)).map(expenseRow) : [],
        // Dairy — the counter needs farmers, charts, collections, lots and deliveries; money and production stay with managers.
        farmers: (await q.query('SELECT * FROM farmers WHERE store_id = :s', s)).map(farmerRow),
        rateCharts: (await q.query('SELECT * FROM rate_charts WHERE store_id = :s', s)).map(rateChartRow),
        collections: (await q.query('SELECT * FROM milk_collections WHERE store_id = :s ORDER BY date', s)).map(collectionRow),
        lots: (await q.query('SELECT * FROM lots WHERE store_id = :s ORDER BY created_at', s)).map(lotRow),
        deliveries: (await q.query('SELECT * FROM deliveries WHERE store_id = :s ORDER BY scheduled_at', s)).map(deliveryRow),
        ledger: manager ? (await q.query('SELECT * FROM farmer_ledger WHERE store_id = :s ORDER BY at', s)).map(ledgerRow) : [],
        settlements: manager ? (await q.query('SELECT * FROM farmer_settlements WHERE store_id = :s ORDER BY paid_at', s)).map(settlementRow) : [],
        batches: manager ? (await q.query('SELECT * FROM production_batches WHERE store_id = :s ORDER BY started_at', s)).map(batchRow) : [],
        wastage: manager ? (await q.query('SELECT * FROM wastage WHERE store_id = :s ORDER BY at', s)).map(wastageRow) : [],
        sessions: manager ? (await q.query('SELECT * FROM day_sessions WHERE store_id = :s ORDER BY opened_at', s)).map(sessionRow) : [],
      }
    })
  }
}
