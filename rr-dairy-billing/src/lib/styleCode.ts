import type { Category, Product } from '../db/types'

/** Two-letter prefixes for product codes (PN-101 = first paneer product). */
const PREFIX: Record<string, string> = {
  cat_milk: 'ML', cat_flavmilk: 'FM', cat_curd: 'CD', cat_buttermilk: 'BM', cat_paneer: 'PN', cat_cheese: 'CH',
  cat_butter: 'BT', cat_ghee: 'GH', cat_cream: 'CR', cat_sweets: 'SW', cat_icecream: 'IC', cat_other: 'OT', cat_rawmilk: 'RW',
}

export function stylePrefix(c: Category | undefined): string {
  if (!c) return 'ST'
  return PREFIX[c.id] ?? `${(c.group[0] ?? 'X')}${(c.name[0] ?? 'X')}`.toUpperCase()
}

/** The next free style code for a category: WS-101, WS-102 … (never reuses a number already taken). */
export function nextStyleCode(c: Category | undefined, products: Array<Pick<Product, 'styleCode'>>): string {
  const prefix = stylePrefix(c)
  const used = new Set(products.map((p) => p.styleCode.toUpperCase()))
  let max = 100
  for (const code of used) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(code)
    if (m) max = Math.max(max, Number(m[1]))
  }
  let n = max + 1
  while (used.has(`${prefix}-${n}`)) n++
  return `${prefix}-${n}`
}

const GROUP_ORDER = ['Milk', 'Cultured', 'Fats', 'Sweets & frozen', 'Other', 'Raw material']

/** Grouped Milk → Cultured → Fats → Sweets → Other, alphabetical inside each group. */
export function sortCategories<T extends Pick<Category, 'id' | 'name' | 'group'>>(cats: T[]): T[] {
  const rank = (c: T) => {
    const g = GROUP_ORDER.indexOf(c.group)
    return g === -1 ? GROUP_ORDER.length : g
  }
  return [...cats].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
