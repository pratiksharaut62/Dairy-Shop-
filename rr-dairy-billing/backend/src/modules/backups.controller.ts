import { BadRequestException, Controller, Get, NotFoundException, Param, PayloadTooLargeException, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { DbService } from '../db/db.service'
import { Auth, Claims, Perm } from '../auth/permissions'

const MAX_BYTES = 40 * 1024 * 1024
/** Newest versions always kept, regardless of age. */
const KEEP_RECENT = 12
/** Plus the last upload of every day for this many days. */
const KEEP_DAILY_DAYS = 30
/** Plus the most recent hand-made backups. */
const KEEP_MANUAL = 10

const header = (req: Request, name: string) => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Whole-store backups. The client compresses everything it holds (all tables, including the audit log and stock
 * ledger) and uploads it on a schedule; this keeps recent versions so a lost or damaged device can be restored.
 *
 *  - upload / list: owner + manager (the people whose devices hold the full data set — a cashier's device only
 *    has a role-filtered copy and must not be able to overwrite the good backups with it)
 *  - download / restore: owner only
 */
@Controller('backups')
export class BackupsController {
  constructor(private readonly db: DbService) {}

  @Perm('reports') @Post()
  async create(@Auth() c: Claims, @Req() req: Request) {
    const buf = req.body as unknown
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new BadRequestException('Send the gzip-compressed backup as application/octet-stream')
    if (buf.length > MAX_BYTES) throw new PayloadTooLargeException('Backup is larger than the 40 MB limit')
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new BadRequestException('Backup must be gzip-compressed')

    const checksum = String(header(req, 'x-checksum') ?? '')
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new BadRequestException('X-Checksum must be a SHA-256 hex digest')
    const kind = header(req, 'x-kind') === 'manual' ? 'manual' : 'auto'
    const device = String(header(req, 'x-device') ?? '').slice(0, 80)
    const rawBytes = Math.max(0, Math.min(2_000_000_000, parseInt(String(header(req, 'x-raw-bytes') ?? '0'), 10) || 0))
    let counts: Record<string, number> = {}
    try {
      const parsed = JSON.parse(String(header(req, 'x-counts') ?? '{}')) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isFinite(v) && k.length < 40) counts[k] = v
    } catch { counts = {} }

    // Nothing changed since the last automatic upload: don't store the same data twice.
    if (kind === 'auto') {
      const last = await this.db.one('SELECT id, checksum, created_at FROM backups WHERE store_id = :s ORDER BY created_at DESC LIMIT 1', { s: c.storeId })
      if (last && last.checksum === checksum) return { id: last.id, createdAt: last.created_at, deduped: true }
    }

    const row = await this.db.one(
      `INSERT INTO backups (store_id, created_by, device, kind, checksum, size_bytes, raw_bytes, counts, payload)
       VALUES (:s, :by, :device, :kind, :checksum, :size, :raw, :counts::jsonb, :payload)
       RETURNING id, created_at`,
      { s: c.storeId, by: c.sub, device, kind, checksum, size: buf.length, raw: rawBytes, counts: JSON.stringify(counts), payload: buf })

    // Prune: newest N, the last one of each day for a month, and the latest manual ones. Everything else goes.
    await this.db.query(
      `DELETE FROM backups WHERE store_id = :s AND id NOT IN (
         SELECT id FROM (SELECT id FROM backups WHERE store_id = :s ORDER BY created_at DESC LIMIT ${KEEP_RECENT}) recent
         UNION
         SELECT id FROM (SELECT DISTINCT ON (created_at::date) id FROM backups
                          WHERE store_id = :s AND created_at > now() - interval '${KEEP_DAILY_DAYS} days'
                          ORDER BY created_at::date, created_at DESC) daily
         UNION
         SELECT id FROM (SELECT id FROM backups WHERE store_id = :s AND kind = 'manual' ORDER BY created_at DESC LIMIT ${KEEP_MANUAL}) manual
       )`, { s: c.storeId })

    return { id: row!.id, createdAt: row!.created_at, deduped: false }
  }

  @Perm('reports') @Get()
  async list(@Auth() c: Claims) {
    const rows = await this.db.query(
      `SELECT id, created_at, created_by, device, kind, checksum, size_bytes, raw_bytes, counts
       FROM backups WHERE store_id = :s ORDER BY created_at DESC LIMIT 60`, { s: c.storeId })
    return rows.map((r) => ({
      id: r.id, createdAt: r.created_at, createdBy: r.created_by, device: r.device, kind: r.kind,
      checksum: r.checksum, sizeBytes: r.size_bytes, rawBytes: r.raw_bytes, counts: r.counts,
    }))
  }

  @Perm('settings') @Get(':id')
  async download(@Auth() c: Claims, @Param('id') id: string, @Res() res: Response) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Invalid backup id')
    const row = await this.db.one('SELECT payload, checksum, created_at FROM backups WHERE id = :id AND store_id = :s', { id, s: c.storeId })
    if (!row) throw new NotFoundException('Backup not found')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('X-Checksum', row.checksum)
    res.setHeader('Access-Control-Expose-Headers', 'X-Checksum')
    res.send(row.payload)
  }
}
