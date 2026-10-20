import { useEffect, useRef, type ReactNode } from 'react'
import { renderBarcode } from '../lib/barcode'
import { Close, InboxIcon, TrendDown, TrendUp } from './icons'
import { Sparkline } from './charts'

/** Initials for an avatar chip — letters only, so "Rohan (Owner)" never shows as "R(". */
export const initialsOf = (name: string) =>
  (name.match(/[A-Za-z\u0900-\u097F]+/g) ?? ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export function Card({ title, action, children, tight, className = '' }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; tight?: boolean; className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {action}
        </header>
      )}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </section>
  )
}

export interface StatDelta {
  /** Percentage change against the comparison period. */
  pct: number
  label: string
  /** Set when a fall is the good outcome, e.g. expenses. */
  invert?: boolean
}

export function Stat({ label, value, foot, icon, delta, spark, tone = 'neutral' }: {
  label: string
  value: ReactNode
  foot?: ReactNode
  icon?: ReactNode
  delta?: StatDelta | null
  /** Optional trend line drawn under the value. */
  spark?: number[]
  tone?:'neutral' | 'brand' | 'ok' | 'warn' | 'danger'
}) {
  const good = delta ? (delta.invert ? delta.pct < 0 : delta.pct > 0) : false
  const flat = !delta || Math.abs(delta.pct) < 0.05
  return (
    <div className="card stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className={`stat-icon tone-${tone}`}>{icon}</span>}
      </div>
      <div className="stat-value">{value}</div>
      {spark && <Sparkline values={spark} tone={tone === 'danger' ? 'danger' : tone === 'ok' ? 'ok' : 'brand'} />}
      {delta && (
        <div className="stat-foot row gap-6">
          <span className={`stat-delta ${flat ? 'flat' : good ? 'up' : 'down'}`}>
            {flat ? '—' : delta.pct > 0 ? <TrendUp size={13} /> : <TrendDown size={13} />}
            {flat ? '0.0%' : `${Math.abs(delta.pct).toFixed(1)}%`}
          </span>
          <span className="muted">{delta.label}</span>
        </div>
      )}
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  )
}

export function Modal({ open, title, onClose, children, footer, width = '' }: {
  open: boolean; title: ReactNode; onClose: () => void; children: ReactNode
  footer?: ReactNode; width?: '' | 'wide' | 'xwide'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="overlay no-print" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${width}`}>
        <div className="sheet-handle" onClick={onClose} />
        <header className="modal-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Close size={15} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="tiny muted">{hint}</span>}
    </label>
  )
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big">{icon ?? <InboxIcon size={26} />}</div>
      <div className="bold">{title}</div>
      {hint && <div className="small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export function Barcode({ value, height = 38, width = 1.5, fontSize = 11, displayValue = true }: {
  value: string; height?: number; width?: number; fontSize?: number; displayValue?: boolean
}) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current && value) renderBarcode(ref.current, value, { height, width, fontSize, displayValue })
  }, [value, height, width, fontSize, displayValue])
  return <svg ref={ref} />
}

export function StockBadge({ stock, reorder }: { stock: number; reorder: number }) {
  if (stock <= 0) return <span className="badge badge-danger"><i className="dot" />Out of stock</span>
  if (stock <= reorder) return <span className="badge badge-warn"><i className="dot" />Low · {stock}</span>
  return <span className="badge badge-ok"><i className="dot" />{stock} in stock</span>
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Confirm({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string
  danger?: boolean; onConfirm: () => void; onClose: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => { onConfirm(); onClose() }}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="dim">{message}</div>
    </Modal>
  )
}
