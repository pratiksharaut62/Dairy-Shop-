import type { MilkType, RateChart, RateSlab } from '../db/types'
import { round2 } from './money'

/**
 * Milk is paid by quality. A rate chart is a grid of Fat % × SNF % cells, each with a ₹/litre rate.
 * A cell matches when  fatMin ≤ fat < fatMax  and  snfMin ≤ snf < snfMax  (lower bound included, upper bound not,
 * so adjacent cells never overlap and never leave a gap). If a hand-edited chart does overlap, the cell with the
 * highest fat floor, then the highest SNF floor, wins. The backend uses exactly the same rule (dairy.rates.ts).
 */
export function slabFor(slabs: RateSlab[], fat: number, snf: number): RateSlab | null {
  let best: RateSlab | null = null
  for (const s of slabs) {
    if (fat < s.fatMin || fat >= s.fatMax || snf < s.snfMin || snf >= s.snfMax) continue
    if (!best || s.fatMin > best.fatMin || (s.fatMin === best.fatMin && s.snfMin > best.snfMin)) best = s
  }
  return best
}

/** The chart in force for this milk at this moment: active, already started, newest start date wins. */
export function chartFor(charts: RateChart[], milkType: MilkType, at: number): RateChart | null {
  return charts
    .filter((c) => c.active && c.milkType === milkType && c.effectiveFrom <= at)
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] ?? null
}

export type Quote =
  | { ok: true; chart: RateChart; slab: RateSlab; rate: number; amount: number }
  | { ok: false; error: string }

export function quoteMilk(charts: RateChart[], milkType: MilkType, fat: number, snf: number, qtyL: number, at: number): Quote {
  const chart = chartFor(charts, milkType, at)
  if (!chart) return { ok: false, error: `No active rate chart for ${milkType} milk. Add one in Rate Chart first.` }
  const slab = slabFor(chart.slabs, fat, snf)
  if (!slab) return { ok: false, error: `Fat ${fat}% / SNF ${snf}% is outside the "${chart.name}" chart — extend the chart or check the reading.` }
  return { ok: true, chart, slab, rate: slab.rate, amount: round2(qtyL * slab.rate) }
}

export interface GridOptions {
  fatFrom: number; fatTo: number; fatStep: number
  snfFrom: number; snfTo: number; snfStep: number
  /** Rate at the lowest cell, then how much each extra 0.1 % of Fat / SNF adds. */
  baseRate: number; perFatPoint: number; perSnfPoint: number
}

const r1 = (n: number) => Math.round(n * 100) / 100

/** Builds a full chart from a base rate and a per-point increment — the usual way a dairy prices its milk. */
export function generateGrid(o: GridOptions): RateSlab[] {
  const out: RateSlab[] = []
  for (let f = o.fatFrom; f < o.fatTo - 1e-9; f = r1(f + o.fatStep)) {
    for (let s = o.snfFrom; s < o.snfTo - 1e-9; s = r1(s + o.snfStep)) {
      const rate = o.baseRate + ((f - o.fatFrom) / 0.1) * o.perFatPoint + ((s - o.snfFrom) / 0.1) * o.perSnfPoint
      out.push({ fatMin: r1(f), fatMax: r1(f + o.fatStep), snfMin: r1(s), snfMax: r1(s + o.snfStep), rate: round2(Math.max(0, rate)) })
    }
  }
  return out
}

export function validateSlabs(slabs: RateSlab[]): string | null {
  if (!slabs.length) return 'Add at least one rate cell.'
  for (const s of slabs) {
    if (!(s.fatMax > s.fatMin) || !(s.snfMax > s.snfMin)) return 'Every cell needs "to" larger than "from" for Fat and SNF.'
    if (!(s.rate >= 0)) return 'Rates cannot be negative.'
  }
  return null
}

export const MILK_LABEL: Record<MilkType, string> = { cow: 'Cow', buffalo: 'Buffalo', mixed: 'Mixed' }

/** Sanity limits for a lab reading so a typo (35 instead of 3.5) cannot be saved. */
export const FAT_RANGE: [number, number] = [0.5, 15]
export const SNF_RANGE: [number, number] = [5, 12]
