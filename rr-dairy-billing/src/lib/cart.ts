import type { BillItem, DiscountType } from '../db/types'
import { computeLineTax, type TaxSlab } from './gst'
import { round2, roundOff } from './money'

export interface CartLine {
  variantId: string
  /** Which product this size belongs to — groups lines and powers the size swap. */
  productId?: string
  sku: string
  barcode: string
  name: string
  size: string
  color: string
  hsn: string
  mrp: number
  price: number
  qty: number
  stock: number
  discountType: DiscountType
  discountValue: number
  priceOverridden?: boolean
  /** Purchase cost per piece, copied onto the bill line when it is sold. */
  cost?: number
  /** The product's own GST %, when it has one (overrides the store's price slabs). */
  taxRate?: number
}

export interface CartTotals {
  items: BillItem[]
  grossMrp: number
  itemDiscount: number
  billDiscount: number
  subtotal: number
  taxableTotal: number
  cgstTotal: number
  sgstTotal: number
  taxTotal: number
  roundOff: number
  total: number
  qtyTotal: number
}

export function lineDiscount(line: CartLine): number {
  const gross = line.price * line.qty
  const d = line.discountType === 'pct'
    ? (gross * line.discountValue) / 100
    : line.discountValue
  return round2(Math.min(Math.max(d, 0), gross))
}

/**
 * Prices the whole cart. A bill-level discount is spread across lines in proportion
 * to their value, so each line's GST slab is decided on what the customer actually pays.
 */
export function priceCart(
  lines: CartLine[],
  billDiscountType: DiscountType,
  billDiscountValue: number,
  slabs: TaxSlab[],
  priceIncludesTax: boolean,
): CartTotals {
  const grossMrp = round2(lines.reduce((s, l) => s + l.mrp * l.qty, 0))

  const netBeforeBill = lines.map((l) => round2(l.price * l.qty - lineDiscount(l)))
  const sumNet = round2(netBeforeBill.reduce((s, n) => s + n, 0))

  const rawBillDiscount = billDiscountType === 'pct'
    ? (sumNet * billDiscountValue) / 100
    : billDiscountValue
  const billDiscount = round2(Math.min(Math.max(rawBillDiscount, 0), sumNet))

  // Distribute proportionally; the last line absorbs the rounding remainder.
  const shares = netBeforeBill.map((n) => (sumNet > 0 ? round2((billDiscount * n) / sumNet) : 0))
  const drift = round2(billDiscount - shares.reduce((s, v) => s + v, 0))
  // The last line absorbs the rounding remainder, but never so much that it ends up below zero (a 100% discount).
  if (shares.length) {
    const last = shares.length - 1
    shares[last] = Math.min(round2(shares[last] + drift), netBeforeBill[last])
  }

  const items: BillItem[] = lines.map((l, i) => {
    const itemDisc = lineDiscount(l)
    const net = round2(netBeforeBill[i] - shares[i])
    const t = computeLineTax(net, l.qty, slabs, priceIncludesTax, l.taxRate)
    return {
      variantId: l.variantId,
      sku: l.sku,
      barcode: l.barcode,
      name: l.name,
      size: l.size,
      color: l.color,
      hsn: l.hsn,
      qty: l.qty,
      mrp: l.mrp,
      price: l.price,
      discountType: l.discountType,
      discountValue: l.discountValue,
      discountAmount: round2(itemDisc + shares[i]),
      net,
      taxable: t.taxable,
      taxRate: t.rate,
      cgst: t.cgst,
      sgst: t.sgst,
      lineTotal: priceIncludesTax ? net : t.gross,
      returnedQty: 0,
      priceOverridden: l.priceOverridden,
      cost: l.cost,
    }
  })

  const taxableTotal = round2(items.reduce((s, i) => s + i.taxable, 0))
  const cgstTotal = round2(items.reduce((s, i) => s + i.cgst, 0))
  const sgstTotal = round2(items.reduce((s, i) => s + i.sgst, 0))
  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0))
  const [total, off] = roundOff(subtotal)

  return {
    items,
    grossMrp,
    itemDiscount: round2(grossMrp - sumNet),
    billDiscount,
    subtotal,
    taxableTotal,
    cgstTotal,
    sgstTotal,
    taxTotal: round2(cgstTotal + sgstTotal),
    roundOff: off,
    total,
    qtyTotal: lines.reduce((s, l) => s + l.qty, 0),
  }
}
