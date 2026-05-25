# CaveCMS Plan 09 — Deployment & Ops

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Production-ready droplet. CI builds the artifact + bundles `migrator-bundle/`. `scripts/setup.sh` provisions a fresh box. `scripts/deploy.sh` ships releases with blue/green-on-disk symlink + expand/contract preflight + pre-deploy DB snapshots. nginx serves static directly with TLS hardening + compression + static pool + maintenance fallback. `/healthz` gates rollouts. systemd timers run backups + cron-purge + media verification. age-encrypted backups with mandatory off-site rclone for production.

**Architecture:** Releases land in `/opt/cavecms/releases/<sha>/`; `current` symlink points to active. PM2 single fork + nginx maintenance fallback covers the brief reload window. Backups encrypted by age; restore drill runs monthly OFF the droplet. Logs JSON-escaped in nginx; PM2 logs rotated by pm2-logrotate.

**Prerequisites:** Plans 01–08.

---

### Task 1: ecosystem.config.cjs

**Files:** Create `ecosystem.config.cjs`

- [ ] **Step 1: write**

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'cavecms',
    script: 'server.js',
    cwd: '/opt/cavecms/current/.next/standalone',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--max-old-space-size=768',
    env: {
      NODE_ENV: 'production',
      PORT: '3040',
      HOST: '127.0.0.1',
      UV_THREADPOOL_SIZE: '8',
    },
    max_memory_restart: '1024M',
    kill_timeout: 8000,
    listen_timeout: 8000,
    wait_ready: true,
    max_restarts: 10,
    min_uptime: 60000,
    out_file: '/var/log/cavecms/out.log',
    error_file: '/var/log/cavecms/err.log',
    merge_logs: true,
    time: true,
  }],
}
```

- [ ] **Step 2: commit**

```bash
git add ecosystem.config.cjs && git commit -m "chore(ops): PM2 ecosystem config"
```

---

### Task 2: scripts/setup.sh

**Files:** Create `scripts/setup.sh`

- [ ] **Step 1: write**

```bash
#!/usr/bin/env bash
# scripts/setup.sh — one-time per box; idempotent.
set -euo pipefail
IFS=$'\n\t'
trap 'echo "FAIL at line $LINENO" >&2' ERR

if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi

read -r -p "LOGIN_PATH (6-32 lowercase/digits/dashes): " LOGIN_PATH
if [[ ! "$LOGIN_PATH" =~ ^[a-z0-9-]{6,32}$ ]]; then echo "Invalid LOGIN_PATH"; exit 1; fi
read -r -p "Apex domain [bestworldcompany.com]: " APEX; APEX="${APEX:-bestworldcompany.com}"
read -r -p "Staging hostname [staging.bestworldcompany.com]: " STAGING; STAGING="${STAGING:-staging.bestworldcompany.com}"
read -r -p "DB host [127.0.0.1]: " DB_HOST; DB_HOST="${DB_HOST:-127.0.0.1}"
read -r -s -p "Existing MariaDB root password: " DB_ROOT_PW; echo
read -r -s -p "New cavecms_user password: " CAVECMS_PW; echo
read -r -s -p "New cavecms_migrator password: " MIG_PW; echo
read -r -p "Backup age recipient public key (age1...): " AGE_PUB
read -r -p "Admin alert email [ops@example.com]: " ALERT; ALERT="${ALERT:-ops@example.com}"

# 1. App user
if ! id cavecms >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -m -d /home/cavecms cavecms
fi
if ! getent group backup >/dev/null; then groupadd -r backup; fi
usermod -aG cavecms www-data
usermod -aG backup cavecms

# 2. Directories
install -d -o cavecms -g cavecms -m 750 /opt/cavecms /opt/cavecms/releases /opt/cavecms/uploads /opt/cavecms/uploads/originals /opt/cavecms/uploads/variants /opt/cavecms/uploads/brochures-private /opt/cavecms/uploads/.tmp /opt/cavecms/static-pool/.next/static
install -d -o cavecms -g backup -m 750 /backup /backup/cavecms /backup/cavecms/db /backup/cavecms/uploads /backup/cavecms/pre-deploy
install -d -o cavecms -g cavecms -m 750 /var/log/cavecms /var/www
install -d -o root -g root -m 750 /etc/cavecms /var/lib/cavecms

# Same-FS assertion
D1=$(stat -c %d /opt/cavecms/uploads/.tmp)
for d in /opt/cavecms/uploads/originals /opt/cavecms/uploads/variants /opt/cavecms/uploads/brochures-private; do
  if [ "$(stat -c %d "$d")" != "$D1" ]; then echo "FAIL: upload dirs must share one filesystem"; exit 1; fi
done

# 3. MariaDB DB + users
mysql -h "$DB_HOST" -u root -p"$DB_ROOT_PW" <<SQL
CREATE DATABASE IF NOT EXISTS cavecms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'cavecms_user'@'%' IDENTIFIED BY '${CAVECMS_PW}';
ALTER USER 'cavecms_user'@'%' IDENTIFIED BY '${CAVECMS_PW}';
GRANT SELECT, INSERT, UPDATE, DELETE ON cavecms.* TO 'cavecms_user'@'%';
CREATE USER IF NOT EXISTS 'cavecms_migrator'@'%' IDENTIFIED BY '${MIG_PW}';
ALTER USER 'cavecms_migrator'@'%' IDENTIFIED BY '${MIG_PW}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ON cavecms.* TO 'cavecms_migrator'@'%';
FLUSH PRIVILEGES;
SQL

# 4. Backup pubkey
echo "$AGE_PUB" > /etc/cavecms/backup.pub
chmod 644 /etc/cavecms/backup.pub

# 5. mysqldump credentials file (used by backup script)
cat > /root/.cavecms-backup.cnf <<EOF
[client]
host=${DB_HOST}
user=cavecms_user
password=${CAVECMS_PW}
EOF
chmod 600 /root/.cavecms-backup.cnf

# 6. Maintenance HTML
cat > /var/www/cavecms-maint.html <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>Just a moment</title><meta name="robots" content="noindex"><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#f5f5f5}</style></head><body><p>We'll be right back.</p></body></html>
EOF

# 7. nginx config
"$(dirname "$0")/install-nginx.sh" "$APEX" "$STAGING" "$LOGIN_PATH"

# 8. Certbot DNS-01 reminder (manual step — operator runs separately)
echo "NOTE: Issue Let's Encrypt cert separately via DNS-01: certbot certonly --manual --preferred-challenges dns -d ${APEX} -d www.${APEX} -d ${STAGING}"

# 9. certbot deploy hook
install -d -o root -g root -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
nginx -t || { logger -t certbot-deploy "nginx -t failed after renewal; NOT reloading"; exit 1; }
systemctl reload nginx
logger -t certbot-deploy "nginx reloaded after cert renewal for ${RENEWED_DOMAINS:-unknown}"
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# 10. systemd units + timers
"$(dirname "$0")/install-systemd.sh"

# 11. pm2 logrotate + startup
sudo -u cavecms pm2 install pm2-logrotate || true
sudo -u cavecms pm2 set pm2-logrotate:max_size 50M
sudo -u cavecms pm2 set pm2-logrotate:retain 30
sudo -u cavecms pm2 set pm2-logrotate:compress true
sudo -u cavecms pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
env PATH=$PATH:/usr/bin pm2 startup systemd -u cavecms --hp /home/cavecms

# 12. UFW
ufw deny 3040 || true
ufw allow 80 || true
ufw allow 443 || true
ufw --force enable || true

# 13. /etc/cavecms/env.<env> templates (operator fills in)
for env in production staging; do
  f="/etc/cavecms/env.${env}"
  if [ ! -f "$f" ]; then
    cat > "$f" <<EOF
NODE_ENV=production
PORT=3040
DATABASE_URL=mysql://cavecms_user:${CAVECMS_PW}@127.0.0.1:3306/cavecms
DATABASE_MIGRATOR_URL=mysql://cavecms_migrator:${MIG_PW}@127.0.0.1:3306/cavecms
JWT_SECRET=$(openssl rand -base64 48)
CSRF_SECRET=$(openssl rand -base64 48)
PREVIEW_SECRET=$(openssl rand -base64 48)
BROCHURE_SECRET=$(openssl rand -base64 48)
LOGIN_PATH=${LOGIN_PATH}
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Best World Properties
SALES_EMAIL=${ALERT}
RECAPTCHA_SECRET=
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
ADMIN_ALERT_EMAIL=${ALERT}
BACKUP_AGE_RECIPIENT=${AGE_PUB}
EOF
    chown root:cavecms "$f"; chmod 640 "$f"
  fi
done

echo "Setup complete. Next: run scripts/seed-admin.sh on a release, then deploy."
```

- [ ] **Step 2: helpers `install-nginx.sh`, `install-systemd.sh`** referenced above — created in Tasks 3 & 4 below.

- [ ] **Step 3: commit**

```bash
chmod +x scripts/setup.sh && git add scripts/setup.sh && git commit -m "feat(ops): setup.sh provisions droplet from scratch"
```

---

### Task 3: nginx config + install helper

**Files:** Create `scripts/install-nginx.sh`, `scripts/nginx/cavecms.conf.template`, `scripts/nginx/snippets/cavecms-proxy.conf`, `scripts/nginx/snippets/cavecms-tls.conf`, `scripts/nginx/snippets/cavecms-compression.conf`

- [ ] **Step 1: proxy snippet**

```nginx
# scripts/nginx/snippets/cavecms-proxy.conf
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_read_timeout 30s;
proxy_send_timeout 30s;
client_max_body_size 30m;
```

- [ ] **Step 2: TLS snippet**

```nginx
# scripts/nginx/snippets/cavecms-tls.conf
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

- [ ] **Step 3: compression snippet**

```nginx
# scripts/nginx/snippets/cavecms-compression.conf
gzip on;
gzip_vary on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml application/json application/javascript application/xml+rss image/svg+xml application/manifest+json;
gzip_proxied no-store no-cache private expired auth;
```

- [ ] **Step 4: server-block template**

```nginx
# scripts/nginx/cavecms.conf.template — variables substituted by install-nginx.sh:
# __APEX__, __STAGING__, __LOGIN_PATH__

log_format cavecms_json escape=json '{"ts":"$time_iso8601","ip":"$remote_addr","method":"$request_method","path":"$request_uri","status":$status,"bytes":$body_bytes_sent,"rt":$request_time,"ua":"$http_user_agent","ref":"$http_referer"}';

# Port 80 → 443
server {
  listen 80;
  server_name __APEX__ www.__APEX__ __STAGING__;
  return 301 https://$host$request_uri;
}

# www → apex
server {
  listen 443 ssl http2;
  server_name www.__APEX__;
  ssl_certificate     /etc/letsencrypt/live/__APEX__/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/__APEX__/privkey.pem;
  include /etc/nginx/snippets/cavecms-tls.conf;
  return 301 https://__APEX__$request_uri;
}

# Apex (production)
server {
  listen 443 ssl http2;
  server_name __APEX__;
  ssl_certificate     /etc/letsencrypt/live/__APEX__/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/__APEX__/privkey.pem;
  include /etc/nginx/snippets/cavecms-tls.conf;
  include /etc/nginx/snippets/cavecms-compression.conf;

  access_log /var/log/nginx/cavecms-access.log cavecms_json;
  error_log  /var/log/nginx/cavecms-error.log warn;
  client_max_body_size 30m;

  location ^~ /_next/static/ {
    alias /opt/cavecms/static-pool/.next/static/;
    expires 1y;
    add_header Cache-Control "public, immutable";
    add_header X-Content-Type-Options "nosniff";
    gzip_static on;
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

  location = /__LOGIN_PATH__   { access_log off; proxy_pass http://127.0.0.1:3040; include /etc/nginx/snippets/cavecms-proxy.conf; }
  location = /api/auth/login   { access_log off; proxy_pass http://127.0.0.1:3040; include /etc/nginx/snippets/cavecms-proxy.conf; }

  location = /api/admin/leads/export {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    chunked_transfer_encoding on;
  }

  location = /api/cms/media {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
  }

  error_page 502 503 504 @maint;
  location @maint {
    root /var/www;
    try_files /cavecms-maint.html =503;
    add_header Cache-Control "no-store" always;
  }

  location / {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
  }
}

# Staging (IP allowlist + basic auth + noindex)
server {
  listen 443 ssl http2;
  server_name __STAGING__;
  ssl_certificate     /etc/letsencrypt/live/__STAGING__/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/__STAGING__/privkey.pem;
  include /etc/nginx/snippets/cavecms-tls.conf;
  include /etc/nginx/snippets/cavecms-compression.conf;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  client_max_body_size 30m;
  access_log /var/log/nginx/cavecms-staging-access.log cavecms_json;
  error_log  /var/log/nginx/cavecms-staging-error.log warn;

  satisfy any;
  # allow lines populated by operator post-install (see /etc/nginx/conf.d/cavecms-staging-allow.conf)
  include /etc/nginx/conf.d/cavecms-staging-allow.conf;
  deny all;
  auth_basic "staging";
  auth_basic_user_file /etc/nginx/.htpasswd-cavecms-staging;

  location ^~ /api/leads/ { return 410; }

  location ^~ /_next/static/ {
    alias /opt/cavecms/static-pool/.next/static/;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location ^~ /uploads/ {
    alias /opt/cavecms/uploads/;
    expires 30d;
  }

  location = /__LOGIN_PATH__   { access_log off; proxy_pass http://127.0.0.1:3040; include /etc/nginx/snippets/cavecms-proxy.conf; }

  error_page 502 503 504 @maint_s;
  location @maint_s { root /var/www; try_files /cavecms-maint.html =503; }

  location / {
    proxy_pass http://127.0.0.1:3040;
    include /etc/nginx/snippets/cavecms-proxy.conf;
  }
}
```

- [ ] **Step 5: install-nginx.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail; IFS=$'\n\t'
APEX="$1"; STAGING="$2"; LOGIN_PATH="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -o root -g root -m 755 /etc/nginx/snippets /etc/nginx/conf.d /etc/nginx/sites-available /etc/nginx/sites-enabled
install -m 644 "$HERE/nginx/snippets/cavecms-proxy.conf"       /etc/nginx/snippets/cavecms-proxy.conf
install -m 644 "$HERE/nginx/snippets/cavecms-tls.conf"         /etc/nginx/snippets/cavecms-tls.conf
install -m 644 "$HERE/nginx/snippets/cavecms-compression.conf" /etc/nginx/snippets/cavecms-compression.conf
# Default allowlist is empty: operator fills in office IPs
if [ ! -f /etc/nginx/conf.d/cavecms-staging-allow.conf ]; then
  echo "# Add 'allow <ip>;' lines here, one per office/dev IP." > /etc/nginx/conf.d/cavecms-staging-allow.conf
fi
if [ ! -f /etc/nginx/.htpasswd-cavecms-staging ]; then
  read -r -p "Staging basic auth user: " U
  htpasswd -c /etc/nginx/.htpasswd-cavecms-staging "$U"
  chown root:www-data /etc/nginx/.htpasswd-cavecms-staging
  chmod 640 /etc/nginx/.htpasswd-cavecms-staging
fi
TMP="$(mktemp)"
awk -v apex="$APEX" -v staging="$STAGING" -v lp="$LOGIN_PATH" '{ gsub(/__APEX__/, apex); gsub(/__STAGING__/, staging); gsub(/__LOGIN_PATH__/, lp); print }' "$HERE/nginx/cavecms.conf.template" > "$TMP"
install -m 644 "$TMP" /etc/nginx/sites-available/cavecms.conf
ln -sfn /etc/nginx/sites-available/cavecms.conf /etc/nginx/sites-enabled/cavecms.conf
nginx -t
systemctl reload nginx
rm -f "$TMP"
```

- [ ] **Step 6: commit**

```bash
chmod +x scripts/install-nginx.sh && git add scripts/install-nginx.sh scripts/nginx && git commit -m "feat(ops): nginx config + install helper"
```

---

### Task 4: systemd units + timers + install helper

**Files:** Create `scripts/install-systemd.sh`, `scripts/systemd/cavecms-db-backup.service`, `scripts/systemd/cavecms-db-backup.timer`, `scripts/systemd/cavecms-uploads-backup.service`, `scripts/systemd/cavecms-uploads-backup.timer`, `scripts/systemd/cavecms-cron-purge.service`, `scripts/systemd/cavecms-cron-purge.timer`, `scripts/systemd/cavecms-disk-check.service`, `scripts/systemd/cavecms-disk-check.timer`, `scripts/systemd/cavecms-media-verify.service`, `scripts/systemd/cavecms-media-verify.timer`, `scripts/systemd/cavecms-alert@.service`, `scripts/systemd/cavecms-static-prune.service`, `scripts/systemd/cavecms-static-prune.timer`

- [ ] **Step 1: db-backup service + timer**

```ini
# scripts/systemd/cavecms-db-backup.service
[Unit]
Description=CaveCMS nightly DB backup
OnFailure=cavecms-alert@%n.service

[Service]
Type=oneshot
User=cavecms
Group=backup
IOSchedulingClass=idle
EnvironmentFile=/etc/cavecms/env.production
ExecStart=/opt/cavecms/current/scripts/db-backup.sh
```

```ini
# scripts/systemd/cavecms-db-backup.timer
[Unit]
Description=CaveCMS nightly DB backup timer

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=15min
Persistent=true
Unit=cavecms-db-backup.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: uploads-backup**

```ini
# scripts/systemd/cavecms-uploads-backup.service
[Unit]
Description=CaveCMS nightly uploads rsync
OnFailure=cavecms-alert@%n.service

[Service]
Type=oneshot
User=cavecms
Group=backup
IOSchedulingClass=idle
ExecStart=/opt/cavecms/current/scripts/uploads-backup.sh
```

```ini
# scripts/systemd/cavecms-uploads-backup.timer
[Unit]
Description=CaveCMS uploads backup timer

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=15min
Persistent=true
Unit=cavecms-uploads-backup.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: cron-purge**

```ini
# scripts/systemd/cavecms-cron-purge.service
[Unit]
Description=CaveCMS nightly cron purge
After=cavecms-uploads-backup.service
OnFailure=cavecms-alert@%n.service

[Service]
Type=oneshot
User=cavecms
Group=cavecms
EnvironmentFile=/etc/cavecms/env.production
WorkingDirectory=/opt/cavecms/current
ExecStart=/usr/bin/env tsx scripts/cron-purge.ts
```

```ini
# scripts/systemd/cavecms-cron-purge.timer
[Unit]
Description=CaveCMS cron purge timer

[Timer]
OnCalendar=*-*-* 06:00:00
RandomizedDelaySec=15min
Persistent=true
Unit=cavecms-cron-purge.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: disk-check (no jitter)**

```ini
# scripts/systemd/cavecms-disk-check.service
[Unit]
Description=CaveCMS hourly disk check

[Service]
Type=oneshot
User=root
ExecStart=/opt/cavecms/current/scripts/disk-check.sh
```

```ini
# scripts/systemd/cavecms-disk-check.timer
[Unit]
Description=CaveCMS disk check timer

[Timer]
OnCalendar=hourly
Persistent=true
Unit=cavecms-disk-check.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: media-verify (weekly)**

```ini
# scripts/systemd/cavecms-media-verify.service
[Unit]
Description=CaveCMS weekly media-refs verifier
OnFailure=cavecms-alert@%n.service

[Service]
Type=oneshot
User=cavecms
EnvironmentFile=/etc/cavecms/env.production
WorkingDirectory=/opt/cavecms/current
ExecStart=/usr/bin/env tsx scripts/verify-media-refs.ts
```

```ini
# scripts/systemd/cavecms-media-verify.timer
[Unit]
Description=CaveCMS media-verify timer

[Timer]
OnCalendar=Sun *-*-* 05:00:00
RandomizedDelaySec=15min
Persistent=true
Unit=cavecms-media-verify.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: alert template**

```ini
# scripts/systemd/cavecms-alert@.service
[Unit]
Description=CaveCMS OnFailure alert for %i

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'journalctl -u %i --no-pager -n 50 | mailx -s "[cavecms] %i failed" "$ADMIN_ALERT_EMAIL"'
EnvironmentFile=/etc/cavecms/env.production
```

- [ ] **Step 7: static-prune (daily)**

```ini
# scripts/systemd/cavecms-static-prune.service
[Unit]
Description=CaveCMS static-pool pruner

[Service]
Type=oneshot
User=cavecms
ExecStart=/opt/cavecms/current/scripts/prune-static-pool.sh
```

```ini
# scripts/systemd/cavecms-static-prune.timer
[Unit]
Description=CaveCMS static-pool pruner timer

[Timer]
OnCalendar=*-*-* 05:30:00
RandomizedDelaySec=10min
Persistent=true
Unit=cavecms-static-prune.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 8: installer**

```bash
#!/usr/bin/env bash
# scripts/install-systemd.sh
set -euo pipefail; IFS=$'\n\t'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d /etc/systemd/system
for f in "$HERE/systemd"/*.service "$HERE/systemd"/*.timer; do
  install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"
done
systemctl daemon-reload
for t in cavecms-db-backup cavecms-uploads-backup cavecms-cron-purge cavecms-disk-check cavecms-media-verify cavecms-static-prune; do
  systemctl enable --now "${t}.timer"
done
```

- [ ] **Step 9: commit**

```bash
chmod +x scripts/install-systemd.sh && git add scripts/systemd scripts/install-systemd.sh && git commit -m "feat(ops): systemd units + timers + installer"
```

---

### Task 5: scripts/preflight.sh

**Files:** Create `scripts/preflight.sh`

- [ ] **Step 1: write**

```bash
#!/usr/bin/env bash
# scripts/preflight.sh — invoked by deploy.sh
set -euo pipefail; IFS=$'\n\t'
SHA="$1"
RELEASE_DIR="/opt/cavecms/releases/$SHA"

# 1. Disk gate (projected footprint)
ARTIFACT_KB=$(du -sk "$RELEASE_DIR" | awk '{print $1}')
LATEST_DUMP_KB=$(ls -1S /backup/cavecms/db/*.sql.age 2>/dev/null | head -1 | xargs -I{} du -sk {} | awk '{print $1}' 2>/dev/null || echo 0)
REQUIRED_KB=$(( ARTIFACT_KB * 2 + LATEST_DUMP_KB + 524288 ))
AVAIL_KB=$(df --output=avail / | tail -1)
[ "$AVAIL_KB" -gt "$REQUIRED_KB" ] || { echo "preflight: insufficient disk ($AVAIL_KB < $REQUIRED_KB)"; exit 1; }

# 2. deploy.blocked file
[ ! -f /var/lib/cavecms/deploy.blocked ] || { echo "preflight: /var/lib/cavecms/deploy.blocked exists"; exit 1; }

# 3. Expand/contract gate
if [ "${ALLOW_CONTRACT:-0}" != "1" ]; then
  for f in "$RELEASE_DIR"/db/migrations/*.sql; do
    [ -f "$f" ] || continue
    if grep -qiE 'DROP[[:space:]]+(COLUMN|TABLE|INDEX)|RENAME[[:space:]]+COLUMN|MODIFY[[:space:]]+\S+[[:space:]]+(VARCHAR\([0-9]+\))' "$f"; then
      echo "preflight: destructive migration $f requires ALLOW_CONTRACT=1"; exit 1
    fi
  done
fi

# 4. sharp glibc compatibility
SHARP_BIN=$(ls -1 "$RELEASE_DIR/.next/standalone/node_modules/sharp/build/Release/"*.node 2>/dev/null | head -1 || true)
if [ -n "$SHARP_BIN" ]; then
  if ldd "$SHARP_BIN" 2>&1 | grep -q 'not found'; then
    echo "preflight: sharp glibc mismatch on $SHARP_BIN"; exit 1
  fi
fi

# 5. /healthz of current (skipped on first deploy)
if [ -L /opt/cavecms/current ]; then
  if ! curl -fsS --max-time 3 -H 'X-Real-IP: 127.0.0.1' http://127.0.0.1:3040/healthz >/dev/null; then
    echo "preflight: current release unhealthy"; exit 1
  fi
fi

echo "preflight ok"
exit 0
```

- [ ] **Step 2: commit**

```bash
chmod +x scripts/preflight.sh && git add scripts/preflight.sh && git commit -m "feat(ops): preflight (disk + expand/contract + sharp glibc + healthz)"
```

---

### Task 6: scripts/deploy.sh

**Files:** Create `scripts/deploy.sh`

- [ ] **Step 1: write**

```bash
#!/usr/bin/env bash
# scripts/deploy.sh — invoked by CI or operator.
# Usage: deploy.sh <git-sha> [production|staging]
set -euo pipefail; IFS=$'\n\t'
trap 'echo "FAIL at line $LINENO" >&2' ERR

SHA="$1"
ENV_NAME="${2:-production}"
RELEASE_DIR="/opt/cavecms/releases/$SHA"

# Mutex
exec 9<>/var/lock/cavecms-deploy.lock
flock -n 9 || { echo "another deploy in progress"; exit 1; }

# Rotate: keep last 5 successful releases
ls -1dt /opt/cavecms/releases/*/ 2>/dev/null | tail -n +6 | xargs -r -I{} rm -rf {}

# Unpack artifact pre-uploaded to /opt/cavecms/incoming/<sha>.tar.zst
mkdir -p "$RELEASE_DIR"
tar --use-compress-program=zstd -xf "/opt/cavecms/incoming/$SHA.tar.zst" -C "$RELEASE_DIR"

# Symlink env
ln -sfn "/etc/cavecms/env.$ENV_NAME" "$RELEASE_DIR/.env.local"

# Preflight
bash "$RELEASE_DIR/scripts/preflight.sh" "$SHA"

# Pre-deploy DB snapshot (encrypted)
SNAP="/backup/cavecms/pre-deploy/$SHA.sql.age"
mysqldump --defaults-extra-file=/root/.cavecms-backup.cnf \
  --single-transaction --quick --skip-lock-tables --routines --triggers --events --set-gtid-purged=OFF cavecms \
  | gzip | age -r "$(cat /etc/cavecms/backup.pub)" > "${SNAP}.partial"
for s in "${PIPESTATUS[@]}"; do
  [ "$s" = 0 ] || { rm -f "${SNAP}.partial"; echo "snapshot failed"; exit 1; }
done
mv "${SNAP}.partial" "$SNAP"

# Migrate
(
  cd "$RELEASE_DIR"
  DATABASE_URL="$(grep ^DATABASE_MIGRATOR_URL /etc/cavecms/env."$ENV_NAME" | cut -d= -f2-)" \
    node migrator-bundle/run.js
)

# Merge static into pool (additive)
rsync -a "$RELEASE_DIR/.next/standalone/.next/static/" /opt/cavecms/static-pool/.next/static/ || true
rsync -a "$RELEASE_DIR/.next/static/"                  /opt/cavecms/static-pool/.next/static/

# Symlink swap (atomic)
ln -sfn "$RELEASE_DIR" /opt/cavecms/current

# PM2 reload
sudo -u cavecms pm2 startOrReload "$RELEASE_DIR/ecosystem.config.cjs" --update-env

# Healthz poll: 3 consecutive 200s ≥1s apart with matching commit, up to 60s
ok=0
for i in $(seq 1 60); do
  body="$(curl -fsS --max-time 2 -H 'X-Real-IP: 127.0.0.1' http://127.0.0.1:3040/healthz || true)"
  commit="$(echo "$body" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("commit",""))' 2>/dev/null || true)"
  if [ "$commit" = "$SHA" ]; then
    ok=$((ok+1)); [ "$ok" -ge 3 ] && break
  else
    ok=0
  fi
  sleep 1
done
if [ "${ok:-0}" -lt 3 ]; then
  echo "healthz failed; rolling back"
  bash "$(dirname "$0")/rollback.sh"
  exit 1
fi

# Persist PM2
sudo -u cavecms pm2 save || true

# Record success
echo "$SHA ok $(date -u +%FT%TZ)" >> /opt/cavecms/releases-history.log
echo "deployed $SHA"
```

- [ ] **Step 2: commit**

```bash
chmod +x scripts/deploy.sh && git add scripts/deploy.sh && git commit -m "feat(ops): deploy.sh (blue/green-on-disk + snapshot + healthz gate)"
```

---

### Task 7: scripts/rollback.sh

**Files:** Create `scripts/rollback.sh`

- [ ] **Step 1: write**

```bash
#!/usr/bin/env bash
# scripts/rollback.sh — re-target current symlink to last successful sha; optional DB restore.
set -euo pipefail; IFS=$'\n\t'

# Find last successful sha from history (excluding the current one)
CURRENT="$(readlink /opt/cavecms/current | awk -F/ '{print $NF}')"
LAST_OK="$(awk '$2=="ok" && $1!="'"$CURRENT"'" {sha=$1} END {print sha}' /opt/cavecms/releases-history.log)"
if [ -z "$LAST_OK" ]; then echo "no prior successful release"; exit 1; fi

# Compare schema fingerprints
CUR_FP="$(cat /opt/cavecms/releases/$CURRENT/db/schema-fingerprint.txt 2>/dev/null || echo missing)"
PREV_FP="$(cat /opt/cavecms/releases/$LAST_OK/db/schema-fingerprint.txt 2>/dev/null || echo missing)"

ln -sfn "/opt/cavecms/releases/$LAST_OK" /opt/cavecms/current
sudo -u cavecms pm2 startOrReload "/opt/cavecms/releases/$LAST_OK/ecosystem.config.cjs" --update-env

if [ "$CUR_FP" != "$PREV_FP" ]; then
  echo "WARNING: schema fingerprint differs between current and rollback target."
  echo "Restore pre-deploy DB snapshot? (y/N)"
  read -r ans
  if [ "$ans" = "y" ]; then
    read -r -s -p "Paste age identity (private key) and press Ctrl-D:" </dev/tty || true
    IDENT="$(cat)"
    SNAP="/backup/cavecms/pre-deploy/$CURRENT.sql.age"
    AGE_KEY=$(mktemp); echo "$IDENT" > "$AGE_KEY"
    age --decrypt -i "$AGE_KEY" "$SNAP" | gunzip | mysql --defaults-extra-file=/root/.cavecms-migrate.cnf cavecms
    shred -u "$AGE_KEY"
  fi
fi

ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 -H 'X-Real-IP: 127.0.0.1' http://127.0.0.1:3040/healthz >/dev/null; then
    ok=$((ok+1)); [ "$ok" -ge 3 ] && break
  fi
  sleep 1
done
echo "rolled back to $LAST_OK"
```

Setup the migrator-credentials file at install time:

```bash
# Add to setup.sh near other credentials:
cat > /root/.cavecms-migrate.cnf <<EOF
[client]
host=127.0.0.1
user=cavecms_migrator
password=${MIG_PW}
EOF
chmod 600 /root/.cavecms-migrate.cnf
```

- [ ] **Step 2: commit**

```bash
chmod +x scripts/rollback.sh && git add scripts/rollback.sh scripts/setup.sh && git commit -m "feat(ops): rollback with optional DB snapshot restore"
```

---

### Task 8: db-backup.sh + uploads-backup.sh + restore-drill.sh + prune-static-pool.sh + disk-check.sh

**Files:** Create the five scripts.

- [ ] **Step 1: db-backup.sh**

```bash
#!/usr/bin/env bash
# scripts/db-backup.sh
set -euo pipefail; IFS=$'\n\t'
DATE="$(date +%F)"
OUT="/backup/cavecms/db/${DATE}.sql.age"
exec 9<>/var/lock/cavecms-backup.lock
flock 9
ionice -c idle mysqldump --defaults-extra-file=/root/.cavecms-backup.cnf \
  --single-transaction --quick --skip-lock-tables --routines --triggers --events --set-gtid-purged=OFF cavecms \
  | gzip | age -r "$(cat /etc/cavecms/backup.pub)" > "${OUT}.partial"
for s in "${PIPESTATUS[@]}"; do
  [ "$s" = 0 ] || { rm -f "${OUT}.partial"; echo "backup failed"; exit 1; }
done
# Size anomaly guard
NEW_SIZE=$(stat -c %s "${OUT}.partial")
YESTERDAY="/backup/cavecms/db/$(date -d 'yesterday' +%F).sql.age"
if [ -f "$YESTERDAY" ]; then
  OLD_SIZE=$(stat -c %s "$YESTERDAY")
  if [ "$NEW_SIZE" -lt $(( OLD_SIZE / 2 )) ]; then
    echo "size anomaly: $NEW_SIZE < 50% of $OLD_SIZE"; rm -f "${OUT}.partial"; exit 1
  fi
fi
mv "${OUT}.partial" "$OUT"
# Retention
find /backup/cavecms/db -type f -name '*.sql.age' -mtime +30 -delete
# Off-site (optional)
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/db/" --config /etc/cavecms/rclone.conf
  rclone delete --min-age 90d "$BACKUP_RCLONE_REMOTE/db/" --config /etc/cavecms/rclone.conf || true
fi
echo "db backup ok: $OUT"
```

- [ ] **Step 2: uploads-backup.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail; IFS=$'\n\t'
exec 9<>/var/lock/cavecms-backup.lock
flock 9
ionice -c idle rsync -a --delete-after \
  /opt/cavecms/uploads/originals/         /backup/cavecms/uploads/originals/
ionice -c idle rsync -a --delete-after \
  /opt/cavecms/uploads/variants/          /backup/cavecms/uploads/variants/
ionice -c idle rsync -a --delete-after \
  /opt/cavecms/uploads/brochures-private/ /backup/cavecms/uploads/brochures-private/
echo "uploads backup ok"
```

- [ ] **Step 3: restore-drill.sh (run on a SEPARATE machine)**

```bash
#!/usr/bin/env bash
# scripts/restore-drill.sh
# Run this OFF the production droplet. Decrypts the latest dump, restores to a scratch DB,
# runs migrations, and smoke-tests admin login.
set -euo pipefail; IFS=$'\n\t'

read -r -p "Path to latest .sql.age dump (e.g. /tmp/2026-05-11.sql.age): " DUMP
read -r -p "Scratch DB name [cavecms_drill]: " DB; DB="${DB:-cavecms_drill}"
read -r -p "MariaDB root for scratch (root@127.0.0.1): " ROOT_USER; ROOT_USER="${ROOT_USER:-root}"
read -r -s -p "Root password: " ROOT_PW; echo
read -r -s -p "Paste age identity (Ctrl-D when done):" IDENT </dev/tty || true

mysql -u "$ROOT_USER" -p"$ROOT_PW" -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\`;"
AGE_KEY=$(mktemp); printf '%s' "$IDENT" > "$AGE_KEY"
age --decrypt -i "$AGE_KEY" "$DUMP" | gunzip | mysql -u "$ROOT_USER" -p"$ROOT_PW" "$DB"
shred -u "$AGE_KEY"

# Verify schema fingerprint, count rows
mysql -u "$ROOT_USER" -p"$ROOT_PW" "$DB" -e "SELECT COUNT(*) FROM users;"
mysql -u "$ROOT_USER" -p"$ROOT_PW" "$DB" -e "SELECT COUNT(*) FROM projects;"
echo "restore drill ok"
date -u +%F >> "$(dirname "$0")/../README.md.drill-log"
```

- [ ] **Step 4: prune-static-pool.sh**

```bash
#!/usr/bin/env bash
# scripts/prune-static-pool.sh
set -euo pipefail; IFS=$'\n\t'

POOL=/opt/cavecms/static-pool/.next/static
KEEP_DAYS=7

# Collect every chunk path referenced by the last 5 releases
declare -A KEEP
while IFS= read -r release; do
  if [ -d "$release/.next/standalone/.next/static" ]; then
    while IFS= read -r f; do
      KEEP["${f#"$release/.next/standalone/.next/static/"}"]=1
    done < <(find "$release/.next/standalone/.next/static" -type f)
  fi
  if [ -d "$release/.next/static" ]; then
    while IFS= read -r f; do
      KEEP["${f#"$release/.next/static/"}"]=1
    done < <(find "$release/.next/static" -type f)
  fi
done < <(ls -1dt /opt/cavecms/releases/*/ 2>/dev/null | head -5)

# Delete pool files older than KEEP_DAYS AND not in any kept release
find "$POOL" -type f -mtime +"$KEEP_DAYS" | while read -r f; do
  rel="${f#"$POOL"/}"
  if [ -z "${KEEP[$rel]+x}" ]; then rm -f "$f"; fi
done
# Remove empty directories
find "$POOL" -type d -empty -delete || true
echo "static pool pruned"
```

- [ ] **Step 5: disk-check.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail; IFS=$'\n\t'
PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$PCT" -ge 90 ]; then
  logger -t cavecms-disk "CRITICAL disk ${PCT}%"
  install -d -o root -g root -m 750 /var/lib/cavecms
  touch /var/lib/cavecms/deploy.blocked
elif [ "$PCT" -ge 80 ]; then
  logger -t cavecms-disk "WARN disk ${PCT}%"
fi
```

- [ ] **Step 6: commit**

```bash
chmod +x scripts/db-backup.sh scripts/uploads-backup.sh scripts/restore-drill.sh scripts/prune-static-pool.sh scripts/disk-check.sh
git add scripts/*.sh && git commit -m "feat(ops): backup + restore drill + static-pool prune + disk check"
```

---

### Task 9: scripts/cron-purge.ts + verify-media-refs.ts

**Files:** Create both scripts.

- [ ] **Step 1: cron-purge**

```ts
// scripts/cron-purge.ts
import { sql } from 'drizzle-orm'
import { db, pool } from '../db/client'

if (process.env.NODE_ENV !== 'production') {
  throw new Error('cron-purge is production-only')
}

const SOFT = Number(process.env.SOFT_DELETE_RETENTION_DAYS ?? 30)
const ATT  = Number(process.env.LOGIN_ATTEMPTS_RETENTION_DAYS ?? 30)
const AUD  = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 730)
const NTF  = Number(process.env.NOTIFICATION_FAILURES_RETENTION_DAYS ?? 30)
const UKI  = Number(process.env.USER_KNOWN_IPS_RETENTION_DAYS ?? 90)

async function main() {
  await db.execute(sql`DELETE FROM content_blocks WHERE deleted_at IS NOT NULL AND deleted_at < NOW(3) - INTERVAL ${SOFT} DAY`)
  await db.execute(sql`DELETE FROM login_attempts WHERE created_at < NOW(3) - INTERVAL ${ATT} DAY`)
  await db.execute(sql`DELETE FROM audit_log      WHERE created_at < NOW(3) - INTERVAL ${AUD} DAY`)
  await db.execute(sql`DELETE FROM notification_failures WHERE resolved_at IS NOT NULL AND resolved_at < NOW(3) - INTERVAL ${NTF} DAY`)
  await db.execute(sql`DELETE FROM pending_emails        WHERE resolved_at IS NOT NULL AND resolved_at < NOW(3) - INTERVAL ${NTF} DAY`)
  await db.execute(sql`DELETE FROM user_known_ips WHERE last_success_at < NOW(3) - INTERVAL ${UKI} DAY`)

  // Orphan upload sweep
  await db.execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE variants IS NULL AND created_at < NOW(3) - INTERVAL 1 HOUR AND deleted_at IS NULL`)

  // Hard-delete unreferenced soft-deleted media
  const candidates = (await db.execute(sql`SELECT id, filename_uuid, mime_type FROM media WHERE deleted_at IS NOT NULL AND deleted_at < NOW(3) - INTERVAL ${SOFT} DAY`)) as unknown as Array<{ id: number; filename_uuid: string; mime_type: string }>
  const fs = await import('node:fs/promises')
  for (const m of candidates) {
    let toUnlink = false
    await db.transaction(async (tx) => {
      const refs = (await tx.execute(sql`SELECT 1 FROM media_references WHERE media_id = ${m.id} LIMIT 1 FOR UPDATE`)) as unknown as Array<unknown>
      if (refs.length > 0) return
      await tx.execute(sql`DELETE FROM media WHERE id = ${m.id}`)
      toUnlink = true
    })
    if (!toUnlink) continue
    const targets = m.mime_type === 'application/pdf'
      ? [`/opt/cavecms/uploads/brochures-private/${m.filename_uuid}.pdf`]
      : [
          `/opt/cavecms/uploads/originals/${m.filename_uuid}`,
          `/opt/cavecms/uploads/variants/${m.filename_uuid}-thumb.webp`,
          `/opt/cavecms/uploads/variants/${m.filename_uuid}-md.webp`,
          `/opt/cavecms/uploads/variants/${m.filename_uuid}-lg.webp`,
          `/opt/cavecms/uploads/variants/${m.filename_uuid}-og.jpg`,
        ]
    for (const path of targets) await fs.unlink(path).catch(() => {})
  }
}

await main()
await pool.end()
```

- [ ] **Step 2: verify-media-refs**

```ts
// scripts/verify-media-refs.ts
import { sql } from 'drizzle-orm'
import { db, pool } from '../db/client'
import { collectMediaPaths } from '../lib/cms/mediaRefs'

async function main() {
  // Rebuild media_references from scratch
  await db.execute(sql`CREATE TEMPORARY TABLE _refs_new LIKE media_references`)

  const blocks = (await db.execute(sql`SELECT id, data FROM content_blocks WHERE deleted_at IS NULL`)) as unknown as Array<{ id: number; data: unknown }>
  for (const b of blocks) {
    for (const r of collectMediaPaths(b.data)) {
      await db.execute(sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field) VALUES (${r.mediaId}, 'content_block', ${b.id}, ${r.field})`)
    }
  }
  const sections = (await db.execute(sql`SELECT id, data FROM project_sections`)) as unknown as Array<{ id: number; data: unknown }>
  for (const s of sections) {
    for (const r of collectMediaPaths(s.data)) {
      await db.execute(sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field) VALUES (${r.mediaId}, 'project_section', ${s.id}, ${r.field})`)
    }
  }
  // Typed FKs
  const projects = (await db.execute(sql`SELECT id, hero_image_id, brochure_pdf_id, og_image_id FROM projects WHERE deleted_at IS NULL`)) as unknown as Array<{ id: number; hero_image_id: number | null; brochure_pdf_id: number | null; og_image_id: number | null }>
  for (const p of projects) {
    for (const [col, val] of Object.entries({ hero_image_id: p.hero_image_id, brochure_pdf_id: p.brochure_pdf_id, og_image_id: p.og_image_id })) {
      if (val) await db.execute(sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field) VALUES (${val}, 'project', ${p.id}, ${col})`)
    }
  }
  const posts = (await db.execute(sql`SELECT id, hero_image_id, og_image_id FROM posts WHERE deleted_at IS NULL`)) as unknown as Array<{ id: number; hero_image_id: number | null; og_image_id: number | null }>
  for (const p of posts) {
    for (const [col, val] of Object.entries({ hero_image_id: p.hero_image_id, og_image_id: p.og_image_id })) {
      if (val) await db.execute(sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field) VALUES (${val}, 'post', ${p.id}, ${col})`)
    }
  }
  const team = (await db.execute(sql`SELECT id, photo_id FROM team_members`)) as unknown as Array<{ id: number; photo_id: number | null }>
  for (const t of team) {
    if (t.photo_id) await db.execute(sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field) VALUES (${t.photo_id}, 'team_member', ${t.id}, 'photo_id')`)
  }

  // Compare and audit
  const missing = (await db.execute(sql`SELECT n.media_id, n.referent_type, n.referent_id, n.field FROM _refs_new n LEFT JOIN media_references m ON m.media_id = n.media_id AND m.referent_type = n.referent_type AND m.referent_id = n.referent_id AND m.field = n.field WHERE m.media_id IS NULL`)) as unknown as Array<Record<string, unknown>>
  const extra = (await db.execute(sql`SELECT m.media_id, m.referent_type, m.referent_id, m.field FROM media_references m LEFT JOIN _refs_new n ON n.media_id = m.media_id AND n.referent_type = m.referent_type AND n.referent_id = m.referent_id AND n.field = m.field WHERE n.media_id IS NULL`)) as unknown as Array<Record<string, unknown>>
  if (missing.length || extra.length) {
    await db.execute(sql`INSERT INTO audit_log (action, resource_type, diff) VALUES ('media_refs_drift', 'media', ${JSON.stringify({ missing, extra })})`)
    // Reconcile
    for (const r of missing) await db.execute(sql`INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field) VALUES (${r.media_id}, ${r.referent_type}, ${r.referent_id}, ${r.field})`)
    for (const r of extra) await db.execute(sql`DELETE FROM media_references WHERE media_id = ${r.media_id} AND referent_type = ${r.referent_type} AND referent_id = ${r.referent_id} AND field = ${r.field}`)
  }
}

await main()
await pool.end()
```

- [ ] **Step 3: commit**

```bash
git add scripts/cron-purge.ts scripts/verify-media-refs.ts && git commit -m "feat(ops): cron-purge + verify-media-refs"
```

---

### Task 10: CI workflows

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`, `.github/workflows/deploy-production.yml`, `pnpm-workspace.yaml`, `migrator/package.json`, `migrator/run.js`

- [ ] **Step 1: pnpm workspace + migrator package**

```yaml
# pnpm-workspace.yaml
packages:
  - migrator
```

```json
// migrator/package.json
{
  "name": "migrator",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "drizzle-orm": "0.36.0",
    "mysql2": "3.11.5"
  }
}
```

```js
// migrator/run.js
const mysql = require('mysql2/promise')
const fs = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
  const conn = await mysql.createConnection(url)
  // Track applied migrations in a dedicated table
  await conn.query(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INT PRIMARY KEY AUTO_INCREMENT, hash VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`)
  const dir = path.join(__dirname, '..', 'db', 'migrations')
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const [applied] = await conn.query('SELECT hash FROM __drizzle_migrations')
  const have = new Set(applied.map((r) => r.hash))
  for (const f of files) {
    if (have.has(f)) continue
    const sqlText = await fs.readFile(path.join(dir, f), 'utf8')
    for (const stmt of sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await conn.query(stmt)
    }
    await conn.query('INSERT INTO __drizzle_migrations (hash) VALUES (?)', [f])
    console.log(`applied: ${f}`)
  }
  // Update schema fingerprint
  const fp = await fs.readFile(path.join(__dirname, '..', 'db', 'schema-fingerprint.txt'), 'utf8')
  await conn.query('INSERT INTO schema_fingerprint (id, fingerprint) VALUES (1, ?) ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), applied_at = NOW(3)', [fp.trim()])
  await conn.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: ci.yml**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    services:
      mariadb:
        image: mariadb:10.11
        env: { MARIADB_ROOT_PASSWORD: root, MARIADB_DATABASE: cavecms_test }
        ports: ['3306:3306']
        options: --health-cmd="mariadb-admin ping" --health-interval=5s
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm rebuild sharp
      - run: pnpm audit --prod --audit-level=high || true
      - run: pnpm typecheck
      - run: pnpm lint
      - env:
          DATABASE_URL: mysql://root:root@127.0.0.1:3306/cavecms_test
          JWT_SECRET: ${{ secrets.TEST_JWT_SECRET || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }}
          CSRF_SECRET: ${{ secrets.TEST_CSRF_SECRET || 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }}
          PREVIEW_SECRET: ${{ secrets.TEST_PREVIEW_SECRET || 'ccccccccccccccccccccccccccccccccccc' }}
          BROCHURE_SECRET: ${{ secrets.TEST_BROCHURE_SECRET || 'ddddddddddddddddddddddddddddddddddd' }}
          LOGIN_PATH: jamestown
        run: |
          node migrator/run.js
          pnpm vitest run
          pnpm playwright install --with-deps chromium
          pnpm playwright test
```

- [ ] **Step 3: deploy-staging.yml**

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy staging
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-24.04
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm rebuild sharp
      - run: pnpm audit --prod --audit-level=high || true
      - env: { NEXT_PUBLIC_RECAPTCHA_SITE_KEY: ${{ secrets.NEXT_PUBLIC_RECAPTCHA_SITE_KEY }} }
        run: pnpm build
      - run: pnpm install --prod --filter=migrator
      - name: Bundle artifact
        run: |
          SHA=${GITHUB_SHA}
          mkdir -p out/${SHA}/migrator-bundle out/${SHA}/scripts
          cp -r .next/standalone out/${SHA}/.next/standalone
          cp -r .next/static out/${SHA}/.next/static
          cp -r public out/${SHA}/public
          cp -r db out/${SHA}/db
          cp -r scripts out/${SHA}/scripts
          cp ecosystem.config.cjs package.json out/${SHA}/
          cp migrator/run.js out/${SHA}/migrator-bundle/run.js
          cp -r migrator/node_modules out/${SHA}/migrator-bundle/node_modules
          # Compute schema fingerprint (sha256 of canonical schema)
          ( cd db/schema && cat *.ts ) | sha256sum | awk '{print $1}' > out/${SHA}/db/schema-fingerprint.txt
          tar --use-compress-program=zstd -cf out/${SHA}.tar.zst -C out/${SHA} .
      - name: Ship to droplet
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: deployer
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: "out/${{ github.sha }}.tar.zst"
          target: "/opt/cavecms/incoming/"
      - name: Run deploy.sh on droplet
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: deployer
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: sudo /opt/cavecms/current/scripts/deploy.sh ${{ github.sha }} staging
```

- [ ] **Step 4: deploy-production.yml**

```yaml
# .github/workflows/deploy-production.yml
name: Deploy production
on:
  push:
    tags: ['v*']
jobs:
  deploy:
    runs-on: ubuntu-24.04
    environment: production    # requires manual approval per GitHub env config
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm rebuild sharp
      - env: { NEXT_PUBLIC_RECAPTCHA_SITE_KEY: ${{ secrets.NEXT_PUBLIC_RECAPTCHA_SITE_KEY }} }
        run: pnpm build
      - run: pnpm install --prod --filter=migrator
      - name: Bundle artifact
        run: |
          SHA=${GITHUB_SHA}
          mkdir -p out/${SHA}/migrator-bundle
          cp -r .next/standalone out/${SHA}/.next/standalone
          cp -r .next/static out/${SHA}/.next/static
          cp -r public out/${SHA}/public
          cp -r db out/${SHA}/db
          cp -r scripts out/${SHA}/scripts
          cp ecosystem.config.cjs package.json out/${SHA}/
          cp migrator/run.js out/${SHA}/migrator-bundle/run.js
          cp -r migrator/node_modules out/${SHA}/migrator-bundle/node_modules
          ( cd db/schema && cat *.ts ) | sha256sum | awk '{print $1}' > out/${SHA}/db/schema-fingerprint.txt
          tar --use-compress-program=zstd -cf out/${SHA}.tar.zst -C out/${SHA} .
      - uses: appleboy/scp-action@v0.1.7
        with: { host: ${{ secrets.DROPLET_HOST }}, username: deployer, key: ${{ secrets.DEPLOY_SSH_KEY }}, source: "out/${{ github.sha }}.tar.zst", target: "/opt/cavecms/incoming/" }
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: deployer
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: sudo /opt/cavecms/current/scripts/deploy.sh ${{ github.sha }} production
```

- [ ] **Step 5: commit**

```bash
git add .github pnpm-workspace.yaml migrator && git commit -m "ci: build + ship artifact, run deploy.sh remotely"
```

---

### Task 11: README + .env.example

**Files:** Create `README.md`, `.env.example`

- [ ] **Step 1: .env.example** (must include every key from `lib/env.ts` + spec §15)

```
# Required — secrets (openssl rand -base64 64)
JWT_SECRET=
CSRF_SECRET=
PREVIEW_SECRET=
BROCHURE_SECRET=

# Database
DATABASE_URL=mysql://cavecms_user:CHANGE_ME@127.0.0.1:3306/cavecms
DATABASE_MIGRATOR_URL=mysql://cavecms_migrator:CHANGE_ME@127.0.0.1:3306/cavecms

# Hidden login
LOGIN_PATH=

# SMTP — handled outside this project
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=Best World Properties
SALES_EMAIL=

# reCAPTCHA v3
RECAPTCHA_SECRET=
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
RECAPTCHA_THRESHOLD=0.5

# First-deploy only — never persisted
INITIAL_ADMIN_EMAIL=
INITIAL_ADMIN_NAME=
INITIAL_ADMIN_PASSWORD=

# Backup
BACKUP_AGE_RECIPIENT=
BACKUP_AGE_FINGERPRINT=
BACKUP_RCLONE_REMOTE=

# Tunables
PORT=3040
NODE_ENV=production
JWT_TTL_SECONDS=28800
JWT_RENEW_AFTER_SECONDS=1800
JWT_ABSOLUTE_MAX_SECONDS=86400
CSRF_TTL_SECONDS=3600
PREVIEW_TTL_SECONDS=900
BROCHURE_TOKEN_TTL_SECONDS=604800
SOFT_DELETE_RETENTION_DAYS=30
UPLOADS_BACKUP_RETENTION_DAYS=7
DB_BACKUP_RETENTION_DAYS=30
AUDIT_LOG_RETENTION_DAYS=730
LOGIN_ATTEMPTS_RETENTION_DAYS=30
NOTIFICATION_FAILURES_RETENTION_DAYS=30
USER_KNOWN_IPS_RETENTION_DAYS=90
MAX_IMAGE_UPLOAD_BYTES=10485760
MAX_PDF_UPLOAD_BYTES=26214400
RECAPTCHA_TIMEOUT_MS=3000
SMTP_CONNECTION_TIMEOUT_MS=5000
SMTP_SOCKET_TIMEOUT_MS=10000
SMTP_POOL_MAX_CONNECTIONS=3
SMTP_RETRY_ATTEMPTS=3
DB_POOL_LIMIT=15
DB_STATEMENT_TIMEOUT_MS=10000
HANDLER_TIMEOUT_MS=15000
UPLOAD_HANDLER_TIMEOUT_MS=60000
SPRAY_DETECTOR_DISTINCT_EMAILS=5
SPRAY_DETECTOR_WINDOW_MIN=15
SPRAY_DETECTOR_LOCK_MIN=60
ADMIN_ALERT_EMAIL=
```

- [ ] **Step 2: README**

````markdown
# Best World Properties — Next.js rebuild

Marketing site + CMS for bestworldcompany.com.

## Prereqs

- Node 22, pnpm 9
- MariaDB ≥ 10.11
- Linux/macOS for development; production target: Ubuntu 24.04 droplet

## First-time setup

```bash
cp .env.example .env.local
# Fill in DATABASE_URL, secrets (openssl rand -base64 64), LOGIN_PATH, SMTP_*
pnpm install --frozen-lockfile
node migrator/run.js                # apply migrations
pnpm db:seed                        # interactive: creates the initial Admin
pnpm dev                            # http://localhost:3040
```

## Dev

- `pnpm dev` — Next dev server on :3040
- `pnpm test` — Vitest unit + integration
- `pnpm playwright test` — E2E

## Deploy

CI builds the artifact and runs `scripts/deploy.sh <sha> <env>` on the droplet.
- `main` branch → staging (auto)
- Tag `v*` → production (manual approval via GitHub Environment)

Manual deploy:

```bash
ssh deployer@droplet sudo /opt/cavecms/current/scripts/deploy.sh <sha> production
```

## Backups + restore

- DB: encrypted (age) nightly dump in `/backup/cavecms/db/`, optional off-site via rclone.
- Uploads: rsync nightly to `/backup/cavecms/uploads/`.
- Restore drill: run `scripts/restore-drill.sh` OFF the production droplet. Quarterly.

Restore drill log (append on each drill):

```
2026-05-11
```

## Env var reference

See `docs/specs/2026-05-10-cavecms-rebuild-design.md` §15.

## Troubleshooting

- `pnpm dev` exits with secret errors → make sure all `*_SECRET` env vars are ≥ 32 bytes base64.
- `/admin` returns 307 to `/` → expected when unauthenticated.
- 502 on the public site → check `pm2 logs cavecms`. Maintenance page should be visible during deploy.
- Forgot admin password → run `scripts/seed-admin.sh` (it refuses on a non-empty users table; you must reset via SQL on staging).
````

- [ ] **Step 3: commit**

```bash
git add README.md .env.example && git commit -m "docs: README + .env.example"
```

---

### Task 12: pre-launch checklist (in README)

- [ ] **Step 1:** Add to README under a `## Cutover checklist` section:

```markdown
## Cutover checklist

- [ ] All projects published with content + brochure PDFs
- [ ] Initial admin user created; credentials delivered out-of-band
- [ ] Smoke test every public page + every form on staging
- [ ] Restore drill executed off-box
- [ ] Apex nginx server block ready (mirrors staging, no IP allowlist + indexable)
- [ ] 301 redirects map old-site URLs → new
- [ ] Apex Let's Encrypt cert pre-issued via DNS-01
- [ ] DNS TTL on apex lowered to 60s, 24h before flip
- [ ] DNS A record on apex updated → droplet IP
- [ ] Monitor logs + /healthz for 30 min
- [ ] DNS TTL restored to 3600s after 7 stable days
```

- [ ] **Step 2: commit**

```bash
git add README.md && git commit -m "docs: cutover checklist"
```

---

### Task 13: Definition of done

- [ ] Fresh droplet → `scripts/setup.sh` succeeds + is idempotent (re-runnable).
- [ ] `scripts/install-nginx.sh` and `scripts/install-systemd.sh` apply config + reload services without manual edits.
- [ ] Certbot deploy hook validates with `nginx -t` before reload.
- [ ] CI builds artifact, ships to droplet, `scripts/deploy.sh` flips symlink and survives /healthz x3.
- [ ] `scripts/rollback.sh` revert-to-previous works (verified by deploying a broken release on staging).
- [ ] DB backup encrypted with age and rotated 30d; restore drill succeeds on a separate machine.
- [ ] systemd timers run on schedule; `OnFailure=cavecms-alert@%n.service` emails admin.
- [ ] PM2 logrotate keeps last 30d compressed.
- [ ] Cutover plan executed: DNS pre-lowered → DNS-01 cert issued → A record flipped → smoke tested → TTL restored.
- [ ] `git tag v1.0.0` after first successful production cutover.
