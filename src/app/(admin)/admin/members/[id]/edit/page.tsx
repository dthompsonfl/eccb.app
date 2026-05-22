import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { MemberForm } from '@/components/admin/members/member-form';
import { updateMember } from '../../actions';

import { MEMBER_EDIT_ALL } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditMemberPage({ params }: PageProps) {
  await requirePermission(MEMBER_EDIT_ALL);
  const { id } = await params;

  const [member, sections, instruments] = await Promise.all([
    prisma.member.findUnique({
      where: { id },
      include: {
        user: true,
      },
    }),
    prisma.section.findMany({
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.instrument.findMany({
      select: { id: true, name: true, family: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    }),
  ]);

  if (!member) {
    notFound();
  }

  const handleUpdate = async (formData: FormData) => {
    'use server';
    return updateMember(id, formData);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/members/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Member</h1>
          <p className="text-muted-foreground">
            Update details for {member.user?.name || `${member.firstName} ${member.lastName}`}
          </p>
        </div>
      </div>

      <MemberForm
        sections={sections}
        instruments={instruments}
        initialData={{
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email || undefined,
          status: member.status,
          joinDate: member.joinDate?.toISOString().split('T')[0],
          phone: member.phone || undefined,
          emergencyName: member.emergencyName || undefined,
          emergencyPhone: member.emergencyPhone || undefined,
          notes: member.notes || undefined,
        }}
        onSubmit={handleUpdate}
        isEdit
      />
    </div>
  );
}
