import Dexie from 'dexie'
import { db } from './index'
import { kickSync } from '../lib/sync'
import { takePlainPin } from './plainPin'
import type { OutboxEntry } from './types'

let installed = false
let paused = false
let suppressStockSync = false

/** Wrap any bulk/demo write (seeding, a full reset) so it never floods the outbox with rows that don't correspond to anything on a real backend. */
export async function withSyncPaused<T>(fn: () => Promise<T>): Promise<T> {
  paused = true
  try {
    return await fn()
  } finally {
    paused = false
  }
}

/**
 * moveStock() (db/ops.ts) bumps a variant's `stock` field for every
 * ledger-backed change — sale, return, purchase, adjust, audit, opening,
 * transfer — and every one of those already has its own move-type-specific
 * sync path that updates stock server-side too (a dedicated endpoint, or
 * POST /stock/adjust). Left unsuppressed, the plain `variants` `updating`
 * hook below would ALSO queue a generic variantUpdate for that same write —
 * not just redundant but actively dangerous, since it carries an *absolute*
 * stock snapshot taken from the local value at write time. Arriving late
 * (outbox order means it can sit behind other entries for a while), it
 * would silently overwrite whatever the server's stock has correctly moved
 * to from other synced activity since. moveStock() wraps its own
 * `db.variants.update()` call in this so that specific write never queues,
 * while any other variant field edit (price, cost, reorder level, a manual
 * SKU/barcode fix) made outside moveStock() still syncs normally.
 */
export async function withStockSyncSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressStockSync = true
  try {
    return await fn()
  } finally {
    suppressStockSync = false
  }
}

/**
 * Queues one outbox row right after the write it describes. NOT in the same
 * IndexedDB transaction as that write — Dexie scopes a transaction to only
 * the tables a call site actually names, and most writes in this app are
 * bare single-table `db.customers.add(x)` calls with no `outbox` in scope,
 * so `transaction.table('outbox')` throws "object store not found" the
 * moment you try it from inside a `creating`/`updating` hook. Getting true
 * same-transaction atomicity would mean adding 'outbox' to the scope of
 * every relevant write across every page — a much bigger change than one
 * file. This is the pragmatic middle ground: the outbox write happens in
 * its own transaction immediately after the original one commits, so the
 * only way to lose an entry is a crash in the few milliseconds between two
 * back-to-back IndexedDB writes — vanishingly rare, and not the kind of
 * thing worth the much larger refactor to close completely.
 */
function queue(entity: OutboxEntry['entity'], payload: unknown) {
  if (paused) return
  // Dexie auto-joins any nested Dexie call into whichever transaction is
  // ambient in the current Promise-continuation zone — including this one,
  // even though it's called through the plain `db` singleton, not
  // `transaction.table(...)`. Since the hook's own transaction was opened
  // scoped to only the table it's writing to, that auto-join is exactly
  // the "object store not found" error from the transaction-based attempt
  // above, just one layer less obvious. Dexie.ignoreTransaction() is the
  // documented escape hatch: it runs the callback with no ambient
  // transaction, so this open a genuinely new one scoped to `outbox`.
  Dexie.ignoreTransaction(() => {
    void db.outbox.add({ entity, payload, createdAt: Date.now(), synced: 0, attempts: 0 })
  })
  kickSync()
}

/**
 * Called once, after the local DB is ready (seeded or not) — never during
 * seedDatabase() itself, which would otherwise queue hundreds of demo rows
 * that don't correspond to anything on a real backend.
 */
export function installSyncHooks() {
  if (installed) return
  installed = true

  // Only finalized bills sync — 'held' bills aren't final, so they're
  // skipped until they become 'paid'. A credit-note bill (status
  // 'returned' + refundOfBillId set) syncs to the dedicated return
  // endpoint instead of the plain create one. 'partial-return' only ever
  // appears on the *original* bill via an update, never as the status of
  // a newly created row, so it's not handled here at all.
  db.bills.hook('creating', function (_primKey, obj) {
    if (obj.status === 'paid') this.onsuccess = () => queue('bill', obj)
    else if (obj.status === 'returned' && obj.refundOfBillId) this.onsuccess = () => queue('billReturn', obj)
  })

  db.customers.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('customer', obj)
  })
  db.customers.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    this.onsuccess = () => queue('customerUpdate', { id: primKey, ...modifications })
  })

  db.products.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('product', obj)
  })
  db.products.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    // Clearing the product's own GST rate (back to the store's price slabs) arrives as `undefined`, which JSON would drop.
    const patch: Record<string, unknown> = { ...modifications }
    if ('taxRate' in patch && patch.taxRate === undefined) patch.taxRate = null
    this.onsuccess = () => queue('productUpdate', { id: primKey, ...patch })
  })

  // Each size/colour cell is its own Dexie write, so it syncs as its own
  // outbox row too — see backend POST /variants, added specifically to
  // match this granularity rather than trying to batch client-side.
  db.variants.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('variant', obj)
  })
  db.variants.hook('updating', function (modifications, primKey) {
    const mods = { ...modifications } as Record<string, unknown>
    if (suppressStockSync) delete mods.stock
    if (!Object.keys(mods).length) return
    this.onsuccess = () => queue('variantUpdate', { id: primKey, ...mods })
  })

  // Staff accounts: the server hashes the PIN itself, so it gets the real digits — but only at the moment one is
  // set or changed (handed over by Settings through takePlainPin). The local copy is a hash and is never uploaded.
  db.users.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => {
      const { pin: _hash, ...rest } = obj
      const pin = takePlainPin(obj.id)
      queue('user', pin ? { ...rest, pin } : rest)
    }
  })
  db.users.hook('updating', function (modifications, primKey) {
    const { pin: hash, ...rest } = modifications as Record<string, unknown>
    if (!Object.keys(rest).length && hash === undefined) return
    this.onsuccess = () => {
      const pin = hash === undefined ? undefined : takePlainPin(primKey as string)
      const payload = { id: primKey, ...rest, ...(pin ? { pin } : {}) }
      if (Object.keys(payload).length > 1) queue('userUpdate', payload)
    }
  })
  // Staff are never hard-deleted server-side (bills reference them) — removing one locally deactivates them there.
  db.users.hook('deleting', function (primKey) {
    this.onsuccess = () => queue('userUpdate', { id: primKey, active: false })
  })

  db.expenses.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('expense', obj)
  })

  db.suppliers.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('supplier', obj)
  })
  db.suppliers.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    this.onsuccess = () => queue('supplierUpdate', { id: primKey, ...modifications })
  })

  db.purchases.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('purchase', obj)
  })

  db.sessions.hook('creating', function (_primKey, obj) {
    this.onsuccess = () => queue('session', obj)
  })
  db.sessions.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    this.onsuccess = () => queue('sessionUpdate', { id: primKey, ...modifications })
  })

  // 'sale', 'return' and 'purchase' moves are already applied server-side
  // inside POST /bills, POST /bills/{id}/return and POST /purchases
  // respectively — the stock change would apply twice if this queued them
  // again too. Every other move type (adjust, audit, opening, transfer)
  // has no other path to the server, so it syncs here.
  db.moves.hook('creating', function (_primKey, obj) {
    // Dairy moves (collection, production, receipt, wastage) are applied by their own server endpoints too.
    if (obj.type === 'opening' || obj.type === 'adjust' || obj.type === 'audit' || obj.type === 'transfer') this.onsuccess = () => queue('stockAdjust', obj)
  })

  /* ── Dairy ──────────────────────────────────────────────────────────────
   * Lots, the farmer ledger's collection/settlement/opening rows and every stock move that a dairy
   * endpoint already applies are DERIVED on the server from the record that caused them (same ids, same
   * arithmetic) — queueing them separately would apply them twice. Only the causing records sync.
   */
  db.farmers.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('farmer', obj) })
  db.farmers.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    this.onsuccess = () => queue('farmerUpdate', { id: primKey, ...modifications })
  })
  db.rateCharts.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('rateChart', obj) })

  db.collections.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('collection', obj) })
  db.collections.hook('updating', function (modifications, primKey) {
    const m = modifications as { status?: string }
    if (m.status !== 'approved' && m.status !== 'rejected') return
    this.onsuccess = () => queue('collectionDecision', { id: primKey, ...modifications })
  })

  // Only advances and deductions are typed in by a person; the other ledger rows are derived server-side.
  db.ledger.hook('creating', function (_primKey, obj) {
    if (obj.type === 'advance' || obj.type === 'deduction') this.onsuccess = () => queue('ledgerEntry', obj)
  })
  db.settlements.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('settlement', obj) })

  // Only a lot received from outside is a record of its own; collection and production lots come with their cause.
  db.lots.hook('creating', function (_primKey, obj) {
    if (obj.source === 'receipt') this.onsuccess = () => queue('lot', obj)
  })

  db.batches.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('batch', obj) })
  db.batches.hook('updating', function (modifications, primKey) {
    const m = modifications as { status?: string }
    if (m.status !== 'completed' && m.status !== 'rejected') return
    this.onsuccess = () => queue('batchComplete', { id: primKey, ...modifications })
  })

  db.deliveries.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('delivery', obj) })
  db.deliveries.hook('updating', function (modifications, primKey) {
    if (!Object.keys(modifications).length) return
    this.onsuccess = () => queue('deliveryUpdate', { id: primKey, ...modifications })
  })

  db.wastage.hook('creating', function (_primKey, obj) { this.onsuccess = () => queue('wastage', obj) })
  db.wastage.hook('updating', function (modifications, primKey) {
    const m = modifications as { status?: string }
    if (m.status !== 'approved' && m.status !== 'rejected') return
    this.onsuccess = () => queue('wastageDecision', { id: primKey, ...modifications })
  })

  db.settings.hook('updating', function (modifications) {
    // syncApiUrl/syncStoreId are local-only connection config, and the
    // printer fields describe hardware plugged into this one counter —
    // neither belongs on the server or should sync back to other devices.
    const { syncApiUrl: _a, syncStoreId: _s, printerMode: _pm, printerSerialPath: _psp,
      printerBaud: _pb, printerHost: _ph, printerPort: _pp, ...rest } = modifications as Record<string, unknown>
    if (!Object.keys(rest).length) return
    this.onsuccess = () => queue('storeUpdate', rest)
  })
}
