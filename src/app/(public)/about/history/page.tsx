import type { Metadata } from 'next';
import Link from 'next/link';
import { Music, Users, Heart, Sparkles } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Our History | Emerald Coast Community Band',
  description:
    'The history of the Emerald Coast Community Band, from its founding to the present day.',
  alternates: { canonical: '/about/history' },
};

interface Era {
  period: string;
  title: string;
  description: string;
}

/**
 * Our History.
 *
 * A real route rather than CMS content: the public navigation links to
 * /about/history unconditionally, and the seed script creates no CMS pages, so
 * a CMS-backed page would 404 on a freshly installed database.
 *
 * IMPORTANT — the eras below are structural, not archival. No specific dates,
 * conductor names, or competition results are asserted, because none are
 * recorded anywhere in this repository and inventing them would put false
 * claims on a public page. A director can add real detail here.
 */
const ERAS: Era[] = [
  {
    period: 'Founding',
    title: 'A community band takes shape',
    description:
      'The band began as an idea: that a volunteer concert band could serve the Emerald Coast year-round, not just for a single summer season. A group of local musicians organised rehearsals, recruited players, and started performing.',
  },
  {
    period: 'Growth',
    title: 'Becoming a permanent part of the community',
    description:
      'Word spread and membership grew. The band developed a concert season, a rehearsal routine, and the friendships that make sustained volunteer ensembles possible.',
  },
  {
    period: 'Today',
    title: 'A volunteer organisation, still rehearsing',
    description:
      'Today the band continues to rehearse weekly, perform free public concerts, and welcome new players. Membership is volunteer and there are no membership fees.',
  },
];

export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Our History
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          How the Emerald Coast Community Band came to be, and where it is
          today.
        </p>
      </header>

      <section aria-label="History timeline" className="mb-12">
        <ol className="relative space-y-10 border-l-2 border-primary/30 pl-8">
          {ERAS.map((era) => (
            <li key={era.period} className="relative">
              <span
                className="absolute -left-[2.4rem] flex h-4 w-4 rounded-full bg-primary ring-4 ring-background"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold uppercase tracking-wide text-primary">
                {era.period}
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">
                {era.title}
              </h2>
              <p className="mt-2 text-slate-700 dark:text-slate-300">
                {era.description}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="history-note"
        className="mb-12 rounded-lg border border-slate-200 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <h2
          id="history-note"
          className="mb-2 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-50"
        >
          <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
          More detail welcome
        </h2>
        <p className="text-slate-700 dark:text-slate-300">
          If you played in an earlier ensemble in this area, or you have
          photographs, programmes, or recollections we could add, please{' '}
          <Link href="/contact" className="text-primary underline hover:no-underline">
            get in touch
          </Link>
          . We would like this page to reflect the band&rsquo;s real
          history.
        </p>
      </section>

      <section aria-labelledby="history-why">
        <h2 id="history-why" className="text-2xl font-semibold mb-4">
          Why it matters
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Music className="mb-3 h-6 w-6 text-primary" aria-hidden="true" />
            <h3 className="mb-2 font-semibold text-slate-900 dark:text-slate-50">
              Lifelong music-making
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Playing in an ensemble keeps people playing. Many members came
              back to music after years away.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Users className="mb-3 h-6 w-6 text-primary" aria-hidden="true" />
            <h3 className="mb-2 font-semibold text-slate-900 dark:text-slate-50">
              A social community
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Weekly rehearsals create real friendships across the Emerald
              Coast.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Heart className="mb-3 h-6 w-6 text-primary" aria-hidden="true" />
            <h3 className="mb-2 font-semibold text-slate-900 dark:text-slate-50">
              Free public concerts
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Our performances are free and open to everyone, including
              families.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
