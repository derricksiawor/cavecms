import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  encryptFile,
  decryptFile,
} from '../../../scripts/backup/cloud/passphraseCipher.mjs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-cipher-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('passphraseCipher', () => {
  it('round-trips a file: encrypt then decrypt yields the original bytes', async () => {
    const src = join(dir, 'plain.bin')
    const enc = join(dir, 'cipher.bin')
    const dec = join(dir, 'out.bin')
    const data = randomBytes(200_000) // ~200 KB, multiple stream chunks
    writeFileSync(src, data)

    const meta = await encryptFile({ srcPath: src, destPath: enc, passphrase: 'correct horse battery' })
    expect(meta.saltB64).toBeTruthy()
    expect(meta.ivB64).toBeTruthy()
    expect(meta.tagB64).toBeTruthy()
    // Ciphertext is not the plaintext.
    expect(readFileSync(enc).equals(data)).toBe(false)
    expect(statSync(enc).size).toBe(data.length) // GCM is a stream cipher: same length

    await decryptFile({
      srcPath: enc,
      destPath: dec,
      passphrase: 'correct horse battery',
      saltB64: meta.saltB64,
      ivB64: meta.ivB64,
      tagB64: meta.tagB64,
    })
    expect(readFileSync(dec).equals(data)).toBe(true)
  })

  it('fails decryption with the wrong passphrase (GCM tag mismatch)', async () => {
    const src = join(dir, 'plain.bin')
    const enc = join(dir, 'cipher.bin')
    const dec = join(dir, 'out.bin')
    writeFileSync(src, randomBytes(50_000))
    const meta = await encryptFile({ srcPath: src, destPath: enc, passphrase: 'right' })
    await expect(
      decryptFile({
        srcPath: enc,
        destPath: dec,
        passphrase: 'wrong',
        saltB64: meta.saltB64,
        ivB64: meta.ivB64,
        tagB64: meta.tagB64,
      }),
    ).rejects.toThrow()
  })

  it('fails decryption when the ciphertext is tampered', async () => {
    const src = join(dir, 'plain.bin')
    const enc = join(dir, 'cipher.bin')
    const dec = join(dir, 'out.bin')
    writeFileSync(src, randomBytes(50_000))
    const meta = await encryptFile({ srcPath: src, destPath: enc, passphrase: 'pw' })
    // Flip a byte in the ciphertext.
    const buf = readFileSync(enc)
    buf[100] = buf[100]! ^ 0xff
    writeFileSync(enc, buf)
    await expect(
      decryptFile({
        srcPath: enc,
        destPath: dec,
        passphrase: 'pw',
        saltB64: meta.saltB64,
        ivB64: meta.ivB64,
        tagB64: meta.tagB64,
      }),
    ).rejects.toThrow()
  })
})
