import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { Pool, PoolClient, types } from 'pg'
import { sslOption } from './ssl'

// BIGINT (epoch millis, well under 2^53) and NUMERIC (money) arrive as strings by default.
types.setTypeParser(20, (v) => Number(v))
types.setTypeParser(1700, (v) => Number(v))

export type Params = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

/** Turns `:name` placeholders into `$1..$n`, so SQL stays readable. `::` casts are left alone. */
export function named(sql: string, params: Params = {}): { text: string; values: unknown[] } {
  const values: unknown[] = []
  const index = new Map<string, number>()
  const text = sql.replace(/(?<![:\w]):([a-zA-Z_]\w*)/g, (_m, key: string) => {
    if (!(key in params)) throw new Error(`Missing SQL parameter :${key}`)
    if (!index.has(key)) { values.push(params[key] === undefined ? null : params[key]); index.set(key, values.length) }
    return `$${index.get(key)}`
  })
  return { text, values }
}

export interface Queryable {
  query(sql: string, params?: Params): Promise<Row[]>
  one(sql: string, params?: Params): Promise<Row | undefined>
}

class Executor implements Queryable {
  constructor(private readonly target: Pool | PoolClient) {}
  async query(sql: string, params?: Params): Promise<Row[]> {
    const { text, values } = named(sql, params)
    return (await this.target.query(text, values)).rows
  }
  async one(sql: string, params?: Params): Promise<Row | undefined> {
    return (await this.query(sql, params))[0]
  }
}

@Injectable()
export class DbService extends Executor implements OnModuleDestroy {
  readonly pool: Pool

  constructor() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill in your Neon connection string')
    const pool = new Pool({
      connectionString: url,
      ssl: sslOption(url),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000, // Neon may need a moment to wake a suspended compute
    })
    super(pool)
    this.pool = pool
  }

  /** Runs fn inside one transaction; commits on return, rolls back on throw. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new Executor(client))
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      client.release()
    }
  }

  async onModuleDestroy() { await this.pool.end() }
}
