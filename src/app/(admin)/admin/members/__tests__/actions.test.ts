import { MEMBER_VIEW_ALL } from '@/lib/auth/permission-constants';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportMembersToCSV } from '../actions';
import { prisma } from '@/lib/db';
import { requirePermission, getMemberSectionFilter } from '@/lib/auth/guards';

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  requirePermission: vi.fn(),
  getMemberSectionFilter: vi.fn(),
}));

vi.mock('@/lib/services/audit', () => ({
  auditLog: vi.fn(),
}));

describe('Member Actions', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    (requirePermission as any).mockResolvedValue({ user: { id: 'test-user' } });
    (getMemberSectionFilter as any).mockResolvedValue(null);
  });

  describe('exportMembersToCSV', () => {
    it('should export members with no filters', async () => {
      const mockMembers = [
        {
          id: '1',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '555-1234',
          status: 'ACTIVE',
          joinDate: new Date('2023-01-15'),
          emergencyName: 'Jane Doe',
          emergencyPhone: '555-5678',
          emergencyEmail: 'jane@example.com',
          user: { email: 'user@example.com', roles: [] },
          instruments: [{ instrument: { name: 'Trumpet' } }],
          sections: [{ section: { name: 'Brass' } }],
        },
        {
          id: '2',
          firstName: 'Jane',
          lastName: 'Smith',
          email: null,
          phone: null,
          status: 'PENDING',
          joinDate: null,
          emergencyName: null,
          emergencyPhone: null,
          emergencyEmail: null,
          user: { email: 'jane.smith@example.com', roles: [{ role: { name: 'MUSICIAN', displayName: 'Musician' } }] },
          instruments: [],
          sections: [],
        },
      ];

      (prisma.member.findMany as any).mockResolvedValue(mockMembers);

      const result = await exportMembersToCSV({});

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.filename).toMatch(/^members-export-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(result.data).toContain('First Name,Last Name,Email,Phone,Status,Section,Instrument,Role,Join Date,Emergency Contact,Emergency Phone,Emergency Email');
      expect(result.data).toContain('John,Doe,john@example.com,555-1234,ACTIVE,Brass,Trumpet,,2023-01-15,Jane Doe,555-5678,jane@example.com');
      expect(result.data).toContain('Jane,Smith,jane.smith@example.com,,PENDING,,,Musician,,,');
    });

    it('should filter by status', async () => {
      (prisma.member.findMany as any).mockResolvedValue([]);

      await exportMembersToCSV({ status: 'ACTIVE' });

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE' }),
        })
      );
    });

    it('should filter by section', async () => {
      (prisma.member.findMany as any).mockResolvedValue([]);

      await exportMembersToCSV({ sectionId: 'section-123' });

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sections: { some: { sectionId: 'section-123' } },
          }),
        })
      );
    });

    it('should filter by instrument', async () => {
      (prisma.member.findMany as any).mockResolvedValue([]);

      await exportMembersToCSV({ instrumentId: 'instrument-456' });

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            instruments: { some: { instrumentId: 'instrument-456' } },
          }),
        })
      );
    });

    it('should filter by role', async () => {
      (prisma.member.findMany as any).mockResolvedValue([]);

      await exportMembersToCSV({ roleId: 'role-789' });

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: { roles: { some: { roleId: 'role-789' } } },
          }),
        })
      );
    });

    it('should escape CSV fields with special characters', async () => {
      const mockMembers = [
        {
          id: '1',
          firstName: 'John, Jr.',
          lastName: 'Doe "The Man"',
          email: 'john@example.com',
          phone: null,
          status: 'ACTIVE',
          joinDate: null,
          emergencyName: null,
          emergencyPhone: null,
          emergencyEmail: null,
          user: { email: 'user@example.com', roles: [] },
          instruments: [],
          sections: [],
        },
      ];

      (prisma.member.findMany as any).mockResolvedValue(mockMembers);

      const result = await exportMembersToCSV({});

      expect(result.success).toBe(true);
      expect(result.data).toContain('"John, Jr."');
      expect(result.data).toContain('"Doe ""The Man"""');
    });

    it('should handle errors gracefully', async () => {
      (prisma.member.findMany as any).mockRejectedValue(new Error('Database error'));

      const result = await exportMembersToCSV({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to export members');
    });

    it('should require permission', async () => {
      await exportMembersToCSV({});

      expect(requirePermission).toHaveBeenCalledWith(MEMBER_VIEW_ALL);
    });
  });
});

    it('should search with case-insensitive mode', async () => {
      (prisma.member.findMany as any).mockResolvedValue([]);

      await exportMembersToCSV({ search: 'john' });

      // Verify at least one condition uses insensitive mode
      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                firstName: expect.objectContaining({
                  contains: 'john',
                  mode: 'insensitive',
                }),
              }),
            ]),
          }),
        })
      );
    });
