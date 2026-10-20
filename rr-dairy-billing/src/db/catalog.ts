import { db } from './index'
import { nextBarcode } from './ops'
import { id } from '../lib/id'
import { skuFor } from '../lib/variantLabel'
import type { Product } from './types'

export interface StyleDraft {
  name: string
  styleCode: string
  categoryId: string
  brand: string
  fabric: string
  season: string
  hsn: string
  sizes: string[]
  colors: string[]
  cost: number
  mrp: number
  price: number
}

/**
 * Creates a style and one barcoded variant (0 stock) for every size × colour — the same thing
 * Inventory → New item does, available to other screens such as Receive stock. An item with no sizes or colours
 * (a saree) passes `colors: ['']` and its types (or `['']` for a single item) as `sizes`.
 */
export async function createStyle(d: StyleDraft): Promise<{ product: Product; variants: number }> {
  const product: Product = {
    id: id('prd'),
    styleCode: d.styleCode.trim().toUpperCase(),
    name: d.name.trim(),
    categoryId: d.categoryId,
    brand: d.brand.trim(),
    fabric: d.fabric.trim(),
    season: d.season,
    hsn: d.hsn.trim(),
    active: true,
    createdAt: Date.now(),
  }
  await db.products.add(product)
  let made = 0
  for (const color of d.colors) {
    for (const size of d.sizes) {
      await db.variants.add({
        id: id('var'), productId: product.id,
        sku: skuFor(product.styleCode, color, size),
        barcode: await nextBarcode(), size, color,
        cost: d.cost, mrp: d.mrp || d.price, price: d.price,
        stock: 0, reorderLevel: 3,
      })
      made++
    }
  }
  return { product, variants: made }
}
