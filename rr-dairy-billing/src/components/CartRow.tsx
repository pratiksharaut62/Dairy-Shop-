import { inr, round2 } from '../lib/money'
import { lineDiscount, type CartLine } from '../lib/cart'
import type { VariantView } from '../db/ops'
import type { DiscountType } from '../db/types'
import { ChevronDown, PencilIcon, TrashIcon } from './icons'

export interface CartRowProps {
  line: CartLine
  flash: boolean
  selected: boolean
  editing: boolean
  swapping: boolean
  /** Other sizes/colours of the same product, for the in-place size swap. */
  siblings: VariantView[]
  canOverridePrice: boolean
  onSelect: () => void
  onQty: (qty: number) => void
  onRemove: () => void
  onToggleEdit: () => void
  onToggleSwap: () => void
  onSwap: (v: VariantView) => void
  onPatch: (patch: Partial<CartLine>) => void
  /** Applies the cashier's discount cap; returns the (possibly lowered) value. */
  capDiscount: (type: DiscountType, value: number) => number
}

/**
 * One size of one product in the cart. A row only carries what's needed 95% of the time —
 * size chip, quantity, line total, remove. Price and discount sit behind the pencil so they
 * can't be changed by an accidental click; the size chip swaps size in place.
 */
export function CartRow(p: CartRowProps) {
  const l = p.line
  const gross = l.price * l.qty
  const disc = lineDiscount(l)
  const net = round2(gross - disc)
  const saves = round2(l.mrp * l.qty - net)
  const left = l.stock - l.qty
  const discLabel = disc > 0 ? (l.discountType === 'pct' ? `${l.discountValue}% off` : `${inr(l.discountValue)} off`) : ''

  return (
    <div className={`cl ${p.flash ? 'flash' : ''} ${p.selected ? 'selected' : ''}`} onClick={p.onSelect}>
      <div className="cl-main">
        <button type="button" className={`cl-size ${p.swapping ? 'open' : ''}`} aria-expanded={p.swapping}
          title={`${l.sku} — click to change size`}
          onClick={(e) => { e.stopPropagation(); p.onToggleSwap() }}>
          <b>{l.size}</b><span>{l.color}</span><ChevronDown size={12} />
        </button>
        {left <= 0
          ? <span className="cl-note warn">All {l.stock} in cart</span>
          : l.stock <= 3 && <span className="cl-note warn">Only {l.stock} left</span>}
        <div className="grow" />

        <div className="qty-stepper" onClick={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Decrease quantity" onClick={() => p.onQty(l.qty - 1)}>−</button>
          <input className="num" aria-label="Quantity" value={l.qty} onChange={(e) => p.onQty(Math.max(0, Number(e.target.value) || 0))} />
          <button type="button" aria-label="Increase quantity" onClick={() => p.onQty(l.qty + 1)}>+</button>
        </div>

        <div className="cl-amt">
          <div className="num bold">{inr(net)}</div>
          {saves > 0 && <div className="num small cl-save">saves {inr(saves)}</div>}
        </div>

        <button type="button" className={`cl-icon ${p.editing ? 'on' : ''}`} title="Edit price / discount" aria-label="Edit price or discount"
          onClick={(e) => { e.stopPropagation(); p.onToggleEdit() }}><PencilIcon size={15} /></button>
        <button type="button" className="cl-icon danger" title="Remove (Delete)" aria-label="Remove item"
          onClick={(e) => { e.stopPropagation(); p.onRemove() }}><TrashIcon size={15} /></button>
      </div>

      <div className="cl-sub">
        {inr(l.price)} each{l.priceOverridden && <span className="badge badge-warn" style={{ marginLeft: 6 }}>price changed</span>}
        {l.mrp > l.price && <> · <s>{inr(l.mrp)}</s></>}
        {discLabel && <span className="cl-save"> · {discLabel}</span>}
      </div>

      {p.editing && (
        <div className="cl-edit" onClick={(e) => e.stopPropagation()}>
          <label className="cl-field">Price
            <input className="input num" inputMode="decimal" value={l.price} disabled={!p.canOverridePrice}
              title={p.canOverridePrice ? 'Price override' : 'Only a manager can change the price'}
              onChange={(e) => p.onPatch({ price: Number(e.target.value) || 0, priceOverridden: true })} />
          </label>
          <label className="cl-field">Discount
            <span className="row gap-6">
              <select className="select" style={{ width: 66 }} value={l.discountType}
                onChange={(e) => p.onPatch({ discountType: e.target.value as DiscountType })}>
                <option value="pct">%</option>
                <option value="amt">₹</option>
              </select>
              <input className="input num" inputMode="decimal" placeholder="0" value={l.discountValue || ''}
                onChange={(e) => p.onPatch({ discountValue: p.capDiscount(l.discountType, Number(e.target.value) || 0) })} />
            </span>
          </label>
          <button type="button" className="btn btn-primary" onClick={p.onToggleEdit}>Done</button>
        </div>
      )}

      {p.swapping && (
        <div className="cl-swap" onClick={(e) => e.stopPropagation()}>
          <span className="small muted">Change to:</span>
          <div className="sd-chips">
            {p.siblings.map((v) => (
              <button key={v.id} type="button" disabled={v.stock <= 0 && v.id !== l.variantId}
                className={`sd-chip ${v.id === l.variantId ? 'cur' : ''}`}
                title={v.stock <= 0 ? 'Sold out' : `${v.stock} in stock`}
                onClick={() => p.onSwap(v)}>
                {v.size} <span className="small" style={{ opacity: .8 }}>{v.color}</span><b>{v.stock <= 0 ? '–' : v.stock}</b>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
