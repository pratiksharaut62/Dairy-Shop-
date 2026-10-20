import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { createDelivery, setDeliveryStatus } from '../db/dairy'
import { loadVariantViews } from '../db/ops'
import { fmtDate, fromInputDate, toInputDate } from '../lib/dates'
import { Card, Empty, Field, Modal, Segmented } from '../components/ui'
import { CheckCircle, Plus } from '../components/icons'
import { useApp } from '../state'
import type { Customer, Delivery as Dlv, DeliveryItem, DeliveryStatus } from '../db/types'

const FLOW: Array<{ value: DeliveryStatus | 'open' | 'all'; label: string }> = [
  { value: 'open', label: 'Open' }, { value: 'delivered', label: 'Delivered' }, { value: 'failed', label: 'Failed' }, { value: 'all', label: 'All' },
]
const NEXT: Partial<Record<DeliveryStatus, { to: DeliveryStatus; label: string }>> = {
  packed: { to: 'dispatched', label: 'Dispatch' }, dispatched: { to: 'delivered', label: 'Mark delivered' },
}

function StatusPill({ s }: { s: DeliveryStatus }) {
  const cls = s === 'delivered' ? 'badge-ok' : s === 'failed' ? 'badge-danger' : s === 'dispatched' ? 'badge-brand' : 'badge-warn'
  return <span className={`badge ${cls}`}><i className="dot" />{s[0].toUpperCase() + s.slice(1)}</span>
}

export default function Delivery() {
  const { user, toast, can } = useApp()
  const [filter, setFilter] = useState<'open' | DeliveryStatus | 'all'>('open')
  const [adding, setAdding] = useState(false)
  const all = useLiveQuery(() => db.deliveries.orderBy('scheduledAt').reverse().toArray(), [], [] as Dlv[]) ?? []
  const customers = useLiveQuery(() => db.customers.toArray(), [], [] as Customer[]) ?? []
  const cmap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers])
  const rows = all.filter((d) => filter === 'all' ? true : filter === 'open' ? d.status === 'packed' || d.status === 'dispatched' : d.status === filter)

  async function move(d: Dlv, to: DeliveryStatus) {
    if (!user) return
    try { await setDeliveryStatus(d.id, to, user.id); toast(`${d.no} ${to}`, 'ok') } catch (e) { toast((e as Error).message, 'err') }
  }

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Delivery</h1>
        <div className="grow" />
        <Segmented value={filter} options={FLOW} onChange={setFilter} />
        {can('delivery') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> New delivery</button>}
      </header>
      <div className="page"><div className="page-narrow col gap-16">
        <Card tight>
          {!rows.length ? <Empty icon={<CheckCircle size={24} />} title={filter === 'open' ? 'Nothing waiting to go out' : 'No deliveries'} hint="Create a delivery for home-delivery customers, route or milk-round orders." /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Delivery</th><th>Customer / route</th><th>Items</th><th>Status</th><th /></tr></thead>
                <tbody>{rows.map((d) => (
                  <tr key={d.id}>
                    <td><div className="mono bold">{d.no}</div><div className="small muted">{fmtDate(d.scheduledAt)}</div></td>
                    <td><div className="bold">{d.customerId ? cmap.get(d.customerId)?.name ?? 'Customer' : 'Walk-in / route'}</div><div className="small muted">{[d.route, d.vehicle, d.driver].filter(Boolean).join(' · ') || '—'}</div></td>
                    <td>{d.items.map((i) => `${d.status === 'delivered' ? i.deliveredQty : i.qty} × ${i.name}`).join(', ')}</td>
                    <td><StatusPill s={d.status} /></td>
                    <td className="right nowrap">{can('delivery') && NEXT[d.status] && <button className="btn btn-sm btn-primary" onClick={() => void move(d, NEXT[d.status]!.to)}>{NEXT[d.status]!.label}</button>}{' '}
                      {can('delivery') && d.status === 'dispatched' && <button className="btn btn-sm" onClick={() => void move(d, 'failed')}>Failed</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div></div>
      {adding && <DeliveryForm customers={customers} onClose={() => setAdding(false)} />}
    </div>
  )
}

function DeliveryForm({ customers, onClose }: { customers: Customer[]; onClose: () => void }) {
  const { user, toast } = useApp()
  const variants = useLiveQuery(() => loadVariantViews(), [], []) ?? []
  const [customerId, setCustomerId] = useState('')
  const [route, setRoute] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [driver, setDriver] = useState('')
  const [when, setWhen] = useState(toInputDate(Date.now()))
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<Array<{ variantId: string; qty: string }>>([{ variantId: '', qty: '' }])
  const [busy, setBusy] = useState(false)
  const sellable = useMemo(() => variants.filter((v) => v.categoryId !== 'cat_rawmilk'), [variants])

  async function go() {
    if (!user || busy) return
    setBusy(true)
    try {
      const list: DeliveryItem[] = items.filter((i) => i.variantId && Number(i.qty) > 0).map((i) => {
        const v = sellable.find((x) => x.id === i.variantId)!
        return { variantId: v.id, name: `${v.productName}${v.size ? ' ' + v.size : ''}`, qty: Number(i.qty), deliveredQty: 0 }
      })
      const d = await createDelivery({ customerId: customerId || undefined, route, vehicle, driver, scheduledAt: fromInputDate(when), items: list, notes }, user.id)
      toast(`${d.no} created`, 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open width="wide" title="New delivery" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void go()}>Create delivery</button></>}>
      <div className="grid grid-2">
        <Field label="Customer"><select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Walk-in / route stop</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}</select></Field>
        <Field label="Deliver on"><input type="date" className="input" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Route"><input className="input" value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Morning route A" /></Field>
        <Field label="Vehicle"><input className="input" value={vehicle} onChange={(e) => setVehicle(e.target.value)} /></Field>
        <Field label="Driver"><input className="input" value={driver} onChange={(e) => setDriver(e.target.value)} /></Field>
        <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <div className="form-section"><h3>Items</h3>
        {items.map((r, i) => (
          <div key={i} className="row gap-6" style={{ marginBottom: 8 }}>
            <select className="select" style={{ flex: 1 }} value={r.variantId} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))}>
              <option value="">Choose item…</option>{sellable.map((v) => <option key={v.id} value={v.id}>{v.productName}{v.size ? ` · ${v.size}` : ''} ({v.stock} in stock)</option>)}
            </select>
            <input className="input num" style={{ width: 100 }} inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
            {items.length > 1 && <button className="btn btn-ghost" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setItems([...items, { variantId: '', qty: '' }])}><Plus size={13} /> Add item</button>
        <div className="tiny muted" style={{ marginTop: 6 }}>Stock is taken off when the sale is billed in POS, not when the delivery goes out.</div>
      </div>
    </Modal>
  )
}
