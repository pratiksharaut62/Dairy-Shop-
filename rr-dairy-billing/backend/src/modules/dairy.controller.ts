import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { DbService, Queryable, Row } from '../db/db.service'
import { body, num, partialUpdate, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'
import { round2, slabFor, Slab } from './dairy.rates'

const newId = (p: string) => `${p}_${randomBytes(6).toString('hex')}`
const json = (v: unknown) => JSON.stringify(v ?? [])

/* ───────────── Row mappers (shared with the sync snapshot) ───────────── */

export const farmerRow = (r: Row) => ({
  id: r.id, code: r.code, name: r.name, phone: r.phone, village: r.village, address: r.address, milkType: r.milk_type,
  payoutDetails: r.payout_details, openingBalance: r.opening_balance, active: r.active, createdAt: r.created_at,
})
export const rateChartRow = (r: Row) => ({
  id: r.id, name: r.name, milkType: r.milk_type, effectiveFrom: r.effective_from, slabs: r.slabs, active: r.active,
  createdAt: r.created_at, createdBy: r.created_by,
})
export const collectionRow = (r: Row) => ({
  id: r.id, no: r.no, farmerId: r.farmer_id, date: r.date, session: r.session, milkType: r.milk_type, qtyL: r.qty_l, fat: r.fat, snf: r.snf,
  rate: r.rate, amount: r.amount, chartId: r.chart_id, status: r.status, note: r.note, collectedBy: r.collected_by,
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}), ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
  ...(r.reject_reason ? { rejectReason: r.reject_reason } : {}), ...(r.variant_id ? { variantId: r.variant_id } : {}),
  ...(r.lot_expires_at !== null ? { lotExpiresAt: r.lot_expires_at } : {}),
})
export const ledgerRow = (r: Row) => ({ id: r.id, farmerId: r.farmer_id, at: r.at, type: r.type, amount: r.amount, ref: r.ref, note: r.note, userId: r.user_id })
export const settlementRow = (r: Row) => ({
  id: r.id, no: r.no, farmerId: r.farmer_id, periodFrom: r.period_from, periodTo: r.period_to, litres: r.litres, collectionAmount: r.collection_amount,
  advances: r.advances, deductions: r.deductions, payable: r.payable, paid: r.paid, mode: r.mode, ref: r.ref, notes: r.notes, paidAt: r.paid_at, userId: r.user_id,
})
export const lotRow = (r: Row) => ({
  id: r.id, variantId: r.variant_id, lotNo: r.lot_no, source: r.source, sourceRef: r.source_ref, qty: r.qty, available: r.available,
  producedAt: r.produced_at, ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}), createdAt: r.created_at,
})
export const batchRow = (r: Row) => ({
  id: r.id, no: r.no, startedAt: r.started_at, status: r.status, inputs: r.inputs, outputs: r.outputs, notes: r.notes, qcNote: r.qc_note,
  ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}), userId: r.user_id,
})
export const deliveryRow = (r: Row) => ({
  id: r.id, no: r.no, ...(r.customer_id ? { customerId: r.customer_id } : {}), ...(r.bill_id ? { billId: r.bill_id } : {}), route: r.route, vehicle: r.vehicle,
  driver: r.driver, scheduledAt: r.scheduled_at, status: r.status, items: r.items, notes: r.notes,
  ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}), createdAt: r.created_at, userId: r.user_id,
})
export const wastageRow = (r: Row) => ({
  id: r.id, no: r.no, variantId: r.variant_id, ...(r.lot_id ? { lotId: r.lot_id } : {}), qty: r.qty, reason: r.reason, note: r.note, value: r.value,
  status: r.status, at: r.at, requestedBy: r.requested_by, ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
})

/* ───────────── Stock helpers (mirror src/db/ops.ts moveStock / dairy.ts) ───────────── */

const MOVE = `INSERT INTO stock_moves (id, store_id, variant_id, qty, type, ref, reason, at, user_id)
  VALUES (:id, :storeId, :variantId, :qty, :type, :ref, :reason, :at, :userId)`

async function moveStock(q: Queryable, storeId: string, variantId: string, qty: number, type: string, ref: string, reason: string, at: number, userId: string) {
  const v = await q.one('SELECT id FROM variants WHERE id = :id AND store_id = :s FOR UPDATE', { id: variantId, s: storeId })
  if (!v) throw new UnprocessableEntityException('Unknown item')
  await q.query('UPDATE variants SET stock = stock + :qty WHERE id = :id AND store_id = :s', { qty, id: variantId, s: storeId })
  await q.query(MOVE, { id: newId('mv'), storeId, variantId, qty, type, ref, reason, at, userId })
}

/**
 * A sale draws from the lot that expires first and never from an expired one — unless nothing else is left, because
 * the sale has already happened at the counter and the server must not refuse to record it.
 */
export async function consumeLotsFefo(q: Queryable, storeId: string, variantId: string, qty: number, now = Date.now()) {
  const lots = await q.query(
    `SELECT id, available, expires_at FROM lots WHERE store_id = :s AND variant_id = :v AND available > 0
     ORDER BY (expires_at IS NOT NULL AND expires_at <= :now), expires_at NULLS LAST, created_at FOR UPDATE`,
    { s: storeId, v: variantId, now })
  let left = qty
  for (const l of lots) {
    if (left <= 0) break
    const take = Math.min(left, Number(l.available))
    await q.query('UPDATE lots SET available = available - :take WHERE id = :id', { take, id: l.id })
    left = round2(left - take)
  }
}

async function applyCollection(q: Queryable, storeId: string, c: Row, userId: string) {
  await q.query(
    `INSERT INTO lots (id, store_id, variant_id, lot_no, source, source_ref, qty, available, produced_at, expires_at, created_at)
     VALUES (:id, :s, :v, :no, 'collection', :ref, :qty, :qty, :at, :exp, :now) ON CONFLICT (id) DO NOTHING`,
    { id: `lot_${c.id}`, s: storeId, v: c.variant_id, no: c.no, ref: c.id, qty: c.qty_l, at: c.date, exp: c.lot_expires_at, now: Date.now() })
  await moveStock(q, storeId, c.variant_id, Number(c.qty_l), 'collection', c.no, 'Milk from farmer', c.date, userId)
  await q.query(
    `INSERT INTO farmer_ledger (id, store_id, farmer_id, at, type, amount, ref, note, user_id)
     VALUES (:id, :s, :f, :at, 'collection', :amount, :no, :note, :u) ON CONFLICT (id) DO NOTHING`,
    { id: `led_${c.id}`, s: storeId, f: c.farmer_id, at: c.date, amount: c.amount, no: c.no, note: `${c.qty_l} L · Fat ${c.fat} · SNF ${c.snf} @ ₹${c.rate}`, u: userId })
}

async function applyWastage(q: Queryable, storeId: string, w: Row, userId: string) {
  if (w.lot_id) await q.query('UPDATE lots SET available = GREATEST(0, available - :qty) WHERE id = :id AND store_id = :s', { qty: w.qty, id: w.lot_id, s: storeId })
  await moveStock(q, storeId, w.variant_id, -Number(w.qty), 'wastage', w.no, w.reason, Date.now(), userId)
}

const range = (from?: string, to?: string) => ({ from: from || null, to: to || null })

@Controller('dairy')
export class DairyController {
  constructor(private readonly db: DbService) {}

  /* ───────────── Farmers ───────────── */

  @Perm('collection') @Get('farmers')
  async farmers(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM farmers WHERE store_id = :s ORDER BY code', { s: c.storeId })).map(farmerRow)
  }

  @Perm('collection') @Post('farmers')
  async createFarmer(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'code', 'name'])
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO farmers (id, store_id, code, name, phone, village, address, milk_type, payout_details, opening_balance, active, created_at)
           VALUES (:id, :s, :code, :name, :phone, :village, :address, :milk, :payout, :opening, TRUE, :at)`,
          { id: b.id, s: c.storeId, code: b.code, name: b.name, phone: b.phone ?? '', village: b.village ?? '', address: b.address ?? '',
            milk: b.milkType ?? 'cow', payout: b.payoutDetails ?? '', opening: num(b.openingBalance), at: b.createdAt ?? Date.now() })
        if (num(b.openingBalance)) {
          await q.query(
            `INSERT INTO farmer_ledger (id, store_id, farmer_id, at, type, amount, ref, note, user_id)
             VALUES (:id, :s, :f, :at, 'opening', :amount, 'OPENING', 'Opening balance', :u)`,
            { id: `led_open_${b.id}`, s: c.storeId, f: b.id, at: b.createdAt ?? Date.now(), amount: num(b.openingBalance), u: c.sub })
        }
      })
    } catch (e) { pgToHttp(e, 'Could not add farmer', 'A farmer with that code already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('collection') @Put('farmers/:id')
  async updateFarmer(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('farmers', body(raw), {
      code: 'code', name: 'name', phone: 'phone', village: 'village', address: 'address', milkType: 'milk_type', payoutDetails: 'payout_details', active: 'active',
    }, 'id = :id AND store_id = :s', { id, s: c.storeId })
    try { if (u) await this.db.query(u.sql, u.params) } catch (e) { pgToHttp(e, 'Could not update farmer', 'That farmer code is already in use') }
    return { ok: true }
  }

  @Perm('collection') @Get('farmers/:id/ledger')
  async farmerLedger(@Auth() c: Claims, @Param('id') id: string) {
    const rows = await this.db.query('SELECT * FROM farmer_ledger WHERE store_id = :s AND farmer_id = :f ORDER BY at DESC', { s: c.storeId, f: id })
    return { balance: round2(rows.reduce((t, r) => t + Number(r.amount), 0)), entries: rows.map(ledgerRow) }
  }

  /** Advances and deductions typed in by a person (collection / settlement rows are derived, never posted). */
  @Perm('settlement') @Post('farmer-ledger')
  async addLedger(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'farmerId', 'type', 'amount'])
    if (b.type !== 'advance' && b.type !== 'deduction') throw new UnprocessableEntityException('Only advances and deductions can be added by hand')
    try {
      await this.db.query(
        `INSERT INTO farmer_ledger (id, store_id, farmer_id, at, type, amount, ref, note, user_id)
         VALUES (:id, :s, :f, :at, :type, :amount, :ref, :note, :u)`,
        { id: b.id, s: c.storeId, f: b.farmerId, at: b.at ?? Date.now(), type: b.type, amount: -Math.abs(num(b.amount)), ref: b.ref ?? String(b.type).toUpperCase(), note: b.note ?? '', u: c.sub })
    } catch (e) { pgToHttp(e, 'Could not record entry', 'Entry already synced') }
    return { ok: true }
  }

  /* ───────────── Rate charts ───────────── */

  @Perm('collection') @Get('rate-charts')
  async charts(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM rate_charts WHERE store_id = :s ORDER BY effective_from DESC', { s: c.storeId })).map(rateChartRow)
  }

  @Perm('quality') @Post('rate-charts')
  async createChart(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'name', 'milkType', 'effectiveFrom', 'slabs'])
    if (!Array.isArray(b.slabs) || !b.slabs.length) throw new UnprocessableEntityException('A rate chart needs at least one cell')
    try {
      await this.db.query(
        `INSERT INTO rate_charts (id, store_id, name, milk_type, effective_from, slabs, active, created_at, created_by)
         VALUES (:id, :s, :name, :milk, :eff, :slabs::jsonb, TRUE, :at, :by)`,
        { id: b.id, s: c.storeId, name: b.name, milk: b.milkType, eff: b.effectiveFrom, slabs: json(b.slabs), at: b.createdAt ?? Date.now(), by: c.sub })
    } catch (e) { pgToHttp(e, 'Could not save rate chart', 'Rate chart already synced') }
    return { ok: true, id: b.id }
  }

  /* ───────────── Milk collection ───────────── */

  @Perm('collection') @Get('collections')
  async collections(@Auth() c: Claims, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    const r = range(from, to)
    return (await this.db.query(
      `SELECT * FROM milk_collections WHERE store_id = :s AND (:from::bigint IS NULL OR date >= :from::bigint)
         AND (:to::bigint IS NULL OR date <= :to::bigint) AND (:status::text IS NULL OR status = :status::text) ORDER BY date DESC LIMIT 2000`,
      { s: c.storeId, from: r.from, to: r.to, status: status || null })).map(collectionRow)
  }

  /**
   * The server re-derives the rate from the chart in force at the collection time and stores ITS answer — a device
   * with a stale chart cannot pay a farmer the wrong amount. An approved collection also puts the milk in stock as a
   * lot and credits the farmer, in the same transaction.
   */
  @Perm('collection') @Post('collections')
  async createCollection(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'farmerId', 'date', 'session', 'milkType', 'qtyL', 'fat', 'snf', 'variantId'])
    const qty = num(b.qtyL), fat = num(b.fat), snf = num(b.snf)
    if (!(qty > 0)) throw new UnprocessableEntityException('Litres must be more than zero')
    const wantsApproved = b.status === 'approved'
    if (wantsApproved && c.role === 'cashier') throw new UnprocessableEntityException('Only a manager or owner can approve milk')
    try {
      await this.db.tx(async (q) => {
        const farmer = await q.one('SELECT id FROM farmers WHERE id = :id AND store_id = :s', { id: b.farmerId, s: c.storeId })
        if (!farmer) throw new UnprocessableEntityException('Unknown farmer')
        const chart = await q.one(
          `SELECT id, slabs FROM rate_charts WHERE store_id = :s AND milk_type = :m AND active AND effective_from <= :at
           ORDER BY effective_from DESC LIMIT 1`, { s: c.storeId, m: b.milkType, at: b.date })
        if (!chart) throw new UnprocessableEntityException(`No rate chart for ${b.milkType} milk on that date`)
        const slab = slabFor(chart.slabs as Slab[], fat, snf)
        if (!slab) throw new UnprocessableEntityException(`Fat ${fat} / SNF ${snf} is outside the rate chart`)
        const amount = round2(qty * slab.rate)
        const row = {
          id: b.id, s: c.storeId, no: b.no, farmer: b.farmerId, date: b.date, session: b.session, milk: b.milkType, qty, fat, snf,
          rate: slab.rate, amount, chart: chart.id, status: wantsApproved ? 'approved' : 'pending', note: b.note ?? '', by: b.collectedBy || c.sub,
          decBy: wantsApproved ? c.sub : null, decAt: wantsApproved ? (b.decidedAt ?? Date.now()) : null, variant: b.variantId, exp: b.lotExpiresAt ?? null,
        }
        await q.query(
          `INSERT INTO milk_collections (id, store_id, no, farmer_id, date, session, milk_type, qty_l, fat, snf, rate, amount, chart_id, status, note,
             collected_by, decided_by, decided_at, variant_id, lot_expires_at)
           VALUES (:id, :s, :no, :farmer, :date, :session, :milk, :qty, :fat, :snf, :rate, :amount, :chart, :status, :note, :by, :decBy, :decAt, :variant, :exp)`, row)
        if (wantsApproved) {
          const inserted = await q.one('SELECT * FROM milk_collections WHERE id = :id', { id: b.id })
          await applyCollection(q, c.storeId, inserted!, c.sub)
        }
      })
    } catch (e) { pgToHttp(e, 'Could not save collection', 'Collection already synced') }
    return { ok: true, id: b.id }
  }

  @Perm('quality') @Post('collections/:id/decision')
  async decideCollection(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const b = body(raw); required(b, ['status'])
    if (b.status !== 'approved' && b.status !== 'rejected') throw new UnprocessableEntityException('Status must be approved or rejected')
    try {
      await this.db.tx(async (q) => {
        const col = await q.one('SELECT * FROM milk_collections WHERE id = :id AND store_id = :s FOR UPDATE', { id, s: c.storeId })
        if (!col) throw new NotFoundException('Collection not found')
        if (col.status !== 'pending') throw new ConflictException('Already decided')
        await q.query(
          `UPDATE milk_collections SET status = :st, decided_by = :by, decided_at = :at, reject_reason = :why WHERE id = :id`,
          { st: b.status, by: c.sub, at: b.decidedAt ?? Date.now(), why: b.status === 'rejected' ? (b.rejectReason ?? 'Rejected on quality') : null, id })
        if (b.status === 'approved') await applyCollection(q, c.storeId, { ...col, status: 'approved' }, c.sub)
      })
    } catch (e) { pgToHttp(e, 'Could not record decision') }
    return { ok: true }
  }

  /* ───────────── Settlements ───────────── */

  @Perm('settlement') @Get('settlements')
  async settlements(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM farmer_settlements WHERE store_id = :s ORDER BY paid_at DESC LIMIT 1000', { s: c.storeId })).map(settlementRow)
  }

  @Perm('settlement') @Post('settlements')
  async createSettlement(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'farmerId', 'periodFrom', 'periodTo', 'paid', 'mode'])
    const paid = round2(num(b.paid))
    if (!(paid > 0)) throw new UnprocessableEntityException('Payment must be more than zero')
    try {
      await this.db.tx(async (q) => {
        // A retry of an upload that already landed must answer 409 ("done"), not fail the balance check below.
        if (await q.one('SELECT 1 AS x FROM farmer_settlements WHERE id = :id', { id: b.id })) throw new ConflictException('Settlement already synced')
        // Lock the farmer row so two devices paying at once cannot overpay.
        const f = await q.one('SELECT id FROM farmers WHERE id = :id AND store_id = :s FOR UPDATE', { id: b.farmerId, s: c.storeId })
        if (!f) throw new UnprocessableEntityException('Unknown farmer')
        const bal = await q.one('SELECT COALESCE(SUM(amount), 0) AS bal FROM farmer_ledger WHERE farmer_id = :f', { f: b.farmerId })
        const payable = round2(Number(bal?.bal ?? 0))
        if (paid > payable + 0.005) throw new UnprocessableEntityException(`Only ₹${payable.toFixed(2)} is owed to this farmer`)
        await q.query(
          `INSERT INTO farmer_settlements (id, store_id, no, farmer_id, period_from, period_to, litres, collection_amount, advances, deductions, payable, paid, mode, ref, notes, paid_at, user_id)
           VALUES (:id, :s, :no, :f, :pf, :pt, :litres, :ca, :adv, :ded, :payable, :paid, :mode, :ref, :notes, :at, :u)`,
          { id: b.id, s: c.storeId, no: b.no, f: b.farmerId, pf: b.periodFrom, pt: b.periodTo, litres: num(b.litres), ca: num(b.collectionAmount),
            adv: num(b.advances), ded: num(b.deductions), payable, paid, mode: b.mode, ref: b.ref ?? '', notes: b.notes ?? '', at: b.paidAt ?? Date.now(), u: c.sub })
        await q.query(
          `INSERT INTO farmer_ledger (id, store_id, farmer_id, at, type, amount, ref, note, user_id)
           VALUES (:id, :s, :f, :at, 'settlement', :amount, :no, :note, :u)`,
          { id: `led_${b.id}`, s: c.storeId, f: b.farmerId, at: b.paidAt ?? Date.now(), amount: -paid, no: b.no, note: `Paid by ${b.mode}`, u: c.sub })
      })
    } catch (e) { pgToHttp(e, 'Could not record settlement', 'Settlement already synced') }
    return { ok: true, id: b.id }
  }

  /* ───────────── Lots ───────────── */

  @Perm('stock') @Get('lots')
  async lots(@Auth() c: Claims, @Query('all') all?: string) {
    return (await this.db.query(
      `SELECT * FROM lots WHERE store_id = :s AND (:all::boolean OR available > 0) ORDER BY expires_at NULLS LAST, created_at`,
      { s: c.storeId, all: all === 'true' })).map(lotRow)
  }

  /** Stock received from outside with its own expiry; collection and production lots are created by their own endpoints. */
  @Perm('stock') @Post('lots')
  async receiveLot(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'variantId', 'lotNo', 'qty', 'producedAt'])
    const qty = num(b.qty)
    if (!(qty > 0)) throw new UnprocessableEntityException('Quantity must be more than zero')
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO lots (id, store_id, variant_id, lot_no, source, source_ref, qty, available, produced_at, expires_at, created_at)
           VALUES (:id, :s, :v, :no, 'receipt', '', :qty, :qty, :made, :exp, :now)`,
          { id: b.id, s: c.storeId, v: b.variantId, no: b.lotNo, qty, made: b.producedAt, exp: b.expiresAt ?? null, now: b.createdAt ?? Date.now() })
        await moveStock(q, c.storeId, b.variantId as string, qty, 'receipt', b.lotNo as string, 'Lot received', Date.now(), c.sub)
      })
    } catch (e) { pgToHttp(e, 'Could not receive lot', 'Lot already synced') }
    return { ok: true, id: b.id }
  }

  /* ───────────── Production ───────────── */

  @Perm('production') @Get('production/batches')
  async batches(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM production_batches WHERE store_id = :s ORDER BY started_at DESC LIMIT 1000', { s: c.storeId })).map(batchRow)
  }

  @Perm('production') @Post('production/batches')
  async startBatch(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'startedAt', 'inputs'])
    const inputs = (Array.isArray(b.inputs) ? b.inputs : []) as Row[]
    if (!inputs.length) throw new UnprocessableEntityException('A batch needs at least one input lot')
    try {
      await this.db.tx(async (q) => {
        if (await q.one('SELECT 1 AS x FROM production_batches WHERE id = :id', { id: b.id })) throw new ConflictException('Batch already synced')
        for (const i of inputs) {
          const lot = await q.one('SELECT id, variant_id, lot_no, available, expires_at FROM lots WHERE id = :id AND store_id = :s FOR UPDATE', { id: i.lotId, s: c.storeId })
          if (!lot) throw new UnprocessableEntityException('An input lot does not exist')
          if (num(i.qty) > Number(lot.available) + 1e-9) throw new UnprocessableEntityException(`${lot.lot_no} has only ${lot.available} available`)
          await q.query('UPDATE lots SET available = available - :qty WHERE id = :id', { qty: num(i.qty), id: lot.id })
          await moveStock(q, c.storeId, lot.variant_id, -num(i.qty), 'production', b.no as string, 'Used in production', b.startedAt as number, c.sub)
        }
        await q.query(
          `INSERT INTO production_batches (id, store_id, no, started_at, status, inputs, outputs, notes, qc_note, user_id)
           VALUES (:id, :s, :no, :at, 'in-progress', :inputs::jsonb, '[]'::jsonb, :notes, '', :u)`,
          { id: b.id, s: c.storeId, no: b.no, at: b.startedAt, inputs: json(inputs), notes: b.notes ?? '', u: c.sub })
      })
    } catch (e) { pgToHttp(e, 'Could not start batch', 'Batch already synced') }
    return { ok: true, id: b.id }
  }

  @Perm('production') @Post('production/batches/:id/complete')
  async completeBatch(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const b = body(raw); required(b, ['status'])
    if (b.status !== 'completed' && b.status !== 'rejected') throw new UnprocessableEntityException('Status must be completed or rejected')
    const outputs = (Array.isArray(b.outputs) ? b.outputs : []) as Row[]
    try {
      await this.db.tx(async (q) => {
        const batch = await q.one('SELECT * FROM production_batches WHERE id = :id AND store_id = :s FOR UPDATE', { id, s: c.storeId })
        if (!batch) throw new NotFoundException('Batch not found')
        if (batch.status !== 'in-progress') throw new ConflictException('Batch already closed')
        const at = (b.completedAt as number) ?? Date.now()
        if (b.status === 'completed') {
          if (!outputs.length) throw new UnprocessableEntityException('A passed batch must list what it produced')
          for (const [i, o] of outputs.entries()) {
            await q.query(
              `INSERT INTO lots (id, store_id, variant_id, lot_no, source, source_ref, qty, available, produced_at, expires_at, created_at)
               VALUES (:id, :s, :v, :no, 'production', :ref, :qty, :qty, :at, :exp, :at)`,
              { id: o.lotId, s: c.storeId, v: o.variantId, no: `${batch.no}-${i + 1}`, ref: id, qty: num(o.qty), at, exp: o.expiresAt ?? null })
            await moveStock(q, c.storeId, o.variantId, num(o.qty), 'production', batch.no, 'Produced', at, c.sub)
          }
        }
        await q.query(
          `UPDATE production_batches SET status = :st, outputs = :outs::jsonb, qc_note = :qc, completed_at = :at WHERE id = :id`,
          { st: b.status, outs: json(b.status === 'completed' ? outputs : []), qc: b.qcNote ?? '', at, id })
      })
    } catch (e) { pgToHttp(e, 'Could not close batch') }
    return { ok: true }
  }

  /* ───────────── Deliveries ───────────── */

  @Perm('delivery') @Get('deliveries')
  async deliveries(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM deliveries WHERE store_id = :s ORDER BY scheduled_at DESC LIMIT 1000', { s: c.storeId })).map(deliveryRow)
  }

  @Perm('delivery') @Post('deliveries')
  async createDelivery(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'scheduledAt', 'items'])
    try {
      await this.db.query(
        `INSERT INTO deliveries (id, store_id, no, customer_id, bill_id, route, vehicle, driver, scheduled_at, status, items, notes, created_at, user_id)
         VALUES (:id, :s, :no, :cust, :bill, :route, :vehicle, :driver, :at, :status, :items::jsonb, :notes, :created, :u)`,
        { id: b.id, s: c.storeId, no: b.no, cust: b.customerId ?? null, bill: b.billId ?? null, route: b.route ?? '', vehicle: b.vehicle ?? '', driver: b.driver ?? '',
          at: b.scheduledAt, status: b.status ?? 'packed', items: json(b.items), notes: b.notes ?? '', created: b.createdAt ?? Date.now(), u: c.sub })
    } catch (e) { pgToHttp(e, 'Could not create delivery', 'Delivery already synced') }
    return { ok: true, id: b.id }
  }

  @Perm('delivery') @Put('deliveries/:id')
  async updateDelivery(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('deliveries', body(raw), {
      status: 'status', items: 'items', notes: 'notes', route: 'route', vehicle: 'vehicle', driver: 'driver', deliveredAt: 'delivered_at',
    }, 'id = :id AND store_id = :s', { id, s: c.storeId }, { items: (v) => JSON.stringify(v) })
    // `items` is JSONB: node-pg would send an array as a Postgres array, so the update casts it explicitly.
    try { if (u) await this.db.query(u.sql.replace('items = :set_items', 'items = :set_items::jsonb'), u.params) } catch (e) { pgToHttp(e, 'Could not update delivery') }
    return { ok: true }
  }

  /* ───────────── Wastage ───────────── */

  @Perm('wastage') @Get('wastage')
  async wastage(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM wastage WHERE store_id = :s ORDER BY at DESC LIMIT 1000', { s: c.storeId })).map(wastageRow)
  }

  @Perm('wastage') @Post('wastage')
  async recordWastage(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'no', 'variantId', 'qty', 'reason'])
    const approved = b.status === 'approved'
    if (approved && c.role !== 'owner') throw new UnprocessableEntityException('Only the owner can approve a write-off')
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO wastage (id, store_id, no, variant_id, lot_id, qty, reason, note, value, status, at, requested_by, decided_by, decided_at)
           VALUES (:id, :s, :no, :v, :lot, :qty, :reason, :note, :value, :status, :at, :by, :decBy, :decAt)`,
          { id: b.id, s: c.storeId, no: b.no, v: b.variantId, lot: b.lotId ?? null, qty: num(b.qty), reason: b.reason, note: b.note ?? '', value: num(b.value),
            status: approved ? 'approved' : 'pending', at: b.at ?? Date.now(), by: c.sub, decBy: approved ? c.sub : null, decAt: approved ? Date.now() : null })
        if (approved) await applyWastage(q, c.storeId, (await q.one('SELECT * FROM wastage WHERE id = :id', { id: b.id }))!, c.sub)
      })
    } catch (e) { pgToHttp(e, 'Could not record write-off', 'Write-off already synced') }
    return { ok: true, id: b.id }
  }

  @Perm('approveWastage') @Post('wastage/:id/decision')
  async decideWastage(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const b = body(raw); required(b, ['status'])
    if (b.status !== 'approved' && b.status !== 'rejected') throw new UnprocessableEntityException('Status must be approved or rejected')
    try {
      await this.db.tx(async (q) => {
        const w = await q.one('SELECT * FROM wastage WHERE id = :id AND store_id = :s FOR UPDATE', { id, s: c.storeId })
        if (!w) throw new NotFoundException('Record not found')
        if (w.status !== 'pending') throw new ConflictException('Already decided')
        await q.query('UPDATE wastage SET status = :st, decided_by = :by, decided_at = :at WHERE id = :id', { st: b.status, by: c.sub, at: b.decidedAt ?? Date.now(), id })
        if (b.status === 'approved') await applyWastage(q, c.storeId, w, c.sub)
      })
    } catch (e) { pgToHttp(e, 'Could not record decision') }
    return { ok: true }
  }

  /* ───────────── Dashboard & reports (server-side, for the web app and exports) ───────────── */

  @Perm('reports') @Get('dashboard')
  async dashboard(@Auth() c: Claims, @Query('from') from?: string, @Query('to') to?: string) {
    const r = range(from, to), p = { s: c.storeId, from: r.from, to: r.to }
    const t = await this.db.one(
      `SELECT COALESCE(SUM(qty_l),0) AS litres, COALESCE(SUM(amount),0) AS amount,
              COALESCE(SUM(fat*qty_l)/NULLIF(SUM(qty_l),0),0) AS avg_fat, COALESCE(SUM(snf*qty_l)/NULLIF(SUM(qty_l),0),0) AS avg_snf, COUNT(*) AS entries
       FROM milk_collections WHERE store_id = :s AND status = 'approved' AND (:from::bigint IS NULL OR date >= :from::bigint) AND (:to::bigint IS NULL OR date <= :to::bigint)`, p)
    const pending = await this.db.one(`SELECT COUNT(*) AS n FROM milk_collections WHERE store_id = :s AND status = 'pending'`, p)
    const owed = await this.db.one(
      `SELECT COALESCE(SUM(bal),0) AS owed FROM (SELECT SUM(amount) AS bal FROM farmer_ledger WHERE store_id = :s GROUP BY farmer_id) x WHERE bal > 0`, p)
    const expiry = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE expires_at <= :now) AS expired,
              COUNT(*) FILTER (WHERE expires_at > :now AND expires_at <= :soon) AS soon
       FROM lots WHERE store_id = :s AND available > 0 AND expires_at IS NOT NULL`, { s: c.storeId, now: Date.now(), soon: Date.now() + 3 * 86_400_000 })
    const batches = await this.db.one(`SELECT COUNT(*) FILTER (WHERE status = 'in-progress') AS open FROM production_batches WHERE store_id = :s`, p)
    const deliveries = await this.db.one(`SELECT COUNT(*) AS n FROM deliveries WHERE store_id = :s AND status IN ('packed','dispatched')`, p)
    return {
      litres: Number(t?.litres), amount: Number(t?.amount), avgFat: round2(Number(t?.avg_fat)), avgSnf: round2(Number(t?.avg_snf)), entries: Number(t?.entries),
      pendingApprovals: Number(pending?.n), owedToFarmers: Number(owed?.owed), expiredLots: Number(expiry?.expired), expiringSoon: Number(expiry?.soon),
      batchesInProgress: Number(batches?.open), openDeliveries: Number(deliveries?.n),
    }
  }

  @Perm('reports') @Get('reports/collections')
  async reportCollections(@Auth() c: Claims, @Query('from') from?: string, @Query('to') to?: string, @Query('groupBy') groupBy = 'day') {
    const r = range(from, to)
    const key = groupBy === 'farmer' ? 'f.code || \' \' || f.name' : groupBy === 'session' ? 'm.session' : "to_char(to_timestamp(m.date / 1000.0) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')"
    return this.db.query(
      `SELECT ${key} AS key, SUM(m.qty_l) AS litres, SUM(m.amount) AS amount,
              ROUND(SUM(m.fat*m.qty_l)/NULLIF(SUM(m.qty_l),0), 2) AS avg_fat, ROUND(SUM(m.snf*m.qty_l)/NULLIF(SUM(m.qty_l),0), 2) AS avg_snf,
              ROUND(SUM(m.amount)/NULLIF(SUM(m.qty_l),0), 2) AS avg_rate
       FROM milk_collections m JOIN farmers f ON f.id = m.farmer_id
       WHERE m.store_id = :s AND m.status = 'approved' AND (:from::bigint IS NULL OR m.date >= :from::bigint) AND (:to::bigint IS NULL OR m.date <= :to::bigint)
       GROUP BY 1 ORDER BY 1`, { s: c.storeId, from: r.from, to: r.to })
  }

  @Perm('reports') @Get('reports/expiry')
  async reportExpiry(@Auth() c: Claims, @Query('days') days = '7') {
    return this.db.query(
      `SELECT l.id, l.lot_no, l.available, l.expires_at, p.name AS product, v.size
       FROM lots l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
       WHERE l.store_id = :s AND l.available > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= :limit ORDER BY l.expires_at`,
      { s: c.storeId, limit: Date.now() + Number(days) * 86_400_000 })
  }

  @Perm('reports') @Get('reports/farmer-dues')
  async reportDues(@Auth() c: Claims) {
    return this.db.query(
      `SELECT f.code, f.name, f.village, ROUND(COALESCE(SUM(l.amount),0), 2) AS balance
       FROM farmers f LEFT JOIN farmer_ledger l ON l.farmer_id = f.id WHERE f.store_id = :s GROUP BY f.id HAVING COALESCE(SUM(l.amount),0) <> 0 ORDER BY balance DESC`,
      { s: c.storeId })
  }
}
