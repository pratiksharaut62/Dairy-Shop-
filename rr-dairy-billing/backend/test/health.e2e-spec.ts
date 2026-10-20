/**
 * Super admin + device health. Unlike api.e2e-spec.ts (which wipes the `public` schema and so may only ever point at a
 * throwaway database), this suite builds its own temporary schema and drops only that, so it is safe on any database.
 */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456'
const SCHEMA = `kc_test_${Math.random().toString(36).slice(2, 10)}`
const BASE = process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5433/rr_test'
// `options` is a startup parameter, so this needs a direct (non-pooled) connection.
process.env.DATABASE_URL = `${BASE}${BASE.includes('?') ? '&' : '?'}options=-c%20search_path%3D${SCHEMA}`

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { Client } from 'pg'
import { AppModule } from '../src/app.module'
import { configureApp } from '../src/setup'
import { DbService } from '../src/db/db.service'
import { provisionStore } from '../src/provision'
import { sslOption } from '../src/db/ssl'

describe('super admin and device health', () => {
  let app: NestExpressApplication
  let db: DbService
  const http = () => request(app.getHttpServer())
  const api = (p: string) => `/api${p}`
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
  let ownerA = '', superToken = '', superId = ''

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE, ssl: sslOption(BASE) })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await admin.end()

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication<NestExpressApplication>()
    configureApp(app)
    await app.init()
    db = app.get(DbService)
    const dir = join(__dirname, '../migrations')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.pool.query(readFileSync(join(dir, f), 'utf8'))

    await provisionStore(db, { storeName: 'Store A', ownerName: 'Asha', ownerEmail: 'asha@a.in', password: 'password-a-1', pin: '1111', storeId: 'store_a' })
    await provisionStore(db, { storeName: 'Store B', ownerName: 'Bala', ownerEmail: 'bala@b.in', password: 'password-b-1', pin: '2222', storeId: 'store_b' })
    const dev = await provisionStore(db, { storeName: 'Dev', ownerName: 'Dev', ownerEmail: 'dev@x.in', password: 'password-dev-1', pin: '3333', storeId: 'store_dev' })
    superId = dev.ownerId
    ownerA = (await http().post(api('/auth/web-login')).send({ email: 'asha@a.in', password: 'password-a-1' }).expect(201)).body.token
  })

  afterAll(async () => {
    try { await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`) } finally { await app.close() }
  })

  it('migrations ran inside the scratch schema, not public', async () => {
    const r = await db.query('SELECT current_schema() AS s')
    expect(r[0].s).toBe(SCHEMA)
  })

  it('an ordinary owner is not a super admin and cannot read the overview', async () => {
    const login = await http().post(api('/auth/web-login')).send({ email: 'asha@a.in', password: 'password-a-1' }).expect(201)
    expect(login.body.user.superAdmin).toBe(false)
    await http().get(api('/admin/overview')).set(auth(ownerA)).expect(403)
  })

  it('the flag can only be set in the database, and then shows in the token and unlocks the overview', async () => {
    await db.query('UPDATE users SET is_super_admin = TRUE WHERE id = :id', { id: superId })
    const login = await http().post(api('/auth/web-login')).send({ email: 'dev@x.in', password: 'password-dev-1' }).expect(201)
    expect(login.body.user.superAdmin).toBe(true)
    superToken = login.body.token
    expect(JSON.parse(Buffer.from(superToken.split('.')[1], 'base64').toString()).sa).toBe(true)
    const ov = await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)
    expect(ov.body.stores.map((s: { id: string }) => s.id).sort()).toEqual(['store_a', 'store_b', 'store_dev'])
    // a refreshed token keeps the claim
    const ref = await http().post(api('/auth/refresh')).set(auth(superToken)).expect(201)
    expect(JSON.parse(Buffer.from(ref.body.token.split('.')[1], 'base64').toString()).sa).toBe(true)
  })

  it('a token that says super admin is not enough once the database flag is removed', async () => {
    await db.query('UPDATE users SET is_super_admin = FALSE WHERE id = :id', { id: superId })
    await http().get(api('/admin/overview')).set(auth(superToken)).expect(403)
    await db.query('UPDATE users SET is_super_admin = TRUE WHERE id = :id', { id: superId })
    await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)
  })

  it('devices report their health; one row per device, replaced on each report, kept per store', async () => {
    const report = (extra: object = {}) => http().post(api('/device-health')).set(auth(ownerA)).send({
      deviceId: 'Desktop-ab12', appVersion: '0.1.1', platform: 'desktop',
      sync: { online: true, authenticated: true, pending: 0, rejected: 0, lastSyncedAt: Date.now(), lastError: null },
      backup: { cloudOkAt: Date.now(), cloudError: null, localOkAt: Date.now(), localError: null, encrypted: false, drive: '' },
      rejects: [], ...extra,
    })
    await report().expect(201)
    let ov = (await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)).body.stores as Array<{ id: string; devices: Array<{ deviceId: string; flags: string[] }>; flags: string[] }>
    const a = ov.find((s) => s.id === 'store_a')!
    expect(a.devices).toHaveLength(1)
    expect(a.devices[0].flags).toEqual([])
    expect(ov.find((s) => s.id === 'store_b')!.devices).toHaveLength(0)

    // problems come through as flags, with the reasons
    await report({
      sync: { online: true, authenticated: true, pending: 3, oldestPendingAt: Date.now() - 20 * 60_000, rejected: 2, lastError: 'stalled' },
      backup: { cloudError: 'Cloud backup failed (500)', localError: 'Documents: the disk is full' },
      rejects: [{ entity: 'bill', attempts: 3, error: '422 {"error":"Missing required field(s): phone"}', at: Date.now() }],
    }).expect(201)
    ov = (await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)).body.stores
    const d = ov.find((s) => s.id === 'store_a')!.devices
    expect(d).toHaveLength(1) // replaced, not appended
    expect(d[0].flags).toEqual(expect.arrayContaining(['rejected_changes', 'stuck_queue', 'cloud_backup_failing', 'local_backup_failing']))
  })

  it('bill options default to a clean receipt, can be changed by the owner, and reach every device through the snapshot', async () => {
    const before = await http().get(api('/store')).set(auth(ownerA)).expect(200)
    expect(before.body).toMatchObject({ receiptShowTax: false, receiptShowHsn: false, receiptShowSavings: true, receiptShowLoyalty: true })
    const put = await http().put(api('/store')).set(auth(ownerA)).send({ receiptShowTax: true, receiptShowSavings: false }).expect(200)
    expect(put.body).toMatchObject({ receiptShowTax: true, receiptShowHsn: false, receiptShowSavings: false, receiptShowLoyalty: true })
    const snap = await http().get(api('/sync/snapshot')).set(auth(ownerA)).expect(200)
    expect(snap.body.store).toMatchObject({ receiptShowTax: true, receiptShowSavings: false })
    // another store is unaffected
    const b = (await http().post(api('/auth/web-login')).send({ email: 'bala@b.in', password: 'password-b-1' }).expect(201)).body.token
    expect((await http().get(api('/store')).set(auth(b)).expect(200)).body.receiptShowTax).toBe(false)
  })

  it('flags a store that has sales but no backup, and one whose backup is stale', async () => {
    const bill = (id: string, date: number) => db.query(
      `INSERT INTO bills (id, store_id, no, date, status, total, cashier_id) VALUES (:id, 'store_b', :id, :date, 'paid', 100, (SELECT id FROM users WHERE store_id = 'store_b' LIMIT 1))`, { id, date })
    await bill('bill_x1', Date.now())
    let ov = (await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)).body.stores as Array<{ id: string; flags: string[] }>
    expect(ov.find((s) => s.id === 'store_b')!.flags).toContain('never_backed_up')

    // an old backup, and a sale made after it
    await db.query(
      `INSERT INTO backups (store_id, created_by, device, kind, checksum, size_bytes, raw_bytes, counts, payload)
       VALUES ('store_b', NULL, 'd', 'auto', :sum, 1, 1, '{}'::jsonb, :payload)`,
      { sum: 'a'.repeat(64), payload: Buffer.from([0x1f, 0x8b]) })
    await db.query(`UPDATE backups SET created_at = now() - interval '3 days' WHERE store_id = 'store_b'`)
    ov = (await http().get(api('/admin/overview')).set(auth(superToken)).expect(200)).body.stores
    expect(ov.find((s) => s.id === 'store_b')!.flags).toContain('backup_stale')
  })
})
