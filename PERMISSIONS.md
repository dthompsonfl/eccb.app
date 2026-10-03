# Community Band Management Platform - Permission Strategy

## Overview

This document defines the Role-Based Access Control (RBAC) system for the Community Band Management Platform. The strategy prioritizes security, clarity, and ease of administration while supporting the complex permission requirements of band operations.

**Design Principles:**
- **Deny by Default**: All actions require explicit permission
- **Role Hierarchy**: Higher roles inherit lower role permissions
- **Resource-Based**: Permissions organized by domain resources
- **Scope-Aware**: Actions can be scoped (all, assigned, own)
- **Auditable**: All permission checks logged
- **Flexible**: Supports both role-based and individual overrides

---

## 1. Role Definitions

### 1.1 Role Hierarchy

```
┌────────────────────┐
│   SUPER_ADMIN      │  Full system access, can manage everything
└────────────────────┘
          ▼
┌────────────────────┐
│      ADMIN         │  Manage members, events, content (not system config)
└────────────────────┘
          ▼
┌────────────────────┐
│  DIRECTOR/STAFF    │  Manage rehearsals, attendance, music assignments
└────────────────────┘
          ▼
┌─────────────┬──────────────┬────────────┐
│   SECTION   │   LIBRARIAN  │  MUSICIAN  │  Limited access to specific domains
│   LEADER    │              │            │
└─────────────┴──────────────┴────────────┘
          ▼
┌────────────────────┐
│      PUBLIC        │  No authentication required (read-only public content)
└────────────────────┘
```

### 1.2 Role Details

#### **SUPER_ADMIN**
- **Purpose**: Full system administration
- **Members**: 1-2 technical administrators
- **Capabilities**: Everything, including system configuration, user management, role assignment

#### **ADMIN**
- **Purpose**: Band operations management
- **Members**: Board members, band manager
- **Capabilities**: Manage members, events, announcements, content, reports (not system config)

#### **DIRECTOR/STAFF**
- **Purpose**: Musical and operational leadership
- **Members**: Music director, assistant directors, staff
- **Capabilities**: Manage rehearsals, concerts, attendance, music assignments, view member info

#### **SECTION_LEADER**
- **Purpose**: Lead section rehearsals and communication
- **Members**: Principal players per section
- **Capabilities**: View section members, mark attendance for section, send section messages

#### **LIBRARIAN**
- **Purpose**: Manage music library
- **Members**: Band librarian, assistant librarians
- **Capabilities**: Upload, edit, organize music catalog, manage files, assign parts

#### **MUSICIAN**
- **Purpose**: Band member participation
- **Members**: All active band members
- **Capabilities**: View assigned music, mark own attendance, update own profile, view events

#### **PUBLIC**
- **Purpose**: Website visitors
- **Members**: Anyone
- **Capabilities**: View public content only (home, about, events, contact)

---

## 2. Permission Structure

### 2.1 Permission Format

Permissions follow the pattern: `resource.action.scope`

**Examples:**
- `music.view.all` - View all music in library
- `music.view.assigned` - View only music assigned to you
- `member.edit.own` - Edit your own profile
- `event.create` - Create new events
- `attendance.mark.all` - Mark attendance for anyone

### 2.2 Resources

| Resource | Description |
|----------|-------------|
| `auth` | User accounts and authentication |
| `member` | Member profiles and management |
| `music` | Music library catalog and files |
| `event` | Concerts, rehearsals, calendar |
| `attendance` | Attendance tracking |
| `cms` | Website content management |
| `announcement` | Internal communications |
| `report` | Analytics and exports |
| `system` | System configuration |
| `file` | File uploads and storage |

### 2.3 Actions

| Action | Description |
|--------|-------------|
| `view` | Read/view resource |
| `create` | Create new resource |
| `edit` | Update existing resource |
| `delete` | Delete resource |
| `publish` | Publish content (CMS) |
| `assign` | Assign to members |
| `download` | Download files |
| `upload` | Upload files |
| `approve` | Approve requests |

### 2.4 Scopes

| Scope | Description |
|-------|-------------|
| `all` | All resources of this type |
| `assigned` | Resources assigned to you |
| `own` | Your own resources only |
| `section` | Resources in your section |
| `public` | Publicly visible resources |

---

## 3. Permission Matrix

### 3.1 Music Library Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `music.view.all` | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `music.view.assigned` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `music.create` | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `music.edit` | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `music.delete` | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `music.assign` | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `music.download.all` | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `music.download.assigned` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `music.upload` | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |

### 3.2 Member Management Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `member.view.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `member.view.section` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `member.view.own` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `member.create` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `member.edit.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `member.edit.own` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `member.delete` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 3.3 Event Management Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `event.view.all` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `event.view.public` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event.create` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `event.edit` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `event.delete` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `event.publish` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### 3.4 Attendance Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `attendance.view.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `attendance.view.section` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `attendance.view.own` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `attendance.mark.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `attendance.mark.section` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `attendance.mark.own` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

### 3.5 CMS Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `cms.view.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `cms.view.public` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cms.edit` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `cms.publish` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `cms.delete` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 3.6 Communication Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `announcement.view.all` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `announcement.create` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `message.send.all` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `message.send.section` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

### 3.7 Admin Permissions

| Permission | Super Admin | Admin | Director | Section Leader | Librarian | Musician | Public |
|------------|-------------|-------|----------|----------------|-----------|----------|--------|
| `report.view` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `report.export` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `system.config` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `audit.view` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `privacy.export` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `privacy.erase` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

**`privacy.export` and `privacy.erase` (GDPR Art. 15/17/20).** Neither is ever
required for the self-service path: a member exporting or erasing *their own*
data needs only a session, and the code checks identity before permission
(`authorizeErasure` / `canExportFor` in `src/lib/privacy/erasure.ts`). These
permissions exist solely for a staff member acting **on behalf of** somebody
else. `privacy.erase` is deliberately narrower than `privacy.export` — an
auditor may need to see what a subject holds without being able to destroy it —
and an admin erasure additionally demands the *target's* name be typed, is
separately audited, and returns a full manifest.

---

## 4. Implementation

### 4.1 Database Setup

See `DATABASE_SCHEMA.md` for complete schema. Key tables:
- `Role`: Defines roles
- `Permission`: Defines permissions
- `RolePermission`: Maps permissions to roles
- `UserRole`: Assigns roles to users

### 4.2 Permission Checking in Code

#### **Server-Side (Next.js Server Actions)**

```typescript
// lib/auth/permissions.ts
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function requirePermission(permission: string): Promise<void> {
  const session = await auth();
  
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  
  const hasPermission = await checkUserPermission(session.user.id, permission);
  
  if (!hasPermission) {
    throw new Error(`Forbidden: Missing permission ${permission}`);
  }
}

export async function checkUserPermission(
  userId: string,
  permission: string
): Promise<boolean> {
  const userPermissions = await getUserPermissions(userId);
  return userPermissions.includes(permission);
}

export async function getUserPermissions(userId: string): Promise<string[]> {
  // Check cache first
  const cached = await redis.get(`permissions:${userId}`);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // Query from database
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ],
    },
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
  });
  
  const permissions = userRoles.flatMap((ur) =>
    ur.role.permissions.map((rp) => rp.permission.name)
  );
  
  // Remove duplicates
  const uniquePermissions = [...new Set(permissions)];
  
  // Cache for 5 minutes
  await redis.setex(`permissions:${userId}`, 300, JSON.stringify(uniquePermissions));
  
  return uniquePermissions;
}
```

#### **Server Action Example**

```typescript
// app/actions/music.ts
'use server';

import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { auditLog } from '@/lib/audit';

export async function createMusicPiece(data: MusicPieceInput) {
  // Check permission
  await requirePermission('music.create');
  
  // Validate input
  const validated = musicPieceSchema.parse(data);
  
  // Create in database
  const piece = await prisma.musicPiece.create({
    data: validated,
  });
  
  // Audit log
  await auditLog({
    action: 'CREATE',
    entityType: 'MusicPiece',
    entityId: piece.id,
    newValues: piece,
  });
  
  return piece;
}

export async function deleteMusicPiece(id: string) {
  await requirePermission('music.delete');
  
  const piece = await prisma.musicPiece.findUnique({ where: { id } });
  
  if (!piece) {
    throw new Error('Music piece not found');
  }
  
  // Soft delete
  await prisma.musicPiece.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  
  await auditLog({
    action: 'DELETE',
    entityType: 'MusicPiece',
    entityId: id,
    oldValues: piece,
  });
}
```

#### **Middleware for Route Protection**

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

const publicRoutes = ['/', '/about', '/events', '/contact'];
const memberRoutes = ['/dashboard', '/music', '/profile'];
const adminRoutes = ['/admin'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Public routes
  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }
  
  // Check authentication
  const session = await auth();
  
  if (!session?.user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  
  // Check admin routes
  if (adminRoutes.some((route) => pathname.startsWith(route))) {
    const isAdmin = await checkUserPermission(session.user.id, 'admin.access');
    
    if (!isAdmin) {
      return NextResponse.redirect(new URL('/forbidden', request.url));
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

#### **Client-Side Permission Checks**

```typescript
// components/ProtectedComponent.tsx
'use client';

import { usePermissions } from '@/hooks/usePermissions';

export function ProtectedComponent() {
  const { hasPermission } = usePermissions();
  
  if (!hasPermission('music.edit')) {
    return null; // Hide component
  }
  
  return <button>Edit Music</button>;
}
```

```typescript
// hooks/usePermissions.ts
import { useSession } from '@/lib/auth/client';

export function usePermissions() {
  const session = useSession();
  const permissions = session?.user?.permissions || [];
  
  const hasPermission = (permission: string) => {
    return permissions.includes(permission);
  };
  
  const hasAnyPermission = (perms: string[]) => {
    return perms.some((p) => permissions.includes(p));
  };
  
  const hasAllPermissions = (perms: string[]) => {
    return perms.every((p) => permissions.includes(p));
  };
  
  return {
    permissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  };
}
```

### 4.3 Scoped Permission Checking

For permissions with scopes like `music.view.assigned`, implement additional logic:

```typescript
export async function canViewMusicPiece(
  userId: string,
  pieceId: string
): Promise<boolean> {
  // Check if user can view all music
  if (await checkUserPermission(userId, 'music.view.all')) {
    return true;
  }
  
  // Check if user can view assigned music and piece is assigned to them
  if (await checkUserPermission(userId, 'music.view.assigned')) {
    const assignment = await prisma.musicAssignment.findFirst({
      where: {
        pieceId,
        member: {
          userId,
        },
      },
    });
    
    return !!assignment;
  }
  
  return false;
}
```

---

## 5. Permission Administration

### 5.1 Assigning Roles to Users

```typescript
// app/actions/admin/users.ts
'use server';

import { requirePermission } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';

export async function assignRoleToUser(userId: string, roleId: string) {
  await requirePermission('auth.manage');
  
  await prisma.userRole.create({
    data: {
      userId,
      roleId,
      assignedAt: new Date(),
    },
  });
  
  // Clear permissions cache
  await redis.del(`permissions:${userId}`);
}

export async function removeRoleFromUser(userId: string, roleId: string) {
  await requirePermission('auth.manage');
  
  await prisma.userRole.delete({
    where: {
      userId_roleId: {
        userId,
        roleId,
      },
    },
  });
  
  // Clear permissions cache
  await redis.del(`permissions:${userId}`);
}
```

### 5.2 Creating Custom Permissions

```typescript
export async function createPermission(data: PermissionInput) {
  await requirePermission('system.config');
  
  return await prisma.permission.create({
    data: {
      name: data.name,
      resource: data.resource,
      action: data.action,
      scope: data.scope,
      description: data.description,
    },
  });
}

export async function assignPermissionToRole(roleId: string, permissionId: string) {
  await requirePermission('system.config');
  
  await prisma.rolePermission.create({
    data: {
      roleId,
      permissionId,
    },
  });
  
  // Clear all user permissions cache for this role
  const usersWithRole = await prisma.userRole.findMany({
    where: { roleId },
    select: { userId: true },
  });
  
  for (const ur of usersWithRole) {
    await redis.del(`permissions:${ur.userId}`);
  }
}
```

---

## 6. Testing Permissions

### 6.1 Unit Tests

```typescript
// lib/auth/__tests__/permissions.test.ts
import { checkUserPermission, getUserPermissions } from '../permissions';
import { prisma } from '@/lib/db';

describe('Permission System', () => {
  beforeEach(async () => {
    // Setup test data
  });

  it('should grant permission to user with correct role', async () => {
    const hasPermission = await checkUserPermission('user-id', 'music.view.all');
    expect(hasPermission).toBe(true);
  });

  it('should deny permission to user without role', async () => {
    const hasPermission = await checkUserPermission('user-id', 'system.config');
    expect(hasPermission).toBe(false);
  });

  it('should cache permissions for performance', async () => {
    const perms1 = await getUserPermissions('user-id');
    const perms2 = await getUserPermissions('user-id');
    
    expect(perms1).toEqual(perms2);
    // Verify cache hit (mock redis.get)
  });
});
```

### 6.2 Integration Tests

```typescript
// app/actions/__tests__/music.test.ts
import { createMusicPiece, deleteMusicPiece } from '../music';

describe('Music Actions', () => {
  it('should allow librarian to create music', async () => {
    // Mock session with LIBRARIAN role
    const piece = await createMusicPiece({
      title: 'Test Piece',
    });
    
    expect(piece.title).toBe('Test Piece');
  });

  it('should deny musician from creating music', async () => {
    // Mock session with MUSICIAN role
    await expect(createMusicPiece({ title: 'Test' })).rejects.toThrow('Forbidden');
  });
});
```

---

## 7. Security Considerations

### 7.1 Defense in Depth

- **Client-side**: Hide UI elements (convenience, not security)
- **Middleware**: Protect routes (first line of defense)
- **Server Actions**: Enforce permissions (critical)
- **Database**: Row-level security (future consideration)

### 7.2 Permission Bypass Prevention

```typescript
// WRONG: Trusting client input
export async function updateMember(id: string, data: any) {
  // No permission check!
  return await prisma.member.update({ where: { id }, data });
}

// CORRECT: Always check permissions
export async function updateMember(id: string, data: MemberInput) {
  await requirePermission('member.edit.all');
  
  const validated = memberSchema.parse(data);
  
  return await prisma.member.update({
    where: { id },
    data: validated,
  });
}
```

### 7.3 Rate Limiting

```typescript
// lib/rate-limit.ts
import { redis } from '@/lib/redis';

export async function rateLimit(userId: string, action: string, limit: number, window: number) {
  const key = `rate-limit:${userId}:${action}`;
  const current = await redis.incr(key);
  
  if (current === 1) {
    await redis.expire(key, window);
  }
  
  if (current > limit) {
    throw new Error('Rate limit exceeded');
  }
}

// Usage in action
export async function sendAnnouncement(data: AnnouncementInput) {
  await requirePermission('announcement.create');
  await rateLimit(session.user.id, 'send-announcement', 10, 3600); // 10 per hour
  
  // ... rest of logic
}
```

---

## 8. Audit Logging

All permission checks and actions should be logged:

```typescript
// lib/audit.ts
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function auditLog(data: {
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: any;
  newValues?: any;
}) {
  const session = await auth();
  const headers = await headers();
  
  await prisma.auditLog.create({
    data: {
      userId: session?.user?.id,
      userName: session?.user?.name || 'Anonymous',
      ipAddress: headers.get('x-forwarded-for') || headers.get('x-real-ip'),
      userAgent: headers.get('user-agent'),
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      oldValues: data.oldValues,
      newValues: data.newValues,
      timestamp: new Date(),
    },
  });
}
```

---

## 9. Future Enhancements

### 9.1 Row-Level Security (MariaDB)

```sql
-- Enable RLS on members table
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only view members in their section (if section leader)
CREATE POLICY section_leader_view_policy ON members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = current_user_id()
      AND r.name = 'SECTION_LEADER'
      AND members.section_id IN (
        SELECT section_id FROM member_sections WHERE member_id = current_member_id()
      )
    )
  );
```

### 9.2 Temporary Permissions

```typescript
// Grant temporary permission (e.g., for event-specific access)
await prisma.userRole.create({
  data: {
    userId: 'user-id',
    roleId: 'temp-role-id',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
});
```

### 9.3 Permission Requests & Approvals

```typescript
// User requests permission
await prisma.permissionRequest.create({
  data: {
    userId: 'user-id',
    permission: 'music.upload',
    reason: 'Need to upload music for upcoming concert',
  },
});

// Admin approves
await prisma.permissionRequest.update({
  where: { id: 'request-id' },
  data: {
    approvedBy: 'admin-id',
    approvedAt: new Date(),
  },
});

// Grant permission
await assignRoleToUser('user-id', 'librarian-role-id');
```

---

## 10. Conclusion

This permission strategy provides:

- **Clear role hierarchy** that maps to real-world band structure
- **Granular permissions** for fine-grained control
- **Secure implementation** with defense in depth
- **Audit trail** for accountability
- **Flexible system** that can evolve with requirements
- **Performance** through caching and indexing

The strategy balances security, usability, and maintainability for a 5-10 year lifecycle.
