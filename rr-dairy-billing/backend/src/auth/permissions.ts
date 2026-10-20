import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'

export type Role = 'owner' | 'manager' | 'cashier'
export interface Claims { sub: string; storeId: string; role: Role; /** Developer/support account: set only in the database. */ superAdmin?: boolean }

/** Mirrors the frontend's permission matrix (src/state.tsx) — the API enforces it independently of the UI. */
const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: ['pos', 'inventory', 'purchases', 'stock', 'customers', 'expenses', 'reports', 'settings', 'viewProfit', 'deleteBill', 'bigDiscount',
    'collection', 'quality', 'production', 'delivery', 'settlement', 'wastage', 'approveWastage'],
  manager: ['pos', 'inventory', 'purchases', 'stock', 'customers', 'expenses', 'reports', 'bigDiscount',
    'collection', 'quality', 'production', 'delivery', 'settlement', 'wastage'],
  cashier: ['pos', 'customers', 'collection', 'delivery'],
}

export const PUBLIC_KEY = 'isPublic'
export const PERM_KEY = 'permission'
export const Public = () => SetMetadata(PUBLIC_KEY, true)
export const Perm = (permission: string) => SetMetadata(PERM_KEY, permission)
/** Injects the verified token claims. store_id always comes from here, never from the request body. */
export const Auth = createParamDecorator((_d: unknown, ctx: ExecutionContext): Claims => ctx.switchToHttp().getRequest().claims)

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true

    const req = ctx.switchToHttp().getRequest<Request & { claims?: Claims }>()
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
    if (!m) throw new UnauthorizedException('Missing or malformed Authorization header')
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; store_id: string; role: Role; sa?: boolean }>(m[1])
      req.claims = { sub: p.sub, storeId: p.store_id, role: p.role, superAdmin: p.sa === true }
    } catch (e) {
      throw new UnauthorizedException((e as Error).name === 'TokenExpiredError' ? 'Session expired — please log in again' : 'Invalid token')
    }

    const needed = this.reflector.getAllAndOverride<string | undefined>(PERM_KEY, targets)
    if (needed && !(ROLE_PERMISSIONS[req.claims.role] ?? []).includes(needed)) {
      throw new ForbiddenException('Not permitted for your role')
    }
    return true
  }
}
