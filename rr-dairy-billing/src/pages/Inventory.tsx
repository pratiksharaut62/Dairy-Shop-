import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { nextBarcode } from '../db/ops'
import { id } from '../lib/id'
import { inr } from '../lib/money'
import { skuFor } from '../lib/variantLabel'
import { nextStyleCode, sortCategories } from '../lib/styleCode'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Card, Confirm, Empty, Field, Modal, StockBadge } from '../components/ui'
import { CategoryPicker } from '../components/CategoryPicker'
import { Download, InventoryIcon, PencilIcon, Plus, Search, TrashIcon } from '../components/icons'
import { useApp } from '../state'
import type { Category, Product, Variant } from '../db/types'

const UNITS = ['L', 'kg', 'g', 'pcs', 'pack']
/** GST rates a dairy product typically carries; "store" falls back to the price slabs in Settings. */
const GST: Array<{ value: string; label: string }> = [
  { value: '0', label: '0 %' }, { value: '5', label: '5 %' }, { value: '12', label: '12 %' }, { value: '18', label: '18 %' }, { value: 'store', label: 'Use store slabs' },
]
const SHELF_HINT: Record<string, number> = { cat_milk: 3, cat_flavmilk: 7, cat_curd: 7, cat_buttermilk: 5, cat_paneer: 7, cat_cheese: 60, cat_butter: 90, cat_ghee: 270, cat_cream: 5, cat_sweets: 5, cat_icecream: 180 }

interface PackDraft { size: string; cost: string; mrp: string; price: string; stock: string; reorder: string }
const blankPack = (): PackDraft => ({ size: '', cost: '', mrp: '', price: '', stock: '', reorder: '5' })

interface Draft {
  name: string; categoryId: string; unit: string; shelf: string; hsn: string; gst: string; brand: string; packs: PackDraft[]
}
const EMPTY: Draft = { name: '', categoryId: '', unit: 'pcs', shelf: '', hsn: '0401', gst: '5', brand: '', packs: [blankPack()] }

export default function Inventory() {
  const { user, toast, can } = useApp()
  const [q, setQ] = useState('')
  const needle = useDebounced(q.trim().toLowerCase(), 120)
  const [cat, setCat] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Product | null>(null)
  const [addingPack, setAddingPack] = useState<Product | null>(null)

  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const variants = useLiveQuery(() => db.variants.toArray(), [], [] as Variant[]) ?? []
  const categories = useLiveQuery(() => db.categories.toArray(), [], [] as Category[]) ?? []
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const byProduct = useMemo(() => {
    const m = new Map<string, Variant[]>()
    for (const v of variants) m.set(v.productId, [...(m.get(v.productId) ?? []), v])
    return m
  }, [variants])

  const rows = useMemo(() => products
    .filter((p) => (showArchived ? p.active === false : p.active !== false))
    .filter((p) => p.categoryId !== 'cat_rawmilk')
    .filter((p) => !cat || p.categoryId === cat)
    .filter((p) => !needle || [p.name, p.styleCode, p.brand, ...(byProduct.get(p.id) ?? []).flatMap((v) => [v.sku, v.barcode, v.size])].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name)), [products, showArchived, cat, needle, byProduct])
  const cats = useMemo(() => sortCategories(categories.filter((c) => c.id !== 'cat_rawmilk')), [categories])

  async function setActive(p: Product, active: boolean) {
    await db.products.update(p.id, { active })
    toast(active ? `${p.name} restored` : `${p.name} archived`, 'ok')
  }

  function exportCsv() {
    downloadFile(`products-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(variants.flatMap((v) => {
      const p = products.find((x) => x.id === v.productId)
      if (!p) return []
      return [{ code: p.styleCode, product: p.name, category: catMap.get(p.categoryId)?.name ?? '', pack: v.size, unit: p.unit ?? '', sku: v.sku, barcode: v.barcode,
        gst: p.taxRate ?? '', shelfLifeDays: p.shelfLifeDays ?? '', cost: v.cost, mrp: v.mrp, price: v.price, stock: v.stock, reorderLevel: v.reorderLevel }]
    })))
  }

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Products</h1>
        <div className="grow" />
        <button className="btn" disabled={!variants.length} onClick={exportCsv}><Download size={15} /> Export</button>
        {can('inventory') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New product</button>}
      </header>
      <div className="page"><div className="page-narrow col gap-16">
        <div className="bills-filters">
          <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
            <span className="ico"><Search /></span>
            <input className="input" placeholder="Search name, code, pack or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="select" style={{ width: 190 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
            <option value="">All categories</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="checkbox"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived</label>
          <div className="grow" />
          <span className="small muted"><b className="num">{rows.length}</b> products</span>
        </div>

        {!rows.length ? (
          <Card><Empty icon={<InventoryIcon size={24} />} title={products.length ? 'No product matches' : 'No products yet'} hint={products.length ? 'Try a different search or category.' : 'Add milk packets, curd, paneer, ghee… each pack size gets its own barcode.'} /></Card>
        ) : rows.map((p) => {
          const vs = (byProduct.get(p.id) ?? []).sort((a, b) => a.sku.localeCompare(b.sku))
          return (
            <Card key={p.id} tight
              title={<div><h2>{p.name}</h2><div className="small muted">{catMap.get(p.categoryId)?.name ?? 'No category'} · {p.styleCode}{p.unit ? ` · sold in ${p.unit}` : ''}{p.shelfLifeDays ? ` · ${p.shelfLifeDays} day shelf life` : ''}{p.taxRate !== undefined ? ` · GST ${p.taxRate}%` : ''}</div></div>}
              action={can('inventory') && <div className="row gap-6">
                <button className="btn btn-sm" onClick={() => setAddingPack(p)}><Plus size={13} /> Pack size</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><PencilIcon size={15} /></button>
                {p.active === false ? <button className="btn btn-sm" onClick={() => void setActive(p, true)}>Restore</button>
                  : <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setArchiving(p)} aria-label={`Archive ${p.name}`}><TrashIcon size={15} /></button>}
              </div>}>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Pack</th><th>Barcode</th><th className="num">Cost</th><th className="num">MRP</th><th className="num">Price</th><th className="num">Stock</th></tr></thead>
                  <tbody>{vs.map((v) => (
                    <tr key={v.id}>
                      <td><div className="bold">{v.size || '—'}</div><div className="small muted mono">{v.sku}</div></td>
                      <td className="mono small">{v.barcode}</td>
                      {(['cost', 'mrp', 'price'] as const).map((f) => (
                        <td key={f} className="num">{can('inventory')
                          ? <input className="input num" style={{ width: 84, textAlign: 'right', fontWeight: f === 'price' ? 700 : 400 }} inputMode="decimal" defaultValue={v[f]} aria-label={`${f} for ${v.size}`}
                              onBlur={(e) => { const n = Number(e.target.value.replace(/[^\d.]/g, '')) || 0; if (n !== v[f]) void db.variants.update(v.id, { [f]: n } as Partial<Variant>) }} />
                          : inr(v[f])}</td>
                      ))}
                      <td className="num"><StockBadge stock={v.stock} reorder={v.reorderLevel} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Card>
          )
        })}
      </div></div>
      {editing && <ProductForm product={editing === 'new' ? null : editing} categories={cats} products={products} userId={user?.id ?? ''} onClose={() => setEditing(null)} />}
      {addingPack && <PackForm product={addingPack} onClose={() => setAddingPack(null)} />}
      <Confirm open={!!archiving} title="Archive product?" confirmLabel="Archive" danger
        message={<><strong>{archiving?.name}</strong> disappears from billing and stock lists. Past bills keep it, and you can restore it any time.</>}
        onConfirm={() => archiving && void setActive(archiving, false)} onClose={() => setArchiving(null)} />
    </div>
  )
}

function ProductForm({ product, categories, products, onClose }: { product: Product | null; categories: Category[]; products: Product[]; userId: string; onClose: () => void }) {
  const { toast } = useApp()
  const isNew = !product
  const [d, setD] = useState<Draft>(product ? {
    ...EMPTY, name: product.name, categoryId: product.categoryId, unit: product.unit ?? 'pcs', shelf: product.shelfLifeDays ? String(product.shelfLifeDays) : '',
    hsn: product.hsn, gst: product.taxRate === undefined ? 'store' : String(product.taxRate), brand: product.brand, packs: [],
  } : EMPTY)
  const existing = useLiveQuery(() => (product ? db.variants.where('productId').equals(product.id).toArray() : Promise.resolve([] as Variant[])), [product?.id], [] as Variant[]) ?? []
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  const cat = categories.find((c) => c.id === d.categoryId)
  const bad = { name: tried && !d.name.trim(), category: tried && !d.categoryId, packs: tried && isNew && !d.packs.some((p) => p.size.trim() && Number(p.price) > 0) }

  function pickCategory(id: string) {
    setD((p) => ({ ...p, categoryId: id, shelf: p.shelf || (SHELF_HINT[id] ? String(SHELF_HINT[id]) : ''), gst: p.gst }))
  }

  async function save() {
    setTried(true)
    if (!d.name.trim() || !d.categoryId) return
    if (isNew && !d.packs.some((p) => p.size.trim() && Number(p.price) > 0)) return
    setBusy(true)
    try {
      const common = {
        name: d.name.trim(), categoryId: d.categoryId, brand: d.brand.trim(), hsn: d.hsn.trim(), unit: d.unit,
        shelfLifeDays: Number(d.shelf) > 0 ? Number(d.shelf) : 0,
        taxRate: d.gst === 'store' ? undefined : Number(d.gst),
      }
      if (product) {
        // `undefined` is not stored by IndexedDB updates, so a cleared GST rate is set explicitly.
        await db.products.update(product.id, { ...common, taxRate: common.taxRate as number })
        toast(`${common.name} updated`, 'ok')
      } else {
        const styleCode = nextStyleCode(cat, products)
        const prod: Product = { id: id('prd'), styleCode, fabric: '', season: '', active: true, createdAt: Date.now(), ...common }
        await db.products.add(prod)
        let made = 0
        for (const p of d.packs) {
          if (!p.size.trim() || !(Number(p.price) > 0)) continue
          await db.variants.add({
            id: id('var'), productId: prod.id, sku: skuFor(styleCode, '', p.size), barcode: await nextBarcode(), size: p.size.trim(), color: '',
            cost: Number(p.cost) || 0, mrp: Number(p.mrp) || Number(p.price), price: Number(p.price), stock: 0, reorderLevel: Number(p.reorder) || 0,
          })
          made++
        }
        toast(`${prod.name} added — ${made} pack size${made === 1 ? '' : 's'} with barcodes`, 'ok')
      }
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }

  const setPack = (i: number, patch: Partial<PackDraft>) => setD((p) => ({ ...p, packs: p.packs.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))
  const digits = (s: string) => s.replace(/[^\d.]/g, '')

  return (
    <Modal open width="wide" title={isNew ? 'New product' : `Edit ${product!.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void save()}>{isNew ? 'Create product' : 'Save changes'}</button></>}>
      <div className="grid grid-2">
        <Field label="Product name *"><input className={`input input-lg ${bad.name ? 'invalid' : ''}`} autoFocus value={d.name} placeholder="Toned milk, Paneer, Cow ghee…" onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Brand"><input className="input input-lg" value={d.brand} onChange={(e) => setD({ ...d, brand: e.target.value })} /></Field>
      </div>
      <div className="form-section"><h3>Category *</h3>
        {bad.category && <div className="small" style={{ color: 'var(--danger)', marginBottom: 6 }}>Pick a category</div>}
        <CategoryPicker categories={categories} value={d.categoryId} onPick={pickCategory} />
      </div>
      <div className="grid grid-3" style={{ marginTop: 18 }}>
        <Field label="Sold in"><select className="select" value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        <Field label="Shelf life (days)" hint="0 = does not expire"><input className="input num" inputMode="numeric" value={d.shelf} onChange={(e) => setD({ ...d, shelf: digits(e.target.value) })} /></Field>
        <Field label="GST"><select className="select" value={d.gst} onChange={(e) => setD({ ...d, gst: e.target.value })}>{GST.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select></Field>
        <Field label="HSN"><input className="input mono" value={d.hsn} onChange={(e) => setD({ ...d, hsn: e.target.value })} /></Field>
      </div>

      {isNew ? (
        <div className="form-section"><h3>Pack sizes &amp; prices</h3>
          {bad.packs && <div className="small" style={{ color: 'var(--danger)', marginBottom: 6 }}>Add at least one pack with a size and selling price</div>}
          {d.packs.map((p, i) => (
            <div key={i} className="grid grid-3" style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
              <Field label="Pack size"><input className="input" placeholder="500 ml / 1 kg / 200 g" value={p.size} onChange={(e) => setPack(i, { size: e.target.value })} /></Field>
              <Field label="Selling price ₹"><input className="input num" inputMode="decimal" value={p.price} onChange={(e) => setPack(i, { price: digits(e.target.value) })} /></Field>
              <Field label="MRP ₹"><input className="input num" inputMode="decimal" value={p.mrp} onChange={(e) => setPack(i, { mrp: digits(e.target.value) })} /></Field>
              <Field label="Cost ₹"><input className="input num" inputMode="decimal" value={p.cost} onChange={(e) => setPack(i, { cost: digits(e.target.value) })} /></Field>
              <Field label="Reorder at"><input className="input num" inputMode="decimal" value={p.reorder} onChange={(e) => setPack(i, { reorder: digits(e.target.value) })} /></Field>
              <div className="row" style={{ alignItems: 'end' }}>{d.packs.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, packs: d.packs.filter((_, j) => j !== i) })}>Remove</button>}</div>
            </div>
          ))}
          <button className="btn btn-sm" onClick={() => setD({ ...d, packs: [...d.packs, blankPack()] })}><Plus size={13} /> Add pack size</button>
          <div className="tiny muted" style={{ marginTop: 8 }}>Stock starts at zero — receive it through Purchases, Lots, or Production so it is tracked.</div>
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 14 }}>
          {existing.length} pack size{existing.length === 1 ? '' : 's'}: {existing.map((v) => `${v.size} ${inr(v.price)}`).join(' · ')}. Edit prices on the product list; add a pack size with the “Pack size” button; adjust stock in Stock Control.
        </div>
      )}
    </Modal>
  )
}

function PackForm({ product, onClose }: { product: Product; onClose: () => void }) {
  const { toast } = useApp()
  const [p, setP] = useState<PackDraft>(blankPack())
  const digits = (s: string) => s.replace(/[^\d.]/g, '')
  async function save() {
    if (!p.size.trim() || !(Number(p.price) > 0)) { toast('Enter the pack size and selling price', 'err'); return }
    const sku = skuFor(product.styleCode, '', p.size)
    if (await db.variants.where('sku').equals(sku).first()) { toast(`${p.size} already exists for ${product.name}`, 'err'); return }
    await db.variants.add({
      id: id('var'), productId: product.id, sku, barcode: await nextBarcode(), size: p.size.trim(), color: '',
      cost: Number(p.cost) || 0, mrp: Number(p.mrp) || Number(p.price), price: Number(p.price), stock: 0, reorderLevel: Number(p.reorder) || 0,
    })
    toast(`${p.size} added to ${product.name}`, 'ok')
    onClose()
  }
  return (
    <Modal open title={`Add pack size · ${product.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" onClick={() => void save()}>Add pack</button></>}>
      <div className="grid grid-3">
        <Field label="Pack size *"><input className="input" autoFocus placeholder="500 ml" value={p.size} onChange={(e) => setP({ ...p, size: e.target.value })} /></Field>
        <Field label="Selling price ₹ *"><input className="input num" inputMode="decimal" value={p.price} onChange={(e) => setP({ ...p, price: digits(e.target.value) })} /></Field>
        <Field label="MRP ₹"><input className="input num" inputMode="decimal" value={p.mrp} onChange={(e) => setP({ ...p, mrp: digits(e.target.value) })} /></Field>
        <Field label="Cost ₹"><input className="input num" inputMode="decimal" value={p.cost} onChange={(e) => setP({ ...p, cost: digits(e.target.value) })} /></Field>
        <Field label="Reorder at"><input className="input num" inputMode="decimal" value={p.reorder} onChange={(e) => setP({ ...p, reorder: digits(e.target.value) })} /></Field>
      </div>
    </Modal>
  )
}
