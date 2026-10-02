import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getEventProgram } from '@/lib/events/program-query';
import { UNKNOWN_DURATION_LABEL } from '@/lib/events/program';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Printer, FileDown, Music } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface ProgramPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ProgramPageProps): Promise<Metadata> {
  const { id } = await params;
  const program = await getEventProgram(id);
  if (!program) return { title: 'Program Not Found' };
  return {
    title: `${program.event.title} — Program`,
    description: program.event.description ?? `Concert program for ${program.event.title}`,
  };
}

export default async function PublicProgramPage({ params }: ProgramPageProps) {
  const { id } = await params;
  const program = await getEventProgram(id);

  if (!program) notFound();

  const { event, items, runtime, groups } = program;

  return (
    <div className="w-full py-12 md:py-16">
      <div className="mx-auto w-full max-w-3xl px-6 lg:px-8">
        {/* Screen-only controls */}
        <div className="no-print mb-8 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" asChild>
            <Link href={`/events/${id}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Event
            </Link>
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/events/${id}/program/print`}>
                <Printer className="mr-2 h-4 w-4" />
                Print view
              </Link>
            </Button>
            <Button asChild>
              <a href={`/api/events/${id}/program.pdf`}>
                <FileDown className="mr-2 h-4 w-4" />
                Download PDF
              </a>
            </Button>
          </div>
        </div>

        <article className="program-document">
          <header className="text-center">
            <h1 className="text-4xl font-bold tracking-tight">{event.title}</h1>
            <p className="mt-3 text-lg text-muted-foreground">{event.dateLabel}</p>
            <p className="text-lg text-muted-foreground">{event.timeLabel}</p>
            {event.venueLabel && (
              <p className="mt-1 text-lg text-muted-foreground">{event.venueLabel}</p>
            )}
            {event.description && (
              <p className="mt-4 text-muted-foreground max-w-2xl mx-auto">
                {event.description}
              </p>
            )}
            {event.dressCode && (
              <p className="mt-2 text-sm text-muted-foreground">
                Dress code: {event.dressCode}
              </p>
            )}
          </header>

          <section className="mt-10">
            <h2 className="text-center text-2xl font-semibold tracking-wide uppercase">Program</h2>

            {items.length === 0 ? (
              <p className="mt-6 text-center text-muted-foreground">
                The program for this concert has not been set yet.
              </p>
            ) : (
              <ol className="mt-6 space-y-5">
                {items.map((item) => (
                  <li key={item.id} className="flex gap-4">
                    <span className="w-6 shrink-0 text-xl font-bold text-muted-foreground/40">
                      {item.position}
                    </span>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold">{item.title}</h3>
                      {item.subtitle && (
                        <p className="text-sm text-muted-foreground italic">{item.subtitle}</p>
                      )}
                      {(item.composer || item.arranger) && (
                        <p className="text-sm text-muted-foreground">
                          {item.composer}
                          {item.composer && item.arranger && ' / '}
                          {item.arranger && `arr. ${item.arranger}`}
                        </p>
                      )}
                      {item.performers.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {item.performers.map((performer) => (
                            <li key={performer.memberId} className="text-sm text-muted-foreground">
                              {performer.name}
                              {performer.partName && ` — ${performer.partName}`}
                              {performer.sectionNames.length > 0 &&
                                ` (${performer.sectionNames.join(', ')})`}
                            </li>
                          ))}
                        </ul>
                      )}
                      {item.notes && <p className="text-sm text-muted-foreground">{item.notes}</p>}
                      {item.durationKnown ? (
                        <p className="mt-1 text-sm font-medium text-primary">
                          {item.durationLabel}
                        </p>
                      ) : (
                        <p className="mt-1">
                          <Badge
                            variant="outline"
                            className="border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                          >
                            Duration: {UNKNOWN_DURATION_LABEL}
                          </Badge>
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="mt-10 border-t pt-4 text-center">
            <p className="text-lg font-semibold">
              Total running time: {runtime.label}
            </p>
            {runtime.isLowerBound && (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                {runtime.unknownCount} of {runtime.pieceCount} pieces have no duration on file, so
                this total is a minimum.
              </p>
            )}
          </section>

          {groups.length > 0 && (
            <section className="mt-8">
              <h2 className="text-center text-lg font-semibold uppercase tracking-wide">
                Performing Groups
              </h2>
              <ul className="mt-3 flex flex-wrap justify-center gap-2">
                {groups.map((group) => (
                  <li key={group.name}>
                    <Badge variant="secondary">
                      <Music className="mr-1 h-3 w-3" />
                      {group.name} · {group.memberIds.length}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          .program-document {
            max-width: none;
            margin: 0;
            padding: 0;
          }
          .program-document ol { page-break-inside: auto; }
          .program-document li { page-break-inside: avoid; }
          a[href]::after { content: ''; }
        }
      `}</style>
    </div>
  );
}
