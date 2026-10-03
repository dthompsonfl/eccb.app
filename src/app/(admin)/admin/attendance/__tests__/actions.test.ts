import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock Setup - All mocks must be hoisted before imports
// =============================================================================

const mockAttendanceFindUnique = vi.hoisted(() => vi.fn());
const mockAttendanceFindMany = vi.hoisted(() => vi.fn());
const mockAttendanceCreate = vi.hoisted(() => vi.fn());
const mockAttendanceUpdate = vi.hoisted(() => vi.fn());
const mockAttendanceUpsert = vi.hoisted(() => vi.fn());
const mockAttendanceDeleteMany = vi.hoisted(() => vi.fn());
const mockAttendanceCreateMany = vi.hoisted(() => vi.fn());

const mockEventFindUnique = vi.hoisted(() => vi.fn());

const mockMemberFindUnique = vi.hoisted(() => vi.fn());
const mockMemberFindFirst = vi.hoisted(() => vi.fn());
const mockMemberFindMany = vi.hoisted(() => vi.fn());

const mockRequireAuth = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockCheckUserPermission = vi.hoisted(() => vi.fn());

// `$transaction` runs its callback immediately and hands it a client exposing
// the same mocked delegates, so a transactional write is observable through the
// same spies the assertions already use.
const mockTransaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      attendance: {
        findUnique: mockAttendanceFindUnique,
        findMany: mockAttendanceFindMany,
        create: mockAttendanceCreate,
        update: mockAttendanceUpdate,
        upsert: mockAttendanceUpsert,
        deleteMany: mockAttendanceDeleteMany,
        createMany: mockAttendanceCreateMany,
      },
    }),
  ),
);

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: mockTransaction,
    attendance: {
      findUnique: mockAttendanceFindUnique,
      findMany: mockAttendanceFindMany,
      create: mockAttendanceCreate,
      update: mockAttendanceUpdate,
      upsert: mockAttendanceUpsert,
      deleteMany: mockAttendanceDeleteMany,
      createMany: mockAttendanceCreateMany,
    },
    event: {
      findUnique: mockEventFindUnique,
    },
    member: {
      findUnique: mockMemberFindUnique,
      findFirst: mockMemberFindFirst,
      findMany: mockMemberFindMany,
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requireAuth: mockRequireAuth,
  requirePermission: mockRequirePermission,
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: mockCheckUserPermission,
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Import after mocks
import {
  markAttendance,
  markBulkAttendance,
  getEventAttendance,
  getMemberAttendance,
  getMemberAttendanceStats,
  getEventAttendanceStats,
  initializeEventAttendance,
} from '../actions';

// Mock types to satisfy linter
type MockSession = { user: { id: string } };
type MockEvent = { id: string; title: string; attendance?: any[] };

describe('Attendance Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set default mock return values for auth functions
    mockRequireAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockRequirePermission.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckUserPermission.mockResolvedValue(true);
  });

  describe('markAttendance', () => {
    it('should mark attendance successfully', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockAttendance = {
        id: 'attendance-1',
        eventId: 'event-1',
        memberId: 'member-1',
        status: 'PRESENT',
      };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockCheckUserPermission.mockResolvedValue(true);
      mockEventFindUnique.mockResolvedValue({ id: 'event-1' } as any);
      mockAttendanceUpsert.mockResolvedValue(mockAttendance as any);

      const result = await markAttendance({
        eventId: 'event-1',
        memberId: 'member-1',
        status: 'PRESENT',
      });

      expect(result.success).toBe(true);
      expect(result.attendance).toBeDefined();
    });

    it('should return error for invalid data', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);

      const result = await markAttendance({
        eventId: '',
        memberId: '',
        status: 'PRESENT' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when permission denied', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockCheckUserPermission.mockResolvedValue(false);

      const result = await markAttendance({
        eventId: 'event-1',
        memberId: 'member-1',
        status: 'PRESENT',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should return error when event not found', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockCheckUserPermission.mockResolvedValue(true);
      mockEventFindUnique.mockResolvedValue(null);

      const result = await markAttendance({
        eventId: 'non-existent',
        memberId: 'member-1',
        status: 'PRESENT',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });
  });

  describe('markBulkAttendance', () => {
    it('should mark bulk attendance with ATTENDANCE_MARK_ALL permission', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockEvent = { id: 'event-1', title: 'Rehearsal' };

      mockRequirePermission.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(mockEvent as any);
      mockAttendanceDeleteMany.mockResolvedValue({ count: 0 });
      mockAttendanceCreateMany.mockResolvedValue({ count: 3 });

      const result = await markBulkAttendance({
        eventId: 'event-1',
        records: [
          { memberId: 'member-1', status: 'PRESENT' },
          { memberId: 'member-2', status: 'ABSENT' },
          { memberId: 'member-3', status: 'LATE' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      // The write is now an atomic upsert-per-member inside a transaction, not a
      // blanket deleteMany followed by createMany. Deleting first meant a failure
      // between the two left the event with no attendance at all.
      expect(mockTransaction).toHaveBeenCalled();
      expect(mockAttendanceUpsert).toHaveBeenCalledTimes(3);
      expect(mockAttendanceCreateMany).not.toHaveBeenCalled();
      // Only members ABSENT from the payload are removed, so a member's existing
      // row is overwritten rather than destroyed and recreated.
      expect(mockAttendanceDeleteMany).toHaveBeenCalledWith({
        where: {
          eventId: 'event-1',
          memberId: { notIn: ['member-1', 'member-2', 'member-3'] },
        },
      });
    });

    it('folds a duplicate memberId instead of failing on the unique constraint', async () => {
      mockRequirePermission.mockResolvedValue({ user: { id: 'user-1' } } as any);
      mockEventFindUnique.mockResolvedValue({ id: 'event-1' } as any);
      mockAttendanceDeleteMany.mockResolvedValue({ count: 0 });

      const result = await markBulkAttendance({
        eventId: 'event-1',
        records: [
          { memberId: 'member-1', status: 'ABSENT' },
          { memberId: 'member-1', status: 'PRESENT' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      // Last write wins.
      expect(mockAttendanceUpsert).toHaveBeenCalledTimes(1);
      expect(mockAttendanceUpsert.mock.calls[0][0].update.status).toBe('PRESENT');
    });

    it('should return error when event not found', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequirePermission.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(null);

      const result = await markBulkAttendance({
        eventId: 'non-existent',
        records: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });
  });

  describe('getEventAttendance', () => {
    it('should get event attendance records', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockEvent: MockEvent = {
        id: 'event-1',
        title: 'Rehearsal',
        attendance: [
          {
            id: 'attendance-1',
            eventId: 'event-1',
            memberId: 'member-1',
            status: 'PRESENT',
            member: { id: 'member-1', firstName: 'John', lastName: 'Doe', sections: [] },
          },
        ],
      };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(mockEvent as any);

      const result = await getEventAttendance('event-1');

      expect(result.success).toBe(true);
      expect(result.attendance).toBeDefined();
    });

    it('should return error when event not found', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(null);

      const result = await getEventAttendance('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });

    it('should return error when permission denied', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockCheckUserPermission.mockResolvedValue(false);

      const result = await getEventAttendance('event-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  describe('getMemberAttendance', () => {
    it('should get member attendance records', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockAttendance = [
        {
          id: 'attendance-1',
          eventId: 'event-1',
          memberId: 'member-1',
          status: 'PRESENT',
          event: { id: 'event-1', title: 'Rehearsal' },
        },
      ];

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockAttendanceFindMany.mockResolvedValue(mockAttendance as any);

      const result = await getMemberAttendance('member-1');

      expect(result.success).toBe(true);
      expect(result.attendance).toBeDefined();
    });

    it('should return error when permission denied', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockCheckUserPermission.mockResolvedValue(false);

      const result = await getMemberAttendance('member-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  describe('getMemberAttendanceStats', () => {
    it('should calculate member attendance statistics', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockAttendance = [
        { status: 'PRESENT' },
        { status: 'PRESENT' },
        { status: 'ABSENT' },
        { status: 'LATE' },
      ];

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockAttendanceFindMany.mockResolvedValue(mockAttendance as any);

      const result = await getMemberAttendanceStats('member-1');

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({
        total: 4,
        present: 2,
        absent: 1,
        excused: 0,
        late: 1,
        leftEarly: 0,
        attendanceRate: 50,
        punctualityRate: 75,
      });
    });
  });

  describe('getEventAttendanceStats', () => {
    it('should calculate event attendance statistics', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockAttendance = [
        { status: 'PRESENT' },
        { status: 'PRESENT' },
        { status: 'PRESENT' },
        { status: 'ABSENT' },
        { status: 'EXCUSED' },
      ];

      mockRequireAuth.mockResolvedValue(mockSession as unknown as any);
      mockAttendanceFindMany.mockResolvedValue(mockAttendance as any);

      const result = await getEventAttendanceStats('event-1');

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({
        total: 5,
        present: 3,
        absent: 1,
        excused: 1,
        late: 0,
        leftEarly: 0,
        attendanceRate: 60,
      });
    });
  });

  describe('initializeEventAttendance', () => {
    it('should initialize attendance for active members', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockEvent = { id: 'event-1', title: 'Rehearsal' };
      const mockActiveMembers = [
        { id: 'member-1' },
        { id: 'member-2' },
        { id: 'member-3' },
      ];

      mockRequirePermission.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(mockEvent as any);
      mockMemberFindMany.mockResolvedValue(mockActiveMembers as any);
      mockAttendanceFindMany.mockResolvedValue([]);
      mockAttendanceCreateMany.mockResolvedValue({ count: 3 });

      const result = await initializeEventAttendance('event-1');

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
    });

    it('should return 0 when all members already have attendance', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };
      const mockEvent = { id: 'event-1', title: 'Rehearsal' };
      const mockActiveMembers = [{ id: 'member-1' }];
      const mockExistingAttendance = [{ memberId: 'member-1' }];

      mockRequirePermission.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(mockEvent as any);
      mockMemberFindMany.mockResolvedValue(mockActiveMembers as any);
      mockAttendanceFindMany.mockResolvedValue(mockExistingAttendance as any);

      const result = await initializeEventAttendance('event-1');

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });

    it('should return error when event not found', async () => {
      const mockSession: MockSession = { user: { id: 'user-1' } };

      mockRequirePermission.mockResolvedValue(mockSession as unknown as any);
      mockEventFindUnique.mockResolvedValue(null);

      const result = await initializeEventAttendance('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });
  });
});
