# ECCB Release Gates

This application is not considered release-ready until every required gate below is executed against the same commit that will be deployed. Do not treat historical `build_output.log` data as release evidence.

## Package Manager Contract

The repository uses pnpm as the authoritative package manager. CI and local release checks must use the checked-in `pnpm-lock.yaml`.

```bash
pnpm install --frozen-lockfile
```

## Required Local/CI Validation

Run these commands in order:

```bash
pnpm run setup
pnpm run db:generate
pnpm run typecheck
pnpm run lint
pnpm run test:run
pnpm run test:coverage
pnpm run build
pnpm run test:e2e:ci
pnpm run security:audit
pnpm run validate
```

If a command cannot run in the current environment, document the exact blocker and classify it as one of:

- pre-existing unrelated
- pre-existing relevant
- introduced by the change
- environment/tooling issue
- unknown

## Database Gates

Before production deployment:

```bash
pnpm run db:migrate:deploy
pnpm run db:seed
```

Production seeding requires an explicitly configured `SUPER_ADMIN_PASSWORD`. Never deploy with placeholders from `env.example`.

## Permission Gates

The runtime permission contract is `resource.action.scope` using constants from `src/lib/auth/permission-constants.ts`.

Required checks:

```bash
pnpm run permissions:audit
pnpm run test:run -- src/lib/auth
```

Release is blocked if runtime source contains colon-delimited permission checks such as `music:read`, `members:read`, or `events:create`.

## Security Gates

Release is blocked by:

- unresolved high/critical dependency vulnerabilities
- production placeholder secrets
- public access to private music files
- admin/API mutations without server-side authorization
- mutating browser requests without CSRF protection
- upload paths that allow invalid file types or path traversal
- rate limiting configured to fail open in production without an approved exception

## E2E Gates

At minimum, Playwright must cover:

- public homepage and public content routes
- login page
- signup page
- admin dashboard
- member management surfaces
- event management surfaces
- attendance surface
- music library surface
- digital music stand access boundary
- permission-denied/unauthenticated behavior
- mobile/tablet smoke paths

Authenticated E2E tests require one of these env pairs:

```bash
E2E_ADMIN_EMAIL=admin@example.org
E2E_ADMIN_PASSWORD=...
```

or the seeded super-admin values:

```bash
SUPER_ADMIN_EMAIL=admin@example.org
SUPER_ADMIN_PASSWORD=...
```

## Rollback Gates

Every deployment must have:

- database backup before migration
- file storage backup or snapshot for uploaded music assets
- rollback command/path documented in deployment notes
- previous artifact or container image available
- operator who owns validation after rollback

## Documentation Gates

Before release, verify that README, LOCAL_SETUP, DEPLOYMENT, TESTING, SECURITY, OPERATIONS, and environment docs match the actual scripts and runtime behavior.
