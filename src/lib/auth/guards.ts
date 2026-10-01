import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_CONSOLE_ROLES } from '@/lib/auth/admin-roles';

// Get current session
export async function getSession() {
  const headersList = await headers();
  return auth.api.getSession({ headers: headersList });
}

// Require authentication - redirect to login if not authenticated
export async function requireAuth() {
  const session = await getSession();
  
  if (!session?.user) {
    redirect('/login');
  }
  
  return session;
}

// Require specific role(s)
export async function requireRole(...roles: string[]) {
  const session = await requireAuth();
  
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId: session.user.id,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ],
    },
    include: {
      role: true,
    },
  });
  
  const userRoleTypes = userRoles.map(ur => ur.role.type);
  // SUPER_ADMIN bypasses all role checks
  const hasRole = userRoleTypes.includes('SUPER_ADMIN') || roles.some(role => userRoleTypes.includes(role as never));
  
  if (!hasRole) {
    redirect('/forbidden');
  }
  
  return { session, roles: userRoleTypes };
}

/**
 * Require entry to the admin console shell.
 *
 * Single canonical guard for BOTH admin layouts. The two layouts previously
 * declared different role lists — the outer one allowed librarians, the nested
 * one allowed only ADMIN — which locked librarians out of admin routes the
 * sidebar links them to. Both now resolve through ADMIN_CONSOLE_ROLES so the
 * lists cannot drift apart again.
 *
 * This is a shell gate only. Individual admin pages and server actions must
 * still call requirePermission() for what the user may actually do.
 */
export async function requireAdminConsole() {
  return requireRole(...ADMIN_CONSOLE_ROLES);
}

// Require specific permission
export async function requirePermission(permission: string) {
  const session = await requireAuth();
  
  const { checkUserPermission } = await import('@/lib/auth/permissions');
  const hasPermission = await checkUserPermission(session.user.id, permission);
  
  if (!hasPermission) {
    redirect('/forbidden');
  }
  
  return session;
}

// Get user with roles and member info
export async function getUserWithProfile() {
  const session = await getSession();
  
  if (!session?.user) {
    return null;
  }
  
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
      member: {
        include: {
          instruments: {
            include: { instrument: true },
          },
          sections: {
            include: { section: true },
          },
        },
      },
    },
  });
  
  return user;
}

// Check if user has admin access
export async function isAdmin() {
  const session = await getSession();
  
  if (!session?.user) {
    return false;
  }
  
  const adminRoles = ['SUPER_ADMIN', 'ADMIN'];
  
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId: session.user.id,
      role: {
        type: { in: adminRoles as never[] },
      },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ],
    },
  });
  
  return !!userRole;
}

// Check if user has staff access (admin, director, staff)
export async function isStaff() {
  const session = await getSession();
  
  if (!session?.user) {
    return false;
  }
  
  const staffRoles = ['SUPER_ADMIN', 'ADMIN', 'DIRECTOR', 'STAFF'];
  
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId: session.user.id,
      role: {
        type: { in: staffRoles as never[] },
      },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ],
    },
  });
  
  return !!userRole;
}

// Check if user is a librarian
export async function isLibrarian() {
  const session = await getSession();
  
  if (!session?.user) {
    return false;
  }
  
  const librarianRoles = ['SUPER_ADMIN', 'ADMIN', 'LIBRARIAN'];
  
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId: session.user.id,
      role: {
        type: { in: librarianRoles as never[] },
      },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ],
    },
  });
  
  return !!userRole;
}

// =============================================================================
// SECTION LEADER HELPERS
// =============================================================================

/**
 * Get the section that a user is a leader of.
 * Returns null if the user is not a section leader or has no section assignment.
 */
export async function getSectionLeaderSection(userId: string): Promise<{
  id: string;
  name: string;
} | null> {
  // First, get the member record for this user
  const member = await prisma.member.findUnique({
    where: { userId },
    include: {
      sections: {
        where: { isLeader: true },
        include: { section: true },
      },
    },
  });

  if (!member || member.sections.length === 0) {
    return null;
  }

  // Return the first section they lead (typically only one)
  const sectionLead = member.sections[0];
  return {
    id: sectionLead.section.id,
    name: sectionLead.section.name,
  };
}

/**
 * Check if the current user is a section leader.
 * A section leader has the SECTION_LEADER role type and is marked as isLeader in a section.
 */
export async function isSectionLeader(): Promise<boolean> {
  const session = await getSession();
  
  if (!session?.user) {
    return false;
  }

  // Check if user has SECTION_LEADER role type
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId: session.user.id,
      role: {
        type: 'SECTION_LEADER',
      },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
  });

  if (!userRole) {
    return false;
  }

  // Verify they are actually a leader of a section
  const section = await getSectionLeaderSection(session.user.id);
  return section !== null;
}

/**
 * Require the user to be a section leader.
 * Returns the section they lead, or redirects to forbidden if not a section leader.
 */
export async function requireSectionLeader(): Promise<{
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  section: { id: string; name: string };
}> {
  const session = await requireAuth();

  const section = await getSectionLeaderSection(session.user.id);

  if (!section) {
    redirect('/forbidden');
  }

  // Verify they have the SECTION_LEADER role
  const hasRole = await isSectionLeader();
  if (!hasRole) {
    redirect('/forbidden');
  }

  return { session, section };
}

/**
 * Check if a user can access a specific member's data.
 * - Admins and staff can access all members
 * - Section leaders can access members in their section
 * - Members can access their own data
 */
export async function canAccessMember(
  targetMemberId: string,
  options: { allowOwn?: boolean } = { allowOwn: true }
): Promise<{ canAccess: boolean; scope: 'all' | 'section' | 'own' | 'none' }> {
  const session = await getSession();

  if (!session?.user) {
    return { canAccess: false, scope: 'none' };
  }

  // Check if admin/staff (full access)
  const adminAccess = await isAdmin();
  if (adminAccess) {
    return { canAccess: true, scope: 'all' };
  }

  // Check if section leader
  const sectionLeaderSection = await getSectionLeaderSection(session.user.id);
  
  if (sectionLeaderSection) {
    // Check if target member is in the same section
    const targetMember = await prisma.member.findUnique({
      where: { id: targetMemberId },
      include: {
        sections: {
          where: { sectionId: sectionLeaderSection.id },
        },
      },
    });

    if (targetMember && targetMember.sections.length > 0) {
      return { canAccess: true, scope: 'section' };
    }
  }

  // Check if accessing own data
  if (options.allowOwn) {
    const ownMember = await prisma.member.findUnique({
      where: { userId: session.user.id },
    });

    if (ownMember && ownMember.id === targetMemberId) {
      return { canAccess: true, scope: 'own' };
    }
  }

  return { canAccess: false, scope: 'none' };
}

/**
 * Get the section filter for the current user.
 * Returns the section ID if the user is a section leader and should be filtered.
 * Returns null if the user has full access (admin/staff) or no section filter applies.
 */
export async function getMemberSectionFilter(): Promise<string | null> {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  // Admins and staff have full access
  const adminAccess = await isAdmin();
  const staffAccess = await isStaff();
  if (adminAccess || staffAccess) {
    return null;
  }

  // Section leaders are filtered to their section
  const section = await getSectionLeaderSection(session.user.id);
  if (section) {
    return section.id;
  }

  return null;
}
