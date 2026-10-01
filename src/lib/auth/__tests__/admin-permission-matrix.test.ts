/**
 * Admin permission-matrix tests.
 *
 * Guards the defect where two nested layouts declared contradictory role lists:
 * the outer (admin)/layout.tsx admitted LIBRARIAN while the nested
 * admin/layout.tsx required ADMIN, so librarians were redirected to /forbidden
 * from every /admin route the sidebar links them to.
 *
 * Three properties are asserted:
 *  1. Both layouts resolve through ONE canonical role matrix, and no layout
 *     declares its own list again.
 *  2. Each admin route's required permission is denied/allowed per role
 *     exactly as PERMISSIONS.md specifies.
 *  3. Every server-rendered admin page carries its own permission guard, so
 *     widening the shell gate cannot silently widen page access.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADMIN_CONSOLE_ROLES,
  ADMIN_SETTINGS_ROLES,
  isAdminConsoleRole,
  isAdminSettingsRole,
} from '@/lib/auth/admin-roles';
import {
  ANNOUNCEMENT_CREATE,
  ANNOUNCEMENT_VIEW_ALL,
  ATTENDANCE_MARK_ALL,
  ATTENDANCE_VIEW_ALL,
  AUDIT_VIEW,
  CMS_DELETE,
  CMS_EDIT,
  CMS_PUBLISH,
  CMS_VIEW_ALL,
  EVENT_CREATE,
  EVENT_DELETE,
  EVENT_EDIT,
  EVENT_PUBLISH,
  EVENT_VIEW_ALL,
  MEMBER_CREATE,
  MEMBER_EDIT_ALL,
  MEMBER_VIEW_ALL,
  MESSAGE_SEND_ALL,
  MUSIC_ASSIGN,
  MUSIC_CREATE,
  MUSIC_DOWNLOAD_ALL,
  MUSIC_EDIT,
  MUSIC_UPLOAD,
  MUSIC_VIEW_ALL,
  REPORT_EXPORT,
  REPORT_VIEW,
  STAND_ACCESS,
  SYSTEM_CONFIG,
  USER_MANAGE,
} from '@/lib/auth/permission-constants';

const REPO_ROOT = join(process.cwd(), 'src/app/(admin)');
const OUTER_LAYOUT = join(REPO_ROOT, 'layout.tsx');
const NESTED_LAYOUT = join(REPO_ROOT, 'admin/layout.tsx');

/** Role → permissions, transcribed from PERMISSIONS.md §3. */
const PERMISSIONS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  SUPER_ADMIN: new Set(['*']),
  ADMIN: new Set([
    MUSIC_VIEW_ALL,
    MUSIC_CREATE,
    MUSIC_EDIT,
    MUSIC_ASSIGN,
    MUSIC_DOWNLOAD_ALL,
    MUSIC_UPLOAD,
    MEMBER_VIEW_ALL,
    MEMBER_CREATE,
    MEMBER_EDIT_ALL,
    EVENT_VIEW_ALL,
    EVENT_CREATE,
    EVENT_EDIT,
    EVENT_DELETE,
    EVENT_PUBLISH,
    ATTENDANCE_VIEW_ALL,
    ATTENDANCE_MARK_ALL,
    CMS_VIEW_ALL,
    CMS_EDIT,
    CMS_PUBLISH,
    CMS_DELETE,
    ANNOUNCEMENT_VIEW_ALL,
    ANNOUNCEMENT_CREATE,
    MESSAGE_SEND_ALL,
    REPORT_VIEW,
    REPORT_EXPORT,
    AUDIT_VIEW,
    USER_MANAGE,
    STAND_ACCESS,
  ]),
  DIRECTOR: new Set([
    MUSIC_VIEW_ALL,
    MUSIC_EDIT,
    MUSIC_ASSIGN,
    MUSIC_DOWNLOAD_ALL,
    MEMBER_VIEW_ALL,
    MEMBER_CREATE,
    MEMBER_EDIT_ALL,
    EVENT_VIEW_ALL,
    EVENT_CREATE,
    EVENT_EDIT,
    EVENT_DELETE,
    EVENT_PUBLISH,
    ATTENDANCE_VIEW_ALL,
    ATTENDANCE_MARK_ALL,
    CMS_VIEW_ALL,
    CMS_EDIT,
    CMS_PUBLISH,
    CMS_DELETE,
    ANNOUNCEMENT_VIEW_ALL,
    ANNOUNCEMENT_CREATE,
    MESSAGE_SEND_ALL,
    REPORT_VIEW,
    REPORT_EXPORT,
    STAND_ACCESS,
  ]),
  STAFF: new Set([STAND_ACCESS]),
  LIBRARIAN: new Set([
    MUSIC_VIEW_ALL,
    MUSIC_CREATE,
    MUSIC_EDIT,
    MUSIC_ASSIGN,
    MUSIC_DOWNLOAD_ALL,
    MUSIC_UPLOAD,
    EVENT_VIEW_ALL,
    ANNOUNCEMENT_VIEW_ALL,
    STAND_ACCESS,
  ]),
  SECTION_LEADER: new Set([STAND_ACCESS]),
  MUSICIAN: new Set([STAND_ACCESS]),
};

/** Admin route → the permission its page/action requires. */
const ROUTE_PERMISSIONS: ReadonlyArray<[string, string]> = [
  ['/admin/members', MEMBER_VIEW_ALL],
  ['/admin/members/new', MEMBER_CREATE],
  ['/admin/music', MUSIC_VIEW_ALL],
  ['/admin/music/new', MUSIC_CREATE],
  ['/admin/music/librarian', MUSIC_ASSIGN],
  ['/admin/uploads', MUSIC_UPLOAD],
  ['/admin/settings', SYSTEM_CONFIG],
  ['/admin/audit', AUDIT_VIEW],
  ['/admin/users', USER_MANAGE],
  ['/admin/users/new', USER_MANAGE],
  ['/admin/roles', USER_MANAGE],
  ['/admin/pages/new', CMS_EDIT],
  ['/admin/events/new', EVENT_CREATE],
];

/** Does this role hold the given permission? SUPER_ADMIN bypasses everything. */
function roleHasPermission(role: string, permission: string): boolean {
  const perms = PERMISSIONS_BY_ROLE[role];
  if (!perms) return false;
  if (perms.has('*')) return true;
  return perms.has(permission);
}

/** Recursively collect every admin page.tsx. */
function collectAdminPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectAdminPages(full));
    } else if (entry === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

describe('admin console role matrix', () => {
  describe('single source of truth', () => {
    it('admits every role that administers the band', () => {
      expect([...ADMIN_CONSOLE_ROLES]).toEqual([
        'SUPER_ADMIN',
        'ADMIN',
        'DIRECTOR',
        'STAFF',
        'LIBRARIAN',
      ]);
    });

    it('excludes roles that do not belong in the admin console', () => {
      expect(ADMIN_CONSOLE_ROLES).not.toContain('MUSICIAN');
      expect(ADMIN_CONSOLE_ROLES).not.toContain('SECTION_LEADER');
      expect(ADMIN_CONSOLE_ROLES).not.toContain('PUBLIC');
    });

    it('admits a librarian — the defect this matrix exists to fix', () => {
      expect(isAdminConsoleRole(['LIBRARIAN'])).toBe(true);
    });

    it('admits staff and director', () => {
      expect(isAdminConsoleRole(['STAFF'])).toBe(true);
      expect(isAdminConsoleRole(['DIRECTOR'])).toBe(true);
    });

    it('admits SUPER_ADMIN even with no other role present', () => {
      expect(isAdminConsoleRole(['SUPER_ADMIN'])).toBe(true);
    });

    it('denies a plain member and a section leader', () => {
      expect(isAdminConsoleRole(['MUSICIAN'])).toBe(false);
      expect(isAdminConsoleRole(['SECTION_LEADER'])).toBe(false);
      expect(isAdminConsoleRole([])).toBe(false);
    });

    it('narrows settings administration below console access', () => {
      // A librarian reaches the console but must not reconfigure the system.
      expect([...ADMIN_SETTINGS_ROLES]).toEqual(['SUPER_ADMIN', 'ADMIN']);
      expect(isAdminConsoleRole(['LIBRARIAN'])).toBe(true);
      expect(isAdminSettingsRole(['LIBRARIAN'])).toBe(false);
      expect(isAdminSettingsRole(['ADMIN'])).toBe(true);
      expect(isAdminSettingsRole(['SUPER_ADMIN'])).toBe(true);
      expect(isAdminSettingsRole(['DIRECTOR'])).toBe(false);
    });
  });

  describe('both admin layouts use the canonical guard', () => {
    it('the outer layout calls requireAdminConsole, not a bare requireRole list', () => {
      const source = readFileSync(OUTER_LAYOUT, 'utf8');
      expect(source).toContain('requireAdminConsole');
      expect(source).not.toMatch(/requireRole\s*\(/);
    });

    it('the nested layout calls requireAdminConsole, not requireRole("ADMIN")', () => {
      const source = readFileSync(NESTED_LAYOUT, 'utf8');
      expect(source).toContain('requireAdminConsole');
      // The specific regression: an ADMIN-only list on the nested layout.
      expect(source).not.toMatch(/requireRole\s*\(\s*['"]ADMIN['"]\s*\)/);
    });

    it('neither layout declares its own role array', () => {
      for (const layout of [OUTER_LAYOUT, NESTED_LAYOUT]) {
        const source = readFileSync(layout, 'utf8');
        // Role lists must come from ADMIN_CONSOLE_ROLES, never be inlined.
        expect(source).not.toMatch(/['"]LIBRARIAN['"]/);
        expect(source).not.toMatch(/['"]SUPER_ADMIN['"]/);
      }
    });

    it('guards.ts exposes requireAdminConsole backed by ADMIN_CONSOLE_ROLES', () => {
      const source = readFileSync(join(process.cwd(), 'src/lib/auth/guards.ts'), 'utf8');
      expect(source).toContain('requireAdminConsole');
      expect(source).toContain('ADMIN_CONSOLE_ROLES');
    });
  });

  describe('route permission matrix', () => {
    it.each([
      ['/admin/members', MEMBER_VIEW_ALL],
      ['/admin/users', USER_MANAGE],
      ['/admin/settings', SYSTEM_CONFIG],
      ['/admin/audit', AUDIT_VIEW],
      ['/admin/roles', USER_MANAGE],
    ])('denies %s to LIBRARIAN', (_route, permission) => {
      expect(roleHasPermission('LIBRARIAN', permission)).toBe(false);
    });

    it.each([
      ['/admin/music', MUSIC_VIEW_ALL],
      ['/admin/music/new', MUSIC_CREATE],
      ['/admin/music/librarian', MUSIC_ASSIGN],
      ['/admin/uploads', MUSIC_UPLOAD],
    ])('allows %s to LIBRARIAN', (_route, permission) => {
      expect(roleHasPermission('LIBRARIAN', permission)).toBe(true);
    });

    it.each([
      ['/admin/settings', SYSTEM_CONFIG, 'ADMIN'],
      ['/admin/audit', AUDIT_VIEW, 'DIRECTOR'],
      ['/admin/members', MEMBER_VIEW_ALL, 'STAFF'],
      ['/admin/members', MEMBER_VIEW_ALL, 'MUSICIAN'],
      ['/admin/audit', AUDIT_VIEW, 'SECTION_LEADER'],
      ['/admin/music', MUSIC_VIEW_ALL, 'MUSICIAN'],
    ])('denies %s to %s', (_route, permission, role) => {
      expect(roleHasPermission(role, permission)).toBe(false);
    });

    it.each([
      ['/admin/members', MEMBER_VIEW_ALL, 'ADMIN'],
      ['/admin/members', MEMBER_VIEW_ALL, 'DIRECTOR'],
      ['/admin/audit', AUDIT_VIEW, 'ADMIN'],
      ['/admin/settings', SYSTEM_CONFIG, 'SUPER_ADMIN'],
      ['/admin/roles', USER_MANAGE, 'ADMIN'],
    ])('allows %s to %s', (_route, permission, role) => {
      expect(roleHasPermission(role, permission)).toBe(true);
    });

    it('SUPER_ADMIN holds every mapped permission', () => {
      for (const [, permission] of ROUTE_PERMISSIONS) {
        expect(roleHasPermission('SUPER_ADMIN', permission)).toBe(true);
      }
    });
  });

  describe('unguarded admin pages', () => {
    /**
     * Server-rendered admin pages must declare their own permission guard.
     *
     * The console shell gate was widened when the contradictory nested guard
     * was removed, so a page relying on the shell alone would silently inherit
     * librarian/director/staff access. Client components are exempt: they fetch
     * from API routes that perform their own permission checks.
     */
    it('every admin page declares a guard or is a client component', () => {
      const unguarded: string[] = [];

      for (const page of collectAdminPages(join(REPO_ROOT, 'admin'))) {
        const source = readFileSync(page, 'utf8');
        const hasGuard =
          /requirePermission\s*\(/.test(source) ||
          /requireAdminConsole\s*\(/.test(source) ||
          /requireRole\s*\(/.test(source) ||
          /requireAuth\s*\(/.test(source);
        const isClientComponent = /^['"]use client['"]/m.test(source);

        if (!hasGuard && !isClientComponent) {
          unguarded.push(page.replace(`${process.cwd()}/`, ''));
        }
      }

      expect(unguarded).toEqual([]);
    });

    it('the sensitive pages this audit added guards to keep them', () => {
      // Each entry is [relative page path, imported constant identifier]. The
      // pages import canonical constants, never inline permission strings.
      const expectations: Array<[string, string]> = [
        ['admin/audit/page.tsx', 'AUDIT_VIEW'],
        ['admin/music/new/page.tsx', 'MUSIC_CREATE'],
        ['admin/music/librarian/page.tsx', 'MUSIC_ASSIGN'],
        ['admin/users/new/page.tsx', 'USER_MANAGE'],
        ['admin/pages/new/page.tsx', 'CMS_EDIT'],
      ];

      for (const [rel, constantName] of expectations) {
        const full = join(REPO_ROOT, rel);
        expect(existsSync(full)).toBe(true);
        const source = readFileSync(full, 'utf8');
        expect(source).toContain('requirePermission');
        expect(source).toContain(constantName);
        // Guard the canonical-constant contract: no legacy colon-style string.
        expect(source).not.toMatch(/requirePermission\s*\(\s*['"]/);
      }
    });
  });
});