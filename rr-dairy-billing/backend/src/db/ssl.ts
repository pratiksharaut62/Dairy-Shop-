/** Neon (and most hosted Postgres) require TLS; a local Postgres usually has none. */
export function sslOption(url: string): false | { rejectUnauthorized: boolean } {
  if (process.env.DATABASE_SSL === 'false') return false
  if (/sslmode=disable/.test(url)) return false
  if (/localhost|127\.0\.0\.1/.test(url) && process.env.DATABASE_SSL !== 'true') return false
  return { rejectUnauthorized: true }
}
