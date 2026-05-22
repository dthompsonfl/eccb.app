'use server';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { AUDIT_VIEW, MEMBER_VIEW_OWN } from '@/lib/auth/permission-constants';
import { Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { z } from 'zod';
import type { AuditLogEntry, AuditLogFilters, AuditLogStats } from './types';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const _auditLogFiltersSchema = z.object({
  userId: z.string().optional(),
  userName: z.string().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const _paginationSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(50),
});

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get audit logs with filtering and pagination
 */
export async function getAuditLogs(
  filters: AuditLogFilters = {},
  page: number = 1,
  limit: number = 50
): Promise<{ logs: AuditLogEntry[]; total: number; totalPages: number }> {
  await requirePermission(AUDIT_VIEW);

  const where: Prisma.AuditLogWhereInput = {};

  if (filters.userId) {
    where.userId = filters.userId;
  }

  if (filters.userName) {
    where.userName = { contains: filters.userName };
  }

  if (filters.action) {
    where.action = { contains: filters.action };
  }

  if (filters.entityType) {
    where.entityType = filters.entityType;
  }

  if (filters.entityId) {
    where.entityId = filters.entityId;
  }

  if (filters.dateFrom || filters.dateTo) {
    where.timestamp = {};
    if (filters.dateFrom) {
      where.timestamp.gte = new Date(filters.dateFrom);
    }
    if (filters.dateTo) {
      // Include the entire end day
      const endDate = new Date(filters.dateTo);
      endDate.setHours(23, 59, 59, 999);
      where.timestamp.lte = endDate;
    }
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs: logs as AuditLogEntry[],
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a single audit log entry with details
 */
export async function getAuditLogDetails(id: string): Promise<AuditLogEntry | null> {
  await requirePermission(AUDIT_VIEW);

  const log = await prisma.auditLog.findUnique({
    where: { id },
  });

  return log as AuditLogEntry | null;
}

/**
 * Get audit log statistics for dashboard
 */
export async function getAuditLogStats(days: number = 30): Promise<AuditLogStats> {
  await requirePermission(AUDIT_VIEW);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  const [total, byAction, byEntityType, byUser] = await Promise.all([
    prisma.auditLog.count({
      where: { timestamp: { gte: startDate } },
    }),
    prisma.auditLog.groupBy({
      by: ['action'],
      where: { timestamp: { gte: startDate } },
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }),
    prisma.auditLog.groupBy({
      by: ['entityType'],
      where: { timestamp: { gte: startDate } },
      _count: { entityType: true },
      orderBy: { _count: { entityType: 'desc' } },
      take: 10,
    }),
    prisma.auditLog.groupBy({
      by: ['userName'],
      where: { timestamp: { gte: startDate } },
      _count: { userName: true },
      orderBy: { _count: { userName: 'desc' } },
      take: 10,
    }),
  ]);

  return {
    total,
    byAction: byAction.map((item) => ({ action: item.action, count: item._count.action })),
    byEntityType: byEntityType.map((item) => ({
      entityType: item.entityType,
      count: item._count.entityType,
    })),
    byUser: byUser.map((item) => ({ userName: item.userName, count: item._count.userName })),
  };
}

/**
 * Get unique action types from audit logs
 */
export async function getUniqueActions(): Promise<string[]> {
  await requirePermission(AUDIT_VIEW);

  const actions = await prisma.auditLog.findMany({
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  });

  return actions.map((a) => a.action);
}

/**
 * Get unique entity types from audit logs
 */
export async function getUniqueEntityTypes(): Promise<string[]> {
  await requirePermission(AUDIT_VIEW);

  const types = await prisma.auditLog.findMany({
    select: { entityType: true },
    distinct: ['entityType'],
    orderBy: { entityType: 'asc' },
  });

  return types.map((t) => t.entityType);
}

/**
 * Export audit logs as CSV
 */
export async function exportAuditLogsCsv(filters: AuditLogFilters = {}): Promise<string> {
  await requirePermission(AUDIT_VIEW);

  const { logs } = await getAuditLogs(filters, 1, 10000);

  const headers = [
    'ID',
    'Timestamp',
    'User ID',
    'User Name',
    'IP Address',
    'Action',
    'Entity Type',
    'Entity ID',
    'Old Values',
    'New Values',
  ];

  const rows = logs.map((log) => [
    log.id,
    format(log.timestamp, "yyyy-MM-dd HH:mm:ss"),
    log.userId || '',
    log.userName || '',
    log.ipAddress || '',
    log.action,
    log.entityType,
    log.entityId || '',
    log.oldValues ? JSON.stringify(log.oldValues) : '',
    log.newValues ? JSON.stringify(log.newValues) : '',
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ),
  ].join('\n');

  return csvContent;
}

/**
 * Export audit logs as JSON
 */
export async function exportAuditLogsJson(filters: AuditLogFilters = {}): Promise<string> {
  await requirePermission(AUDIT_VIEW);

  const { logs } = await getAuditLogs(filters, 1, 10000);

  return JSON.stringify(logs, null, 2);
}

/**
 * Get audit logs for a specific entity (for showing in entity detail pages)
 */
export async function getEntityAuditLogs(
  entityType: string,
  entityId: string,
  limit: number = 20
): Promise<AuditLogEntry[]> {
  await requirePermission(AUDIT_VIEW);

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType,
      entityId,
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return logs as AuditLogEntry[];
}

/**
 * Get audit logs for the current user (for user profile)
 */
export async function getMyAuditLogs(
  limit: number = 20
): Promise<AuditLogEntry[]> {
  const session = await requirePermission(MEMBER_VIEW_OWN);

  const logs = await prisma.auditLog.findMany({
    where: {
      userId: session.user.id,
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return logs as AuditLogEntry[];
}
