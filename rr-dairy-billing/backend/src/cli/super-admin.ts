import '../env'
import 'reflect-metadata'
import { Client } from 'pg'
import { sslOption } from '../db/ssl'

/**
 * Grants or removes the developer / support "super admin" flag on an existing user. This is deliberately a command
 * line tool and not an API: nobody can promote themselves from inside the app.
 *
 *   npm run super-admin -- --email dev@example.com
 *   npm run super-admin -- --email dev@example.com --off
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const email = arg('email')
  if (!email) throw new Error('Missing --email')
  const on = !process.argv.includes('--off')
  const client = new Client({ connectionString: url, ssl: sslOption(url) })
  await client.connect()
  try {
    const r = await client.query('UPDATE users SET is_super_admin = $1 WHERE lower(email) = lower($2) RETURNING id, name, store_id', [on, email])
    if (!r.rowCount) throw new Error(`No user with the email ${email}`)
    console.log(`${r.rows[0].name} (${r.rows[0].id}, store ${r.rows[0].store_id}) is ${on ? 'now' : 'no longer'} a super admin.`)
    console.log('Takes effect at their next sign-in or token refresh (within about 9 hours).')
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
