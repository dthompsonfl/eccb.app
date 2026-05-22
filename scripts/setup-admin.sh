#!/usr/bin/env bash
# Validate environment and ensure SUPER_ADMIN credentials are present for production builds.
# Intended to run as part of `pnpm run build` when wired explicitly by the deployment pipeline.

set -euo pipefail
shopt -s expand_aliases

# Load .env if exists (useful for local dev)
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a
  # support lines like KEY="value" and KEY=value
  . .env
  set +a
else
  echo "⚠️  No .env file found."
  echo "   Run 'pnpm run setup' to create one interactively with all required variables."
  exit 0
fi

NODE_ENV=${NODE_ENV:-development}
CI=${CI:-false}

echo "🔎 Running environment checks (NODE_ENV=${NODE_ENV}, CI=${CI})"

missing_count=0
missing_vars=()

check_required() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    missing_count=$((missing_count + 1))
    missing_vars+=("$var")
    echo "  - MISSING: $var"
    return 1
  fi
  return 0
}

# Always-recommended variables (build/runtime important)
RECOMMENDED=(DATABASE_URL NEXT_PUBLIC_APP_URL AUTH_SECRET BETTER_AUTH_SECRET)
for v in "${RECOMMENDED[@]}"; do
  if ! check_required "$v"; then :; fi
done

# Production-only strict requirements
if [ "$NODE_ENV" = "production" ]; then
  echo "  – Enforcing production environment requirements"
  PROD_REQUIRED=(SUPER_ADMIN_EMAIL SUPER_ADMIN_PASSWORD)
  for v in "${PROD_REQUIRED[@]}"; do
    if ! check_required "$v"; then :; fi
  done

  # Length checks
  if [ -n "${AUTH_SECRET:-}" ] && [ "${#AUTH_SECRET}" -lt 32 ]; then
    echo "  - ERROR: AUTH_SECRET must be at least 32 characters"
    missing_count=$((missing_count + 1))
    missing_vars+=("AUTH_SECRET_LENGTH")
  fi
  if [ -n "${BETTER_AUTH_SECRET:-}" ] && [ "${#BETTER_AUTH_SECRET}" -lt 32 ]; then
    echo "  - ERROR: BETTER_AUTH_SECRET must be at least 32 characters"
    missing_count=$((missing_count + 1))
    missing_vars+=("BETTER_AUTH_SECRET_LENGTH")
  fi
  if [ -n "${SUPER_ADMIN_PASSWORD:-}" ] && [ "${#SUPER_ADMIN_PASSWORD}" -lt 8 ]; then
    echo "  - ERROR: SUPER_ADMIN_PASSWORD must be at least 8 characters"
    missing_count=$((missing_count + 1))
    missing_vars+=("SUPER_ADMIN_PASSWORD_LENGTH")
  fi
fi

# Conditional checks for optional drivers
STORAGE_DRIVER=${STORAGE_DRIVER:-LOCAL}
if [ "$STORAGE_DRIVER" = "S3" ]; then
  echo "  – STORAGE_DRIVER=S3 — validating S3 vars"
  for v in S3_ENDPOINT S3_BUCKET_NAME S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    if ! check_required "$v"; then :; fi
  done
fi

EMAIL_DRIVER=${EMAIL_DRIVER:-LOG}
if [ "$EMAIL_DRIVER" = "SMTP" ]; then
  echo "  – EMAIL_DRIVER=SMTP — validating SMTP vars"
  for v in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD; do
    if ! check_required "$v"; then :; fi
  done
fi

# Decide whether to fail
if [ "$missing_count" -gt 0 ]; then
  echo "\n⚠️  Found ${missing_count} missing/invalid environment values.\n"
  # Fail only for non-CI production builds (prevent breaking CI and test runners)
  if [ "$NODE_ENV" = "production" ] && [ "$CI" != "true" ]; then
    echo "❌ Aborting: production build requires the missing environment variables listed above."
    echo "   (When running in CI the check is permissive so test/build pipelines are not blocked.)"
    exit 1
  else
    echo "⚠️  WARNING: continuing because this is not a non-CI production build."
  fi
fi

# Write a masked summary so operators can quickly verify captured values (no secrets written)
REPORT_DIR="./build"
REPORT_FILE="$REPORT_DIR/env-variables-check.txt"
mkdir -p "$REPORT_DIR"
{
  echo "ENV CHECK REPORT"
  echo "NODE_ENV=$NODE_ENV"
  echo "CI=$CI"
  echo ""
  for var in DATABASE_URL REDIS_URL AUTH_SECRET BETTER_AUTH_SECRET AUTH_URL BETTER_AUTH_URL NEXT_PUBLIC_APP_URL SUPER_ADMIN_EMAIL SUPER_ADMIN_PASSWORD STORAGE_DRIVER EMAIL_DRIVER; do
    if [ -n "${!var:-}" ]; then
      val="${!var}"
      if [[ "$var" == *PASSWORD* || "$var" == *SECRET* || "$var" == *KEY* ]]; then
        echo "$var=present (length=${#val})"
      else
        echo "$var=${val}"
      fi
    else
      echo "$var=missing"
    fi
  done
} > "$REPORT_FILE"

echo "✅ Environment validation complete — summary written to $REPORT_FILE"

exit 0
