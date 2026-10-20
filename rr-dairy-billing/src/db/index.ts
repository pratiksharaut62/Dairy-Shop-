import Dexie, { type Table } from 'dexie'
import { id } from '../lib/id'
import type {
  AuditLog, Bill, Category, Collection, Customer, DaySession, Delivery, Expense, Farmer, LedgerEntry, Lot, OutboxEntry,
  Product, ProductionBatch, Purchase, RateChart, Settlement, StockMove, StoreSettings, Supplier, User, Variant, Wastage,
} from './types'

export class ShopDB extends Dexie {
  settings!: Table<StoreSettings, string>
  users!: Table<User, string>
  categories!: Table<Category, string>
  products!: Table<Product, string>
  variants!: Table<Variant, string>
  suppliers!: Table<Supplier, string>
  purchases!: Table<Purchase, string>
  customers!: Table<Customer, string>
  bills!: Table<Bill, string>
  moves!: Table<StockMove, string>
  expenses!: Table<Expense, string>
  audit!: Table<AuditLog, string>
  sessions!: Table<DaySession, string>
  outbox!: Table<OutboxEntry, number>
  // Dairy
  farmers!: Table<Farmer, string>
  rateCharts!: Table<RateChart, string>
  collections!: Table<Collection, string>
  ledger!: Table<LedgerEntry, string>
  settlements!: Table<Settlement, string>
  lots!: Table<Lot, string>
  batches!: Table<ProductionBatch, string>
  deliveries!: Table<Delivery, string>
  wastage!: Table<Wastage, string>

  constructor() {
    super('rr_dairy_billing')
    this.version(1).stores({
      settings: 'id',
      users: 'id, name, role',
      categories: 'id, name, group',
      products: 'id, styleCode, name, categoryId, brand',
      variants: 'id, productId, sku, barcode, stock',
      suppliers: 'id, name, phone',
      purchases: 'id, no, supplierId, date',
      customers: 'id, phone, name, createdAt',
      bills: 'id, no, date, customerId, status, cashierId',
      moves: 'id, variantId, type, at',
      expenses: 'id, date, category',
      audit: 'id, at, userId',
      sessions: 'id, openedAt',
    })
    // v2 adds the sync outbox and two blank-by-default settings fields
    // (syncApiUrl/syncStoreId) — existing stores upgrade with sync simply
    // off, since there's nothing to fill those in with automatically.
    this.version(2).stores({
      outbox: '++id, synced, entity',
    }).upgrade(async (tx) => {
      const s = await tx.table('settings').get('store')
      if (s && s.syncApiUrl === undefined) {
        await tx.table('settings').update('store', { syncApiUrl: '', syncStoreId: '' })
      }
    })
    // v3 adds printer settings — existing stores default to 'browser' mode,
    // i.e. exactly the print behaviour they already had.
    this.version(3).stores({}).upgrade(async (tx) => {
      const s = await tx.table('settings').get('store')
      if (s && s.printerMode === undefined) {
        await tx.table('settings').update('store', {
          printerMode: 'browser', printerSerialPath: '', printerBaud: 9600, printerHost: '', printerPort: 9100,
        })
      }
    })
    // v4 adds a configurable physical label size (mm) for barcode stickers —
    // existing stores default to 50x38mm, a common landscape tag size, but
    // it's meant to be set to whatever's actually loaded in the printer.
    this.version(4).stores({}).upgrade(async (tx) => {
      const s = await tx.table('settings').get('store')
      if (s && s.labelWidthMm === undefined) {
        await tx.table('settings').update('store', { labelWidthMm: 50, labelHeightMm: 38 })
      }
    })
    // v5 adds side-by-side label rolls (two or more labels per physical
    // row) — existing stores default to a single column, i.e. unchanged
    // behaviour, since that's what every store before this had anyway.
    this.version(5).stores({}).upgrade(async (tx) => {
      const s = await tx.table('settings').get('store')
      if (s && s.labelsAcross === undefined) {
        await tx.table('settings').update('store', { labelsAcross: 1, labelGapMm: 0 })
      }
    })
    // v6 — the dairy tables: farmers and their milk collection, rate charts, the farmer ledger and settlements,
    // lots with expiry, production batches, deliveries and approved wastage.
    this.version(6).stores({
      farmers: 'id, code, name, phone, active',
      rateCharts: 'id, milkType, effectiveFrom',
      collections: 'id, no, farmerId, date, status, session',
      ledger: 'id, farmerId, at, type',
      settlements: 'id, farmerId, paidAt',
      lots: 'id, variantId, expiresAt, source, sourceRef',
      batches: 'id, no, startedAt, status',
      deliveries: 'id, no, scheduledAt, status, customerId',
      wastage: 'id, at, status, variantId',
    })
  }
}

export const db = new ShopDB()

export async function logAudit(userId: string, action: string, detail: string) {
  await db.audit.add({ id: id('log'), at: Date.now(), userId, action, detail })
}

/** Full backup: every table into one JSON blob the owner can re-import. */
export async function exportBackup() {
  const tables = ['settings', 'users', 'categories', 'products', 'variants', 'suppliers',
    'purchases', 'customers', 'bills', 'moves', 'expenses', 'audit', 'sessions',
    'farmers', 'rateCharts', 'collections', 'ledger', 'settlements', 'lots', 'batches', 'deliveries', 'wastage'] as const
  const dump: Record<string, unknown[]> = {}
  for (const t of tables) dump[t] = await (db as never as Record<string, Table>)[t].toArray()
  return { version: 1, exportedAt: Date.now(), data: dump }
}

export async function importBackup(payload: { data: Record<string, unknown[]> }) {
  const tables = Object.keys(payload.data)
  await db.transaction('rw', db.tables, async () => {
    for (const t of tables) {
      const table = db.table(t)
      await table.clear()
      await table.bulkAdd(payload.data[t] as never[])
    }
  })
}
