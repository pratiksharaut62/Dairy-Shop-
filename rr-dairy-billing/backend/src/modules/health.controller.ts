import { Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common'
import { DbService } from '../db/db.service'
import { body } from '../common/http'
import { Auth, Claims } from '../auth/permissions'

const HOUR = 3_600_000

const num = (v: unknown, max = 1e15): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : null)
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/**
 * Devices report their own sync and backup health here. The shop's PC is out of our reach, so this is the only way
 * a stuck queue or a failing backup becomes visible to us. Only counters, error text and entity names are accepted —
 * never bill contents.
 */
@Controller('device-health')
export class DeviceHealthController {
  constructor(private readonly db: DbService) {}

  /** Any signed-in device, any role: a cashier's counter reports too. Stored per store, replaced on every report. */
  @Post()
  async report(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw)
    const deviceId = str(b.deviceId, 80)
    if (!deviceId) return { ok: false }
    const sync = (b.sync ?? {}) as Record<string, unknown>
    const backup = (b.backup ?? {}) as Record<string, unknown>
    const rejects = Array.isArray(b.rejects) ? (b.rejects as Array<Record<string, unknown>>).slice(0, 10) : []
    const payload = {
      appVersion: str(b.appVersion, 40), platform: str(b.platform, 20), role: c.role,
      sync: {
        online: sync.online === true, authenticated: sync.authenticated === true,
        pending: num(sync.pending), oldestPendingAt: num(sync.oldestPendingAt), rejected: num(sync.rejected),
        lastSyncedAt: num(sync.lastSyncedAt), lastError: str(sync.lastError),
      },
      backup: {
        cloudOkAt: num(backup.cloudOkAt), cloudError: str(backup.cloudError),
        localOkAt: num(backup.localOkAt), localError: str(backup.localError),
        encrypted: backup.encrypted === true, drive: str(backup.drive, 2),
      },
      rejects: rejects.map((r) => ({ entity: str(r.entity, 40), attempts: num(r.attempts, 1000), error: str(r.error, 300), at: num(r.at) })),
    }
    await this.db.query(
      `INSERT INTO device_health (store_id, device_id, user_id, payload) VALUES (:s, :d, :u, :p::jsonb)
       ON CONFLICT (store_id, device_id) DO UPDATE SET user_id = :u, payload = :p::jsonb, reported_at = now()`,
      { s: c.storeId, d: deviceId, u: c.sub, p: JSON.stringify(payload) })
    return { ok: true }
  }
}

/** Cross-store view for the developer account. Everything here requires `users.is_super_admin` in the database. */
@Controller('admin')
export class AdminController {
  constructor(private readonly db: DbService) {}

  /** Checked against the database on every call, so removing the flag takes effect immediately, not at token expiry. */
  private async assertSuperAdmin(c: Claims) {
    const u = await this.db.one('SELECT is_super_admin, active FROM users WHERE id = :id', { id: c.sub })
    if (!u || !u.active || !u.is_super_admin) throw new ForbiddenException('Not permitted')
  }

  @Get('overview')
  async overview(@Auth() c: Claims, @Query('quietHours') quietHours?: string) {
    await this.assertSuperAdmin(c)
    const quiet = Math.max(1, Math.min(168, Number(quietHours) || 6)) * HOUR
    const now = Date.now()

    const stores = await this.db.query(
      `SELECT s.id, s.name, s.plan,
              (SELECT max(created_at) FROM backups b WHERE b.store_id = s.id) AS last_backup_at,
              (SELECT max(created_at) FROM backups b WHERE b.store_id = s.id AND b.kind = 'auto') AS last_auto_backup_at,
              (SELECT max(date) FROM bills x WHERE x.store_id = s.id) AS last_bill_at,
              (SELECT count(*)::int FROM bills x WHERE x.store_id = s.id) AS bill_count
         FROM stores s ORDER BY s.name`)
    const devices = await this.db.query('SELECT store_id, device_id, user_id, first_seen, reported_at, payload FROM device_health ORDER BY reported_at DESC')

    return {
      generatedAt: now,
      stores: stores.map((s) => {
        const devs = devices.filter((d) => d.store_id === s.id).map((d) => {
          const p = d.payload as {
            sync?: { pending?: number; rejected?: number; oldestPendingAt?: number; authenticated?: boolean; online?: boolean }
            backup?: { cloudError?: string | null; localError?: string | null }
          }
          const reportedAt = new Date(d.reported_at).getTime()
          const flags: string[] = []
          if (now - reportedAt > quiet) flags.push('silent')
          if ((p.sync?.rejected ?? 0) > 0) flags.push('rejected_changes')
          if ((p.sync?.pending ?? 0) > 0 && p.sync?.oldestPendingAt && now - p.sync.oldestPendingAt > 10 * 60_000) flags.push('stuck_queue')
          if (p.sync?.authenticated === false) flags.push('signed_out')
          if (p.backup?.cloudError) flags.push('cloud_backup_failing')
          if (p.backup?.localError) flags.push('local_backup_failing')
          return { deviceId: d.device_id, userId: d.user_id, firstSeen: d.first_seen, reportedAt: d.reported_at, flags, ...p }
        })
        const lastBackupMs = s.last_backup_at ? new Date(s.last_backup_at).getTime() : 0
        const lastBillMs = s.last_bill_at ? Number(s.last_bill_at) : 0
        const storeFlags: string[] = []
        if (s.bill_count > 0 && !lastBackupMs) storeFlags.push('never_backed_up')
        // Sales happened after the newest backup and it is over a day old: backups are not keeping up.
        else if (lastBackupMs && lastBillMs > lastBackupMs && now - lastBackupMs > 24 * HOUR) storeFlags.push('backup_stale')
        if (!devs.length && s.bill_count > 0) storeFlags.push('no_device_reports')
        return {
          id: s.id, name: s.name, plan: s.plan, billCount: s.bill_count,
          lastBillAt: lastBillMs || null, lastBackupAt: s.last_backup_at, lastAutoBackupAt: s.last_auto_backup_at,
          flags: storeFlags, devices: devs,
        }
      }),
    }
  }
}
