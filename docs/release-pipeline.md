# CaveCMS release pipeline

**Audience**: you (Derrick) — the sole maintainer. This describes how a
release becomes a thing operators can install or auto-update to.

---

## Where releases live

A static origin at **`https://updates.cavecms.com`** serves three
kinds of artifacts:

```
https://updates.cavecms.com/
├── manifest.json                         ← always current; CaveCMS instances poll this
├── manifest.json.sig                     ← Ed25519 signature over manifest.json
├── pubkey.pem                            ← Ed25519 public key, published once, rotated rarely
├── latest.zip                            ← symlink to the most recent versioned zip
├── latest.zip.sha256                     ← convenience checksum file for latest.zip
└── releases/
    ├── cavecms-1.0.0.zip                 ← the actual release artifact
    ├── cavecms-1.0.0.zip.sha256
    ├── cavecms-1.0.0.zip.sig             ← Ed25519 sig over the zip
    ├── cavecms-1.1.0.zip
    ├── cavecms-1.1.0.zip.sha256
    ├── cavecms-1.1.0.zip.sig
    └── …
```

The marketing site lives separately at **`cavecms.com`** (Next.js, deployed
from the `cavecms-web` repo). `updates.cavecms.com` serves ONLY the release
artifacts above — it runs no marketing app.

---

## `manifest.json` shape

```json
{
  "latestVersion": "1.1.0",
  "publishedAt": "2026-06-15T10:00:00Z",
  "releases": [
    {
      "version": "1.1.0",
      "publishedAt": "2026-06-15T10:00:00Z",
      "downloadUrl": "https://updates.cavecms.com/releases/cavecms-1.1.0.zip",
      "sha256": "9f2c…",
      "signature": "MEUCIQ…",
      "notes": "## What's new\n\n- Auto-resizing media library\n- Faster page render…",
      "isSecurity": false,
      "minPreviousVersion": "1.0.0"
    },
    {
      "version": "1.0.1",
      "publishedAt": "2026-05-30T09:00:00Z",
      "downloadUrl": "https://updates.cavecms.com/releases/cavecms-1.0.1.zip",
      "sha256": "7a3e…",
      "signature": "MEYCIQD…",
      "notes": "## Security fix\n\nFixes CVE-2026-XXXX in lead-form CSRF handling. Update recommended.",
      "isSecurity": true,
      "minPreviousVersion": "1.0.0"
    },
    {
      "version": "1.0.0",
      "publishedAt": "2026-04-01T12:00:00Z",
      "downloadUrl": "https://updates.cavecms.com/releases/cavecms-1.0.0.zip",
      "sha256": "1b9d…",
      "signature": "MEYCIQC…",
      "notes": "## First public release\n\nWelcome to CaveCMS.",
      "isSecurity": false
    }
  ]
}
```

Field semantics:

| Field | Meaning |
|---|---|
| `latestVersion` | What every CaveCMS instance should compare against. Drives the "update available" banner. |
| `releases[]` | Reverse-chronological (newest first). Operators can install any version listed here. |
| `isSecurity` | If true, instances with `autoApplySecurityPatches: true` install without an admin click. |
| `minPreviousVersion` | Cap on auto-upgrade jumps. If an operator is on 0.9.x and `minPreviousVersion: 1.0.0`, they must manually step through 1.0 before auto-installing this. |
| `signature` | Base64 Ed25519 signature over the zip's bytes, verifiable with `pubkey.pem`. |
| `notes` | Markdown. Rendered as-is in the operator's "What's new" card. Write hand-crafted release notes — not commit messages. |

---

## Publishing a release — the manual flow

For now (until you have a CI worker), this is a script you run on your
laptop after tagging a release.

### 1. Tag + build

```bash
cd ~/portfolio/cavecms
git checkout main
git pull
git tag -s v1.1.0 -m "v1.1.0 — release notes summary"
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm build` produces `.next/standalone` and `.next/static`. The released
zip contains:

```
cavecms-1.1.0/
├── .next/standalone/         ← the runtime
├── .next/static/             ← static assets
├── public/                   ← public dir (icons, etc.)
├── db/migrations/            ← Drizzle SQL files (run by bootstrap.sh)
├── scripts/                  ← bootstrap.sh, cavecms-update.sh, etc.
├── ecosystem.config.cjs      ← PM2 config
├── package.json              ← for pnpm install --prod
├── pnpm-lock.yaml
├── LICENSE.md
├── AGENTS.md
├── README.md
└── VERSION                   ← single-line: "1.1.0"
```

No `app/`, `components/`, `lib/`, `db/schema/`, `db/seeds/`, `tests/` —
those are source-only. The standalone build inlines everything it needs.

### 2. Sign + checksum

```bash
# (one-time setup) Generate your Ed25519 keypair
openssl genpkey -algorithm ed25519 -out ~/.cavecms-release-private.pem
openssl pkey -in ~/.cavecms-release-private.pem -pubout -out ~/.cavecms-release-public.pem

# Per release:
ZIP=cavecms-1.1.0.zip
sha256sum "$ZIP" > "$ZIP.sha256"
openssl pkeyutl -sign -inkey ~/.cavecms-release-private.pem \
  -rawin -in "$ZIP" | base64 -w 0 > "$ZIP.sig"
```

### 3. Update + sign the manifest

```bash
# Edit manifest.json: prepend the new release entry, bump latestVersion + publishedAt
$EDITOR manifest.json

# Sign the manifest itself
openssl pkeyutl -sign -inkey ~/.cavecms-release-private.pem \
  -rawin -in manifest.json | base64 -w 0 > manifest.json.sig
```

### 4. Upload to the origin

If `updates.cavecms.com` is hosted on S3/R2/static-bucket:

```bash
aws s3 cp manifest.json s3://cavecms-derricksiawor-com/manifest.json
aws s3 cp manifest.json.sig s3://cavecms-derricksiawor-com/manifest.json.sig
aws s3 cp "$ZIP" "s3://cavecms-derricksiawor-com/releases/$ZIP"
aws s3 cp "$ZIP.sha256" "s3://cavecms-derricksiawor-com/releases/$ZIP.sha256"
aws s3 cp "$ZIP.sig" "s3://cavecms-derricksiawor-com/releases/$ZIP.sig"

# Update the latest.zip symlink (S3-equivalent: copy + cache-control no-store)
aws s3 cp "s3://cavecms-derricksiawor-com/releases/$ZIP" \
  s3://cavecms-derricksiawor-com/latest.zip \
  --cache-control "no-store"
```

If hosted on Cloudflare Pages / static Nginx, the same idea — drop into
the right directory and bust any HTTP cache. `manifest.json` MUST always
be served with `Cache-Control: no-store` so updates propagate instantly.

### 5. Tag + push

```bash
git push origin main
git push origin v1.1.0
```

### 6. Verify from the outside

```bash
# Pretend you're an operator
curl -sSL https://updates.cavecms.com/manifest.json | jq .latestVersion
# → "1.1.0"

# Check the install banner appears on a running CaveCMS within ~12h
# (or trigger immediately via /api/admin/updates/trigger-check)
```

---

## Operator's update path — what they see

When `updates.cavecms.com/manifest.json` advertises a new version:

1. **The background scheduler** running inside every CaveCMS install
   polls the manifest every `settings.updates.checkFrequencyHours` hours
   (12 by default).
2. **The dashboard banner** appears across every admin page: *"A new
   version of CaveCMS is ready to install."*
3. **The operator clicks Update Now**. The 6-step modal walks through:
   - Getting ready (preflight: disk space, network, DB health)
   - Downloading the new version (zip + signature verify)
   - Preparing your data (pnpm install + db:migrate)
   - Building your site (already built — extracted from standalone)
   - Restarting (pm2 reload)
   - Making sure everything works (healthz polling, auto-rollback on failure)
4. **If anything fails**, CaveCMS auto-rolls back to the previous version.
   The operator's site is never offline.

The orchestrator script is at `scripts/cavecms-update.sh`.

---

## Future improvements (not blocking initial launch)

- **CI worker that automates steps 1–4** when a `v*` tag is pushed
- **Beta channel** (`manifest.beta.json`) for opt-in early releases
- **Delta zips** for faster downloads (small unchanged-file count)
- **Key rotation procedure** with operator-facing notification
- **Telemetry dashboard** at `cavecms.com/admin` that shows
  which versions are running in the wild (opt-in for operators who tick
  "share anonymous version info")

---

## Host split — division of labour

The marketing site and the release origin are now on SEPARATE hosts (both
proxied through Cloudflare):

| Host | Owner | Paths |
|---|---|---|
| `cavecms.com` (+ `www`) | Marketing site (`cavecms-web` repo, separate codebase) | `/`, `/docs/*`, `/pricing`, `/blog/*` |
| `updates.cavecms.com` | Release origin (this codebase's ship pipeline) | `/manifest.json`, `/manifest.json.sig`, `/pubkey.pem`, `/latest.zip`, `/latest.zip.sha256`, `/releases/*` |

`updates.cavecms.com` runs no app — it static-serves `/var/www/cavecms-releases`
via nginx on smokeleads. The in-app updater enforces same-origin between the
manifest URL and each `downloadUrl`, so both MUST be on `updates.cavecms.com`.

> NOTE: this doc predates the server-side build (`scripts/release/build-release.sh`
> on smokeleads). The manual openssl/S3 flow above is historical — the real
> pipeline is `connect deploy cavecms`. Rewrite when time allows.
