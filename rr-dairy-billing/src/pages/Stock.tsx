import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { findByBarcode, loadVariantViews, moveStock, type VariantView } from '../db/ops'
import { inr, round2 } from '../lib/money'
import { fmtDateTime } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Modal, Empty, StockBadge, Field, Segmented, Confirm } from '../components/ui'
import { Close, Download, Minus, Plus, ReceiveIcon, ScanSearchIcon, Search, StockIcon } from '../components/icons'
import { useApp } from '../state'
import type { MoveType, StockMove, User } from '../db/types'

type Tab = 'onhand' | 'audit' | 'ledger'
type Filter = '' | 'low' | 'out' | 'nosale'

const SALE_WINDOW_DAYS = 60
const PAGE = 100
const REASONS = ['Damaged piece', 'Lost / theft', 'Sample given', 'Personal use', 'Supplier return', 'Counting correction', 'Other']
const MOVE_BADGE: Record<MoveType, string> = {
  sale: 'badge-brand', purchase: 'badge-ok', return: 'badge-ok', opening: '', adjust: 'badge-warn', audit: 'badge-warn', transfer: '',
  collection: 'badge-ok', production: 'badge-brand', receipt: 'badge-ok', wastage: 'badge-danger',
}
const AUDIT_KEY = 'rr.stock.audit.draft'

export default function Stock() {
  const { user, toast, can } = useApp()
  const navigate = useNavigate()
  const variants = useLiveQuery(() => loadVariantViews(), [], [] as VariantView[]) ?? []
  const users = useLiveQuery(() => db.users.toArray(), [], [] as User[]) ?? []
  // Variants that sold in the window — looked up from the full movement history, not just the latest rows.
  const soldRecently = useLiveQuery(async () => {
    const cutoff = Date.now() - SALE_WINDOW_DAYS * 86400000
    const set = new Set<string>()
    await db.moves.where('at').aboveOrEqual(cutoff).each((m) => { if (m.type === 'sale') set.add(m.variantId) })
    return set
  }, [], new Set<string>()) ?? new Set<string>()

  const [tab, setTab] = useState<Tab>('onhand')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('')
  const [adjusting, setAdjusting] = useState<VariantView | null>(null)
  const [restock, setRestock] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const rows = useMemo(() => variants
    .filter((v) => {
      if (needle && !(v.productName.toLowerCase().includes(needle) || v.sku.toLowerCase().includes(needle) || v.barcode.includes(needle) || v.color.toLowerCase().includes(needle) || v.size.toLowerCase() === needle)) return false
      if (filter === 'low') return v.stock > 0 && v.stock <= v.reorderLevel
      if (filter === 'out') return v.stock <= 0
      if (filter === 'nosale') return v.stock > 0 && !soldRecently.has(v.id)
      return true
    })
    .sort((a, b) => a.stock - b.stock || a.productName.localeCompare(b.productName)), [variants, needle, filter, soldRecently])

  useEffect(() => setLimit(PAGE), [needle, filter])

  const needsRestock = useMemo(() => variants.filter((v) => v.stock <= v.reorderLevel), [variants])
  const stockValue = round2(rows.reduce((s, v) => s + v.stock * v.cost, 0))
  const pieces = rows.reduce((s, v) => s + v.stock, 0)

  /** ± on a row: one tap, logged, and undoable from the toast. */
  async function quick(v: VariantView, delta: number) {
    if (v.stock + delta < 0) return
    await moveStock(v.id, delta, 'adjust', 'MANUAL', `Quick adjust (${delta > 0 ? '+' : ''}${delta})`, user?.id ?? '')
    toast(`${v.productName} ${variantLabel(v.size, v.color)}: ${v.stock} → ${v.stock + delta}`, 'info', {
      label: 'Undo', run: () => void moveStock(v.id, -delta, 'adjust', 'MANUAL', 'Undo quick adjust', user?.id ?? ''),
    })
  }

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Stock Control</h1>
        <div className="grow" />
        <Segmented value={tab} options={[
          { value: 'onhand', label: 'On hand' },
          { value: 'audit', label: 'Stock audit' },
          { value: 'ledger', label: 'Movement ledger' },
        ]} onChange={setTab} />
        {can('purchases') && (
          <button className="btn btn-primary" onClick={() => navigate('/purchases?receive=1')} title="Scan a delivery to add stock">
            <ReceiveIcon size={15} /> Receive stock
          </button>
        )}
        {tab === 'onhand' && (
          <>
            <button className="btn" onClick={() => setRestock(true)} disabled={!needsRestock.length}>
              Restock list{needsRestock.length > 0 && <span className="badge badge-warn">{needsRestock.length}</span>}
            </button>
            <button className="btn" onClick={() => {
              downloadFile('stock-on-hand.csv', toCSV(rows.map((v) => ({
                item: v.productName, sku: v.sku, barcode: v.barcode, size: v.size, color: v.color,
                stock: v.stock, reorderLevel: v.reorderLevel, cost: v.cost, value: round2(v.stock * v.cost),
              }))))
              toast('Stock exported', 'ok')
            }}><Download size={15} /> Export</button>
          </>
        )}
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          {tab === 'onhand' && (
            <>
              <div className="bills-filters">
                <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
                  <span className="ico"><Search /></span>
                  <input className="input" placeholder="Search item, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <select className="select" style={{ width: 190 }} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
                  <option value="">All stock</option>
                  <option value="low">Low stock</option>
                  <option value="out">Out of stock</option>
                  <option value="nosale">No sales in {SALE_WINDOW_DAYS} days</option>
                </select>
                <div className="grow" />
                <span className="small muted">
                  <b className="num">{rows.length}</b> SKUs · <b className="num">{pieces.toLocaleString('en-IN')}</b> pieces · Value at cost <b className="num">{inr(stockValue)}</b>
                </span>
              </div>

              <section className="card">
                {!rows.length ? <Empty icon={<StockIcon size={24} />} title="Nothing matches" hint="Try a different search or show all stock." /> : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead><tr><th>Item</th><th>Size / Colour</th><th>Barcode</th><th className="num">On hand</th><th className="num">Reorder at</th><th className="num">Value</th><th>Status</th><th /></tr></thead>
                      <tbody>
                        {rows.slice(0, limit).map((v) => (
                          <tr key={v.id}>
                            <td><div className="bold">{v.productName}</div><div className="small muted mono">{v.sku}</div></td>
                            <td>{variantLabel(v.size, v.color)}</td>
                            <td className="mono small">{v.barcode}</td>
                            <td className="num">
                              <span className="qty-quick">
                                <button type="button" aria-label={`Remove one ${v.sku}`} disabled={v.stock <= 0} onClick={() => void quick(v, -1)}><Minus size={13} /></button>
                                <b className="num">{v.stock}</b>
                                <button type="button" aria-label={`Add one ${v.sku}`} onClick={() => void quick(v, 1)}><Plus size={13} /></button>
                              </span>
                            </td>
                            <td className="num">{v.reorderLevel}</td>
                            <td className="num">{inr(v.stock * v.cost)}</td>
                            <td><StockBadge stock={v.stock} reorder={v.reorderLevel} /></td>
                            <td className="right"><button className="btn btn-sm" onClick={() => setAdjusting(v)}>Adjust…</button></td>
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
          )}

          {tab === 'audit' && <AuditSheet variants={variants} userId={user?.id ?? ''} />}
          {tab === 'ledger' && <Ledger variants={variants} users={users} />}
        </div>
      </div>

      {adjusting && (
        <AdjustModal
          variant={adjusting}
          userId={user?.id ?? ''}
          onClose={() => setAdjusting(null)}
          onDone={(msg) => { toast(msg, 'ok'); setAdjusting(null) }}
        />
      )}
      {restock && <RestockList items={needsRestock} onClose={() => setRestock(false)} />}
    </div>
  )
}

/* ---------------------------------------------------------------- */

function AdjustModal({ variant, userId, onClose, onDone }: {
  variant: VariantView; userId: string; onClose: () => void; onDone: (msg: string) => void
}) {
  const [mode, setMode] = useState<'set' | 'add' | 'remove'>('set')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  const n = Number(value) || 0
  const next = mode === 'set' ? n : mode === 'add' ? variant.stock + n : variant.stock - n
  const delta = next - variant.stock
  const invalid = next < 0
  const ready = value !== '' && delta !== 0 && !invalid && !!reason

  async function apply() {
    if (!ready) return
    await moveStock(variant.id, delta, 'adjust', 'MANUAL', note ? `${reason} — ${note}` : reason, userId)
    onDone(`${variant.sku}: ${variant.stock} → ${next}`)
  }

  return (
    <Modal open title="Adjust stock" onClose={onClose} footer={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-lg" disabled={!ready} onClick={() => void apply()}>Apply adjustment</button></>
    }>
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="bold">{variant.productName}</div>
        <div className="small muted">{variantLabel(variant.size, variant.color)} · <span className="mono">{variant.sku}</span> · <span className="mono">{variant.barcode}</span></div>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="small muted">Currently on hand</span>
          <span className="num bold" style={{ fontSize: 20 }}>{variant.stock}</span>
        </div>
      </div>
      <Segmented value={mode} options={[
        { value: 'set', label: 'Set to' }, { value: 'add', label: 'Add' }, { value: 'remove', label: 'Remove' },
      ]} onChange={setMode} />
      <div style={{ marginTop: 12 }}>
        <Field label={mode === 'set' ? 'New quantity' : mode === 'add' ? 'Pieces to add' : 'Pieces to remove'}>
          <input className="input input-lg num" autoFocus inputMode="numeric" value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') void apply() }} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Reason *">
          <select className={`select ${!reason && value ? 'invalid' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason…</option>
            {REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void apply() }} /></Field>
      </div>
      <div className={`pay-banner ${invalid ? 'short' : delta < 0 ? 'short' : delta > 0 ? 'change' : 'exact'}`} style={{ marginTop: 14 }}>
        {invalid ? <span>Can't remove more than the {variant.stock} on hand</span> : (
          <>
            <span>After this adjustment</span>
            <b className="num">{next} <span style={{ fontSize: 14 }}>({delta > 0 ? '+' : ''}{delta})</span></b>
          </>
        )}
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

/** Suggested re-order quantities for everything at or under its reorder level. */
function RestockList({ items, onClose }: { items: VariantView[]; onClose: () => void }) {
  const { toast } = useApp()
  const suggest = (v: VariantView) => Math.max(1, v.reorderLevel * 2 - v.stock)
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(items.map((v) => [v.id, suggest(v)])))
  const sorted = useMemo(() => items.slice().sort((a, b) => a.productName.localeCompare(b.productName) || a.color.localeCompare(b.color)), [items])
  const pieces = sorted.reduce((s, v) => s + (qty[v.id] ?? 0), 0)
  const cost = round2(sorted.reduce((s, v) => s + (qty[v.id] ?? 0) * v.cost, 0))

  const lines = () => sorted.filter((v) => (qty[v.id] ?? 0) > 0)

  return (
    <Modal open title="Restock list" width="wide" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={() => {
          const text = lines().map((v) => `${v.productName} · ${variantLabel(v.size, v.color)} · ${qty[v.id]} pcs`).join('\n')
          void navigator.clipboard?.writeText(text).then(() => toast('List copied', 'ok'), () => toast('Could not copy', 'err'))
        }}>Copy list</button>
        <button className="btn btn-primary" onClick={() => {
          downloadFile('restock-list.csv', toCSV(lines().map((v) => ({
            item: v.productName, sku: v.sku, size: v.size, color: v.color, onHand: v.stock, reorderLevel: v.reorderLevel,
            orderQty: qty[v.id], unitCost: v.cost, estCost: round2(qty[v.id] * v.cost),
          }))))
          toast('Restock list downloaded', 'ok')
        }}><Download size={15} /> Download CSV</button>
      </>
    }>
      <div className="small muted" style={{ marginBottom: 12 }}>
        Everything at or below its reorder level. The suggested quantity brings each size back up to twice its reorder level — change any number, or set 0 to leave it out.
      </div>
      <div className="card">
        <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Item</th><th>Size / Colour</th><th className="num">On hand</th><th className="num">Reorder at</th><th className="num">Order qty</th><th className="num">Est. cost</th></tr></thead>
            <tbody>
              {sorted.map((v) => (
                <tr key={v.id}>
                  <td><div className="bold">{v.productName}</div><div className="small muted mono">{v.sku}</div></td>
                  <td>{variantLabel(v.size, v.color)}</td>
                  <td className="num"><StockBadge stock={v.stock} reorder={v.reorderLevel} /></td>
                  <td className="num">{v.reorderLevel}</td>
                  <td className="num">
                    <input className="input num cell-input" inputMode="numeric" value={qty[v.id] ?? 0} aria-label={`Order quantity ${v.sku}`}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setQty({ ...qty, [v.id]: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
                  </td>
                  <td className="num">{inr((qty[v.id] ?? 0) * v.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="row between" style={{ marginTop: 14 }}>
        <span className="small muted">{lines().length} lines</span>
        <span><b className="num">{pieces}</b> pieces · about <b className="num">{inr(cost)}</b> at cost</span>
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

interface Draft { counted: Record<string, number>; order: string[] }

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(AUDIT_KEY)
    if (raw) { const d = JSON.parse(raw) as Draft; if (d && d.counted && Array.isArray(d.order)) return d }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return { counted: {}, order: [] }
}

/** Physical count: scan every piece on the shelf, review the differences, then post them in one go. */
function AuditSheet({ variants, userId }: { variants: VariantView[]; userId: string }) {
  const { toast } = useApp()
  const [draft, setDraft] = useState<Draft>(loadDraft)
  const [scan, setScan] = useState('')
  const [last, setLast] = useState<{ ok: boolean; text: string; id?: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const byId = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])

  useEffect(() => { inputRef.current?.focus() }, [])
  // The count survives a refresh or an accidental click elsewhere.
  useEffect(() => {
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(draft)) } catch { /* ignore */ }
  }, [draft])

  const bump = (vid: string, by: number) => setDraft((d) => {
    const next = Math.max(0, (d.counted[vid] ?? 0) + by)
    const counted = { ...d.counted }
    let order = d.order.filter((x) => x !== vid)
    if (next === 0 && by < 0) delete counted[vid]
    else { counted[vid] = next; order = [vid, ...order] }
    return { counted, order }
  })

  async function onScan() {
    const code = scan.trim()
    if (!code) return
    const v = await findByBarcode(code)
    setScan('')
    if (!v) { setLast({ ok: false, text: `Unknown barcode ${code} — not in your catalogue` }); return }
    bump(v.id, 1)
    setLast({ ok: true, text: `${v.productName} · ${variantLabel(v.size, v.color)} → counted ${(draft.counted[v.id] ?? 0) + 1}`, id: v.id })
  }

  const sheet = draft.order
    .map((vid) => ({ vid, v: byId.get(vid), physical: draft.counted[vid] ?? 0 }))
    .filter((r): r is { vid: string; v: VariantView; physical: number } => !!r.v)
    .map((r) => ({ ...r, variance: r.physical - r.v.stock }))
    // Differences first — they are what needs a decision. Newest scan first within each group.
    .sort((a, b) => Number(b.variance !== 0) - Number(a.variance !== 0))

  const changes = sheet.filter((r) => r.variance !== 0)
  // A count far below the system figure usually means "not every piece was scanned", not a real loss.
  const lowCounts = sheet.filter((r) => r.v.stock >= 3 && r.v.stock - r.physical >= 3 && r.physical < r.v.stock * 0.5)
  const totalVariance = sheet.reduce((s, r) => s + r.variance, 0)
  const gain = changes.filter((r) => r.variance > 0).reduce((s, r) => s + r.variance, 0)
  const loss = changes.filter((r) => r.variance < 0).reduce((s, r) => s + r.variance, 0)
  const scanned = Object.values(draft.counted).reduce((s, n) => s + n, 0)

  async function post() {
    for (const r of changes) await moveStock(r.v.id, r.variance, 'audit', 'AUDIT', 'Physical count correction', userId)
    setDraft({ counted: {}, order: [] })
    setLast(null)
    toast(changes.length ? `${changes.length} SKUs corrected from the count` : 'Everything already matched', 'ok')
  }

  return (
    <>
      <section className="card" style={{ padding: 16 }}>
        <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <h2>Physical stock count</h2>
          <div className="row gap-6">
            {last?.ok && last.id && <button className="btn" onClick={() => { bump(last.id!, -1); setLast(null); inputRef.current?.focus() }}>Undo last scan</button>}
            <button className="btn" disabled={!sheet.length} onClick={() => { setDraft({ counted: {}, order: [] }); setLast(null) }}>Clear sheet</button>
            <button className="btn btn-primary" disabled={!sheet.length} onClick={() => setConfirming(true)}>Review &amp; post…</button>
          </div>
        </div>
        <div className="row gap-6">
          <input ref={inputRef} className="scan-input" style={{ paddingLeft: 14 }} placeholder="Scan each piece on the shelf…"
            value={scan} onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onScan() } }} />
          <button className="btn btn-lg" onClick={() => void onScan()}>Add</button>
        </div>
        <div className={`pay-banner ${!last ? 'exact' : last.ok ? 'change' : 'short'}`} style={{ marginTop: 12 }} aria-live="polite">
          <span>{last ? last.text : 'Scan every piece of each item you are counting — its stock will be set to the number you scan. Items you don\'t scan are left alone, so you can count one rack at a time.'}</span>
        </div>
        {sheet.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>Your count is saved automatically — you can leave this page and come back.</div>}
        {lowCounts.length > 0 && (
          <div className="pay-banner short" style={{ marginTop: 12, alignItems: 'flex-start', padding: '10px 16px' }} role="alert">
            <span><b>{lowCounts.length} item{lowCounts.length === 1 ? '' : 's'} counted far below the system number.</b> If you haven't scanned every piece of {lowCounts.length === 1 ? 'it' : 'them'}, keep scanning — posting will set the stock to what you scanned.</span>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Count sheet — {sheet.length} SKUs · {scanned} pieces</h2>
          <span className={`badge ${totalVariance === 0 ? 'badge-ok' : 'badge-warn'}`}>Net difference {totalVariance > 0 ? '+' : ''}{totalVariance}</span>
        </div>
        {!sheet.length ? <Empty icon={<ScanSearchIcon size={24} />} title="Start scanning to build the count sheet" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Item</th><th>Size / Colour</th><th className="num">In system</th><th className="num">Counted</th><th className="num">Difference</th><th /></tr></thead>
              <tbody>
                {sheet.map((r) => (
                  <tr key={r.vid} style={lowCounts.includes(r) ? { background: 'var(--warn-bg)' } : last?.id === r.vid ? { background: 'var(--brand-50)' } : undefined}>
                    <td><div className="bold">{r.v.productName}</div><div className="small muted mono">{r.v.sku}</div></td>
                    <td>{r.v.size} / {r.v.color}</td>
                    <td className="num">{r.v.stock}</td>
                    <td className="num">
                      <input className="input num cell-input" inputMode="numeric" value={r.physical} aria-label={`Counted ${r.v.sku}`}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => {
                          const n = Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0)
                          setDraft((d) => ({ ...d, counted: { ...d.counted, [r.vid]: n } }))
                        }} />
                    </td>
                    <td className="num">
                      {r.variance === 0
                        ? <span className="badge badge-ok">Matches</span>
                        : <span className={`badge ${r.variance < 0 ? 'badge-danger' : 'badge-brand'}`}>{r.variance > 0 ? '+' : ''}{r.variance}</span>}
                      {lowCounts.includes(r) && <div className="small" style={{ color: 'var(--warn)', fontWeight: 650, marginTop: 4 }}>All scanned?</div>}
                    </td>
                    <td className="right">
                      <button className="btn btn-sm btn-ghost" title="Remove from sheet" aria-label={`Remove ${r.v.sku}`}
                        onClick={() => setDraft((d) => { const counted = { ...d.counted }; delete counted[r.vid]; return { counted, order: d.order.filter((x) => x !== r.vid) } })}><Close size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Confirm
        open={confirming}
        title="Post this count to stock?"
        confirmLabel={changes.length ? `Correct ${changes.length} SKU${changes.length === 1 ? '' : 's'}` : 'Finish'}
        danger={changes.length > 0}
        message={changes.length ? (
          <>
            <strong>{changes.length}</strong> SKUs will change in your stock: <strong style={{ color: 'var(--ok)' }}>+{gain}</strong> pieces up and <strong style={{ color: 'var(--danger)' }}>{loss}</strong> down
            (net {totalVariance > 0 ? '+' : ''}{totalVariance}). {sheet.length - changes.length} already match.{lowCounts.length > 0 && <> <strong style={{ color: 'var(--danger)' }}>{lowCounts.length} count{lowCounts.length === 1 ? ' looks' : 's look'} unusually low — check you scanned every piece.</strong></>} This is written to the stock ledger and can't be undone in one step.
          </>
        ) : <>Every counted SKU already matches the system, so nothing will change.</>}
        onConfirm={() => void post()}
        onClose={() => { setConfirming(false); inputRef.current?.focus() }}
      />
    </>
  )
}

/* ---------------------------------------------------------------- */

function Ledger({ variants, users }: { variants: VariantView[]; users: User[] }) {
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [take, setTake] = useState(300)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const vmap = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  const umap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  // Items whose name or SKU match the search; the movement filter itself runs inside the database
  // query, so choosing a type or typing a search looks through the whole history, not just the newest rows.
  const matchIds = useMemo(() => {
    if (!needle) return null
    const s = new Set<string>()
    for (const v of variants) if (v.productName.toLowerCase().includes(needle) || v.sku.toLowerCase().includes(needle)) s.add(v.id)
    return s
  }, [needle, variants])
  const moves = useLiveQuery(
    () => db.moves.orderBy('at').reverse()
      .filter((m) => (!type || m.type === type)
        && (!matchIds || matchIds.has(m.variantId) || m.ref.toLowerCase().includes(needle) || m.reason.toLowerCase().includes(needle)))
      .limit(take).toArray(),
    [take, type, needle, matchIds], [] as StockMove[],
  ) ?? []

  const rows = moves

  return (
    <>
      <div className="bills-filters">
        <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
          <span className="ico"><Search /></span>
          <input className="input" placeholder="Search item, SKU, bill no or reason" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Movement type">
          <option value="">All movements</option>
          <option value="sale">Sales</option>
          <option value="return">Returns</option>
          <option value="purchase">Purchases</option>
          <option value="adjust">Adjustments</option>
          <option value="audit">Audit corrections</option>
          <option value="opening">Opening stock</option>
          <option value="collection">Milk collected</option>
          <option value="production">Production</option>
          <option value="receipt">Lots received</option>
          <option value="wastage">Wastage</option>
        </select>
        <div className="grow" />
        <span className="small muted"><b className="num">{rows.length}{rows.length >= take ? '+' : ''}</b> movements{type || needle ? ' match' : ''}</span>
      </div>

      <section className="card">
        {!rows.length ? <Empty icon={<StockIcon size={24} />} title="No movements match" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Item</th><th>Type</th><th>Reference</th><th>Reason</th><th>By</th><th className="num">Change</th></tr></thead>
              <tbody>
                {rows.map((m) => {
                  const v = vmap.get(m.variantId)
                  return (
                    <tr key={m.id}>
                      <td className="muted">{fmtDateTime(m.at)}</td>
                      <td>{v ? <><span className="bold">{v.productName}</span> <span className="small muted">{v.size}/{v.color}</span></> : <span className="muted">deleted item</span>}</td>
                      <td><span className={`badge ${MOVE_BADGE[m.type]}`}>{m.type}</span></td>
                      <td className="mono small">{m.ref}</td>
                      <td className="muted">{m.reason}</td>
                      <td className="muted">{umap.get(m.userId)?.name.split(' ')[0] ?? '—'}</td>
                      <td className="num bold" style={{ color: m.qty < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {moves.length >= take && (
              <div className="center" style={{ padding: 14 }}>
                <button className="btn" onClick={() => setTake((t) => t + 300)}>Load 300 older movements</button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  )
}
