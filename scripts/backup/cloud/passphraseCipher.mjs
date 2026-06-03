// Zero-dependency streaming AES-256-GCM file cipher for passphrase-encrypted
// cloud backups. The key is scrypt-derived from the operator's passphrase; the
// salt / iv / auth-tag live in the cleartext sidecar (next to the uploaded
// blob) so cloud-pull can decrypt before it can read the inner manifest.
//
// Why not `age`: age's passphrase mode needs an interactive TTY (not
// scriptable) and a customer-installed `age` binary. AES-256-GCM via
// node:crypto is fully zero-dep, streams multi-GB archives, and matches the
// primitives the app's secretCipher already uses.

import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

// scrypt cost params: N=2^15 (32768), r=8, p=1 → ~strong, ~tens of ms. maxmem
// must clear 128*N*r bytes (~32 MiB) with headroom.
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16

function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
}

// Encrypt srcPath -> destPath. Returns { saltB64, ivB64, tagB64 } for the sidecar.
export async function encryptFile({ srcPath, destPath, passphrase }) {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  await pipeline(createReadStream(srcPath), cipher, createWriteStream(destPath, { mode: 0o600 }))
  const tag = cipher.getAuthTag()
  return {
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
    tagB64: tag.toString('base64'),
  }
}

// Decrypt srcPath -> destPath using sidecar salt/iv/tag. Throws on tag mismatch
// (wrong passphrase or tampered ciphertext) — the GCM final() rejects.
export async function decryptFile({ srcPath, destPath, passphrase, saltB64, ivB64, tagB64 }) {
  const salt = Buffer.from(saltB64, 'base64')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  await pipeline(createReadStream(srcPath), decipher, createWriteStream(destPath, { mode: 0o600 }))
}
