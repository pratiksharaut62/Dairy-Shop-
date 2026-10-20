import type { Bill, Customer, StoreSettings, User } from '../db/types'
import { round2, amountInWords } from './money'
import { hsnSummary } from './gst'
import { receiptOptions } from './receiptOptions'
import { variantLabel } from './variantLabel'

const ESC = 0x1b
const GS = 0x1d

/** ESC/POS thermal printers use codepages without a ₹ glyph — Rs. prints cleanly everywhere. */
const money = (n: number) => 'Rs.' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Raw ESC/POS byte builder. Text is written as one byte per character
 * (Latin-1-ish, matching the printer's default codepage for ASCII text) —
 * fine for the store/product data this app deals with; anything outside
 * that range degrades to '?' rather than corrupting the byte stream.
 */
class EscPos {
  private bytes: number[] = []

  private push(...b: number[]) { this.bytes.push(...b); return this }

  text(s: string) {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i)
      this.bytes.push(code <= 0xff ? code : 0x3f)
    }
    return this
  }

  line(s = '') { return this.text(s).push(0x0a) }

  init() { return this.push(ESC, 0x40) }
  align(a: 'left' | 'center' | 'right') { return this.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2) }
  bold(on: boolean) { return this.push(ESC, 0x45, on ? 1 : 0) }
  /** GS ! n — bit 0-3 height multiplier, bit 4-7 width multiplier (0 = normal). */
  size(scale: 0 | 1) { return this.push(GS, 0x21, scale ? 0x11 : 0x00) }
  feed(n = 1) { return this.push(ESC, 0x64, n) }
  cut() { return this.push(GS, 0x56, 1) }
  /** Standard pin-2 cash-drawer kick most ESC/POS drawers/kick cables use. */
  openDrawer() { return this.push(ESC, 0x70, 0, 25, 250) }

  hr(width: number) { return this.line('-'.repeat(width)) }

  /** Left-aligned label, right-aligned value, padded to fill the paper width. */
  row(left: string, right: string, width: number) {
    const space = Math.max(1, width - left.length - right.length)
    return this.line(left + ' '.repeat(space) + right)
  }

  /** Code128 barcode via GS k — printed natively by the printer, no image needed. */
  barcode(data: string) {
    const clean = data.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
    if (!clean) return this
    return this.push(GS, 0x68, 60) // height ~60 dots
      .push(GS, 0x77, 2) // module width
      .push(GS, 0x48, 2) // print HRI text below the bars
      .push(GS, 0x6b, 73, clean.length) // GS k m=73 (CODE128) n
      .text(clean)
  }

  build() { return new Uint8Array(this.bytes) }
}

const MODE_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', credit: 'Store Credit' }

const dt = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Builds a full receipt as raw ESC/POS bytes, mirroring the layout of
 * print/Receipt.tsx (the browser-print version) so both paths agree on
 * what a receipt says — this one just says it in printer control codes
 * instead of HTML.
 */
export function buildReceiptEscPos(bill: Bill, settings: StoreSettings, customer: Customer | null | undefined, cashier: User | null | undefined): Uint8Array {
  const width = settings.receiptWidth === '58mm' ? 32 : 42
  const isReturn = bill.status === 'returned' && !!bill.refundOfBillId
  const hsn = hsnSummary(bill.items.map((i) => ({ hsn: i.hsn, taxable: i.taxable, cgst: i.cgst, sgst: i.sgst, taxRate: i.taxRate, qty: i.qty })))
  const savings = round2(bill.itemDiscount + bill.billDiscount)
  const opt = receiptOptions(settings)

  const p = new EscPos().init()

  p.align('center').bold(true).size(1).line(settings.name).size(0).bold(false)
  if (settings.tagline) p.line(settings.tagline)
  if (settings.address) p.line(settings.address)
  if (settings.city) p.line(settings.city)
  p.line(`Ph: ${settings.phone}`)
  if (settings.gstin) p.line(`GSTIN: ${settings.gstin}`)
  p.align('left').hr(width)
  p.align('center').bold(true).line(isReturn ? 'CREDIT NOTE' : 'TAX INVOICE').bold(false).align('left')
  p.hr(width)

  p.row('Bill No', bill.no, width)
  p.row('Date', dt(bill.date), width)
  p.row('Cashier', cashier?.name ?? '—', width)
  if (customer) p.row('Customer', customer.name, width)
  if (customer?.phone) p.row('Mobile', customer.phone, width)
  if (customer?.gstin) p.row('Cust GSTIN', customer.gstin, width)
  if (isReturn) p.row('Against', bill.notes.replace('Return against ', ''), width)
  p.hr(width)

  for (const [i, it] of bill.items.entries()) {
    p.bold(true).line(`${i + 1}. ${it.name}`).bold(false)
    p.line([variantLabel(it.size, it.color), it.sku].filter(Boolean).join(' . '))
    if (it.mrp > it.price) p.row(`MRP ${money(it.mrp)}`, `Price ${money(it.price)}`, width)
    const left = `${it.qty} x ${money(it.price)}${it.discountAmount > 0 ? ` (-${money(it.discountAmount)})` : ''}`
    p.row(left, money(it.lineTotal), width)
  }
  p.hr(width)

  p.row('Items / Qty', `${bill.items.length} / ${bill.items.reduce((s, i) => s + i.qty, 0)}`, width)
  p.row('Gross (MRP)', money(bill.grossMrp), width)
  if (savings > 0) p.row('Discount', '-' + money(savings), width)
  if (opt.showTax) {
    p.row('Taxable Value', money(bill.taxableTotal), width)
    p.row('CGST', money(bill.cgstTotal), width)
    p.row('SGST', money(bill.sgstTotal), width)
  }
  if (bill.roundOff !== 0) p.row('Round Off', money(bill.roundOff), width)
  p.hr(width)

  p.bold(true).size(1).row(isReturn ? 'REFUND' : 'TOTAL', money(Math.abs(bill.total)), Math.floor(width * 0.7)).size(0).bold(false)
  p.line(amountInWords(Math.abs(bill.total)))
  if (!opt.showTax) p.line('Inclusive of all taxes')
  p.hr(width)

  for (const pay of bill.payments) p.row(MODE_LABEL[pay.mode] ?? pay.mode, money(Math.abs(pay.amount)), width)
  if (bill.changeDue > 0) p.bold(true).row('Change', money(bill.changeDue), width).bold(false)

  if (opt.showSavings && savings > 0 && !isReturn) {
    p.hr(width)
    p.align('center').bold(true).line(`You saved ${money(savings)} on this bill!`).bold(false).align('left')
  }
  if (opt.showLoyalty && customer && (bill.loyaltyEarned > 0 || customer.loyaltyPoints > 0)) {
    p.line(`Loyalty: +${bill.loyaltyEarned} pts earned`)
  }
  p.hr(width)

  if (opt.showHsn) {
    p.bold(true).line('HSN Summary').bold(false)
    p.row('HSN', 'Rate   Taxable    Tax', width)
    for (const h of hsn) p.row(h.hsn, `${h.rate}%  ${h.taxable.toFixed(2)}  ${(h.cgst + h.sgst).toFixed(2)}`, width)
    p.hr(width)
  }

  if (settings.returnPolicy) p.align('center').line(settings.returnPolicy)
  p.feed(1).align('center').barcode(bill.no).feed(1)
  if (settings.footerNote) p.bold(true).line(settings.footerNote).bold(false)
  p.line('RR Dairy')
  p.feed(3)

  if (!isReturn && bill.payments.some((pay) => pay.mode === 'cash')) p.openDrawer()

  p.cut()
  return p.build()
}

/** Settings → printer "Test print" button — proves the connection and paper width without needing a real bill. */
export function buildTestPrintEscPos(settings: StoreSettings): Uint8Array {
  const width = settings.receiptWidth === '58mm' ? 32 : 42
  return new EscPos()
    .init()
    .align('center').bold(true).size(1).line(settings.name || 'RR Dairy').size(0).bold(false)
    .line('Printer test').hr(width)
    .line(`Paper width: ${settings.receiptWidth}`)
    .line(`Printed: ${new Date().toLocaleString('en-IN')}`)
    .hr(width)
    .align('center').line('If you can read this, the printer').line('is connected correctly.')
    .feed(3).cut()
    .build()
}

/** Settings → printer "Open cash drawer" button — just the kick pulse, no receipt. */
export function buildDrawerKickEscPos(): Uint8Array {
  return new EscPos().init().openDrawer().build()
}
