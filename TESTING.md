# ECCB Testing Guide

## Command Contract

```bash
pnpm install --frozen-lockfile
pnpm run setup
pnpm run typecheck
pnpm run lint
pnpm run test:run
pnpm run test:coverage
pnpm run test:e2e:ci
pnpm run build
```

## Permission Regression Testing

Runtime code must import permission constants from `src/lib/auth/permission-constants.ts`.

```bash
pnpm run permissions:audit
```

This fails if runtime source reintroduces old colon-delimited permission strings.

## Playwright E2E Setup

The Playwright suite lives in `e2e/`.

Unauthenticated/public tests can run without credentials. Authenticated admin tests require either:

```bash
E2E_ADMIN_EMAIL=...
E2E_ADMIN_PASSWORD=...
```

or:

```bash
SUPER_ADMIN_EMAIL=...
SUPER_ADMIN_PASSWORD=...
```

Run:

```bash
pnpm run test:e2e:ci
```

## Failure Classification

Every failed check must be classified as:

- pre-existing unrelated
- pre-existing relevant
- introduced by the change
- environment/tooling issue
- unknown

Only unrelated pre-existing failures may be excluded from a release decision, and they still need documentation.
