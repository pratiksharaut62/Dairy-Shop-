import type { Bill } from '../db/types'
import { round2 } from './money'

/**
 * The numbers one bill contributes to a report, all signed: a credit note (a return) has a negative `total` and
 * subtracts everything — sales, tax, pieces, cost and discount — so any sum over a period is already net of returns.
 *
 * Reports and the dashboard both use this, so they can never disagree about what a return does to profit.
 */
export interface BillFigures {
  sign: 1 | -1
  /** What the customer paid (or was refunded), GST included, after round-off. Equals `bill.total`. */
  total: number
  /** The shop's own sales value: taxable value, GST excluded. This is what profit is calculated on. */
  net: number
  /** CGST + SGST collected — money held for the government, not income. */
  gst: number
  pieces: number
  /** Cost of the goods on the bill: the cost recorded when it was sold, else the variant's current cost. */
  cost: number
  /** Discount actually given at the counter (line discounts + the bill-level share), not the gap to MRP. */
  discount: number
}

export function billFigures(b: Bill, currentCost: (variantId: string) => number): BillFigures {
  // A credit note always points at the bill it returns; the sign of the total alone would miss a return worth exactly zero.
  const sign = b.total < 0 || !!b.refundOfBillId ? -1 : 1
  let net = 0, gst = 0, pieces = 0, cost = 0, discount = 0
  for (const i of b.items) {
    net += i.taxable
    gst += i.cgst + i.sgst
    pieces += i.qty
    cost += (i.cost ?? currentCost(i.variantId)) * i.qty
    discount += i.discountAmount
  }
  return {
    sign,
    total: b.total,
    net: round2(net * sign),
    gst: round2(gst * sign),
    pieces: pieces * sign,
    cost: round2(cost * sign),
    discount: round2(discount * sign),
  }
}
