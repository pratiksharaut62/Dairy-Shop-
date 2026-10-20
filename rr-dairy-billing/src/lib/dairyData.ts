import { db } from '../db'
import { round2 } from './money'
import { DAY, endOfDay, rangeBounds, startOfDay, type RangeKey } from './dates'
import type { Collection, Lot } from '../db/types'

/** Weighted by litres: a 100 L can with 4.0 % fat counts for more than a 5 L can with 6.0 %. */
export function milkTotals(cols: Collection[]) {
  const approved = cols.filter((c) => c.status === 'approved')
  const litres = round2(approved.reduce((s, c) => s + c.qtyL, 0))
  const amount = round2(approved.reduce((s, c) => s + c.amount, 0))
  const w = (f: (c: Collection) => number) => (litres ? round2(approved.reduce((s, c) => s + f(c) * c.qtyL, 0) / litres) : 0)
  return { litres, amount, avgFat: w((c) => c.fat), avgSnf: w((c) => c.snf), avgRate: litres ? round2(amount / litres) : 0, count: approved.length }
}

export interface ExpiryRow { lot: Lot; name: string; days: number }

export async function loadExpiry(withinDays = 3): Promise<{ expired: ExpiryRow[]; soon: ExpiryRow[] }> {
  const now = Date.now()
  const [lots, variants, products] = await Promise.all([db.lots.toArray(), db.variants.toArray(), db.products.toArray()])
  const vmap = new Map(variants.map((v) => [v.id, v]))
  const pmap = new Map(products.map((p) => [p.id, p]))
  const rows: ExpiryRow[] = []
  for (const lot of lots) {
    if (lot.available <= 0 || lot.expiresAt === undefined) continue
    const v = vmap.get(lot.variantId)
    const p = v ? pmap.get(v.productId) : undefined
    rows.push({ lot, name: `${p?.name ?? 'Item'}${v?.size ? ' · ' + v.size : ''}`, days: Math.ceil((lot.expiresAt - now) / DAY) })
  }
  rows.sort((a, b) => (a.lot.expiresAt ?? 0) - (b.lot.expiresAt ?? 0))
  return {
    expired: rows.filter((r) => (r.lot.expiresAt ?? 0) <= now),
    soon: rows.filter((r) => (r.lot.expiresAt ?? 0) > now && (r.lot.expiresAt ?? 0) <= now + withinDays * DAY),
  }
}

export async function loadDairyDashboard(range: RangeKey) {
  const [from, to] = rangeBounds(range)
  const today = [startOfDay(), endOfDay()] as const
  const [cols, todayCols, pendingCols, batches, deliveries, wastage, ledger, expiry, farmers] = await Promise.all([
    db.collections.where('date').between(from, to, true, true).toArray(),
    db.collections.where('date').between(today[0], today[1], true, true).toArray(),
    db.collections.where('status').equals('pending').toArray(),
    db.batches.toArray(),
    db.deliveries.toArray(),
    db.wastage.where('status').equals('pending').toArray(),
    db.ledger.toArray(),
    loadExpiry(3),
    db.farmers.toArray(),
  ])
  const totals = milkTotals(cols)
  const approvedToday = todayCols.filter((c) => c.status === 'approved')
  const session = (s: 'morning' | 'evening') => round2(approvedToday.filter((c) => c.session === s).reduce((x, c) => x + c.qtyL, 0))

  // What we owe farmers right now = sum of positive account balances.
  const bal = new Map<string, number>()
  for (const e of ledger) bal.set(e.farmerId, round2((bal.get(e.farmerId) ?? 0) + e.amount))
  const payable = round2([...bal.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0))

  // Collection per day for the trend line.
  const dayMap = new Map<number, number>()
  for (const c of cols) if (c.status === 'approved') { const k = startOfDay(c.date); dayMap.set(k, round2((dayMap.get(k) ?? 0) + c.qtyL)) }
  const series = [...dayMap.entries()].sort((a, b) => a[0] - b[0]).map(([start, litres]) => ({ start, litres }))

  // Today by shift: what physically arrived (pending entries count, rejected ones do not).
  const fmap = new Map(farmers.map((f) => [f.id, f]))
  const shift = (name: 'morning' | 'evening') => {
    const list = todayCols.filter((c) => c.session === name && c.status !== 'rejected')
    const t = milkTotals(list.map((c) => ({ ...c, status: 'approved' as const })))
    return { litres: t.litres, amount: t.amount, avgFat: t.avgFat, avgSnf: t.avgSnf, farmers: new Set(list.map((c) => c.farmerId)).size }
  }
  // Top suppliers in the selected range.
  const perFarmer = new Map<string, number>()
  for (const c of cols) if (c.status === 'approved') perFarmer.set(c.farmerId, round2((perFarmer.get(c.farmerId) ?? 0) + c.qtyL))
  const topFarmers = [...perFarmer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([farmerId, litres]) => ({ farmerId, litres, name: fmap.get(farmerId)?.name ?? 'Unknown', code: fmap.get(farmerId)?.code ?? '', village: fmap.get(farmerId)?.village ?? '' }))

  const inRange = (t: number) => t >= from && t <= to
  const producedBatches = batches.filter((b) => b.status === 'completed' && b.completedAt && inRange(b.completedAt))
  const openDeliveries = deliveries.filter((d) => d.status === 'packed' || d.status === 'dispatched')

  return {
    totals, series, topFarmers, morningShift: shift('morning'), eveningShift: shift('evening'),
    todayLitres: round2(approvedToday.reduce((s, c) => s + c.qtyL, 0)), morning: session('morning'), evening: session('evening'),
    pending: pendingCols.length,
    activeFarmers: farmers.filter((f) => f.active).length,
    payable,
    expired: expiry.expired, soon: expiry.soon,
    batchesInProgress: batches.filter((b) => b.status === 'in-progress').length,
    batchesDone: producedBatches.length,
    openDeliveries: openDeliveries.length,
    pendingWastage: wastage.length,
    hasFarmers: farmers.length > 0,
  }
}


export interface Period { key: string; label: string; from: number; to: number }

/**
 * The payment cycles a dairy actually runs on: three 10-day bills a month (1–10, 11–20, 21–end) plus the whole month,
 * for this month and last month. Farmers are normally settled at the end of each cycle.
 */
export function billingPeriods(now = Date.now()): Period[] {
  const d = new Date(now)
  const y = d.getFullYear(), m = d.getMonth()
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1
  const last = (yy: number, mm: number) => new Date(yy, mm + 1, 0).getDate()
  const mon = (yy: number, mm: number) => new Date(yy, mm, 1).toLocaleDateString('en-IN', { month: 'short' })
  const mk = (key: string, yy: number, mm: number, from: number, to: number, whole = false): Period => ({
    key, from: new Date(yy, mm, from).getTime(), to: new Date(yy, mm, to, 23, 59, 59, 999).getTime(),
    label: whole ? `Whole ${mon(yy, mm)}` : `${from}–${to} ${mon(yy, mm)}`,
  })
  return [
    mk('c1', y, m, 1, 10), mk('c2', y, m, 11, 20), mk('c3', y, m, 21, last(y, m)), mk('cm', y, m, 1, last(y, m), true),
    mk('p1', py, pm, 1, 10), mk('p2', py, pm, 11, 20), mk('p3', py, pm, 21, last(py, pm)), mk('pm', py, pm, 1, last(py, pm), true),
  ]
}

/** The cycle that contains today, or — if today's cycle has barely started — the one that just ended. */
export function currentPeriodKey(now = Date.now()): string {
  const day = new Date(now).getDate()
  return day <= 10 ? 'p3' : day <= 20 ? 'c1' : 'c2'
}
