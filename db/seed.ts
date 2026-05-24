import { db, pool } from './client-node'
import { users, settings } from './schema'
import { hashPassword } from '../lib/auth/scrypt'
import {
  seedAboutPageBlocksIfEmpty,
  seedContactPageBlocksIfEmpty,
  seedHomePageBlocksIfEmpty,
  seedPrivacyPageBlocksIfEmpty,
  seedProjectsPageBlocksIfEmpty,
  seedServicesPageBlocksIfEmpty,
  seedTermsPageBlocksIfEmpty,
  seedTheKharisPageBlocksIfEmpty,
  seedMantebeaGardensPageBlocksIfEmpty,
  seedAnowaaGardensPageBlocksIfEmpty,
  seedThankYouEnquiryPageBlocksIfEmpty,
  seedThankYouTourPageBlocksIfEmpty,
  seedThankYouBrochurePageBlocksIfEmpty,
} from './seeds/systemPageBlocks'

export async function seedAdminIfEmpty(
  email: string,
  name: string,
  password: string,
): Promise<boolean> {
  const existing = await db.select({ id: users.id }).from(users).limit(1)
  if (existing.length > 0) return false
  const passwordHash = await hashPassword(password)
  await db.insert(users).values({
    email,
    name,
    role: 'admin',
    active: true,
    mustRotatePassword: true,
    passwordHash,
  })
  return true
}

// Settings defaults. Idempotent: each key INSERT IGNOREs if already
// present (the `settings` PK is the key itself). Safe to re-run on
// every deploy — admin /admin/settings PATCH overrides take precedence
// because the seed only inserts when missing.
//
// Pulls from settings-registry so any newly-added key gets a row on
// the next deploy without touching this file. A handful of project-
// specific overrides (real contact info, footer tagline) sit on top
// so a fresh BWC install isn't generic out of the box.
import { registry } from '@/lib/cms/settings-registry'

const PROJECT_OVERRIDES: Partial<Record<keyof typeof registry, unknown>> = {
  contact_info: {
    phone: '+233 24 297 7639',
    email: 'info@bestworldcompany.com',
    address: 'Nuumo Kofi Anum Link, Okpegon-Ledzokuku, Accra',
    hours: 'Mon-Fri 09:00-17:00',
  },
  default_seo: {
    title: 'Best World Properties',
    description: 'Luxury residential development in Accra, Ghana.',
    ogImagePath: null,
  },
  footer: {
    ...(registry.footer.default as object),
    tagline: 'Building homes that reflect your aspirations.',
  },
}

// Built lazily inside the function so a future registry edit whose
// `default` throws (typo, regex slip, etc.) surfaces inside runCli's
// try/finally — instead of at module-load time, where it would crash
// before the `BWC_SEED_OK=1` production guard or the pool-cleanup
// finally block ever runs.
function buildSettingsDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    (Object.keys(registry) as Array<keyof typeof registry>).map((k) => [
      k,
      PROJECT_OVERRIDES[k] ?? registry[k].default,
    ]),
  )
}

export async function seedSettingsIfEmpty(): Promise<void> {
  const SETTINGS_DEFAULTS = buildSettingsDefaults()
  const rows = await db.select({ key: settings.key }).from(settings)
  const have = new Set(rows.map((r) => r.key))
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    if (!have.has(key)) {
      await db.insert(settings).values({ key, value: value as object })
    }
  }
}

async function readEnvOrPrompt(): Promise<{ email: string; name: string; password: string }> {
  const envEmail = process.env['BWC_ADMIN_EMAIL']
  const envName = process.env['BWC_ADMIN_NAME']
  const envPassword = process.env['BWC_ADMIN_PASSWORD']
  if (envEmail && envName && envPassword) {
    return { email: envEmail.trim().toLowerCase(), name: envName.trim(), password: envPassword }
  }
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const email = (await rl.question('Admin email: ')).trim().toLowerCase()
    const name = (await rl.question('Admin name: ')).trim()
    const password = await readPasswordSilent('Admin password (>=12 chars): ')
    return { email, name, password }
  } finally {
    rl.close()
  }
}

// Read a single line from stdin without echoing characters back to the
// terminal — keeps the bootstrap admin password out of scrollback and any
// `script(1)` recording. Falls back to ordinary readline when stdin isn't a
// TTY (e.g., piped input in CI), which echoes but is the only sensible mode.
async function readPasswordSilent(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  if (!process.stdin.isTTY) {
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try { return await rl.question('') } finally { rl.close() }
  }
  const { StringDecoder } = await import('node:string_decoder')
  const decoder = new StringDecoder('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      // StringDecoder buffers multi-byte chars split across chunks.
      const s = decoder.write(chunk)
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\x03') { // Ctrl-C
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          reject(new Error('aborted'))
          return
        }
        if (ch === '\x7f' || ch === '\b') { // backspace / delete
          if (buf.length > 0) buf = buf.slice(0, -1)
        } else {
          buf += ch
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

async function runCli(): Promise<void> {
  // Production-run gate. The CLI legitimately runs on prod ONCE per
  // server (first-deploy admin bootstrap), but a sysadmin accidentally
  // hitting `pnpm db:seed` against the live DB shouldn't be possible
  // without an explicit opt-in. Defence in depth on top of the
  // table-empty / INSERT-IGNORE guards inside the seed functions.
  // Operator override: BWC_SEED_OK=1 pnpm db:seed
  if (
    process.env['NODE_ENV'] === 'production' &&
    process.env['BWC_SEED_OK'] !== '1'
  ) {
    console.error(
      '[db:seed] refusing to run with NODE_ENV=production without explicit opt-in.',
    )
    console.error(
      '[db:seed]   first-deploy bootstrap: BWC_SEED_OK=1 BWC_ADMIN_EMAIL=… BWC_ADMIN_NAME=… BWC_ADMIN_PASSWORD=… pnpm db:seed',
    )
    process.exit(1)
  }

  try {
    // Skip the admin-credential prompt when an admin user already
    // exists — `pnpm db:seed` should work standalone for the
    // settings-only path without requiring fake bootstrap creds.
    // The admin seed is still gated on table-empty inside
    // seedAdminIfEmpty, so the env/prompt is only needed on a
    // fresh DB. This makes the script idempotent + re-runnable
    // for settings updates without operator input.
    const existing = await db.select({ id: users.id }).from(users).limit(1)
    if (existing.length === 0) {
      const { email, name, password } = await readEnvOrPrompt()
      if (password.length < 12) {
        console.error('password too short (must be >=12 chars)')
        process.exit(1)
      }
      const seeded = await seedAdminIfEmpty(email, name, password)
      console.log(seeded ? `Seeded admin: ${email}` : 'admin seed no-op.')
    } else {
      console.log('Admin user(s) exist; skipping admin prompt.')
    }
    await seedSettingsIfEmpty()
    console.log('Seeded default settings (idempotent).')
    // System-page block seeds. Each call returns the rows inserted on
    // a fresh seed, or `false` when the page already had live blocks.
    // Add new system pages here as their block trees are designed (see
    // db/seeds/systemPageBlocks.ts).
    const homeInserted = await seedHomePageBlocksIfEmpty()
    console.log(
      homeInserted === false
        ? 'Home page already has live blocks — skipped block seed.'
        : `Seeded Home page block tree (${homeInserted} rows).`,
    )
    const aboutInserted = await seedAboutPageBlocksIfEmpty()
    console.log(
      aboutInserted === false
        ? 'About page already has live blocks — skipped block seed.'
        : `Seeded About page block tree (${aboutInserted} rows).`,
    )
    const servicesInserted = await seedServicesPageBlocksIfEmpty()
    console.log(
      servicesInserted === false
        ? 'Services page already has live blocks — skipped block seed.'
        : `Seeded Services page block tree (${servicesInserted} rows).`,
    )
    const projectsInserted = await seedProjectsPageBlocksIfEmpty()
    console.log(
      projectsInserted === false
        ? 'Projects page already has live blocks — skipped block seed.'
        : `Seeded Projects page block tree (${projectsInserted} rows).`,
    )
    const contactInserted = await seedContactPageBlocksIfEmpty()
    console.log(
      contactInserted === false
        ? 'Contact page already has live blocks — skipped block seed.'
        : `Seeded Contact page block tree (${contactInserted} rows).`,
    )
    const privacyInserted = await seedPrivacyPageBlocksIfEmpty()
    console.log(
      privacyInserted === false
        ? 'Privacy page already has live blocks — skipped block seed.'
        : `Seeded Privacy page block tree (${privacyInserted} rows).`,
    )
    const termsInserted = await seedTermsPageBlocksIfEmpty()
    console.log(
      termsInserted === false
        ? 'Terms page already has live blocks — skipped block seed.'
        : `Seeded Terms page block tree (${termsInserted} rows).`,
    )
    const kharisInserted = await seedTheKharisPageBlocksIfEmpty()
    console.log(
      kharisInserted === false
        ? 'The Kharis page already has live blocks — skipped block seed.'
        : `Seeded The Kharis page block tree (${kharisInserted} rows).`,
    )
    const mantebeaInserted = await seedMantebeaGardensPageBlocksIfEmpty()
    console.log(
      mantebeaInserted === false
        ? 'Mantebea Gardens page already has live blocks — skipped block seed.'
        : `Seeded Mantebea Gardens page block tree (${mantebeaInserted} rows).`,
    )
    const anowaaInserted = await seedAnowaaGardensPageBlocksIfEmpty()
    console.log(
      anowaaInserted === false
        ? 'Anowaa Gardens page already has live blocks — skipped block seed.'
        : `Seeded Anowaa Gardens page block tree (${anowaaInserted} rows).`,
    )
    const tyEnquiryInserted = await seedThankYouEnquiryPageBlocksIfEmpty()
    console.log(
      tyEnquiryInserted === false
        ? 'Thank-you enquiry page already has live blocks — skipped block seed.'
        : `Seeded thank-you enquiry page block tree (${tyEnquiryInserted} rows).`,
    )
    const tyTourInserted = await seedThankYouTourPageBlocksIfEmpty()
    console.log(
      tyTourInserted === false
        ? 'Thank-you tour page already has live blocks — skipped block seed.'
        : `Seeded thank-you tour page block tree (${tyTourInserted} rows).`,
    )
    const tyBrochureInserted = await seedThankYouBrochurePageBlocksIfEmpty()
    console.log(
      tyBrochureInserted === false
        ? 'Thank-you brochure page already has live blocks — skipped block seed.'
        : `Seeded thank-you brochure page block tree (${tyBrochureInserted} rows).`,
    )
  } finally {
    await pool.end()
  }
}

// Robust main-module detection — `file://${process.argv[1]}` only works on
// POSIX with absolute argv. fileURLToPath handles Windows + URL escaping.
async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false
  const { fileURLToPath } = await import('node:url')
  return fileURLToPath(import.meta.url) === process.argv[1]
}
if (await isMainModule()) {
  await runCli()
}
