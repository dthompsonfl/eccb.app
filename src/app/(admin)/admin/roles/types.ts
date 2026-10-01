// =============================================================================
// TYPES FOR ROLE MANAGEMENT
// =============================================================================

export interface UserWithRoles {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  roles: {
    id: string;
    roleId: string;
    assignedAt: Date;
    role: {
      id: string;
      name: string;
      displayName: string;
      description: string | null;
      type: string;
    };
  }[];
  member: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
}

export interface RoleWithPermissions {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  type: string;
  permissions: {
    id: string;
    permission: {
      id: string;
      name: string;
      resource: string;
      action: string;
      description: string | null;
    };
  }[];
  _count?: {
    users: number;
  };
}

// Permission constant for user management.
//
// Re-exported from the canonical permission constants instead of being
// re-declared here as a legacy colon-style alias. Both admin/roles pages gate
// on requirePermission(ADMIN_USERS_MANAGE), and that alias resolved to
// USER_MANAGE anyway, so importing the canonical constant keeps a single
// source of truth and satisfies the permissions:audit release gate.
export { USER_MANAGE as ADMIN_USERS_MANAGE } from '@/lib/auth/permission-constants';
