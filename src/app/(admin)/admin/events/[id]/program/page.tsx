import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, FileText } from 'lucide-react';
import { ProgramBuilder } from '@/components/admin/events/ProgramBuilder';
import { getEventProgram } from '@/lib/events/program-query';
import { EVENT_EDIT } from '@/lib/auth/permission-constants';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Admin program builder: order, performers, runtime, and program output. */
export default async function AdminEventProgramPage({ params }: PageProps) {
  await requirePermission(EVENT_EDIT);
  const { id } = await params;

  const program = await getEventProgram(id, { publishedOnly: false });
  if (!program) notFound();

  const members = await prisma.member.findMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'INACTIVE'] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      sections: { include: { section: { select: { name: true } } } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/events/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <FileText className="h-6 w-6 text-primary" />
            Concert Program
          </h1>
          <p className="text-muted-foreground">{program.event.title}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Running Order &amp; Program</CardTitle>
          <CardDescription>
            Reorder pieces, assign performers, and generate the printable program, PDF and public
            page. Order changes save to the database immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProgramBuilder
            eventId={id}
            initialItems={program.items.map((item) => ({
              id: item.id,
              position: item.position,
              pieceId: item.pieceId,
              title: item.title,
              composer: item.composer,
              durationLabel: item.durationLabel,
              durationKnown: item.durationKnown,
              performers: item.performers,
            }))}
            runtime={{
              label: program.runtime.label,
              isLowerBound: program.runtime.isLowerBound,
              unknownCount: program.runtime.unknownCount,
              pieceCount: program.runtime.pieceCount,
            }}
            members={members.map((member) => ({
              id: member.id,
              name: `${member.firstName} ${member.lastName}`.trim(),
              sectionNames: member.sections.map((s) => s.section.name).sort(),
            }))}
            isPublished={program.event.isPublished}
          />
        </CardContent>
      </Card>
    </div>
  );
}
