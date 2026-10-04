/**
 * SUPER_ADMIN privilege-bypass coverage.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two SUPER_ADMIN bypasses grant unrestricted access — one in `requireRole`
 * (`guards.ts`) and one in `checkUserPermission` (`permissions.ts`). Mutation
 * testing showed DELETING EITHER ONE left all tests green.
 *
 * The existing `guards.test.ts` has a test named "should recognize SUPER_ADMIN
 * as having all elevated privileges", but it mocks `prisma.userRole.findFirst`
 * to RETURN a SUPER_ADMIN role. The bypass branch is then indistinguishable
 * from the generic `roles.some(...)` lookup — the test asserts the fixture, not
 * the logic. Pass the same fixture with the bypass deleted and it still passes.
 *
 * The only way to test a bypass is to prove that its ABSENCE changes the
 * outcome. That requires the general path to yield a DENY for the same
 * permissions/roles the bypass overrides. Every test here does exactly that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUserRoleFindFirst = vi.fn();
const mockUserRoleFindMany = vi.fn();
const redisGet = vi.fn();
const redisDel = vi.fn();
const redisSet = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    userRole: {
      findFirst: (...a: unknown[]) => mockUserRoleFindFirst(...a),
      // `getUserPermissions` includes role.permissions.permission and reads
      // `permission.name`, so the mock must carry that nesting.
      findMany: (...a: unknown[]) => mockUserRoleFindMany(...a),
    },
  },
}));

// No cached permissions, so the code must actually consult the database.
vi.mock('@/lib/redis', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    del: (...a: unknown[]) => redisDel(...a),
    set: (...a: unknown[]) => redisSet(...a),
  },
  invalidatePermissionCache: vi.fn(),
  invalidateAllPermissionCaches: vi.fn(),
}));

vi.mock('@/lib/auth/permission-constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/permission-constants')>();
  return { ...actual, ALL_PERMISSIONS: actual.ALL_PERMISSIONS ?? [] };
});

import { checkUserPermission } from '../permissions';
import { requireRole } from '../guards';

const redirectMock = vi.fn();

// `requireRole` calls `redirect()` from next/navigation on failure, which in a
// test environment throws. Capture it so a DENY is observable as a value rather
// than as a control-flow exception.
vi.mock('next/navigation', () => ({
  redirect: (...a: unknown[]) => redirectMock(...a),
}));

const mockGetSession = vi.fn();

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: 'better-auth.session_token=x' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue(undefined);
  redisDel.mockResolvedValue(undefined);
});

/**
 * A user holding exactly ONE role, with the given permission grants.
 *
 * The shape mirrors what `getUserPermissions` actually queries:
 * userRole -> role -> permissions[] -> permission.name
 */
function userWithRole(roleType: string, grantedPermissions: string[] = []) {
  // `getUserRoles` maps `ur.role.name`; the guards map `ur.role.type`. Carry
  // both so the fixture satisfies either projection.
  const role = {
    name: roleType,
    type: roleType,
    permissions: grantedPermissions.map((name) => ({ permission: { name } })),
  };
  mockUserRoleFindFirst.mockResolvedValue({ role });
  mockUserRoleFindMany.mockResolvedValue([{ role }]);
}

describe('checkUserPermission — SUPER_ADMIN bypass', () => {
  it('grants a permission the user has NO grant for', async () => {
    userWithRole('SUPER_ADMIN', []);

    // The general path would deny this: no RolePermission row exists.
    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(true);
  });

  it('the bypass is what grants it — a MEMBER is denied the same permission', async () => {
    userWithRole('MEMBER', []);
    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(false);
  });

  it('still honours the real grant list for a non-super-admin', async () => {
    userWithRole('LIBRARIAN', ['music.view.all']);
    await expect(checkUserPermission('u1', 'music.view.all')).resolves.toBe(true);
    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(false);
  });

  it('a role that merely CONTAINS admin does not get the bypass', async () => {
    // Guards against the bypass being widened to any admin-ish role.
    userWithRole('ADMIN', []);
    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(false);
  });

  it('multiple non-super-admin roles still require an explicit grant', async () => {
    const adminRole = {
      name: 'ADMIN',
      type: 'ADMIN',
      permissions: [{ permission: { name: 'music.view.all' } }],
    };
    const librarianRole = { name: 'LIBRARIAN', type: 'LIBRARIAN', permissions: [] };
    mockUserRoleFindFirst.mockResolvedValue({ role: adminRole });
    mockUserRoleFindMany.mockResolvedValue([
      { role: adminRole },
      { role: librarianRole },
    ]);

    await expect(checkUserPermission('u1', 'music.view.all')).resolves.toBe(true);
    await expect(checkUserPermission('u1', 'attendance.mark.all')).resolves.toBe(false);
  });

  it('normalises the requested permission before comparing', async () => {
    userWithRole('SUPER_ADMIN', []);
    // Both spellings resolve true via the bypass; the point is that the bypass
    // sits BEFORE the normalisation-sensitive lookup and cannot be bypassed by
    // passing a differently-cased alias.
    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(true);
  });
});

describe('SUPER_ADMIN bypass cannot be reached by a user with no roles', () => {
  it('denies when the user holds nothing', async () => {
    mockUserRoleFindFirst.mockResolvedValue(null);
    mockUserRoleFindMany.mockResolvedValue([]);

    await expect(checkUserPermission('u1', 'members.delete')).resolves.toBe(false);
  });
});

describe('requireRole — SUPER_ADMIN bypass', () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
  });

  it('lets SUPER_ADMIN through a role check they do not hold', async () => {
    userWithRole('SUPER_ADMIN');

    const result = await requireRole('DIRECTOR');

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.roles).toContain('SUPER_ADMIN');
  });

  it('redirects a plain MEMBER who lacks the role', async () => {
    // The counterpart that makes the bypass observable: with the same
    // assertion, removing the bypass turns this pass into a redirect.
    userWithRole('MEMBER');

    await requireRole('DIRECTOR');

    expect(redirectMock).toHaveBeenCalledWith('/forbidden');
  });

  it('a role that merely contains admin does not bypass', async () => {
    userWithRole('ADMIN');

    await requireRole('DIRECTOR');

    expect(redirectMock).toHaveBeenCalledWith('/forbidden');
  });

  it('an explicit role match passes without any bypass', async () => {
    userWithRole('DIRECTOR');

    const result = await requireRole('DIRECTOR');

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.roles).toEqual(['DIRECTOR']);
  });

  it('SUPER_ADMIN satisfies ANY requested role', async () => {
    userWithRole('SUPER_ADMIN');
    await requireRole('LIBRARIAN', 'DIRECTOR', 'SECTION_LEADER');
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
