import { Fragment, forwardRef } from 'react'
import { inr } from '../lib/money'
import type { VariantView } from '../db/ops'
import type { SearchResult } from '../lib/posSearch'

/** Wraps the parts of `text` that match a typed word, so the cashier sees *why* a row matched. */
function Marked({ text, tokens }: { text: string; tokens: string[] }) {
  const hit = tokens.filter((t) => t.length > 0)
  if (!hit.length) return <>{text}</>
  const re = new RegExp(`(${hit.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig')
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>)}
    </>
  )
}

const MAX_COLORS = 4

interface Props {
  results: SearchResult[]
  tokens: string[]
  qty: number
  highlight: number
  /** Index (into results[highlight].variants) of the size chip the keyboard is on. */
  activeVar: number
  cartQty: Map<string, number>
  onHover: (i: number) => void
  onPick: (v: VariantView) => void
}

/**
 * Type-ahead results grouped by product: one row per product, with size chips per colour
 * underneath. Sold-out sizes are visible but disabled. ↑↓ moves between products, ←→ between
 * sizes, Enter adds the chip the cursor is on (handled by the POS key handler).
 */
export const ItemSearchDrop = forwardRef<HTMLDivElement, Props>(function ItemSearchDrop(
  { results, tokens, qty, highlight, activeVar, cartQty, onHover, onPick }, ref,
) {
  return (
    <div className="card search-drop sd" ref={ref} role="listbox" aria-label="Matching items" style={{ top: 54, left: 0, right: 0 }}>
      <div className="sd-list">
        {results.map((r, i) => {
          const on = i === highlight
          const colors = [...new Set(r.variants.map((v) => v.color))]
          const shown = colors.slice(0, MAX_COLORS)
          const inCart = r.variants.reduce((s, v) => s + (cartQty.get(v.id) ?? 0), 0)
          const soldOut = r.totalStock <= 0
          return (
            <div key={r.group.id} role="option" aria-selected={on}
              className={`sd-group ${on ? 'highlighted' : ''} ${soldOut ? 'sold-out' : ''}`}
              onMouseEnter={() => onHover(i)}>
              <div className="sd-head">
                <div style={{ minWidth: 0 }}>
                  <div className="sd-name">
                    <Marked text={r.group.name} tokens={tokens} />
                    {inCart > 0 && <span className="badge badge-brand" style={{ marginLeft: 8 }}>In cart ×{inCart}</span>}
                  </div>
                  <div className="sd-meta">
                    <Marked text={r.group.brand} tokens={tokens} /> · <Marked text={r.group.styleCode} tokens={tokens} />
                    {qty > 1 && <span className="sd-qty"> · adds ×{qty}</span>}
                  </div>
                </div>
                <div className="sd-aside">
                  <div className="right">
                    <div className="num bold">{r.minPrice === r.maxPrice ? inr(r.minPrice) : `${inr(r.minPrice)} – ${inr(r.maxPrice)}`}</div>
                    {r.mrp > r.minPrice && <div className="num small muted"><s>{inr(r.mrp)}</s></div>}
                  </div>
                  <span className={`badge ${soldOut ? 'badge-danger' : r.totalStock <= 5 ? 'badge-warn' : 'badge-ok'}`}>
                    {soldOut ? 'Sold out' : `${r.totalStock} in stock`}
                  </span>
                </div>
              </div>

              <div className="sd-colors">
                {shown.map((color) => (
                  <div key={color} className="sd-color-row">
                    <span className="sd-color"><Marked text={color} tokens={tokens} /></span>
                    <div className="sd-chips">
                      {r.variants.filter((v) => v.color === color).map((v) => {
                        const idx = r.variants.indexOf(v)
                        const out = v.stock <= 0
                        const cur = on && idx === activeVar
                        return (
                          <button key={v.id} type="button" disabled={out} tabIndex={-1}
                            className={`sd-chip ${cur ? 'cur' : ''} ${!out && v.stock <= v.reorderLevel ? 'low' : ''}`}
                            title={out ? `${v.size} is sold out` : `${v.sku} · ${v.stock} left`}
                            onMouseDown={(e) => e.preventDefault()} /* keep focus in the scan box */
                            onClick={() => onPick(v)}>
                            <Marked text={v.size} tokens={tokens} /><b>{out ? '–' : v.stock}</b>
                            {(cartQty.get(v.id) ?? 0) > 0 && <i className="sd-dot" aria-label="in cart" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {colors.length > MAX_COLORS && (
                  <div className="sd-more">+{colors.length - MAX_COLORS} more colour{colors.length - MAX_COLORS > 1 ? 's' : ''} — type a colour to narrow</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="sd-foot">
        <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> product</span>
        <span><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd> size</span>
        <span><kbd className="kbd">Enter</kbd> add</span>
        <span><kbd className="kbd">Esc</kbd> close</span>
        <span className="grow" />
        <span className="muted">Tip: <b>2*oxford navy</b> adds two</span>
      </div>
    </div>
  )
})

export function NoMatch({ query, onAdd }: { query: string; onAdd: () => void }) {
  return (
    <div className="card search-drop sd sd-empty" style={{ top: 54, left: 0, right: 0 }}>
      <div className="bold">No item matches “{query}”</div>
      <div className="small muted">Check the spelling, try fewer words, or scan the barcode.</div>
      <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onMouseDown={(e) => e.preventDefault()} onClick={onAdd}>
        Add it as a new product
      </button>
    </div>
  )
}
