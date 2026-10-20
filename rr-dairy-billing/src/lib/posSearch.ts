import type { VariantView } from '../db/ops'

/** One catalogue product with all its size/colour variants — what the cashier thinks in. */
export interface ProductGroup {
  id: string
  name: string
  brand: string
  styleCode: string
  variants: VariantView[]
  /** Lower-cased searchable text, built once per catalogue change (not per keystroke). */
  hay: string
}

export interface SearchResult {
  group: ProductGroup
  /** Variants worth showing — narrowed by any colour/size words in the query. */
  variants: VariantView[]
  totalStock: number
  minPrice: number
  maxPrice: number
  mrp: number
  score: number
}

export interface ParsedQuery {
  /** Quantity from the "2*shirt" / "3x kurta" shortcut (1 when absent). */
  qty: number
  term: string
  tokens: string[]
}

const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', 'FREE', 'FREE SIZE']

/** Natural size order: S M L XL XXL, then waist/number sizes ascending, kids' ages by their first number. */
export function sizeRank(size: string): number {
  const up = size.trim().toUpperCase()
  const i = LETTER_SIZES.indexOf(up)
  if (i >= 0) return i
  const n = parseFloat(up)
  return Number.isNaN(n) ? 1000 : 100 + n
}

/** Groups variants by product and precomputes the search text. Call once per catalogue change. */
export function buildIndex(variants: VariantView[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>()
  for (const v of variants) {
    let g = map.get(v.productId)
    if (!g) {
      g = { id: v.productId, name: v.productName, brand: v.brand, styleCode: v.styleCode, variants: [], hay: '' }
      map.set(v.productId, g)
    }
    g.variants.push(v)
  }
  for (const g of map.values()) {
    // Keep each colour together, sizes in natural order — the chips read left to right.
    const colorOrder = [...new Set(g.variants.map((v) => v.color))]
    g.variants.sort((a, b) => (colorOrder.indexOf(a.color) - colorOrder.indexOf(b.color)) || (sizeRank(a.size) - sizeRank(b.size)))
    g.hay = [g.name, g.brand, g.styleCode, ...g.variants.flatMap((v) => [v.sku, v.barcode, v.color, v.size])]
      .join(' ').toLowerCase()
  }
  return [...map.values()]
}

/** "2*oxford navy" → 2 × "oxford navy". A bare number is left alone — it could be a barcode. */
export function parseQuery(raw: string): ParsedQuery {
  const m = raw.trim().match(/^(\d{1,3})\s*[*xX×]\s*(.+)$/)
  const qty = m ? Math.max(1, Math.min(999, Number(m[1]))) : 1
  const term = (m ? m[2] : raw).trim()
  return { qty, term, tokens: term.toLowerCase().split(/\s+/).filter(Boolean) }
}

const wordStart = (text: string, token: string) => text.startsWith(token) || text.includes(' ' + token)

/**
 * Multi-word search: every word must match somewhere ("navy shirt xl"). Results are ranked —
 * exact SKU/barcode, then name-prefix, then word-start, then anywhere — with groups that have
 * stock ahead of sold-out ones. Colour/size words in the query narrow the variants shown.
 */
export function searchGroups(index: ProductGroup[], tokens: string[], limit = 8): SearchResult[] {
  if (!tokens.length || tokens.join('').length < 2) return []
  const out: SearchResult[] = []

  for (const g of index) {
    if (!tokens.every((t) => g.hay.includes(t))) continue
    const name = g.name.toLowerCase()
    let score = 0
    for (const t of tokens) {
      if (g.variants.some((v) => v.barcode === t || v.sku.toLowerCase() === t)) score += 1000
      else if (name.startsWith(t)) score += 60
      else if (wordStart(name, t)) score += 45
      else if (name.includes(t)) score += 30
      else if (g.brand.toLowerCase().startsWith(t) || g.styleCode.toLowerCase().startsWith(t)) score += 25
      else score += 10
    }

    // Narrow to the colour/size the cashier already typed, if the product has it.
    let visible = g.variants
    const byColor = visible.filter((v) => tokens.some((t) => v.color.toLowerCase().startsWith(t)))
    if (byColor.length) visible = byColor
    const bySize = visible.filter((v) => tokens.some((t) => t === v.size.toLowerCase()))
    if (bySize.length) visible = bySize

    const prices = visible.map((v) => v.price)
    out.push({
      group: g, variants: visible, score,
      totalStock: visible.reduce((s, v) => s + Math.max(0, v.stock), 0),
      minPrice: Math.min(...prices), maxPrice: Math.max(...prices),
      mrp: Math.max(...visible.map((v) => v.mrp)),
    })
  }

  out.sort((a, b) =>
    (Number(b.totalStock > 0) - Number(a.totalStock > 0)) || (b.score - a.score) || a.group.name.localeCompare(b.group.name))
  return out.slice(0, limit)
}

/** First variant of a result that can actually be sold. */
export const firstSellable = (r: SearchResult) => r.variants.findIndex((v) => v.stock > 0)
