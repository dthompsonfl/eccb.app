import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Navigation integrity gate.
 *
 * Two failure modes are checked:
 *
 * 1. DEAD LINK — a sidebar entry pointing at a route with no `page.tsx`. The nav
 *    would offer an administrator an operation that cannot work.
 * 2. ORPHAN — a real member/admin page with no inbound link from its sidebar,
 *    making a working feature unreachable by navigation.
 *
 * The second case is what previously left /admin/monitoring, /admin/attendance
 * and /member/practice stranded: fully implemented, correctly permissioned, and
 * impossible to reach.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const AREAS = [
  {
    name: 'admin',
    sidebar: 'src/components/admin/sidebar.tsx',
    routeGroup: 'src/app/(admin)',
    prefix: '/admin',
  },
  {
    name: 'member',
    sidebar: 'src/components/member/sidebar.tsx',
    routeGroup: 'src/app/(member)',
    prefix: '/member',
  },
] as const;

/**
 * Additional inline nav arrays that are NOT in a sidebar component but still
 * render as navigation. `src/app/(admin)/admin/layout.tsx` renders alongside the
 * AdminSidebar, and previously linked to `/admin/cms`, which does not exist.
 */
const INLINE_NAVS = [
  {
    name: 'admin layout inline nav',
    source: 'src/app/(admin)/admin/layout.tsx',
    routeGroup: 'src/app/(admin)',
    prefix: '/admin',
  },
] as const;

function readSidebarHrefs(relPath: string): string[] {
  const abs = path.join(REPO_ROOT, relPath);
  const source = readFileSync(abs, 'utf8');
  const matches = source.matchAll(/href:\s*'([^']+)'/g);
  return [...new Set([...matches].map((m) => m[1]!))];
}

describe('navigation integrity', () => {
  for (const area of AREAS) {
    describe(`${area.name} sidebar`, () => {
      it('every sidebar href resolves to a real page', () => {
        const hrefs = readSidebarHrefs(area.sidebar);
        expect(hrefs.length).toBeGreaterThan(0);

        const dead = hrefs.filter(
          (href) => !existsSync(path.join(REPO_ROOT, area.routeGroup, href, 'page.tsx')),
        );

        expect(dead, `Dead navigation links: ${dead.join(', ')}`).toEqual([]);
      });
    });
  }

  describe('orphan detection', () => {
    const MUST_BE_NAVIGABLE = [
      { area: AREAS[0], href: '/admin/monitoring' },
      { area: AREAS[0], href: '/admin/attendance' },
      { area: AREAS[0], href: '/admin/events' },
      { area: AREAS[1], href: '/member/practice' },
      { area: AREAS[1], href: '/member/music' },
      { area: AREAS[1], href: '/member/attendance' },
    ];

    for (const { area, href } of MUST_BE_NAVIGABLE) {
      it(`${href} is reachable from its sidebar`, () => {
        const hrefs = readSidebarHrefs(area.sidebar);
        expect(hrefs).toContain(href);
      });
    }
  });

  describe('inline nav arrays', () => {
    for (const nav of INLINE_NAVS) {
      it(`${nav.name} contains no dead links`, () => {
        const hrefs = readSidebarHrefs(nav.source);
        expect(hrefs.length).toBeGreaterThan(0);

        const dead = hrefs.filter(
          (href) => !existsSync(path.join(REPO_ROOT, nav.routeGroup, href, 'page.tsx')),
        );

        expect(dead, `Dead links in ${nav.name}: ${dead.join(', ')}`).toEqual([]);
      });
    }
  });
});
