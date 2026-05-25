# Best World Properties — Website Rebuild Design

**Project:** Rebuild bestworldcompany.com in Next.js with a self-hosted CMS
**Date:** 2026-05-10
**Status:** Design v2 (post-review) — awaiting implementation plan

---

## 1. Purpose & scope

Best World Properties is a luxury residential developer in Accra, Ghana with three named projects (The Kharis, Mantebea Gardens, Anowaa Gardens). The current site is template-corrupted with hotel/hospitality content bleeding in.

This rebuild delivers a clean Next.js marketing site plus a CMS that lets the client edit all visible content, manage projects, capture leads, and run a small blog — without dev intervention after handover.

**In scope**
- Public marketing site: Home, About, Services, Contact, Projects index, Project detail, Blog index, Blog post
- CMS with three roles (Admin / Editor / Viewer) and field-level authorization
- Inline click-to-edit on the live site for all marketing content
- Project CRUD (10 section types per project)
- Lead capture for contact, brochure request, project inquiry, newsletter
- Team management
- Blog/News
- SEO (sitemap.xml, JSON-LD, OG tags)
- Self-hosted on the user's existing DigitalOcean droplet alongside other apps

**Out of scope**
- Email infrastructure (handled manually outside this project; app reads SMTP config from `.env.local`)
- Multi-language (English only)
- Analytics (no Plausible / GA / similar)
- Newsletter campaign editor (subscribers are stored only)
- Payments / online unit reservations
- Property listing search / portal features (this is a developer, not a brokerage)
- Drafts, scheduled publishing, revision history UI
- Real-time collaborative editing

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Framework | Next.js 15.5.4, React 19.1.0, TypeScript strict mode |
| Database | MariaDB (native, shared with other apps on the droplet) |
| ORM / migrations | Drizzle ORM + drizzle-kit; generated SQL committed |
| Auth | jose (HS256, iss/aud/jti/nbf/iat/exp, 8h, sliding renewal), scrypt password hashing with versioned cost, timingSafeEqual compare |
| Editing UX | Inline click-to-edit on live site + side drawer with structured form + small `/admin` dashboard for non-visual things |
| Roles | Admin (full) / Editor (content + leads) / Viewer (leads read-only, PII-masked) |
| Hosting | User's existing DigitalOcean droplet, PM2 single-instance fork mode + nginx + native MariaDB, port 3040 (loopback-only) |
| Build location | **CI builds** (`.next/standalone` artifact). Deploy ships the prebuilt artifact via rsync — never `pnpm build` on the droplet. |
| Media | Local `/opt/cavecms/uploads` (chmod 750, owned by app user), `public/uploads` is a symlink, `sharp` generates thumb/md/lg/og variants on upload, atomic temp+rename pipeline |
| Forms / leads | DB-first commit, response returned immediately; SMTP via in-process queue with retry + circuit breaker |
| Email | SMTP via env vars; app uses nodemailer. Email infrastructure setup is out of scope. |
| Languages | English only |
| Extras | Blog/News section, SEO (sitemap + JSON-LD + OG). No analytics, no campaign editor. |
| Branding | Reverse-engineered from current bestworldcompany.com; tokens captured in `lib/theme/tokens.ts`. |
| Rendering | ISR with on-demand `revalidateTag` invalidation on CMS save, formal tag taxonomy |
| Content model | Two tables (`content_blocks`, `project_sections`) sharing one helper library; JSON `data` validated by Zod **on every read and write** |
| Cutover | `staging.bestworldcompany.com` behind nginx IP-allowlist + basic auth + noindex → DNS flip on approval |

---

## 3. System topology

Shared droplet — CaveCMS piggybacks on existing nginx and native MariaDB. Email delivery is handled by the user manually outside this project; the app only reads SMTP env vars and sends with nodemailer.

```
[Browser]
   │ HTTPS (port 80→443 redirect; www→apex 301)
[Cloudflare DNS]   bestworldcompany.com (apex), staging.bestworldcompany.com
   │
[DigitalOcean droplet — shared with other apps, Ubuntu, UFW firewalled]
   │
   ├─ nginx (existing)
   │     Server blocks added by setup.sh:
   │       apex on 443 → reverse-proxy to 127.0.0.1:3040 for / and /api/*
   │                  → direct alias for /_next/static (1y immutable)
   │                  → direct alias for /uploads/* (30d cache)
   │                  → location /api/auth/login { access_log off; ... }
   │                  → location <LOGIN_PATH> { access_log off; ... }
   │       staging on 443 → IP-allowlist + basic auth, X-Robots-Tag: noindex
   │     proxy_set_header X-Forwarded-For $remote_addr (overwrite, not append)
   │     proxy_set_header X-Real-IP $remote_addr
   │     Let's Encrypt cert via certbot, systemd certbot.timer enabled
   │     /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh installed
   │
   ├─ PM2 (single fork instance) → Next.js on 127.0.0.1:3040 (loopback ONLY — UFW blocks 3040 publicly)
   │     Process user: `cavecms` (system account, no shell)
   │     Reads X-Real-IP only when req.socket.remoteAddress === '127.0.0.1'
   │     ecosystem.config.cjs: kill_timeout: 8000, listen_timeout: 8000,
   │                            wait_ready: true, max_memory_restart: '512M',
   │                            max_restarts: 10, min_uptime: 60_000,
   │                            env_file: /etc/cavecms/env.<env>  (symlinked into release)
   │     UV_THREADPOOL_SIZE=8 (sharp), NODE_OPTIONS='--max-old-space-size=1024'
   │
   ├─ MariaDB (existing, native systemd service)
   │     DB `cavecms`, user `cavecms_user` GRANTED: SELECT/INSERT/UPDATE/DELETE/INDEX/CREATE/ALTER/REFERENCES ON cavecms.*
   │     Migrations user `cavecms_migrator` separate (above + DROP) — used only by deploy
   │     time_zone = '+00:00' (UTC) on the connection
   │
   ├─ /opt/cavecms/                              (chown cavecms:cavecms, chmod 750)
   │     releases/<git-sha>/                 (prebuilt artifact from CI, last 5 kept)
   │     current → releases/<sha>            (atomic symlink; rollback = retarget)
   │     uploads/originals/                  (immutable post-write)
   │     uploads/variants/                   (sharp output: thumb/md/lg/og)
   │     uploads/brochures-private/          (NOT served by nginx; only via /api/brochure)
   │     uploads/.tmp/                       (sharp temp; cleared on boot)
   │
   ├─ /backup/cavecms/  (chown cavecms:backup, chmod 750, encrypted at rest via age)
   │     db/<date>.sql.age                   (mysqldump | gzip | age -r <pub>; 30d retention)
   │     uploads/                             (rsync; 7d retention)
   │     pre-deploy/<sha>.sql.age            (pre-migration snapshot per deploy)
   │
   └─ /etc/cavecms/
         env.production                      (chmod 600 root:cavecms, symlinked into current release)
         env.staging                         (same)
         backup.env                          (chmod 600 root:root — age public key only)
```

**Setup script** (`scripts/setup.sh`, run once per box) — creates the `cavecms` system user, the DB + both DB users, drops nginx server blocks (validates with `nginx -t` before reload), issues Let's Encrypt cert with `--keep-until-expiring`, installs systemd timers and certbot deploy hook, mkdirs uploads + backup directories with correct ownership and permissions, prompts for and validates `LOGIN_PATH` against `^[a-z0-9-]{6,32}$`, installs `pm2-logrotate` and `pm2 startup systemd` unit, configures `nginx log_format ... escape=json` for safe log injection, sets a UFW rule denying public access to 3040.

**Deploy script** (`scripts/deploy.sh`, every push) — runs under `flock -n /var/lock/cavecms-deploy.lock`. Steps: (1) preflight — disk ≥ 2 GB free, MariaDB reachable, current `/healthz` 200 (skipped on first deploy), (2) rsync prebuilt CI artifact into `/opt/cavecms/releases/<sha>/`, (3) symlink the env file from `/etc/cavecms/`, (4) DB snapshot to `/backup/cavecms/pre-deploy/<sha>.sql.age`, (5) run forward migrations via `cavecms_migrator` user, (6) atomic `ln -sfn` of `current → releases/<sha>`, (7) `pm2 startOrReload ecosystem.config.cjs --update-env`, (8) poll `/healthz` up to 30 s before declaring success, (9) on any failure revert the symlink, restart PM2, optionally restore the DB snapshot (manual confirmation for the restore step).

**`pnpm dev`** locally — predev hook verifies MariaDB is reachable, runs migrations, seeds initial admin if `users` is empty (reads `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_NAME` / `INITIAL_ADMIN_PASSWORD` from `.env.local`; marks the row `must_rotate_password = true`), starts Next.js on port 3040.

All shell scripts begin with `set -euo pipefail; IFS=$'\n\t'` and a `trap 'echo "FAIL at line $LINENO"' ERR`. No `sed`. No `eval`. All variable expansions double-quoted. mysqldump credentials read from `/root/.cavecms-backup.cnf` (chmod 600) `[client]` block — never on the command line.

---

## 4. Routes

### Public (ISR-cached with explicit tags; cache headers per route)

| Route | Cache tag | Cache-Control |
|---|---|---|
| `/` | `page:home`, `featured-projects`, `settings` | `public, s-maxage=600, stale-while-revalidate=86400` |
| `/about` | `page:about`, `team`, `settings` | same |
| `/services` | `page:services`, `settings` | same |
| `/contact` | `page:contact`, `settings` | same |
| `/projects` | `projects-index`, `settings` | same |
| `/projects/[slug]` | `project:<slug>`, `settings` | same |
| `/blog` | `posts-index`, `settings` | same |
| `/blog/[slug]` | `post:<slug>`, `settings` | same |
| `/sitemap.xml` | `sitemap` | `public, s-maxage=3600, stale-while-revalidate=86400` |
| `/robots.txt` | `robots` (dynamic per host) | `public, s-maxage=3600` |
| `/unsubscribe?token=…` | none (dynamic) | `no-store` |
| `/api/brochure/[token]` | none (signed token) | `private, no-store` |
| `/healthz` | none | `no-store` |

### API

```
# Auth
GET  /[LOGIN_PATH]                     Login page (no <Link> ever points here; access_log off)
POST /api/auth/login                   Rate-limited; pre-auth CSRF cookie required
POST /api/auth/logout                  CSRF + session required; bumps users.tokens_valid_after
GET  /api/csrf                         Returns session-bound CSRF token + cookie

# CMS — admin/editor only, CSRF required, field-level Zod per role
PATCH  /api/cms/blocks/[id]            Update typed block (optimistic lock)
POST   /api/cms/blocks                 Create freeform tail block on a page
DELETE /api/cms/blocks/[id]            Soft delete (deleted_at)
POST   /api/cms/blocks/reorder         Single-TX batch position update with per-row version
POST   /api/cms/media                  Multipart upload, MIME sniff, sharp variants (semaphore-gated)
GET    /api/cms/media                  Paginated library
DELETE /api/cms/media/[id]             Admin only; soft delete, hardened by media_references table
POST   /api/cms/projects               Admin only
PATCH  /api/cms/projects/[id]          Field-level RBAC (Editor schema vs Admin schema)
PATCH  /api/cms/projects/[id]/sections/[sectionId]   Project section update with optimistic lock
DELETE /api/cms/projects/[id]          Admin only — soft delete (deleted_at), not hard delete
POST   /api/cms/projects/reorder       Admin+Editor; single-TX
POST   /api/cms/projects/[id]/preview-token   Admin+Editor; signs PREVIEW JWT with project pinned
CRUD  /api/cms/posts/*                 Admin+Editor; Editor field-level schema
CRUD  /api/cms/team/*                  Admin+Editor
POST  /api/cms/blocks/[id]/restore     Restore soft-deleted block (Admin+Editor)

# Leads — public POSTs; honeypot + reCAPTCHA + rate limit + pre-auth CSRF
POST /api/leads/contact
POST /api/leads/brochure               Returns the brochure token URL via auto-reply email (queued)
POST /api/leads/inquiry                Pre-tagged with project_id
POST /api/leads/newsletter             Idempotent (ON DUPLICATE KEY)

# Admin
GET    /api/admin/leads                Admin/Editor (full PII); Viewer (masked PII)
GET    /api/admin/leads/[id]           Admin/Editor only (403 for Viewer)
PATCH  /api/admin/leads/[id]           Admin/Editor; enforced state-machine transitions
GET    /api/admin/leads/export.csv     Admin/Editor; streaming response
CRUD   /api/admin/users/*              Admin only; last-admin invariant + no-self-demote
GET    /api/admin/audit-log            Admin only; cursor-paginated
GET    /api/admin/trash                Admin+Editor; lists soft-deleted recoverable items
GET    /api/admin/settings             Admin only
PATCH  /api/admin/settings             Admin only; Zod-validated against settings key registry
```

### Admin (auth-gated; unauthenticated → 307 `/`; never link to LOGIN_PATH)

```
/[LOGIN_PATH]              Hidden login (env-var path; layout has no shared footer/header; no external assets)
/admin                     Dashboard: leads-this-week, recent edits, quick links
/admin/projects            Table: name, status, featured order, published toggle, drag-reorder
/admin/leads               Inbox: filter by source/status/date, drawer detail, status transitions
/admin/team                List: drag-reorder, add/edit/hide
/admin/blog                Post list + markdown editor with live preview
/admin/users               Admin only
/admin/settings            Global settings (typed by key registry)
/admin/activity            Audit log (cursor pagination, filters)
/admin/trash               Soft-deleted items (restore / hard-delete after 30d)
/admin/help                Handover docs (Loom + written runbook)
```

---

## 5. Content model & MariaDB schema

### Boundary rule

Every read and write of any JSON column (`content_blocks.data`, `project_sections.data`, `media.variants`, `audit_log.diff`, `settings.value`) goes through `lib/cms/parse.ts` — Zod parse on read, Zod parse + DOMPurify sanitize on write, **with no exceptions** including migrations. Raw SQL touching these columns outside the helper is forbidden by convention and by a Vitest contract test that greps the codebase.

### Tables (full column list)

```sql
-- pages: roots for marketing pages (4 rows)
pages (
  id INT PK,
  slug VARCHAR(50) UNIQUE NOT NULL,        -- home|about|services|contact
  seo_title VARCHAR(180),
  seo_description VARCHAR(320),
  og_image_id INT NULL → media(id) ON DELETE SET NULL,
  version INT NOT NULL DEFAULT 0,
  updated_by INT NULL → users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)

content_blocks (
  id INT PK AUTO_INCREMENT,
  page_id INT NOT NULL → pages(id) ON DELETE CASCADE,
  block_key VARCHAR(50) NULL,              -- 'hero', 'featured_projects' etc; NULL for freeform
  block_type VARCHAR(50) NOT NULL,
  position INT NOT NULL,
  data JSON NOT NULL,
  version INT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMP NULL,
  updated_by INT NULL → users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_blocks_page (page_id, position),
  INDEX idx_blocks_deleted (deleted_at),
  -- Partial uniqueness: only ONE 'hero' (etc.) per page. MariaDB allows multiple NULLs in a UNIQUE
  -- index, so NULL block_key (freeform) rows don't conflict; fixed-key duplicates are rejected.
  UNIQUE idx_blocks_page_key (page_id, block_key)
)

projects (
  id INT PK AUTO_INCREMENT,
  slug VARCHAR(120) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  tagline VARCHAR(220),
  status ENUM('coming_soon','under_construction','selling','sold_out') NOT NULL,
  location VARCHAR(180),
  hero_image_id INT NULL → media(id) ON DELETE SET NULL,
  brochure_pdf_id INT NULL → media(id) ON DELETE SET NULL,
  featured_order INT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMP NULL,             -- set on first false→true transition, sticky
  seo_title VARCHAR(180),
  seo_description VARCHAR(320),
  og_image_id INT NULL → media(id) ON DELETE SET NULL,
  preview_epoch INT NOT NULL DEFAULT 0,    -- bump to revoke outstanding preview tokens
  version INT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMP NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE idx_projects_slug (slug),
  INDEX idx_projects_published (published, featured_order),
  INDEX idx_projects_deleted (deleted_at)
)

project_sections (
  id INT PK AUTO_INCREMENT,
  project_id INT NOT NULL → projects(id) ON DELETE CASCADE,
  section_key ENUM(
    'hero', 'gallery', 'floor_plans', 'pricing', 'amenities', 'location',
    'brochure', 'timeline', 'testimonials', 'inquiry'
  ) NOT NULL,
  position INT NOT NULL,
  data JSON NOT NULL,
  version INT NOT NULL DEFAULT 0,
  updated_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE idx_psecs_project_key (project_id, section_key),
  INDEX idx_psecs_project (project_id, position)
)

posts (
  id INT PK AUTO_INCREMENT,
  slug VARCHAR(140) UNIQUE NOT NULL,
  title VARCHAR(220) NOT NULL,
  excerpt VARCHAR(320),
  body_md MEDIUMTEXT NOT NULL,
  hero_image_id INT NULL → media(id) ON DELETE SET NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMP NULL,
  author_id INT NULL → users(id) ON DELETE SET NULL,
  seo_title VARCHAR(180),
  seo_description VARCHAR(320),
  og_image_id INT NULL → media(id) ON DELETE SET NULL,
  version INT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE idx_posts_slug (slug),
  INDEX idx_posts_published (published, published_at DESC)
)

team_members (
  id INT PK AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  role VARCHAR(120),
  bio_md TEXT,
  photo_id INT NULL → media(id) ON DELETE SET NULL,
  position INT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)

media (
  id INT PK AUTO_INCREMENT,
  filename_uuid VARCHAR(40) UNIQUE NOT NULL,   -- v4 UUID, no extension exposure
  original_name VARCHAR(255),
  mime_type VARCHAR(80) NOT NULL,              -- from magic-byte sniff
  alt_text VARCHAR(320) NOT NULL,              -- required at upload time
  width INT NULL,
  height INT NULL,
  byte_size INT NOT NULL,
  variants JSON NULL,                          -- {thumb,md,lg,og} URLs; NULL = still processing
  uploaded_by INT NULL → users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_media_deleted (deleted_at)
)

-- Reverse-index for O(1) "is this media referenced?" check.
-- Maintained transactionally by lib/cms/save.ts on every block/section/typed-FK save.
media_references (
  media_id INT NOT NULL → media(id) ON DELETE CASCADE,
  referent_type ENUM('content_block','project_section','project','post','team_member','page','settings') NOT NULL,
  referent_id INT NOT NULL,
  field VARCHAR(200) NOT NULL,            -- canonical path: typed FK = column name (e.g. 'hero_image_id');
                                          -- JSON = dot-path with array indices (e.g. 'data.unit_types[3].image.media_id')
                                          -- lib/cms/save.ts MUST produce the same path for the same logical reference
                                          -- on every save (sorted array indices, no leading $., no whitespace)
  PRIMARY KEY (media_id, referent_type, referent_id, field)
)

leads (
  id INT PK AUTO_INCREMENT,
  source ENUM('contact','brochure','inquiry') NOT NULL,    -- newsletter writes ONLY to newsletter_subscribers
  name VARCHAR(180),
  email VARCHAR(180),
  phone VARCHAR(40),
  message TEXT,
  project_id INT NULL → projects(id) ON DELETE SET NULL,
  status ENUM('new','contacted','won','lost') NOT NULL DEFAULT 'new',
  notes TEXT,                            -- internal admin notes
  brochure_token_used_at TIMESTAMP NULL,
  ip VARCHAR(45),
  user_agent VARCHAR(255),
  status_changed_at TIMESTAMP NULL,
  status_changed_by INT NULL → users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leads_status_created (status, created_at DESC),
  INDEX idx_leads_source (source),
  INDEX idx_leads_created (created_at DESC),
  INDEX idx_leads_source_status_created (source, status, created_at DESC, id DESC)
)

newsletter_subscribers (
  id INT PK AUTO_INCREMENT,
  email VARCHAR(180) UNIQUE NOT NULL,
  status ENUM('active','unsubscribed') NOT NULL DEFAULT 'active',
  unsubscribe_token VARCHAR(64) UNIQUE NOT NULL,   -- crypto.randomBytes(32).toString('base64url')
  source VARCHAR(40),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)

users (
  id INT PK AUTO_INCREMENT,
  email VARCHAR(180) UNIQUE NOT NULL,
  password_hash VARCHAR(400) NOT NULL,             -- "scrypt$N=131072$r=8$p=1$<salt>$<hash>"
  role ENUM('admin','editor','viewer') NOT NULL,
  name VARCHAR(180),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_rotate_password BOOLEAN NOT NULL DEFAULT FALSE,
  tokens_valid_after TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- invalidates JWTs issued before
  password_changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  failed_login_count INT NOT NULL DEFAULT 0,       -- legacy counter, advisory only
  locked_until TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE idx_users_email (email)
)

failed_logins_by_email (
  email VARCHAR(180) PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TIMESTAMP NULL
)
failed_logins_by_ip (
  ip VARCHAR(45) PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  distinct_emails_24h INT NOT NULL DEFAULT 0,      -- credential-spray detector
  last_failure_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TIMESTAMP NULL
)
login_attempts (                                   -- audit trail; not used for rate-limit math
  id INT PK AUTO_INCREMENT,
  email VARCHAR(180),
  ip VARCHAR(45),
  user_agent VARCHAR(255),
  success BOOLEAN NOT NULL,
  failure_reason VARCHAR(60),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attempts_email_created (success, email, created_at DESC),
  INDEX idx_attempts_ip_created    (success, ip,    created_at DESC),
  INDEX idx_attempts_created       (created_at)
)

audit_log (
  id BIGINT PK AUTO_INCREMENT,
  user_id INT NULL → users(id) ON DELETE SET NULL,
  action VARCHAR(40) NOT NULL,                     -- 'create'|'update'|'delete'|'restore'|'login_success'|'login_failure'|'logout'|'lockout'|'role_change'|'deactivate'|'csrf_reject'|'status_change'
  resource_type VARCHAR(40) NOT NULL,              -- 'content_block'|'project'|'lead'|'auth'|...
  resource_id VARCHAR(60) NULL,
  diff JSON NULL,                                  -- field-level patch: {field: {from, to}} or {snapshot: {...}} on delete
  ip VARCHAR(45),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at DESC),
  INDEX idx_audit_user_created (user_id, created_at DESC),
  INDEX idx_audit_resource (resource_type, resource_id, created_at DESC),
  INDEX idx_audit_action (action, created_at DESC)
)

slug_redirects (
  id INT PK AUTO_INCREMENT,
  resource_type ENUM('project','post') NOT NULL,
  old_slug VARCHAR(140) NOT NULL,
  new_slug VARCHAR(140) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE idx_redir (resource_type, old_slug)
)

notification_failures (
  id INT PK AUTO_INCREMENT,
  kind ENUM('smtp_send','recaptcha_degraded','revalidate_failed','unhandled_rejection','rbac_field_reject') NOT NULL,
  ref_table VARCHAR(40) NULL,
  ref_id INT NULL,
  payload JSON NULL,             -- e.g., revalidate tag name; email envelope; etc.
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TIMESTAMP NULL,
  resolved_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_kind_pending (kind, resolved_at, next_retry_at)
)

pending_emails (                  -- enqueued-on-creation, NOT only-on-failure
  id INT PK AUTO_INCREMENT,
  to_email VARCHAR(180) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  html_body MEDIUMTEXT NOT NULL,
  text_body TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pending_emails_due (resolved_at, next_retry_at)
)

user_known_ips (                  -- per-user trusted source IPs for lockout-DoS mitigation
  user_id INT NOT NULL → users(id) ON DELETE CASCADE,
  ip VARCHAR(45) NOT NULL,
  last_success_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, ip)
)

schema_fingerprint (              -- single-row; the deployed schema hash, set by migrations
  id TINYINT PK,
  fingerprint CHAR(64) NOT NULL,  -- sha256 of canonical information_schema for our tables
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)

settings (
  `key` VARCHAR(60) PRIMARY KEY,                  -- restricted to registry (see below)
  value JSON NOT NULL,                            -- Zod-validated per key
  version INT NOT NULL DEFAULT 0,                 -- optimistic lock
  updated_by INT NULL → users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
```

All TIMESTAMP columns are UTC (`time_zone='+00:00'`). Display layer renders in `Africa/Accra` via `Intl.DateTimeFormat`.

### Naming conventions

- Enum string values are lowercase snake_case (DB); UI displays TitleCase.
- "Make it go away" patterns:
  - **`deleted_at`** on `content_blocks`, `projects`, `posts`, `media` — recoverable for 30 days, then hard-deleted by nightly cron.
  - **`published` toggle only** on `team_members` (small list, never deleted in practice).
  - **Newsletter `status` enum** on subscribers (`active|unsubscribed`).
- `seo_*` triplet expanded once: `seo_title VARCHAR(180), seo_description VARCHAR(320), og_image_id INT NULL`.
- `updated_*` expanded once: `updated_by INT NULL → users(id) ON DELETE SET NULL, updated_at TIMESTAMP …`.
- `position` is an integer, spaced by 1000 on initial insert. Reorder API renumbers the entire affected page/project in a single TX.

### Settings keys (v1 registry)

| Key | Zod shape | Used by |
|---|---|---|
| `contact_info` | `{ phone, email, address, hours }` | Contact page, footer, JSON-LD |
| `social_links` | `Array<{ platform, url }>` | Footer |
| `default_seo` | `{ title, description, og_image_id }` | Per-page metadata fallback |
| `footer` | `{ tagline, columns: Array<{ label, links: Array<{ text, href }> }> }` | Layout footer |
| `organization_json_ld` | `{ name, alt_name?, logo_id, founding_date?, … }` | JSON-LD on every public page |

Loader rejects unknown keys. Admin UI iterates this registry to render the form.

### Block type registry (v1)

| `block_type` | Fixed-or-freeform | Fields (Zod) | Allowed on pages |
|---|---|---|---|
| `hero` | fixed (`block_key='hero'`) | `{ title, subtitle?, image: media_ref, cta?: {text, href, openInNew} }` | home, about, services, contact |
| `services_intro` | fixed | `{ title, body_richtext, items: Array<{ icon?, title, body }> }` | services |
| `featured_projects` | fixed | `{ title?, project_ids: Array<int>, layout: 'grid'\|'carousel' }` | home |
| `about_history` | fixed | `{ title, body_richtext, image?: media_ref }` | about |
| `team_block` | fixed | `{ title?, member_ids?: Array<int>, all: boolean }` | about |
| `cta` | freeform | `{ title, body?, cta: {text, href, openInNew} }` | any |
| `text` | freeform | `{ heading?, body_richtext }` | any |
| `image` | freeform | `{ image: media_ref, caption?, alignment }` | any |
| `gallery` | freeform | `{ images: Array<media_ref & {caption?}>, columns: 2\|3\|4 }` | any |
| `quote` | freeform | `{ quote, attribution?, attribution_title? }` | any |

A `media_ref` is `{ media_id: int, alt: string }` (alt is denormalized for editor convenience but `lib/cms/parse.ts` re-resolves from the media row on read for safety).

### Project section schemas (v1)

Each section_key has one row per project. Schemas in `lib/cms/project-section-schemas.ts`. Each schema includes a `richtext` field where applicable; the renderer applies the same DOMPurify allow-list (`p, br, strong, em, a[href]` + URI allow-list for `https:|mailto:|tel:`).

| `section_key` | Fields |
|---|---|
| `hero` | `{ status_label?, banner_image: media_ref, summary_richtext? }` |
| `gallery` | `{ categories: Array<{ name, images: Array<media_ref & { caption? }> }> }` |
| `floor_plans` | `{ unit_types: Array<{ name, beds, baths, sqft, image: media_ref, description? }> }` |
| `pricing` | `{ display: 'range'\|'per_unit'\|'contact', value_richtext, units_total?, units_remaining? }` |
| `amenities` | `{ items: Array<{ icon, label }> }` |
| `location` | `{ map_embed_url?, address, points_of_interest: Array<{ label, drive_time_min }> }` — `map_embed_url` Zod-refined to start with `https://www.google.com/maps/embed?` (CSP `frame-src` already restricts; refinement is defense in depth) |
| `brochure` | `{ pdf: media_ref \| null, gate_message_richtext? }` |
| `timeline` | `{ entries: Array<{ date, title, body_richtext?, photo?: media_ref }> }` |
| `testimonials` | `{ entries: Array<{ quote, attribution, unit_type? }> }` |
| `inquiry` | `{ heading?, body_richtext? }` (the form itself is hardcoded; this just controls copy) |

### State machines

**`projects.status`** — explicit transition table enforced in the PATCH handler:

| From | Allowed `to` |
|---|---|
| `coming_soon` | `under_construction`, `selling` |
| `under_construction` | `selling`, `sold_out` |
| `selling` | `sold_out` |
| `sold_out` | `selling` (units freed up; reversible) |

No transition back to `coming_soon` (one-way out). Any other transition → 409; reason logged to `audit_log`.

**`leads.status`** — transitions:
```
new → contacted → won
new → contacted → lost
won  → contacted   (Admin only; "reopen")
lost → contacted   (Admin only; "reopen")
```
Reopen requires a `notes` entry; `status_changed_at` + `status_changed_by` updated; audit_log row written.

### What's NOT in schema (deliberately)

- Sessions table — JWT in httpOnly cookie + `tokens_valid_after` revocation signal.
- CSRF tokens persisted — session-bound HMAC, no DB row.
- Tags / categories on posts.
- Multi-author bylines.
- Comments.
- i18n columns.

### Cleanup crons (systemd timers; documented in §11)

- Soft-deleted rows past `SOFT_DELETE_RETENTION_DAYS` → hard delete + audit row.
- `login_attempts` past `LOGIN_ATTEMPTS_RETENTION_DAYS` → delete.
- `audit_log` past `AUDIT_LOG_RETENTION_DAYS` (default 730 = 2y) → delete.
- `notification_failures` AND `pending_emails` resolved past 30 d → delete.
- `media` rows with `deleted_at` past 30 d AND no `media_references` → hard delete inside a TX (`SELECT … FOR UPDATE` on candidate, re-check refs after lock, then DELETE; only after COMMIT do we unlink files; unlink failure logs to `notification_failures` but never crashes the cron).
- **Orphan upload sweep**: `media` rows with `variants IS NULL AND created_at < NOW() - INTERVAL 1 HOUR AND deleted_at IS NULL` → mark `deleted_at = NOW()` (will be hard-deleted by the next pass). Catches uploads whose process crashed between the initial INSERT (variants=NULL) and the final variants UPDATE.
- `slug_redirects` older than 1 year → optionally prune (kept by default — they're tiny).
- `user_known_ips` past 90 d since `last_success_at` → delete (so a stolen-laptop IP doesn't remain trusted forever).

---

## 6. Inline edit mode

### Render paths

Every public page server-component reads the session cookie. If a valid JWT exists with role in `{admin, editor}` AND the user row is active AND `iat ≥ tokens_valid_after`, render with `editable={true}` drilled into each block component. Anonymous renders pure HTML with no edit chrome — ISR-cached, fast.

A separate `editMode` cookie (HMAC-signed, not the session cookie) is on by default for authenticated admins and can be toggled off via the floating "Preview as visitor" pill. The cookie carries no claims; auth is still via the session cookie.

### Block discovery

Page templates declare their `block_type` requirements. Loader query:
```ts
SELECT * FROM content_blocks
WHERE page_id = ? AND deleted_at IS NULL
ORDER BY position
```
Renderer dispatches by `block_type` → component. Missing required blocks render a placeholder card in edit mode ("+ Add Hero"). Freeform tail blocks render after the last fixed block.

(Hydration described in detail later in this section — see "Hydration (N+1 defense)".)

### Edit drawer

Right-side drawer slides in on click. Form is auto-generated from the block's Zod schema. Live preview:
- Form state mirrors into a `useDeferredValue` wrapped store with a 150 ms debounce.
- Heavy blocks (gallery, featured_projects) memoize by `media_id[]` / `project_id[]` array equality.
- Below 768 px, the drawer becomes a full-screen sheet and live preview is **disabled** — preview shows on Save.

Form field types:
- **Plain text** — input / textarea with `maxLength` from Zod.
- **Rich text** — TipTap with marks `p, br, strong, em, a[href]`; on save, server-side DOMPurify with `ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i` and post-hook forcing `rel="noopener noreferrer nofollow"` + `target="_blank"` on every `<a>`.
- **Image** — media picker (library tab + upload tab). Upload is multipart, immediate sharp processing (or async if queue is congested — picker shows a placeholder until `variants` is non-null).
- **Link / CTA** — text + URL (validated) + `openInNew` toggle.
- **Lists** (amenities, services_intro items) — repeater with add/remove/reorder.
- **Project references** (featured_projects) — multi-select picker of published projects.

### Save flow (atomic)

```
Drawer Save →
  PATCH /api/cms/blocks/[id]  with X-CSRF-Token + body {data, expectedVersion} →
    middleware: verify JWT, derive role from DB (not from token claim), enforce route auth
    handler:
      requireRole(['admin','editor']) →
      pick fieldAllowSchema (Editor vs Admin) →
      Zod.parse(body.data) →
      DOMPurify on every rich-text field →
      BEGIN TX →
        SELECT version, page_id FROM content_blocks WHERE id=? FOR UPDATE
        IF version != expectedVersion → ROLLBACK + 409
        UPDATE content_blocks SET data=?, version=version+1, updated_by=?, updated_at=NOW()
        UPSERT media_references rows based on diff(old.data, new.data)
        INSERT INTO audit_log (action='update', resource_type='content_block', diff=fieldPatch)
      COMMIT →
      try { revalidateTag('page:<slug>'); revalidateTag('sitemap'); /* per taxonomy */ }
      catch (e) { log; enqueue retry; do not throw }
      → return { version: newVersion }
```

### Cache tag taxonomy

Single source of truth in `lib/cache/tags.ts`:

| Tag | Invalidated on |
|---|---|
| `page:<slug>` | Save of any block on that page |
| `projects-index` | Project publish toggle, slug change, archive, featured_order change |
| `project:<slug>` | Any project_section save, project header field save, project hero/brochure media swap |
| `featured-projects` | Project publish toggle, featured_order change, project archive, project name/tagline/hero change |
| `posts-index` | Post publish toggle, slug change, archive |
| `post:<slug>` | Post body or metadata save |
| `team` | team_members save / reorder / hide |
| `settings` | settings save (also invalidates **all page tags** + sitemap if footer/contact fields used in JSON-LD changed) |
| `sitemap` | Any publish/unpublish/slug change of project or post |
| `robots` | Settings change that affects robots policy (rare) |

Each save handler imports a `tagsFor(...)` helper that returns the tag list — never invents tags inline. Failures are logged + enqueued in `notification_failures` (kind=`revalidate_failed`) and retried by a background sweeper on next request to that page.

### Reorder / add / delete

- **Add** freeform block: `position = (SELECT COALESCE(MAX(position),0) FROM content_blocks WHERE page_id=? AND deleted_at IS NULL) + 1000`.
- **Reorder**: client sends the new ordered ID list; server renumbers all blocks for that page in a single TX with sequential positions (1000, 2000, …), bumping every row's `version`.
- **Soft delete**: set `deleted_at = NOW()`, bump version, remove `media_references` rows.
- **Restore** (Admin+Editor): `/admin/trash` → click Restore → clear `deleted_at`, re-append to tail position, restore `media_references`, bump version, audit row.

Fixed-schema blocks (those with `block_key IS NOT NULL`) cannot be reordered or deleted via the UI; the DELETE handler rejects on `block_key NOT NULL`.

### Image upload (atomic — DB row first, then atomic rename)

The pipeline guarantees no orphan files even if any step fails:

1. Receive multipart upload (max `MAX_IMAGE_UPLOAD_BYTES` for images, `MAX_PDF_UPLOAD_BYTES` for PDFs — enforced by both the Next.js route handler AND nginx `client_max_body_size 30m`). Plumbing of `req.signal` (AbortSignal) into the semaphore wait, sharp, and any DB call so client disconnect cancels work.
2. Magic-byte sniff via `file-type`; allow-list `image/jpeg|png|webp|avif` and `application/pdf` only. **Reject SVG.** Reject mismatch between declared MIME and sniffed MIME.
3. **Assert same-filesystem invariant** before any write: `fs.statSync('/opt/cavecms/uploads/.tmp').dev === fs.statSync('/opt/cavecms/uploads/originals').dev`. setup.sh enforces all four upload dirs live on one filesystem.
4. **BEGIN TX → INSERT `media` row with `variants = NULL`** (`uploaded_by`, `original_name`, `mime_type`, `byte_size`, `alt_text` from the form). Capture the new `filename_uuid`. COMMIT. (Row is visible in admin "Library" as "Processing…".)
5. Write all variant bytes to `/opt/cavecms/uploads/.tmp/<filename_uuid>/<variant>.<ext>` for images, or `/opt/cavecms/uploads/.tmp/<filename_uuid>.pdf` for PDFs.
6. Sharp (images only): `sharp({ limitInputPixels: 24_000_000 }).rotate().withMetadata({ exif: {} })` — strips EXIF. Generates four variants **serially** (one libvips pipeline at a time per upload to bound RSS), each written to `.tmp/`.
7. `fsync` each file. Verify all expected files present.
8. Atomic `rename(2)` each from `.tmp/` → final paths (`/opt/cavecms/uploads/originals/...`, `/opt/cavecms/uploads/variants/...` or `/opt/cavecms/uploads/brochures-private/...`). All on the same filesystem per step 3.
9. UPDATE the `media` row: `variants = <json>`, audit log entry. COMMIT.
10. `rm -rf` the temp dir.
11. **On any failure between steps 5 and 9**: `rm -rf` temp dir AND any partially-renamed final files (the boot sweeper double-covers). Mark the `media` row as `deleted_at = NOW()` (a separate small TX) so the in-progress row doesn't stay visible. Return 500.

**File mode**: PM2 starts with `umask 027` so newly written files are `640` (owner-rw, group-r). Directories `750`. Group `cavecms` includes `www-data` so nginx can read.

**Concurrency**: server-side semaphore caps in-flight uploads at **1** (single sharp pipeline per process). `UV_THREADPOOL_SIZE=8`, `sharp.concurrency(2)`, `sharp.cache({ memory: 100 })`. PM2 `max_memory_restart: '1024M'` (raised from 512M to give sharp headroom). `NODE_OPTIONS='--max-old-space-size=768'`.

**Cleanup**: a boot sweeper removes ALL `/opt/cavecms/uploads/.tmp/*` directories unconditionally (any leftover is by definition orphaned from a prior process). Weekly `scripts/verify-media-refs.ts` cross-checks `media` rows against on-disk files.

### Hydration (N+1 defense)

Per-page render flow (three-phase, single resolver `lib/cms/hydrate.ts`):
1. Load all blocks for the page (`content_blocks` for marketing pages; `project_sections` for project detail).
2. **Phase 1 — direct refs**: walk Zod-parsed `data` JSON to collect `media_id`, `project_id`, and `team_member_id` references.
3. **Phase 2 — second-wave refs**: if any `project_id` collected, `SELECT id, slug, name, tagline, hero_image_id, og_image_id, status FROM projects WHERE id IN (?) AND published = TRUE AND deleted_at IS NULL`. Collect those `hero_image_id` + `og_image_id` values. If any `team_member_id`, `SELECT id, name, role, photo_id FROM team_members WHERE id IN (?) AND published = TRUE` — collect `photo_id`s.
4. **Phase 3 — single media query**: `SELECT … FROM media WHERE id IN (?)` (NO `deleted_at IS NULL` filter — see below). Union of Phase 1 and Phase 2 ids.
5. Renderer defensively handles missing/`deleted_at`-set media by rendering a placeholder (blank or "[image removed]" alt-text fallback) — never throws. Inline edit chrome surfaces a warning marker on the affected block.
6. **Soft-delete of media is rejected when `media_references` has any row** (handled by `DELETE /api/cms/media/[id]` with 409). This prevents the dangling-ref class entirely; the defensive renderer is the second line of defense.

A page render performs exactly: 1 block query, 0–2 entity queries (projects / team), 1 media query, plus the cached `settings` lookup. Integration test asserts the count for the home page.

### Reorder API contract

```
POST /api/cms/blocks/reorder
Body: { pageId, blocks: Array<{ id, expectedVersion }> }

Server (single TX):
  SELECT id, version FROM content_blocks
    WHERE page_id = ? AND deleted_at IS NULL FOR UPDATE
  If the submitted ID set != current non-deleted set → 409 + drift report
  If any row's version != expectedVersion → 409 + per-row conflicts
  Renumber: UPDATE rows with positions 1000, 2000, … in submitted order; version=version+1
  Broadcast: write an audit_log row and send BroadcastChannel event 'blocks-reordered'
  COMMIT

Response: { blocks: Array<{ id, version }> }
```

The drawer listens for `blocks-reordered`; if it has unsaved changes for any of the listed block_ids, it surfaces the conflict immediately rather than letting the next Save 409 silently.

### Brochure download — atomic single-use

```
GET /api/brochure/[token]

Decode token = base64url(payload).base64url(mac)
Canonical HMAC input: JSON.stringify({v:1, lead_id, project_id, exp}) (length-prefixed,
delimited — collision-free; see lib/auth/brochure.ts canonicalizeBrochureToken()).
Recompute mac and timingSafeEqual against the token's mac (length-checked first).
Check exp > now. Load lead row.

Assert leads.project_id === token.project_id
   AND leads.source === 'brochure'
   AND projects.published = TRUE AND projects.deleted_at IS NULL.
On any mismatch → 410 Gone (generic, no detail).

UPDATE leads
SET brochure_token_used_at = NOW()
WHERE id = ? AND source = 'brochure' AND brochure_token_used_at IS NULL

If affectedRows === 0 → 410 Gone (already used).
Else stream the PDF with Content-Disposition: attachment, Cache-Control: private, no-store, X-Robots-Tag: noindex.
```

Token URL is sent in the brochure auto-reply email; the PDF lives only in `/opt/cavecms/uploads/brochures-private/` (never served by nginx). `BROCHURE_SECRET` rotation invalidates all outstanding tokens immediately.

### Preview links

Admin clicks "Get preview link" on an unpublished project → server signs:
```ts
SignJWT({ resource_type: 'project', resource_id, preview_epoch })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('cavecms.preview').setAudience('cavecms.preview')
  .setSubject(`project:${resource_id}`).setJti(crypto.randomUUID())
  .setIssuedAt().setNotBefore('0s').setExpirationTime('15m')
  .sign(previewSecret)
```
URL: `/projects/the-kharis?preview=<jwt>`.

Verification: `jwtVerify` with `algorithms:['HS256'], issuer, audience, subject (computed)`; also assert `preview_epoch === projects.preview_epoch` (admin can revoke all outstanding tokens by bumping `preview_epoch`); reject if header contains `kid`, `jku`, `jwk`, `x5u`, `x5c`. Preview-rendered pages set `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`, and a `<meta name="robots" content="noindex,nofollow">` tag. Canonical URL strips the `?preview=` query string.

### Dirty drawer state

- On click of another block while dirty → prompt save/discard.
- Auto-save draft to `localStorage` keyed by `block_id + base_version` every 5 s while dirty.
- On drawer mount, if a matching draft exists for the current version, offer recovery.
- `beforeunload` warning when dirty.

### Mid-session JWT expiry

Sliding renewal mechanism specified in §7 (oat-anchored, same-jti). Drawer Save on 401 pops a re-login modal preserving form state and the dirty draft (from localStorage); on successful re-login the save retries automatically. CSRF token rotates with the cookie if the JWT is re-signed-with-same-jti — actually it doesn't need to rotate (same jti). If the user crossed the absolute cap and got a new jti, the next Save fetches a fresh `/api/csrf` token transparently.

---

## 7. Auth, RBAC, security

### Boot-time secret validation (`instrumentation.ts`)

On process start, ALL of these must pass or `process.exit(1)`:

- Presence of `JWT_SECRET`, `CSRF_SECRET`, `PREVIEW_SECRET`, `BROCHURE_SECRET`, `DATABASE_URL`, `LOGIN_PATH`, `RECAPTCHA_SECRET`, `SMTP_*`. (`INITIAL_ADMIN_*` only when `NODE_ENV !== 'production'`.)
- `Buffer.byteLength(<secret>, 'base64') ≥ 32` for each of `JWT_SECRET`, `CSRF_SECRET`, `PREVIEW_SECRET`, `BROCHURE_SECRET`.
- All four secrets pairwise distinct.
- `LOGIN_PATH` matches `^[a-z0-9-]{6,32}$`.
- **Schema fingerprint match**: compute SHA-256 of canonical `information_schema.columns` filtered to our tables; assert equal to `schema_fingerprint.fingerprint` row. If mismatch → exit (catches "new code, old schema" deploys).
- **Test scrypt hash**: run one full `scrypt` of a fixed test string with the production parameters; if it throws or takes <50 ms (param-too-weak) → exit. Detects `maxmem` and parameter regressions before any user hits the login path.
- Pre-compute and cache `DUMMY_SCRYPT_HASH` for use in the constant-time login path.
- PM2 surfaces failures via `min_uptime` / `max_restarts`; no fail-open.

### Hidden login

- Login at `/[LOGIN_PATH]` rendered by `app/(auth)/[loginPath]/page.tsx` with `dynamic = 'force-dynamic'`. At request time, `params.loginPath` is **length-checked first** (`Buffer.byteLength` equality) then `timingSafeEqual`-compared to `process.env.LOGIN_PATH`. Any failure → standard 404 generic body (no path echo).
- Login page is a **minimal standalone layout** — no shared header, no shared footer, no Google reCAPTCHA on the login form itself (reCAPTCHA is only on public lead forms), no external fonts (uses next/font local). `Referrer-Policy: no-referrer` set as a route-level header.
- **No `<Link>` anywhere** in the app ever points to `LOGIN_PATH` (operators type it directly).
- nginx `location <LOGIN_PATH> { access_log off; }` AND `location /api/auth/login { access_log off; }`. nginx `log_format ... escape=json` for the remaining locations to defeat log injection via Referer/User-Agent.
- **Middleware behavior split by path prefix** (Node runtime — `export const runtime = 'nodejs'` in `middleware.ts` so DB lookups work):
  - `/admin` and `/admin/:path*` (HTML routes) unauthenticated → **307 → `/`**.
  - `/api/cms/:path*`, `/api/admin/:path*`, `/api/auth/logout` unauthenticated → **`401 { error: 'Authentication required' }` JSON** (no redirect — API clients shouldn't see Location).
- Matcher: `['/admin', '/admin/:path*', '/api/cms/:path*', '/api/admin/:path*', '/api/auth/logout']` (defense-in-depth; handler RBAC remains authoritative).
- `robots.txt` `Disallow: /admin` + `Disallow: /api/`. Never lists `LOGIN_PATH`.
- Layout metadata on `/admin` and login routes: `robots: { index: false, follow: false }`.
- Generic error messages everywhere ("Authentication required", "Invalid or expired token", "Not found"). 404 handler renders generic "Not found" without echoing the requested URL.

### JWT

```ts
import { SignJWT, jwtVerify } from 'jose'
const secret = new TextEncoder().encode(process.env.JWT_SECRET)

// sign
new SignJWT({ tv: user.tokens_valid_after_ms })   // role NOT in claim
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('cavecms.cms').setAudience('cavecms.web')
  .setSubject(String(user.id)).setJti(crypto.randomUUID())
  .setIssuedAt().setNotBefore('0s')
  .setExpirationTime(`${JWT_TTL_SECONDS}s`)
  .sign(secret)

// verify (in middleware + requireRole)
const { payload, protectedHeader } = await jwtVerify(token, secret, {
  algorithms: ['HS256'],
  issuer: 'cavecms.cms', audience: 'cavecms.web',
  clockTolerance: '5s',
})
if (protectedHeader.kid || protectedHeader.jku || protectedHeader.jwk
    || protectedHeader.x5u || protectedHeader.x5c) throw unauthorized()
```

Then load `users` row (cached 30s in-memory keyed by user id), assert:
- `active === true`
- `locked_until === null OR locked_until < NOW()`
- `payload.iat * 1000 ≥ tokens_valid_after_ms`
- **Role read from DB row, never from JWT.** `requireRole` consults the cache.

Cookie: `__Host-cavecms_session`, `httpOnly: true, secure: true (prod), sameSite: 'strict', path: '/', maxAge: JWT_TTL_SECONDS`. No `Domain`. Sliding renewal as in §6.

Logout / role-change / deactivate / password-change → `UPDATE users SET tokens_valid_after = NOW()` → all outstanding tokens for that user invalidated on next request.

### Passwords (scrypt — versioned)

- Hash format: `scrypt$N=131072$r=8$p=1$<salt-base64>$<hash-base64>`.
- `crypto.scrypt(password, salt(16), 64, { N: 1<<17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })`. Memory headroom (`maxmem = 2 × N × r × 128`) prevents `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
- Compare with `crypto.timingSafeEqual` after explicit length check.
- On login success, if hash params are below current target → re-hash and `UPDATE`.
- **Constant-time login path (locked branch INCLUDED)**:
  ```ts
  // 1. Always run scrypt against either the real hash or the dummy hash, BEFORE
  //    any short-circuit branch. This keeps response time uniform across:
  //    nonexistent email, wrong password, deactivated, locked.
  const user = await getUserByEmail(email);
  const hashToCompare = user?.password_hash ?? DUMMY_SCRYPT_HASH;
  const passwordOk = await verifyScrypt(password, hashToCompare);

  // 2. Now evaluate gates (these don't add latency because the heavy work is done)
  const locked = await isLockedOut(email, ip);
  const reject = locked || !user || !passwordOk || !user.active;

  if (reject) {
    await recordFailedLogin(email, ip, user_agent, reasonGenericized);
    return jsonError(401, 'Invalid email or password');   // identical body + status
  }
  // 3. handle must_rotate_password by issuing a pwp-scoped JWT (see "Password rotation flow")
  ```
- **Failure reason compression** in `login_attempts.failure_reason`: only the generic set `{ 'bad_credentials','locked','csrf_invalid','rate_limited','malformed' }` is stored — never distinguishing `no_such_email` vs `wrong_password` (defeats DB-read enumeration).
- Vitest timing assertion runs the four branches (nonexistent / wrong-pw / locked / deactivated) and asserts pairwise max-min < 10 ms over 50 runs.

### Password rotation flow (`must_rotate_password`)

When `users.must_rotate_password = TRUE` AND credentials are valid, do NOT issue a normal session. Instead:

```ts
new SignJWT({ pwp: true, oat: now })       // scoped JWT
  .setSubject(String(user.id)).setJti(...).setExpirationTime('15m').sign(...)
```

The login response body includes `{ next: '/[LOGIN_PATH]/rotate' }`. The middleware/`requireRole` rejects any route except `POST /api/auth/rotate-password` when `payload.pwp === true`. The rotation handler:
1. Requires CSRF + current pwp-scoped session.
2. Verifies the user's CURRENT password again (`scryptVerify`).
3. Validates the new password (≥ 12 chars, ≥ 1 character class diversity per OWASP, optional HIBP-prefix check if `PWNED_CHECK=true`).
4. Updates `password_hash`, `password_changed_at = NOW()`, `must_rotate_password = FALSE`, `tokens_valid_after = NOW()`, invalidates the user cache.
5. Issues a fresh full-scope JWT (`pwp: false`).
6. Audit log entry.

Initial-admin seed sets `must_rotate_password = TRUE` so the bootstrap credential is never a long-lived working password.

### CSRF (session-bound double-submit; canonical HMAC input)

The HMAC input is **length-prefixed JSON** to prevent canonicalization collisions:
```
const macInput = JSON.stringify({ v:1, nonce, ts, jti: sessionJti, sub: userId })
const mac = hmacSHA256(CSRF_SECRET, macInput)
const token = `${base64url(nonce)}.${base64url(ts)}.${base64url(mac)}`
```

Flow:
- **`GET /api/csrf`** (authenticated only — returns 401 to unauthenticated callers) issues the token bound to the CURRENT session's `jti` + `sub`.
- Token returned in JSON AND set as `__Host-cavecms_csrf` cookie (`Secure, SameSite=Strict, Path=/`, **not** httpOnly).
- Client mirrors cookie into `X-CSRF-Token` on every mutation.
- Verify: recompute HMAC using the request's CURRENT session jti/sub, `timingSafeEqual`. Reject if:
  - cookie value and header value don't match (length-checked first)
  - HMAC mismatch
  - timestamp older than `CSRF_TTL_SECONDS`
  - issued before current JWT's `iat` (prevents stale tokens reused after sliding renewal that re-signed the JWT — preserved-jti renewal keeps tokens valid; only password-change/role-change/logout invalidate)

**Pre-auth CSRF (login + public forms)** — used wherever CSRF is required without a JWT session:
- The page server-renders the form with a hidden `<input name="csrf">` populated from a freshly-generated value `preNonce`, AND sets a parallel `__Host-cavecms_pre_csrf=preNonce` cookie (httpOnly, Secure, SameSite=Strict, 15 min TTL).
- On POST, the server validates `body.csrf` length-equals `cookie.preNonce` length first, then `timingSafeEqual`.
- **Replay prevention** via an in-memory single-use Map keyed by `preNonce` with TTL = pre-auth CSRF TTL; after first verification (success or failure) the nonce is rejected. The Map is bounded at 50 000 entries with LRU eviction on overflow.
- The cookie is cleared on every POST attempt; if the page is reloaded, a fresh preNonce is generated.

This pre-auth mechanism is the CSRF defense for **`POST /api/auth/login`** AND for **all public lead-form POSTs** (`/api/leads/contact`, `/api/leads/brochure`, `/api/leads/inquiry`, `/api/leads/newsletter`, `/unsubscribe` POST). The public form page server-renders the nonce identically. Public forms do NOT use the post-auth `/api/csrf` endpoint (which is auth-only).

**Multi-tab caveat**: each `GET` rotates the cookie value, so an open tab whose preNonce was overwritten by a later GET in another tab will fail on submit. Acceptable UX trade-off; the form re-fetches a fresh page on a failure.

**Login response cookie rotation**: `POST /api/auth/login` 200 response sets both the new `__Host-cavecms_session` AND a freshly minted `__Host-cavecms_csrf` cookie (bound to the new jti) AND returns the new CSRF token in the response body so the client can prime its in-memory copy without an immediate `/api/csrf` round-trip. The pre-auth cookie is cleared.

**Rate limits**:
- `/api/csrf` — 120 req/min per session (auth required).
- `GET /[LOGIN_PATH]` — 10 req/min per IP (separate bucket from `default`).
- `POST /api/auth/login` — 3/60 s per IP AND 5/5 min per email.

### IP derivation (anti-spoof)

- nginx `proxy_set_header X-Forwarded-For $remote_addr` (**overwrite**, not append) and `proxy_set_header X-Real-IP $remote_addr`.
- App reads `X-Real-IP` **only** when `req.socket.remoteAddress === '127.0.0.1'`. Otherwise → ignore headers, use `req.socket.remoteAddress`.
- Validate the resulting IP parses as IPv4/IPv6 before using it as a Map / DB key. Invalid → reject 400.
- UFW denies public access to port 3040 — only nginx (loopback) can reach it.

### Rate limiting (in-memory Map, single PM2 instance)

Buckets:
```
/api/auth/login    3 req/60s per IP   AND   5 req/5min per email
/api/csrf          120 req/min per session (per IP if anon)
/api/cms/*         60 req/min per user
/api/leads/*       5 req/15min per IP
/healthz           unlimited
default            120 req/min per IP
```

Implementation: `Map<bucketName, Map<key, { count, windowStart, lastSeen }>>`. A `setInterval(sweep, 5 * 60_000).unref()` evicts entries with `lastSeen` older than `2 × longestWindow`. Total entries per bucket capped at 100 k; on overflow, evict the oldest 10%. PM2 `max_memory_restart: '512M'` is the final backstop.

### Progressive lockout (persisted, dual-key, windowed)

Two state tables — `failed_logins_by_email` and `failed_logins_by_ip` — carry only the live lock state (`locked_until`, `last_failure_at`, advisory `count`). The **tier math reads from `login_attempts`** (the audit table) so the three windows are evaluated correctly.

Tiers (read with three windowed COUNTs each per key):
- 3 failures in **10 min** → 30 min lock
- 6 failures in **1 h** → 3 h lock
- 9 failures in **24 h** → 24 h lock

Lockout check — single query with conditional aggregation (NOT eight separate subqueries; the eight-row form below is for clarity only):
```sql
SELECT
  SUM(success=0 AND email=? AND created_at > NOW() - INTERVAL 10 MINUTE) AS e10m,
  SUM(success=0 AND email=? AND created_at > NOW() - INTERVAL 1  HOUR  ) AS e1h,
  SUM(success=0 AND email=? AND created_at > NOW() - INTERVAL 24 HOUR ) AS e24h,
  SUM(success=0 AND ip   =? AND created_at > NOW() - INTERVAL 10 MINUTE) AS i10m,
  SUM(success=0 AND ip   =? AND created_at > NOW() - INTERVAL 1  HOUR  ) AS i1h,
  SUM(success=0 AND ip   =? AND created_at > NOW() - INTERVAL 24 HOUR ) AS i24h
FROM login_attempts
WHERE created_at > NOW() - INTERVAL 24 HOUR
  AND (email = ? OR ip = ?);

-- Followed by:
SELECT (SELECT locked_until FROM failed_logins_by_email WHERE email=?) AS email_locked,
       (SELECT locked_until FROM failed_logins_by_ip    WHERE ip   =?) AS ip_locked;
```
The `created_at > NOW() - INTERVAL 24 HOUR` outer floor bounds the scan irrespective of retention. Required composite indexes: `INDEX idx_attempts_email_created (success, email, created_at DESC)` and `INDEX idx_attempts_ip_created (success, ip, created_at DESC)` — the `success` prefix makes `success=0` a constant in the index. (These supersede the §5 indexes shown without `success` prefix; §5 is updated accordingly.)

Apply locks:
- If `email_locked > NOW()` OR `ip_locked > NOW()` → reject (generic 401 + `Retry-After`).
- Else evaluate tier triggers for either key: if any window's count crosses its threshold, write `locked_until = NOW() + <duration>` to the corresponding state row.

**Credential-spray detector** (separate path, computed from `login_attempts`):
```sql
SELECT COUNT(DISTINCT email) FROM login_attempts
WHERE ip = ? AND success = 0
  AND created_at > NOW() - INTERVAL SPRAY_DETECTOR_WINDOW_MIN MINUTE
```
If > `SPRAY_DETECTOR_DISTINCT_EMAILS` (default 5) → lock IP for `SPRAY_DETECTOR_LOCK_MIN` (default 60 min).

**Counter resets**: on successful login, clear `locked_until` AND `count` on BOTH the email row AND the request's IP row. The legitimate user shouldn't be locked out from their own IP after a successful login. The credential-spray detector still observes from `login_attempts` (not from the reset state row) so attackers across multiple emails still trip independently.

**Lockout-DoS mitigation** (targeted lockouts against a known admin): if `failed_logins_by_email.locked_until > NOW()` AND there exists `user_known_ips (user_id, ip)` for the email's user_id AND `failed_logins_by_ip.locked_until IS NULL OR < NOW()` → **bypass the email lock for this single attempt only** (do not clear the lock; just allow scrypt to run and gate on credentials). Successful login from a known-good IP then clears the email lock. `user_known_ips` is populated on every successful login (INSERT … ON DUPLICATE KEY UPDATE last_success_at). Spec-tested: an attacker locking the email cannot use the bypass (their IP isn't in the user's known-good set).

`login_attempts.failure_reason` uses the compressed enum from §7 Passwords. Successes are recorded too but never contribute to lockout math. Retention: `LOGIN_ATTEMPTS_RETENTION_DAYS` (default 30) via nightly cron.

### Per-route RBAC matrix (authoritative for tests/shared/rbac-matrix.ts)

Status codes per role; `anon` = no JWT.

| Route | anon | viewer | editor | admin |
|---|:-:|:-:|:-:|:-:|
| `GET /` (and other public pages) | 200 | 200 | 200 (edit chrome) | 200 (edit chrome) |
| `GET /[LOGIN_PATH]` | 200 | 200 | 200 | 200 |
| `GET /healthz` | 200 (minimal) | 200 | 200 | 200 |
| `GET /sitemap.xml` / `/robots.txt` | 200 | 200 | 200 | 200 |
| `GET /unsubscribe?token=…` | 200 | 200 | 200 | 200 |
| `GET /api/brochure/[token]` | 200 (file)/410 | same | same | same |
| `POST /api/auth/login` | 401/200 | n/a | n/a | n/a |
| `POST /api/auth/logout` | 401 | 200 | 200 | 200 |
| `POST /api/auth/rotate-password` | 401 | 200 (own) | 200 (own) | 200 (own) |
| `GET /api/csrf` | 401 | 200 | 200 | 200 |
| `POST /api/leads/{contact,brochure,inquiry,newsletter}` | 200 | 200 | 200 | 200 |
| `PATCH /api/cms/blocks/[id]` | 401 | 403 | 200 | 200 |
| `POST /api/cms/blocks` | 401 | 403 | 200 | 200 |
| `DELETE /api/cms/blocks/[id]` | 401 | 403 | 200 | 200 |
| `POST /api/cms/blocks/[id]/restore` | 401 | 403 | 200 | 200 |
| `POST /api/cms/blocks/reorder` | 401 | 403 | 200 | 200 |
| `POST /api/cms/media` | 401 | 403 | 200 | 200 |
| `GET /api/cms/media` | 401 | 403 | 200 | 200 |
| `DELETE /api/cms/media/[id]` | 401 | 403 | 403 | 200 |
| `POST /api/cms/projects` | 401 | 403 | 403 | 200 |
| `PATCH /api/cms/projects/[id]` | 401 | 403 | 200 (editor schema) | 200 (admin schema) |
| `DELETE /api/cms/projects/[id]` | 401 | 403 | 403 | 200 |
| `POST /api/cms/projects/reorder` | 401 | 403 | 200 | 200 |
| `PATCH /api/cms/projects/[id]/sections/[sectionId]` | 401 | 403 | 200 | 200 |
| `POST /api/cms/projects/[id]/preview-token` | 401 | 403 | 200 | 200 |
| `GET/POST /api/cms/posts` | 401 | 403 | 200 | 200 |
| `PATCH/DELETE /api/cms/posts/[id]` | 401 | 403 | 200 (editor schema) | 200 (admin schema) |
| `GET/POST/PATCH/DELETE /api/cms/team[/…]` | 401 | 403 | 200 | 200 |
| `GET /api/admin/leads` | 401 | 200 (PII masked) | 200 (full PII) | 200 (full PII) |
| `GET /api/admin/leads/[id]` | 401 | 403 | 200 | 200 |
| `PATCH /api/admin/leads/[id]` | 401 | 403 | 200 | 200 |
| `GET /api/admin/leads/export` | 401 | 403 | 200 | 200 |
| `GET /api/admin/audit-log` | 401 | 403 | 403 | 200 |
| `GET /api/admin/trash` | 401 | 403 | 200 | 200 |
| `GET/PATCH /api/admin/settings` | 401 | 403 | 403 | 200 |
| `GET/POST /api/admin/users` | 401 | 403 | 403 | 200 |
| `PATCH/DELETE /api/admin/users/[id]` | 401 | 403 | 403 | 200 |

API routes return JSON 401 on missing auth (no redirect). HTML routes at `/admin/*` return 307 → `/`. Server-side `requireRole` is the enforcing layer; middleware is defense in depth. The Vitest contract test walks `app/api/**/route.ts` and asserts every detected route appears in `tests/shared/rbac-matrix.ts`.

### Action-level RBAC summary

| Action | Admin | Editor | Viewer |
|---|:-:|:-:|:-:|
| Inline-edit page content | ✓ | ✓ | – |
| Edit existing project content fields (Editor schema) | ✓ | ✓ | – |
| Toggle project `published` / change `slug` / change `status` | ✓ | – | – |
| Reorder featured projects | ✓ | ✓ | – |
| Create / archive project | ✓ | – | – |
| Blog CRUD (Editor schema for non-Admin fields) | ✓ | ✓ | – |
| Team CRUD | ✓ | ✓ | – |
| Upload media | ✓ | ✓ | – |
| Delete media (soft) | ✓ | – | – |
| View leads (full PII) | ✓ | ✓ | – |
| View leads (masked PII) | – | – | ✓ |
| Update / export leads | ✓ | ✓ | – |
| Edit settings | ✓ | – | – |
| Manage users | ✓ | – | – |
| View audit log | ✓ | – | – |

**Field-level RBAC** — each PATCH handler picks a Zod **allowlist** schema by role:

- `projectPatchSchema.editor` (allowlist): `name, tagline, location, hero_image_id, brochure_pdf_id, featured_order, seo_title, seo_description, og_image_id, version`.
- `projectPatchSchema.admin` (allowlist): editor allowlist + `published, slug, status, deleted_at`.
- `postPatchSchema.editor` (allowlist): `title, excerpt, body_md, hero_image_id, seo_title, seo_description, og_image_id, version`.
- `postPatchSchema.admin` (allowlist): editor allowlist + `published, slug, published_at`.
- `blockPatchSchema.editor` (allowlist): `data, version` (cannot touch `block_key`, `position`, `block_type`).
- `blockPatchSchema.admin` (allowlist): editor + `position`. `block_key`/`block_type` are immutable post-creation.

Any field present in the body that is NOT in the role's allowlist → **403 `{ error: 'Forbidden' }`** (generic, does NOT echo the offending field name to the client). Server-side: an `audit_log` row with `action='rbac_field_reject'` records the user_id, route, IP, and offending field — visible to Admin via `/admin/activity`. This prevents schema-enumeration recon while keeping audit visibility.

**PII masking for Viewer leads**: `lib/leads/mask.ts` reduces `name` to initials, `email` to `f***@domain.tld`, `phone` to last 4 digits, `message` to first 80 chars with no embedded contact info regex-redacted. Detail endpoint `/api/admin/leads/[id]` returns 403 for Viewer.

**User-management invariants** (enforced in handler inside same TX with `SELECT ... FOR UPDATE`):
- Cannot change own role.
- Cannot deactivate own account.
- Cannot demote/deactivate the last active Admin. Concrete locking pattern: `SELECT id FROM users WHERE role='admin' AND active=TRUE FOR UPDATE` — count must remain ≥ 1 after the planned change. Violation → 409 `{ error: 'At least one active admin must remain' }`.
- New Admin creation requires existing Admin to confirm with current password re-entry.

### Audit log captures auth events

`audit_log` rows are written for: `login_success`, `login_failure`, `logout`, `lockout`, `role_change`, `deactivate`, `csrf_reject`, plus all CMS writes. `/admin/activity` filters on `resource_type` so admins can review auth events without leaving the dashboard.

### Audit log diff format

Field-level patch: `{ "field_name": { "from": value, "to": value }, ... }`. JSON canonicalized (sorted keys) before computing the diff via `microdiff`. On `action='delete'`, diff carries `{ snapshot: <full pre-delete row> }` for restore.

**Sensitive-field denylist** (per-table) — these fields are NEVER recorded; replaced with `"[redacted]"` in both `{from,to}` patches and `{snapshot}` payloads:
- `users.password_hash`
- `users.tokens_valid_after`
- `newsletter_subscribers.unsubscribe_token`
- Any column matching the suffix `_secret`, `_token`, `_key` (future-proofing)

Diff column capped at **64 KB for non-delete actions**; if exceeded, `{ truncated: true, summary: "N keys changed" }`. For `action='delete'` the full snapshot is preserved (column is MEDIUMTEXT-effective) so restore-from-audit is possible after the 30-day soft-delete window. Vitest fuzz greps all `audit_log` rows after exercising every PATCH/DELETE for any string matching the password-hash or token shapes.

### Input validation & SQL

- All queries via Drizzle ORM (typed, parameterized). Any raw query uses `mysql2.execute(sql, params)` with placeholders.
- Zod on every API route handler before DB calls.
- **No character-blocking regex on user-facing message/free-text fields** (rejecting `<>&"'` mangles legitimate input like `O'Brien`, `J & K Properties`). Defense is output encoding (React + DOMPurify + escapeHtml in emails). Short identifier-like fields (phone, internal slugs) still have format regex.
- Zod field length caps on every string (`name z.string().max(180)` etc.).
- Email-template header values (subject, To name, Reply-To): strip `\r` and `\n` before passing to nodemailer (CRLF injection defense).

### XSS

- React escapes by default for all text.
- Rich text (TipTap) → DOMPurify on save with `ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i`, `ADD_ATTR: ['rel','target']`, post-hook forcing `rel="noopener noreferrer nofollow"` + `target="_blank"` on links. Re-sanitized on read (defense vs DB tampering, restored backups).
- Markdown (`posts.body_md`, `team_members.bio_md`) → server-side `remark → remark-gfm → rehype-sanitize` with allow-list `p, br, strong, em, a[href], h2-h4, ul, ol, li, blockquote, code, pre, img[src][alt]`; same URI allow-regex for `<a href>`; `img[src]` restricted by an **anchored regex** `^/uploads/(originals|variants)/[A-Za-z0-9._-]{1,80}\.(jpe?g|png|webp|avif)$` (defeats path traversal and external-host smuggling). **No client-side markdown rendering ever.**
- Rich-text (TipTap) allow-list widened to include `ul, ol, li` (single-level lists are common in project copy like "Includes: 2BR, 3BR, 4BR units"). Block-quote and headings remain markdown-only.
- Email templates run every dynamic value through `escapeHtml()`. Subject lines RFC-2047 encoded for non-ASCII.

### Security headers (`next.config.ts` + middleware for nonces)

```
poweredByHeader: false

X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin   (login route overrides to no-referrer)
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Content-Security-Policy:
  default-src 'self';
  img-src 'self' data:;                            # NO https: wildcard
  script-src 'self' 'nonce-<per-request>' 'strict-dynamic'
             https://www.google.com https://www.gstatic.com https://www.recaptcha.net;
  style-src 'self' 'nonce-<per-request>';          # 'unsafe-inline' removed via Next experimental nonce
  font-src 'self' data:;
  connect-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net;
  frame-src https://www.google.com https://www.recaptcha.net;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests;
```

**Nonces** are generated per request in middleware (`crypto.randomUUID()`), set on the CSP header, and threaded to layouts via `headers().get('x-csp-nonce')`. Layouts stamp the nonce on every Next.js `<Script>` and inline `<style>`. The `style-src` nonce path uses Next.js's experimental `experimental.cssNonce` option; if blocked, document as `OPEN-ITEM-1` and accept `'unsafe-inline'` temporarily with a target removal date.

### Public-form spam defense

- **Honeypot** field on every public form (hidden `<input name="company_url">`); filled → drop silently + bump rate-limit counter.
- **reCAPTCHA v3** on `/api/leads/contact`, `/api/leads/brochure`, `/api/leads/inquiry`, `/api/leads/newsletter`. Verify via `https://www.google.com/recaptcha/api/siteverify` with `AbortSignal.timeout(RECAPTCHA_TIMEOUT_MS)`. Threshold `RECAPTCHA_THRESHOLD` (default 0.5).
- **Fail-open vs fail-closed policy**: on Google service timeout/5xx, **fail-OPEN but only when honeypot empty AND rate limit not tripped**; log to `notification_failures` with kind=`recaptcha_degraded`. On Google returning a definitive low score, **fail-CLOSED**.

### Brochure download (signed token, private storage)

Brochure PDFs live in `/opt/cavecms/uploads/brochures-private/<uuid>.pdf` — **not** symlinked into `public/` and **not** served by nginx. Access only via `/api/brochure/[token]`:
- Token = `HMAC-SHA256(BROCHURE_SECRET, lead_id || project_id || exp)` + payload base64url.
- 7-day expiry; single-use (sets `leads.brochure_token_used_at`).
- Response: `Content-Disposition: attachment`, `Cache-Control: private, no-store`.
- Brochure auto-reply email contains the token URL.

### SSRF defense

- reCAPTCHA URL is a const. No other outbound HTTP fetches in v1.
- All `og_image` references are `media_id` (server-resolved to `/uploads/*`); free-form image URLs are never accepted in settings or content.
- If a future feature requires outbound fetch, it must validate scheme `https:` AND resolve DNS to a non-private IP (block `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`).

### Error handling

`lib/api/withError.ts` wraps every route handler:
```ts
catch (err) {
  const requestId = crypto.randomUUID()
  console.error({ requestId, err }, 'route_error')   // server log only
  if (err instanceof ZodError)        return jsonError(400, 'Invalid request', requestId)
  if (err instanceof OptimisticLock)  return jsonError(409, 'Stale version, reload', requestId)
  if (err instanceof Unauthorized)    return jsonError(401, 'Authentication required', requestId)
  if (err instanceof Forbidden)       return jsonError(403, 'Forbidden', requestId)
  if (err instanceof NotFound)        return jsonError(404, 'Not found', requestId)
  return jsonError(500, 'Something went wrong', requestId)
}
```
Never returns `err.message`, `err.code`, `err.sqlMessage`. Vitest contract test fuzzes handlers with bad input and asserts no DB internals appear in responses.

### Cookies summary

| Cookie | Purpose | httpOnly | Secure | SameSite | Path | maxAge |
|---|---|:-:|:-:|---|---|---|
| `__Host-cavecms_session` | JWT session | ✓ | ✓ | Strict | `/` | JWT_TTL |
| `__Host-cavecms_csrf` | CSRF echo | ✗ | ✓ | Strict | `/` | CSRF_TTL |
| `__Host-cavecms_pre_csrf` | Pre-auth CSRF | ✓ | ✓ | Strict | `/` | 15 min |
| `__Host-cavecms_edit_mode` | Edit overlay toggle | ✓ | ✓ | Strict | `/` | JWT_TTL |

Subdomain isolation: staging and apex have distinct `__Host-` cookies (no `Domain` allowed → automatic isolation).

### Multi-tab session

`BroadcastChannel('cavecms-auth')`: on login/logout/role-change events the active tab posts `{ type: 'invalidate' }`. All open tabs call `router.refresh()` and re-render auth-gated UI. Server components reading the session cookie use `cookies()` (uncached per Next.js docs).

### Unhandled rejection / crash policy

`instrumentation.ts` registers:
- `process.on('unhandledRejection', (r) => console.error('unhandled rejection', r))` — log only.
- `process.on('uncaughtException', (e) => { console.error('uncaught exception', e); process.exit(1) })` — exit; PM2 restarts (gated by `max_restarts: 10, min_uptime: 60_000`).

### Defends against (explicit)

- Account takeover (CSRF session-bound, scrypt versioned, rate limits, lockout, IP+email dual-key, IP-spoof defense, force-logout via `tokens_valid_after`)
- User enumeration (identical error + constant timing via dummy hash)
- Session fixation (new JWT on login; old invalidated via `tokens_valid_after` bump)
- Privilege escalation (role read from DB on every request, field-level RBAC, last-admin invariant)
- CSRF (session-bound double-submit, pre-auth variant for login)
- Brute force (in-memory IP/user buckets + DB-persisted dual-key lockout + spray detector)
- SQL injection (Drizzle typed queries + Zod input)
- XSS (React + DOMPurify on save AND read + escapeHtml in email + markdown sanitize-rehype)
- Clickjacking (frame-ancestors 'none' + X-Frame-Options DENY)
- Information disclosure (no X-Powered-By, generic errors, masked PII for Viewer, hidden login URL never in code/Link/log, error wrapper never leaks SQL)
- Path leak (no `<Link>` to LOGIN_PATH, nginx access_log off on login routes, no shared footer, no external referrers)
- SSRF (no free-form outbound URLs; reCAPTCHA pinned)
- Spam (honeypot + reCAPTCHA + rate limit; fail-open with logging only when degraded)
- Open redirect (form-action 'self'; no redirect query params accepted)
- Decompression bomb (sharp `limitInputPixels`, MIME sniff, size cap)
- Header injection (CRLF strip on email template values; nginx `log_format … escape=json`)

### Deferred (documented deviations)

- `OPEN-ITEM-1` — `style-src` may include `'unsafe-inline'` at launch if Next.js 15.5.4 doesn't yet honor a CSS nonce reliably in production. Target removal: within 30 days of launch.

---

## 8. Media handling

- Upload endpoint `/api/cms/media` (admin/editor only, CSRF, multipart, semaphore=2 in-flight).
- Hard limits: 10 MiB images, 25 MiB PDFs. Enforced both in the route handler and via nginx `client_max_body_size 30m`.
- Magic-byte MIME sniff via `file-type`. Allow-list: `image/jpeg`, `image/png`, `image/webp`, `image/avif`, `application/pdf`. **SVG rejected outright.** PDF magic bytes must start with `%PDF-`.
- Stored filenames are v4 UUIDs with no extension exposed externally; `original_name` retained as DB column only.
- Images: sharp `limitInputPixels: 24_000_000`; EXIF stripped via `withMetadata({ exif: {} })`; `.rotate()` applied. Four variants generated in parallel: thumb (320w WebP), md (768w WebP), lg (1600w WebP), og (1200×630 JPEG).
- PDFs: no transformation; placed in `/opt/cavecms/uploads/brochures-private/` (private; served only via `/api/brochure/[token]`).
- Atomic write pipeline (temp dir → validate → rename → INSERT inside TX → cleanup) as specified in §6.
- Alt text **required** at upload time (a11y + SEO; refusal is a server-side check, not UI-only).
- nginx serves `/uploads/originals/*` and `/uploads/variants/*` directly with `expires 30d; add_header Cache-Control "public, max-age=2592000"; add_header X-Content-Type-Options nosniff;`. PDFs are never served by nginx.
- Backup: `/opt/cavecms/uploads/{originals,variants}` rsynced daily to `/backup/cavecms/uploads/`. Brochures-private rsynced separately to a key-restricted backup path. Both encrypted via `age`.
- A periodic verifier (`scripts/verify-media-refs.ts`, run weekly via systemd timer) rebuilds `media_references` from scratch and logs any drift to `audit_log`.

---

## 9. Forms & leads

### Submission flow (DB-first, persist-on-enqueue)

```
Public form submit →
  POST /api/leads/{source}                          # CSRF + honeypot + reCAPTCHA + rate limit
  → Zod validate, length cap fields
  → BEGIN TX
       INSERT INTO leads (...)  (for contact/brochure/inquiry only — newsletter writes elsewhere)
       INSERT INTO pending_emails (sales notification rendered now via React Email/MJML)
       INSERT INTO pending_emails (user auto-reply; brochure variant embeds signed URL)
     COMMIT
  → respond 200 with neutral message ("Thanks, we'll be in touch")
  → trigger queue runner (best-effort; the runner sweeps regardless)
```

**Slug-change handler**: when a project or post slug changes inside the PATCH handler, in the **same TX** as the UPDATE: `INSERT INTO slug_redirects (resource_type, old_slug, new_slug) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)`. Additionally, collapse chains: `UPDATE slug_redirects SET new_slug = <newest> WHERE resource_type = ? AND new_slug = <old_slug>`. Public routes check `slug_redirects` on 404 and `301`-redirect.

### Email queue (`lib/email/queue.ts`, persist-on-enqueue)

`pending_emails` is the source of truth — enqueued BEFORE first attempt so a PM2 restart between enqueue and first send loses nothing.

- nodemailer transport singleton with pool: `pool: true, maxConnections: SMTP_POOL_MAX_CONNECTIONS, maxMessages: 100, connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS, greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS, socketTimeout: SMTP_SOCKET_TIMEOUT_MS`.
- Retry policy: `SMTP_RETRY_ATTEMPTS` attempts, exponential backoff `30s / 5m / 1h`.
- Circuit breaker: 5 consecutive failures → skip sends for 5 min, breaker open state recorded in `notification_failures (kind='smtp_send')`.
- Boot sweeper retries `pending_emails` where `next_retry_at < NOW()` AND `resolved_at IS NULL` AND `attempts < SMTP_RETRY_ATTEMPTS`. After max attempts, leaves the row for admin review at `/admin/activity`.
- Header values (subject, From name, Reply-To) pass through CRLF-strip before nodemailer; subjects RFC-2047 encoded for non-ASCII.
- Body HTML rendered through React/MJML with `escapeHtml()` on every dynamic value.

### Lead sources

- `contact` — `/contact` page. Writes to `leads`.
- `brochure` — gated form on each project. Writes to `leads`. Auto-reply contains a signed `/api/brochure/[token]` URL valid 7 days.
- `inquiry` — project-specific form; pre-tagged with `project_id`. Writes to `leads`. Handler validates `projects.deleted_at IS NULL AND published = TRUE` before insert; if not, returns neutral 200 but does NOT persist (don't reveal state of unpublished/deleted projects).
- `newsletter` — single email field; writes **only** to `newsletter_subscribers`, never to `leads`. Idempotent semantics in §9 Newsletter.

### State machine for `leads.status`

Enforced server-side as in §5. Status changes write `audit_log` rows with the actor and timestamp.

### CSV export (streaming, injection-safe)

`GET /api/admin/leads/export` (handler sets `Content-Disposition: attachment; filename="cavecms-leads-YYYY-MM-DD.csv"`) — Admin/Editor only. Uses Drizzle's row iterator → writes CSV rows to a `ReadableStream` with `Transfer-Encoding: chunked`. UTF-8 BOM. Columns: `id, source, name, email, phone, project_slug, status, message, created_at` (ISO 8601 with TZ offset). Honors current filter querystring. Cursor-paginated internally (no `OFFSET`). Max 100k rows per export.

**CSV injection defense** (per OWASP): every cell whose first character is one of `= + - @ \t \r` is prefixed with a leading apostrophe (`'`) before RFC-4180 quoting. Embedded `"` doubled. Applied to ALL string columns, not just `message`.

**Cursor cleanup**: the `ReadableStream` defines a `cancel(reason)` handler that calls the Drizzle iterator's `.return()` to release the DB connection back to the pool — defends against client-disconnect leaks under `DB_POOL_LIMIT` saturation. nginx is configured with `proxy_buffering off` for this route (see §11).

### Lead inbox query (keyset pagination)

```sql
SELECT leads.*, projects.slug AS project_slug, projects.name AS project_name
FROM leads
LEFT JOIN projects ON leads.project_id = projects.id AND projects.deleted_at IS NULL
WHERE (created_at, leads.id) < (?, ?)
  AND (?source IS NULL OR source = ?)
  AND (?status IS NULL OR status = ?)
ORDER BY leads.created_at DESC, leads.id DESC
LIMIT 50
```

Cursor passed as `?cursor=<created_at>_<id>`. Same keyset pattern for `/admin/audit-log` and `/admin/trash`.

For Viewer role, the response goes through `lib/leads/mask.ts` before serialization.

(Index `idx_leads_source_status_created` declared in §5 `leads` schema. Vitest integration test asserts `EXPLAIN` selects it for the common filter shape.)

### Unsubscribe

- `GET /unsubscribe?token=<…>` — token base64url, 32-byte random. Lookup, render a confirmation page with a POST form (CSRF-protected); only the POST flips `status='unsubscribed'` and rotates the token (defeats link-prefetch unsubscribes by email scanners). Idempotent. Rate-limited 60 req/min/IP.

### Newsletter duplicate behavior

`INSERT INTO newsletter_subscribers (email, unsubscribe_token, source) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE …`:
- If existing row is `status='active'` → no-op (keep existing token).
- If existing row is `status='unsubscribed'` → **do NOT auto-reactivate from a public unauthenticated POST**. Always return 200 with neutral copy. Re-subscribing an unsubscribed email is a no-op silently to defeat email-harvesting via token-rotation timing AND to honor the recipient's prior unsubscribe.
- To re-subscribe, the user must use the public newsletter form which sends a **double-opt-in confirmation email** to the address (a separate one-time signed-link route); only the confirmation click flips status back to `active` and rotates the unsubscribe token. This applies only when the existing row is `status='unsubscribed'`; brand-new emails skip the double-opt-in.

Always returns 200; never reveals whether the address was already in the DB.

---

## 10. SEO

- `/sitemap.xml` dynamic (`app/sitemap.ts`). Lists Home, About, Services, Contact, Projects index, all published+non-deleted projects, Blog index, all published+non-deleted posts. Cached via tag `sitemap`. `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`.
- `/robots.txt` dynamic (`app/robots.ts`). Apex emits the documented allowlist; staging host emits `User-agent: *` `Disallow: /`. Branch on `request.headers.get('host')`. `Cache-Control: public, s-maxage=3600`.
- Per-page metadata via Next.js `generateMetadata`:
  - Resolution chain in `lib/seo/resolve.ts`:
    - `title = entity.seo_title || entity.name || entity.title || settings.default_seo.title`
    - `description = entity.seo_description || entity.tagline || entity.excerpt || settings.default_seo.description`
    - `og_image = entity.og_image_id || entity.hero_image_id || settings.default_seo.og_image_id`
  - **Canonical URLs** computed from pathname only; query strings (including `?preview`) stripped.
- JSON-LD:
  - `Organization` schema on every public page (from `settings.organization_json_ld` + `contact_info`).
  - `Residence` (or `Place`) + `Offer` schema on each project page.
  - `BlogPosting` schema on each post.
  - `BreadcrumbList` schema on deep pages.
  - Built from already-fetched data — no extra DB queries; `settings` is loaded once per request via `unstable_cache` keyed on tag `settings`.
- OG + Twitter card tags on every public page. OG image dimensions enforced via the `og` sharp variant (1200×630 JPEG).
- Preview-rendered pages emit `X-Robots-Tag: noindex, nofollow, noarchive` and a `<meta name="robots">` regardless of any other setting.

---

## 11. Deployment & operations

### CI workflows (GitHub Actions)

CI runner uses **Ubuntu image matching the droplet** (`ubuntu-24.04` or whichever matches the droplet's `lsb_release -rs`) so sharp's prebuilt native binary glibc/arch matches.

1. **PR / push to any branch:** typecheck → lint → vitest unit + integration → Playwright headless. Fails the PR if any red.
2. **Push to `main`:** above + production build:
   - `pnpm install --frozen-lockfile --ignore-scripts`
   - `pnpm rebuild sharp` (explicit allow-list — only `sharp` is permitted to run install scripts)
   - `NEXT_PUBLIC_*` env vars from the **staging GitHub Environment** are exposed at this step so they are inlined into the build (CI step asserts the placeholder strings are NOT present in `.next/static/**` after build; if a placeholder survives, the artifact is rejected).
   - `pnpm build` → produces `.next/standalone`
   - Bundle a separate `migrator-bundle/` containing `node_modules` derived from `pnpm install --prod --filter=migrator` (drizzle-orm, mysql2, the migration runner script). This is the runtime that runs `pnpm db:migrate` on the droplet.
   - **Schema fingerprint**: run `drizzle-kit introspect` against a scratch DB seeded from migrations, compute SHA-256 over the canonical column list, write to `db/schema-fingerprint.txt` in the artifact.
   - Tar: `build.tar.zst` containing `.next/standalone + .next/static + public + db/migrations + db/schema-fingerprint.txt + migrator-bundle/ + package.json + ecosystem.config.cjs + scripts/`.
   - rsync to droplet's `/opt/cavecms/releases/<sha>/` via deploy-only SSH key.
   - Trigger staging deploy with `--env staging`.
3. **Tag `v*`:** above with **production GitHub Environment** secrets for `NEXT_PUBLIC_*` (rebuilt because public env vars are inlined per-environment), manual approval gate, deploy to apex with `--env production`.
4. **Failed deploy:** auto-revert via `scripts/rollback.sh` (re-point `current` symlink to previous release; PM2 reload; if the failed deploy's migration was destructive, prompt to restore the pre-deploy DB snapshot).

**`NEXT_PUBLIC_*` env vars** (only `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` in v1) are passed at CI build time, NOT at runtime on the droplet — Next.js inlines them into the client bundle at build. The droplet `.env.local` carries only server-side secrets.

### Repository layout

```
app/
  (public)/
    layout.tsx                       # shared header/footer; nonce stamping
    page.tsx                          # /
    about/page.tsx
    services/page.tsx
    contact/page.tsx
    projects/page.tsx
    projects/[slug]/page.tsx
    blog/page.tsx
    blog/[slug]/page.tsx
    unsubscribe/page.tsx
  (auth)/
    [loginPath]/page.tsx              # minimal layout, no shared chrome
  (admin)/
    admin/
      layout.tsx                      # sidebar + topbar
      page.tsx                        # dashboard
      projects/page.tsx
      leads/page.tsx
      team/page.tsx
      blog/page.tsx
      users/page.tsx
      settings/page.tsx
      activity/page.tsx
      trash/page.tsx
      help/page.tsx
  api/
    auth/login/route.ts
    auth/logout/route.ts
    csrf/route.ts
    cms/blocks/[id]/route.ts
    cms/blocks/route.ts
    cms/blocks/reorder/route.ts
    cms/blocks/[id]/restore/route.ts
    cms/media/route.ts
    cms/media/[id]/route.ts
    cms/projects/[id]/route.ts
    cms/projects/[id]/sections/[sectionId]/route.ts
    cms/projects/[id]/preview-token/route.ts
    cms/projects/reorder/route.ts
    cms/posts/[id]/route.ts
    cms/team/[id]/route.ts
    admin/leads/route.ts
    admin/leads/[id]/route.ts
    admin/leads/export/route.ts            # Content-Disposition; format=csv
    admin/users/route.ts                   # list/create
    admin/users/[id]/route.ts              # PATCH/DELETE
    admin/audit-log/route.ts
    admin/trash/route.ts
    admin/settings/route.ts
    cms/posts/route.ts                     # list/create
    cms/team/route.ts                      # list/create
    auth/rotate-password/route.ts
    leads/{contact,brochure,inquiry,newsletter}/route.ts
    brochure/[token]/route.ts
    healthz/route.ts
  sitemap.ts
  robots.ts
  not-found.tsx
  error.tsx
components/
  blocks/
    Hero/{render.tsx,editor.tsx,schema.ts}      # co-located triplet per block
    Cta/...
    ...
  inline-edit/
    EditableBlock.tsx
    Drawer.tsx
    MediaPicker.tsx
    RichTextEditor.tsx
  admin/
    LeadsTable.tsx
    ProjectsTable.tsx
    ...
  ui/                                # primitives (Button, Input, etc.)
lib/
  auth/
    jwt.ts
    csrf.ts
    scrypt.ts
    requireRole.ts
    rateLimit.ts
    middleware.ts
  cms/
    parse.ts                          # Zod read/write boundary
    save.ts                           # optimistic-lock save flow
    hydrate.ts                        # N+1 defense
    revalidate.ts                     # tagsFor + try/catch + enqueue
    project-section-schemas.ts
    block-type-registry.ts
  cache/tags.ts                       # canonical tag list
  email/
    transport.ts
    queue.ts
    templates/
      sales-notification.tsx
      user-auto-reply.tsx
      brochure-delivery.tsx
      unsubscribe-confirm.tsx
  seo/
    resolve.ts
    jsonLd.ts
  leads/
    mask.ts                           # PII masking for Viewer
  theme/tokens.ts                     # brand palette + type ramp + spacing
  api/withError.ts
db/
  schema/
    users.ts
    pages.ts
    projects.ts
    posts.ts
    media.ts
    leads.ts
    audit.ts
    settings.ts
    index.ts                          # re-exports
  migrations/                         # drizzle-kit generated, reviewed, committed
  seed.ts                             # idempotent; admin if empty
  client.ts                           # singleton pool
scripts/
  setup.sh
  deploy.sh
  rollback.sh
  db-backup.sh
  uploads-backup.sh
  cron-purge.ts
  verify-media-refs.ts
  nginx/
    cavecms.conf.template                 # processed by setup.sh
public/
  brand/
    logo.svg
    favicon.ico
  fonts/
    *.woff2
  uploads -> /opt/cavecms/uploads         # symlink (gitignored)
tests/
  unit/
  integration/
  e2e/
  shared/
    rbac-matrix.ts                    # data-driven RBAC denial tests (consumed by Vitest + Playwright)
docs/
  specs/2026-05-10-cavecms-rebuild-design.md
  brand/audit-YYYY-MM-DD.md
README.md
```

Each block lives as a triplet: `render.tsx` (public render), `editor.tsx` (drawer form auto-generated from schema), `schema.ts` (Zod). One file per logical unit. Adding a new block = three files in a new folder + register in `lib/cms/block-type-registry.ts`.

### Migrations (Drizzle, forward-only, expand/contract enforced)

- Schema in `db/schema/*.ts`. Migrations in `db/migrations/*.sql` generated by `drizzle-kit generate` and reviewed by humans before commit.
- Each migration is a single logical change. Multi-statement migrations should be avoided; if needed, each statement is idempotent (`CREATE TABLE IF NOT EXISTS`, etc.) where MariaDB syntax allows.
- **Migration runner uses the `cavecms_migrator` DB user from `migrator-bundle/`**, NOT the app's pool.
- **Expand/contract gate** — `scripts/preflight.sh` scans all pending migrations for destructive statements (regex matches `DROP\s+(COLUMN|TABLE|INDEX)`, `ALTER\s+TABLE\s+\S+\s+MODIFY` narrowing types, `RENAME COLUMN`). If found AND `ALLOW_CONTRACT=1` env var is NOT set on the deploy → reject the deploy with a clear message. Contracts are run via a separate `scripts/finalize.sh` invocation (manual or follow-up workflow) after the new release has been stable for ≥ N minutes.
- **Schema fingerprint guarantee** — after migrations run, `scripts/update-fingerprint.ts` recomputes the canonical fingerprint and UPDATEs `schema_fingerprint.fingerprint`. The app's boot-time validation (§7) reads this value and compares to the `db/schema-fingerprint.txt` baked into the build. Mismatch → `process.exit(1)`. Defends against "new code, old schema" or vice versa.
- Failed migration recovery: `scripts/migrate-recover.sh` prompts before marking a partially-applied migration as applied (after manual SQL fix). Pre-deploy DB snapshot in `/backup/cavecms/pre-deploy/<sha>.sql.age` provides rollback; the rollback script auto-restores when the rolled-back release's `schema-fingerprint.txt` does not match the live DB fingerprint.

### Scripts (all idempotent, `set -euo pipefail; IFS=$'\n\t'`, `trap 'echo "FAIL at line $LINENO"' ERR`)

- `scripts/setup.sh` — one-time per box. Creates the `cavecms` system user (no shell), adds `www-data` to the `cavecms` group, creates the `cavecms` DB + `cavecms_user` + `cavecms_migrator` users with scoped grants, mkdirs `/opt/cavecms/{releases,uploads/{originals,variants,brochures-private,.tmp},static-pool}` and `/backup/cavecms/{db,uploads,pre-deploy}` with correct ownership (`cavecms:cavecms 750`) and asserts they all live on the same filesystem (`stat -c %d` equality), drops nginx server blocks (validates with `nginx -t` BEFORE reload), installs the certbot deploy hook (which itself runs `nginx -t && systemctl reload nginx`), prompts for and validates `LOGIN_PATH`, installs `pm2-logrotate`, configures `pm2 startup systemd`, installs systemd timers (db backup at 03:00 + uploads backup at 03:30 + cron-purge at 04:00 with `After=` ordering between them + disk-check hourly + media-refs verify weekly, all with `RandomizedDelaySec=15min`, `Persistent=true`, `IOSchedulingClass=idle` on backups, and `OnFailure=cavecms-alert@%n.service`).
- `scripts/seed-admin.sh` — one-time per box, run by operator after `setup.sh`. Prompts interactively for `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_PASSWORD` (never persisted to `/etc/cavecms/env.*`). Invokes the migrator bundle to insert the seed row with `must_rotate_password = TRUE`.
- `scripts/deploy.sh` — every deploy. Holds `flock -n /var/lock/cavecms-deploy.lock`. Sequence:
  1. Preflight: compute `required_free = size(latest_artifact) × 2 + size(latest_db_dump) + 500MB`; reject if `df --output=avail /opt /backup` < required. MariaDB reachable check. Current `/healthz` returns 200 (skipped on first deploy). Reject if `/var/lib/cavecms/deploy.blocked` exists.
  2. `scripts/preflight.sh` (expand/contract gate — see Migrations subsection).
  3. Rotate release directory (delete oldest if more than 5 retained — BEFORE the new release lands so disk is reclaimed).
  4. rsync prebuilt CI artifact into `/opt/cavecms/releases/<sha>/`.
  5. Symlink `/etc/cavecms/env.<env> → /opt/cavecms/releases/<sha>/.env.local` (chmod 600 preserved).
  6. Pre-deploy DB snapshot: `mysqldump --defaults-extra-file=… --single-transaction --quick --skip-lock-tables --routines --triggers --events --set-gtid-purged=OFF cavecms | gzip | age -r $(cat /etc/cavecms/backup.pub) > /backup/cavecms/pre-deploy/<sha>.sql.age.partial`; verify all `${PIPESTATUS[@]}` are `0`; verify size ≥ 50% of prior snapshot (anomaly guard); rename `.partial` → final.
  7. Run forward migrations via `migrator-bundle/`: `cd /opt/cavecms/releases/<sha> && node migrator-bundle/run.js`. Migrator updates `schema_fingerprint`.
  8. **Merge new static assets into static pool**: `rsync -a /opt/cavecms/releases/<sha>/.next/static/ /opt/cavecms/static-pool/.next/static/` (additive; old chunks remain for at least 7 days). `nginx` aliases `/_next/static` from `/opt/cavecms/static-pool/.next/static/` so clients with stale HTML still resolve their chunks.
  9. Atomic `ln -sfn /opt/cavecms/releases/<sha> /opt/cavecms/current`.
  10. `pm2 startOrReload /opt/cavecms/current/ecosystem.config.cjs --update-env`.
  11. Poll `/healthz` from loopback up to 30 s: require **3 consecutive 200 responses ≥ 1 s apart AND `healthz.commit === <new-sha>`** before declaring success.
  12. `pm2 save` (so PM2 systemd restart picks up the new config).
  13. On any failure: invoke `scripts/rollback.sh`.
- `scripts/rollback.sh` — reads `/opt/cavecms/releases-history.log`, identifies previous release sha. Compares previous release's `schema-fingerprint.txt` against current DB fingerprint; if mismatch (the failed deploy ran a contract migration) → restore the pre-deploy DB snapshot via prompted age-identity decryption AND re-point symlink AND PM2 reload AND poll healthz. If fingerprints match → just symlink revert + reload.
- `scripts/preflight.sh` — scans `db/migrations/*.sql` for destructive statements; reject deploy unless `ALLOW_CONTRACT=1`.
- `scripts/finalize.sh` — invoked manually (or via a separate "contract" workflow) AFTER a new release has been stable. Runs contract-class migrations with `ALLOW_CONTRACT=1` set.
- `scripts/db-backup.sh` — `mysqldump --defaults-extra-file=/root/.cavecms-backup.cnf --single-transaction --quick --skip-lock-tables --routines --triggers --events --set-gtid-purged=OFF cavecms | gzip | age -r $(cat /etc/cavecms/backup.pub) > /backup/cavecms/db/<date>.sql.age.partial`; check `${PIPESTATUS[@]}`; size-anomaly guard (≥ 50% of yesterday); rename `.partial` → final; on failure remove `.partial`. `flock`-serialized against deploy lock to avoid races. `ionice` class idle. Weekly: `age --decrypt --identity=<test-identity-from-stdin>` round-trip test on the latest dump (drill).
- `scripts/uploads-backup.sh` — `rsync -a --delete-after /opt/cavecms/uploads/{originals,variants,brochures-private}/ /backup/cavecms/uploads/`. Encrypted via age-on-rsync-target only if `BACKUP_RSYNC_REMOTE` set to an `rclone` destination.
- `scripts/cron-purge.ts` — invoked nightly by systemd timer. Hard-deletes soft-deleted rows past retention windows (content_blocks, projects, posts, media unreferenced, login_attempts, audit_log, notification_failures resolved). Wrapped in `if (process.env.NODE_ENV !== 'production') throw new Error('production-only')` so dev/CI invocations abort before touching data.
- `scripts/verify-media-refs.ts` — weekly. Rebuilds `media_references` from scratch by walking every block/section/typed-FK and logs drift to `audit_log`.
- `scripts/restore-drill.sh` — designed to run on a SEPARATE machine (NOT the production droplet). Decrypts the latest dump using an age identity pasted at stdin (no on-disk identity file), restores to a scratch MariaDB instance, runs `pnpm db:migrate` (asserts no pending migrations), points a local Next.js at it, smokes home + projects + admin login. Drill date logged in `README.md`.
- `scripts/disk-check.sh` — hourly. When `df --output=pcent /` ≥ 80 → warn to `journald`. ≥ 90 → page (email + create `/var/lib/cavecms/deploy.blocked`). Cleared manually after disk pressure resolved.

### `pnpm dev` (predev hook)

```
predev:
  - require MariaDB reachable (start systemctl/brew if not, never fail silently)
  - pnpm db:migrate
  - if (users empty) → pnpm db:seed   (reads INITIAL_ADMIN_* from .env.local; sets must_rotate_password=true)
  - require typecheck passes (warn, do not fail)
dev:
  - next dev -p 3040 --turbopack
```

### nginx server block (template under `scripts/nginx/cavecms.conf.template`)

Snippets included by each 443 block: `cavecms-proxy.conf` (proxy headers), `cavecms-tls.conf` (TLS hardening), `cavecms-compression.conf` (gzip + brotli_static).

```
# Port 80 → 443
server {
  listen 80;
  server_name bestworldcompany.com www.bestworldcompany.com staging.bestworldcompany.com;
  return 301 https://$host$request_uri;
}

# www → apex
server {
  listen 443 ssl http2;
  server_name www.bestworldcompany.com;
  ssl_certificate     /etc/letsencrypt/live/bestworldcompany.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bestworldcompany.com/privkey.pem;
  return 301 https://bestworldcompany.com$request_uri;
}

# apex
server {
  listen 443 ssl http2;
  server_name bestworldcompany.com;
  ssl_certificate     /etc/letsencrypt/live/bestworldcompany.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/bestworldcompany.com/privkey.pem;

  client_max_body_size 30m;
  log_format cavecms_json escape=json '{"ts":"$time_iso8601","ip":"$remote_addr","method":"$request_method","path":"$request_uri","status":$status,"bytes":$body_bytes_sent,"rt":$request_time,"ua":"$http_user_agent","ref":"$http_referer"}';
  access_log /var/log/nginx/cavecms-access.log cavecms_json;
  error_log  /var/log/nginx/cavecms-error.log warn;

  # Static directly from disk — STATIC POOL retains old chunks for in-flight HTML
  location ^~ /_next/static/ {
    alias /opt/cavecms/static-pool/.next/static/;
    expires 1y;
    add_header Cache-Control "public, immutable";
    add_header X-Content-Type-Options "nosniff";
    gzip_static on;
    # brotli_static on;   # if libnginx-mod-http-brotli installed
  }
  location ^~ /uploads/originals/ {
    alias /opt/cavecms/uploads/originals/;
    expires 30d;
    add_header Cache-Control "public, max-age=2592000";
    add_header X-Content-Type-Options "nosniff";
  }
  location ^~ /uploads/variants/ {
    alias /opt/cavecms/uploads/variants/;
    expires 30d;
    add_header Cache-Control "public, max-age=2592000";
    add_header X-Content-Type-Options "nosniff";
  }

  # Hidden login + login API: no access log
  location = /__LOGIN_PATH__   { access_log off; proxy_pass http://127.0.0.1:3040; include /etc/nginx/snippets/cavecms-proxy.conf; }
  location = /api/auth/login   { access_log off; proxy_pass http://127.0.0.1:3040; include /etc/nginx/snippets/cavecms-proxy.conf; }

  # Streaming CSV export: disable buffering
  location = /api/admin/leads/export {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    chunked_transfer_encoding on;
  }

  # Image upload: extended read timeout
  location = /api/cms/media {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
  }

  # Maintenance fallback on upstream errors (covers PM2 reload window)
  error_page 502 503 504 @maint;
  location @maint {
    root /var/www;
    try_files /cavecms-maint.html =503;
    add_header Cache-Control "no-store" always;
  }

  # Everything else → Next.js
  location / {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 2;
    proxy_next_upstream_timeout 2s;
  }
}

# staging — IP allowlist + basic auth + noindex
server {
  listen 443 ssl http2;
  server_name staging.bestworldcompany.com;
  ssl_certificate     /etc/letsencrypt/live/staging.bestworldcompany.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/staging.bestworldcompany.com/privkey.pem;
  client_max_body_size 30m;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

  satisfy any;                      # both rules can pass
  allow 1.2.3.4;                    # client office IP (configured at setup)
  allow 5.6.7.8;                    # dev IP
  deny  all;
  auth_basic "staging";
  auth_basic_user_file /etc/nginx/.htpasswd-cavecms-staging;

  # Block public lead form submission on staging (return 410 Gone)
  location ^~ /api/leads/ { return 410; }

  location / {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
  }
}
```

`/etc/nginx/snippets/cavecms-proxy.conf`:
```
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, not append
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_read_timeout 30s;
proxy_send_timeout 30s;
client_max_body_size 30m;
```

`/etc/nginx/snippets/cavecms-tls.conf`:
```
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
ssl_stapling on;
ssl_stapling_verify on;
resolver 1.1.1.1 1.0.0.1 valid=300s;
resolver_timeout 5s;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
```

`/etc/nginx/snippets/cavecms-compression.conf`:
```
gzip on;
gzip_vary on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css text/csv text/xml application/json application/javascript application/xml+rss image/svg+xml application/manifest+json;
gzip_proxied any;
```

`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` (installed by setup.sh):
```
#!/bin/bash
set -euo pipefail
nginx -t || { logger -t certbot-deploy "nginx -t failed after renewal; NOT reloading"; exit 1; }
systemctl reload nginx
logger -t certbot-deploy "nginx reloaded after cert renewal for ${RENEWED_DOMAINS:-unknown}"
```

A monthly cron runs `openssl x509 -checkend $((30*86400)) -in /etc/letsencrypt/live/bestworldcompany.com/fullchain.pem` and emails on < 30 days remaining (catches silent renewal failures).

### systemd timers

```
[Unit] Description=CaveCMS nightly DB backup
[Timer] OnCalendar=*-*-* 03:00:00
        RandomizedDelaySec=15min
        Persistent=true
[Install] WantedBy=timers.target

# Uploads backup: OnCalendar=*-*-* 03:30:00, otherwise identical
# Cron purge: OnCalendar=*-*-* 04:00:00
# Disk check: OnCalendar=hourly
# Media verify: OnCalendar=weekly
```

### Logs & log rotation

- pm2-logrotate: `max_size 10M`, `retain 14`, `compress true`, `rotateInterval '0 0 * * *'`.
- nginx logs `/var/log/nginx/cavecms-*.log` rotated by logrotate (7d retention, compressed).
- nginx `access_log off` on `LOGIN_PATH` and `/api/auth/login`.
- App logs (PM2 stdout) never log full request URLs; only `pathname` for safe routes.

### Disk monitoring

`scripts/disk-check.sh` hourly: when `df --output=pcent /` ≥ 85% → log warning to `journald`, email the admin (if SMTP configured).

### Backups: encrypted, age, off-site mandatory for prod

- DB: `mysqldump --single-transaction --quick --skip-lock-tables --routines --triggers --events --set-gtid-purged=OFF cavecms | gzip | age -r $(cat /etc/cavecms/backup.pub)` → `/backup/cavecms/db/<date>.sql.age` (`.partial` rename pattern). `--single-transaction` avoids holding a global lock that would block writes for the OTHER apps sharing this MariaDB. Retention `DB_BACKUP_RETENTION_DAYS` (default 30).
- Uploads rsync (encryption optional; rsync target is local-only by default). Retention `UPLOADS_BACKUP_RETENTION_DAYS` (default 7).
- **Off-site is required for production**: enable `rclone copy /backup/cavecms/db/ <remote>:cavecms-backups/db/` nightly to S3-compatible storage (DigitalOcean Spaces or Backblaze B2). The dumps are already age-encrypted on disk so the remote target doesn't need its own at-rest encryption to be sufficient. Off-site target configured in `/etc/cavecms/rclone.conf` (`chmod 600`, root only). **`scripts/restore-drill.sh` confirms off-site recoverability** monthly.
- **Age key custody**: `/etc/cavecms/backup.pub` is the public key, on the droplet. The matching **age identity (private key) is generated off-host and NEVER written to the droplet** — stored in the operator's password manager AND a sealed-envelope physical copy held by the client. Rotate every 12 months (re-encrypting last 30 days of dumps with the new recipient on rotation). `BACKUP_AGE_FINGERPRINT` env var carries the recipient's fingerprint so the app refuses to start if the configured public key has been silently substituted.
- nginx never serves `/backup/*`: setup.sh asserts no nginx `location` block references `/backup`.
- Restore procedure detailed in §12.

### `.env` and secrets

`.gitignore` (see the actual repo file for the full pattern set) blocks `.env`, `.env.*` (allowlisting only `.env.example`), wildcards `*.env`, swap files, AND crypto/key artifacts (`*.age`, `*.key`, `id_rsa*`, `*.p12`, `.htpasswd*`, etc.).

Pre-commit hook in CI rejects any file matching `^\.env(\..+)?$` (except `.env.example`) AND any pattern in the crypto-key denylist.

Env files on the droplet live in `/etc/cavecms/env.production` and `/etc/cavecms/env.staging` (`chmod 600 root:cavecms`). `deploy.sh --env <name>` symlinks the right file into the release dir as `.env.local` — this is the SINGLE env mechanism (no PM2 `env_file`; PM2 inherits the process env and Next.js loads `.env.local` natively). To rotate a secret: edit the central file, `pm2 reload cavecms`.

**`INITIAL_ADMIN_*` are NEVER persisted to `/etc/cavecms/env.production`.** They are prompted interactively by `scripts/seed-admin.sh` on first deploy only, used to insert the seed row, and discarded from the shell history (`set +o history` around the prompt). Subsequent restarts do not require these vars.

### Supply chain

- `pnpm install --frozen-lockfile` in CI and on deploy.
- `.npmrc` with `registry=https://registry.npmjs.org/`, `package-manager-strict=true`, `auto-install-peers=true`.
- All dependency versions pinned exactly (no `^`/`~`) in `package.json`.
- CI step `pnpm audit --prod --audit-level=high` that fails the build.
- `pnpm install --ignore-scripts` followed by `pnpm rebuild sharp` (explicit allow-list of one).
- `predev` runs migrations against the local DB inside a NODE_ENV check.

### Cutover plan

**Phase 1 — Build (staging only)**
- DNS: `staging.bestworldcompany.com` → droplet IP (apex untouched). TTL not relevant yet (staging is new).
- nginx staging server block: IP-allowlist + basic auth + noindex + lead-API 410.
- Client reviews iteratively.

**Phase 2 — Pre-flip checklist**
- All projects published with content + brochure PDFs.
- Initial admin user created, credentials handed to client out-of-band; `must_rotate_password=true` forces rotation on first login.
- Smoke test every public page + every form on staging.
- Restore drill executed (see §12).
- Apex nginx server block ready (mirrors staging, no IP allowlist, no basic auth, indexable).
- 301 redirects in `slug_redirects` and explicit nginx-level redirects for old paths (`/about-us` → `/about`, etc.).
- Apex cert pre-issued (`certbot certonly --dry-run` succeeds).
- DNS TTL on apex lowered to 60 s 24 hours before flip.

**Phase 3 — Flip** (low-traffic hour, Ghana time)
- A record on apex → droplet IP.
- Monitor logs + `/healthz` for 30 min.
- Restore TTL to 3600 s after 7 stable days.

**Phase 4 — Sunset staging**
- Empty staging `leads`, `audit_log`, `pending_emails`, `notification_failures`.
- `UPDATE users SET tokens_valid_after = NOW()` on staging to invalidate all outstanding JWTs (there is no sessions table).
- Keep staging for ongoing edits-before-publish dry runs.

### Handover

- Admin credentials delivered out-of-band; first-login flow forces password rotation.
- Loom walkthrough (≤ 10 min) covering: edit a page, add a project, view a lead, add a team member, write a blog post.
- `/admin/help` route inside the dashboard with the same content as the Loom transcript + searchable.

### Monitoring

- PM2 process metrics (`pm2 monit`).
- nginx access + error logs (JSON-escaped).
- `audit_log` is the content + auth observability layer.
- Optional external uptime ping on `/healthz` (UptimeRobot free tier).
- No external observability SaaS in v1.

---

## 12. Testing

| Layer | Tool | What's tested |
|---|---|---|
| Unit | Vitest | Auth helpers (scrypt versioned, JWT sign/verify, CSRF HMAC binding), Zod schemas for every block_type and project_section, sharp variant generation, lead validation, email-template HTML escape + header CRLF strip, slug-redirect resolution, mask.ts PII redaction |
| Integration | Vitest + real local MariaDB | DB queries against real migrations; no mocks. Test DB seeded per-suite, dropped after. Reuses Drizzle connection. Tests: optimistic-lock conflict, reorder TX, media atomic upload (including failure rollback), media_references maintenance, slug-redirect chain collapse, expand/contract migration drill |
| E2E | Playwright | Login at hidden path, /admin unauthenticated → 307 to / (NOT to login path); generic 404 doesn't echo the URL; CSP nonces stamped; cookies have __Host- prefix; inline edit save reflected on public page after revalidate; project CRUD with RBAC denial paths; public form submit → lead row + email enqueue; image upload → all four variants present; brochure form → signed-URL email; CSP headers and security headers present; HSTS preload; staging blocks /api/leads/*; preview link renders + carries noindex |
| RBAC contract | Vitest | Driven by `tests/shared/rbac-matrix.ts`: explicit table mapping every API route to `{anon, viewer, editor, admin}` expected status code (401/403/200). CI scans `app/api/**/route.ts` for any new route file not present in the matrix and fails. |
| Security | Manual + Playwright | Login path never leaks in redirects / errors / headers / sitemap / robots. Error wrapper never returns SQL or stack. Honeypot, reCAPTCHA, rate limits behave as specified. Lockout dual-key triggers correctly. JWT replay after `tokens_valid_after` bump → 401. |
| Restore drill | Manual, scripted | `scripts/restore-drill.sh`: spin up a scratch DB on the droplet, decrypt the latest backup with the age key, restore, run `pnpm db:migrate` (no pending migrations), rsync uploads to a scratch dir, point a local Next.js at scratch DB + scratch uploads, smoke-test home + projects + admin login. Required to pass before cutover and quarterly. Log dates in README. |
| Performance | Vitest + Playwright | LCP/CLS budget on /; sitemap response < 100 ms; lead inbox listing 1000 rows < 200 ms; upload of a 8 MB JPEG completes < 8 s (serial variants); CSV export of 10 k leads streams under 30 s; `EXPLAIN` on the inbox query uses `idx_leads_source_status_created`; abort-mid-stream returns pool to baseline within 5 s |
| Concurrency | Vitest | Two concurrent saves on the same block: one succeeds, one gets 409; reorder TX with simulated mid-operation interrupt rolls back cleanly |

`npm run typecheck` and `npm run lint` wired into `predev` and CI. Lint config bans `dangerouslySetInnerHTML` outside `lib/cms/parse.ts` + markdown render.

---

## 13. Definition of done

- All 8 public routes render content from DB with correct ISR cache tags. Tag taxonomy (§6) enforced — no inline tags.
- Inline edit works on every page section type per the v1 block registry (§5). Save flow with optimistic locking — verified with two concurrent browsers.
- All 10 project section types implemented per schemas (§5).
- All 4 lead sources captured to DB + email queue → 200 returned before SMTP completes.
- RBAC enforced server-side on every API route via `requireRole`. Field-level Zod allowlist per role. RBAC matrix Vitest passes.
- Hidden login + `/admin` → 307 → `/` for unauthenticated; LOGIN_PATH never leaks in code, in `<Link>`s, in error pages, in OG cards, in sitemap, in robots, in nginx access logs.
- Boot-time secret validation passes; missing or short secrets cause `process.exit(1)`.
- Security headers present: `poweredByHeader: false`, CSP nonce-based (or documented `OPEN-ITEM-1` deviation), COOP/CORP, HSTS preload, no `unsafe-eval`.
- CSRF session-bound on every mutation, double-submit cookie + header pattern; pre-auth variant for login.
- Rate limits + dual-key progressive lockout + credential-spray detector all wired and verified.
- Honeypot + reCAPTCHA on every public form. reCAPTCHA timeout policy enforced.
- Audit log captures every CMS write AND auth event. Diff format is field-level patch.
- Sitemap + robots dynamic; canonical URLs strip query params; preview pages set noindex.
- JSON-LD: Organization on every page, Residence on each project, BlogPosting on each post; built from already-fetched data.
- Migrations expand/contract discipline documented; pre-deploy snapshot taken; rollback script tested.
- Setup + deploy + rollback + restore scripts all idempotent, `set -euo pipefail`. `pnpm dev` auto-bootstraps. No manual server commands.
- Backups (DB + uploads) running on schedule, encrypted with age, restored at least once before launch.
- `/opt/cavecms/uploads` owned `cavecms:cavecms` chmod 750; brochures-private not served by nginx.
- nginx serves /_next/static and /uploads/* directly. App on loopback only (UFW blocks 3040 publicly).
- `/healthz` returns minimal `{ status: 'ok' }` for non-loopback callers; verbose `{ status, commit, db_ping, pool_free, schema_fingerprint, secrets_ok, uptime_s }` only when `req.socket.remoteAddress === '127.0.0.1'` (used by deploy poller and LAN uptime probes). Deploy poller requires 3 consecutive 200s ≥ 1 s apart AND `healthz.commit === <new-sha>`.
- Brand audit produced `docs/brand/audit-<date>.md` and `lib/theme/tokens.ts`. Every public page uses theme tokens (no raw hex). Logo SVG in `public/brand/`. `@font-face` for brand typeface. Client visual sign-off on Home, About, Projects index, one project detail.
- Client can edit content, add a project, view leads, write a blog post, and recover a soft-deleted block from `/admin/trash` without dev help.
- Cutover from staging → apex executed with zero data loss and verified via post-flip smoke test.

---

## 14. Open items deferred to implementation

- Exact `LOGIN_PATH` value (picked at setup time).
- Final brand palette + typography (extracted during the implementation brand-audit step).
- Backup destination path on the droplet (`/backup/cavecms/...` assumed).
- Initial admin email/name for the seed (delivered via `.env.local`).
- IP allowlist values for staging nginx (depends on the client's office IPs).
- `OPEN-ITEM-1` — confirm CSS nonce works with Next.js 15.5.4 in production. If not, accept `style-src 'unsafe-inline'` at launch and target removal within 30 days.
- Off-site backup target (rclone destination — defaults disabled; enable at the user's discretion).

---

## 15. Tunables & environment variables

All defaults sensible; override in `/etc/cavecms/env.<env>` per environment. Boot-time validation throws on missing required vars. `NEXT_PUBLIC_*` vars are inlined at CI build time, not at runtime.

```
# Required — secrets (openssl rand -base64 64)
JWT_SECRET=                          # ≥ 32 bytes
CSRF_SECRET=                         # ≥ 32 bytes
PREVIEW_SECRET=                      # ≥ 32 bytes, distinct from JWT_SECRET
BROCHURE_SECRET=                     # ≥ 32 bytes, for signed brochure URLs
DATABASE_URL=mysql://cavecms_user:CHANGEME@127.0.0.1:3306/cavecms
DATABASE_MIGRATOR_URL=mysql://cavecms_migrator:CHANGEME@127.0.0.1:3306/cavecms

# Required — hidden login
LOGIN_PATH=                          # ^[a-z0-9-]{6,32}$

# Required — SMTP (user-managed infra; app-agnostic)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Best World Properties

# Required — reCAPTCHA v3
RECAPTCHA_SECRET=
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=      # inlined at CI build time per GitHub Environment, NOT loaded at runtime on the droplet

# First-deploy only — NEVER persisted to /etc/cavecms/env.production. Prompted by scripts/seed-admin.sh and consumed once.
INITIAL_ADMIN_EMAIL=
INITIAL_ADMIN_NAME=
INITIAL_ADMIN_PASSWORD=

# Required — backup
BACKUP_AGE_RECIPIENT=                # age public key (recipient string)
BACKUP_AGE_FINGERPRINT=              # SHA fingerprint of the recipient; app refuses to start on mismatch

# Optional — tunables with sensible defaults (all wired into code per §7)
PORT=3040
NODE_ENV=production
JWT_TTL_SECONDS=28800                # 8 h
JWT_RENEW_AFTER_SECONDS=1800         # re-sign when this much remains (with same jti, same oat)
JWT_ABSOLUTE_MAX_SECONDS=86400       # hard cap from oat
CSRF_TTL_SECONDS=3600
PREVIEW_TTL_SECONDS=900               # 15 min
BROCHURE_TOKEN_TTL_SECONDS=604800     # 7 d
SOFT_DELETE_RETENTION_DAYS=30
UPLOADS_BACKUP_RETENTION_DAYS=7
DB_BACKUP_RETENTION_DAYS=30
AUDIT_LOG_RETENTION_DAYS=730
LOGIN_ATTEMPTS_RETENTION_DAYS=30
NOTIFICATION_FAILURES_RETENTION_DAYS=30
USER_KNOWN_IPS_RETENTION_DAYS=90
MAX_IMAGE_UPLOAD_BYTES=10485760       # 10 MiB
MAX_PDF_UPLOAD_BYTES=26214400         # 25 MiB
RECAPTCHA_TIMEOUT_MS=3000
RECAPTCHA_THRESHOLD=0.5
SMTP_CONNECTION_TIMEOUT_MS=5000
SMTP_SOCKET_TIMEOUT_MS=10000
SMTP_POOL_MAX_CONNECTIONS=3
SMTP_RETRY_ATTEMPTS=3
DB_POOL_LIMIT=15                      # mysql2 pool size; consumed by db/client.ts
DB_POOL_ACQUIRE_TIMEOUT_MS=5000
DB_STATEMENT_TIMEOUT_MS=10000         # SET STATEMENT max_statement_time on each connection
HANDLER_TIMEOUT_MS=15000              # wired into lib/api/withError.ts via AbortSignal.timeout()
UPLOAD_HANDLER_TIMEOUT_MS=60000       # per-route override on /api/cms/media
RATE_LIMIT_LOGIN_IP=3
RATE_LIMIT_LOGIN_IP_WINDOW_S=60
RATE_LIMIT_LOGIN_EMAIL=5
RATE_LIMIT_LOGIN_EMAIL_WINDOW_S=300
RATE_LIMIT_LEADS_IP=5
RATE_LIMIT_LEADS_WINDOW_S=900
RATE_LIMIT_CSRF_SESSION=120
RATE_LIMIT_CMS_USER=60
RATE_LIMIT_LOGIN_PAGE_GET=10          # GET /[LOGIN_PATH] per IP
RATE_LIMIT_DEFAULT_IP=120
SPRAY_DETECTOR_DISTINCT_EMAILS=5
SPRAY_DETECTOR_WINDOW_MIN=15
SPRAY_DETECTOR_LOCK_MIN=60
# Image variant widths are NOT tunable — the keys (thumb/md/lg/og) are a fixed contract.
```

---

## 16. Risk register (deliberate residual risks)

| Risk | Severity | Mitigation | Accept |
|---|---|---|---|
| `pm2 reload` on a single fork instance is effectively a brief restart, dropping in-flight requests | LOW | `kill_timeout: 8000` + nginx maintenance fallback (`error_page 502/503/504 → cavecms-maint.html`) + `proxy_next_upstream`; deploys at low-traffic hours | Yes — true blue/green via two PM2 instances + DB-backed rate limits is v2 |
| In-memory rate limit Maps lose state on PM2 restart | LOW | DB-backed lockout via `failed_logins_by_email/ip` + windowed reads of `login_attempts` cover the auth case; non-auth limits recover within their window | Yes |
| Rich-text allow-list is conservative; no tables, code blocks, embeds in section blocks (only in posts via markdown) | LOW | Explicit allow-lists in §7 | Yes |
| reCAPTCHA fail-open during Google outage may admit spam | LOW | Honeypot + rate limit still enforced; `notification_failures` (kind=`recaptcha_degraded`) logs the degraded mode | Yes |
| `style-src 'unsafe-inline'` may ship at launch if Next.js 15 CSS nonce is unreliable | MEDIUM | `OPEN-ITEM-1`; target removal within 30 days post-launch | Conditional |
| Single droplet — no HA | MEDIUM | Daily encrypted backups + mandatory off-site (rclone to Spaces/B2) + monthly restore drill + documented rollback | Yes (cost trade) |
| Concurrent project archive while admin is editing a section surfaces only as a UI warning, not a hard block | LOW | Warning surfaced; archive doesn't cascade-delete sections | Yes |
| `cavecms_user` DB user has CREATE/ALTER on `cavecms.*` (needed for some legacy migrations) | LOW | `cavecms_migrator` is the only user with DROP; app-runtime queries via `cavecms_user` only | Yes |
| Locked-out admin needs a "known good IP" entry to bypass — fresh admin from a new location is fully locked until window expires | LOW | Window decay is 30 min/3 h/24 h tiered; out-of-band recovery via `scripts/admin-unlock.sh` invoked by sysop | Yes |
| Brochure PDF, once delivered, is shareable indefinitely within 7 days (signed URL); single-use enforces only the first download | LOW | 7-day expiry + single-use + `BROCHURE_SECRET` rotation invalidates outstanding links | Yes |
| Posts and team bios render via server-side markdown; advanced content (interactive embeds) requires a code change | LOW | Rich-text allow-list is the explicit boundary | Yes |
| Production seed admin password is shared interactively via shell; if shell history is captured it could be exposed | LOW | `set +o history` around prompt; `must_rotate_password = TRUE` forces rotation on first login; credential is short-lived working secret | Yes |
