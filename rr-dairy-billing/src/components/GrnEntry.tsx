import { useEffect, useMemo, useRef, useState } from 'react'
import { inr, round2 } from '../lib/money'
import { buildIndex, searchGroups, sizeRank } from '../lib/posSearch'
import { createStyle } from '../db/catalog'
import { db } from '../db'
import { Field } from './ui'
import { TagInput, parseTags } from './TagInput'
import { CategoryPicker } from './CategoryPicker'
import { nextStyleCode, sortCategories } from '../lib/styleCode'
import { moveOnEnter } from '../lib/formNav'
import { useApp } from '../state'
import type { VariantView } from '../db/ops'
import type { Category, Product } from '../db/types'

export interface ReceiveLine { variant: VariantView; qty: number; cost: number }

/**
 * Enter a whole delivery of one style in seconds: pick the style, then type how many of each
 * size and colour arrived into a grid — instead of scanning or searching piece by piece.
 */
export function SizeGrid({ variants, focusProductId, onAdd }: {
  variants: VariantView[]
  /** Open straight on this style (e.g. one just created). */
  focusProductId?: string | null
  onAdd: (lines: ReceiveLine[], styleName: string) => void
}) {
  const index = useMemo(() => buildIndex(variants), [variants])
  const [productId, setProductId] = useState<string | null>(focusProductId ?? null)
  const [q, setQ] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [cost, setCost] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (focusProductId) setProductId(focusProductId) }, [focusProductId])
  const group = index.find((g) => g.id === productId) ?? null
  useEffect(() => {
    setQty({})
    setCost(group?.variants[0] ? String(group.variants[0].cost || '') : '')
  }, [group?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const t = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return t.length ? searchGroups(index, t, 6) : index.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6).map((g) => ({ group: g }))
  }, [q, index])

  if (!group) {
    return (
      <div>
        <input className="input input-lg" autoFocus placeholder="Which style arrived? Type its name or style code" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grid grid-2" style={{ marginTop: 10 }}>
          {results.length === 0 && <div className="small muted">No style matches. Use “New item” to create it.</div>}
          {results.map(({ group: g }) => (
            <button key={g.id} type="button" className="grid-pick" onClick={() => setProductId(g.id)}>
              <span className="bold">{g.name}</span>
              <span className="small muted">{g.styleCode}{g.brand ? ` · ${g.brand}` : ''} · {g.variants.length} variants</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const sizes = [...new Set(group.variants.map((v) => v.size))].sort((a, b) => sizeRank(a) - sizeRank(b))
  const colors = [...new Set(group.variants.map((v) => v.color))]
  const cell = new Map(group.variants.map((v) => [`${v.size}|${v.color}`, v]))
  const lines: ReceiveLine[] = group.variants
    .map((v) => ({ variant: v, qty: Number(qty[v.id]) || 0, cost: Number(cost) || v.cost }))
    .filter((l) => l.qty > 0)
  const pieces = lines.reduce((s, l) => s + l.qty, 0)
  const value = round2(lines.reduce((s, l) => s + l.qty * l.cost, 0))

  function nextCell(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const inputs = [...(gridRef.current?.querySelectorAll<HTMLInputElement>('.matrix input') ?? [])]
    inputs[inputs.indexOf(e.currentTarget) + 1]?.focus()
  }

  function submit() {
    if (!lines.length) return
    onAdd(lines, group!.name)
    setQty({})
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <div>
          <span className="bold" style={{ fontSize: 15 }}>{group.name}</span>
          <span className="small muted"> · {group.styleCode}</span>
          <button className="link-btn" style={{ marginLeft: 12 }} onClick={() => { setProductId(null); setQ('') }}>Change style</button>
        </div>
        <div className="row gap-6">
          <span className="small muted">Cost each (₹)</span>
          <input className="input num" style={{ width: 100 }} inputMode="decimal" value={cost} placeholder="0"
            onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
      </div>

      <div className="table-wrap" ref={gridRef}>
        <table className="matrix">
          <thead><tr><th className="corner">Pack</th>{sizes.map((s) => <th key={s}>{s}</th>)}</tr></thead>
          <tbody>
            {colors.map((c) => (
              <tr key={c}>
                <th className="corner">{c}</th>
                {sizes.map((s) => {
                  const v = cell.get(`${s}|${c}`)
                  if (!v) return <td key={s} className="cell-zero">—</td>
                  return (
                    <td key={s}>
                      <input className="num" inputMode="numeric" placeholder="0" value={qty[v.id] ?? ''} aria-label={`${c} ${s} quantity received`}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={nextCell}
                        onChange={(e) => setQty({ ...qty, [v.id]: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                      <div className="small muted" style={{ marginTop: 2 }}>have {v.stock}</div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row between" style={{ marginTop: 12 }}>
        <span className="small muted">Type the pieces received in each box. Press Enter to jump to the next one.</span>
        <button className="btn btn-primary btn-lg" disabled={!lines.length} onClick={submit}>
          Add {pieces} piece{pieces === 1 ? '' : 's'}{value > 0 ? ` · ${inr(value)}` : ''} to receipt
        </button>
      </div>
    </div>
  )
}

const PACK_PRESETS: Record<string, string> = {
  'Milk (500 ml, 1 L)': '500 ml, 1 L',
  'Curd (200 g – 1 kg)': '200 g, 400 g, 1 kg',
  'Paneer / sweets': '200 g, 500 g, 1 kg',
  'Ghee / oil': '200 ml, 500 ml, 1 L',
  'Single pack': '1 pc',
}

const GST_CHOICES: Array<[string, string]> = [['0', '0 %'], ['5', '5 %'], ['12', '12 %'], ['18', '18 %'], ['store', 'Store slabs']]

/** Create a brand-new product without leaving the receipt: each pack size gets its own barcode, at 0 stock. */
export function NewItemPanel({ categories, products, onCreated }: {
  categories: Category[]
  products: Product[]
  onCreated: (product: Product, variants: number) => void
}) {
  const { toast } = useApp()
  const cats = sortCategories(categories.filter((c) => c.id !== 'cat_rawmilk'))
  const [d, setD] = useState(() => ({
    name: '', styleCode: cats[0] ? nextStyleCode(cats[0], products) : '', categoryId: cats[0]?.id ?? '', brand: '',
    sizes: '500 ml, 1 L', cost: '', mrp: '', price: '', shelf: '', gst: '5',
  }))
  const [codeTouched, setCodeTouched] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const pickCategory = (categoryId: string) => {
    const cat = cats.find((c) => c.id === categoryId)
    setD((x) => ({ ...x, categoryId, styleCode: codeTouched || !cat ? x.styleCode : nextStyleCode(cat, products) }))
    setTimeout(() => nameRef.current?.focus(), 0)
  }
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  const sizes = parseTags(d.sizes)
  const price = Number(d.price) || Number(d.mrp) || 0
  const styleCode = d.styleCode.trim().toUpperCase()
  const taken = !!styleCode && products.some((p) => p.styleCode === styleCode)
  const bad = { name: tried && !d.name.trim(), style: (tried && !styleCode) || taken, price: tried && price <= 0, sizes: tried && !sizes.length }

  async function create() {
    setTried(true)
    if (!d.name.trim() || !styleCode || taken || !sizes.length || price <= 0) { toast('Fill the highlighted fields to continue', 'err'); return }
    setBusy(true)
    try {
      const { product, variants } = await createStyle({
        name: d.name, styleCode, categoryId: d.categoryId || categories[0]?.id || '', brand: d.brand, fabric: '', season: '', hsn: '0401',
        sizes, colors: [''], cost: Number(d.cost) || 0, mrp: Number(d.mrp) || price, price,
      })
      // Dairy attributes live beside the style the receipt just created.
      await db.products.update(product.id, {
        unit: 'pcs', shelfLifeDays: Number(d.shelf) > 0 ? Number(d.shelf) : 0, ...(d.gst === 'store' ? {} : { taxRate: Number(d.gst) }),
      })
      toast(`${product.name} created — ${variants} pack size${variants === 1 ? '' : 's'} with barcodes`, 'ok')
      onCreated(product, variants)
    } finally { setBusy(false) }
  }

  return (
    <div onKeyDown={(e) => moveOnEnter(e, () => void create())}>
      <CategoryPicker categories={cats} value={d.categoryId} onPick={pickCategory} />
      <div className="grid grid-3" style={{ marginTop: 12 }}>
        <Field label="Product name *"><input ref={nameRef} className={`input ${bad.name ? 'invalid' : ''}`} autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Toned Milk" /></Field>
        <Field label="Product code *" hint={taken ? undefined : codeTouched ? 'Becomes the SKU prefix' : 'Made automatically — change it if you like'}>
          <input className={`input ${bad.style ? 'invalid' : ''}`} value={d.styleCode} onChange={(e) => { setCodeTouched(true); setD({ ...d, styleCode: e.target.value.toUpperCase() }) }} placeholder="ML-101" />
          {taken && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>{styleCode} already exists</span>}
        </Field>
        <Field label="Brand"><input className="input" value={d.brand} onChange={(e) => setD({ ...d, brand: e.target.value })} /></Field>
      </div>
      <div className="grid grid-4" style={{ marginTop: 12 }}>
        <Field label="Cost (₹)"><input className="input num" inputMode="decimal" value={d.cost} onChange={(e) => setD({ ...d, cost: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="MRP (₹)"><input className="input num" inputMode="decimal" value={d.mrp} onChange={(e) => setD({ ...d, mrp: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Selling price (₹) *"><input className={`input num ${bad.price ? 'invalid' : ''}`} inputMode="decimal" value={d.price} onChange={(e) => setD({ ...d, price: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Shelf life (days)" hint="0 = no expiry"><input className="input num" inputMode="numeric" value={d.shelf} onChange={(e) => setD({ ...d, shelf: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <div className="row gap-6 wrap" style={{ margin: '14px 0 8px' }}>
        <span className="small muted">GST</span>
        {GST_CHOICES.map(([v, label]) => <button key={v} type="button" className={`chip ${d.gst === v ? 'on' : ''}`} onClick={() => setD({ ...d, gst: v })}>{label}</button>)}
      </div>
      <div className="row gap-6 wrap" style={{ margin: '0 0 8px' }}>
        <span className="small muted">Pack preset</span>
        {Object.entries(PACK_PRESETS).map(([label, val]) => (
          <button key={label} type="button" className={`chip ${d.sizes === val ? 'on' : ''}`} onClick={() => setD({ ...d, sizes: val })}>{label}</button>
        ))}
      </div>
      <Field label="Pack sizes *" hint="Each size becomes its own barcoded item at the same price — adjust prices later in Products.">
        <TagInput value={d.sizes} invalid={bad.sizes} onChange={(v) => setD({ ...d, sizes: v })} placeholder="500 ml, 1 L…" />
      </Field>
      <div className="row between" style={{ marginTop: 14 }}>
        <span className="small muted">
          {sizes.length ? <><b>{sizes.length === 1 ? '1 pack size' : `${sizes.length} pack sizes`}</b> will be created with their own barcodes, at 0 stock.</> : 'Add at least one pack size.'}
        </span>
        <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void create()}>Create product &amp; enter quantities</button>
      </div>
    </div>
  )
}
