# =============================================================================
# ECCB Platform — production process topology
# =============================================================================
#
# The application is TWO long-running processes, not one. A previous
# deployment guide defined a single systemd unit running only `next start`,
# which silently omitted the background worker. In that topology nothing sends
# email, the scheduler never runs, and Smart Upload and OCR never process.
#
#   eccb-web.service       HTTP + Server Actions + Stand Socket.IO (one port)
#   eccb-workers.service   email, scheduler, Smart Upload, OCR, cleanup
#
# Both must be started on every deploy.
#
# Why eccb-web runs scripts/serve.ts and NOT `next start`:
#   serve.ts attaches the Stand Socket.IO server to the same http.Server and
#   port as Next. A WebSocket upgrade is never proxied by a rewrite, so a
#   separately-bound SOCKET_PORT is unreachable and clients silently poll.
#   `next start` binds only Next and cannot do that attachment. (Static assets
#   are served correctly either way — verified.)
#
# eccb-sockets.service is LEGACY and must NOT be enabled. It exists only so a
# host that still has it enabled can be migrated deliberately.
#
# Install (run from the app directory):
#   sudo cp deploy/systemd/eccb-web.service      /etc/systemd/system/
#   sudo cp deploy/systemd/eccb-workers.service  /etc/systemd/system/
#   sudo cp deploy/systemd/eccb.env.example     /etc/eccb/eccb.env
#   sudo chmod 600 /etc/eccb/eccb.env
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now eccb-web eccb-workers
#
# Verify:
#   systemctl status eccb-web eccb-workers
#   curl -fsS localhost:3000/api/health
#   curl -fsS localhost:3001/health    # worker health port
#
# /api/health reports components.sockets.expected and .attached — the REAL
# attach state of the socket server, not merely ENABLE_WEBSOCKETS. Realtime
# configured but not attached shows status "degraded" there.
#
# Restart order matters on deploy: web picks up new code, but workers must be
# restarted LAST and only after migrations have been applied (see deploy.md).
# A worker running old code against a migrated schema is the most common cause
# of a bad deploy.
# =============================================================================

[Unit]
Description=ECCB Platform — web (Next.js)
Documentation=file:///var/www/eccb/DEPLOYMENT.md
After=network-online.target mariadb.service redis-server.service
Wants=network-online.target
Requires=mariadb.service redis-server.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/eccb

# Secrets live in a root-owned, 0600 file — never in the unit or in git.
EnvironmentFile=/etc/eccb/eccb.env

# `next start` serves the production build. This process is stateless: all
# durable state lives in MariaDB and Redis, so it can be restarted freely.
ExecStart=/usr/bin/node /var/www/eccb/node_modules/.bin/next start -p 3000

Restart=always
RestartSec=10

# Give in-flight requests a chance to finish before SIGKILL.
KillSignal=SIGTERM
TimeoutStopSec=30

# Hardening: the web process needs no shell, no new privileges, and no write
# access outside the upload directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/www/eccb/storage /var/www/eccb/logs

StandardOutput=journal
StandardError=journal
SyslogIdentifier=eccb-web

[Install]
WantedBy=multi-user.target
