/**
 * Passphrase protection for backup files. A backup holds every customer's phone number and address, the staff
 * PINs and all the sales — so a copy that leaves the shop (email, USB stick, cloud drive) can be locked.
 *
 * AES-256-GCM with a key derived from the passphrase by PBKDF2-SHA-256 (250,000 rounds, random salt). GCM also
 * authenticates the file: a wrong passphrase or a damaged file fails cleanly instead of producing garbage.
 * There is no recovery if the passphrase is forgotten — that is the point.
 */
const enc = new TextEncoder()
const dec = new TextDecoder()

export const ENCRYPTED_FORMAT = 'rr-dairy-encrypted-backup'
const ITERATIONS = 250_000

function toB64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** A machine-made recovery key is already unguessable, so it needs far fewer rounds than a typed passphrase. */
export const KEY_ITERATIONS = 20_000

export async function encryptText(plain: string, passphrase: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, iterations)
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(plain) as BufferSource))
  return JSON.stringify({ format: ENCRYPTED_FORMAT, v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(data) })
}

/** True for a file produced by encryptText — checked on the first bytes so a multi-MB plain backup isn't parsed twice. */
export function isEncryptedBackup(text: string): boolean {
  return text.slice(0, 200).includes(ENCRYPTED_FORMAT)
}

/* Recovery keys: 32 characters (160 bits) from an alphabet without look-alikes, shown in groups of four. */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => KEY_ALPHABET[b % 32]).join('')
}

/** What the person sees and writes down: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export const formatRecoveryKey = (raw: string) => raw.replace(/(.{4})(?=.)/g, '$1-')

/** Accepts the key however it was copied or retyped: any case, with or without dashes and spaces. */
export const normalizeRecoveryKey = (typed: string) => typed.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Decrypts with a typed passphrase, or — failing that — with the same text read as a recovery key. */
export async function decryptWithPassphraseOrKey(text: string, typed: string): Promise<string> {
  try {
    return await decryptText(text, typed)
  } catch (first) {
    const key = normalizeRecoveryKey(typed)
    if (key.length === 32 && key !== typed) return decryptText(text, key)
    throw first
  }
}

export async function decryptText(text: string, passphrase: string): Promise<string> {
  try {
    const f = JSON.parse(text) as { format?: string; iterations?: number; salt: string; iv: string; data: string }
    if (f.format !== ENCRYPTED_FORMAT) throw new Error('not encrypted')
    const key = await deriveKey(passphrase, fromB64(f.salt), f.iterations ?? ITERATIONS)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(f.iv) as BufferSource }, key, fromB64(f.data) as BufferSource)
    return dec.decode(plain)
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged')
  }
}
