import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { findByBarcode, loadVariantViews, nextInvoiceNo, saveBill, type VariantView } from '../db/ops'
import { lineDiscount, priceCart, type CartLine } from '../lib/cart'
import { inr, round2 } from '../lib/money'
import { id } from '../lib/id'
import { useApp } from '../state'
import { usePrint } from '../print/PrintProvider'
import { Invoice } from '../print/Invoice'
import { printReceiptSmart } from '../print/printReceipt'
import { Modal, Field, Empty } from '../components/ui'
import { ItemSearchDrop, NoMatch } from '../components/ItemSearch'
import { CartRow } from '../components/CartRow'
import { SaleDone } from '../components/SaleDone'
import { buildIndex, firstSellable, parseQuery, searchGroups, sizeRank } from '../lib/posSearch'
import {
  CardIcon, CashIcon, ChevronDown, Close, InventoryIcon, ParkedIcon, Plus, Printer, ScanIcon, TrashIcon, UpiIcon, UserIcon,
} from '../components/icons'
import type { Bill, Customer, DiscountType, PayMode, Payment } from '../db/types'

const PAY_MODES: Array<{ mode: PayMode; label: string; icon: ReactNode }> = [
  { mode: 'cash', label: 'Cash', icon: <CashIcon /> },
  { mode: 'upi', label: 'UPI', icon: <UpiIcon /> },
  { mode: 'card', label: 'Card', icon: <CardIcon /> },
]

/** Trails a fast-changing value so heavy work (search) runs once typing pauses, not on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export default function POS() {
  const navigate = useNavigate()
  const { user, settings, toast, can } = useApp()
  const { print } = usePrint()

  const variants = useLiveQuery(() => loadVariantViews(), [], [] as VariantView[]) ?? []
  const customers = useLiveQuery(() => db.customers.toArray(), [], [] as Customer[]) ?? []
  const heldBills = useLiveQuery(() => db.bills.where('status').equals('held').toArray(), [], [] as Bill[]) ?? []

  const [lines, setLines] = useState<CartLine[]>([])
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [activeVar, setActiveVar] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [swapping, setSwapping] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [billDiscountType, setBillDiscountType] = useState<DiscountType>('pct')
  const [billDiscountValue, setBillDiscountValue] = useState(0)
  const [coupon, setCoupon] = useState('')
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [showCustomer, setShowCustomer] = useState(false)
  const [showPay, setShowPay] = useState(false)
  const [showHeld, setShowHeld] = useState(false)
  const [showQuick, setShowQuick] = useState(false)
  const [cartSheetOpen, setCartSheetOpen] = useState(false)
  const [discOpen, setDiscOpen] = useState(false)
  const [taxOpen, setTaxOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastBill, setLastBill] = useState<Bill | null>(null)
  // The most recent finished sale (and who it was for) stays reachable after the dialog closes,
  // so a receipt that wasn't printed straight away can still be printed.
  const [recent, setRecent] = useState<{ bill: Bill; customer: Customer | null } | null>(null)
  const [reopened, setReopened] = useState(false)
  const scanRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const slabs = settings?.slabs ?? []
  const totals = useMemo(
    () => priceCart(lines, billDiscountType, billDiscountValue, slabs, settings?.priceIncludesTax ?? true),
    [lines, billDiscountType, billDiscountValue, slabs, settings?.priceIncludesTax],
  )

  const hasDiscount = billDiscountValue > 0 || coupon !== ''
  // Keep the discount fields open whenever a discount is active, e.g. after resuming a parked bill.
  useEffect(() => { if (hasDiscount) setDiscOpen(true) }, [hasDiscount])
  // A complete 10-digit number that isn't a known customer: offer to add them.
  const isNewCustomerNumber = customerPhone.length === 10 && !customers.some((c) => c.phone === customerPhone)

  const focusScan = () => scanRef.current?.focus()
  useEffect(() => { focusScan() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); focusScan() }
      if (e.key === 'F4' && lines.length) { e.preventDefault(); setShowPay(true) }
      if (e.key === 'F3') { e.preventDefault(); setShowCustomer(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lines.length])

  // The product index is rebuilt only when the catalogue changes; each keystroke just filters it.
  const index = useMemo(() => buildIndex(variants), [variants])
  const deferredQuery = useDebounced(query, 80)
  const parsed = useMemo(() => parseQuery(deferredQuery), [deferredQuery])
  const results = useMemo(() => searchGroups(index, parsed.tokens), [index, parsed])
  const cartQty = useMemo(() => new Map(lines.map((l) => [l.variantId, l.qty])), [lines])
  const showDrop = query.trim().length >= 2 && !dismissed
  const noMatch = showDrop && query === deferredQuery && parsed.tokens.length > 0 && results.length === 0

  // New results → cursor back on the top product, Esc-dismissal cleared.
  useEffect(() => { setHighlight(0); setDismissed(false) }, [results])
  // Cursor lands on the first size that can actually be sold.
  useEffect(() => {
    const r = results[highlight]
    setActiveVar(r ? Math.max(0, firstSellable(r)) : 0)
  }, [results, highlight])
  useEffect(() => {
    dropRef.current?.querySelectorAll('.sd-group')[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  /** ←/→ steps through the highlighted product's sizes, skipping sold-out ones. */
  function stepSize(dir: 1 | -1) {
    const r = results[highlight]
    if (!r) return
    for (let i = 1; i <= r.variants.length; i++) {
      const j = (activeVar + dir * i + r.variants.length * 2) % r.variants.length
      if (r.variants[j].stock > 0) { setActiveVar(j); return }
    }
  }

  const topSellers = useMemo(() => [...variants].sort((a, b) => b.stock - a.stock).slice(0, 18), [variants])

  function addVariant(v: VariantView, qty = 1) {
    if (v.stock <= 0) { toast(`${v.productName}${v.size ? ` (${v.size})` : ''} is out of stock`, 'err'); return }
    setLines((prev) => {
      const i = prev.findIndex((l) => l.variantId === v.id)
      if (i >= 0) {
        const next = [...prev]
        const wanted = next[i].qty + qty
        if (wanted > v.stock) { toast(`Only ${v.stock} left in stock`, 'err'); return prev }
        next[i] = { ...next[i], qty: wanted }
        return next
      }
      return [{
        variantId: v.id, productId: v.productId, sku: v.sku, barcode: v.barcode, name: v.productName,
        size: v.size, color: v.color, hsn: v.hsn, mrp: v.mrp, price: v.price, cost: v.cost,
        qty, stock: v.stock, discountType: 'pct', discountValue: 0, taxRate: v.taxRate,
      }, ...prev]
    })
    setSelected(v.id)
    setFlashId(v.id)
    setTimeout(() => setFlashId(null), 500)
    setQuery('')
  }

  async function handleScanOrSearch() {
    const p = parseQuery(query)
    if (!p.term) return
    // An exact barcode/SKU hit always wins — it's what a real scanner just
    // fired, not a fuzzy match the user is browsing with the arrow keys.
    const hit = await findByBarcode(p.term)
    if (hit) { addVariant(hit, p.qty); return }
    // A scanner's Enter can land before the debounced results catch up, so search fresh then.
    const settled = query === deferredQuery
    const list = settled ? results : searchGroups(index, p.tokens)
    const r = list[settled ? highlight : 0] ?? list[0]
    if (!r) { toast('No item found for that code', 'err'); return }
    let v = settled ? r.variants[activeVar] : undefined
    if (!v || v.stock <= 0) v = r.variants[firstSellable(r)]
    if (!v) { toast(`${r.group.name} is sold out`, 'err'); return }
    addVariant(v, p.qty)
  }

  const updateLine = (variantId: string, patch: Partial<CartLine>) =>
    setLines((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)))

  /** Removes a line but keeps it recoverable for a few seconds via the toast's Undo. */
  function removeLine(variantId: string) {
    const at = lines.findIndex((l) => l.variantId === variantId)
    if (at < 0) return
    const gone = lines[at]
    setLines((prev) => prev.filter((l) => l.variantId !== variantId))
    setSelected((s) => (s === variantId ? null : s))
    setEditing((e) => (e === variantId ? null : e))
    setSwapping((e) => (e === variantId ? null : e))
    toast(`Removed ${gone.name}${gone.size ? ` (${gone.size})` : ''}`, 'info', {
      label: 'Undo',
      run: () => setLines((prev) => {
        if (prev.some((l) => l.variantId === gone.variantId)) return prev
        const next = [...prev]; next.splice(Math.min(at, next.length), 0, gone); return next
      }),
    })
  }

  /** Swaps a line to another size/colour of the same product without removing and re-scanning. */
  function swapLine(from: CartLine, v: VariantView) {
    if (v.id === from.variantId) { setSwapping(null); return }
    if (v.stock <= 0) { toast(`${variantLabel(v.size, v.color)} is sold out`, 'err'); return }
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === v.id)
      const qty = Math.min(from.qty + (existing?.qty ?? 0), v.stock)
      const swapped: CartLine = {
        ...from, variantId: v.id, sku: v.sku, barcode: v.barcode, size: v.size, color: v.color,
        mrp: v.mrp, price: from.priceOverridden ? from.price : v.price, stock: v.stock, qty, taxRate: v.taxRate,
      }
      return prev.filter((l) => l.variantId !== v.id).map((l) => (l.variantId === from.variantId ? swapped : l))
    })
    setSelected(v.id); setSwapping(null)
  }

  function capDiscount(type: DiscountType, value: number) {
    if (type === 'pct' && !can('bigDiscount') && value > settings!.maxCashierDiscountPct) {
      toast(`Cashier discount is capped at ${settings!.maxCashierDiscountPct}%`, 'err')
      return settings!.maxCashierDiscountPct
    }
    return value
  }

  // Lines grouped by product (newest product first), plus the flat on-screen order for keyboard moves.
  const groups = useMemo(() => {
    const m = new Map<string, CartLine[]>()
    for (const l of lines) {
      const k = l.productId ?? l.name
      const arr = m.get(k)
      if (arr) arr.push(l); else m.set(k, [l])
    }
    return [...m.values()].map((ls) => ls.slice().sort((a, b) => sizeRank(a.size) - sizeRank(b.size)))
  }, [lines])
  const flat = useMemo(() => groups.flat(), [groups])

  // Cart keyboard: ↑↓ select a line, + / − change its quantity, Delete removes it. Works from the
  // empty scan box or anywhere outside a form field — never while typing a search or a price.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const inForm = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
      const scanEmpty = t === scanRef.current && scanRef.current.value === ''
      if ((inForm && !scanEmpty) || !flat.length || e.ctrlKey || e.metaKey || e.altKey) return
      const i = flat.findIndex((l) => l.variantId === selected)
      const cur = i >= 0 ? flat[i] : null
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = i < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
        setSelected(flat[next].variantId)
      } else if (cur && (e.key === '+' || e.key === '=')) { e.preventDefault(); setQty(cur, cur.qty + 1) }
      else if (cur && (e.key === '-' || e.key === '_')) { e.preventDefault(); setQty(cur, cur.qty - 1) }
      else if (cur && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeLine(cur.variantId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function setQty(l: CartLine, qty: number) {
    if (qty <= 0) { removeLine(l.variantId); return }
    if (qty > l.stock) { toast(`Only ${l.stock} in stock`, 'err'); return }
    updateLine(l.variantId, { qty })
  }

  function clearCart() {
    setLines([])
    pickCustomer(null)
    setBillDiscountValue(0)
    setCoupon('')
    setCartSheetOpen(false)
    focusScan()
  }

  function pickCustomer(c: Customer | null) {
    setCustomer(c)
    setCustomerPhone('')
    setCustomerName('')
  }

  // A 10-digit number that matches an existing customer attaches the
  // moment it's complete — no Enter needed, since linking an existing
  // customer is easily undone with "Change". Creating a brand-new
  // customer is a real write, so that path only fires on Enter/blur,
  // once the cashier has actually finished typing.
  useEffect(() => {
    if (customerPhone.length !== 10) return
    const existing = customers.find((c) => c.phone === customerPhone)
    if (existing) { pickCustomer(existing); toast(`${existing.name} attached`, 'ok') }
  }, [customerPhone, customers])

  async function attachOrCreateCustomer() {
    const phone = customerPhone.trim()
    if (!phone) return
    if (!/^\d{10}$/.test(phone)) { toast('Enter a valid 10-digit mobile number', 'err'); return }
    const existing = customers.find((c) => c.phone === phone)
    if (existing) { pickCustomer(existing); toast(`${existing.name} attached`, 'ok'); return }
    const c: Customer = {
      id: id('cus'), name: customerName.trim() || 'Customer', phone, email: '', dob: '',
      anniversary: '', address: '', gstin: '', loyaltyPoints: 0, storeCredit: 0,
      createdAt: Date.now(), notes: '',
    }
    await db.customers.add(c)
    pickCustomer(c)
    toast(`${c.name} added & attached`, 'ok')
  }

  async function holdBill() {
    if (!lines.length || !user) return
    const no = `HOLD-${new Date().toTimeString().slice(0, 5).replace(':', '')}`
    await db.bills.add({
      id: id('bill'), no, date: Date.now(), customerId: customer?.id ?? null,
      items: totals.items, grossMrp: totals.grossMrp, itemDiscount: totals.itemDiscount,
      billDiscountType, billDiscountValue, billDiscount: totals.billDiscount, coupon,
      subtotal: totals.subtotal, taxableTotal: totals.taxableTotal, cgstTotal: totals.cgstTotal,
      sgstTotal: totals.sgstTotal, taxTotal: totals.taxTotal, roundOff: totals.roundOff,
      total: totals.total, payments: [], paid: 0, changeDue: 0, loyaltyEarned: 0,
      loyaltyRedeemed: 0, creditUsed: 0, cashierId: user.id, status: 'held', notes: 'Parked bill',
    })
    toast(`Bill parked as ${no}`, 'ok')
    clearCart()
  }

  async function resumeBill(b: Bill) {
    const restored: CartLine[] = []
    for (const it of b.items) {
      const v = variants.find((x) => x.id === it.variantId)
      restored.push({
        variantId: it.variantId, productId: v?.productId, sku: it.sku, barcode: it.barcode, name: it.name,
        size: it.size, color: it.color, hsn: it.hsn, mrp: it.mrp, price: it.price, cost: v?.cost ?? it.cost,
        qty: it.qty, stock: v?.stock ?? it.qty, discountType: it.discountType,
        discountValue: it.discountValue, taxRate: v?.taxRate,
      })
    }
    setLines(restored)
    setBillDiscountType(b.billDiscountType)
    setBillDiscountValue(b.billDiscountValue)
    pickCustomer(b.customerId ? customers.find((c) => c.id === b.customerId) ?? null : null)
    await db.bills.delete(b.id)
    setShowHeld(false)
    toast(`Resumed ${b.no}`, 'ok')
  }

  async function completeSale(payments: Payment[], loyaltyRedeemed: number, creditUsed: number, changeDue: number) {
    if (!user || !settings) return
    const no = await nextInvoiceNo()
    const paid = round2(payments.reduce((s, p) => s + p.amount, 0))
    let bill: Bill
    try {
      bill = await saveBill({
      no, date: Date.now(), customerId: customer?.id ?? null,
      items: totals.items, grossMrp: totals.grossMrp, itemDiscount: totals.itemDiscount,
      billDiscountType, billDiscountValue, billDiscount: totals.billDiscount, coupon,
      subtotal: totals.subtotal, taxableTotal: totals.taxableTotal, cgstTotal: totals.cgstTotal,
      sgstTotal: totals.sgstTotal, taxTotal: totals.taxTotal, roundOff: totals.roundOff,
      total: totals.total, payments, paid, changeDue,
      loyaltyEarned: customer ? Math.floor((totals.total * settings.loyaltyEarnPct) / 100) : 0,
      loyaltyRedeemed, creditUsed, cashierId: user.id, status: 'paid', notes: '',
      })
    } catch (e) {
      toast((e as Error).message || 'Could not save the bill', 'err')
      return
    }
    setShowPay(false)
    setCartSheetOpen(false)
    setLastBill(bill)
    setRecent({ bill, customer })
    setReopened(false)
    toast(`${no} saved · ${inr(bill.total)}`, 'ok')
  }

  /** One-tap checkout for the full amount (exact payment, so no change to work out). */
  async function quickPay(mode: PayMode) {
    if (!lines.length || saving) return
    setSaving(true)
    try { await completeSale([{ mode, amount: totals.total }], 0, 0, 0) } finally { setSaving(false) }
  }

  const printReceipt = async (bill: Bill) => {
    if (!settings) return
    await printReceiptSmart(print, bill, settings, recent?.customer ?? null, user, (msg) => toast(msg, 'err'))
  }
  const printInvoice = (bill: Bill) => {
    if (!settings) return
    print(<Invoice bill={bill} settings={settings} customer={recent?.customer ?? null} cashier={user} />)
  }

  if (!settings) return null

  return (
    <div className="pos">
      {/* ---------------- Left: scan + cart ---------------- */}
      <div className="pos-left">
        <div className="scan-bar no-print">
          <div className="pos-scan-wrap">
            <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--brand-600)', display: 'flex' }}><ScanIcon size={17} /></span>
            <input
              ref={scanRef}
              className="scan-input"
              placeholder="Scan barcode or type item name / SKU…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setDismissed(true); return }
                const open = showDrop && results.length > 0
                if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  setHighlight((h) => Math.max(0, Math.min(results.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))))
                  return
                }
                // Only when the caret is at the end, so ←/→ still edit the text mid-word.
                if (open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.currentTarget.selectionStart === query.length) {
                  e.preventDefault()
                  stepSize(e.key === 'ArrowRight' ? 1 : -1)
                  return
                }
                if (e.key === 'Enter') { e.preventDefault(); handleScanOrSearch() }
              }}
            />
            {showDrop && results.length > 0 && (
              <ItemSearchDrop
                ref={dropRef}
                results={results}
                tokens={parsed.tokens}
                qty={parsed.qty}
                highlight={highlight}
                activeVar={activeVar}
                cartQty={cartQty}
                onHover={setHighlight}
                onPick={(v) => { addVariant(v, parsed.qty); focusScan() }}
              />
            )}
            {noMatch && <NoMatch query={query.trim()} onAdd={() => navigate('/inventory')} />}
          </div>
          <button className="btn" onClick={() => setShowQuick((v) => !v)}>{showQuick ? 'Hide' : 'Quick add'}</button>
          <button className="btn" onClick={() => setShowHeld(true)}>
            Held {heldBills.length > 0 && <span className="badge badge-brand">{heldBills.length}</span>}
          </button>
          {recent && !lastBill && (
            <button className="btn" title="Reopen the last finished bill to print it again"
              onClick={() => { setReopened(true); setLastBill(recent.bill) }}>
              <Printer size={15} /> Last bill · {recent.bill.no}
            </button>
          )}
        </div>

        {showQuick && (
          <div className="quick-grid no-print" style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
            {topSellers.map((v) => (
              <button key={v.id} className="quick-tile" disabled={v.stock <= 0} onClick={() => addVariant(v)}>
                <span className="qt-name">{v.productName}</span>
                <span className="qt-meta">{variantLabel(v.size, v.color)}</span>
                <span className="qt-price">{inr(v.price)}</span>
                <span className="qt-meta">{v.stock} in stock</span>
              </button>
            ))}
          </div>
        )}

        <div className="cart-scroll">
          {!lines.length ? (
            <Empty icon={<ScanIcon size={24} />} title="Scan an item to start billing" hint="Press F2 to jump to the scan box · F4 to take payment" />
          ) : (
            groups.map((ls) => {
              const pcs = ls.reduce((s, l) => s + l.qty, 0)
              const total = round2(ls.reduce((s, l) => s + l.price * l.qty - lineDiscount(l), 0))
              return (
                <section key={ls[0].productId ?? ls[0].name} className="cg">
                  <header className="cg-head">
                    <div className="cart-thumb"><InventoryIcon size={18} /></div>
                    <div className="cg-name">{ls[0].name}</div>
                    <div className="cg-sum num">{pcs} pc{pcs === 1 ? '' : 's'} · {inr(total)}</div>
                  </header>
                  {ls.map((l) => (
                    <CartRow
                      key={l.variantId}
                      line={l}
                      flash={flashId === l.variantId}
                      selected={selected === l.variantId}
                      editing={editing === l.variantId}
                      swapping={swapping === l.variantId}
                      siblings={variants
                        .filter((v) => v.productId === l.productId)
                        .sort((a, b) => a.color.localeCompare(b.color) || sizeRank(a.size) - sizeRank(b.size))}
                      canOverridePrice={can('bigDiscount')}
                      onSelect={() => setSelected(l.variantId)}
                      onQty={(q) => setQty(l, q)}
                      onRemove={() => removeLine(l.variantId)}
                      onToggleEdit={() => setEditing((e) => (e === l.variantId ? null : l.variantId))}
                      onToggleSwap={() => setSwapping((e) => (e === l.variantId ? null : l.variantId))}
                      onSwap={(v) => swapLine(l, v)}
                      onPatch={(patch) => updateLine(l.variantId, patch)}
                      capDiscount={capDiscount}
                    />
                  ))}
                </section>
              )
            })
          )}
        </div>

        {lines.length > 0 && (
          <button className="pos-cart-bar no-print" onClick={() => setCartSheetOpen(true)}>
            <span className="pcb-count">{totals.qtyTotal}</span>
            <span className="grow" style={{ textAlign: 'left' }}>
              <span className="small dim" style={{ display: 'block' }}>{lines.length} item{lines.length > 1 ? 's' : ''} in cart</span>
              <span className="pcb-total">{inr(totals.total)}</span>
            </span>
            <span className="btn btn-primary btn-sm" style={{ pointerEvents: 'none' }}>View cart</span>
          </button>
        )}
      </div>

      {cartSheetOpen && <div className="sheet-backdrop show no-print" onClick={() => setCartSheetOpen(false)} />}

      {/* ---------------- Right: customer, totals, payment ---------------- */}
      <div className={`pos-right no-print ${cartSheetOpen ? 'sheet-open' : ''}`}>
        <div className="sheet-handle" onClick={() => setCartSheetOpen(false)} />

        <div className="bill-head">
          <div className="row between">
            <h2>Current Bill</h2>
            <span className="badge badge-brand">{lines.length} item{lines.length === 1 ? '' : 's'} · {totals.qtyTotal} pcs</span>
          </div>

          {customer ? (
            <button className="btn btn-block customer-chip" onClick={() => setShowCustomer(true)} title="Change customer (F3)">
              <UserIcon size={15} />
              <span style={{ textAlign: 'left', lineHeight: 1.25, minWidth: 0 }}>
                <span className="bold" style={{ display: 'block' }}>{customer.name}</span>
                <span className="small muted">{customer.phone} · {customer.loyaltyPoints} pts{customer.storeCredit > 0 ? ` · ${inr(customer.storeCredit)} credit` : ''}</span>
              </span>
              <span className="small muted" style={{ marginLeft: 'auto' }}>Change</span>
            </button>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div className="row gap-6">
                <div className="search-wrap" style={{ flex: 1, minWidth: 0 }}>
                  <span className="ico"><UserIcon size={15} /></span>
                  <input
                    className="input" placeholder="Customer mobile (optional)" inputMode="numeric"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    onKeyDown={(e) => { if (e.key === 'Enter') attachOrCreateCustomer() }}
                  />
                </div>
                <button className="btn" onClick={() => setShowCustomer(true)} title="Search by name or add details (F3)">
                  Search <span className="kbd">F3</span>
                </button>
              </div>
              {/* The name box only matters when this number isn't a known customer yet. */}
              {isNewCustomerNumber && (
                <div className="row gap-6" style={{ marginTop: 8 }}>
                  <input className="input" autoFocus placeholder="New customer — name (optional)" value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') attachOrCreateCustomer() }} />
                  <button className="btn btn-primary" onClick={attachOrCreateCustomer}>Add</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bill-disc">
          {discOpen ? (
            <div className="col gap-6" style={{ gap: 8 }}>
              <div className="form-row">
                <span className="form-label">Discount</span>
                <select className="select" style={{ width: 66 }} value={billDiscountType} onChange={(e) => setBillDiscountType(e.target.value as DiscountType)}>
                  <option value="pct">%</option>
                  <option value="amt">₹</option>
                </select>
                <input
                  className="input num" value={billDiscountValue || ''} placeholder="0" inputMode="decimal" autoFocus
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0
                    const capped = billDiscountType === 'pct' && !can('bigDiscount') ? Math.min(v, settings.maxCashierDiscountPct) : v
                    setBillDiscountValue(capped)
                  }}
                />
              </div>
              <div className="form-row">
                <span className="form-label">Coupon</span>
                <input className="input" placeholder="e.g. DIWALI10" value={coupon}
                  onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                  onBlur={() => {
                    const m = coupon.match(/(\d+)$/)
                    if (coupon && m) { setBillDiscountType('pct'); setBillDiscountValue(Number(m[1])); toast(`Coupon applied — ${m[1]}% off`, 'ok') }
                  }}
                />
              </div>
              {!hasDiscount && (
                <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setDiscOpen(false)}>Hide</button>
              )}
            </div>
          ) : (
            <button className="link-btn" onClick={() => setDiscOpen(true)}>
              <Plus size={14} /> Add discount / coupon
            </button>
          )}
        </div>

        {/* Middle of the panel: a prompt when empty, a quiet spacer otherwise. */}
        {!lines.length ? (
          <div className="bill-empty">
            <div className="big"><ScanIcon size={22} /></div>
            <div className="bold">Cart is empty</div>
            {/* <div className="small muted">Scan a barcode or search for an item<br />to start this bill. <span className="kbd">F2</span></div> */}
          </div>
        ) : <div className="grow" />}

        <div className="totals">
          {lines.length > 0 && (
            <>
              <div className="total-row"><span>Items (MRP)</span><span>{inr(totals.grossMrp)}</span></div>
              {totals.itemDiscount > 0 && <div className="total-row save"><span>Item discounts</span><span>− {inr(totals.itemDiscount)}</span></div>}
              {totals.billDiscount > 0 && <div className="total-row save"><span>Bill discount</span><span>− {inr(totals.billDiscount)}</span></div>}
              <button type="button" className="total-row total-toggle" onClick={() => setTaxOpen((v) => !v)} aria-expanded={taxOpen}>
                <span>GST included <ChevronDown size={13} style={{ transform: taxOpen ? 'rotate(180deg)' : undefined }} /></span>
                <span>{inr(totals.taxTotal)}</span>
              </button>
              {taxOpen && (
                <div className="tax-detail">
                  <div className="total-row"><span>Taxable value</span><span>{inr(totals.taxableTotal)}</span></div>
                  <div className="total-row"><span>CGST</span><span>{inr(totals.cgstTotal)}</span></div>
                  <div className="total-row"><span>SGST</span><span>{inr(totals.sgstTotal)}</span></div>
                </div>
              )}
              {totals.roundOff !== 0 && <div className="total-row"><span>Round off</span><span>{inr(totals.roundOff)}</span></div>}
            </>
          )}
          <div className="total-row grand"><span>To Pay</span><span>{inr(totals.total)}</span></div>

          <div className="small muted quick-pay-label">One tap · exact amount, no change</div>
          <div className="quick-pay" role="group" aria-label="Quick pay: completes the sale for the exact amount">
            {PAY_MODES.map((p) => (
              <button key={p.mode} className="btn quick-pay-btn" disabled={!lines.length || saving} onClick={() => quickPay(p.mode)}
                title={`Take the full ${inr(totals.total)} by ${p.label}`}>
                {p.icon} {p.label}
              </button>
            ))}
          </div>

          <button className="btn btn-primary btn-lg btn-block pay-main" disabled={!lines.length || saving} onClick={() => setShowPay(true)}>
            Take Payment · {lines.length} item{lines.length === 1 ? '' : 's'} · {inr(totals.total)} <span className="kbd kbd-on-dark">F4</span>
          </button>

          <div className="row between" style={{ marginTop: 8 }}>
            <button className="btn" style={{ flex: 1 }} disabled={!lines.length} onClick={holdBill}><ParkedIcon size={15} /> Hold</button>
            <button className="btn-clear" disabled={!lines.length} onClick={clearCart}><TrashIcon size={14} /> Clear bill</button>
          </div>
        </div>
      </div>

      <CustomerPicker
        open={showCustomer}
        customers={customers}
        onClose={() => setShowCustomer(false)}
        onPick={(c) => { pickCustomer(c); setShowCustomer(false); focusScan() }}
      />

      <PaymentModal
        open={showPay}
        total={totals.total}
        summary={{ items: lines.length, pcs: totals.qtyTotal, mrp: totals.grossMrp, discount: round2(totals.itemDiscount + totals.billDiscount), tax: totals.taxTotal }}
        customer={customer}
        loyaltyValue={settings.loyaltyRedeemValue}
        onClose={() => setShowPay(false)}
        onDone={completeSale}
      />

      <Modal open={showHeld} title="Parked bills" onClose={() => setShowHeld(false)} width="wide">
        {!heldBills.length ? <Empty icon={<ParkedIcon size={24} />} title="No parked bills" hint="Use Hold to park a customer's cart and serve the next person." /> : (
          <table className="tbl">
            <thead><tr><th>Bill</th><th>Time</th><th>Items</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {heldBills.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.no}</td>
                  <td>{new Date(b.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{b.items.length}</td>
                  <td className="num">{inr(b.total)}</td>
                  <td className="right">
                    <button className="btn btn-sm btn-primary" onClick={() => resumeBill(b)}>Resume</button>
                    <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={async () => { await db.bills.delete(b.id); toast('Parked bill discarded') }}>Discard</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <SaleDone
        bill={lastBill}
        settings={settings}
        customer={recent?.customer ?? null}
        cashier={user}
        // Reopened from "Last bill" while a new bill is in progress: just close, don't wipe that cart.
        onNewBill={() => { setLastBill(null); if (!reopened) clearCart(); setReopened(false) }}
        onPrintReceipt={printReceipt}
        onPrintInvoice={printInvoice}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- */

function CustomerPicker({ open, customers, onClose, onPick }: {
  open: boolean; customers: Customer[]; onClose: () => void; onPick: (c: Customer | null) => void
}) {
  const { toast } = useApp()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [hi, setHi] = useState(0)
  const [form, setForm] = useState({ name: '', phone: '', email: '', dob: '', address: '', gstin: '' })

  const found = customers.filter((c) =>
    c.phone.includes(q.trim()) || c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)

  // Cursor returns to the top result whenever the list changes or the picker reopens.
  useEffect(() => { setHi(0) }, [q, open, creating])
  useEffect(() => {
    document.querySelector('.cust-row.kb-active')?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!found.length) return
      e.preventDefault()
      setHi((h) => Math.max(0, Math.min(found.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = found[hi]
      if (c) onPick(c)
    }
  }

  async function create() {
    if (!/^\d{10}$/.test(form.phone)) { toast('Enter a valid 10-digit mobile number', 'err'); return }
    if (customers.some((c) => c.phone === form.phone)) { toast('That number already exists', 'err'); return }
    const c: Customer = {
      id: id('cus'), name: form.name || 'Customer', phone: form.phone, email: form.email,
      dob: form.dob, anniversary: '', address: form.address, gstin: form.gstin,
      loyaltyPoints: 0, storeCredit: 0, createdAt: Date.now(), notes: '',
    }
    await db.customers.add(c)
    toast('Customer added', 'ok')
    setCreating(false)
    setForm({ name: '', phone: '', email: '', dob: '', address: '', gstin: '' })
    onPick(c)
  }

  return (
    <Modal open={open} title="Customer" onClose={onClose} footer={
      <>
        <button className="btn" onClick={() => onPick(null)}>Walk-in (skip)</button>
        {creating
          ? <button className="btn btn-primary" onClick={create}>Save & attach</button>
          : <button className="btn btn-primary" onClick={() => { setCreating(true); setForm((f) => ({ ...f, phone: /^\d+$/.test(q) ? q : '' })) }}>+ New customer</button>}
      </>
    }>
      {!creating ? (
        <>
          <input className="input input-lg" autoFocus placeholder="Search by mobile number or name…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} />
          <div style={{ marginTop: 12 }}>
            {found.length ? found.map((c, i) => (
              <button key={c.id} className={`nav-item cust-row ${i === hi ? 'kb-active' : ''}`} style={{ color: 'var(--ink-800)', border: '1px solid var(--line)', marginBottom: 6 }}
                onMouseEnter={() => setHi(i)} onClick={() => onPick(c)}>
                <span className="avatar" style={{ background: 'var(--brand-50)', color: 'var(--brand-600)' }}>{c.name[0]}</span>
                <span style={{ flex: 1 }}>
                  <span className="bold" style={{ display: 'block' }}>{c.name}</span>
                  <span className="tiny muted">{c.phone}</span>
                </span>
                <span className="badge badge-brand">{c.loyaltyPoints} pts</span>
                {c.storeCredit > 0 && <span className="badge badge-ok">{inr(c.storeCredit)}</span>}
              </button>
            )) : <div className="small muted center" style={{ padding: 16 }}>{q ? 'No match — create a new customer.' : 'Type a mobile number to search.'}</div>}
          </div>
        </>
      ) : (
        <div className="grid grid-2">
          <Field label="Mobile number *"><input className="input" autoFocus value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></Field>
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Date of birth" hint="Used for birthday offers"><input type="date" className="input" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></Field>
          <Field label="Address"><input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="GSTIN" hint="For business customers"><input className="input" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></Field>
        </div>
      )}
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

interface PaySummary { items: number; pcs: number; mrp: number; discount: number; tax: number }

/** Round-up tender suggestions for cash: the next "nice" amounts above what's due, e.g. 2,999 → 3,000 · 3,500 · 5,000. */
function cashSuggestions(due: number): number[] {
  const out: number[] = []
  for (const step of [10, 50, 100, 500, 1000, 2000, 5000]) {
    const v = Math.ceil(due / step) * step
    if (v > due && !out.includes(v)) out.push(v)
    if (out.length === 4) break
  }
  return out
}

function PaymentModal({ open, total, summary, customer, loyaltyValue, onClose, onDone }: {
  open: boolean; total: number; summary: PaySummary; customer: Customer | null; loyaltyValue: number
  onClose: () => void
  onDone: (payments: Payment[], loyaltyRedeemed: number, creditUsed: number, changeDue: number) => void
}) {
  const [split, setSplit] = useState<Payment[]>([])
  const [mode, setMode] = useState<PayMode>('cash')
  const [tendered, setTendered] = useState('')
  const [ref, setRef] = useState('')
  const [redeemPts, setRedeemPts] = useState(0)
  const [useCredit, setUseCredit] = useState(false)
  const amountRef = useRef<HTMLInputElement>(null)

  const creditUsed = useCredit && customer ? Math.min(customer.storeCredit, total) : 0
  const loyaltyRupees = round2(redeemPts * loyaltyValue)
  const payable = round2(Math.max(0, total - creditUsed - loyaltyRupees))
  const splitPaid = round2(split.reduce((s, p) => s + p.amount, 0))
  const remaining = round2(Math.max(0, payable - splitPaid))

  const isCash = mode === 'cash'
  // An empty box means "exactly what's due" — the default for almost every sale.
  const amount = tendered === '' ? remaining : Number(tendered) || 0
  const covers = amount >= remaining
  const change = isCash && covers ? round2(amount - remaining) : 0
  const shortBy = covers ? 0 : round2(remaining - amount)

  useEffect(() => {
    if (open) { setSplit([]); setTendered(''); setRef(''); setRedeemPts(0); setUseCredit(false); setMode('cash') }
  }, [open])

  const pickMode = (m: PayMode) => { setMode(m); setRef(''); amountRef.current?.focus() }

  /** Takes part of the bill on this mode and leaves the rest for another mode. */
  function addPartial() {
    if (amount <= 0 || covers) return
    setSplit([...split, { mode, amount, ...(ref.trim() ? { ref: ref.trim() } : {}) }])
    setTendered(''); setRef('')
    amountRef.current?.focus()
  }

  function finish() {
    if (!covers) return
    const payments = [...split]
    if (remaining > 0) payments.push({ mode, amount: remaining, ...(ref.trim() ? { ref: ref.trim() } : {}) })
    if (creditUsed > 0) payments.push({ mode: 'credit', amount: creditUsed })
    if (loyaltyRupees > 0) payments.push({ mode: 'credit', amount: loyaltyRupees, ref: `${redeemPts} loyalty points` })
    onDone(payments, redeemPts, creditUsed, change)
  }

  const quick = isCash ? cashSuggestions(remaining) : []

  return (
    <Modal open={open} title="Payment" onClose={onClose} width="wide" footer={
      <>
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-primary btn-lg" disabled={!covers} onClick={finish}>
          Complete Sale · {inr(total)}
        </button>
      </>
    }>
      <div className="pay-grid">
        <div className="col" style={{ gap: 14 }}>
          <div className="pay-due">
            <div className="small" style={{ opacity: .75 }}>{split.length ? 'Still due' : 'Amount due'}</div>
            <div className="num pay-due-amt">{inr(remaining)}</div>
            {(split.length > 0 || creditUsed > 0 || loyaltyRupees > 0) && (
              <div className="small" style={{ opacity: .75 }}>
                Bill {inr(total)}
                {splitPaid > 0 && <> − paid {inr(splitPaid)}</>}
                {creditUsed > 0 && <> − credit {inr(creditUsed)}</>}
                {loyaltyRupees > 0 && <> − points {inr(loyaltyRupees)}</>}
              </div>
            )}
          </div>

          <div className="pay-modes" role="group" aria-label="Payment mode">
            {PAY_MODES.map((p) => (
              <button key={p.mode} type="button" className={`pay-mode ${mode === p.mode ? 'on' : ''}`}
                aria-pressed={mode === p.mode} title={`${p.label} (${p.mode === 'cash' ? 'C' : p.mode === 'upi' ? 'U' : 'D'})`}
                onClick={() => pickMode(p.mode)}>
                {p.icon} {p.label}
              </button>
            ))}
          </div>

          <Field label={isCash ? 'Cash received' : `${mode.toUpperCase()} amount`}>
            <input
              ref={amountRef}
              className="input input-lg num pay-amount"
              autoFocus
              inputMode="decimal"
              value={tendered}
              placeholder={String(remaining)}
              onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))}
              onKeyDown={(e) => {
                // Letters never go in this box, so they double as mode shortcuts.
                const k = e.key.toLowerCase()
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                  if (k === 'c') { e.preventDefault(); pickMode('cash'); return }
                  if (k === 'u') { e.preventDefault(); pickMode('upi'); return }
                  if (k === 'd') { e.preventDefault(); pickMode('card'); return }
                }
                if (e.key === 'Enter') { e.preventDefault(); if (covers) finish(); else addPartial() }
              }}
            />
          </Field>

          {isCash && (
            <div className="row gap-6 wrap">
              <button type="button" className={`btn btn-sm ${tendered === '' ? 'btn-dark' : ''}`} onClick={() => setTendered('')}>Exact {inr(remaining)}</button>
              {quick.map((n) => (
                <button key={n} type="button" className={`btn btn-sm ${Number(tendered) === n ? 'btn-dark' : ''}`} onClick={() => setTendered(String(n))}>
                  {inr(n).replace('.00', '')}
                </button>
              ))}
            </div>
          )}
          {!isCash && (
            <input className="input" placeholder={mode === 'upi' ? 'UPI transaction ID (optional)' : 'Card last 4 digits / approval code (optional)'}
              value={ref} onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (covers) finish(); else addPartial() } }} />
          )}

          {/* Always occupies the same space, so the dialog never jumps as you type. */}
          <div className={`pay-banner ${shortBy > 0 ? 'short' : change > 0 ? 'change' : 'exact'}`} aria-live="polite">
            {shortBy > 0 ? (
              <>
                <span>Short by</span><b className="num">{inr(shortBy)}</b>
              </>
            ) : change > 0 ? (
              <>
                <span>Change to return</span><b className="num">{inr(change)}</b>
              </>
            ) : (
              <span>{remaining > 0 ? 'Exact amount — no change' : 'Nothing left to pay'}</span>
            )}
          </div>

          {shortBy > 0 && amount > 0 && (
            <button type="button" className="btn btn-block" onClick={addPartial}>
              Take {inr(amount)} by {mode.toUpperCase()} · {inr(shortBy)} still due on another mode
            </button>
          )}
        </div>

        <div className="col" style={{ gap: 12 }}>
          <div className="card pay-summary">
            <div className="total-row"><span>{summary.items} item{summary.items === 1 ? '' : 's'} · {summary.pcs} pc{summary.pcs === 1 ? '' : 's'}</span><span>{inr(summary.mrp)}</span></div>
            {summary.discount > 0 && <div className="total-row save"><span>Discounts</span><span>− {inr(summary.discount)}</span></div>}
            <div className="total-row"><span>GST included</span><span>{inr(summary.tax)}</span></div>
            <div className="total-row grand" style={{ fontSize: 17 }}><span>Bill total</span><span style={{ fontSize: 20 }}>{inr(total)}</span></div>
          </div>

          {customer ? (
            <div className="card" style={{ padding: 14 }}>
              <div className="row between">
                <div>
                  <div className="bold">{customer.name}</div>
                  <div className="small muted">{customer.phone}</div>
                </div>
                <span className="badge badge-brand">{customer.loyaltyPoints} pts</span>
              </div>
              {customer.storeCredit > 0 && (
                <label className="checkbox" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} />
                  Use store credit ({inr(customer.storeCredit)})
                </label>
              )}
              {customer.loyaltyPoints > 0 && (
                <div style={{ marginTop: 10 }}>
                  <Field label={`Redeem points (1 pt = ${inr(loyaltyValue)})`}>
                    <input className="input num" inputMode="numeric" value={redeemPts || ''} placeholder="0"
                      onChange={(e) => setRedeemPts(Math.min(Number(e.target.value) || 0, customer.loyaltyPoints))} />
                  </Field>
                </div>
              )}
            </div>
          ) : (
            <div className="card small muted" style={{ padding: 14 }}>Walk-in customer — no points or store credit on this bill.</div>
          )}

          {split.length > 0 && (
            <div className="card">
              <div className="card-head" style={{ padding: '10px 14px' }}><h3>Paid so far</h3><span className="num bold">{inr(splitPaid)}</span></div>
              <div className="card-body" style={{ padding: '6px 14px 10px' }}>
                {split.map((p, i) => (
                  <div key={i} className="row between" style={{ padding: '6px 0' }}>
                    <span className="badge">{p.mode.toUpperCase()}</span>
                    <span className="grow small muted" style={{ marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.ref}</span>
                    <span className="num bold">{inr(p.amount)}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSplit(split.filter((_, x) => x !== i))} title="Remove" aria-label="Remove payment"><Close size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
