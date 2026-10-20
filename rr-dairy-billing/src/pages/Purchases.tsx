import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { findByBarcode, loadVariantViews, receivePurchase, type VariantView } from '../db/ops'
import { id } from '../lib/id'
import { inr, round2 } from '../lib/money'
import { fmtDate, toInputDate, fromInputDate } from '../lib/dates'
import { useDebounced } from '../lib/useDebounced'
import { parseQuery } from '../lib/posSearch'
import { Modal, Empty, Field, Segmented, Confirm } from '../components/ui'
import { Close, LabelsIcon, Plus, PurchasesIcon, ReceiveIcon, Search, SupplierIcon } from '../components/icons'
import { useApp } from '../state'
import { usePrint } from '../print/PrintProvider'
import { LabelSheet, labelRowWidthMm, type LabelSpec } from '../print/LabelSheet'
import { SizeGrid, NewItemPanel, type ReceiveLine } from '../components/GrnEntry'
import type { Category, Product, Purchase, PurchaseItem, Supplier } from '../db/types'

const PAGE = 100

export default function Purchases() {
  const { user, settings, toast } = useApp()
  const { print } = usePrint()
  const purchases = useLiveQuery(() => db.purchases.orderBy('date').reverse().toArray(), [], [] as Purchase[]) ?? []
  const suppliers = useLiveQuery(() => db.suppliers.toArray(), [], [] as Supplier[]) ?? []
  const categories = useLiveQuery(() => db.categories.toArray(), [], [] as Category[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const variants = useLiveQuery(() => loadVariantViews(), [], [] as VariantView[]) ?? []
  const supMap = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers])
  const vMap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])

  const [tab, setTab] = useState<'grn' | 'suppliers'>('grn')
  // Arriving from Stock Control's "Receive stock" button opens the scan-in form straight away.
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('receive') === '1')
  useEffect(() => { if (params.get('receive') === '1') { setParams({}, { replace: true }) } }, [params, setParams])
  const [viewing, setViewing] = useState<Purchase | null>(null)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)

  const [q, setQ] = useState('')
  const [show, setShow] = useState<'' | 'due'>('')
  const [sel, setSel] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const searchRef = useRef<HTMLInputElement>(null)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const due = (p: Purchase) => round2(p.total - p.paid)
  const payable = round2(purchases.reduce((s, p) => s + due(p), 0) + suppliers.reduce((s, x) => s + x.openingBalance, 0))

  const rows = useMemo(() => purchases.filter((p) => {
    if (show === 'due' && due(p) <= 0) return false
    if (!needle) return true
    return p.no.toLowerCase().includes(needle)
      || (supMap.get(p.supplierId)?.name.toLowerCase().includes(needle) ?? false)
      || p.invoiceRef.toLowerCase().includes(needle)
      || (p.notes ?? '').toLowerCase().includes(needle)
      || p.items.some((i) => vMap.get(i.variantId)?.productName.toLowerCase().includes(needle))
  }), [purchases, show, needle, supMap, vMap])

  useEffect(() => { setSel(0); setLimit(PAGE) }, [rows.length, needle, show])
  const visible = rows.slice(0, limit)

  // Keyboard: ↑↓ move, Enter opens, / searches, N starts a new receipt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (creating || viewing || editingSupplier || tab !== 'grn' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t === searchRef.current && e.key === 'ArrowDown') { e.preventDefault(); searchRef.current?.blur(); setSel(0); return }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setCreating(true) }
      else if (!visible.length) return
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(visible.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); setViewing(visible[sel]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { document.querySelector('.grn-row.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const labelsFor = (p: Purchase): LabelSpec[] => p.items.map((it) => {
    const v = vMap.get(it.variantId)
    return v ? { barcode: v.barcode, name: v.productName, size: v.size, color: v.color, sku: v.sku, mrp: v.mrp, price: v.price, copies: it.qty } : null
  }).filter(Boolean) as LabelSpec[]

  function printLabels(p: Purchase) {
    if (!settings) return
    print(
      <LabelSheet labels={labelsFor(p)} storeName={settings.name} widthMm={settings.labelWidthMm} heightMm={settings.labelHeightMm}
        across={settings.labelsAcross} gapMm={settings.labelGapMm} />,
      { pageSizeMm: { w: labelRowWidthMm(settings.labelWidthMm, settings.labelsAcross, settings.labelGapMm), h: settings.labelHeightMm } },
    )
  }

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Purchases</h1>
        <div className="grow" />
        <Segmented value={tab} options={[{ value: 'grn', label: 'Goods received' }, { value: 'suppliers', label: 'Suppliers' }]} onChange={setTab} />
        {tab === 'grn'
          ? <button className="btn btn-primary" onClick={() => setCreating(true)}><ReceiveIcon size={15} /> Receive stock</button>
          : <button className="btn btn-primary" onClick={() => setEditingSupplier({ id: '', name: '', phone: '', gstin: '', address: '', openingBalance: 0 })}><Plus size={15} /> New supplier</button>}
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          {tab === 'grn' ? (
            <>
              <div className="bills-filters">
                <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
                  <span className="ico"><Search /></span>
                  <input ref={searchRef} className="input" placeholder="Search GRN, supplier, invoice no or item"
                    value={q} onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); searchRef.current?.blur() } }} />
                </div>
                <select className="select" style={{ width: 170 }} value={show} onChange={(e) => setShow(e.target.value as '' | 'due')} aria-label="Show">
                  <option value="">All receipts</option>
                  <option value="due">Unpaid balance</option>
                </select>
                <div className="grow" />
                <span className="small muted">
                  <b className="num">{rows.length}</b> receipts · Purchased <b className="num">{inr(round2(rows.reduce((s, p) => s + p.total, 0)))}</b> · You owe <b className="num">{inr(payable)}</b>
                </span>
              </div>

              <section className="card">
                {!rows.length ? (
                  <Empty icon={<PurchasesIcon size={24} />}
                    title={needle || show ? 'No receipts match' : 'No goods received yet'}
                    hint={needle || show ? 'Try a different search.' : 'Receiving stock adds quantities and lets you print barcode labels straight away.'} />
                ) : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead><tr><th>GRN</th><th>Date</th><th>Supplier</th><th>Supplier invoice</th><th className="num">Pieces</th><th className="num">Value</th><th className="num">Balance</th></tr></thead>
                      <tbody>
                        {visible.map((p, i) => (
                          <tr key={p.id} className={`grn-row clickable ${i === sel ? 'sel' : ''}`} onClick={() => { setSel(i); setViewing(p) }} onMouseEnter={() => setSel(i)}>
                            <td className="mono bold">{p.no}</td>
                            <td className="muted">{fmtDate(p.date)}</td>
                            <td className="bold">{supMap.get(p.supplierId)?.name ?? '—'}</td>
                            <td className="muted">{p.invoiceRef || '—'}</td>
                            <td className="num">{p.items.reduce((s, i) => s + i.qty, 0)}<span className="small muted"> · {p.items.length} SKU{p.items.length === 1 ? '' : 's'}</span></td>
                            <td className="num bold">{inr(p.total)}</td>
                            <td className="num">{due(p) > 0 ? <span className="badge badge-warn">{inr(due(p))} due</span> : <span className="badge badge-ok">Paid</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > limit && (
                      <div className="center" style={{ padding: 14 }}>
                        <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more · {rows.length - limit} not shown</button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="bills-filters">
                <div className="grow" />
                <span className="small muted"><b className="num">{suppliers.length}</b> suppliers · You owe in total <b className="num">{inr(payable)}</b></span>
              </div>
              <section className="card">
                {!suppliers.length ? <Empty icon={<SupplierIcon size={24} />} title="No suppliers yet" hint="Add a supplier before you receive stock." /> : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead><tr><th>Supplier</th><th>Phone</th><th>GSTIN</th><th>Address</th><th className="num">Purchased</th><th className="num">You owe</th><th /></tr></thead>
                      <tbody>
                        {suppliers.map((s) => {
                          const mine = purchases.filter((p) => p.supplierId === s.id)
                          const owe = round2(mine.reduce((t, p) => t + due(p), 0) + s.openingBalance)
                          return (
                            <tr key={s.id} className="clickable" onClick={() => setEditingSupplier(s)}>
                              <td className="bold">{s.name}</td>
                              <td className="mono small">{s.phone || '—'}</td>
                              <td className="mono small">{s.gstin || '—'}</td>
                              <td className="muted">{s.address || '—'}</td>
                              <td className="num">{inr(round2(mine.reduce((t, p) => t + p.total, 0)))}</td>
                              <td className="num">{owe > 0 ? <span className="badge badge-warn">{inr(owe)}</span> : <span className="badge badge-ok">Settled</span>}</td>
                              <td className="right"><button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setEditingSupplier(s) }}>Edit</button></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {creating && (
        <GrnModal
          suppliers={suppliers}
          variants={variants}
          categories={categories}
          products={products}
          onClose={() => setCreating(false)}
          onAddSupplier={() => { setCreating(false); setTab('suppliers'); setEditingSupplier({ id: '', name: '', phone: '', gstin: '', address: '', openingBalance: 0 }) }}
          onSave={async (draft) => {
            const p = await receivePurchase(draft, user?.id ?? '')
            // Printing is a separate, deliberate step: offered here, and always available later from the receipt.
            toast(`${p.no} received — stock updated`, 'ok', { label: 'Print labels', run: () => printLabels(p) })
            setCreating(false)
          }}
        />
      )}

      {viewing && (
        <Modal open width="wide" onClose={() => setViewing(null)}
          title={
            <div>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {viewing.no}
                {due(viewing) > 0 ? <span className="badge badge-warn">{inr(due(viewing))} due</span> : <span className="badge badge-ok">Paid</span>}
              </h2>
              <div className="small muted">{fmtDate(viewing.date)} · {supMap.get(viewing.supplierId)?.name ?? '—'}</div>
            </div>
          }
          footer={
            <>
              <button className="btn" onClick={() => setViewing(null)}>Close</button>
              <button className="btn btn-dark" onClick={() => printLabels(viewing)}><LabelsIcon size={15} /> Print labels for this GRN</button>
            </>
          }>
          <div className="grid grid-3" style={{ marginBottom: 14 }}>
            <div className="card" style={{ padding: 12 }}><div className="small muted">Supplier invoice</div><div className="bold">{viewing.invoiceRef || '—'}</div></div>
            <div className="card" style={{ padding: 12 }}><div className="small muted">Total / paid</div><div className="bold num">{inr(viewing.total)} <span className="muted">/ {inr(viewing.paid)}</span></div></div>
            <div className="card" style={{ padding: 12 }}><div className="small muted">Notes</div><div className="bold">{viewing.notes || '—'}</div></div>
          </div>
          <div className="card">
            <table className="tbl">
              <thead><tr><th>Item</th><th>Size / Colour</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {viewing.items.map((it, i) => {
                  const v = vMap.get(it.variantId)
                  return (
                    <tr key={i}>
                      <td><div className="bold">{v?.productName ?? 'Removed item'}</div><div className="small muted mono">{v?.sku}</div></td>
                      <td>{v ? variantLabel(v.size, v.color) : '—'}</td>
                      <td className="num">{it.qty}</td>
                      <td className="num">{inr(it.cost)}</td>
                      <td className="num bold">{inr(it.qty * it.cost)}</td>
                    </tr>
                  )
                })}
                <tr><td colSpan={4} className="right bold">Total</td><td className="num bold">{inr(viewing.total)}</td></tr>
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {editingSupplier && (
        <SupplierModal supplier={editingSupplier} suppliers={suppliers} purchases={purchases} onClose={() => setEditingSupplier(null)} />
      )}
    </div>
  )
}

/** Indian GSTIN: 2-digit state, 10-char PAN, entity digit, "Z", checksum. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/

function SupplierModal({ supplier, suppliers, purchases, onClose }: {
  supplier: Supplier; suppliers: Supplier[]; purchases: Purchase[]; onClose: () => void
}) {
  const { toast } = useApp()
  const [f, setF] = useState(supplier)
  const [tried, setTried] = useState(false)
  const isNew = !supplier.id

  const mine = purchases.filter((p) => p.supplierId === supplier.id)
  const purchased = round2(mine.reduce((t, p) => t + p.total, 0))
  const owe = round2(mine.reduce((t, p) => t + (p.total - p.paid), 0) + f.openingBalance)
  const last = mine.reduce((m, p) => Math.max(m, p.date), 0)

  const name = f.name.trim()
  const phoneDigits = f.phone.replace(/\D/g, '')
  const dupe = suppliers.some((x) => x.id !== f.id && x.name.trim().toLowerCase() === name.toLowerCase())
  const phoneBad = f.phone.trim() !== '' && phoneDigits.length < 10
  const gstinBad = f.gstin.trim() !== '' && !GSTIN_RE.test(f.gstin.trim())
  const dirty = JSON.stringify(f) !== JSON.stringify(supplier)

  async function save() {
    setTried(true)
    if (!name) { toast('Supplier name is required', 'err'); return }
    if (dupe) { toast('You already have a supplier with this name', 'err'); return }
    const clean = { ...f, name, gstin: f.gstin.trim(), phone: f.phone.trim() }
    if (clean.id) await db.suppliers.update(clean.id, clean)
    else await db.suppliers.add({ ...clean, id: id('sup') })
    toast(isNew ? `${name} added` : `${name} updated`, 'ok')
    onClose()
  }
  const submit = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') { e.preventDefault(); void save() } }

  return (
    <Modal open title={isNew ? 'New supplier' : f.name || 'Edit supplier'} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-lg" disabled={!isNew && !dirty} onClick={() => void save()}>{isNew ? 'Add supplier' : 'Save changes'}</button>
        </>
      }>
      {!isNew && (
        <div className="ed-summary" style={{ marginBottom: 16 }}>
          <div><span className="small muted">Receipts</span><b className="num">{mine.length}</b></div>
          <div><span className="small muted">Purchased</span><b className="num">{inr(purchased)}</b></div>
          <div><span className="small muted">Last received</span><b>{last ? fmtDate(last) : '—'}</b></div>
          <div className="grow" />
          {owe > 0 ? <span className="badge badge-warn">You owe {inr(owe)}</span> : <span className="badge badge-ok">Settled</span>}
        </div>
      )}

      <div className="form-section" style={{ marginTop: 0 }}>
        <h3>Contact</h3>
        <div className="grid grid-2">
          <Field label="Supplier name *" hint={dupe ? undefined : ' '}>
            <input className={`input ${(tried && !name) || dupe ? 'invalid' : ''}`} autoFocus value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={submit} />
            {dupe && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>You already have a supplier with this name</span>}
          </Field>
          <Field label="Phone" hint={phoneBad ? undefined : ' '}>
            <input className={`input ${phoneBad ? 'invalid' : ''}`} inputMode="tel" value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value.replace(/[^\d+\s-]/g, '') })} onKeyDown={submit} />
            {phoneBad && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Enter at least 10 digits</span>}
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Address"><textarea className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Tax &amp; account</h3>
        <div className="grid grid-2">
          <Field label="GSTIN" hint={gstinBad ? undefined : '15 characters, e.g. 27AABCS1429B1ZX'}>
            <input className={`input ${gstinBad ? 'invalid' : ''}`} maxLength={15} value={f.gstin}
              onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} onKeyDown={submit} />
            {gstinBad && <span className="small" style={{ color: 'var(--warn)', fontWeight: 650 }}>Doesn't look like a valid GSTIN — you can still save it</span>}
          </Field>
          <Field label="Opening balance (₹)" hint="Owed before you started using this app">
            <input className="input num" inputMode="decimal" value={f.openingBalance || ''} placeholder="0"
              onChange={(e) => setF({ ...f, openingBalance: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} onKeyDown={submit} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

function GrnModal({ suppliers, variants, categories, products, onClose, onSave, onAddSupplier }: {
  suppliers: Supplier[]
  variants: VariantView[]
  categories: Category[]
  products: Product[]
  onClose: () => void
  onSave: (p: Omit<Purchase, 'id' | 'no'>) => void
  onAddSupplier: () => void
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '')
  const [date, setDate] = useState(toInputDate(Date.now()))
  const [invoiceRef, setInvoiceRef] = useState('')
  const [notes, setNotes] = useState('')
  const [paidNow, setPaidNow] = useState('')
  const [q, setQ] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [items, setItems] = useState<PurchaseItem[]>([])
  const [last, setLast] = useState<{ ok: boolean; text: string; id?: string } | null>(null)
  const [askDiscard, setAskDiscard] = useState(false)
  const [mode, setMode] = useState<'scan' | 'grid' | 'new'>('scan')
  const [gridFocus, setGridFocus] = useState<string | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const scanRef = useRef<HTMLInputElement>(null)
  const vMap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])

  const parsed = parseQuery(q)
  const matches = useMemo(() => {
    const n = parsed.term.toLowerCase()
    if (n.length < 2) return []
    return variants.filter((v) =>
      v.productName.toLowerCase().includes(n) || v.sku.toLowerCase().includes(n) ||
      v.barcode.includes(n) || v.styleCode.toLowerCase().includes(n)).slice(0, 8)
  }, [parsed.term, variants])

  useEffect(() => { setHighlight(0) }, [matches])
  useEffect(() => { dropRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' }) }, [highlight])
  useEffect(() => { scanRef.current?.focus() }, [])

  /** Adds pieces and moves the line to the top, so the item you just scanned is always in view. */
  /** Adds a batch of lines (from the size grid) and moves them to the top of the receipt. */
  function addMany(lines: ReceiveLine[], styleName: string) {
    setItems((prev) => {
      let next = prev
      for (const l of lines) {
        const existing = next.find((x) => x.variantId === l.variant.id)
        const line: PurchaseItem = existing ? { ...existing, qty: existing.qty + l.qty } : { variantId: l.variant.id, qty: l.qty, cost: l.cost }
        next = [line, ...next.filter((x) => x.variantId !== l.variant.id)]
      }
      return next
    })
    const n = lines.reduce((t, l) => t + l.qty, 0)
    setLast({ ok: true, text: `Added ${n} piece${n === 1 ? '' : 's'} of ${styleName} to the receipt` })
  }

  function add(v: VariantView, qty = 1) {
    const current = items.find((x) => x.variantId === v.id)?.qty ?? 0
    setItems((prev) => {
      const existing = prev.find((x) => x.variantId === v.id)
      const line: PurchaseItem = existing ? { ...existing, qty: existing.qty + qty } : { variantId: v.id, qty, cost: v.cost }
      return [line, ...prev.filter((x) => x.variantId !== v.id)]
    })
    setLast({ ok: true, text: `${v.productName} · ${variantLabel(v.size, v.color)} → ${current + qty} received`, id: v.id })
    setQ('')
    scanRef.current?.focus()
  }

  async function scan() {
    if (!parsed.term) return
    const hit = await findByBarcode(parsed.term)
    if (hit) { add(hit, parsed.qty); return }
    if (matches.length) { add(matches[highlight] ?? matches[0], parsed.qty); return }
    setLast({ ok: false, text: `Nothing found for "${parsed.term}" — check the barcode or search by name` })
  }

  const total = round2(items.reduce((s, i) => s + i.qty * i.cost, 0))
  const pieces = items.reduce((s, i) => s + i.qty, 0)
  const paid = Number(paidNow) || 0
  const overpaid = paid > total
  const zeroCost = items.filter((i) => i.cost <= 0).length
  const canSave = items.length > 0 && !!supplierId && !overpaid

  const requestClose = () => (askDiscard ? setAskDiscard(false) : items.length ? setAskDiscard(true) : onClose())

  return (
    <>
      <Modal open width="xwide" title="Receive stock (GRN)" onClose={requestClose} footer={
        <>
          <span className="small muted" style={{ marginRight: 'auto' }}>Labels aren't printed automatically — print them from the receipt when you're ready.</span>
          <button className="btn" onClick={requestClose}>Cancel</button>
          <button className="btn btn-primary btn-lg" disabled={!canSave} onClick={() => onSave({
            supplierId, date: fromInputDate(date), invoiceRef, items, total, paid, notes, userId: '',
          })}>Receive {pieces} piece{pieces === 1 ? '' : 's'} · {inr(total)}</button>
        </>
      }>
        {!suppliers.length && (
          <div className="pay-banner short" style={{ marginBottom: 14 }}>
            <span>You need a supplier before you can receive stock.</span>
            <button className="btn btn-sm" onClick={onAddSupplier}>Add a supplier</button>
          </div>
        )}
        <div className="grid grid-4">
          <Field label="Supplier *">
            <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Supplier invoice no"><input className="input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></Field>
          <Field label="Paid now (₹)" hint={overpaid ? undefined : total > 0 ? `${inr(round2(total - paid))} will remain due` : undefined}>
            <div className="row gap-6">
              <input className={`input num ${overpaid ? 'invalid' : ''}`} inputMode="decimal" value={paidNow} placeholder="0"
                onChange={(e) => setPaidNow(e.target.value.replace(/[^\d.]/g, ''))} />
              <button type="button" className="btn" disabled={!total} onClick={() => setPaidNow(String(total))} title="Paid in full">Full</button>
            </div>
          </Field>
        </div>

        <div className="row between" style={{ marginTop: 16, marginBottom: 10, flexWrap: 'wrap' }}>
          <Segmented value={mode} options={[
            { value: 'scan', label: 'Scan or search' },
            { value: 'grid', label: 'Size grid' },
            { value: 'new', label: 'New item' },
          ]} onChange={(m) => { setMode(m); if (m === 'scan') setTimeout(() => scanRef.current?.focus(), 0) }} />
          <span className="small muted">
            {mode === 'scan' && 'Item already in your catalogue? Scan one of your own labels or type its name.'}
            {mode === 'grid' && 'A whole delivery of one style: type the quantity for each size and colour.'}
            {mode === 'new' && 'Never stocked this style before? Create it here, then enter what arrived.'}
          </span>
        </div>

        {mode === 'scan' && (
          <>
            <div style={{ position: 'relative' }}>
              <input ref={scanRef} className="input input-lg" placeholder="Scan one of our labels, or type the item name / SKU — 5*name adds five" value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault()
                    setHighlight((h) => Math.max(0, Math.min(matches.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))))
                    return
                  }
                  if (e.key === 'Enter') { e.preventDefault(); void scan() }
                }} />
              {matches.length > 0 && (
                <div className="card search-drop" ref={dropRef} style={{ top: 54, left: 0, right: 0 }}>
                  {matches.map((m, i) => (
                    <button key={m.id} className={`search-drop-item ${i === highlight ? 'highlighted' : ''}`}
                      onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHighlight(i)} onClick={() => add(m, parsed.qty)}>
                      <span className="search-drop-info">
                        <span className="search-drop-name">{m.productName}</span>
                        <span className="search-drop-meta">{variantLabel(m.size, m.color)} · {m.sku}</span>
                      </span>
                      <span className="search-drop-aside"><span className="badge">In stock {m.stock}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {mode === 'grid' && (
          <div className="card" style={{ padding: 14 }}>
            <SizeGrid variants={variants} focusProductId={gridFocus} onAdd={addMany} />
          </div>
        )}
        {mode === 'new' && (
          <div className="card" style={{ padding: 14 }}>
            <NewItemPanel categories={categories} products={products}
              onCreated={(p) => { setGridFocus(p.id); setMode('grid'); setLast({ ok: true, text: `${p.name} created — enter how many of each size arrived` }) }} />
          </div>
        )}
        <div className={`pay-banner ${!last ? 'exact' : last.ok ? 'change' : 'short'}`} style={{ marginTop: 10, minHeight: 44 }} aria-live="polite">
          <span>{last ? last.text : 'Nothing is added to your stock until you save the receipt.'}</span>
        </div>

        <div style={{ marginTop: 14 }}>
          {!items.length ? <Empty icon={<ReceiveIcon size={24} />} title="No items on this receipt yet" hint="Scan one of your labels, type a name, use the size grid for a full delivery, or create a new item." /> : (
            <div className="card">
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Item</th><th>Size / Colour</th><th className="num">Qty</th><th className="num">Cost each</th><th className="num">Amount</th><th /></tr></thead>
                  <tbody>
                    {items.map((it, i) => {
                      const v = vMap.get(it.variantId)
                      if (!v) return null
                      return (
                        <tr key={it.variantId} style={last?.id === it.variantId ? { background: 'var(--brand-50)' } : undefined}>
                          <td><div className="bold">{v.productName}</div><div className="small muted mono">{v.sku}</div></td>
                          <td>{variantLabel(v.size, v.color)}</td>
                          <td className="num">
                            <input className="input num cell-input" inputMode="numeric" value={it.qty} aria-label={`Quantity ${v.sku}`}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, qty: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) } : x))} />
                          </td>
                          <td className="num">
                            <input className={`input num cell-input ${it.cost <= 0 ? 'invalid' : ''}`} inputMode="decimal" value={it.cost} aria-label={`Cost ${v.sku}`}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, cost: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 } : x))} />
                            {it.cost !== v.cost && it.cost > 0 && <div className="small" style={{ color: 'var(--warn)', fontWeight: 650 }}>was {inr(v.cost)}</div>}
                          </td>
                          <td className="num bold">{inr(it.qty * it.cost)}</td>
                          <td className="right"><button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setItems(items.filter((_, j) => j !== i))} title="Remove" aria-label={`Remove ${v.sku}`}><Close size={14} /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="bd-totals row between" style={{ fontWeight: 650 }}>
                <span className="small muted">{items.length} SKU{items.length === 1 ? '' : 's'} · {pieces} pieces{zeroCost > 0 && <span style={{ color: 'var(--danger)' }}> · {zeroCost} with no cost</span>}</span>
                <span>Total purchase value <b className="num" style={{ fontSize: 18, marginLeft: 8 }}>{inr(total)}</b></span>
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. festive season stock" /></Field>
        </div>
        {overpaid && <div className="small" style={{ color: 'var(--danger)', fontWeight: 650, marginTop: 8 }}>Paid now is more than the receipt total ({inr(total)}).</div>}
      </Modal>

      <Confirm
        open={askDiscard}
        title="Discard this receipt?"
        danger
        confirmLabel="Discard"
        message={<>You've scanned <strong>{pieces} pieces</strong> that haven't been saved. Closing now throws them away and your stock stays unchanged.</>}
        onConfirm={onClose}
        onClose={() => { setAskDiscard(false); scanRef.current?.focus() }}
      />
    </>
  )
}
