import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { decideWastage, receiveLot, recordWastage } from '../db/dairy'
import { DAY, fmtDate, fmtDateTime, fromInputDate, toInputDate } from '../lib/dates'
import { expiringSoon } from '../lib/dairyData'
import { inr } from '../lib/money'
import { Card, Empty, Field, Modal, Segmented, Stat } from '../components/ui'
import { AlertIcon, BoxesIcon, CheckCircle, Close, Plus, TrashIcon } from '../components/icons'
import { useApp } from '../state'
import type { Lot, Product, Variant, Wastage, WastageReason } from '../db/types'

const REASONS: Array<{ value: WastageReason; label: string }> = [
  { value: 'expiry', label: 'Expired' }, { value: 'damage', label: 'Damaged' }, { value: 'spillage', label: 'Spilled' },
  { value: 'wastage', label: 'Wastage' }, { value: 'sample', label: 'Sample' },
]
const label = (v: Variant | undefined, p: Product | undefined) => `${p?.name ?? 'Item'}${v?.size ? ' · ' + v.size : ''}`

function useCatalog() {
  const variants = useLiveQuery(() => db.variants.toArray(), [], [] as Variant[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const pmap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const vmap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  const nameOf = (variantId: string) => { const v = vmap.get(variantId); return label(v, v ? pmap.get(v.productId) : undefined) }
  return { variants, products, pmap, vmap, nameOf }
}

export default function Lots() {
  const { can } = useApp()
  const [tab, setTab] = useState<'lots' | 'writeoffs'>('lots')
  const pending = useLiveQuery(() => db.wastage.where('status').equals('pending').count(), [], 0) ?? 0
  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Lots &amp; expiry</h1>
        <div className="grow" />
        <Segmented value={tab} options={[{ value: 'lots', label: 'Lots' }, { value: 'writeoffs', label: pending ? `Write-offs (${pending})` : 'Write-offs' }]} onChange={setTab} />
      </header>
      <div className="page"><div className="page-narrow col gap-16">
        {tab === 'lots' ? <LotsTab canReceive={can('stock')} canWriteOff={can('wastage')} /> : <WriteoffTab />}
      </div></div>
    </div>
  )
}

function LotsTab({ canReceive, canWriteOff }: { canReceive: boolean; canWriteOff: boolean }) {
  const { nameOf } = useCatalog()
  const lots = useLiveQuery(() => db.lots.filter((l) => l.available > 0).toArray(), [], [] as Lot[]) ?? []
  const [receiving, setReceiving] = useState(false)
  const [writing, setWriting] = useState<Lot | null>(null)
  const now = Date.now()
  const sorted = useMemo(() => [...lots].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)), [lots])
  const expired = sorted.filter((l) => l.expiresAt !== undefined && l.expiresAt <= now)
  const soon = sorted.filter((l) => expiringSoon(l, now))

  return (
    <>
      <div className="stat-grid">
        <Stat label="Active lots" value={sorted.length} icon={<BoxesIcon />} tone="brand" />
        <Stat label="Expired (not sellable)" value={expired.length} icon={<AlertIcon />} tone={expired.length ? 'danger' : 'ok'} foot={expired.length ? 'Write these off' : 'None'} />
        <Stat label="Expiring soon" value={soon.length} tone={soon.length ? 'warn' : 'ok'} foot="Close to the end of their shelf life" />
      </div>
      <div className="row"><div className="grow" />{canReceive && <button className="btn btn-primary" onClick={() => setReceiving(true)}><Plus size={15} /> Receive lot</button>}</div>
      <Card tight>
        {!sorted.length ? <Empty icon={<BoxesIcon size={24} />} title="No lots with stock" hint="Lots are created when milk is approved, a batch finishes, or you receive stock from outside." /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Lot</th><th>Item</th><th>Source</th><th className="num">Available</th><th>Expires</th><th /></tr></thead>
              <tbody>{sorted.map((l) => {
                const gone = l.expiresAt !== undefined && l.expiresAt <= now
                const near = expiringSoon(l, now)
                return (
                  <tr key={l.id}>
                    <td className="mono bold">{l.lotNo}</td><td>{nameOf(l.variantId)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{l.source}</td>
                    <td className="num">{l.available}<span className="muted small"> / {l.qty}</span></td>
                    <td>{l.expiresAt === undefined ? <span className="muted">No expiry</span> : gone ? <span className="badge badge-danger"><i className="dot" />Expired {fmtDate(l.expiresAt)}</span> : <span className={`badge ${near ? 'badge-warn' : 'badge-ok'}`}><i className="dot" />{fmtDateTime(l.expiresAt)}</span>}</td>
                    <td className="right">{canWriteOff && <button className={`btn btn-sm ${gone ? 'btn-primary' : ''}`} onClick={() => setWriting(l)}><TrashIcon size={14} /> Write off</button>}</td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
      {receiving && <ReceiveForm onClose={() => setReceiving(false)} />}
      {writing && <WriteoffForm lot={writing} onClose={() => setWriting(null)} />}
    </>
  )
}

function ReceiveForm({ onClose }: { onClose: () => void }) {
  const { user, toast } = useApp()
  const { variants, pmap } = useCatalog()
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState('')
  const [lotNo, setLotNo] = useState('')
  const [made, setMade] = useState(toInputDate(Date.now()))
  const [exp, setExp] = useState('')
  const [busy, setBusy] = useState(false)
  const v = variants.find((x) => x.id === variantId)
  const shelf = v ? pmap.get(v.productId)?.shelfLifeDays : undefined

  async function go() {
    if (!user || busy) return
    setBusy(true)
    try {
      const producedAt = fromInputDate(made)
      const expiresAt = exp ? fromInputDate(exp) : shelf ? producedAt + shelf * DAY : undefined
      const lot = await receiveLot({ variantId, qty: Number(qty), lotNo, producedAt, expiresAt }, user.id)
      toast(`Lot ${lot.lotNo} received`, 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open title="Receive a lot" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy || !variantId || !(Number(qty) > 0)} onClick={() => void go()}>Receive</button></>}>
      <p className="small muted" style={{ marginBottom: 10 }}>For stock that arrives ready-made (packaged curd from a supplier, etc.) and needs an expiry. Use Purchases for ordinary stock without expiry.</p>
      <Field label="Item *"><select className="select" value={variantId} onChange={(e) => setVariantId(e.target.value)}><option value="">Choose item…</option>
        {variants.map((x) => <option key={x.id} value={x.id}>{label(x, pmap.get(x.productId))}</option>)}</select></Field>
      <div className="grid grid-2" style={{ marginTop: 12 }}>
        <Field label="Quantity *"><input className="input input-lg num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Lot / batch no."><input className="input input-lg" value={lotNo} onChange={(e) => setLotNo(e.target.value)} placeholder="Auto" /></Field>
        <Field label="Made on"><input type="date" className="input" value={made} onChange={(e) => setMade(e.target.value)} /></Field>
        <Field label="Expires on" hint={shelf ? `Blank = ${shelf} days after made` : 'Blank = never expires'}><input type="date" className="input" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

function WriteoffForm({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const { user, toast, can } = useApp()
  const { nameOf } = useCatalog()
  const gone = lot.expiresAt !== undefined && lot.expiresAt <= Date.now()
  const [reason, setReason] = useState<WastageReason>(gone ? 'expiry' : 'wastage')
  const [qty, setQty] = useState(String(lot.available))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    if (!user || busy) return
    setBusy(true)
    try {
      const w = await recordWastage({ variantId: lot.variantId, lotId: lot.id, qty: Number(qty), reason, note }, user.id, can('approveWastage'))
      toast(w.status === 'approved' ? `${w.no} written off` : `${w.no} sent for approval`, 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open title={`Write off · ${lot.lotNo}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy || !(Number(qty) > 0)} onClick={() => void go()}>{can('approveWastage') ? 'Write off' : 'Send for approval'}</button></>}>
      <div className="small muted" style={{ marginBottom: 10 }}>{nameOf(lot.variantId)} · {lot.available} available</div>
      <div className="form-section"><h3>Reason</h3><Segmented value={reason} options={REASONS} onChange={setReason} /></div>
      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <Field label="Quantity *"><input className="input input-lg num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Note"><input className="input input-lg" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {!can('approveWastage') && <div className="small muted" style={{ marginTop: 10 }}>Stock changes once the owner approves this write-off.</div>}
    </Modal>
  )
}

function WriteoffTab() {
  const { user, toast, can } = useApp()
  const { nameOf } = useCatalog()
  const rows = useLiveQuery(() => db.wastage.orderBy('at').reverse().toArray(), [], [] as Wastage[]) ?? []
  async function decide(w: Wastage, ok: boolean) {
    if (!user) return
    try { await decideWastage(w.id, ok, user.id); toast(ok ? `${w.no} approved` : `${w.no} rejected`, 'ok') } catch (e) { toast((e as Error).message, 'err') }
  }
  return (
    <Card tight>
      {!rows.length ? <Empty icon={<TrashIcon size={24} />} title="No write-offs" hint="Expired, damaged or spilled stock is recorded here so the books match the shelf." /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Record</th><th>Item</th><th className="num">Qty</th><th>Reason</th><th className="num">Cost</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((w) => (
              <tr key={w.id}>
                <td><div className="mono bold">{w.no}</div><div className="small muted">{fmtDateTime(w.at)}</div></td>
                <td>{nameOf(w.variantId)}{w.note && <div className="tiny muted">{w.note}</div>}</td>
                <td className="num">{w.qty}</td><td style={{ textTransform: 'capitalize' }}>{w.reason}</td><td className="num">{inr(w.value)}</td>
                <td>{w.status === 'approved' ? <span className="badge badge-ok"><i className="dot" />Approved</span> : w.status === 'rejected' ? <span className="badge badge-danger"><i className="dot" />Rejected</span> : <span className="badge badge-warn"><i className="dot" />Pending</span>}</td>
                <td className="right nowrap">{w.status === 'pending' && can('approveWastage') && (<>
                  <button className="btn btn-sm btn-primary" onClick={() => void decide(w, true)}><CheckCircle size={14} /> Approve</button>{' '}
                  <button className="btn btn-sm" onClick={() => void decide(w, false)}><Close size={14} /> Reject</button></>)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
