import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { MemberForm } from '@/components/admin/members/member-form';
import { createMember } from '../actions';

import { MEMBER_CREATE } from '@/lib/auth/permission-constants';
export default async function NewMemberPage() {
  await requirePermission(MEMBER_CREATE);

  const [sections, instruments, usersWithoutMember] = await Promise.all([
    prisma.section.findMany({
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.instrument.findMany({
      select: { id: true, name: true, family: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    }),
    // Get users who don't have a member profile yet
    prisma.user.findMany({
      where: {
        member: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/members">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Add Member</h1>
          <p className="text-muted-foreground">
            Create a new member profile
          </p>
        </div>
      </div>

      <MemberForm
        sections={sections}
        instruments={instruments}
        users={usersWithoutMember}
        onSubmit={createMember}
      />
    </div>
  );
}
