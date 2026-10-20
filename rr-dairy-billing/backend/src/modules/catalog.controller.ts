import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from '@nestjs/common'
import { DbService, Row } from '../db/db.service'
import { body, num, partialUpdate, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'

export const variantRow = (v: Row) => ({
  id: v.id, productId: v.product_id, sku: v.sku, barcode: v.barcode, size: v.size, color: v.color,
  cost: v.cost, mrp: v.mrp, price: v.price, stock: v.stock, reorderLevel: v.reorder_level,
})
export const productRow = (p: Row) => ({
  id: p.id, styleCode: p.style_code, name: p.name, categoryId: p.category_id, brand: p.brand, fabric: p.fabric,
  season: p.season, hsn: p.hsn, unit: p.unit ?? '', shelfLifeDays: p.shelf_life_days ?? 0,
  ...(p.tax_rate === null || p.tax_rate === undefined ? {} : { taxRate: p.tax_rate }), active: p.active, createdAt: p.created_at,
})

const VARIANT_INSERT = `INSERT INTO variants (id, store_id, product_id, sku, barcode, size, color, cost, mrp, price, stock, reorder_level)
  VALUES (:id, :storeId, :productId, :sku, :barcode, :size, :color, :cost, :mrp, :price, :stock, :reorder)`

@Controller()
export class CatalogController {
  constructor(private readonly db: DbService) {}

  /** The whole catalogue with variants nested — same shape the client keeps in IndexedDB. */
  @Get('products')
  async list(@Auth() c: Claims) {
    const products = await this.db.query('SELECT * FROM products WHERE store_id = :s ORDER BY name', { s: c.storeId })
    const variants = await this.db.query('SELECT * FROM variants WHERE store_id = :s ORDER BY sku', { s: c.storeId })
    const byProduct = new Map<string, ReturnType<typeof variantRow>[]>()
    for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), variantRow(v)])
    return products.map((p) => ({ ...productRow(p), variants: byProduct.get(p.id) ?? [] }))
  }

  @Perm('inventory') @Post('products')
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'styleCode', 'name'])
    const variants = (Array.isArray(b.variants) ? b.variants : []) as Row[]
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO products (id, store_id, style_code, name, category_id, brand, fabric, season, hsn, unit, shelf_life_days, tax_rate, active, created_at)
           VALUES (:id, :storeId, :styleCode, :name, :categoryId, :brand, :fabric, :season, :hsn, :unit, :shelf, :taxRate, TRUE, :createdAt)`,
          { id: b.id, storeId: c.storeId, styleCode: b.styleCode, name: b.name, categoryId: b.categoryId || null,
            brand: b.brand ?? '', fabric: b.fabric ?? '', season: b.season ?? '', hsn: b.hsn ?? '', unit: b.unit ?? '',
            shelf: num(b.shelfLifeDays), taxRate: b.taxRate === undefined || b.taxRate === null ? null : num(b.taxRate), createdAt: b.createdAt ?? Date.now() })
        for (const v of variants) await q.query(VARIANT_INSERT, variantParams(c.storeId, b.id as string, v))
      })
    } catch (e) { pgToHttp(e, 'Could not create product', 'A product with that style code or barcode already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('inventory') @Put('products/:id')
  async update(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('products', body(raw), {
      name: 'name', styleCode: 'style_code', categoryId: 'category_id', brand: 'brand', fabric: 'fabric',
      season: 'season', hsn: 'hsn', active: 'active', unit: 'unit', shelfLifeDays: 'shelf_life_days', taxRate: 'tax_rate',
    }, 'id = :id AND store_id = :storeId', { id, storeId: c.storeId })
    try { if (u) await this.db.query(u.sql, u.params) } catch (e) { pgToHttp(e, 'Could not update product', 'That style code is already in use') }
    return { ok: true }
  }

  @Perm('inventory') @Delete('products/:id')
  async remove(@Auth() c: Claims, @Param('id') id: string) {
    try { await this.db.query('DELETE FROM products WHERE id = :id AND store_id = :s', { id, s: c.storeId }) }
    catch (e) { pgToHttp(e, 'Cannot delete a product that has sales or stock history — mark it inactive instead') }
    return { ok: true }
  }

  /** The most latency-sensitive endpoint: a cashier is standing at the counter waiting on this. */
  @Get('variants/barcode/:code')
  async byBarcode(@Auth() c: Claims, @Param('code') code: string) {
    const v = await this.db.one(
      `SELECT v.*, p.name AS product_name, p.style_code, p.brand, p.hsn, p.category_id
       FROM variants v JOIN products p ON p.id = v.product_id
       WHERE v.store_id = :s AND (v.barcode = :code OR v.sku = :code) LIMIT 1`, { s: c.storeId, code })
    if (!v) throw new NotFoundException('No item found for that code')
    return { ...variantRow(v), productName: v.product_name, styleCode: v.style_code, brand: v.brand, hsn: v.hsn, categoryId: v.category_id }
  }

  /** One variant of an already-synced product — the client writes each size×colour cell separately, so the outbox does too. */
  @Perm('inventory') @Post('variants')
  async createVariant(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'productId', 'sku', 'barcode', 'size', 'color'])
    try { await this.db.query(VARIANT_INSERT, variantParams(c.storeId, b.productId as string, b)) }
    catch (e) { pgToHttp(e, 'Could not create variant', 'A variant with that SKU or barcode already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('inventory') @Put('variants/:id')
  async updateVariant(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('variants', body(raw), {
      sku: 'sku', barcode: 'barcode', size: 'size', color: 'color', cost: 'cost', mrp: 'mrp', price: 'price',
      stock: 'stock', reorderLevel: 'reorder_level',
    }, 'id = :id AND store_id = :storeId', { id, storeId: c.storeId })
    try { if (u) await this.db.query(u.sql, u.params) } catch (e) { pgToHttp(e, 'Could not update variant', 'That SKU or barcode is already in use') }
    return { ok: true }
  }
}

function variantParams(storeId: string, productId: string, v: Row) {
  return { id: v.id, storeId, productId, sku: v.sku, barcode: v.barcode, size: v.size, color: v.color,
    cost: num(v.cost), mrp: num(v.mrp), price: num(v.price), stock: num(v.stock), reorder: num(v.reorderLevel, 3) }
}
