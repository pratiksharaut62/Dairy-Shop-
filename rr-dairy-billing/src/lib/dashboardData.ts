import { db } from '../db'
import type { Bill } from '../db/types'
import { round2 } from './money'
import { billFigures } from './billFigures'

/** Expense category used for GST paid to the government — a liability settlement, kept out of profit. */
export const GST_PAYMENT_CATEGORY = 'GST / Taxes'
import { DAY, fmtDayShort, startOfDay } from './dates'

export type DashRange = 'today' | '7d' | '30d'
export const RANGE_DAYS: Record<DashRange, number> = { today: 1, '7d': 7, '30d': 30 }

/** `sales` is what customers paid (GST included); `net` is sales excluding GST, which is what profit is worked out on. */
export interface PeriodTotals { sales: number; net: number; bills: number; pieces: number; cost: number; expenses: number; profit: number }

export interface DashboardData {
  cur: PeriodTotals
  prev: PeriodTotals
  series: Array<{ start: number; label: string; total: number; bills: number }>
  byMode: Array<[string, number]>
  topItems: Array<{ name: string; qty: number; value: number }>
  recent: Bill[]
  stock: {
    value: number
    units: number
    outOfStock: number
    lowCount: number
    low: Array<{ id: string; name: string; sku: string; size: string; color: string; stock: number; reorderLevel: number }>
  }
  hasAnyBills: boolean
}

/**
 * Everything the dashboard shows, computed in a single pass.
 *
 * Why this exists: the old screen loaded the *entire* bills and expenses
 * tables on every change and then did `variants.find()` inside nested loops
 * to cost each sale (O(bills × items × variants)). Here only the date window
 * actually displayed is read through the `date` index, costs come from a Map
 * (O(1) per item), and bills are walked once. Cost is fine with 100k bills.
 *
 * The comparison window is the same length shifted back, ending at the same
 * clock time — so a half-finished trading day isn't compared with a full one.
 */
export async function loadDashboard(range: DashRange): Promise<DashboardData> {
  const n = RANGE_DAYS[range]
  const now = Date.now()
  const curStart = startOfDay(now - (n - 1) * DAY)
  const prevStart = curStart - n * DAY
  const prevEnd = now - n * DAY
  const chartDays = Math.max(n, 7)
  const chartStart = startOfDay(now - (chartDays - 1) * DAY)
  const since = Math.min(prevStart, chartStart)

  const [bills, expenses, variants, latest, anyBill] = await Promise.all([
    db.bills.where('date').aboveOrEqual(since).toArray(),
    db.expenses.where('date').aboveOrEqual(since).toArray(),
    db.variants.toArray(),
    db.bills.orderBy('date').reverse().limit(24).toArray(),
    db.bills.limit(1).count(),
  ])

  const costOf = new Map<string, number>()
  for (const v of variants) costOf.set(v.id, v.cost)

  const blank = (): PeriodTotals => ({ sales: 0, net: 0, bills: 0, pieces: 0, cost: 0, expenses: 0, profit: 0 })
  const cur = blank()
  const prev = blank()
  const modes = new Map<string, number>()
  const items = new Map<string, { name: string; qty: number; value: number }>()
  const series = Array.from({ length: chartDays }, (_, i) => {
    const start = chartStart + i * DAY
    return { start, label: fmtDayShort(start), total: 0, bills: 0 }
  })

  for (const b of bills) {
    if (b.status === 'held') continue
    const inCur = b.date >= curStart && b.date <= now
    const inPrev = b.date >= prevStart && b.date <= prevEnd
    const t: PeriodTotals | null = inCur ? cur : inPrev ? prev : null
    const f = billFigures(b, (vid) => costOf.get(vid) ?? 0)
    if (t) {
      t.sales += b.total
      t.net += f.net
      t.pieces += f.pieces
      t.cost += f.cost
      if (b.total > 0) t.bills++
    }
    if (inCur) {
      for (const p of b.payments) modes.set(p.mode, (modes.get(p.mode) ?? 0) + p.amount)
      if (b.total > 0) {
        for (const it of b.items) {
          const row = items.get(it.name) ?? { name: it.name, qty: 0, value: 0 }
          row.qty += it.qty
          row.value += it.lineTotal
          items.set(it.name, row)
        }
      }
    }
    const idx = Math.floor((startOfDay(b.date) - chartStart) / DAY)
    if (idx >= 0 && idx < chartDays) {
      series[idx].total += b.total
      if (b.total > 0) series[idx].bills++
    }
  }

  for (const e of expenses) {
    // Paying GST to the government settles a liability — it is not a cost of running the shop.
    if (e.category === GST_PAYMENT_CATEGORY) continue
    if (e.date >= curStart && e.date <= now) cur.expenses += e.amount
    else if (e.date >= prevStart && e.date <= prevEnd) prev.expenses += e.amount
  }
  for (const t of [cur, prev]) {
    t.sales = round2(t.sales); t.net = round2(t.net); t.cost = round2(t.cost); t.expenses = round2(t.expenses)
    t.profit = round2(t.net - t.cost - t.expenses)
  }

  // Stock health from variants alone; product names are fetched only for the
  // handful of rows actually displayed instead of joining the whole catalogue.
  let value = 0
  let units = 0
  let outOfStock = 0
  const lowVariants = []
  for (const v of variants) {
    value += v.cost * v.stock
    units += v.stock
    if (v.stock <= 0) outOfStock++
    if (v.stock <= v.reorderLevel) lowVariants.push(v)
  }
  lowVariants.sort((a, b) => a.stock - b.stock)
  const shown = lowVariants.slice(0, 8)
  const products = await db.products.bulkGet([...new Set(shown.map((v) => v.productId))])
  const nameOf = new Map(products.filter(Boolean).map((p) => [p!.id, p!.name]))

  return {
    cur, prev,
    series: series.map((s) => ({ ...s, total: round2(s.total) })),
    byMode: [...modes.entries()].map(([m, v]) => [m, round2(v)] as [string, number]).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]),
    topItems: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 6).map((r) => ({ ...r, value: round2(r.value) })),
    recent: latest.filter((b) => b.status !== 'held').slice(0, 8),
    stock: {
      value: round2(value), units, outOfStock, lowCount: lowVariants.length,
      low: shown.map((v) => ({
        id: v.id, name: nameOf.get(v.productId) ?? 'Unknown item', sku: v.sku, size: v.size, color: v.color,
        stock: v.stock, reorderLevel: v.reorderLevel,
      })),
    },
    hasAnyBills: anyBill > 0,
  }
}
