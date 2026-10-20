import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { DbService, Row } from '../db/db.service'

const MAX_ATTEMPTS = 5
const LOCK_MINUTES = 15

/**
 * PINs are short (4 digits) by design, so the real brute-force defence is the
 * per-user lockout (5 failures → 15 minutes), not hash strength.
 */
@Injectable()
export class AuthService {
  constructor(private readonly db: DbService, private readonly jwt: JwtService) {}

  hash(secret: string) { return bcrypt.hash(secret, 10) }

  async loginWithPin(storeId: string, userId: string, pin: string) {
    const user = await this.db.one('SELECT * FROM users WHERE id = :userId AND store_id = :storeId', { userId, storeId })
    return this.verify(user, pin, 'pin_hash', 'Invalid user or PIN')
  }

  /**
   * Swaps a still-valid token for a fresh one, so a counter that stays open all day keeps its cloud connection
   * (and its scheduled backups) without anyone re-entering a password. Re-checks that the person and store are
   * still allowed in, so disabling a user takes effect at the next refresh.
   */
  async refresh(claims: { sub: string; storeId: string }) {
    const user = await this.db.one('SELECT * FROM users WHERE id = :id AND store_id = :s', { id: claims.sub, s: claims.storeId })
    if (!user || !user.active) throw new UnauthorizedException('This account is no longer active')
    const store = await this.db.one('SELECT plan FROM stores WHERE id = :id', { id: user.store_id })
    if (!store || store.plan === 'suspended') throw new HttpException('This store account is suspended — contact support', 403)
    return { token: await this.jwt.signAsync({ sub: user.id, store_id: user.store_id, role: user.role, ...(user.is_super_admin ? { sa: true } : {}) }) }
  }

  async loginWithPassword(email: string, password: string) {
    const user = await this.db.one('SELECT * FROM users WHERE lower(email) = lower(:email)', { email })
    return this.verify(user, password, 'password_hash', 'Invalid email or password')
  }

  private async verify(user: Row | undefined, secret: string, hashCol: 'pin_hash' | 'password_hash', failMsg: string) {
    if (!user || !user.active || !user[hashCol]) throw new UnauthorizedException(failMsg)
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000)
      throw new HttpException(`Too many failed attempts — try again in ${mins} minute(s)`, 429)
    }
    if (!(await bcrypt.compare(secret, user[hashCol]))) {
      const attempts = user.failed_login_attempts + 1
      const lock = attempts >= MAX_ATTEMPTS
      await this.db.query(
        'UPDATE users SET failed_login_attempts = :a, locked_until = :l WHERE id = :id',
        { a: lock ? 0 : attempts, l: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null, id: user.id },
      )
      throw new UnauthorizedException(failMsg)
    }
    await this.db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = :id', { id: user.id })

    const store = await this.db.one('SELECT id, name, plan FROM stores WHERE id = :id', { id: user.store_id })
    if (!store || store.plan === 'suspended') throw new HttpException('This store account is suspended — contact support', 403)

    const token = await this.jwt.signAsync({ sub: user.id, store_id: user.store_id, role: user.role, ...(user.is_super_admin ? { sa: true } : {}) })
    return {
      token,
      user: { id: user.id, name: user.name, role: user.role, storeId: user.store_id, superAdmin: !!user.is_super_admin },
      store: { id: store.id, name: store.name },
    }
  }
}
