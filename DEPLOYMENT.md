# Production Deployment Guide - Ubuntu 22.04 LTS

This guide covers deploying the Emerald Coast Community Band platform to a bare-metal Ubuntu 22.04 LTS server without Docker.

## Prerequisites

- Ubuntu 22.04 LTS server with root/sudo access
- Domain name pointed to server IP (for SSL)
- Minimum 2GB RAM, 20GB disk space
- SSH access to server

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/eccb.app.git
cd eccb.app

# 2. Install dependencies
pnpm install --frozen-lockfile

# 3. Configure environment
cp env.example .env
nano .env  # Edit with production values

# 4. Build and start
pnpm run build
pnpm run start
```

For detailed setup, follow the sections below.

## Production Deployment

### 1. Server Preparation

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y build-essential curl git

# Install Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js installation
node --version  # Should show v20.x.x
```

### 2. MariaDB Setup

```bash
# Install MariaDB 14
sudo apt install -y MariaDB MariaDB-contrib

# Start and enable MariaDB
sudo systemctl start MariaDB
sudo systemctl enable MariaDB

# Create database and user
sudo -u MariaDB psql << 'EOF'
CREATE DATABASE eccb_production;
CREATE USER eccb_user WITH ENCRYPTED PASSWORD 'YOUR_SECURE_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE eccb_production TO eccb_user;
\c eccb_production
GRANT ALL ON SCHEMA public TO eccb_user;
EOF

# Configure authentication
sudo sed -i 's/local\s*all\s*all\s*peer/local all all md5/' /etc/MariaDB/14/main/pg_hba.conf
sudo systemctl restart MariaDB
```

### 3. Redis Setup

```bash
# Install Redis
sudo apt install -y redis-server

# Configure Redis for production
sudo sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory <bytes>/maxmemory 256mb/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory-policy noeviction/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf

# Start and enable Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

### 4. Application Setup

```bash
# Create application directory
sudo mkdir -p /var/www/eccb
sudo chown $USER:$USER /var/www/eccb

# Clone repository
cd /var/www/eccb
git clone https://github.com/your-org/eccb.app.git .

# Install dependencies
pnpm install --frozen-lockfile

# Create storage directory
mkdir -p storage
chmod 755 storage
```

### 5. Environment Configuration

Create a production `.env`, edit it with real values, then validate it:

```bash
cp env.example .env
# Edit .env with production values from your secret store
pnpm run setup
```

`pnpm run setup` validates required environment variables and regenerates the Prisma client. It does not generate production secrets. Generate secrets with a password manager or `openssl rand -base64 32`, store them outside version control, and rotate any value that was ever committed.

Note: run `pnpm run setup` before production builds to validate required variables and regenerate Prisma. Production deployments must provide `SUPER_ADMIN_PASSWORD` for seeding and must never use placeholder secrets from `env.example`.

Alternatively, for manual configuration:

```bash
# Copy example environment file
cp env.example .env

# Edit with production values
nano .env
```

**Required Production Values:**

```env
# Database
DATABASE_URL="MariaDB://eccb_user:YOUR_SECURE_PASSWORD@localhost:5432/eccb_production"

# Redis
REDIS_URL="redis://localhost:6379"

# Auth (generate with: openssl rand -base64 32)
AUTH_SECRET="your-32-char-secret-here"
BETTER_AUTH_SECRET="your-32-char-secret-here"

# URLs (use your domain)
AUTH_URL="https://your-domain.com"
BETTER_AUTH_URL="https://your-domain.com"
NEXT_PUBLIC_APP_URL="https://your-domain.com"

# Super Admin (REQUIRED in production)
SUPER_ADMIN_EMAIL="admin@your-domain.com"
SUPER_ADMIN_PASSWORD="your-secure-admin-password"

> Note: `pnpm run db:seed` requires `SUPER_ADMIN_PASSWORD` to be set and will fail if it is missing. This ensures root credentials are explicitly chosen during deployment.

# Storage
STORAGE_DRIVER="LOCAL"
LOCAL_STORAGE_PATH="/var/www/eccb/storage"

# Email (configure for production)
EMAIL_DRIVER="SMTP"
SMTP_HOST="smtp.your-provider.com"
SMTP_PORT="587"
SMTP_USER="your-smtp-user"
SMTP_PASSWORD="your-smtp-password"
SMTP_FROM="noreply@your-domain.com"

# Environment
NODE_ENV="production"
```

### 6. Database Migration

```bash
# Run migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Seed database (first deployment only)
pnpm run db:seed
```

### 7. Build Application

```bash
# Production build
pnpm run build
```

### 8. Systemd Service

Create a systemd service for the application:

```bash
sudo nano /etc/systemd/system/eccb.service
```

```ini
[Unit]
Description=ECCB Platform - Next.js Application
Documentation=https://github.com/your-org/eccb.app
After=network.target MariaDB.service redis-server.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/eccb
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node /var/www/eccb/node_modules/.bin/next start
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=eccb

# Security settings
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/www/eccb/storage /var/www/eccb/logs
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
# Set ownership
sudo chown -R www-data:www-data /var/www/eccb

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable eccb
sudo systemctl start eccb

# Check status
sudo systemctl status eccb
```

## SSL/TLS Setup

### Install Nginx

```bash
sudo apt install -y nginx
```

### Configure Nginx Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/eccb
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # SSL certificates (configure after Certbot)
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/json application/xml;

    # Proxy to Next.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # Static files
    location /_next/static {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache static_cache;
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # File uploads
    client_max_body_size 50M;
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/eccb /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### Install SSL Certificate with Certbot

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

Certbot automatically configures SSL in Nginx and sets up auto-renewal.

## Backup Strategy

### Database Backup Script

Create `/var/www/eccb/scripts/backup-production.sh`:

```bash
#!/bin/bash
set -e

# Configuration
BACKUP_DIR="/var/backups/eccb"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="eccb_production"
DB_USER="eccb_user"
RETENTION_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Database backup
pg_dump -U "$DB_USER" -d "$DB_NAME" -F c -f "$BACKUP_DIR/db_$DATE.dump"

# Compress backup
gzip "$BACKUP_DIR/db_$DATE.dump"

# Remove old backups
find "$BACKUP_DIR" -name "db_*.dump.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: db_$DATE.dump.gz"
```

```bash
# Make executable
chmod +x /var/www/eccb/scripts/backup-production.sh

# Create backup directory
sudo mkdir -p /var/backups/eccb
sudo chown www-data:www-data /var/backups/eccb
```

### File Storage Backup

```bash
#!/bin/bash
set -e

# Configuration
BACKUP_DIR="/var/backups/eccb"
STORAGE_DIR="/var/www/eccb/storage"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Create backup
tar -czf "$BACKUP_DIR/storage_$DATE.tar.gz" -C "$STORAGE_DIR" .

# Remove old backups
find "$BACKUP_DIR" -name "storage_*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "Storage backup completed: storage_$DATE.tar.gz"
```

### Automated Backups with Cron

```bash
# Edit crontab
sudo crontab -e
```

```cron
# Database backup daily at 2 AM
0 2 * * * /var/www/eccb/scripts/backup-production.sh >> /var/log/eccb-backup.log 2>&1

# Storage backup weekly on Sunday at 3 AM
0 3 * * 0 /var/www/eccb/scripts/backup-storage.sh >> /var/log/eccb-backup.log 2>&1
```

## Monitoring

### Health Check Endpoint

The application provides a health check endpoint:

```bash
curl https://your-domain.com/api/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-02-14T00:00:00.000Z",
  "database": "connected",
  "redis": "connected",
  "version": "0.1.0"
}
```

### Log Management

Application logs are handled by systemd:

```bash
# View application logs
sudo journalctl -u eccb -f

# View recent logs
sudo journalctl -u eccb -n 100

# View logs from today
sudo journalctl -u eccb --since today
```

Nginx logs:

```bash
# Access logs
sudo tail -f /var/log/nginx/access.log

# Error logs
sudo tail -f /var/log/nginx/error.log
```

### Monitoring Script

Create `/var/www/eccb/scripts/health-check.sh`:

```bash
#!/bin/bash

# Check application health
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)

if [ "$RESPONSE" != "200" ]; then
    echo "Health check failed: HTTP $RESPONSE"
    sudo systemctl restart eccb
    echo "Application restarted"
    exit 1
fi

echo "Health check passed"
exit 0
```

```bash
chmod +x /var/www/eccb/scripts/health-check.sh
```

Add to cron for automatic monitoring:

```cron
# Health check every 5 minutes
*/5 * * * * /var/www/eccb/scripts/health-check.sh >> /var/log/eccb-health.log 2>&1
```

## Updates and Maintenance

### Update Process

```bash
# Navigate to application directory
cd /var/www/eccb

# Pull latest changes
git pull origin main

# Install/update dependencies
pnpm install --frozen-lockfile

# Run database migrations
npx prisma migrate deploy

# Rebuild application
pnpm run build

# Restart service
sudo systemctl restart eccb

# Verify status
sudo systemctl status eccb
```

### Zero-Downtime Updates

For zero-downtime deployments, consider using a deployment script that:

1. Builds to a new directory
2. Runs health checks
3. Switches symlinks
4. Restarts gracefully

### Database Migrations

```bash
# Check migration status
npx prisma migrate status

# Apply pending migrations
npx prisma migrate deploy

# Create a new migration (development)
npx prisma migrate dev --name description_of_change
```

## Security Checklist

- [ ] SSH key-only authentication enabled
- [ ] UFW firewall configured (ports 22, 80, 443 only)
- [ ] fail2ban installed and running
- [ ] SSL certificate installed and auto-renewing
- [ ] Database password is strong and unique
- [ ] `.env` file has restricted permissions (600)
- [ ] `SUPER_ADMIN_PASSWORD` is set and strong
- [ ] Regular backups configured
- [ ] Security updates enabled (`unattended-upgrades`)
- [ ] File upload directory has appropriate permissions

### Firewall Setup

```bash
# Install UFW
sudo apt install -y ufw

# Configure defaults
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH, HTTP, HTTPS
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'

# Enable firewall
sudo ufw enable
```

### Fail2Ban Setup

```bash
# Install fail2ban
sudo apt install -y fail2ban

# Create local configuration
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true

[nginx-http-auth]
enabled = true
```

```bash
# Enable and start
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

## Troubleshooting

### Application Won't Start

```bash
# Check service status
sudo systemctl status eccb

# View logs
sudo journalctl -u eccb -n 50

# Check environment
cat /var/www/eccb/.env

# Verify database connection
psql -U eccb_user -d eccb_production -c "SELECT 1"
```

### Database Connection Errors

```bash
# Check MariaDB status
sudo systemctl status MariaDB

# Test connection
psql -U eccb_user -d eccb_production

# Check logs
sudo tail -f /var/log/MariaDB/MariaDB-14-main.log
```

### Redis Connection Errors

```bash
# Check Redis status
sudo systemctl status redis-server

# Test connection
redis-cli ping

# Check logs
sudo tail -f /var/log/redis/redis-server.log
```

### SSL Certificate Issues

```bash
# Test renewal
sudo certbot renew --dry-run

# Force renewal
sudo certbot renew --force-renewal

# Check certificate
sudo certbot certificates
```

### Nginx Issues

```bash
# Test configuration
sudo nginx -t

# View error logs
sudo tail -f /var/log/nginx/error.log

# Restart Nginx
sudo systemctl restart nginx
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                     Internet                         │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│                  Nginx (SSL/Proxy)                   │
│                    Port 80, 443                      │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│               Next.js Application                    │
│                    Port 3000                         │
│               (systemd: eccb.service)                │
└───────┬─────────────────┬─────────────────┬─────────┘
        │                 │                 │
┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
│  MariaDB   │ │     Redis     │ │    Storage    │
│   Port 5432   │ │   Port 6379   │ │   (Local FS)  │
└───────────────┘ └───────────────┘ └───────────────┘
```

## Support

For issues with deployment:

1. Check service logs (`journalctl -u eccb`)
2. Check Nginx error logs
3. Verify health endpoint responds
4. Check database and Redis connectivity

---

**Last Updated:** February 2026
**Status:** Production-ready for Ubuntu 22.04 LTS
