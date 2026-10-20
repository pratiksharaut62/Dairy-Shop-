import { Controller, Get, Post, Query, Req, UseGuards, Body, Put, Param, UnprocessableEntityException } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { DbService } from '../db/db.service'
import { body, partialUpdate, pgToHttp, required } from '../common/http'
import { Auth, Claims, Perm, Public } from './permissions'
import { AuthService } from './auth.service'

@Controller('auth')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Counter/desktop login: store + staff member + PIN. This is what the sync client uses. */
  @Public() @Post('login')
  login(@Body() raw: unknown) {
    const b = body(raw); required(b, ['storeId', 'userId', 'pin'])
    return this.auth.loginWithPin(String(b.storeId), String(b.userId), String(b.pin))
  }

  /** Web login: email + password, no store id needed — the account belongs to exactly one store. */
  @Public() @Post('web-login')
  webLogin(@Body() raw: unknown) {
    const b = body(raw); required(b, ['email', 'password'])
    return this.auth.loginWithPassword(String(b.email), String(b.password))
  }

  @Post('refresh')
  refresh(@Auth() c: Claims) { return this.auth.refresh(c) }

  @Get('me')
  me(@Auth() c: Claims) { return { id: c.sub, storeId: c.storeId, role: c.role } }
}

@Controller('users')
export class UsersController {
  constructor(private readonly db: DbService, private readonly auth: AuthService) {}

  /** Unauthenticated on purpose: the "who's at the counter?" list a login screen shows before any PIN. Never returns hashes. */
  @Public() @Get()
  async publicList(@Query('storeId') storeId?: string) {
    if (!storeId) throw new UnprocessableEntityException('storeId query parameter is required')
    const rows = await this.db.query(
      `SELECT id, name, role, active FROM users WHERE store_id = :storeId
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, name`, { storeId })
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active }))
  }

  @Perm('settings') @Post()
  async create(@Auth() c: Claims, @Body() raw: unknown) {
    const b = body(raw); required(b, ['id', 'name', 'role', 'pin'])
    try {
      await this.db.query(
        `INSERT INTO users (id, store_id, name, role, pin_hash, email, password_hash, active)
         VALUES (:id, :storeId, :name, :role, :pinHash, :email, :passHash, :active)`,
        {
          id: b.id, storeId: c.storeId, name: b.name, role: b.role, pinHash: await this.auth.hash(String(b.pin)),
          email: b.email || null, passHash: b.password ? await this.auth.hash(String(b.password)) : null, active: b.active !== false,
        })
    } catch (e) { pgToHttp(e, 'Could not create user', 'A user with that id or email already exists') }
    return { ok: true, id: b.id }
  }

  @Perm('settings') @Put(':id')
  async update(@Auth() c: Claims, @Param('id') id: string, @Body() raw: unknown) {
    const b = body(raw)
    const patch: Record<string, unknown> = { ...b }
    if (b.pin !== undefined) patch.pinHash = await this.auth.hash(String(b.pin))
    if (b.password) patch.passwordHash = await this.auth.hash(String(b.password))
    const u = partialUpdate('users', patch,
      { name: 'name', role: 'role', active: 'active', email: 'email', pinHash: 'pin_hash', passwordHash: 'password_hash' },
      'id = :id AND store_id = :storeId', { id, storeId: c.storeId },
      { email: (v) => v || null })
    if (u) { try { await this.db.query(u.sql, u.params) } catch (e) { pgToHttp(e, 'Could not update user', 'That email is already in use') } }
    return { ok: true }
  }
}
