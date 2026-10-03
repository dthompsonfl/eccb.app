# Canonical Toolchain

This document is the single source of truth for the build toolchain. If any
other document, script, or CI workflow disagrees with this one, this document
and `package.json` win, and the other file is a bug.

## Package manager: npm

**npm is the canonical package manager for this repository.**

### Why (the evidence)

An earlier audit recommended normalizing on pnpm "unless repository evidence
proves otherwise." Repository evidence proves otherwise, decisively:

| Evidence | Result |
| --- | --- |
| `package.json` → `packageManager` | `"npm@11.1.0"` — pnpm **refuses to run** in this repo because of this field. CI using pnpm would fail immediately. |
| Installed `node_modules` | Built by npm. `node_modules/.package-lock.json` exists; `node_modules/.modules.yaml` (pnpm's marker) does not. |
| `package-lock.json` vs `package.json` | **In sync.** 0 dependencies missing, 0 version mismatches. |
| `package-lock.json` vs installed tree | **Exact match** (e.g. `vite` 8.0.14, `@vitejs/plugin-react` 6.0.2). |
| `pnpm-lock.yaml` vs `package.json` | **Stale.** Pinned `vite` 7.3.3 and `@vitejs/plugin-react` 5.1.2, while `package.json` requires `vite` ^8.0.0 and `@vitejs/plugin-react` ^6.0.2. |
| Every script in `package.json` | Uses `npm run …`. Zero use pnpm. |
| Documentation + CI | Said "pnpm" — this was the incorrect minority. |

`pnpm-lock.yaml` was a stale artifact: had CI used `pnpm install
--frozen-lockfile`, it would have installed Vite 7 against a Vite 8 codebase.
It has been deleted. The stale `pnpm/action-setup` steps in both workflows
would also have failed outright, because `packageManager: npm@11.1.0` makes
pnpm abort with *"This project is configured to use npm"*.

### Consequences

- `package-lock.json` is the **only** lockfile. Do not reintroduce
  `pnpm-lock.yaml`, `yarn.lock`, or `bun.lockb`.
- CI uses `npm ci`, which **fails** if the lockfile is out of sync with
  `package.json`. A drifted lockfile is a build failure, not a silent
  install.
- Node is pinned to `>=22 <27` in `package.json` `engines`; CI runs Node 22
  (the lowest supported major) so version-specific breakage surfaces in CI.

## Canonical install

```bash
# CI / clean checkout / release rehearsal
npm ci

# Local development, after intentionally changing dependencies
npm install
```

## Canonical validation ladder

Run in this order. Each step must pass before the next.

```bash
npm run security:scan-secrets   # no committed env files or secrets
npm run permissions:audit       # permission constants are canonical
npx tsx scripts/assert-no-skipped-tests.ts
npm run typecheck
npm run lint
npm run test:run
npm run test:coverage
npm run test:smart-upload:fixtures
npm run check-routes
npm run db:generate
npm run build
npm run test:e2e:ci
npm audit --audit-level=moderate
```

Convenience wrappers:

```bash
npm run validate        # secrets → lint → typecheck → test:run → build
npm run validate:ci     # the above, plus E2E
npm run security:audit  # scripts/security-audit.sh
```

## Database

**MySQL is canonical.** Prisma declares `provider = "mysql"`, CI provisions
`mysql:8`, and deployment targets MariaDB (wire-compatible, driven through
`@prisma/adapter-mariadb`). `prisma.config.ts` normalizes `mariadb://` and
`postgresql://` URLs to `mysql://` so a MariaDB deployment URL works unchanged.
No PostgreSQL support exists or is claimed.

## Process topology

Production runs **two** supervised processes, not one:

| Process | Command | Purpose |
| --- | --- | --- |
| web | `scripts/serve.ts` under tsx | HTTP + Server Actions **and** the Stand Socket.IO server, on one port |
| workers | `npm run start:workers` (`tsx src/workers/index.ts`) | email, scheduler, Smart Upload, OCR, cleanup |

`npm run start:all` runs both under one supervising process — preflight, port
resolution, restart-with-backoff, and a real readiness gate. It is the
recommended way to run the whole system locally, and it exercises the same two
entry points systemd does.

There is deliberately **no third `sockets` process**. `src/server/socket-worker.ts`
(`npm run start:sockets`) is a standalone entry point that binds `SOCKET_PORT`
separately; it is unreachable from the browser because a WebSocket upgrade can
never be proxied by a `next.config.ts` rewrite. Do not start it alongside
`serve.ts` — see `DEPLOYMENT.md`.
