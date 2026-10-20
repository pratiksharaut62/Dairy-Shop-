import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common'
import { DbService, Row } from '../db/db.service'
import { body, num, partialUpdate, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm } from '../auth/permissions'

export const customerRow = (c: Row) => ({
  id: c.id, name: c.name, phone: c.phone, email: c.email, dob: c.dob, anniversary: c.anniversary, address: c.address,
  gstin: c.gstin, loyaltyPoints: c.loyalty_points, storeCredit: c.store_credit, createdAt: c.created_at, notes: c.notes ?? '',
})
export const supplierRow = (s: Row) => ({
  id: s.id, name: s.name, phone: s.phone, gstin: s.gstin, address: s.address, openingBalance: s.opening_balance,
})

@Controller('customers')
export class CustomersController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM customers WHERE store_id = :s ORDER BY name', { s: c.storeId })).map(customerRow)
  }

  @Perm('customers') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'phone'])
    try {
      await this.db.query(
        `INSERT INTO customers (id, store_id, name, phone, email, dob, anniversary, address, gstin, loyalty_points, store_credit, created_at, notes)
         VALUES (:id, :storeId, :name, :phone, :email, :dob, :anniversary, :address, :gstin, :points, :credit, :createdAt, :notes)`,
        { id: b.id, storeId: c.storeId, name: b.name ?? 'Customer', phone: b.phone, email: b.email ?? '', dob: b.dob ?? '',
          anniversary: b.anniversary ?? '', address: b.address ?? '', gstin: b.gstin ?? '', points: num(b.loyaltyPoints),
          credit: num(b.storeCredit), createdAt: b.createdAt ?? Date.now(), notes: b.notes ?? '' })
    } catch (e) { pgToHttp(e, 'Could not create customer', 'A customer with that mobile number already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('customers') @Put(':id')
  async update(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('customers', body(raw), {
      name: 'name', phone: 'phone', email: 'email', dob: 'dob', anniversary: 'anniversary', address: 'address',
      gstin: 'gstin', loyaltyPoints: 'loyalty_points', storeCredit: 'store_credit', notes: 'notes',
    }, 'id = :id AND store_id = :storeId', { id, storeId: c.storeId })
    try { if (u) await this.db.query(u.sql, u.params) } catch (e) { pgToHttp(e, 'Could not update customer', 'That mobile number is already used by another customer') }
    return { ok: true }
  }
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Auth() c: Claims) {
    return (await this.db.query('SELECT * FROM suppliers WHERE store_id = :s ORDER BY name', { s: c.storeId })).map(supplierRow)
  }

  @Perm('purchases') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'name'])
    try {
      await this.db.query(
        `INSERT INTO suppliers (id, store_id, name, phone, gstin, address, opening_balance)
         VALUES (:id, :storeId, :name, :phone, :gstin, :address, :ob)`,
        { id: b.id, storeId: c.storeId, name: b.name, phone: b.phone ?? '', gstin: b.gstin ?? '', address: b.address ?? '', ob: num(b.openingBalance) })
    } catch (e) { pgToHttp(e, 'Could not create supplier', 'Supplier already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('purchases') @Put(':id')
  async update(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const u = partialUpdate('suppliers', body(raw), {
      name: 'name', phone: 'phone', gstin: 'gstin', address: 'address', openingBalance: 'opening_balance',
    }, 'id = :id AND store_id = :storeId', { id, storeId: c.storeId })
    if (u) await this.db.query(u.sql, u.params)
    return { ok: true }
  }
}
