import '../env'
import 'reflect-metadata'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'
import { sslOption } from '../db/ssl'

/** Applies migrations/*.sql in filename order, once each, tracked in schema_migrations. */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const client = new Client({ connectionString: url, ssl: sslOption(url) })
  await client.connect()
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
  const dir = join(__dirname, '..', '..', 'migrations')
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    console.log(`applying ${file}`)
    await client.query('BEGIN')
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'))
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
  }
  await client.end()
  console.log('migrations up to date')
}

main().catch((e) => { console.error(e); process.exit(1) })
