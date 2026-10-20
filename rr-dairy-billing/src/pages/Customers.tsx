import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { id } from '../lib/id'
import { inr, round2 } from '../lib/money'
import { DAY, fmtDate, startOfDay } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Modal, Empty, Field } from '../components/ui'
import { CustomersIcon, Download, Plus, Search } from '../components/icons'
import { useApp } from '../state'
import type { Bill, Customer } from '../db/types'

type View = '' | 'loyal' | 'credit' | 'birthday' | 'lapsed'
interface Stat { spend: number; visits: number; last: number }

const PAGE = 100
const monthDay = (s: string) => (s ? s.slice(5) : '')
const blank = (): Customer => ({
  id: '', name: '', phone: '', email: '', dob: '', anniversary: '', address: '',
  gstin: '', loyaltyPoints: 0, storeCredit: 0, createdAt: Date.now(), notes: '',
})

/** "Today", "Yesterday", "5 days ago", "3 months ago" — easier to scan than a date. */
function ago(ms: number): string {
  const d = Math.round((startOfDay() - startOfDay(ms)) / DAY)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 30) return `${d} days ago`
  if (d < 365) return `${Math.round(d / 30)} month${Math.round(d / 30) === 1 ? '' : 's'} ago`
  return `${Math.round(d / 365)} year${Math.round(d / 365) === 1 ? '' : 's'} ago`
}

export default function Customers() {
  const { toast, can } = useApp()
  const customers = useLiveQuery(() => db.customers.toArray(), [], [] as Customer[]) ?? []
  // Spend / visits per customer come from the customerId index, not a scan of every bill.
  const stats = useLiveQuery(async () => {
    const m = new Map<string, Stat>()
    await db.bills.where('customerId').above('').each((b) => {
      if (!b.customerId || b.status === 'held') return
      const r = m.get(b.customerId) ?? { spend: 0, visits: 0, last: 0 }
      r.spend = round2(r.spend + b.total)
      if (b.total > 0) r.visits++
      r.last = Math.max(r.last, b.date)
      m.set(b.customerId, r)
    })
    return m
  }, [], new Map<string, Stat>()) ?? new Map<string, Stat>()

  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('')
  const [editing, setEditing] = useState<Customer | null>(null)
  const [open, setOpen] = useState<Customer | null>(null)
  const [sel, setSel] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const searchRef = useRef<HTMLInputElement>(null)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const thisMonth = String(new Date().getMonth() + 1).padStart(2, '0')
  const lapsedBefore = Date.now() - 90 * DAY
  const hasBirthday = (c: Customer) => monthDay(c.dob).startsWith(thisMonth) || monthDay(c.anniversary).startsWith(thisMonth)

  const rows = useMemo(() => customers
    .filter((c) => !needle || c.phone.includes(needle) || c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle))
    .filter((c) => {
      if (view === 'loyal') return c.loyaltyPoints > 0
      if (view === 'credit') return c.storeCredit > 0
      if (view === 'birthday') return hasBirthday(c)
      if (view === 'lapsed') { const l = stats.get(c.id)?.last ?? 0; return l > 0 && l < lapsedBefore }
      return true
    })
    .sort((a, b) => (stats.get(b.id)?.spend ?? 0) - (stats.get(a.id)?.spend ?? 0)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [customers, needle, view, stats, thisMonth])

  useEffect(() => { setSel(0); setLimit(PAGE) }, [rows.length, needle, view])
  const visible = rows.slice(0, limit)

  const totalSpend = round2([...stats.values()].reduce((s, r) => s + r.spend, 0))
  const totalCredit = round2(customers.reduce((s, c) => s + c.storeCredit, 0))

  // Keyboard: ↑↓ move, Enter opens the customer, / searches, N adds a customer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || open || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t === searchRef.current && e.key === 'ArrowDown') { e.preventDefault(); searchRef.current?.blur(); setSel(0); return }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setEditing(blank()) }
      else if (!visible.length) return
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(visible.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); setOpen(visible[sel]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { document.querySelector('.cust-list-row.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  function exportCsv() {
    downloadFile('customers.csv', toCSV(rows.map((c) => ({
      name: c.name, phone: c.phone, email: c.email, dob: c.dob, address: c.address,
      gstin: c.gstin, loyaltyPoints: c.loyaltyPoints, storeCredit: c.storeCredit,
      totalSpend: stats.get(c.id)?.spend ?? 0, visits: stats.get(c.id)?.visits ?? 0,
      lastVisit: stats.get(c.id)?.last ? fmtDate(stats.get(c.id)!.last) : '',
    }))))
    toast('Customer list exported', 'ok')
  }

  const filtered = !!(needle || view)

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Customers</h1>
        <div className="grow" />
        {can('reports') && <button className="btn" onClick={exportCsv} disabled={!rows.length}><Download size={15} /> Export</button>}
        <button className="btn btn-primary" onClick={() => setEditing(blank())}><Plus size={15} /> New customer</button>
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="bills-filters">
            <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
              <span className="ico"><Search /></span>
              <input ref={searchRef} className="input" placeholder="Search mobile number, name or email"
                value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); searchRef.current?.blur() } }} />
            </div>
            <select className="select" style={{ width: 210 }} value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Show">
              <option value="">All customers</option>
              <option value="loyal">With loyalty points</option>
              <option value="credit">With store credit</option>
              <option value="birthday">Birthday or anniversary this month</option>
              <option value="lapsed">Not seen in 90 days</option>
            </select>
            <div className="grow" />
            <span className="small muted">
              <b className="num">{rows.length}</b> customers
              {can('reports') && <> · Lifetime spend <b className="num">{inr(totalSpend)}</b> · Credit owed <b className="num">{inr(totalCredit)}</b></>}
            </span>
          </div>

          <section className="card">
            {!rows.length ? (
              <Empty icon={<CustomersIcon size={24} />} title={filtered ? 'No customers match' : 'No customers yet'}
                hint={filtered ? 'Try a different search or show all customers.' : 'Customers are added at the billing counter by mobile number, or with New customer.'} />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Customer</th><th>Mobile</th><th className="num">Visits</th><th className="num">Total spend</th><th className="num">Points</th><th className="num">Credit</th><th>Last visit</th><th /></tr></thead>
                  <tbody>
                    {visible.map((c, i) => {
                      const s = stats.get(c.id)
                      return (
                        <tr key={c.id} className={`cust-list-row clickable ${i === sel ? 'sel' : ''}`} onClick={() => { setSel(i); setOpen(c) }} onMouseEnter={() => setSel(i)}>
                          <td>
                            <div className="bold">{c.name}{hasBirthday(c) && <span className="badge badge-brand" style={{ marginLeft: 8 }}>Birthday month</span>}</div>
                            <div className="small muted">{c.address || c.email || '—'}</div>
                          </td>
                          <td className="mono">{c.phone}</td>
                          <td className="num">{s?.visits ?? 0}</td>
                          <td className="num bold">{inr(s?.spend ?? 0)}</td>
                          <td className="num">{c.loyaltyPoints ? <span className="badge badge-brand">{c.loyaltyPoints}</span> : <span className="muted">—</span>}</td>
                          <td className="num">{c.storeCredit ? <span className="badge badge-ok">{inr(c.storeCredit)}</span> : <span className="muted">—</span>}</td>
                          <td>{s?.last ? <span title={fmtDate(s.last)}>{ago(s.last)}</span> : <span className="muted">Never billed</span>}</td>
                          <td className="right"><button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); setEditing(c) }}>Edit</button></td>
                        </tr>
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

      {editing && <CustomerForm customer={editing} customers={customers} onClose={() => setEditing(null)} />}
      {open && <CustomerDetail customer={open} stat={stats.get(open.id)} onClose={() => setOpen(null)} onEdit={() => { setEditing(open); setOpen(null) }} />}
    </div>
  )
}

/* ---------------------------------------------------------------- */

function CustomerDetail({ customer: c, stat, onClose, onEdit }: {
  customer: Customer; stat?: Stat; onClose: () => void; onEdit: () => void
}) {
  const history = useLiveQuery(() => db.bills.where('customerId').equals(c.id).toArray().then((l) => l.filter((b) => b.status !== 'held').sort((a, b) => b.date - a.date)), [c.id], [] as Bill[]) ?? []
  const [more, setMore] = useState(20)
  const spend = stat?.spend ?? 0
  const visits = stat?.visits ?? 0
  const thisMonth = String(new Date().getMonth() + 1).padStart(2, '0')

  const details: Array<[string, string]> = [
    ['Mobile', c.phone], ['Email', c.email], ['Address', c.address], ['GSTIN', c.gstin],
    ['Birthday', c.dob ? fmtDate(new Date(c.dob + 'T12:00:00').getTime()) : ''],
    ['Anniversary', c.anniversary ? fmtDate(new Date(c.anniversary + 'T12:00:00').getTime()) : ''],
  ]

  return (
    <Modal open width="wide" onClose={onClose}
      title={
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.name}
            {(monthDay(c.dob).startsWith(thisMonth) || monthDay(c.anniversary).startsWith(thisMonth)) && <span className="badge badge-brand">Birthday month</span>}
          </h2>
          <div className="small muted">Customer since {fmtDate(c.createdAt)}</div>
        </div>
      }
      footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={onEdit}>Edit customer</button></>}>
      <div className="ed-summary">
        <div><span className="small muted">Total spend</span><b className="num">{inr(spend)}</b></div>
        <div><span className="small muted">Visits</span><b className="num">{visits}</b></div>
        <div><span className="small muted">Average bill</span><b className="num">{visits ? inr(round2(spend / visits)) : '—'}</b></div>
        <div><span className="small muted">Last visit</span><b>{stat?.last ? ago(stat.last) : '—'}</b></div>
        <div className="grow" />
        <span className="badge badge-brand">{c.loyaltyPoints} points</span>
        {c.storeCredit > 0 && <span className="badge badge-ok">{inr(c.storeCredit)} credit</span>}
      </div>

      <div className="grid grid-3" style={{ marginTop: 14 }}>
        {details.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="card" style={{ padding: 12 }}><div className="small muted">{k}</div><div className="bold" style={{ wordBreak: 'break-word' }}>{v}</div></div>
        ))}
      </div>
      {c.notes && (
        <div className="card" style={{ padding: 12, marginTop: 12, background: 'var(--warn-bg)' }}>
          <div className="small muted">Notes</div><div className="bold">{c.notes}</div>
        </div>
      )}

      <div className="form-section">
        <h3>Purchase history</h3>
        {!history.length ? <Empty title="No purchases recorded yet" hint="Bills billed to this mobile number will show up here." /> : (
          <div className="card">
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Bill</th><th>Date</th><th>Items</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {history.slice(0, more).map((b) => (
                    <tr key={b.id}>
                      <td className="mono bold">{b.no}</td>
                      <td className="muted">{fmtDate(b.date)}</td>
                      <td>{b.items.map((i) => `${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ')}</td>
                      <td className="num bold" style={{ color: b.total < 0 ? 'var(--danger)' : undefined }}>{inr(b.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {history.length > more && <div className="center" style={{ padding: 12 }}><button className="btn" onClick={() => setMore((m) => m + 20)}>Show {Math.min(20, history.length - more)} more</button></div>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/

function CustomerForm({ customer, customers, onClose }: { customer: Customer; customers: Customer[]; onClose: () => void }) {
  const { toast, can } = useApp()
  const [f, setF] = useState(customer)
  const [tried, setTried] = useState(false)
  const isNew = !customer.id

  const phoneBad = tried && !/^\d{10}$/.test(f.phone)
  const dupe = /^\d{10}$/.test(f.phone) ? customers.find((c) => c.id !== f.id && c.phone === f.phone) : undefined
  const emailBad = f.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(f.email.trim())
  const gstinBad = f.gstin.trim() !== '' && !GSTIN_RE.test(f.gstin.trim())
  const dirty = JSON.stringify(f) !== JSON.stringify(customer)
  const owner = can('settings')

  async function save() {
    setTried(true)
    if (!/^\d{10}$/.test(f.phone)) { toast('Enter a valid 10-digit mobile number', 'err'); return }
    if (dupe) { toast(`${dupe.name} already uses this number`, 'err'); return }
    if (emailBad) { toast('That email address doesn\'t look right', 'err'); return }
    const clean = { ...f, name: f.name.trim() || 'Customer', email: f.email.trim(), gstin: f.gstin.trim() }
    if (clean.id) await db.customers.update(clean.id, clean)
    else await db.customers.add({ ...clean, id: id('cus') })
    toast(isNew ? `${clean.name} added` : `${clean.name} updated`, 'ok')
    onClose()
  }
  const submit = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') { e.preventDefault(); void save() } }

  return (
    <Modal open title={isNew ? 'New customer' : `Edit ${customer.name}`} onClose={onClose} width="wide"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-lg" disabled={!isNew && !dirty} onClick={() => void save()}>{isNew ? 'Add customer' : 'Save changes'}</button>
        </>
      }>
      <div className="form-section" style={{ marginTop: 0 }}>
        <h3>Contact</h3>
        <div className="grid grid-3">
          <Field label="Mobile number *" hint={dupe || phoneBad ? undefined : '10 digits'}>
            <input className={`input ${phoneBad || dupe ? 'invalid' : ''}`} autoFocus inputMode="numeric" value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} onKeyDown={submit} />
            {dupe && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>{dupe.name} already uses this number</span>}
            {phoneBad && !dupe && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Enter all 10 digits</span>}
          </Field>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={submit} /></Field>
          <Field label="Email" hint={emailBad ? undefined : ' '}>
            <input className={`input ${emailBad ? 'invalid' : ''}`} inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} onKeyDown={submit} />
            {emailBad && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Doesn't look like an email</span>}
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} onKeyDown={submit} /></Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Special days</h3>
        <div className="grid grid-3">
          <Field label="Date of birth" hint="Used for birthday offers"><input type="date" className="input" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></Field>
          <Field label="Anniversary"><input type="date" className="input" value={f.anniversary} onChange={(e) => setF({ ...f, anniversary: e.target.value })} /></Field>
          <Field label="GSTIN" hint={gstinBad ? undefined : 'For business customers'}>
            <input className={`input ${gstinBad ? 'invalid' : ''}`} maxLength={15} value={f.gstin}
              onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} onKeyDown={submit} />
            {gstinBad && <span className="small" style={{ color: 'var(--warn)', fontWeight: 650 }}>Doesn't look like a valid GSTIN</span>}
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Loyalty &amp; credit</h3>
        <div className="grid grid-3">
          <Field label="Loyalty points" hint={owner ? undefined : 'Only the owner can change balances'}>
            <input className="input num" inputMode="numeric" disabled={!owner} value={f.loyaltyPoints} onChange={(e) => setF({ ...f, loyaltyPoints: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </Field>
          <Field label="Store credit (₹)">
            <input className="input num" inputMode="decimal" disabled={!owner} value={f.storeCredit} onChange={(e) => setF({ ...f, storeCredit: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h3>Notes</h3>
        <Field label="Anything the staff should remember" hint="Preferred sizes, fit notes, favourite brands">
          <textarea className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
