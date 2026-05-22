# ECCB Security Notes

## Secrets

Do not deploy with placeholder values from `env.example`. Generate production secrets with a secret manager or:

```bash
openssl rand -base64 32
```

Required production secrets include:

- `AUTH_SECRET`
- `BETTER_AUTH_SECRET`
- `SUPER_ADMIN_PASSWORD` during initial seeding
- storage credentials if `STORAGE_DRIVER=S3`
- SMTP credentials if `EMAIL_DRIVER=SMTP`

## Permission Contract

Use constants from `src/lib/auth/permission-constants.ts`. Runtime source must not use legacy colon-delimited permissions.

```bash
pnpm run permissions:audit
```

Legacy aliases exist only as a compatibility bridge while old data/tests are migrated. New runtime code must use canonical constants.

## Rate Limiting

Production rate limiting fails closed by default if Redis storage is unavailable. `RATE_LIMIT_FAIL_OPEN=true` is an emergency/development escape hatch and should not be enabled in production without an explicit operational decision.

## CSP

`unsafe-eval` is disabled by default. `NEXT_ENABLE_UNSAFE_EVAL=true` is an emergency escape hatch only.

## Uploads and Private Files

Music files, Smart Upload previews, and digital stand assets must remain behind authenticated, permission-scoped access controls. Public routes must not expose private storage keys or signed download URLs for unauthorized users.
