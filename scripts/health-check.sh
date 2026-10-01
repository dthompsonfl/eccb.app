#!/bin/bash

# ====================================
# Health Check Script
# For monitoring application status
# ====================================

set -e

# Configuration — honours .env overrides; defaults match src/lib/ports.ts.
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env 2>/dev/null && set +a
APP_URL="${APP_URL:-http://localhost:${PORT:-3225}}"
MINIO_URL="${MINIO_URL:-http://localhost:9000}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  ECCB Health Check                    ${NC}"
echo -e "${YELLOW}========================================${NC}"

# ====================================
# Check Next.js Application
# ====================================
echo -e "\n${YELLOW}[1/5] Checking Next.js application...${NC}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/api/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" == "200" ]; then
    echo -e "${GREEN}✓ Application is running (HTTP $HTTP_CODE)${NC}"
else
    echo -e "${RED}✗ Application is down (HTTP $HTTP_CODE)${NC}"
    ERRORS=$((ERRORS + 1))
fi

# ====================================
# Check MariaDB
# ====================================
echo -e "\n${YELLOW}[2/5] Checking MariaDB...${NC}"

if systemctl is-active --quiet mariadb; then
    echo -e "${GREEN}✓ MariaDB is running${NC}"
    
    # Test connection
    if [ -f /root/.eccb_db_password ]; then
        DB_PASSWORD=$(cat /root/.eccb_db_password)
        if mariadb -u eccb_user -p"$DB_PASSWORD" -e "SELECT 1" eccb_production &>/dev/null; then
            echo -e "${GREEN}✓ Database connection successful${NC}"
        else
            echo -e "${RED}✗ Database connection failed${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    fi
else
    echo -e "${RED}✗ MariaDB is not running${NC}"
    ERRORS=$((ERRORS + 1))
fi

# ====================================
# Check Redis
# ====================================
echo -e "\n${YELLOW}[3/5] Checking Redis...${NC}"

if systemctl is-active --quiet redis-server; then
    echo -e "${GREEN}✓ Redis is running${NC}"
    
    # Test connection
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping &>/dev/null; then
        echo -e "${GREEN}✓ Redis connection successful${NC}"
    else
        echo -e "${RED}✗ Redis connection failed${NC}"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "${RED}✗ Redis is not running${NC}"
    ERRORS=$((ERRORS + 1))
fi

# ====================================
# Check MinIO
# ====================================
echo -e "\n${YELLOW}[4/5] Checking MinIO...${NC}"

if systemctl is-active --quiet minio; then
    echo -e "${GREEN}✓ MinIO is running${NC}"
    
    # Test connection
    MINIO_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$MINIO_URL/minio/health/live" 2>/dev/null || echo "000")
    if [ "$MINIO_CODE" == "200" ]; then
        echo -e "${GREEN}✓ MinIO health check passed${NC}"
    else
        echo -e "${YELLOW}⚠ MinIO health endpoint returned $MINIO_CODE${NC}"
    fi
else
    echo -e "${RED}✗ MinIO is not running${NC}"
    ERRORS=$((ERRORS + 1))
fi

# ====================================
# Check Nginx
# ====================================
echo -e "\n${YELLOW}[5/5] Checking Nginx...${NC}"

if systemctl is-active --quiet nginx; then
    echo -e "${GREEN}✓ Nginx is running${NC}"
else
    echo -e "${RED}✗ Nginx is not running${NC}"
    ERRORS=$((ERRORS + 1))
fi

# ====================================
# Disk Space
# ====================================
echo -e "\n${YELLOW}Disk Usage:${NC}"
df -h / | tail -n 1 | awk '{printf "  Root: %s used of %s (%s)\n", $3, $2, $5}'

if [ -d /data ]; then
    df -h /data | tail -n 1 | awk '{printf "  Data: %s used of %s (%s)\n", $3, $2, $5}'
fi

# ====================================
# Memory
# ====================================
echo -e "\n${YELLOW}Memory Usage:${NC}"
free -h | awk '/^Mem:/ {printf "  Used: %s of %s (%.1f%%)\n", $3, $2, $3/$2*100}'

# ====================================
# Summary
# ====================================
echo -e "\n${YELLOW}========================================${NC}"

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}$ERRORS check(s) failed!${NC}"
    exit 1
fi
