import Link from 'next/link';
import type { Metadata } from 'next';
import { FileText } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Terms of Use | Emerald Coast Community Band',
  description:
    'Terms governing use of the Emerald Coast Community Band website, member portal, and Digital Music Stand.',
  alternates: { canonical: '/terms' },
};

/**
 * Terms of Use.
 *
 * A real route rather than CMS content because the public footer links to
 * /terms unconditionally; it must resolve in a brand-new database.
 */
export default function TermsPage() {
  const lastUpdated = 'October 1, 2026';

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Terms of Use
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
      </header>

      <div className="space-y-8 text-slate-700 dark:text-slate-300">
        <section aria-labelledby="terms-acceptance">
          <h2 id="terms-acceptance" className="text-xl font-semibold mb-2">
            Acceptance of terms
          </h2>
          <p>
            By using this website, the member portal, or the Digital Music
            Stand, you agree to these terms. If you are a member of the band,
            these terms supplement the band&rsquo;s policies and your
            membership obligations.
          </p>
        </section>

        <section aria-labelledby="terms-copyright">
          <h2 id="terms-copyright" className="flex gap-3">
            <FileText className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <span className="text-xl font-semibold">Sheet music and copyright</span>
          </h2>
          <div className="mt-2 space-y-3">
            <p>
              All sheet music, scores, and arrangements made available through
              the Digital Music Stand remain the property of their composers,
              arrangers, and publishers. Access is provided to band members for
              rehearsal and performance only.
            </p>
            <p>
              You may download, annotate, and print music for your own use in
              rehearsal and performance. You may not redistribute, resell,
              publicly post, or share music files outside the band, and you may
              not remove watermarks or copyright notices.
            </p>
            <p>
              Some arrangements are licensed specifically for rehearsal use
              only and may not be publicly performed. When in doubt, ask your
              librarian or director before a public performance.
            </p>
          </div>
        </section>

        <section aria-labelledby="terms-conduct">
          <h2 id="terms-conduct" className="text-xl font-semibold mb-2">
            Acceptable use
          </h2>
          <p>You agree not to:</p>
          <ul className="list-disc space-y-2 pl-6">
            <li>Share your account credentials or allow another person to use your account.</li>
            <li>Attempt to access music, member records, or administrative functions you are not authorized to access.</li>
            <li>Probe, scan, or test the security of the site without written permission.</li>
            <li>Use automated tools to scrape, bulk-download, or overload the service.</li>
            <li>Upload malicious code, or attempt to disrupt rehearsals, concerts, or other members&rsquo; use of the service.</li>
          </ul>
          <p className="mt-3">
            We may suspend or revoke access for members who violate these
            terms.
          </p>
        </section>

        <section aria-labelledby="terms-conduct-conduct">
          <h2 id="terms-conduct-conduct" className="text-xl font-semibold mb-2">
            Member conduct
          </h2>
          <p>
            Members are expected to conduct themselves professionally at
            rehearsals and performances, to treat fellow members and audience
            respectfully, and to follow the direction of the band&rsquo;s
            directors. Conduct that endangers the safety or dignity of others
            may result in removal from the band.
          </p>
        </section>

        <section aria-labelledby="terms-availability">
          <h2 id="terms-availability" className="text-xl font-semibold mb-2">
            Availability and changes
          </h2>
          <p>
            The band is a volunteer organization and this site is provided
            &quot;as is.&quot; Rehearsal schedules, events, and music library
            contents may change without notice. We work to keep the service
            available during rehearsals and concerts, but we do not guarantee
            uninterrupted access.
          </p>
        </section>

        <section aria-labelledby="terms-liability">
          <h2 id="terms-liability" className="text-xl font-semibold mb-2">
            Limitation of liability
          </h2>
          <p>
            To the fullest extent permitted by law, the band and its officers
            and members are not liable for any indirect or consequential
            damages arising from your use of this site. Music files are
            provided for rehearsal convenience; the band is not responsible for
            performance decisions made from these materials.
          </p>
        </section>

        <section aria-labelledby="terms-changes">
          <h2 id="terms-changes" className="text-xl font-semibold mb-2">
            Changes to these terms
          </h2>
          <p>
            We may update these terms. The &quot;last updated&rdquo; date above
            always reflects the current version. Continued use of the site after
            a change constitutes acceptance of the updated terms.
          </p>
        </section>

        <section aria-labelledby="terms-contact">
          <h2 id="terms-contact" className="text-xl font-semibold mb-2">
            Questions
          </h2>
          <p>
            Questions about these terms can be sent through the{' '}
            <Link href="/contact" className="text-primary underline hover:no-underline">
              contact page
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
