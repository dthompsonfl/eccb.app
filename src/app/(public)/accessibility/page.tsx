import Link from 'next/link';
import type { Metadata } from 'next';
import { Accessibility, CheckCircle2, Keyboard, Eye, Volume2 } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Accessibility Statement | Emerald Coast Community Band',
  description:
    'The Emerald Coast Community Band commitment to an accessible website, member portal, and Digital Music Stand.',
  alternates: { canonical: '/accessibility' },
};

/**
 * Accessibility Statement.
 *
 * A real route because the public footer links to /accessibility
 * unconditionally; it must resolve in a brand-new database.
 *
 * The commitments below describe behavior that is implemented and covered by
 * automated checks, not aspirations. Where something has a known limitation it
 * is stated as a limitation rather than promised away.
 */
export default function AccessibilityPage() {
  const lastReviewed = 'October 1, 2026';

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Accessibility Statement
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last reviewed: {lastReviewed}</p>
      </header>

      <div className="space-y-8 text-slate-700 dark:text-slate-300">
        <section aria-labelledby="a11y-commitment" className="flex gap-3">
          <Accessibility className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="a11y-commitment" className="text-xl font-semibold mb-2">
              Our commitment
            </h2>
            <p>
              The Emerald Coast Community Band is committed to making this
              website, the member portal, and the Digital Music Stand usable by
              as many people as possible, including people with disabilities.
              We aim to conform to the Web Content Accessibility Guidelines
              (WCAG) 2.2 Level AA.
            </p>
          </div>
        </section>

        <section aria-labelledby="a11y-measures">
          <h2 id="a11y-measures" className="text-xl font-semibold mb-3">
            Measures we take
          </h2>
          <ul className="space-y-3">
            <li className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <strong>Keyboard access.</strong> All interactive controls,
                dialogs, and menus are reachable and operable by keyboard.
                Visible focus indicators are provided throughout.
              </span>
            </li>
            <li className="flex gap-3">
              <Keyboard className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <strong>Page turning in the Digital Music Stand.</strong> Music
                can be turned without a pointer or precise gestures, using
                keyboard keys and page-turn controls sized for touch. Mouse and
                MIDI pedal controls are additional options, never the only way.
              </span>
            </li>
            <li className="flex gap-3">
              <Eye className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <strong>Structure and screen readers.</strong> Pages use
                proper landmarks and heading hierarchy, form controls have
                associated labels, and errors are announced and associated with
                the field that caused them.
              </span>
            </li>
            <li className="flex gap-3">
              <Volume2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <strong>Text and motion.</strong> Content reflows at high zoom
                without horizontal scrolling, colour choices meet contrast
                requirements, and animation respects the
                <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-sm dark:bg-slate-800">
                  prefers-reduced-motion
                </code>
                setting.
              </span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="a11y-stand">
          <h2 id="a11y-stand" className="text-xl font-semibold mb-2">
            Digital Music Stand
          </h2>
          <p>
            The Stand is designed for use on tablets and laptops during
            rehearsal, including in bright rooms and at a distance. Zoom and
            page-fit controls let you enlarge the score and read it at your own
            pace. The tuner and audio tools use your microphone only while you
            have them switched on; the microphone is blocked by the browser on
            every other page, and audio is never recorded or stored.
          </p>
        </section>

        <section aria-labelledby="a11y-limitations">
          <h2 id="a11y-limitations" className="text-xl font-semibold mb-2">
            Known limitations
          </h2>
          <p>We are transparent about the following:</p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              Some third-party PDF content inside uploaded music may not be
              fully accessible, because the accessibility of a score depends on
              how the publisher produced it.
            </li>
            <li>
              Automated checks cannot verify the visual and tonal quality of
              hand-drawn annotations. We review these manually.
            </li>
          </ul>
        </section>

        <section aria-labelledby="a11y-feedback">
          <h2 id="a11y-feedback" className="text-xl font-semibold mb-2">
            Feedback and assistance
          </h2>
          <p>
            If you have difficulty using any part of this site or the Digital
            Music Stand, please tell us — including the page you were on, the
            device and browser you used, and what happened. We will provide
            the information you need in an accessible format and work to fix
            the problem. Use the{' '}
            <Link href="/contact" className="text-primary underline hover:no-underline">
              contact page
            </Link>{' '}
            or speak with any band officer at rehearsal.
          </p>
        </section>
      </div>
    </div>
  );
}
