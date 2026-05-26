# create-cavecms

The official one-command installer for [CaveCMS](https://cavecms.derricksiawor.com).

## Install

```bash
npx create-cavecms my-site
```

That's it. The CLI:

1. Detects whether you're on **VPS / laptop / cPanel** and picks the right adapter
2. Downloads and SHA-256 + Ed25519 verifies the latest release from `cavecms.derricksiawor.com`
3. Unpacks the runtime to the canonical install path for the surface
4. Prompts for the minimum it cannot auto-supply: DB connection, public URL, port
5. Generates every bootstrap secret (JWT / CSRF / preview / brochure / internal-revalidate / secrets-encryption + a random `LOGIN_PATH`)
6. Writes ONE sealed `env.production` (mode `600`) that you **never open or edit**
7. Runs database migrations against your MariaDB
8. Starts the service (systemd on VPS, foreground on laptop, Passenger shim on cPanel)

After the CLI finishes, open `<site-url>/install` and walk the in-app wizard.

## Prerequisites

- **Node 20+** on the target machine
- **MariaDB 10.11+** reachable from the install target
- For **VPS** installs only: sudo access during the CLI run (for systemd + nginx)

## Non-interactive install

```bash
CAVECMS_DB_USER=cavecms \
CAVECMS_DB_PASSWORD='secret' \
CAVECMS_SITE_URL='https://mysite.com' \
npx create-cavecms my-site --yes --surface=vps
```

| Env var                 | Default     |
|-------------------------|-------------|
| `CAVECMS_DB_HOST`       | `127.0.0.1` |
| `CAVECMS_DB_PORT`       | `3306`      |
| `CAVECMS_DB_USER`       | *required*  |
| `CAVECMS_DB_PASSWORD`   | *required*  |
| `CAVECMS_DB_NAME`       | `cavecms`   |
| `CAVECMS_SITE_URL`      | *required for VPS / cPanel* |
| `CAVECMS_PORT`          | `3040`      |

## CLI flags

| Flag                  | Meaning |
|-----------------------|---------|
| `--surface=auto`      | Force a surface (`vps` / `laptop` / `cpanel`). Default: auto-detect. |
| `--port=NUMBER`       | App listen port. Default: 3040. |
| `--version=X.Y.Z`     | Pin to a specific release. Default: `latest`. |
| `--dir=PATH`          | Override the install directory. |
| `--skip-signature`    | Skip Ed25519 verify (SHA-256 still checked). |
| `--skip-migrate`      | Don't run migrations. |
| `--skip-start`        | Don't start the service. |
| `-y, --yes`           | Non-interactive: accept defaults + env-supplied answers. |

## Why a sealed env file?

Customer installs must NEVER require editing `.env.local`, `.env.production`,
or any config file by hand. The CLI writes `env.production` ONE TIME at
install — random secrets, the DB URL you provided, and the LOGIN_PATH the
wizard will reveal. From then on, every operator-configurable knob lives
in the `settings` table you edit from the admin dashboard.

If a secret is ever compromised, re-run the installer with `--rotate`
(future flag) to regenerate the affected secret in place.

## License

This installer is part of [CaveCMS](https://cavecms.derricksiawor.com).
See the project's [LICENSE.md](../../LICENSE.md) — Prosperity Public
License 3.0.0 (free for personal/educational/non-profit; 30-day commercial
trial; paid license for ongoing commercial use).
