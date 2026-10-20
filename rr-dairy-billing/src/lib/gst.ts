import { round2 } from './money'

export interface TaxSlab {
  /** Rate applies when the per-piece taxable value is <= threshold. Use Infinity for the top slab. */
  upto: number
  rate: number
}

/**
 * Fallback for a product that has no GST rate of its own: a flat 5 % at every price. Dairy products normally carry
 * their own rate (milk 0 %, paneer 5 %, ghee 12 % …) set on the product, which always wins over these slabs.
 * Editable in Settings — confirm the rates with the shop's accountant, as they change with notifications.
 */
export const DEFAULT_SLABS: TaxSlab[] = [
  { upto: Number.MAX_SAFE_INTEGER, rate: 5 },
]

export function rateFor(perPieceTaxable: number, slabs: TaxSlab[]): number {
  const sorted = [...slabs].sort((a, b) => a.upto - b.upto)
  for (const s of sorted) if (perPieceTaxable <= s.upto) return s.rate
  return sorted[sorted.length - 1]?.rate ?? 0
}

export interface LineTaxResult {
  taxable: number
  rate: number
  cgst: number
  sgst: number
  tax: number
  gross: number
}

/**
 * Splits a line's net amount into taxable value + CGST/SGST.
 * In Indian retail the tag price is tax-inclusive, so `inclusive` back-calculates;
 * set it false for exclusive pricing (B2B style).
 *
 * The slab is chosen on the per-piece amount the customer actually pays after
 * discount. Deciding it on the back-calculated ex-tax value instead leaves a dead
 * band around the threshold where neither rate is self-consistent (a ₹1,099 tag is
 * over ₹1,000 at 5% but under it at 12%), and "tag price per piece" is the rule
 * shops and their accountants work to anyway.
 */
export function computeLineTax(
  netAmount: number,
  qty: number,
  slabs: TaxSlab[],
  inclusive: boolean,
  /** A product's own GST % (dairy: milk 0, paneer 5 …). When given it is used instead of the price slabs. */
  fixedRate?: number,
): LineTaxResult {
  const perPiece = qty > 0 ? netAmount / qty : netAmount
  const rate = fixedRate !== undefined && fixedRate !== null ? fixedRate : rateFor(perPiece, slabs)

  const taxable = inclusive ? round2(netAmount / (1 + rate / 100)) : round2(netAmount)
  const tax = round2(inclusive ? netAmount - taxable : (netAmount * rate) / 100)
  const cgst = round2(tax / 2)
  const sgst = round2(tax - cgst)
  return { taxable, rate, cgst, sgst, tax: round2(cgst + sgst), gross: round2(taxable + cgst + sgst) }
}

/** Groups lines into an HSN-wise summary block for the tax invoice and the GST report. */
export function hsnSummary<T extends { hsn: string; taxable: number; cgst: number; sgst: number; taxRate: number; qty: number }>(
  lines: T[],
) {
  const map = new Map<string, { hsn: string; rate: number; qty: number; taxable: number; cgst: number; sgst: number }>()
  for (const l of lines) {
    const key = `${l.hsn}|${l.taxRate}`
    const row = map.get(key) ?? { hsn: l.hsn || '—', rate: l.taxRate, qty: 0, taxable: 0, cgst: 0, sgst: 0 }
    row.qty += l.qty
    row.taxable = round2(row.taxable + l.taxable)
    row.cgst = round2(row.cgst + l.cgst)
    row.sgst = round2(row.sgst + l.sgst)
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
}
