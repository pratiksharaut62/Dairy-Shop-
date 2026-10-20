import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { loadVariantViews, nextBarcode, type VariantView } from '../db/ops'
import { useDebounced } from '../lib/useDebounced'
import { Empty, Confirm, Segmented } from '../components/ui'
import { LabelsIcon, Minus, Plus, Printer, Refresh, Search } from '../components/icons'
import { useApp } from '../state'
import { usePrint } from '../print/PrintProvider'
import { LabelFace, LabelSheet, labelRowWidthMm, labelVars, type LabelSpec } from '../print/LabelSheet'
import type { Product } from '../db/types'

const SHOWN = 300
const BIG_PRINT = 100

type Mode = 'stock' | 'one' | 'manual'

export default function Labels() {
  const { settings, toast } = useApp()
  const { print } = usePrint()
  const variants = useLiveQuery(() => loadVariantViews(), [], [] as VariantView[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []

  const [q, setQ] = useState('')
  const [productId, setProductId] = useState('')
  const [mode, setMode] = useState<Mode>('stock')
  const [copies, setCopies] = useState<Record<string, number>>({})
  const [showMrp, setShowMrp] = useState(true)
  const [confirmPrint, setConfirmPrint] = useState(false)
  const [reissue, setReissue] = useState<VariantView | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  // Every typed word must match somewhere ("oxford navy xl"), like the billing search.
  const rows = useMemo(() => variants
    .filter((v) => !productId || v.productId === productId)
    .filter((v) => {
      if (!needle) return true
      const hay = `${v.productName} ${v.styleCode} ${v.sku} ${v.barcode} ${v.color} ${v.size}`.toLowerCase()
      return needle.split(/\s+/).every((t) => hay.includes(t))
    })
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.color.localeCompare(b.color)), [variants, needle, productId])

  const copiesFor = (v: VariantView) => (mode === 'stock' ? v.stock : mode === 'one' ? 1 : (copies[v.id] ?? 0))

  // "Choose quantity" remembers what you picked across searches, so a mixed batch can be built up;
  // the other two modes print everything that matches the current search / item.
  const selected = useMemo(() => {
    if (mode === 'manual') {
      const byId = new Map(variants.map((v) => [v.id, v]))
      return Object.entries(copies).filter(([vid, n]) => n > 0 && byId.has(vid)).map(([vid, n]) => ({ v: byId.get(vid)!, n }))
    }
    return rows.map((v) => ({ v, n: copiesFor(v) })).filter((r) => r.n > 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, copies, rows, variants])
  const totalLabels = selected.reduce((s, r) => s + r.n, 0)

  const labels: LabelSpec[] = selected.map(({ v, n }) => ({
    barcode: v.barcode, name: v.productName, size: v.size, color: v.color, sku: v.sku, mrp: v.mrp, price: v.price, copies: n,
  }))

  const setN = (vid: string, n: number) => setCopies((c) => ({ ...c, [vid]: Math.max(0, Math.min(999, n)) }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function doPrint() {
    if (!settings || !totalLabels) return
    print(
      <LabelSheet labels={labels} storeName={settings.name} showMrp={showMrp}
        widthMm={settings.labelWidthMm} heightMm={settings.labelHeightMm}
        across={settings.labelsAcross} gapMm={settings.labelGapMm} />,
      { pageSizeMm: { w: labelRowWidthMm(settings.labelWidthMm, settings.labelsAcross, settings.labelGapMm), h: settings.labelHeightMm } },
    )
  }

  async function reissueBarcode(v: VariantView) {
    const code = await nextBarcode()
    await db.variants.update(v.id, { barcode: code })
    toast(`New barcode issued for ${v.sku} — reprint its labels`, 'ok')
  }

  /** Enter in a quantity box moves to the next row's box, like a spreadsheet. */
  function nextBox(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.lbl-qty input')]
    boxes[boxes.indexOf(e.currentTarget) + 1]?.focus()
  }

  const w = settings?.labelWidthMm ?? 50
  const h = settings?.labelHeightMm ?? 38
  const shown = rows.slice(0, SHOWN)

  return (
    <div className="inv-scope">
      <header className="topbar topbar-tools">
        <h1>Barcode Labels</h1>
        <div className="hdr-tools">
          <div className="search-wrap" style={{ flex: '1 1 170px', minWidth: 150, maxWidth: 260 }}>
            <span className="ico"><Search /></span>
            <input ref={searchRef} className="input" placeholder="Search item or SKU…" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); searchRef.current?.blur() } }} />
          </div>
          <select className="select" style={{ width: 170 }} value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Item">
            <option value="">All items</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.styleCode})</option>)}
          </select>
          <Segmented value={mode} options={[
            { value: 'stock', label: 'One per piece in stock' },
            { value: 'one', label: 'One each' },
            { value: 'manual', label: 'Choose quantity' },
          ]} onChange={setMode} />
        </div>
        <div className="hdr-actions">
          <label className="checkbox"><input type="checkbox" checked={showMrp} onChange={(e) => setShowMrp(e.target.checked)} />Show MRP</label>
          <button className="btn btn-primary" disabled={!totalLabels}
            onClick={() => (totalLabels > BIG_PRINT ? setConfirmPrint(true) : doPrint())}>
            <Printer size={15} /> Print {totalLabels.toLocaleString('en-IN')} label{totalLabels === 1 ? '' : 's'}
          </button>
        </div>
      </header>

      <div className="page">
        <div className="page-narrow grid split-labels">
          <section className="card">
            <div className="card-head">
              <h2>Items ({rows.length})</h2>
              {mode === 'manual' && totalLabels > 0 && <button className="link-btn" onClick={() => setCopies({})}>Clear quantities</button>}
            </div>
            {!rows.length ? <Empty icon={<LabelsIcon size={24} />} title="No items match" hint="Try a different search." /> : (
              <div className="table-wrap" style={{ maxHeight: '66vh', overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Item</th><th>Size / Colour</th><th>Barcode</th><th className="num">Stock</th><th className="num">Labels</th><th /></tr></thead>
                  <tbody>
                    {shown.map((v) => {
                      const n = copiesFor(v)
                      return (
                        <tr key={v.id} style={mode === 'manual' && n > 0 ? { background: 'var(--brand-50)' } : undefined}>
                          <td><div className="bold">{v.productName}</div><div className="small muted mono">{v.sku}</div></td>
                          <td>{variantLabel(v.size, v.color)}</td>
                          <td className="mono small">{v.barcode}</td>
                          <td className="num">{v.stock}</td>
                          <td className="num">
                            {mode === 'manual' ? (
                              <span className="qty-quick lbl-qty">
                                <button type="button" aria-label={`Fewer labels for ${v.sku}`} disabled={n <= 0} onClick={() => setN(v.id, n - 1)}><Minus size={13} /></button>
                                <input className="input num cell-input" style={{ width: 56, textAlign: 'center' }} inputMode="numeric" value={n || ''} placeholder="0" aria-label={`Labels for ${v.sku}`}
                                  onFocus={(e) => e.currentTarget.select()} onKeyDown={nextBox}
                                  onChange={(e) => setN(v.id, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                                <button type="button" aria-label={`More labels for ${v.sku}`} onClick={() => setN(v.id, n + 1)}><Plus size={13} /></button>
                              </span>
                            ) : <span className="bold">{n}</span>}
                          </td>
                          <td className="right"><button className="btn btn-sm btn-ghost" title="Issue a new barcode" aria-label={`Issue a new barcode for ${v.sku}`} onClick={() => setReissue(v)}><Refresh size={14} /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {rows.length > SHOWN && <div className="small muted center" style={{ padding: 10 }}>Showing the first {SHOWN} of {rows.length} — narrow the search to see the rest. Printing still includes all of them{mode === 'manual' ? ' you have chosen' : ''}.</div>}
              </div>
            )}
          </section>

          <section className="card" style={{ alignSelf: 'start', position: 'sticky', top: 0 }}>
            <div className="card-head">
              <h2>Label preview</h2>
              <span className={`badge ${totalLabels ? 'badge-brand' : ''}`}>{totalLabels.toLocaleString('en-IN')} labels · {selected.length} SKUs</span>
            </div>
            <div className="card-body">
              {!selected.length ? (
                <Empty icon={<Printer size={24} />} title="Nothing selected yet" hint={mode === 'manual' ? 'Set a quantity next to an item — its label appears here.' : 'No items match — labels appear here before you print.'} />
              ) : (
                <>
                  <div className="label-preview" style={labelVars(w, h)}>
                    {selected.slice(0, 4).map(({ v, n }) => (
                      <div key={v.id} className="label-preview-item">
                        <div className="label-cell label-card">
                          <LabelFace l={{ barcode: v.barcode, name: v.productName, size: v.size, color: v.color, sku: v.sku, mrp: v.mrp, price: v.price }}
                            storeName={settings?.name ?? ''} showMrp={showMrp} widthMm={w} heightMm={h} />
                        </div>
                        <div className="small muted center">× {n}</div>
                      </div>
                    ))}
                  </div>
                  {selected.length > 4 && <div className="small muted center" style={{ marginTop: 10 }}>+ {selected.length - 4} more SKUs will print.</div>}
                </>
              )}
              <div className="small muted" style={{ marginTop: 14 }}>
                Shown at actual size. Prints {settings && settings.labelsAcross > 1 ? `${settings.labelsAcross} across, ` : 'one per page, '}{w} × {h} mm.
                Change the size in Settings to match your sticker roll.
              </div>
            </div>
          </section>
        </div>
      </div>

      <Confirm
        open={confirmPrint}
        title={`Print ${totalLabels.toLocaleString('en-IN')} labels?`}
        confirmLabel={`Print ${totalLabels.toLocaleString('en-IN')} labels`}
        message={<>That is a lot of stickers — <strong>{selected.length} different items</strong>, {totalLabels.toLocaleString('en-IN')} labels in total. Check the quantities before sending them to the printer.</>}
        onConfirm={doPrint}
        onClose={() => setConfirmPrint(false)}
      />

      <Confirm
        open={!!reissue}
        title="Issue a new barcode?"
        danger
        confirmLabel="Issue new barcode"
        message={<>
          <strong>{reissue?.productName}</strong> ({variantLabel(reissue?.size, reissue?.color)}) will get a different barcode.
          Every label already stuck on a garment of this size will <strong>stop scanning</strong> until you reprint it. Only do this if the current barcode is wrong or duplicated.
        </>}
        onConfirm={() => reissue && void reissueBarcode(reissue)}
        onClose={() => setReissue(null)}
      />
    </div>
  )
}
