import { Prisma } from '@prisma/client';

// =============================================================================
// TYPES
// =============================================================================

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues: Prisma.JsonValue | null;
  newValues: Prisma.JsonValue | null;
  timestamp: Date;
}

export interface AuditLogFilters {
  userId?: string;
  userName?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AuditLogStats {
  total: number;
  byAction: Array<{ action: string; count: number }>;
  byEntityType: Array<{ entityType: string; count: number }>;
  byUser: Array<{ userName: string | null; count: number }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

export const AUDIT_ACTIONS = [
  // User actions
  'user.create',
  'user.update',
  'user.delete',
  'user.ban',
  'user.unban',
  'user.password_reset_sent',
  'user.impersonate_start',
  'user.impersonate_end',
  // Session actions
  'session.revoke',
  'session.revoke_all',
  // Member actions
  'member.create',
  'member.update',
  'member.delete',
  // Event actions
  'event.create',
  'event.update',
  'event.delete',
  // Music actions
  'music.create',
  'music.update',
  'music.delete',
  'music.assign',
  'music.unassign',
  // Announcement actions
  'announcement.create',
  'announcement.update',
  'announcement.delete',
  // Page actions
  'page.create',
  'page.update',
  'page.delete',
  // Role actions
  'role.assign',
  'role.remove',
  'permission.grant',
  'permission.revoke',
  // Settings actions
  'settings.update',
] as const;

export const ENTITY_TYPES = [
  'User',
  'Member',
  'Event',
  'MusicPiece',
  'MusicAssignment',
  'Announcement',
  'Page',
  'Role',
  'Permission',
  'Session',
  'SystemSetting',
] as const;
