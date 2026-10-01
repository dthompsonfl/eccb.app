#!/usr/bin/env bash
#
# Rewrite package-manager references from pnpm to npm across the repository.
#
# npm is the canonical manager (see docs/TOOLCHAIN.md):
#   - package.json declares "packageManager": "npm@11.1.0", which makes pnpm
#     refuse to run in this repo at all
#   - package-lock.json is the only tracked lockfile and is in sync
#   - CI uses `npm ci`
#
# docs/TOOLCHAIN.md is EXCLUDED: it documents the pnpm->npm decision and must
# keep mentioning pnpm to explain why the change was made.

import re
import sys
from pathlib import Path

ROOT = Path('.').resolve()

# Files to rewrite: operator/developer-facing docs and scripts.
TARGET_GLOBS = [
    '*.md',
    'scripts/*.sh',
    'docs/*.md',
    'plans/*.md',
    '.github/prompts/old/*.md',
    'opencode.json',
]

# Never touch these.
EXCLUDE = {
    'docs/TOOLCHAIN.md',
    'CHANGELOG.md',
}

SKIP_DIRS = {'.git', 'node_modules', '.next', '.serena', '.trash', '.agent', '.jules', '.kilocode', '.legacy', 'storage', 'logs', 'outbox'}

# Ordered substitutions, most specific first.
SUBS: list[tuple[str, str]] = [
    # Full commands.
    (r'pnpm install --frozen-lockfile', 'npm ci'),
    (r'pnpm install --no-frozen-lockfile', 'npm ci'),
    (r'\bpnpm install\b', 'npm ci'),
    (r'\bpnpm run dev:full\b', 'npm run dev:full'),
    (r'\bpnpm run\b', 'npm run'),
    (r'\bpnpm exec\b', 'npx'),
    (r'\bpnpm build\b', 'npm run build'),
    (r'\bpnpm start\b', 'npm run start'),
    (r'\bpnpm test\b', 'npm run test:run'),
    (r'\bpnpm audit\b', 'npm audit'),
    (r'\bpnpm lint\b', 'npm run lint'),
    (r'\bpnpm typecheck\b', 'npm run typecheck'),
    (r'\bpnpm prisma\b', 'npx prisma'),
    (r'\bpnpm add\b', 'npm install'),
    (r'\bpnpm remove\b', 'npm uninstall'),
    (r'\bpnpm update\b', 'npm update'),
    (r'\bpnpm approve-builds\b', 'npm rebuild'),
    (r'\bpnpm store prune\b', 'npm cache clean --force'),
    # Global install of pnpm itself -> remove the step entirely.
    (r'^# Install pnpm globally\n', ''),
    (r'^npm install -g pnpm\n', ''),
    # Lockfile detection.
    (r'\bpnpm-lock\.yaml\b', 'package-lock.json'),
    # Version pin references.
    (r'pnpm/action-setup@v3', '(n/a — npm is canonical)'),
    (r'pnpm 9', 'npm 11'),
    (r"'9'", "'11'"),
    # Leftover bare mentions in prose.
    (r'\bpnpm\b', 'npm'),
]


def should_skip(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    if rel in EXCLUDE:
        return True
    if any(part in SKIP_DIRS for part in rel.split('/')):
        return True
    return False


def main() -> int:
    targets: set[Path] = set()
    for pattern in TARGET_GLOBS:
        for p in ROOT.glob(pattern):
            if p.is_file():
                targets.add(p)

    changed: list[tuple[str, int]] = []

    for path in sorted(targets):
        if should_skip(path):
            continue
        try:
            original = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        if 'pnpm' not in original:
            continue

        updated = original
        for pattern, repl in SUBS:
            updated = re.sub(pattern, repl, updated, flags=re.MULTILINE)

        if updated != original:
            path.write_text(updated, encoding='utf-8')
            rel = path.relative_to(ROOT).as_posix()
            remaining = len(re.findall(r'pnpm', updated))
            changed.append((rel, remaining))

    print(f'rewrote {len(changed)} file(s):')
    for rel, remaining in changed:
        note = f'  ({remaining} pnpm mention(s) left)' if remaining else ''
        print(f'  {rel}{note}')

    return 0


if __name__ == '__main__':
    sys.exit(main())
