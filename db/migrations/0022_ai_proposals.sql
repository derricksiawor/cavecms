-- Migration 0022 — AI proposal ledger
--
-- Backs the AI writing partner: every proposal that Gemini returns
-- (inline sparkle or Page Assistant chatbot) lands here in a `pending`
-- state until the operator clicks Apply (→ accepted) or Dismiss (→
-- dismissed), or until the sweeper marks it `expired` 30 min after
-- creation.
--
-- The changeset column carries the validated, sanitized array of ops
-- the AI proposed:
--   [{ op: 'edit'|'insert'|'delete'|'reorder', blockId?, parentId?,
--      position?, blockType?, data?, meta? }, ...]
-- Already parsed by lib/cms/parse.ts (parseAndSanitize) at propose-time;
-- runs again at apply-time as defence-in-depth. No DDL constraint
-- attempts to validate the shape here — Zod is the authority.
--
-- FK shape (mirrors the Drizzle schema in db/schema/ai.ts):
--   user_id ON DELETE SET NULL — preserve the audit trail when a user
--     is deactivated; the proposal still records what was asked for,
--     just not by whom.
--   page_id ON DELETE CASCADE — a proposal pointing at a deleted page
--     can never apply, drop the row.
--
-- Indexes:
--   uniq_ai_proposals_token         token lookup on /apply + /dismiss
--   idx_ai_proposals_user_status_created   user dashboard ordering
--   idx_ai_proposals_page_status    "any pending proposals for this
--                                    page?" used by the inline-edit
--                                    chrome to surface in-flight
--                                    previews
--   idx_ai_proposals_expires        sweeper: WHERE status='pending'
--                                    AND expires_at < NOW()
--
-- IF NOT EXISTS guard keeps the migration idempotent against ledger
-- re-runs (production-grade — same pattern as 0012 / 0021).

CREATE TABLE IF NOT EXISTS ai_proposals (
  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token        VARCHAR(64) NOT NULL,
  user_id      INT NULL,
  page_id      INT NOT NULL,
  surface      VARCHAR(20) NOT NULL,
  prompt       VARCHAR(2000) NOT NULL,
  changeset    JSON NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  model         VARCHAR(60) NOT NULL,
  -- `tokens_usage` (not `usage`) — `USAGE` is a MySQL reserved word
  -- used by GRANT USAGE syntax; raw SQL queries would parse on MariaDB
  -- but fail on stricter MySQL parsers. Avoid the footgun.
  tokens_usage  JSON NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   TIMESTAMP(3) NOT NULL,
  applied_at   TIMESTAMP(3) NULL,
  CONSTRAINT uniq_ai_proposals_token UNIQUE (token),
  CONSTRAINT fk_ai_proposals_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_proposals_page
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  INDEX idx_ai_proposals_user_status_created (user_id, status, created_at),
  INDEX idx_ai_proposals_page_status (page_id, status),
  INDEX idx_ai_proposals_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
