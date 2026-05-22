import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { EventForm } from '@/components/admin/events/event-form';
import { createEvent } from '../actions';

import { EVENT_CREATE } from '@/lib/auth/permission-constants';
export default async function NewEventPage() {
  await requirePermission(EVENT_CREATE);

  const venues = await prisma.venue.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/events">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Add Event</h1>
          <p className="text-muted-foreground">
            Create a new rehearsal, concert, or event
          </p>
        </div>
      </div>

      <EventForm venues={venues} onSubmit={createEvent} />
    </div>
  );
}
