import type { CSSProperties } from 'react'
import { getBarcodeMarkup } from '../lib/barcode'
import { inr } from '../lib/money'

/** The physical page width a printer needs for one row of labels — shared
 *  by every call site so the @page size passed to PrintProvider always
 *  matches what LabelSheet itself lays out. */
export function labelRowWidthMm(widthMm: number, across: number, gapMm: number): number {
  return across * widthMm + (across - 1) * gapMm
}

export interface LabelSpec {
  barcode: string
  name: string
  size: string
  color: string
  sku: string
  /** Maximum retail price printed on the garment. */
  mrp: number
  /** What the customer pays. Shown next to the MRP when it is lower; falls back to the MRP when missing. */
  price?: number
  copies: number
}

/**
 * Every font size, the barcode's height and the cell padding were tuned by
 * eye against a 38mm-tall label — this baseline lets them scale down (or up)
 * proportionally for whatever height Settings actually has, instead of
 * overflowing a shorter label or wasting space on a taller one. Clamped so a
 * pathologically short or tall setting can't shrink text to unreadable.
 */
const BASELINE_HEIGHT_MM = 38
export function fitScale(heightMm: number): number {
  return Math.min(1.25, Math.max(0.45, heightMm / BASELINE_HEIGHT_MM))
}

const PX_PER_MM = 96 / 25.4

/**
 * Padding and the space between lines, in mm. Kept small on purpose: every millimetre saved here goes to the text,
 * because the barcode itself is not allowed to shrink.
 */
export function spacingMm(heightMm: number) {
  const s = fitScale(heightMm)
  return { pad: Math.max(0.7, Math.min(1.6, 1.2 * s)), gap: Math.max(0.4, Math.min(1.2, 0.8 * s)) }
}

/** Size/gap/padding as CSS custom properties — shared by the printed sheet and the on-screen preview. */
export function labelVars(widthMm: number, heightMm: number, gapMm = 0): CSSProperties {
  const sp = spacingMm(heightMm)
  return {
    '--label-w': `${widthMm}mm`, '--label-h': `${heightMm}mm`, '--label-gap': `${gapMm}mm`, '--label-pad': `${sp.pad.toFixed(2)}mm`,
    '--label-gy': `${sp.gap.toFixed(2)}mm`,
  } as CSSProperties
}

/**
 * Font sizes (px) that fill the room the barcode leaves. A short sticker (say 50×25 mm) has little spare height, so
 * the old fixed sizes — scaled down with the barcode — came out around 7px. Here the barcode keeps its size and the
 * four text rows share what remains, then each row is limited by its own width so nothing runs off the sticker.
 */
export function textSizes(widthMm: number, heightMm: number, texts: { store: string; market: string; rate: string }) {
  const s = fitScale(heightMm)
  const sp = spacingMm(heightMm)
  const pad = sp.pad * PX_PER_MM
  const gap = sp.gap * PX_PER_MM
  const digits = 11 * s
  const barBlock = 36 * s + digits * 1.35 + 3 // bars + the number under them (+ its margin)
  const room = heightMm * PX_PER_MM - 2 * pad - barBlock - 4 * gap
  // Rows are store 1.1x, name 1x and the two price rows 1.5x of `base`, each 1.14 line-height: 5.1 units of base.
  const base = Math.max(8, Math.min(18, room / (1.14 * 5.1)))
  // Leave a little room on the right too: bold figures run wider than the estimate and printers clip the last pixels.
  const innerW = widthMm * PX_PER_MM - 2 * pad - 2 - 6
  const byWidth = (chars: number, cap: number) => Math.max(8, Math.min(cap, innerW / (0.72 * Math.max(1, chars))))
  return {
    digits,
    store: byWidth(texts.store.length, base * 1.1),
    name: base,
    market: byWidth(texts.market.length, base * 1.5),
    rate: byWidth(texts.rate.length, base * 1.5),
  }
}

/** "₹1,699" for whole rupees (cleaner on a tag), "₹1,699.50" otherwise. */
const price = (n: number) => (Number.isInteger(n) ? '₹' + n.toLocaleString('en-IN') : inr(n))

/**
 * The inside of one garment label. The barcode is the only thing meant to stand out: everything else is
 * plain, normal-weight black text so it is easy to read without competing with the bars. Pure black on white
 * because thermal printers have no grey. Used by the printed sheet and the preview, so what you see is what prints.
 */
export function LabelFace({ l, storeName, showMrp = true, widthMm, heightMm }: {
  l: Omit<LabelSpec, 'copies'> & { copies?: number }
  storeName: string
  showMrp?: boolean
  /** Used to keep each line inside the sticker width. */
  widthMm?: number
  heightMm: number
}) {
  const scale = fitScale(heightMm)
  const variant = [l.size, l.color].filter(Boolean).join(' / ')
  const sell = l.price && l.price > 0 ? l.price : l.mrp
  const marketText = `Market price ${price(l.mrp)}`
  const rateText = `MRP Rate ${price(sell)}`
  const fs = textSizes(widthMm ?? 50, heightMm, { store: storeName, market: marketText, rate: rateText })
  // The barcode keeps its size exactly (36px tall bars, 1.25px modules, scaled only with the label height); only the
  // number under it is made bolder and a little larger so it can be read.
  const bars = getBarcodeMarkup(l.barcode, { height: 36 * scale, width: 1.25, fontSize: fs.digits, bold: true })
  return (
    <>
      <div className="lbl-store" style={{ fontSize: fs.store }}>{storeName}</div>
      <div className="lbl-line" style={{ fontSize: fs.name }}>
        <span className="lbl-name">{l.name}</span>
        {variant && <span className="lbl-variant"> · {variant}</span>}
      </div>
      <span className="lbl-bar" dangerouslySetInnerHTML={{ __html: bars }} />
      {showMrp && (
        <div className="lbl-pricerow" style={{ fontSize: fs.market }}>
          <span>Market price</span><span>{price(l.mrp)}</span>
        </div>
      )}
      <div className="lbl-pricerow" style={{ fontSize: fs.rate }}>
        <span>MRP Rate</span><span>{price(sell)}</span>
      </div>
    </>
  )
}

/**
 * Barcode label sheet — one physical *row* per printed page, sized in mm to
 * exactly match the sticker stock loaded in the printer (a label-roll or
 * die-cut printer feeds by page size, so a mismatch prints across labels or
 * leaves a gap). Most rolls are a single lane (across=1, one label = one
 * row = one page); some carry two or more labels side by side, in which
 * case a page is `across` labels wide plus `across - 1` gaps of `gapMm`,
 * and the trailing row is padded with empty slots so it still lays out
 * `across`-wide. widthMm/heightMm/across/gapMm come from Settings → Label
 * printing and drive both the page size itself (PrintProvider's dynamic
 * @page rule) and each cell's on-paper dimensions via CSS custom
 * properties. A run can carry hundreds of *copies* of the same handful of
 * SKUs, so each cell embeds pre-rendered barcode markup (getBarcodeMarkup
 * caches by value) instead of mounting a live JsBarcode-backed component
 * per copy — regenerating identical barcodes is what froze the page on a
 * large print run.
 */
export function LabelSheet({ labels, storeName, showMrp = true, widthMm, heightMm, across = 1, gapMm = 0 }: {
  labels: LabelSpec[]; storeName: string; showMrp?: boolean
  widthMm: number; heightMm: number; across?: number; gapMm?: number
}) {
  const flat = labels.flatMap((l) => Array.from({ length: Math.max(1, l.copies) }, () => l))
  const rows: (LabelSpec | null)[][] = []
  for (let i = 0; i < flat.length; i += across) {
    const row: (LabelSpec | null)[] = flat.slice(i, i + across)
    while (row.length < across) row.push(null)
    rows.push(row)
  }
  return (
    <div className="label-sheet" style={labelVars(widthMm, heightMm, gapMm)}>
      {rows.map((row, r) => (
        <div className="label-row" key={r}>
          {row.map((l, i) => l ? (
            <div className="label-cell" key={i}>
              <LabelFace l={l} storeName={storeName} showMrp={showMrp} widthMm={widthMm} heightMm={heightMm} />
            </div>
          ) : <div className="label-cell label-cell-empty" key={i} />)}
        </div>
      ))}
    </div>
  )
}
