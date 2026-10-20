import JsBarcode from 'jsbarcode'

/** Internal-use EAN-13 prefix (200-299 is reserved for in-store numbering). */
const STORE_PREFIX = '210'

export function ean13CheckDigit(first12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12])
}

/**
 * Builds a scannable in-store EAN-13 from a running counter.
 * Pre-barcoded stock keeps its own code — this is only for goods we label ourselves.
 */
export function makeBarcode(counter: number): string {
  const body = String(counter).padStart(9, '0').slice(-9)
  const first12 = STORE_PREFIX + body
  return first12 + ean13CheckDigit(first12)
}

export function detectFormat(code: string): 'EAN13' | 'CODE128' {
  return isValidEan13(code) ? 'EAN13' : 'CODE128'
}

export function renderBarcode(el: SVGSVGElement | HTMLCanvasElement, value: string, opts: {
  height?: number; width?: number; fontSize?: number; displayValue?: boolean; margin?: number; bold?: boolean
} = {}) {
  try {
    JsBarcode(el, value, {
      format: detectFormat(value),
      height: opts.height ?? 40,
      width: opts.width ?? 1.6,
      fontSize: opts.fontSize ?? 12,
      displayValue: opts.displayValue ?? true,
      margin: opts.margin ?? 2,
      textMargin: 1,
      fontOptions: opts.bold ? 'bold' : '',
      background: '#ffffff',
      lineColor: '#000000',
    })
  } catch {
    // An unscannable value should never crash the label sheet — fall back to Code128.
    JsBarcode(el, value.replace(/[^\x20-\x7E]/g, ''), { format: 'CODE128', height: opts.height ?? 40 })
  }
}

type BarcodeOpts = { height?: number; width?: number; fontSize?: number; displayValue?: boolean; margin?: number; bold?: boolean }

const markupCache = new Map<string, string>()

/**
 * A label sheet can carry hundreds of *copies* of the same handful of SKUs
 * (e.g. "one label per piece in stock" on a full inventory) — rendering
 * each copy as its own live JsBarcode call is what actually froze the
 * page, since it reruns the same SVG generation for identical output
 * dozens of times over. This renders each distinct (value + options) pair
 * exactly once, into a real but off-screen SVG element (JsBarcode measures
 * text via getBBox, which needs actual layout to behave the same across
 * every platform webview), caches the resulting markup, and hands back a
 * ready-to-embed string every other copy can just reuse.
 */
export function getBarcodeMarkup(value: string, opts: BarcodeOpts = {}): string {
  const key = value + '|' + JSON.stringify(opts)
  const cached = markupCache.get(key)
  if (cached) return cached

  // The off-screen position belongs on a throwaway host, not the SVG being
  // measured — capturing svg.outerHTML picks up every attribute the
  // element carries, inline style included, so putting position:absolute;
  // left:-9999px directly on the SVG itself would bake "invisible,
  // off-screen" into every cached copy this markup gets reused into.
  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.left = '-9999px'
  host.style.top = '-9999px'
  document.body.appendChild(host)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  host.appendChild(svg)
  renderBarcode(svg, value, opts)
  const markup = svg.outerHTML
  document.body.removeChild(host)
  markupCache.set(key, markup)
  return markup
}

/**
 * Barcode scanners type fast and end with Enter. This distinguishes a scan from
 * a human typing into the same field, so POS can auto-add on scan.
 */
export function createScanDetector(onScan: (code: string) => void, minLength = 4, maxGapMs = 60) {
  let buffer = ''
  let last = 0
  return (e: KeyboardEvent) => {
    const now = Date.now()
    if (now - last > maxGapMs) buffer = ''
    last = now
    if (e.key === 'Enter') {
      if (buffer.length >= minLength) { onScan(buffer); e.preventDefault() }
      buffer = ''
      return
    }
    if (e.key.length === 1) buffer += e.key
  }
}
