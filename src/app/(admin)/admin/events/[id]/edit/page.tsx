import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { EventForm } from '@/components/admin/events/event-form';
import { updateEvent } from '../../actions';

import { EVENT_EDIT } from '@/lib/auth/permission-constants';
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditEventPage({ params }: PageProps) {
  await requirePermission(EVENT_EDIT);
  const { id } = await params;

  const [event, venues] = await Promise.all([
    prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        startTime: true,
        endTime: true,
        venueId: true,
        isPublished: true,
        dressCode: true,
        callTime: true,
        isCancelled: true,
      },
    }),
    prisma.venue.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  if (!event) {
    notFound();
  }

  // Map DB model back to form initial data
  const initialData = {
    title: event.title,
    description: event.description ?? '',
    eventType: event.type,
    status: event.isCancelled ? 'CANCELLED' : 'SCHEDULED',
    startDate: event.startTime.toISOString().slice(0, 16), // datetime-local
    endDate: event.endTime ? event.endTime.toISOString().slice(0, 16) : '',
    venueId: event.venueId ?? '',
    isPublished: event.isPublished,
    dressCode: event.dressCode ?? '',
    callTime: event.callTime ? event.callTime.toISOString().slice(0, 16) : '',
  };

  // Bind id into action
  const updateEventWithId = updateEvent.bind(null, id);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/events/${id}`}>
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Event</h1>
          <p className="text-muted-foreground">Update details for {event.title}</p>
        </div>
      </div>

      <EventForm
        venues={venues}
        initialData={initialData}
        onSubmit={updateEventWithId}
        isEdit
      />
    </div>
  );
}
