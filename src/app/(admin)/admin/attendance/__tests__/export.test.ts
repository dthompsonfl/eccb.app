import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  exportAttendanceToCSV,
  exportMemberAttendanceSummary,
  exportEventAttendanceSummary,
  getAttendanceReportData,
} from '../actions';
import { prisma } from '@/lib/db';
import { requireAuth, requirePermission } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    attendance: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    section: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/lib/auth/permissions', () => ({
  checkUserPermission: vi.fn(),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn(),
}));

describe('Attendance Export Functions', () => {
  const mockSession = {
    user: { id: 'user-1', email: 'admin@test.com' },
    session: { id: 'session-1' },
  };

  const mockAttendance = [
    {
      id: 'att-1',
      eventId: 'event-1',
      memberId: 'member-1',
      status: 'PRESENT',
      notes: null,
      markedAt: new Date('2024-01-15T10:00:00Z'),
      event: {
        id: 'event-1',
        title: 'Winter Concert',
        type: 'CONCERT',
        startTime: new Date('2024-01-15T19:00:00Z'),
        location: 'Main Hall',
      },
      member: {
        id: 'member-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@test.com',
        sections: [{ section: { name: 'Trumpet' } }],
      },
    },
    {
      id: 'att-2',
      eventId: 'event-1',
      memberId: 'member-2',
      status: 'ABSENT',
      notes: 'Sick',
      markedAt: new Date('2024-01-15T10:00:00Z'),
      event: {
        id: 'event-1',
        title: 'Winter Concert',
        type: 'CONCERT',
        startTime: new Date('2024-01-15T19:00:00Z'),
        location: 'Main Hall',
      },
      member: {
        id: 'member-2',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@test.com',
        sections: [{ section: { name: 'Flute' } }],
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (requireAuth as any).mockResolvedValue(mockSession);
    (requirePermission as any).mockResolvedValue(mockSession);
    (checkUserPermission as any).mockResolvedValue(true);
  });

  describe('exportAttendanceToCSV', () => {
    it('should return error when user lacks permission', async () => {
      (checkUserPermission as any).mockResolvedValue(false);

      const result = await exportAttendanceToCSV({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should export attendance records to CSV', async () => {
      (prisma.attendance.findMany as any).mockResolvedValue(mockAttendance);

      const result = await exportAttendanceToCSV({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.filename).toContain('attendance-export');
      expect(result.count).toBe(2);

      // Check CSV structure
      const lines = result.data!.split('\n');
      expect(lines[0]).toContain('Event,Event Type,Event Date');
      expect(lines[1]).toContain('Winter Concert,CONCERT');
      expect(lines[1]).toContain('John,Doe');
    });

    it('should filter by section for section-scoped users', async () => {
      // Keyed on the permission string, not call order: `resolveAttendanceScope`
      // checks VIEW_ALL, VIEW_SECTION and VIEW_OWN, so an ordered
      // `mockResolvedValueOnce` chain silently grants the wrong permission and
      // then returns undefined for the third.
      (checkUserPermission as any).mockImplementation((_userId: string, permission: string) => {
        return Promise.resolve(permission === 'attendance.view.section');
      });

      const mockMember = {
        id: 'member-1',
        sections: [{ sectionId: 'section-1' }],
      };
      (prisma.member.findFirst as any).mockResolvedValue(mockMember);
      (prisma.attendance.findMany as any).mockResolvedValue(mockAttendance);

      const result = await exportAttendanceToCSV({});

      expect(result.success).toBe(true);
      expect(prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            member: expect.objectContaining({
              sections: { some: { sectionId: { in: ['section-1'] } } },
            }),
          }),
        })
      );
    });

    it('should apply filters correctly', async () => {
      (prisma.attendance.findMany as any).mockResolvedValue(mockAttendance);

      await exportAttendanceToCSV({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        memberId: 'member-1',
        eventId: 'event-1',
        eventType: 'CONCERT',
        status: 'PRESENT',
      });

      expect(prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            memberId: 'member-1',
            eventId: 'event-1',
            status: 'PRESENT',
          }),
        })
      );
    });
  });

  describe('exportMemberAttendanceSummary', () => {
    const mockMembers = [
      {
        id: 'member-1',
        firstName: 'John',
        lastName: 'Doe',
        sections: [{ section: { name: 'Trumpet' } }],
        attendance: [
          { status: 'PRESENT' },
          { status: 'PRESENT' },
          { status: 'ABSENT' },
        ],
      },
      {
        id: 'member-2',
        firstName: 'Jane',
        lastName: 'Smith',
        sections: [{ section: { name: 'Flute' } }],
        attendance: [
          { status: 'PRESENT' },
          { status: 'LATE' },
        ],
      },
    ];

    it('should return error when user lacks permission', async () => {
      (checkUserPermission as any).mockResolvedValue(false);

      const result = await exportMemberAttendanceSummary({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should export member attendance summary to CSV', async () => {
      (prisma.member.findMany as any).mockResolvedValue(mockMembers);

      const result = await exportMemberAttendanceSummary({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.filename).toContain('member-attendance-summary');
      expect(result.count).toBe(2);

      // Check CSV structure
      const lines = result.data!.split('\n');
      expect(lines[0]).toContain('First Name,Last Name,Section');
      expect(lines[0]).toContain('Total Events,Present,Absent');
      expect(lines[0]).toContain('Attendance Rate (%)');
      expect(lines[1]).toContain('John,Doe,Trumpet');
      expect(lines[1]).toContain('3,2,1'); // total, present, absent
      expect(lines[1]).toContain('67'); // attendance rate
    });

    it('should calculate attendance rate correctly', async () => {
      (prisma.member.findMany as any).mockResolvedValue(mockMembers);

      const result = await exportMemberAttendanceSummary({});

      const lines = result.data!.split('\n');
      const johnLine = lines[1];
      const janeLine = lines[2];

      // John: 2 present out of 3 = 67%
      expect(johnLine).toContain('67');
      // Jane: 1 present out of 2 = 50%
      expect(janeLine).toContain('50');
    });
  });

  describe('exportEventAttendanceSummary', () => {
    const mockEvents = [
      {
        id: 'event-1',
        title: 'Winter Concert',
        type: 'CONCERT',
        startTime: new Date('2024-01-15T19:00:00Z'),
        location: 'Main Hall',
        attendance: [
          { status: 'PRESENT' },
          { status: 'PRESENT' },
          { status: 'ABSENT' },
        ],
      },
      {
        id: 'event-2',
        title: 'Weekly Rehearsal',
        type: 'REHEARSAL',
        startTime: new Date('2024-01-10T19:00:00Z'),
        location: 'Band Room',
        attendance: [
          { status: 'PRESENT' },
          { status: 'LATE' },
        ],
      },
    ];

    it('should require ATTENDANCE_VIEW_ALL permission', async () => {
      (requirePermission as any).mockRejectedValue(new Error('Permission denied'));

      const result = await exportEventAttendanceSummary({});

      expect(result.success).toBe(false);
    });

    it('should export event attendance summary to CSV', async () => {
      (prisma.event.findMany as any).mockResolvedValue(mockEvents);

      const result = await exportEventAttendanceSummary({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.filename).toContain('event-attendance-summary');
      expect(result.count).toBe(2);

      // Check CSV structure
      const lines = result.data!.split('\n');
      expect(lines[0]).toContain('Event,Event Type,Event Date');
      expect(lines[0]).toContain('Total Records,Present,Absent');
      expect(lines[0]).toContain('Attendance Rate (%)');
      expect(lines[1]).toContain('Winter Concert,CONCERT');
      expect(lines[1]).toContain('3,2,1'); // total, present, absent
      expect(lines[1]).toContain('67'); // attendance rate
    });

    it('should filter by event type', async () => {
      (prisma.event.findMany as any).mockResolvedValue([mockEvents[0]]);

      await exportEventAttendanceSummary({
        eventType: 'CONCERT',
      });

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'CONCERT',
          }),
        })
      );
    });
  });

  describe('getAttendanceReportData', () => {
    it('should return attendance data with stats', async () => {
      (prisma.attendance.findMany as any).mockResolvedValue(mockAttendance);

      const result = await getAttendanceReportData({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result.success).toBe(true);
      expect(result.attendance).toBeDefined();
      expect(result.stats).toBeDefined();
      expect(result.stats?.total).toBe(2);
      expect(result.stats?.present).toBe(1);
      expect(result.stats?.absent).toBe(1);
      expect(result.stats?.attendanceRate).toBe(50);
    });

    it('should return error when user lacks permission', async () => {
      (checkUserPermission as any).mockResolvedValue(false);

      const result = await getAttendanceReportData({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });
});
