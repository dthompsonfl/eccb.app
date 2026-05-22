# ECCB Install and Build Error Fix Report

## Fixed errors

### 1. npm install ERESOLVE conflict

The root project declared `vite@^8.0.0`, but `@vitejs/plugin-react@5.1.4` only accepts Vite `^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`.

Updated:

- `package.json`
- `package-lock.json`
- `pnpm-lock.yaml`

Resolution:

- Changed Vite to `^7.3.3`, which satisfies `@vitejs/plugin-react@5.1.4` and `vitest@4.0.18`.

Validation:

- `npm install --package-lock-only --ignore-scripts` passed.
- `npm install --ignore-scripts --no-audit --no-fund` passed.

### 2. Next.js Server Action build error

The files below had file-level `'use server'` directives. In Next.js, a file-level `'use server'` directive makes every export in the file a Server Action. These files also export React page components, which caused Turbopack to fail with: `Server Actions must be async functions`.

Updated:

- `src/app/(admin)/admin/pages/new/page.tsx`
- `src/app/(admin)/admin/users/new/page.tsx`

Resolution:

- Removed file-level `'use server'` directives.
- Added inline `'use server'` directives inside the form action functions only.

## Validation notes

Attempted `npm run db:generate`, but Prisma could not download native binaries in this environment due DNS/network failure against `binaries.prisma.sh`.

Attempted `npm run build`; the previous explicit Server Action errors did not reappear before the container timeout. The build stayed at `Creating an optimized production build ...` until tool timeout, so full production build completion still needs to be run locally after applying this patch.

## Commands to run locally

```bash
rm -rf node_modules package-lock.json pnpm-lock.yaml
npm install
npm run db:generate
npm run build
```

If you prefer pnpm, use:

```bash
corepack enable
pnpm install
pnpm run db:generate
pnpm run build
```

Do not use `--force` or `--legacy-peer-deps`; the dependency conflict is resolved by the Vite downgrade to the supported Vite 7 line.
