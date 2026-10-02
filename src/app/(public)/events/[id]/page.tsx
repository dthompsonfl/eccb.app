import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, MapPin, Clock, ArrowLeft, Music, Navigation, Car } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface EventPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: EventPageProps): Promise<Metadata> {
  const { id } = await params;
  const event = await prisma.event.findUnique({
    where: { id },
    select: { title: true, description: true },
  });

  if (!event) {
    return { title: 'Event Not Found' };
  }

  return {
    title: event.title,
    description: event.description || `Join us for ${event.title}`,
  };
}

async function getEvent(id: string) {
  return prisma.event.findUnique({
    where: { id, deletedAt: null },
    include: {
      venue: true,
      music: {
        include: {
          piece: {
            include: {
              composer: true,
              arranger: true,
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
      notes: {
        where: { isPublic: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

export default async function EventDetailPage({ params }: EventPageProps) {
  const { id } = await params;
  const event = await getEvent(id);

  if (!event || !event.isPublished) {
    notFound();
  }

  const isPast = new Date(event.endTime) < new Date();

  return (
    <div className="w-full py-12 md:py-16">
      {/* Back navigation */}
      <div className="mx-auto w-full max-w-4xl px-6 lg:px-8 py-4">
        <Button variant="ghost" asChild>
          <Link href="/events">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Events
          </Link>
        </Button>
      </div>

      {/* Event Header */}
      <section className="py-8 bg-gradient-to-b from-primary/10 to-transparent">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="flex flex-wrap items-start gap-4 mb-4">
            <Badge className={event.type === 'CONCERT' ? 'bg-primary' : ''}>
              {event.type.replace('_', ' ')}
            </Badge>
            {event.isCancelled && (
              <Badge variant="destructive">Cancelled</Badge>
            )}
            {isPast && !event.isCancelled && (
              <Badge variant="secondary">Past Event</Badge>
            )}
          </div>
          
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {event.title}
          </h1>
          
          {event.description && (
            <p className="mt-4 text-xl text-muted-foreground max-w-3xl">
              {event.description}
            </p>
          )}
        </div>
      </section>

      {/* Event Details */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Main Content */}
            <div className="lg:col-span-2 space-y-8">
              {/* Program */}
              {event.music.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-lg">
                  <h2 className="text-xl font-semibold flex items-center gap-2 mb-6">
                    <Music className="h-5 w-5 text-primary" />
                    Program
                  </h2>
                  <div className="space-y-4">
                    {event.music.map((item, index) => (
                      <div
                        key={item.id}
                        className="flex items-start gap-4 py-3 border-b last:border-0"
                      >
                        <span className="text-2xl font-bold text-muted-foreground/30 w-8">
                          {index + 1}
                        </span>
                        <div>
                          <h3 className="font-medium">{item.piece.title}</h3>
                          {(item.piece.composer || item.piece.arranger) && (
                            <p className="text-sm text-muted-foreground">
                              {item.piece.composer && `${item.piece.composer.fullName}`}
                              {item.piece.composer && item.piece.arranger && ' / '}
                              {item.piece.arranger && `arr. ${item.piece.arranger.fullName}`}
                            </p>
                          )}
                          {item.notes && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {item.notes}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                    <p className="pt-4 text-center text-sm">
                      <Link
                        href={`/events/${event.id}/program`}
                        className="text-primary underline underline-offset-4"
                      >
                        View the full concert program
                      </Link>
                    </p>
                  </div>
                </div>
              )}

              {/* Notes */}
              {event.notes.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-lg">
                  <h2 className="text-xl font-semibold mb-6">Event Notes</h2>
                  <div className="space-y-4">
                    {event.notes.map((note) => (
                      <div key={note.id} className="prose dark:prose-invert max-w-none">
                        {note.title && <h3>{note.title}</h3>}
                        <p>{note.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Date & Time Card */}
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-lg">
                <h2 className="text-lg font-semibold mb-4">When</h2>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <CalendarDays className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <div className="font-medium">{formatDate(event.startTime, 'EEEE, MMMM d, yyyy')}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Clock className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <div className="font-medium">
                        {formatTime(event.startTime)} - {formatTime(event.endTime)}
                      </div>
                      {event.callTime && (
                        <div className="text-sm text-muted-foreground">
                          Call time: {formatTime(event.callTime)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Location Card */}
              {event.venue && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-lg">
                  <h2 className="text-lg font-semibold mb-4">Where</h2>
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <MapPin className="h-5 w-5 text-primary mt-0.5" />
                      <div>
                        <div className="font-medium">{event.venue.name}</div>
                        {event.venue.address && (
                          <div className="text-sm text-muted-foreground">
                            {event.venue.address}
                            {event.venue.city && <br />}
                            {event.venue.city && `${event.venue.city}, ${event.venue.state || ''} ${event.venue.zipCode || ''}`}
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {event.venue.directions && (
                      <div className="flex items-start gap-3">
                        <Navigation className="h-5 w-5 text-primary mt-0.5" />
                        <div className="text-sm text-muted-foreground">
                          {event.venue.directions}
                        </div>
                      </div>
                    )}

                    {event.venue.parking && (
                      <div className="flex items-start gap-3">
                        <Car className="h-5 w-5 text-primary mt-0.5" />
                        <div className="text-sm text-muted-foreground">
                          {event.venue.parking}
                        </div>
                      </div>
                    )}

                    {event.venue.address && (
                      <Button variant="outline" className="w-full" asChild>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                            `${event.venue.name} ${event.venue.address || ''} ${event.venue.city || ''}`
                          )}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Get Directions
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Dress Code */}
              {event.dressCode && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-lg">
                  <h2 className="text-lg font-semibold mb-4">Dress Code</h2>
                  <p className="text-muted-foreground">{event.dressCode}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
