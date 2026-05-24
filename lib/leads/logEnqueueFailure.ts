import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// Shared best-effort logger for lead-route enqueueEmail failures.
// The lead row is already committed by the time this fires — the
// notification is a forensic marker, not a replay queue (operator
// must manually re-trigger). Payload stores a SHA-256 of the email
// rather than the plaintext to keep newsletter_subscribers /
// leads as the single retention-policy-governed PII store.
//
// `source` identifies which template failed: 'contact:sales',
// 'contact:auto_reply', 'brochure:sales', 'brochure:delivery',
// 'inquiry:sales', 'inquiry:auto_reply', 'newsletter:confirm'.
export async function logEnqueueFailure(
  source: string,
  email: string,
  err: unknown,
): Promise<void> {
  const emailHash = createHash('sha256').update(email).digest('hex')
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'lead_email_enqueue_failed',
      source,
      email_sha256: emailHash,
      err: err instanceof Error ? err.message : String(err),
    }),
  )
  // notification_failures is a forensic ledger here (no automated
  // replay for this kind — `lead_email_enqueue_failed`). Operator
  // queries by source + email_sha256 to correlate against the
  // leads / newsletter_subscribers row, then manually re-runs the
  // email if recovery is desired. Best-effort INSERT — if even
  // this fails, the console.error above is the audit trail.
  await db
    .execute(sql`
      INSERT INTO notification_failures (kind, payload, attempts, next_retry_at)
      VALUES (
        'lead_email_enqueue_failed',
        ${JSON.stringify({ source, email_sha256: emailHash })},
        0,
        NOW(3)
      )
    `)
    .catch(() => {})
}
