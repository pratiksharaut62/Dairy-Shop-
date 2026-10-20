import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { completeBatch, startBatch } from '../db/dairy'
import { fmtDate, fmtDateTime } from '../lib/dates'
import { round2 } from '../lib/money'
import { Card, Empty, Field, Modal, Segmented } from '../components/ui'
import { BoxesIcon, Check, Plus } from '../components/icons'
import { useApp } from '../state'
import type { Lot, Product, ProductionBatch, Variant } from '../db/types'

const label = (v: Variant | undefined, p: Product | undefined) => `${p?.name ?? 'Item'}${v?.size ? ' · ' + v.size : ''}`

export default function Production() {
  const { can } = useApp()
  const batches = useLiveQuery(() => db.batches.orderBy('startedAt').reverse().toArray(), [], [] as ProductionBatch[]) ?? []
  const [starting, setStarting] = useState(false)
  const [finishing, setFinishing] = useState<ProductionBatch | null>(null)
  const open = batches.filter((b) => b.status === 'in-progress')

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Production</h1>
        <div className="grow" />
        {can('production') && <button className="btn btn-primary" onClick={() => setStarting(true)}><Plus size={15} /> Start batch</button>}
      </header>
      <div className="page">
        <div className="page-narrow col gap-16">
          {open.length > 0 && (
            <Card title="In progress">
              <div className="col gap-12">{open.map((b) => (
                <div key={b.id} className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div><div className="bold">{b.no} <span className="small muted">· started {fmtDateTime(b.startedAt)}</span></div>
                    <div className="small muted">{b.inputs.map((i) => `${i.qty} × ${i.label}`).join(', ')}</div></div>
                  {can('production') && <button className="btn btn-primary" onClick={() => setFinishing(b)}><Check size={15} /> Finish batch</button>}
                </div>
              ))}</div>
            </Card>
          )}
          <Card title="Batches" tight>
            {!batches.length ? <Empty icon={<BoxesIcon size={24} />} title="No production yet" hint="Start a batch by choosing the raw milk lots that go into it; finish it with what came out." /> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Batch</th><th>Used</th><th>Produced</th><th>Status</th></tr></thead>
                  <tbody>{batches.map((b) => {
                    const litres = round2(b.inputs.reduce((s, i) => s + i.qty, 0))
                    return (
                      <tr key={b.id}>
                        <td><div className="bold mono">{b.no}</div><div className="small muted">{fmtDate(b.startedAt)}</div></td>
                        <td>{litres} <span className="muted small">units in · {b.inputs.length} lot{b.inputs.length === 1 ? '' : 's'}</span></td>
                        <td>{b.outputs.length ? b.outputs.map((o) => `${o.qty} × ${o.label}`).join(', ') : <span className="muted">—</span>}{b.qcNote && <div className="tiny muted">{b.qcNote}</div>}</td>
                        <td>{b.status === 'completed' ? <span className="badge badge-ok"><i className="dot" />Passed QC</span> : b.status === 'rejected' ? <span className="badge badge-danger"><i className="dot" />Rejected</span> : <span className="badge badge-warn"><i className="dot" />In progress</span>}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
      {starting && <StartForm onClose={() => setStarting(false)} />}
      {finishing && <FinishForm batch={finishing} onClose={() => setFinishing(null)} />}
    </div>
  )
}

function StartForm({ onClose }: { onClose: () => void }) {
  const { user, toast } = useApp()
  const now = Date.now()
  const lots = useLiveQuery(() => db.lots.filter((l) => l.available > 0 && (l.expiresAt === undefined || l.expiresAt > Date.now())).toArray(), [], [] as Lot[]) ?? []
  const variants = useLiveQuery(() => db.variants.toArray(), [], [] as Variant[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const [qty, setQty] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const vmap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  const pmap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const sorted = [...lots].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
  const total = round2((Object.values(qty) as string[]).reduce((s, v) => s + (Number(v) || 0), 0))

  async function go() {
    if (!user || busy) return
    setBusy(true)
    try {
      const b = await startBatch(Object.entries(qty).map(([lotId, v]) => ({ lotId, qty: Number(v) || 0 })), notes, user.id)
      toast(`${b.no} started`, 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open width="wide" title="Start a production batch" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy || total <= 0} onClick={() => void go()}>Start batch · {total} used</button></>}>
      <p className="small muted" style={{ marginBottom: 10 }}>Choose what goes in. The oldest lots are listed first. Quantities are taken out of stock now.</p>
      {!sorted.length ? <Empty title="No usable lots" hint="Approve milk collections or receive a lot first." /> : (
        <div className="table-wrap" style={{ maxHeight: '45vh', overflow: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Lot</th><th>Item</th><th className="num">Available</th><th>Expires</th><th className="num" style={{ width: 110 }}>Use</th></tr></thead>
            <tbody>{sorted.map((l) => {
              const v = vmap.get(l.variantId)
              return (
                <tr key={l.id}>
                  <td className="mono bold">{l.lotNo}</td><td>{label(v, v ? pmap.get(v.productId) : undefined)}</td>
                  <td className="num">{l.available}</td>
                  <td className="muted">{l.expiresAt ? fmtDateTime(l.expiresAt) : '—'}{l.expiresAt && l.expiresAt - now < 86_400_000 ? ' ⚠' : ''}</td>
                  <td><input className="input num" inputMode="decimal" placeholder="0" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^\d.]/g, '') })} />
                    {Number(qty[l.id]) > l.available && <div className="tiny" style={{ color: 'var(--danger)' }}>Max {l.available}</div>}</td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
      )}
      <Field label="Notes"><input className="input" placeholder="e.g. Paneer, 2 vats" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  )
}

function FinishForm({ batch, onClose }: { batch: ProductionBatch; onClose: () => void }) {
  const { user, toast } = useApp()
  const variants = useLiveQuery(() => db.variants.toArray(), [], [] as Variant[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const pmap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  // Finished goods: anything that is not raw material.
  const options = useMemo(() => variants.filter((v) => pmap.get(v.productId)?.categoryId !== 'cat_rawmilk' && pmap.get(v.productId)?.active !== false)
    .sort((a, b) => label(a, pmap.get(a.productId)).localeCompare(label(b, pmap.get(b.productId)))), [variants, pmap])
  const [rows, setRows] = useState<Array<{ variantId: string; qty: string }>>([{ variantId: '', qty: '' }])
  const [pass, setPass] = useState<'pass' | 'fail'>('pass')
  const [qc, setQc] = useState('')
  const [busy, setBusy] = useState(false)
  const litresIn = round2(batch.inputs.reduce((s, i) => s + i.qty, 0))

  async function go() {
    if (!user || busy) return
    setBusy(true)
    try {
      await completeBatch(batch.id, rows.map((r) => ({ variantId: r.variantId, qty: Number(r.qty) || 0 })).filter((r) => r.variantId), pass === 'pass', qc, user.id)
      toast(pass === 'pass' ? `${batch.no} passed — stock added` : `${batch.no} rejected`, pass === 'pass' ? 'ok' : 'info')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open width="wide" title={`Finish ${batch.no}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void go()}>{pass === 'pass' ? 'Pass QC & add to stock' : 'Reject batch'}</button></>}>
      <div className="small muted" style={{ marginBottom: 10 }}>Used {litresIn} units: {batch.inputs.map((i) => `${i.qty} × ${i.label}`).join(', ')}</div>
      <div className="form-section"><h3>Quality check</h3>
        <Segmented value={pass} options={[{ value: 'pass', label: 'Passed' }, { value: 'fail', label: 'Failed' }]} onChange={setPass} />
        {pass === 'fail' && <div className="small" style={{ marginTop: 6, color: 'var(--warn)' }}>A failed batch adds nothing to stock — the milk used is a loss.</div>}
      </div>
      {pass === 'pass' && (
        <div className="form-section"><h3>What was produced</h3>
          {rows.map((r, i) => (
            <div key={i} className="row gap-6" style={{ marginBottom: 8 }}>
              <select className="select" style={{ flex: 1 }} value={r.variantId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))}>
                <option value="">Choose item…</option>
                {options.map((v) => <option key={v.id} value={v.id}>{label(v, pmap.get(v.productId))}</option>)}
              </select>
              <input className="input num" style={{ width: 110 }} inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
              {rows.length > 1 && <button className="btn btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
            </div>
          ))}
          <button className="btn btn-sm" onClick={() => setRows([...rows, { variantId: '', qty: '' }])}><Plus size={13} /> Another product</button>
          <div className="tiny muted" style={{ marginTop: 6 }}>Quantity is in the item's own pack count (e.g. 40 packs of 500 g). Each product gets its expiry from its shelf life.</div>
        </div>
      )}
      <Field label="QC note"><input className="input" value={qc} onChange={(e) => setQc(e.target.value)} placeholder="Texture, taste, temperature…" /></Field>
    </Modal>
  )
}
