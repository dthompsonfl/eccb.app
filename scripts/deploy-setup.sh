#!/bin/bash

# ====================================
# Emerald Coast Community Band
# Production Deployment Script
# Ubuntu 22.04 LTS Bare Metal
# ====================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="eccb"
APP_USER="eccb"
APP_DIR="/var/www/eccb"
NODE_VERSION="20"
DOMAIN="${DOMAIN:-eccb.local}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ECCB Production Deployment Script    ${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root${NC}"
   exit 1
fi

# ====================================
# 1. System Updates & Prerequisites
# ====================================
echo -e "\n${YELLOW}[1/8] Updating system and installing prerequisites...${NC}"

apt-get update
apt-get upgrade -y
apt-get install -y \
    curl \
    git \
    nginx \
    certbot \
    python3-certbot-nginx \
    mariadb-server \
    redis-server \
    ufw \
    fail2ban \
    htop \
    unzip

# ====================================
# 2. Create Application User
# ====================================
echo -e "\n${YELLOW}[2/8] Creating application user...${NC}"

if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$APP_USER"
    echo -e "${GREEN}User $APP_USER created${NC}"
else
    echo -e "${GREEN}User $APP_USER already exists${NC}"
fi

# ====================================
# 3. Install Node.js
# ====================================
echo -e "\n${YELLOW}[3/8] Installing Node.js ${NODE_VERSION}...${NC}"

if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi


echo -e "${GREEN}Node.js $(node -v) installed${NC}"
echo -e "${GREEN}npm $(npm -v) installed${NC}"

# ====================================
# 4. Configure MariaDB
# ====================================
echo -e "\n${YELLOW}[4/8] Configuring MariaDB...${NC}"

systemctl start mariadb
systemctl enable mariadb

# Secure MariaDB installation
mysql -e "DELETE FROM mysql.user WHERE User='';"
mysql -e "DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');"
mysql -e "DROP DATABASE IF EXISTS test;"
mysql -e "DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';"
mysql -e "FLUSH PRIVILEGES;"

# Create database and user
DB_PASSWORD=$(openssl rand -base64 32)
mysql -e "CREATE DATABASE IF NOT EXISTS eccb_production CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -e "CREATE USER IF NOT EXISTS 'eccb'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';"
mysql -e "GRANT ALL PRIVILEGES ON eccb_production.* TO 'eccb'@'localhost';"
mysql -e "FLUSH PRIVILEGES;"

echo -e "${GREEN}MariaDB configured${NC}"
echo -e "${YELLOW}Database password saved to /root/.eccb_db_password${NC}"
echo "$DB_PASSWORD" > /root/.eccb_db_password
chmod 600 /root/.eccb_db_password

# ====================================
# 5. Configure Redis
# ====================================
echo -e "\n${YELLOW}[5/8] Configuring Redis...${NC}"

# Configure Redis for security
sed -i 's/^# maxmemory .*/maxmemory 256mb/' /etc/redis/redis.conf
sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf

systemctl restart redis-server
systemctl enable redis-server

echo -e "${GREEN}Redis configured${NC}"

# ====================================
# 6. Setup Application Directory
# ====================================
echo -e "\n${YELLOW}[6/8] Setting up application directory...${NC}"

mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/storage"
mkdir -p "$APP_DIR/logs"

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo -e "${GREEN}Application directory created at $APP_DIR${NC}"

# ====================================
# 7. Configure Nginx
# ====================================
echo -e "\n${YELLOW}[7/8] Configuring Nginx...${NC}"

cat > /etc/nginx/sites-available/eccb << 'NGINX_EOF'
upstream eccb_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN_PLACEHOLDER;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name DOMAIN_PLACEHOLDER;

    # SSL Configuration (will be managed by certbot)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # Modern SSL Configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    # Client max body size for file uploads
    client_max_body_size 100M;

    # Root and index
    root /var/www/eccb/current/public;

    # Logging
    access_log /var/www/eccb/logs/access.log;
    error_log /var/www/eccb/logs/error.log;

    # Static files
    location /_next/static {
        alias /var/www/eccb/current/.next/static;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /images {
        expires 30d;
        add_header Cache-Control "public";
    }

    # Service worker and manifest
    location /sw.js {
        add_header Cache-Control "no-cache";
        proxy_pass http://eccb_backend;
    }

    location /manifest.json {
        add_header Cache-Control "no-cache";
    }

    # API and Next.js
    location / {
        proxy_pass http://eccb_backend;
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
}
NGINX_EOF

# Replace domain placeholder
sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" /etc/nginx/sites-available/eccb

# Enable site
ln -sf /etc/nginx/sites-available/eccb /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and reload nginx
nginx -t
systemctl reload nginx

echo -e "${GREEN}Nginx configured${NC}"

# ====================================
# 8. Configure Firewall
# ====================================
echo -e "\n${YELLOW}[8/8] Configuring firewall...${NC}"

ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
ufw --force enable

echo -e "${GREEN}Firewall configured${NC}"

# ====================================
# 9. Create Systemd Service
# ====================================
echo -e "\n${YELLOW}Creating systemd service...${NC}"

cat > /etc/systemd/system/eccb.service << 'SERVICE_EOF'
[Unit]
Description=Emerald Coast Community Band Web Application
After=network.target mariadb.service redis-server.service

[Service]
Type=simple
User=eccb
WorkingDirectory=/var/www/eccb/current
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node /var/www/eccb/current/.next/standalone/server.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=eccb

# Security
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/www/eccb/storage /var/www/eccb/logs

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable eccb

echo -e "${GREEN}Systemd service created${NC}"

# ====================================
# Summary
# ====================================
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment Setup Complete!           ${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e ""
echo -e "Next steps:"
echo -e "1. Clone your repository to $APP_DIR/current"
echo -e "2. Create .env file with production settings"
echo -e "3. Run 'npm ci' and 'npm run build'"
echo -e "4. Run database migrations: 'npx prisma migrate deploy'"
echo -e "5. Start the service: 'systemctl start eccb'"
echo -e "6. (Optional) Setup SSL with: 'certbot --nginx -d $DOMAIN'"
echo -e ""
echo -e "Database credentials:"
echo -e "  User: eccb"
echo -e "  Password: stored in /root/.eccb_db_password"
echo -e "  Database: eccb_production"
echo -e ""
echo -e "${YELLOW}Remember to setup MinIO for file storage!${NC}"
