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
