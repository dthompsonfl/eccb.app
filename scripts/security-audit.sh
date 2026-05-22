#!/usr/bin/env bash

# ====================================
# ECCB Security Audit
# Package-manager aware dependency audit for CI and release gates.
# ====================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

AUDIT_LEVEL="${AUDIT_LEVEL:-moderate}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-text}"
EXIT_ON_VULN="${EXIT_ON_VULN:-true}"

cd "$(dirname "$0")/.."

if [[ -f pnpm-lock.yaml ]]; then
  PACKAGE_MANAGER="pnpm"
elif [[ -f package-lock.json ]]; then
  PACKAGE_MANAGER="npm"
else
  echo -e "${RED}Error: no supported lockfile found. Expected pnpm-lock.yaml or package-lock.json.${NC}"
  exit 1
fi

if ! command -v "$PACKAGE_MANAGER" >/dev/null 2>&1; then
  echo -e "${RED}Error: ${PACKAGE_MANAGER} is not installed or not available on PATH.${NC}"
  exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  ECCB Security Audit                  ${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Package manager: ${PACKAGE_MANAGER}"
echo -e "Audit level: ${AUDIT_LEVEL}"
echo -e "Output format: ${OUTPUT_FORMAT}"
echo ""

if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  AUDIT_OUTPUT=$("$PACKAGE_MANAGER" audit --audit-level="$AUDIT_LEVEL" --json 2>&1 || true)
else
  AUDIT_OUTPUT=$("$PACKAGE_MANAGER" audit --audit-level="$AUDIT_LEVEL" 2>&1 || true)
fi

if echo "$AUDIT_OUTPUT" | grep -qiE "found 0 vulnerabilities|No known vulnerabilities found"; then
  echo -e "${GREEN}No vulnerabilities found at or above ${AUDIT_LEVEL}.${NC}"
  exit 0
fi

echo "$AUDIT_OUTPUT"
echo ""
echo -e "${YELLOW}Remediation:${NC}"
echo "  1. Review the vulnerable advisory and affected dependency path."
echo "  2. Prefer a targeted package upgrade over force-upgrading the dependency graph."
echo "  3. Re-run: pnpm run security:audit"
echo ""

if [[ "$EXIT_ON_VULN" == "true" ]]; then
  echo -e "${RED}Security audit failed. Address vulnerabilities before release.${NC}"
  exit 1
fi
