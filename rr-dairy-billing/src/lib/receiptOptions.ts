import type { StoreSettings } from '../db/types'

/**
 * What a printed bill shows. One definition for the browser receipt (print/Receipt.tsx) and the thermal printer
 * (lib/escpos.ts) so both always say the same thing. A GST tax invoice normally carries the CGST/SGST split and an
 * HSN summary, so those are opt-in here — and the A4 invoice (print/Invoice.tsx) always shows them regardless.
 */
export interface ReceiptOptions {
  /** Taxable value, CGST and SGST rows. */
  showTax: boolean
  /** The HSN summary block at the foot. */
  showHsn: boolean
  /** "You saved ₹… on this bill!" */
  showSavings: boolean
  /** "Loyalty: +N pts earned". */
  showLoyalty: boolean
}

export function receiptOptions(s: Partial<Pick<StoreSettings, 'receiptShowTax' | 'receiptShowHsn' | 'receiptShowSavings' | 'receiptShowLoyalty'>>): ReceiptOptions {
  return {
    showTax: s.receiptShowTax === true,
    showHsn: s.receiptShowHsn === true,
    showSavings: s.receiptShowSavings !== false,
    showLoyalty: s.receiptShowLoyalty !== false,
  }
}
