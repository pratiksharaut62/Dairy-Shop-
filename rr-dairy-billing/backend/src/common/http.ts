import { ArgumentsHost, BadRequestException, Catch, ConflictException, ExceptionFilter, HttpException, Logger, UnprocessableEntityException } from '@nestjs/common'
import type { Response } from 'express'
import type { Params } from '../db/db.service'

/** Every error leaves the API as `{ error: string }` — the frontend sync client only ever reads status codes and that shape. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Http')
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    if (exception instanceof HttpException) {
      const body = exception.getResponse()
      const message = typeof body === 'string' ? body : Array.isArray((body as { message?: unknown }).message)
        ? ((body as { message: string[] }).message).join(', ')
        : String((body as { message?: string }).message ?? exception.message)
      res.status(exception.getStatus()).json({ error: message })
      return
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception))
    res.status(500).json({ error: 'Internal server error' })
  }
}

export function body(b: unknown): Params {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequestException('Request body must be JSON')
  return b as Params
}

export function required(data: Params, fields: string[]) {
  const missing = fields.filter((f) => data[f] === undefined || data[f] === null || data[f] === '')
  if (missing.length) throw new UnprocessableEntityException(`Missing required field(s): ${missing.join(', ')}`)
}

export const num = (v: unknown, fallback = 0) => (v === undefined || v === null || v === '' ? fallback : Number(v))

/** Maps a Postgres error to the status the sync client expects: 409 = "already there, treat as done". */
export function pgToHttp(e: unknown, context: string, conflictMessage?: string): never {
  if (e instanceof HttpException) throw e
  const err = e as { code?: string; message?: string }
  if (err.code === '23505') throw new ConflictException(conflictMessage ?? 'Already exists')
  throw new UnprocessableEntityException(`${context}: ${err.message ?? 'database error'}`)
}

/** Builds `UPDATE ... SET a = :a, b = :b` from the subset of body keys present. Returns null when nothing to update. */
export function partialUpdate(
  table: string, b: Params, map: Record<string, string>, where: string, whereParams: Params,
  transform: Record<string, (v: unknown) => unknown> = {},
): { sql: string; params: Params } | null {
  const set: string[] = []
  const params: Params = { ...whereParams }
  for (const [jsonKey, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, jsonKey)) {
      set.push(`${col} = :set_${col}`)
      params[`set_${col}`] = transform[jsonKey] ? transform[jsonKey](b[jsonKey]) : b[jsonKey]
    }
  }
  if (!set.length) return null
  return { sql: `UPDATE ${table} SET ${set.join(', ')} WHERE ${where}`, params }
}
