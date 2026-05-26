# Admin help

This is a quick orientation for editors and admins. If you cannot find what
you need here, ping the admin channel.

## Roles at a glance

- **Admin** — can do everything. Manages users, settings, projects, posts,
  trash. Publish toggle, archive, last-admin invariant.
- **Editor** — can create + edit projects, posts, leads, recover from
  trash. Cannot publish, cannot manage users or settings.
- **Viewer** — read-only. Sees the dashboard, masked leads inbox, and
  help. Cannot open lead detail or export.

Every mutating action you take is recorded in the audit log under
**Activity** (admins only).

## How to edit a page

1. Sign in.
2. Visit the page you want to edit on the public site.
3. Click **Enter edit mode** at the bottom-right corner.
4. Hover any section → click **Edit**.
5. Make your changes → **Save**.

Soft-deleted blocks land in **Trash** and can be restored for thirty days.

## How to add a project

1. Open **Projects** in the sidebar.
2. Enter a name and a slug (lowercase, dashes, e.g. `jamestown-villas`).
3. Click **Create**.
4. Open the new project on the public site and edit each section in place.
5. When ready, an admin flips the **Publish** toggle on the projects list.

Drag rows to reorder. The order on this list controls the order on the
public listings page.

## How to view leads

1. Open **Leads** in the sidebar.
2. Filter by source (contact / brochure / inquiry) and status if useful.
3. Click any row to open the detail drawer (admin and editor only).
4. Move the lead through **new → contacted → won / lost**.
5. **Export CSV** downloads every lead in the database (admin and
   editor only). The filters on this page apply to the list view; the
   CSV always exports the full set.

Viewers see masked rows — initials, partial email, last four digits of
phone, message with emails and phones stripped.

## How to write a blog post

1. Open **Posts** in the sidebar.
2. Click **New post**, give it a title and slug.
3. Edit the body markdown in the editor. **Preview** renders the
   sanitized HTML the public page would show.
4. Toggle **Published** when ready (admin only).

Slug renames issue a 308 permanent redirect from the old URL.

## How to add a team member

1. Open **Team** in the sidebar.
2. Enter the name and role.
3. Drag rows to reorder.

## How to manage users

1. Open **Users** in the sidebar (admin only).
2. **Invite teammate** — fill the form and click **Create**. The user is
   forced to rotate the initial password on their first sign-in.
3. Change a user's role with the dropdown, or **Deactivate** to revoke
   access. Every save prompts you to re-confirm your own password.

You cannot demote or deactivate the last remaining admin, and you cannot
modify your own account from this page.

## How to edit site-wide settings

1. Open **Settings** in the sidebar (admin only).
2. Each entry is a JSON document validated against a strict schema.
3. Edit the JSON inline → **Save**. You will be prompted to re-confirm
   your password.

Schema validation refuses malformed values before they touch the database.

## How to read the activity feed

- **Audit log** records every CMS mutation (create / update / delete /
  restore / reorder).
- **Alerts** surfaces unresolved background failures: SMTP delivery,
  cache revalidation, reCAPTCHA degradation, RBAC field rejections.

Use the **Email alerts** card on the dashboard as a quick deep-link.
The **AI activity** chip at the top of the audit log narrows the view
to proposals, accepts, and dismisses from the AI writing partner.

## AI Assistant

The AI writing partner appears as a sparkle on every section in edit
mode, and as a Page Assistant chat in the bottom-left of any page
you're editing.

### Get a key

The AI uses your Google Gemini API key — you bring your own. Free
tier is generous; you'll pay pennies for typical use.

1. Go to https://aistudio.google.com/apikey
2. Create a key, copy it
3. Paste it into **Settings → AI Assistant**
4. Click **Test connection**, then **Save**

### What the AI can touch

- The words inside your blocks (headings, body text, captions, button
  labels, eyebrows, quotes, etc.)
- The arrangement of blocks on the current page (only when using the
  Page Assistant chatbot)
- Block visibility / inserts / deletes on the current page (chat only;
  fixed blocks like the contact form on `/contact` can't be removed)

### What the AI cannot touch

- Your settings, users, or security configuration
- Your media library (it can refer to existing images by ID, but it
  cannot upload, alter, or generate images)
- Pages other than the one you're editing
- Any code or files on your server

This isn't a promise — it's enforced by what the AI has access to.
The tools we give it never reach beyond block content on the current
page. There is no way for a clever prompt to break out.

### Tones

Click the sparkle on any block, then pick a tone:

- **Punchier** — same meaning, fewer words, more energy
- **Shorter** — reduce length ~30% without losing meaning
- **Longer** — expand with concrete detail
- **Warmer / Friendlier** — more inviting, conversational
- **More professional** — crisper, business-appropriate
- **More casual** — loosen up, drop formality
- **More playful** — light, witty
- **More authoritative** — confident, declarative
- **Simpler** — plain language, drop jargon
- **More elegant** — considered, editorial quality

You can also type a free-form instruction in your own words.

### The Page Assistant chat

Bottom-left sparkle on any edit page → expands into a chat panel. Ask
it to rework the whole page, restructure sections, add a closing
quote, translate everything to French — whatever you'd ask a human
editor. The AI proposes a set of changes; you review each one in the
proposal tray and accept or dismiss individually.

### Troubleshooting

- **"Stored key could not be decrypted"** — usually means the
  `SECRETS_ENCRYPTION_KEY` in your env file rotated. Re-paste your
  Gemini key in **Settings → AI Assistant** to refresh.
- **"Gemini rejected the API key"** — the key is invalid or revoked.
  Generate a new one at AI Studio.
- **"Could not reach generativelanguage.googleapis.com"** — your
  server's firewall is blocking outbound to Google. Allow that host.
- **"Slow down — only N checks per minute"** — you've hit the rate
  limit. Wait a moment and try again.

### Privacy

Block content goes to Gemini so it can write the rewrite. Your
settings, users, secrets, leads, audit log, and other pages never
leave your server. The encrypted Gemini key stays in your database;
the dashboard only shows the last 4 characters to confirm which key
is on file.
