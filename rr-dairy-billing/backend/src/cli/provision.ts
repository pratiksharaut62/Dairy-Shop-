import '../env'
import 'reflect-metadata'
import { Client } from 'pg'
import { sslOption } from '../db/ssl'
import { named } from '../db/db.service'
import { provisionStore } from '../provision'

/**
 * npm run provision -- --store "RR Dairy" --owner "Rohan Gosavi" --email owner@shop.in --password "..." --pin 1234
 * Optional: --store-id store_rr  --gstin 27ABCDE1234F1Z5  --city Pune  --phone +91...
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const need = (n: string) => arg(n) ?? (() => { throw new Error(`Missing --${n}`) })()
  const client = new Client({ connectionString: url, ssl: sslOption(url) })
  await client.connect()
  try {
    await client.query('BEGIN')
    const q = { query: async (sql: string, p?: Record<string, unknown>) => { const n = named(sql, p); return (await client.query(n.text, n.values)).rows }, one: async (sql: string, p?: Record<string, unknown>) => (await q.query(sql, p))[0] }
    const res = await provisionStore(q, {
      storeName: need('store'), ownerName: need('owner'), ownerEmail: need('email'), password: need('password'), pin: need('pin'),
      storeId: arg('store-id'), gstin: arg('gstin'), city: arg('city'), phone: arg('phone'),
    })
    await client.query('COMMIT')
    console.log(`Store created.\n  Store ID : ${res.storeId}\n  Owner ID : ${res.ownerId}\n  Web login: ${need('email')}`)
    console.log('Put the Store ID into the app: Settings → Data → Cloud sync.')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
