import type { TaxSlab } from '../lib/gst'

export type Role = 'owner' | 'manager' | 'cashier'

export interface User {
  id: string
  name: string
  role: Role
  pin: string
  active: boolean
}

export interface StoreSettings {
  id: 'store'
  name: string
  tagline: string
  address: string
  city: string
  phone: string
  email: string
  gstin: string
  invoicePrefix: string
  nextInvoiceNo: number
  slabs: TaxSlab[]
  priceIncludesTax: boolean
  receiptWidth: '58mm' | '80mm'
  returnPolicy: string
  footerNote: string
  loyaltyEarnPct: number     // points earned per ₹100 spent
  loyaltyRedeemValue: number // ₹ value of 1 point
  maxCashierDiscountPct: number
  lowStockDefault: number
  /** What the printed bill shows (see lib/receiptOptions.ts). Missing on older records: tax/HSN default to hidden. */
  receiptShowTax?: boolean
  receiptShowHsn?: boolean
  receiptShowSavings?: boolean
  receiptShowLoyalty?: boolean
  /** Cloud backend, optional — leave blank and the app stays exactly as offline-only as it's always been. */
  syncApiUrl: string
  syncStoreId: string
  /** Receipt printer, optional — 'browser' (default) keeps using the OS print dialog; the other two send raw ESC/POS bytes directly, desktop shell only. */
  printerMode: PrinterMode
  printerSerialPath: string
  printerBaud: number
  printerHost: string
  printerPort: number
  /** Physical barcode sticker size, in mm — one *row* per printed page, so
   *  this must match the roll/die-cut stock actually loaded in the printer.
   *  Most label printers feed a single column (labelsAcross: 1), but some
   *  rolls carry two or more labels side by side per row — labelsAcross and
   *  labelGapMm describe that layout; a page is `labelsAcross` labels wide
   *  plus `labelsAcross - 1` gaps, and exactly `labelHeightMm` tall. */
  labelWidthMm: number
  labelHeightMm: number
  labelsAcross: number
  labelGapMm: number
}

export type PrinterMode = 'browser' | 'usbSerial' | 'network'

export interface Category {
  id: string
  name: string
  group: string // Men / Women / Kids / Accessories
}

export interface Product {
  id: string
  styleCode: string
  name: string
  categoryId: string
  brand: string
  fabric: string
  season: string
  hsn: string
  /** Dairy: how the product is measured/sold (L, kg, pcs) — drives labels and quantity steps. */
  unit?: string
  /** Dairy: days from production/receipt until expiry. 0 / missing = does not expire. */
  shelfLifeDays?: number
  /** Dairy: GST % for this product (milk 0, paneer 5 …). When set it wins over the store's price slabs. */
  taxRate?: number
  active: boolean
  createdAt: number
}

export interface Variant {
  id: string
  productId: string
  sku: string
  barcode: string
  size: string
  color: string
  cost: number
  mrp: number
  price: number
  stock: number
  reorderLevel: number
}

export interface Supplier {
  id: string
  name: string
  phone: string
  gstin: string
  address: string
  openingBalance: number
}

export interface PurchaseItem {
  variantId: string
  qty: number
  cost: number
}

export interface Purchase {
  id: string
  no: string
  supplierId: string
  date: number
  invoiceRef: string
  items: PurchaseItem[]
  total: number
  paid: number
  notes: string
  userId: string
}

export interface Customer {
  id: string
  name: string
  phone: string
  email: string
  dob: string
  anniversary: string
  address: string
  gstin: string
  loyaltyPoints: number
  storeCredit: number
  createdAt: number
  notes: string
}

export type DiscountType = 'pct' | 'amt'

export interface BillItem {
  variantId: string
  sku: string
  barcode: string
  name: string
  size: string
  color: string
  hsn: string
  qty: number
  mrp: number
  price: number
  discountType: DiscountType
  discountValue: number
  discountAmount: number
  net: number
  taxable: number
  taxRate: number
  cgst: number
  sgst: number
  lineTotal: number
  returnedQty: number
  priceOverridden?: boolean
  /** Purchase cost of one piece at the moment of sale, so profit reports do not move when the cost is edited later. */
  cost?: number
}

export type PayMode = 'cash' | 'card' | 'upi' | 'credit'

export interface Payment {
  mode: PayMode
  amount: number
  ref?: string
}

export type BillStatus = 'paid' | 'held' | 'returned' | 'partial-return'

export interface Bill {
  id: string
  no: string
  date: number
  customerId: string | null
  items: BillItem[]
  grossMrp: number
  itemDiscount: number
  billDiscountType: DiscountType
  billDiscountValue: number
  billDiscount: number
  coupon: string
  subtotal: number
  taxableTotal: number
  cgstTotal: number
  sgstTotal: number
  taxTotal: number
  roundOff: number
  total: number
  payments: Payment[]
  paid: number
  changeDue: number
  loyaltyEarned: number
  loyaltyRedeemed: number
  creditUsed: number
  cashierId: string
  status: BillStatus
  refundOfBillId?: string
  refundAmount?: number
  notes: string
}

export type MoveType = 'opening' | 'purchase' | 'sale' | 'return' | 'adjust' | 'audit' | 'transfer'
  /** Dairy: raw milk accepted from a farmer, production in/out, a lot received from outside, approved wastage. */
  | 'collection' | 'production' | 'receipt' | 'wastage'

export interface StockMove {
  id: string
  variantId: string
  qty: number
  type: MoveType
  ref: string
  reason: string
  at: number
  userId: string
}

export type ExpenseMode = 'cash' | 'card' | 'upi' | 'bank'

export interface Expense {
  id: string
  date: number
  category: string
  amount: number
  mode: ExpenseMode
  vendor: string
  note: string
  recurring: boolean
  userId: string
}

export interface AuditLog {
  id: string
  at: number
  userId: string
  action: string
  detail: string
}

/** Cash drawer session — day open / day close (Z-report). */
export interface DaySession {
  id: string
  openedAt: number
  openedBy: string
  openingCash: number
  closedAt?: number
  closedBy?: string
  countedCash?: number
  expectedCash?: number
  variance?: number
  note?: string
}

export type SyncEntity = 'bill' | 'billReturn' | 'customer' | 'customerUpdate' | 'product' | 'productUpdate' | 'variant' | 'variantUpdate'
  | 'expense' | 'stockAdjust' | 'storeUpdate' | 'supplier' | 'supplierUpdate' | 'purchase' | 'session' | 'sessionUpdate'
  | 'user' | 'userUpdate'
  // Dairy
  | 'farmer' | 'farmerUpdate' | 'rateChart' | 'collection' | 'collectionDecision' | 'ledgerEntry' | 'settlement'
  | 'lot' | 'batch' | 'batchComplete' | 'delivery' | 'deliveryUpdate' | 'wastage' | 'wastageDecision'

/**
 * One outbound write, queued right after the write it describes (see
 * db/syncHooks.ts) and flushed to the backend in order — order matters
 * here (a product must reach the server before its variants).
 */
export interface OutboxEntry {
  id?: number
  entity: SyncEntity
  payload: unknown
  createdAt: number
  /** 0 = waiting to upload, 1 = uploaded, 2 = rejected by the server (set aside so it cannot block the queue; the full backups still hold the data). */
  synced: 0 | 1 | 2
  attempts: number
  lastError?: string
}


/* ───────────────────────────── Dairy ERP ───────────────────────────── */

export type MilkType = 'cow' | 'buffalo' | 'mixed'
export type CollectionSession = 'morning' | 'evening'

export interface Farmer {
  id: string
  /** Short code the collection operator types at the counter (F-001). */
  code: string
  name: string
  phone: string
  village: string
  address: string
  milkType: MilkType
  /** UPI id / bank details used when paying the settlement. */
  payoutDetails: string
  /** Amount already owed to (+) or by (−) the farmer when they were added. */
  openingBalance: number
  active: boolean
  createdAt: number
}

/** One cell of the rate chart: milk whose Fat and SNF both fall inside the ranges is paid `rate` per litre. */
export interface RateSlab {
  fatMin: number
  fatMax: number
  snfMin: number
  snfMax: number
  rate: number
}

export interface RateChart {
  id: string
  name: string
  milkType: MilkType
  /** The chart applies to collections made on or after this moment, until a newer chart for the same milk takes over. */
  effectiveFrom: number
  slabs: RateSlab[]
  active: boolean
  createdAt: number
  createdBy: string
}

export type CollectionStatus = 'pending' | 'approved' | 'rejected'

export interface Collection {
  id: string
  no: string
  farmerId: string
  /** When the milk was received. */
  date: number
  session: CollectionSession
  milkType: MilkType
  qtyL: number
  fat: number
  snf: number
  /** Snapshot of the rate chart outcome at the time of collection — later chart edits never change it. */
  rate: number
  amount: number
  chartId: string
  status: CollectionStatus
  note: string
  collectedBy: string
  decidedBy?: string
  decidedAt?: number
  rejectReason?: string
  /** The raw-milk variant stock was added to when approved, and when that lot goes off. */
  variantId?: string
  lotExpiresAt?: number
}

export type LedgerType = 'opening' | 'collection' | 'advance' | 'deduction' | 'settlement'

/** Farmer account: positive = we owe the farmer, negative = the farmer owes us. */
export interface LedgerEntry {
  id: string
  farmerId: string
  at: number
  type: LedgerType
  amount: number
  ref: string
  note: string
  userId: string
}

export interface Settlement {
  id: string
  no: string
  farmerId: string
  periodFrom: number
  periodTo: number
  litres: number
  collectionAmount: number
  advances: number
  deductions: number
  /** Everything owed to the farmer at the moment of settlement (previous balance + period milk − advances − deductions). */
  payable: number
  paid: number
  mode: 'cash' | 'upi' | 'bank'
  ref: string
  notes: string
  paidAt: number
  userId: string
}

export type LotSource = 'collection' | 'production' | 'receipt'

/** A traceable quantity of one variant with its own expiry — raw milk from a collection, a production output, or stock received from outside. */
export interface Lot {
  id: string
  variantId: string
  lotNo: string
  source: LotSource
  /** Collection id / batch id / blank. */
  sourceRef: string
  qty: number
  available: number
  producedAt: number
  expiresAt?: number
  createdAt: number
}

export interface BatchInput { lotId: string; variantId: string; qty: number; label: string }
export interface BatchOutput { lotId: string; variantId: string; qty: number; expiresAt?: number; label: string }

export type BatchStatus = 'in-progress' | 'completed' | 'rejected'

export interface ProductionBatch {
  id: string
  no: string
  startedAt: number
  status: BatchStatus
  inputs: BatchInput[]
  outputs: BatchOutput[]
  notes: string
  qcNote: string
  completedAt?: number
  userId: string
}

export type DeliveryStatus = 'packed' | 'dispatched' | 'delivered' | 'failed'

export interface DeliveryItem { variantId: string; name: string; qty: number; deliveredQty: number }

export interface Delivery {
  id: string
  no: string
  customerId?: string
  billId?: string
  route: string
  vehicle: string
  driver: string
  scheduledAt: number
  status: DeliveryStatus
  items: DeliveryItem[]
  notes: string
  deliveredAt?: number
  createdAt: number
  userId: string
}

export type WastageReason = 'wastage' | 'damage' | 'expiry' | 'spillage' | 'sample'
export type WastageStatus = 'pending' | 'approved' | 'rejected'

export interface Wastage {
  id: string
  no: string
  variantId: string
  lotId?: string
  qty: number
  reason: WastageReason
  note: string
  /** Cost value of what is written off, for reports. */
  value: number
  status: WastageStatus
  at: number
  requestedBy: string
  decidedBy?: string
  decidedAt?: number
}
