import { db, logAudit } from './index'
import { moveStock, nextBarcode } from './ops'
import { id, pad } from '../lib/id'
import { round2 } from '../lib/money'
import { DAY } from '../lib/dates'
import { FAT_RANGE, MILK_LABEL, SNF_RANGE, quoteMilk, validateSlabs } from '../lib/milkRate'
import type {
  BatchInput, BatchOutput, Collection, CollectionSession, Delivery, DeliveryItem, DeliveryStatus, Farmer, LedgerEntry, Lot,
  MilkType, ProductionBatch, RateChart, RateSlab, Settlement, Variant, Wastage, WastageReason,
} from './types'

/**
 * Dairy business rules, applied to the local (offline-first) database. The server applies the same rules to the
 * same records when they sync (backend/src/modules/dairy.controller.ts) — ids of everything derived from a
 * record (its lot, its ledger row) are built from the record's own id so both sides produce identical rows.
 */

const RAW_CATEGORY = 'cat_rawmilk'
const RAW_CODE: Record<MilkType, string> = { cow: 'RAW-COW', buffalo: 'RAW-BUF', mixed: 'RAW-MIX' }

/* ───────────────────────────── Farmers ───────────────────────────── */

export async function nextFarmerCode(): Promise<string> {
  const all = await db.farmers.toArray()
  let max = 0
  for (const f of all) { const m = /^F-?(\d+)$/i.exec(f.code); if (m) max = Math.max(max, Number(m[1])) }
  return `F-${pad(max + 1, 3)}`
}

export async function createFarmer(d: Omit<Farmer, 'id' | 'createdAt' | 'active'>, userId: string): Promise<Farmer> {
  const code = d.code.trim().toUpperCase() || (await nextFarmerCode())
  if (!d.name.trim()) throw new Error('Farmer name is required.')
  if (!code) throw new Error('Farmer code is required.')
  if (await db.farmers.where('code').equals(code).first()) throw new Error(`Code ${code} is already used by another farmer.`)
  const farmer: Farmer = { ...d, code, name: d.name.trim(), id: id('far'), active: true, createdAt: Date.now() }
  await db.transaction('rw', [db.farmers, db.ledger, db.audit], async () => {
    await db.farmers.add(farmer)
    if (farmer.openingBalance) {
      await db.ledger.put({
        id: `led_open_${farmer.id}`, farmerId: farmer.id, at: farmer.createdAt, type: 'opening',
        amount: round2(farmer.openingBalance), ref: 'OPENING', note: 'Opening balance', userId,
      })
    }
    await logAudit(userId, 'FARMER_ADD', `${farmer.code} ${farmer.name}`)
  })
  return farmer
}

export async function farmerBalance(farmerId: string): Promise<number> {
  const rows = await db.ledger.where('farmerId').equals(farmerId).toArray()
  return round2(rows.reduce((s, r) => s + r.amount, 0))
}

/** Advances and deductions reduce what we owe the farmer; they are stored as negative amounts. */
export async function addFarmerEntry(
  farmerId: string, type: 'advance' | 'deduction', amount: number, note: string, userId: string,
): Promise<LedgerEntry> {
  if (!(amount > 0)) throw new Error('Enter an amount greater than zero.')
  const entry: LedgerEntry = { id: id('led'), farmerId, at: Date.now(), type, amount: -round2(amount), ref: type.toUpperCase(), note: note.trim(), userId }
  await db.transaction('rw', [db.ledger, db.audit], async () => {
    await db.ledger.add(entry)
    await logAudit(userId, type === 'advance' ? 'FARMER_ADVANCE' : 'FARMER_DEDUCTION', `${farmerId} ₹${amount}`)
  })
  return entry
}

/* ───────────────────────────── Rate chart ───────────────────────────── */

export async function createRateChart(
  d: { name: string; milkType: MilkType; effectiveFrom: number; slabs: RateSlab[] }, userId: string,
): Promise<RateChart> {
  if (!d.name.trim()) throw new Error('Give the chart a name.')
  const bad = validateSlabs(d.slabs)
  if (bad) throw new Error(bad)
  const chart: RateChart = {
    id: id('rch'), name: d.name.trim(), milkType: d.milkType, effectiveFrom: d.effectiveFrom, slabs: d.slabs,
    active: true, createdAt: Date.now(), createdBy: userId,
  }
  await db.transaction('rw', [db.rateCharts, db.audit], async () => {
    await db.rateCharts.add(chart)
    await logAudit(userId, 'RATE_CHART', `${chart.name} (${MILK_LABEL[chart.milkType]}) from ${new Date(chart.effectiveFrom).toDateString()}`)
  })
  return chart
}

/* ───────────────────────────── Raw milk stock ───────────────────────────── */

/** Raw milk is stock like any other item — one hidden-from-POS style per milk type, created the first time it is needed. */
export async function ensureRawMilkVariant(milkType: MilkType): Promise<Variant> {
  const code = RAW_CODE[milkType]
  // Ids are fixed per store, so two counters that both need raw milk for the first time create the *same* records
  // (the server then sees a harmless duplicate) rather than two different "RAW-COW" products.
  const store = (await db.settings.get('store')) as { syncStoreId?: string } | undefined
  const key = store?.syncStoreId || 'local'
  const productId = `prd_raw_${milkType}_${key}`
  const variantId = `var_raw_${milkType}_${key}`
  const existing = (await db.products.get(productId)) ?? (await db.products.where('styleCode').equals(code).first())
  if (existing) {
    const v = await db.variants.where('productId').equals(existing.id).first()
    if (v) return v
  }
  if (!(await db.categories.get(RAW_CATEGORY))) await db.categories.put({ id: RAW_CATEGORY, name: 'Raw Milk', group: 'Raw material' })
  const product = existing ?? {
    id: productId, styleCode: code, name: `Raw Milk (${MILK_LABEL[milkType]})`, categoryId: RAW_CATEGORY, brand: '', fabric: '', season: '',
    hsn: '0401', unit: 'L', shelfLifeDays: 1, taxRate: 0, active: true, createdAt: Date.now(),
  }
  if (!existing) await db.products.add(product)
  const variant: Variant = {
    id: variantId, productId: product.id, sku: code, barcode: await nextBarcode(), size: '1 L', color: '',
    cost: 0, mrp: 0, price: 0, stock: 0, reorderLevel: 0,
  }
  await db.variants.put(variant)
  return variant
}

/* ───────────────────────────── Milk collection ───────────────────────────── */

export interface CollectionInput {
  farmerId: string
  date: number
  session: CollectionSession
  milkType: MilkType
  qtyL: number
  fat: number
  snf: number
  note: string
}

export async function previewCollection(d: Pick<CollectionInput, 'milkType' | 'fat' | 'snf' | 'qtyL' | 'date'>) {
  return quoteMilk(await db.rateCharts.toArray(), d.milkType, d.fat, d.snf, d.qtyL, d.date)
}

/** Accepting a collection: stock goes up as a traceable lot, and the farmer's account is credited. */
async function applyCollectionApproval(c: Collection, userId: string) {
  const lot: Lot = {
    id: `lot_${c.id}`, variantId: c.variantId!, lotNo: c.no, source: 'collection', sourceRef: c.id,
    qty: c.qtyL, available: c.qtyL, producedAt: c.date, expiresAt: c.lotExpiresAt, createdAt: Date.now(),
  }
  await db.lots.put(lot)
  await moveStock(c.variantId!, c.qtyL, 'collection', c.no, `Milk from farmer`, userId)
  await db.ledger.put({
    id: `led_${c.id}`, farmerId: c.farmerId, at: c.date, type: 'collection', amount: c.amount, ref: c.no,
    note: `${c.qtyL} L · Fat ${c.fat} · SNF ${c.snf} @ ₹${c.rate}`, userId,
  })
}

/**
 * Saves one milk collection. The rate is looked up from the chart in force and frozen onto the record. Staff who
 * may approve (autoApprove) have it accepted immediately; everyone else's entries wait as 'pending'.
 */
export async function saveCollection(d: CollectionInput, userId: string, autoApprove: boolean): Promise<Collection> {
  const farmer = await db.farmers.get(d.farmerId)
  if (!farmer || !farmer.active) throw new Error('Pick an active farmer.')
  if (!(d.qtyL > 0) || d.qtyL > 5000) throw new Error('Enter the litres received (more than 0).')
  if (d.fat < FAT_RANGE[0] || d.fat > FAT_RANGE[1]) throw new Error(`Fat should be between ${FAT_RANGE[0]} and ${FAT_RANGE[1]} %.`)
  if (d.snf < SNF_RANGE[0] || d.snf > SNF_RANGE[1]) throw new Error(`SNF should be between ${SNF_RANGE[0]} and ${SNF_RANGE[1]} %.`)

  const q = await previewCollection(d)
  if (!q.ok) throw new Error(q.error)

  const variant = await ensureRawMilkVariant(d.milkType)
  const product = await db.products.get(variant.productId)
  const count = await db.collections.count()
  const c: Collection = {
    id: id('col'), no: `MC-${pad(count + 1, 5)}`, farmerId: d.farmerId, date: d.date, session: d.session, milkType: d.milkType,
    qtyL: round2(d.qtyL), fat: d.fat, snf: d.snf, rate: q.rate, amount: round2(d.qtyL * q.rate), chartId: q.chart.id,
    status: autoApprove ? 'approved' : 'pending', note: d.note.trim(), collectedBy: userId,
    variantId: variant.id, lotExpiresAt: product?.shelfLifeDays ? d.date + product.shelfLifeDays * DAY : undefined,
    ...(autoApprove ? { decidedBy: userId, decidedAt: Date.now() } : {}),
  }
  await db.transaction('rw', [db.collections, db.ledger, db.lots, db.variants, db.moves, db.audit], async () => {
    await db.collections.add(c)
    if (autoApprove) await applyCollectionApproval(c, userId)
    await logAudit(userId, 'MILK_COLLECT', `${c.no} ${farmer.code} ${c.qtyL} L ₹${c.amount}`)
  })
  return c
}

export async function decideCollection(collectionId: string, accept: boolean, userId: string, reason = ''): Promise<void> {
  await db.transaction('rw', [db.collections, db.ledger, db.lots, db.variants, db.moves, db.audit], async () => {
    const c = await db.collections.get(collectionId)
    if (!c) throw new Error('Collection not found.')
    if (c.status !== 'pending') throw new Error('This collection has already been decided.')
    const patch = accept
      ? { status: 'approved' as const, decidedBy: userId, decidedAt: Date.now() }
      : { status: 'rejected' as const, decidedBy: userId, decidedAt: Date.now(), rejectReason: reason.trim() || 'Rejected on quality' }
    await db.collections.update(collectionId, patch)
    if (accept) await applyCollectionApproval({ ...c, ...patch }, userId)
    await logAudit(userId, accept ? 'MILK_APPROVE' : 'MILK_REJECT', `${c.no}${reason ? ` — ${reason}` : ''}`)
  })
}

/* ───────────────────────────── Settlement ───────────────────────────── */

export interface SettlementPreview {
  litres: number; collectionAmount: number; advances: number; deductions: number
  /** Total owed to the farmer right now, including anything before the period. */
  payable: number
  /** Approved milk after the farmer's last settlement that no payment has covered yet. */
  lastSettledTo: number
}

export async function previewSettlement(farmerId: string, from: number, to: number): Promise<SettlementPreview> {
  const [entries, cols, prev] = await Promise.all([
    db.ledger.where('farmerId').equals(farmerId).toArray(),
    db.collections.where('farmerId').equals(farmerId).toArray(),
    db.settlements.where('farmerId').equals(farmerId).toArray(),
  ])
  const inPeriod = cols.filter((c) => c.status === 'approved' && c.date >= from && c.date <= to)
  const sumType = (t: LedgerEntry['type']) => round2(entries.filter((e) => e.type === t && e.at >= from && e.at <= to).reduce((s, e) => s + Math.abs(e.amount), 0))
  return {
    litres: round2(inPeriod.reduce((s, c) => s + c.qtyL, 0)),
    collectionAmount: round2(inPeriod.reduce((s, c) => s + c.amount, 0)),
    advances: sumType('advance'),
    deductions: sumType('deduction'),
    payable: round2(entries.reduce((s, e) => s + e.amount, 0)),
    lastSettledTo: prev.reduce((m, s) => Math.max(m, s.periodTo), 0),
  }
}

export async function createSettlement(
  d: { farmerId: string; from: number; to: number; paid: number; mode: Settlement['mode']; ref: string; notes: string },
  userId: string,
): Promise<Settlement> {
  const prev = await previewSettlement(d.farmerId, d.from, d.to)
  const paid = round2(d.paid)
  if (!(paid > 0)) throw new Error('Enter the amount being paid.')
  if (paid > prev.payable + 0.005) throw new Error(`Only ₹${prev.payable.toFixed(2)} is owed to this farmer.`)
  const count = await db.settlements.count()
  const now = Date.now()
  const s: Settlement = {
    id: id('stl'), no: `FS-${pad(count + 1, 4)}`, farmerId: d.farmerId, periodFrom: d.from, periodTo: d.to,
    litres: prev.litres, collectionAmount: prev.collectionAmount, advances: prev.advances, deductions: prev.deductions,
    payable: prev.payable, paid, mode: d.mode, ref: d.ref.trim(), notes: d.notes.trim(), paidAt: now, userId,
  }
  await db.transaction('rw', [db.settlements, db.ledger, db.audit], async () => {
    await db.settlements.add(s)
    await db.ledger.put({ id: `led_${s.id}`, farmerId: s.farmerId, at: now, type: 'settlement', amount: -paid, ref: s.no, note: `Paid by ${s.mode}`, userId })
    await logAudit(userId, 'FARMER_SETTLE', `${s.no} ₹${paid}`)
  })
  return s
}

/* ───────────────────────────── Lots & expiry ───────────────────────────── */

const byExpiry = (a: Lot, b: Lot) =>
  (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt

/** Quantity of a variant sitting in lots that are already past expiry — it is still "on hand" but must not be sold. */
export async function expiredQty(variantId: string, now = Date.now()): Promise<number> {
  const lots = await db.lots.where('variantId').equals(variantId).toArray()
  return round2(lots.filter((l) => l.available > 0 && l.expiresAt !== undefined && l.expiresAt <= now).reduce((s, l) => s + l.available, 0))
}

/** First-expiry-first-out: a sale draws from the lot that goes off soonest, and never from an expired one. */
export async function consumeLotsFEFO(variantId: string, qty: number, now = Date.now()): Promise<void> {
  const lots = (await db.lots.where('variantId').equals(variantId).toArray())
    .filter((l) => l.available > 0 && (l.expiresAt === undefined || l.expiresAt > now))
    .sort(byExpiry)
  let left = qty
  for (const l of lots) {
    if (left <= 0) break
    const take = Math.min(left, l.available)
    await db.lots.update(l.id, { available: round2(l.available - take) })
    left = round2(left - take)
  }
  // Anything left over came from stock that was never put in a lot (opening stock, older purchases) — nothing to trace.
}

export async function receiveLot(
  d: { variantId: string; qty: number; lotNo: string; producedAt: number; expiresAt?: number }, userId: string,
): Promise<Lot> {
  if (!(d.qty > 0)) throw new Error('Enter the quantity received.')
  const v = await db.variants.get(d.variantId)
  if (!v) throw new Error('Pick an item.')
  const lot: Lot = {
    id: id('lot'), variantId: d.variantId, lotNo: d.lotNo.trim() || `LOT-${pad((await db.lots.count()) + 1, 4)}`, source: 'receipt', sourceRef: '',
    qty: round2(d.qty), available: round2(d.qty), producedAt: d.producedAt, expiresAt: d.expiresAt, createdAt: Date.now(),
  }
  await db.transaction('rw', [db.lots, db.variants, db.moves, db.audit], async () => {
    await db.lots.add(lot)
    await moveStock(d.variantId, lot.qty, 'receipt', lot.lotNo, 'Lot received', userId)
    await logAudit(userId, 'LOT_RECEIVE', `${lot.lotNo} ${lot.qty}`)
  })
  return lot
}

/* ───────────────────────────── Production ───────────────────────────── */

export async function startBatch(
  inputs: Array<{ lotId: string; qty: number }>, notes: string, userId: string,
): Promise<ProductionBatch> {
  const wanted = inputs.filter((i) => i.qty > 0)
  if (!wanted.length) throw new Error('Pick the milk (or other lots) going into this batch.')
  const count = await db.batches.count()
  const batch: ProductionBatch = {
    id: id('bat'), no: `PB-${pad(count + 1, 4)}`, startedAt: Date.now(), status: 'in-progress', inputs: [], outputs: [], notes: notes.trim(), qcNote: '', userId,
  }
  await db.transaction('rw', [db.batches, db.lots, db.variants, db.moves, db.products, db.audit], async () => {
    for (const i of wanted) {
      const lot = await db.lots.get(i.lotId)
      if (!lot) throw new Error('A selected lot no longer exists.')
      if (lot.expiresAt !== undefined && lot.expiresAt <= batch.startedAt) throw new Error(`${lot.lotNo} has expired and cannot be used.`)
      if (i.qty > lot.available + 1e-9) throw new Error(`${lot.lotNo} has only ${lot.available} available.`)
      const v = await db.variants.get(lot.variantId)
      const p = v ? await db.products.get(v.productId) : undefined
      await db.lots.update(lot.id, { available: round2(lot.available - i.qty) })
      await moveStock(lot.variantId, -i.qty, 'production', batch.no, 'Used in production', userId)
      batch.inputs.push({ lotId: lot.id, variantId: lot.variantId, qty: round2(i.qty), label: `${p?.name ?? 'Item'} · ${lot.lotNo}` } satisfies BatchInput)
    }
    await db.batches.add(batch)
    await logAudit(userId, 'BATCH_START', batch.no)
  })
  return batch
}

/** Finishing a batch: a passing batch turns its outputs into new lots (with expiry) ready to sell; a failed one books the loss. */
export async function completeBatch(
  batchId: string, outputs: Array<{ variantId: string; qty: number }>, pass: boolean, qcNote: string, userId: string,
): Promise<void> {
  const b = await db.batches.get(batchId)
  if (!b) throw new Error('Batch not found.')
  if (b.status !== 'in-progress') throw new Error('This batch is already closed.')
  const now = Date.now()
  const made = outputs.filter((o) => o.qty > 0)
  if (pass && !made.length) throw new Error('Enter what the batch produced.')

  await db.transaction('rw', [db.batches, db.lots, db.variants, db.moves, db.products, db.audit], async () => {
    const outs: BatchOutput[] = []
    if (pass) {
      for (const [i, o] of made.entries()) {
        const v = await db.variants.get(o.variantId)
        if (!v) throw new Error('A produced item no longer exists.')
        const p = await db.products.get(v.productId)
        const expiresAt = p?.shelfLifeDays ? now + p.shelfLifeDays * DAY : undefined
        const lot: Lot = {
          id: `lot_${b.id}_${i}`, variantId: v.id, lotNo: `${b.no}-${i + 1}`, source: 'production', sourceRef: b.id,
          qty: round2(o.qty), available: round2(o.qty), producedAt: now, expiresAt, createdAt: now,
        }
        await db.lots.put(lot)
        await moveStock(v.id, lot.qty, 'production', b.no, 'Produced', userId)
        outs.push({ lotId: lot.id, variantId: v.id, qty: lot.qty, expiresAt, label: `${p?.name ?? 'Item'} ${v.size}`.trim() })
      }
    }
    await db.batches.update(b.id, { status: pass ? 'completed' : 'rejected', outputs: outs, qcNote: qcNote.trim(), completedAt: now })
    await logAudit(userId, pass ? 'BATCH_DONE' : 'BATCH_REJECT', `${b.no}${qcNote ? ` — ${qcNote}` : ''}`)
  })
}

/* ───────────────────────────── Wastage ───────────────────────────── */

export async function recordWastage(
  d: { variantId: string; lotId?: string; qty: number; reason: WastageReason; note: string }, userId: string, autoApprove: boolean,
): Promise<Wastage> {
  if (!(d.qty > 0)) throw new Error('Enter the quantity.')
  const v = await db.variants.get(d.variantId)
  if (!v) throw new Error('Pick an item.')
  if (d.qty > v.stock + 1e-9) throw new Error(`Only ${v.stock} is on hand.`)
  if (d.lotId) {
    const lot = await db.lots.get(d.lotId)
    if (!lot || lot.variantId !== d.variantId) throw new Error('That lot is not for this item.')
    if (d.qty > lot.available + 1e-9) throw new Error(`Lot ${lot.lotNo} has only ${lot.available} left.`)
  }
  const count = await db.wastage.count()
  const w: Wastage = {
    id: id('wst'), no: `WS-${pad(count + 1, 4)}`, variantId: d.variantId, lotId: d.lotId, qty: round2(d.qty), reason: d.reason, note: d.note.trim(),
    value: round2(d.qty * v.cost), status: autoApprove ? 'approved' : 'pending', at: Date.now(), requestedBy: userId,
    ...(autoApprove ? { decidedBy: userId, decidedAt: Date.now() } : {}),
  }
  await db.transaction('rw', [db.wastage, db.lots, db.variants, db.moves, db.audit], async () => {
    await db.wastage.add(w)
    if (autoApprove) await applyWastage(w, userId)
    await logAudit(userId, 'WASTAGE', `${w.no} ${w.qty} ${w.reason}`)
  })
  return w
}

async function applyWastage(w: Wastage, userId: string) {
  if (w.lotId) {
    const lot = await db.lots.get(w.lotId)
    if (lot) await db.lots.update(lot.id, { available: round2(Math.max(0, lot.available - w.qty)) })
  }
  await moveStock(w.variantId, -w.qty, 'wastage', w.no, w.reason, userId)
}

export async function decideWastage(wastageId: string, approve: boolean, userId: string): Promise<void> {
  await db.transaction('rw', [db.wastage, db.lots, db.variants, db.moves, db.audit], async () => {
    const w = await db.wastage.get(wastageId)
    if (!w) throw new Error('Record not found.')
    if (w.status !== 'pending') throw new Error('This write-off has already been decided.')
    const patch = { status: approve ? ('approved' as const) : ('rejected' as const), decidedBy: userId, decidedAt: Date.now() }
    await db.wastage.update(wastageId, patch)
    if (approve) await applyWastage({ ...w, ...patch }, userId)
    await logAudit(userId, approve ? 'WASTAGE_OK' : 'WASTAGE_NO', w.no)
  })
}

/* ───────────────────────────── Delivery ───────────────────────────── */

export async function createDelivery(
  d: { customerId?: string; billId?: string; route: string; vehicle: string; driver: string; scheduledAt: number; items: DeliveryItem[]; notes: string },
  userId: string,
): Promise<Delivery> {
  const items = d.items.filter((i) => i.qty > 0)
  if (!items.length) throw new Error('Add at least one item to deliver.')
  const count = await db.deliveries.count()
  const delivery: Delivery = {
    id: id('dlv'), no: `DL-${pad(count + 1, 4)}`, customerId: d.customerId, billId: d.billId, route: d.route.trim(), vehicle: d.vehicle.trim(),
    driver: d.driver.trim(), scheduledAt: d.scheduledAt, status: 'packed', items: items.map((i) => ({ ...i, deliveredQty: 0 })),
    notes: d.notes.trim(), createdAt: Date.now(), userId,
  }
  await db.transaction('rw', [db.deliveries, db.audit], async () => {
    await db.deliveries.add(delivery)
    await logAudit(userId, 'DELIVERY_NEW', delivery.no)
  })
  return delivery
}

export async function setDeliveryStatus(deliveryId: string, status: DeliveryStatus, userId: string, delivered?: Record<string, number>): Promise<void> {
  const d = await db.deliveries.get(deliveryId)
  if (!d) throw new Error('Delivery not found.')
  const items = status === 'delivered'
    ? d.items.map((i) => ({ ...i, deliveredQty: delivered?.[i.variantId] ?? i.qty }))
    : d.items
  await db.transaction('rw', [db.deliveries, db.audit], async () => {
    await db.deliveries.update(deliveryId, { status, items, ...(status === 'delivered' || status === 'failed' ? { deliveredAt: Date.now() } : {}) })
    await logAudit(userId, 'DELIVERY_' + status.toUpperCase(), d.no)
  })
}
