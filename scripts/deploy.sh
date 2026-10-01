#!/bin/bash

# ====================================
# Emerald Coast Community Band
# Application Deployment Script
# Run this after deploy-setup.sh
# ====================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_USER="eccb"
APP_DIR="/var/www/eccb"
REPO_URL="${REPO_URL:-git@github.com:your-org/eccb.app.git}"
BRANCH="${BRANCH:-main}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ECCB Application Deployment          ${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as correct user
if [[ $EUID -eq 0 ]]; then
   echo -e "${YELLOW}Switching to $APP_USER user...${NC}"
   exec sudo -u "$APP_USER" "$0" "$@"
fi

cd "$APP_DIR"

# ====================================
# 1. Backup Current Version
# ====================================
echo -e "\n${YELLOW}[1/6] Creating backup...${NC}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
if [ -d "current" ]; then
    cp -r current "backups/backup_$TIMESTAMP" 2>/dev/null || true
    echo -e "${GREEN}Backup created: backups/backup_$TIMESTAMP${NC}"
fi

mkdir -p backups releases

# ====================================
# 2. Clone/Pull Repository
# ====================================
echo -e "\n${YELLOW}[2/6] Getting latest code...${NC}"

RELEASE_DIR="releases/release_$TIMESTAMP"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE_DIR"

cd "$RELEASE_DIR"

# ====================================
# 3. Install Dependencies
# ====================================
echo -e "\n${YELLOW}[3/6] Installing dependencies...${NC}"

# Copy .env from shared location
if [ -f "$APP_DIR/shared/.env" ]; then
    cp "$APP_DIR/shared/.env" .env
else
    echo -e "${RED}Warning: No .env file found at $APP_DIR/shared/.env${NC}"
    echo -e "${YELLOW}Please create .env file before starting the application${NC}"
fi

npm ci

# ====================================
# 4. Build Application
# ====================================
echo -e "\n${YELLOW}[4/6] Building application...${NC}"

npm run build

# Copy static files for standalone
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/

# ====================================
# 5. Run Migrations
# ====================================
echo -e "\n${YELLOW}[5/6] Running database migrations...${NC}"

npx prisma migrate deploy

# ====================================
# 6. Switch to New Release
# ====================================
echo -e "\n${YELLOW}[6/6] Switching to new release...${NC}"

cd "$APP_DIR"

# Update symlink
rm -f current
ln -s "$RELEASE_DIR" current

# Create storage symlink
ln -sfn "$APP_DIR/storage" "$RELEASE_DIR/storage"

# Restart application
echo -e "\n${YELLOW}Restarting application...${NC}"
sudo systemctl restart eccb

# Wait for startup
sleep 3

# Health check (honours PORT from the environment, defaults to 3225)
if curl -s "http://localhost:${PORT:-3225}/api/health" > /dev/null 2>&1; then
    echo -e "${GREEN}Application is healthy!${NC}"
else
    echo -e "${YELLOW}Warning: Health check failed, application may still be starting...${NC}"
fi

# ====================================
# Cleanup Old Releases
# ====================================
echo -e "\n${YELLOW}Cleaning up old releases...${NC}"

cd "$APP_DIR/releases"
ls -t | tail -n +6 | xargs -r rm -rf

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment Complete!                 ${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e ""
echo -e "Current release: $RELEASE_DIR"
echo -e "To rollback: ln -sfn $APP_DIR/backups/backup_XXX $APP_DIR/current && sudo systemctl restart eccb"
