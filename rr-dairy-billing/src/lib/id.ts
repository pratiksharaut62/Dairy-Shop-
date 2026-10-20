const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Short, sortable, human-readable id. Prefixed so ids are self-describing in exports. */
export function id(prefix: string): string {
  let t = Date.now()
  let out = ''
  for (let i = 0; i < 8; i++) { out = ALPHABET[t % 32] + out; t = Math.floor(t / 32) }
  let rand = ''
  for (let i = 0; i < 4; i++) rand += ALPHABET[Math.floor(Math.random() * 32)]
  return `${prefix}_${out}${rand}`
}

export const pad = (n: number, width: number) => String(n).padStart(width, '0')
