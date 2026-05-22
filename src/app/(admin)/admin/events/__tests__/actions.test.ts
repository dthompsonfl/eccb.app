import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reorderEventMusic } from '../actions';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { revalidatePath } from 'next/cache';

import { EVENT_EDIT } from '@/lib/auth/permission-constants';
// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    eventMusic: {
      update: vi.fn().mockReturnValue({}),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn().mockResolvedValue({ user: { id: 'test-user-id' } }),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn().mockReturnValue(undefined),
}));

describe('Event Actions - reorderEventMusic', () => {
  beforeEach(() => {
    // Vitest mock reset
    vi.clearAllMocks();
  });

  it('should use prisma.$transaction to prevent N+1 queries when reordering music', async () => {
    const eventId = 'test-event-id';
    const orderedIds = ['id-1', 'id-2', 'id-3'];

    // Create spy instances for the updates that would be generated
    const mockUpdates = orderedIds.map((id, index) => ({
      where: { id },
      data: { sortOrder: index }
    }));

    // We mock the update to return its args so we can verify they get passed to $transaction
    (prisma.eventMusic.update as any).mockImplementation((args: any) => args);

    const result = await reorderEventMusic(eventId, orderedIds);

    expect(result).toEqual({ success: true });

    // Check that requirePermission was called
    expect(requirePermission).toHaveBeenCalledWith(EVENT_EDIT);

    // Verify each update was created correctly
    expect(prisma.eventMusic.update).toHaveBeenCalledTimes(3);

    // Verify $transaction was used to execute them all at once
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(mockUpdates);

    // Verify audit log
    expect(auditLog).toHaveBeenCalledWith({
      action: 'event.music.reorder',
      entityType: 'Event',
      entityId: eventId,
      newValues: { count: orderedIds.length },
    });

    // Verify revalidation
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/events/${eventId}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/events/${eventId}/music`);
  });
});
