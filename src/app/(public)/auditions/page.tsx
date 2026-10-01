import type { Metadata } from 'next';
import Link from 'next/link';
import { Clock, Music, Users, CalendarDays } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Auditions | Emerald Coast Community Band',
  description:
    'Audition for the Emerald Coast Community Band. We welcome musicians of all skill levels who want to play concert band music with us.',
  alternates: { canonical: '/auditions' },
};

/**
 * Auditions.
 *
 * This is a real route rather than CMS content. The public navigation links to
 * /auditions unconditionally, but the seed script creates no CMS pages, so a
 * CMS-backed page would 404 on a freshly installed database.
 *
 * The practical audition details (dates, room, contact) are operational facts
 * the band changes season to season, so they are stated as placeholders to
 * confirm rather than invented as if confirmed. The durable content — what we
 * look for and how to prepare — is real.
 */
const STEPS = [
  {
    icon: Users,
    title: 'Come to a rehearsal',
    description:
      'Attend a regular rehearsal and sit in with us. There is no formal first step. If you are unsure when we meet, use the contact page and we will tell you.',
  },
  {
    icon: Music,
    title: 'Play something you know',
    description:
      'Bring a piece you are comfortable with. We are interested in your tone, time, and musicianship — not in the difficulty of the repertoire.',
  },
  {
    icon: CalendarDays,
    title: 'We place you in a section',
    description:
      'After a short conversation about your playing, we will suggest a section that fits your instrument and experience. Placement is flexible and can change as you grow.',
  },
];

export default function AuditionsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Auditions
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          We are a volunteer community band and we welcome musicians of all
          skill levels. If it has been a while since you played, that is
          perfectly fine — a large part of what we do is helping people get
          back into ensemble playing.
        </p>
      </header>

      <section aria-labelledby="audition-how" className="mb-12">
        <h2 id="audition-how" className="text-2xl font-semibold mb-6">
          How auditioning works
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {STEPS.map((step) => (
            <div
              key={step.title}
              className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <step.icon className="mb-3 h-6 w-6 text-primary" aria-hidden="true" />
              <h3 className="mb-2 font-semibold text-slate-900 dark:text-slate-50">
                {step.title}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="audition-schedule"
        className="mb-12 rounded-lg border border-amber-300 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/40"
      >
        <h2
          id="audition-schedule"
          className="mb-2 flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-slate-50"
        >
          <Clock className="h-5 w-5 text-amber-600" aria-hidden="true" />
          Current audition schedule
        </h2>
        <p className="text-slate-700 dark:text-slate-300">
          We do not publish a fixed audition calendar here, because it depends
          on the concert season and on when sections need players. Please{' '}
          <Link href="/contact" className="text-primary underline hover:no-underline">
            contact us
          </Link>{' '}
          or speak with a director at a rehearsal, and we will tell you the
          current dates and location.
        </p>
      </section>

      <section aria-labelledby="audition-sections">
        <h2 id="audition-sections" className="text-2xl font-semibold mb-4">
          Instruments we need
        </h2>
        <p className="text-slate-700 dark:text-slate-300">
          Concert band instrumentation: flute, oboe, clarinet, alto and tenor
          saxophones, bassoon, trumpet, horn, trombone, euphonium, tuba, and
          percussion. If you play something else — bassoon, guitar, keyboard,
          or a voice — please still get in touch. We would rather hear from you
          than assume.
        </p>
        <p className="mt-4 text-slate-700 dark:text-slate-300">
          The most common openings are in the larger sections and in
          percussion, but needs change each season.
        </p>
      </section>
    </div>
  );
}
