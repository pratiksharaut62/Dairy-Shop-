import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { processReturn } from '../db/ops'
import { inr, round2 } from '../lib/money'
import { DAY, fmtDateTime, fmtTime, rangeBounds, RANGE_OPTIONS, startOfDay, type RangeKey } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Modal, Empty, Segmented } from '../components/ui'
import { ArrowLeft, ArrowRight, BillsIcon, Download, Printer, Search, FileTextIcon } from '../components/icons'
import { useApp } from '../state'
import { usePrint } from '../print/PrintProvider'
import { Receipt } from '../print/Receipt'
import { Invoice } from '../print/Invoice'
import { printReceiptSmart } from '../print/printReceipt'
import type { Bill, Customer, User } from '../db/types'

const STATUS_BADGE: Record<string, string> = {
  paid: 'badge-ok', held: 'badge-warn', returned: 'badge-danger', 'partial-return': 'badge-warn',
}
const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid', held: 'Parked', returned: 'Returned', 'partial-return': 'Part returned',
}
const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Credit' }

const PAGE = 100

function dayLabel(ms: number): string {
  const d = startOfDay(ms)
  const today = startOfDay()
  if (d === today) return 'Today'
  if (d === today - DAY) return 'Yesterday'
  return new Date(ms).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })
}

export default function Bills() {
  const { settings, user, toast } = useApp()
  const { print } = usePrint()
  const customers = useLiveQuery(() => db.customers.toArray(), [], [] as Customer[]) ?? []
  const users = useLiveQuery(() => db.users.toArray(), [], [] as User[]) ?? []
  const custMap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers])
  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])

  const [q, setQ] = useState('')
  const [range, setRange] = useState<RangeKey>('7d')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<number | null>(null) // index into rows
  const [returning, setReturning] = useState<Bill | null>(null)
  const [sel, setSel] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const searchRef = useRef<HTMLInputElement>(null)

  const [from, to] = useMemo(() => rangeBounds(range), [range])
  // Only the chosen window is read, newest first, straight off the date index — not the whole table.
  const inRange = useLiveQuery(
    () => db.bills.where('date').between(from, to, true, true).reverse().toArray(),
    [from, to], [] as Bill[],
  ) ?? []

  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const rows = useMemo(() => inRange.filter((b) => {
    if (status && b.status !== status) return false
    if (!needle) return true
    const c = b.customerId ? custMap.get(b.customerId) : undefined
    return b.no.toLowerCase().includes(needle)
      || (c?.phone ?? '').includes(needle)
      || (c?.name ?? '').toLowerCase().includes(needle)
      || b.items.some((i) => i.name.toLowerCase().includes(needle) || i.barcode.includes(needle) || i.sku.toLowerCase().includes(needle))
  }), [inRange, status, needle, custMap])

  const stats = useMemo(() => {
    let net = 0, refunds = 0, bills = 0
    for (const b of rows) {
      if (b.status === 'held') continue
      net += b.total
      if (b.total < 0) refunds += Math.abs(b.total); else bills++
    }
    return { net: round2(net), refunds: round2(refunds), bills, avg: bills ? round2((net + refunds) / bills) : 0 }
  }, [rows])

  const dayTotals = useMemo(() => {
    const m = new Map<number, { count: number; total: number }>()
    for (const b of rows) {
      if (b.status === 'held') continue
      const k = startOfDay(b.date)
      const t = m.get(k) ?? { count: 0, total: 0 }
      t.count++; t.total = round2(t.total + b.total)
      m.set(k, t)
    }
    return m
  }, [rows])

  useEffect(() => { setSel(0); setLimit(PAGE) }, [rows])
  const visible = rows.slice(0, limit)

  const custOf = (b: Bill | null) => (b?.customerId ? custMap.get(b.customerId) ?? null : null)
  const userOf = (b: Bill | null) => (b ? userMap.get(b.cashierId) ?? null : null)
  const reprint = (b: Bill) => { if (settings) void printReceiptSmart(print, b, settings, custOf(b), userOf(b), (msg) => toast(msg, 'err')) }
  const invoice = (b: Bill) => { if (settings) print(<Invoice bill={b} settings={settings} customer={custOf(b)} cashier={userOf(b)} />) }

  // Keyboard: ↑↓ move through bills, Enter opens, / jumps to search; ←→ step between bills inside the detail view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (returning || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
      if (open !== null) {
        if (inField) return
        if (e.key === 'ArrowLeft') { e.preventDefault(); setOpen((i) => (i === null ? i : Math.max(0, i - 1))) }
        if (e.key === 'ArrowRight') { e.preventDefault(); setOpen((i) => (i === null ? i : Math.min(rows.length - 1, i + 1))) }
        return
      }
      if (t === searchRef.current && e.key === 'ArrowDown') { e.preventDefault(); searchRef.current?.blur(); setSel(0); return }
      if (inField) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return }
      if (!visible.length) return
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(visible.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); setOpen(sel) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    document.querySelector('.bill-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function exportCsv() {
    downloadFile(`bills-${range}.csv`, toCSV(rows.map((b) => ({
      bill: b.no, date: new Date(b.date).toLocaleString('en-IN'),
      customer: custOf(b)?.name ?? 'Walk-in', phone: custOf(b)?.phone ?? '',
      items: b.items.length, qty: b.items.reduce((s, i) => s + i.qty, 0),
      gross: b.grossMrp, discount: round2(b.itemDiscount + b.billDiscount),
      taxable: b.taxableTotal, cgst: b.cgstTotal, sgst: b.sgstTotal, total: b.total,
      payment: b.payments.map((p) => p.mode).join('+'), status: b.status,
      cashier: userOf(b)?.name ?? '',
    }))))
    toast('Bills exported', 'ok')
  }

  const filtered = !!(q || status)

  let lastDay = -1
  const openBill = open !== null ? rows[open] ?? null : null

  return (
    <>
      <header className="topbar">
        <h1>Bills &amp; Returns</h1>
        <div className="grow" />
        <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} />
        <button className="btn" onClick={exportCsv} disabled={!rows.length}><Download size={15} /> Export</button>
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="bills-filters">
            <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
              <span className="ico"><Search /></span>
              <input ref={searchRef} className="input" placeholder="Search bill no, customer, mobile or item"
                value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); searchRef.current?.blur() } }} />
            </div>
            <select className="select" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All bills</option>
              <option value="paid">Paid</option>
              <option value="partial-return">Part returned</option>
              <option value="returned">Returned</option>
              <option value="held">Parked</option>
            </select>
            <div className="grow" />
            <span className="small muted">
              <b className="num">{stats.bills}</b> bills · Net sales <b className="num">{inr(stats.net)}</b>
              {stats.refunds > 0 && <> · Refunds <b className="num">{inr(stats.refunds)}</b></>}
            </span>
          </div>

          <section className="card">
            {!rows.length ? (
              <Empty icon={<BillsIcon size={24} />} title={filtered ? 'No bills match these filters' : 'No bills in this period'}
                hint={filtered ? 'Try clearing a filter or widening the date range.' : 'Sales will appear here as soon as they are billed.'} />
            ) : (
              <div className="table-wrap">
                <table className="tbl bills-tbl">
                  <thead>
                    <tr><th>Bill</th><th>Time</th><th>Customer</th><th>Cashier</th><th className="num">Items</th><th>Payment</th><th>Status</th><th className="num">Amount</th><th /></tr>
                  </thead>
                  <tbody>
                    {visible.map((b, i) => {
                      const k = startOfDay(b.date)
                      const showHeader = k !== lastDay
                      lastDay = k
                      return (
                        <FragmentRows key={b.id} showHeader={showHeader} label={dayLabel(b.date)} totals={dayTotals.get(k)}>
                          <tr className={`bill-row clickable ${i === sel ? 'sel' : ''}`} onClick={() => { setSel(i); setOpen(i) }} onMouseEnter={() => setSel(i)}>
                            <td className="mono bold">{b.no}</td>
                            <td className="muted">{fmtTime(b.date)}</td>
                            <td>{custOf(b)?.name ?? <span className="muted">Walk-in</span>}</td>
                            <td className="muted">{userOf(b)?.name.split(' ')[0] ?? '—'}</td>
                            <td className="num">{b.items.reduce((s, it) => s + it.qty, 0)}</td>
                            <td>
                              <span className="row gap-4" style={{ flexWrap: 'wrap' }}>
                                {b.payments.length ? [...new Set(b.payments.map((p) => p.mode))].map((m) => <span key={m} className="badge">{MODE_LABEL[m] ?? m}</span>) : '—'}
                              </span>
                            </td>
                            <td>
                              {b.total < 0
                                ? <span className="badge badge-danger">Credit note</span>
                                : <span className={`badge ${STATUS_BADGE[b.status]}`}>{STATUS_LABEL[b.status] ?? b.status}</span>}
                            </td>
                            <td className="num bold" style={{ color: b.total < 0 ? 'var(--danger)' : undefined }}>{inr(b.total)}</td>
                            <td className="right">
                              <button className="btn btn-sm btn-ghost bill-print" onClick={(e) => { e.stopPropagation(); reprint(b) }} title="Reprint receipt" aria-label={`Reprint ${b.no}`}><Printer size={15} /></button>
                            </td>
                          </tr>
                        </FragmentRows>
                      )
                    })}
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
        </div>
      </div>

      {openBill && settings && (
        <BillDetail
          bill={openBill}
          settings={settings}
          customer={custOf(openBill)}
          cashier={userOf(openBill)}
          position={{ index: open!, total: rows.length }}
          onPrev={() => setOpen((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() => setOpen((i) => (i === null ? i : Math.min(rows.length - 1, i + 1)))}
          onClose={() => setOpen(null)}
          onReturn={() => { setReturning(openBill); setOpen(null) }}
          onReceipt={() => reprint(openBill)}
          onInvoice={() => invoice(openBill)}
        />
      )}

      {returning && (
        <ReturnModal
          bill={returning}
          onClose={() => setReturning(null)}
          onDone={async (lines, refundMode) => {
            try {
              const cn = await processReturn(returning.id, lines, refundMode, user?.id ?? '')
              toast(`${cn.no} — refund ${inr(cn.refundAmount ?? 0)} by ${refundMode}`, 'ok')
              setReturning(null)
              if (settings) void printReceiptSmart(print, cn, settings, custOf(returning), user, (msg) => toast(msg, 'err'))
            } catch (e) {
              toast((e as Error).message, 'err')
            }
          }}
        />
      )}
    </>
  )
}

/** A table row optionally preceded by a day header ("Today · 14 bills · ₹38,420"). */
function FragmentRows({ showHeader, label, totals, children }: {
  showHeader: boolean; label: string; totals?: { count: number; total: number }; children: ReactNode
}) {
  return (
    <>
      {showHeader && (
        <tr className="day-row">
          <td colSpan={9}>
            <span className="bold">{label}</span>
            {totals && <span className="muted"> · {totals.count} bill{totals.count === 1 ? '' : 's'} · <span className="num">{inr(totals.total)}</span></span>}
          </td>
        </tr>
      )}
      {children}
    </>
  )
}

function BillDetail({ bill, settings, customer, cashier, position, onPrev, onNext, onClose, onReturn, onReceipt, onInvoice }: {
  bill: Bill
  settings: NonNullable<ReturnType<typeof useApp>['settings']>
  customer: Customer | null
  cashier: User | null
  position: { index: number; total: number }
  onPrev: () => void; onNext: () => void; onClose: () => void
  onReturn: () => void; onReceipt: () => void; onInvoice: () => void
}) {
  const pcs = bill.items.reduce((s, i) => s + i.qty, 0)
  const discount = round2(bill.itemDiscount + bill.billDiscount)
  const canReturn = bill.status !== 'held' && bill.total > 0

  return (
    <Modal
      open
      width="xwide"
      onClose={onClose}
      title={
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {bill.no}
            {bill.total < 0
              ? <span className="badge badge-danger">Credit note</span>
              : <span className={`badge ${STATUS_BADGE[bill.status]}`}>{STATUS_LABEL[bill.status] ?? bill.status}</span>}
          </h2>
          <div className="small muted">{fmtDateTime(bill.date)}{cashier ? ` · ${cashier.name}` : ''}</div>
        </div>
      }
      footer={
        <>
          <button className="btn btn-icon" onClick={onPrev} disabled={position.index === 0} title="Previous bill (←)" aria-label="Previous bill"><ArrowLeft size={16} /></button>
          <span className="small muted num">{position.index + 1} / {position.total}</span>
          <button className="btn btn-icon" onClick={onNext} disabled={position.index >= position.total - 1} title="Next bill (→)" aria-label="Next bill"><ArrowRight size={16} /></button>
          <div className="grow" />
          {canReturn && <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={onReturn}>Return / Exchange</button>}
          <button className="btn" onClick={onInvoice}><FileTextIcon size={15} /> A4 invoice</button>
          <button className="btn btn-dark" onClick={onReceipt}><Printer size={15} /> Reprint receipt</button>
        </>
      }
    >
      <div className="bd-grid">
        <div className="col" style={{ gap: 14 }}>
          <div className="bd-hero">
            <div>
              <div className="small muted">Bill total</div>
              <div className="num bd-total" style={{ color: bill.total < 0 ? 'var(--danger)' : undefined }}>{inr(bill.total)}</div>
            </div>
            <div className="right small muted">
              {bill.items.length} item{bill.items.length === 1 ? '' : 's'} · {pcs} pc{pcs === 1 ? '' : 's'}
            </div>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {bill.items.map((i, x) => (
                    <tr key={x}>
                      <td>
                        <div className="bold">{i.name}</div>
                        <div className="small muted">{variantLabel(i.size, i.color)} · <span className="mono">{i.sku}</span></div>
                      </td>
                      <td className="num">{i.qty}{i.returnedQty > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>−{i.returnedQty} returned</span>}</td>
                      <td className="num">
                        {inr(i.price)}
                        {i.discountAmount > 0 && <div className="small" style={{ color: 'var(--ok)' }}>− {inr(i.discountAmount)}</div>}
                      </td>
                      <td className="num bold">{inr(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bd-totals">
              <div className="total-row"><span>Items (MRP)</span><span>{inr(bill.grossMrp)}</span></div>
              {discount > 0 && <div className="total-row save"><span>Discounts</span><span>− {inr(discount)}</span></div>}
              <div className="total-row"><span>GST included (CGST {inr(bill.cgstTotal)} + SGST {inr(bill.sgstTotal)})</span><span>{inr(bill.taxTotal)}</span></div>
              {bill.roundOff !== 0 && <div className="total-row"><span>Round off</span><span>{inr(bill.roundOff)}</span></div>}
            </div>
          </div>

          <div className="grid grid-2">
            <div className="card" style={{ padding: 14 }}>
              <div className="small muted">Customer</div>
              <div className="bold">{customer?.name ?? 'Walk-in customer'}</div>
              {customer && <div className="small muted">{customer.phone}</div>}
              {bill.loyaltyEarned > 0 && <span className="badge badge-ok" style={{ marginTop: 6 }}>+{bill.loyaltyEarned} pts earned</span>}
            </div>
            <div className="card" style={{ padding: 14 }}>
              <div className="small muted">Payments</div>
              {bill.payments.length === 0 && <div className="small muted">None — parked bill</div>}
              {bill.payments.map((p, i) => (
                <div key={i} className="row between" style={{ marginTop: 4 }}>
                  <span className="badge">{MODE_LABEL[p.mode] ?? p.mode}</span>
                  <span className="num bold">{inr(p.amount)}</span>
                </div>
              ))}
              {bill.changeDue > 0 && <div className="row between small muted" style={{ marginTop: 6 }}><span>Change given</span><span className="num">{inr(bill.changeDue)}</span></div>}
            </div>
          </div>
        </div>

        <div className="preview-frame bd-preview">
          <div className="paper">
            <Receipt bill={bill} settings={settings} customer={customer} cashier={cashier} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

function ReturnModal({ bill, onClose, onDone }: {
  bill: Bill
  onClose: () => void
  onDone: (lines: Array<{ variantId: string; qty: number }>, mode: 'cash' | 'credit') => void
}) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [mode, setMode] = useState<'cash' | 'credit'>('cash')

  const refund = round2(bill.items.reduce((s, i) => {
    const q = qty[i.variantId] ?? 0
    return s + (i.qty > 0 ? (i.lineTotal / i.qty) * q : 0)
  }, 0))
  const anyLeft = bill.items.some((i) => i.qty - i.returnedQty > 0)
  const returnAll = () => setQty(Object.fromEntries(bill.items.map((i) => [i.variantId, i.qty - i.returnedQty])))
  const submit = () => onDone(Object.entries(qty).filter(([, q]) => q > 0).map(([variantId, q]) => ({ variantId, qty: q })), mode)

  return (
    <Modal
      open
      width="wide"
      title={<div><h2>Return / Exchange</h2><div className="small muted">Against {bill.no}</div></div>}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger btn-lg" disabled={refund <= 0} onClick={submit}>
            Refund {inr(refund)} by {mode === 'cash' ? 'cash' : 'store credit'}
          </button>
        </>
      }
    >
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small muted">Choose how many of each item the customer is returning.</span>
        {anyLeft && <button className="link-btn" onClick={returnAll}>Return everything</button>}
      </div>
      <div className="card">
        <table className="tbl">
          <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Returned</th><th className="num">Return now</th><th className="num">Refund</th></tr></thead>
          <tbody>
            {bill.items.map((i) => {
              const max = i.qty - i.returnedQty
              const q = qty[i.variantId] ?? 0
              return (
                <tr key={i.variantId} style={q > 0 ? { background: 'var(--danger-bg)' } : undefined}>
                  <td><div className="bold">{i.name}</div><div className="small muted">{variantLabel(i.size, i.color)} · {i.sku}</div></td>
                  <td className="num">{i.qty}</td>
                  <td className="num">{i.returnedQty || '—'}</td>
                  <td className="num">
                    {max > 0 ? (
                      <div className="qty-stepper" style={{ float: 'right' }}>
                        <button onClick={() => setQty({ ...qty, [i.variantId]: Math.max(0, q - 1) })} aria-label="Fewer">−</button>
                        <input className="num" value={q} onChange={(e) => setQty({ ...qty, [i.variantId]: Math.min(max, Math.max(0, Number(e.target.value) || 0)) })} />
                        <button onClick={() => setQty({ ...qty, [i.variantId]: Math.min(max, q + 1) })} disabled={q >= max} aria-label="More">+</button>
                      </div>
                    ) : <span className="muted">fully returned</span>}
                  </td>
                  <td className="num bold">{inr(i.qty ? (i.lineTotal / i.qty) * q : 0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="row gap-16" style={{ marginTop: 16, flexWrap: 'wrap' }}>
        <span className="small muted">Refund as</span>
        <Segmented value={mode} options={[{ value: 'cash', label: 'Cash refund' }, { value: 'credit', label: 'Store credit' }]} onChange={setMode} />
        <div className="grow" />
        <div className="right">
          <div className="small muted">Total refund</div>
          <div className="num" style={{ fontSize: 28, fontWeight: 720, color: refund > 0 ? 'var(--danger)' : 'var(--ink-300)' }}>{inr(refund)}</div>
        </div>
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        Returned pieces go straight back into stock. For an exchange, take the return first and then bill the new item.
      </div>
    </Modal>
  )
}
