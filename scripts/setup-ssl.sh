#!/bin/bash

# ====================================
# SSL Certificate Setup with Let's Encrypt
# Automated certificate generation and renewal
# ====================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check for domain argument
if [ -z "$1" ]; then
    echo -e "${RED}Usage: $0 <domain> [email]${NC}"
    echo -e "Example: $0 eccb.example.com admin@example.com"
    exit 1
fi

DOMAIN="$1"
EMAIL="${2:-webmaster@$DOMAIN}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  SSL Certificate Setup                ${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "Domain: $DOMAIN"
echo -e "Email: $EMAIL"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}This script must be run as root${NC}"
   exit 1
fi

# ====================================
# 1. Install Certbot
# ====================================
echo -e "\n${YELLOW}[1/4] Installing Certbot...${NC}"

apt-get update
apt-get install -y certbot python3-certbot-nginx

echo -e "${GREEN}Certbot installed${NC}"

# ====================================
# 2. Obtain Certificate
# ====================================
echo -e "\n${YELLOW}[2/4] Obtaining SSL certificate...${NC}"

# Stop nginx temporarily for standalone verification
systemctl stop nginx || true

certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    --domain "$DOMAIN" \
    --preferred-challenges http

# Start nginx back
systemctl start nginx

echo -e "${GREEN}Certificate obtained${NC}"

# ====================================
# 3. Update Nginx Configuration
# ====================================
echo -e "\n${YELLOW}[3/4] Updating Nginx configuration...${NC}"

cat > /etc/nginx/sites-available/eccb << EOF
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_session_tickets off;

    # Modern SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Root and index
    root /var/www/eccb/current/public;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    # Static files
    location /_next/static {
        alias /var/www/eccb/current/.next/static;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /static {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Service worker
    location /sw.js {
        add_header Cache-Control "no-cache";
        proxy_pass http://localhost:3225;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    # PWA manifest
    location /manifest.json {
        add_header Cache-Control "no-cache";
    }

    # Proxy to Next.js
    location / {
        proxy_pass http://localhost:3225;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # MinIO files proxy (optional, if serving files through nginx)
    location /files/ {
        proxy_pass http://localhost:9000/eccb-files/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Error pages
    error_page 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }
}
EOF

# Test configuration
nginx -t

# Reload nginx
systemctl reload nginx

echo -e "${GREEN}Nginx configuration updated${NC}"

# ====================================
# 4. Setup Auto-Renewal
# ====================================
echo -e "\n${YELLOW}[4/4] Setting up auto-renewal...${NC}"

# Create renewal hook to reload nginx
mkdir -p /etc/letsencrypt/renewal-hooks/deploy

cat > /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh << 'HOOK'
#!/bin/bash
systemctl reload nginx
HOOK

chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx-reload.sh

# Test renewal
certbot renew --dry-run

echo -e "${GREEN}Auto-renewal configured${NC}"

# ====================================
# Summary
# ====================================
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  SSL Setup Complete!                  ${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e ""
echo -e "Domain: https://$DOMAIN"
echo -e ""
echo -e "Certificate location:"
echo -e "  /etc/letsencrypt/live/$DOMAIN/"
echo -e ""
echo -e "Auto-renewal: Enabled (cron job via certbot)"
echo -e ""
echo -e "${YELLOW}Note: Update your .env file:${NC}"
echo -e "  NEXT_PUBLIC_APP_URL=https://$DOMAIN"
echo -e "  BETTER_AUTH_URL=https://$DOMAIN"
