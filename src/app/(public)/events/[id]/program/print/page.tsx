import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getEventProgram } from '@/lib/events/program-query';
import { UNKNOWN_DURATION_LABEL } from '@/lib/events/program';

export const dynamic = 'force-dynamic';

interface PrintProgramPageProps {
  params: Promise<{ id: string }>;
}

export const metadata: Metadata = {
  title: 'Concert Program (print)',
  robots: { index: false, follow: false },
};

/**
 * Print-optimised program. Chrome-free, black on white, US Letter, and it
 * auto-opens the browser print dialog. The PDF download at
 * /api/events/[id]/program.pdf produces the same content.
 */
export default async function PrintProgramPage({ params }: PrintProgramPageProps) {
  const { id } = await params;
  const program = await getEventProgram(id);

  if (!program) notFound();

  const { event, items, runtime, groups } = program;

  return (
    <div className="print-sheet">
      <style>{`
        @page { size: Letter; margin: 0.75in; }
        @media print {
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
          .print-sheet { max-width: none !important; padding: 0 !important; }
        }
        @media screen {
          .print-sheet {
            max-width: 8.5in;
            margin: 2rem auto;
            padding: 1rem 3rem 3rem;
            background: #fff;
            color: #000;
            font-family: Georgia, 'Times New Roman', serif;
          }
        }
        .no-print {
          max-width: 8.5in;
          margin: 1rem auto 0;
          font-family: system-ui, sans-serif;
        }
        .print-sheet h1 { font-size: 2rem; text-align: center; margin: 0 0 0.5rem; }
        .print-sheet h2 {
          font-size: 1.1rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          text-align: center;
          margin: 1.75rem 0 0.75rem;
        }
        .print-sheet .meta { text-align: center; }
        .print-sheet .meta p { margin: 0.15rem 0; }
        .print-sheet ol { list-style: none; padding: 0; margin: 0; }
        .print-sheet li {
          display: flex;
          gap: 0.75rem;
          margin-bottom: 0.9rem;
          page-break-inside: avoid;
        }
        .print-sheet .pos { width: 1.5rem; text-align: right; font-weight: bold; }
        .print-sheet .body { flex: 1; }
        .print-sheet .title { font-size: 1.05rem; font-weight: bold; }
        .print-sheet .credit { font-size: 0.85rem; font-style: italic; }
        .print-sheet .performer { font-size: 0.85rem; margin-left: 0.75rem; }
        .print-sheet .duration { font-size: 0.85rem; }
        .print-sheet .unknown {
          font-size: 0.85rem;
          font-style: italic;
          border: 1px solid #000;
          padding: 0 0.3rem;
          display: inline-block;
        }
        .print-sheet .total {
          margin-top: 1.5rem;
          border-top: 1px solid #000;
          padding-top: 0.6rem;
          text-align: center;
          font-weight: bold;
        }
        .print-sheet .lower-bound {
          text-align: center;
          font-style: italic;
          font-size: 0.85rem;
          margin-top: 0.25rem;
        }
        .print-sheet .groups {
          margin-top: 1.5rem;
          text-align: center;
          font-size: 0.9rem;
        }
      `}</style>

      <div className="no-print">
        <PrintTrigger />
      </div>

      <article className="print-sheet">
        <header>
          <h1>{event.title}</h1>
          <div className="meta">
            <p>{event.dateLabel}</p>
            <p>{event.timeLabel}</p>
            {event.venueLabel && <p>{event.venueLabel}</p>}
            {event.description && <p>{event.description}</p>}
            {event.dressCode && <p>Dress code: {event.dressCode}</p>}
          </div>
        </header>

        <h2>Program</h2>
        {items.length === 0 ? (
          <p>No pieces scheduled for this concert.</p>
        ) : (
          <ol>
            {items.map((item) => (
              <li key={item.id}>
                <span className="pos">{item.position}</span>
                <div className="body">
                  <div className="title">{item.title}</div>
                  {item.subtitle && <div className="credit">{item.subtitle}</div>}
                  {(item.composer || item.arranger) && (
                    <div className="credit">
                      {item.composer}
                      {item.composer && item.arranger && ' / '}
                      {item.arranger && `arr. ${item.arranger}`}
                    </div>
                  )}
                  {item.performers.map((performer) => (
                    <div className="performer" key={performer.memberId}>
                      {performer.name}
                      {performer.partName ? ` — ${performer.partName}` : ''}
                      {performer.sectionNames.length > 0
                        ? ` (${performer.sectionNames.join(', ')})`
                        : ''}
                    </div>
                  ))}
                  {item.notes && <div className="credit">{item.notes}</div>}
                  {item.durationKnown ? (
                    <div className="duration">{item.durationLabel}</div>
                  ) : (
                    <div className="unknown">Duration: {UNKNOWN_DURATION_LABEL}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="total">Total running time: {runtime.label}</div>
        {runtime.isLowerBound && (
          <div className="lower-bound">
            {runtime.unknownCount} of {runtime.pieceCount} pieces have no duration on file — this
            total is a minimum.
          </div>
        )}

        {groups.length > 0 && (
          <div className="groups">
            Performing Groups: {groups.map((g) => g.name).join(' · ')}
          </div>
        )}
      </article>
    </div>
  );
}

/** Client-free auto-print: a tiny inline script keeps this a server component. */
function PrintTrigger() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: 'if(typeof window!=="undefined"){window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})}',
      }}
    />
  );
}
