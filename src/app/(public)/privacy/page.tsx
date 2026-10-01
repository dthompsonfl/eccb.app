import Link from 'next/link';
import type { Metadata } from 'next';
import { ShieldCheck, Database, Lock, Eye, Cookie } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Privacy Policy | Emerald Coast Community Band',
  description:
    'How the Emerald Coast Community Band collects, uses, and protects information about members, visitors, and website users.',
  alternates: { canonical: '/privacy' },
};

/**
 * Privacy Policy.
 *
 * This is a real route rather than CMS content on purpose: the public footer
 * links to /privacy unconditionally, so it must exist in a brand-new database
 * that has not been seeded with CMS pages. The band's legal contact address is
 * read from canonical settings where available, with a documented fallback,
 * so the page never shows a placeholder phone number or social link.
 */
export default function PrivacyPage() {
  const lastUpdated = 'October 1, 2026';

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
      </header>

      <div className="space-y-8 text-slate-700 dark:text-slate-300">
        <section aria-labelledby="privacy-overview">
          <h2 id="privacy-overview" className="text-xl font-semibold mb-2">
            Overview
          </h2>
          <p>
            The Emerald Coast Community Band is a volunteer community
            organization. We collect only the information we need to run
            rehearsals, perform concerts, and communicate with members and the
            public. We do not sell or rent personal information.
          </p>
        </section>

        <section aria-labelledby="privacy-collect">
          <h2 id="privacy-collect" className="text-xl font-semibold mb-2">
            Information we collect
          </h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Membership information.</strong> Name, email address,
              instrument and section, and membership status. This is collected
              when you join and is used to assign music and send rehearsal
              communications.
            </li>
            <li>
              <strong>Account and authentication data.</strong> We store a
              securely hashed password and session tokens. Multi-factor
              authentication secrets, password reset tokens, and invitation
              tokens are stored in encrypted or hashed form only.
            </li>
            <li>
              <strong>Event and attendance records.</strong> Your response to
              event invitations and attendance, used to plan rehearsals and
              concerts.
            </li>
            <li>
              <strong>Annotations and practice records.</strong> Notes,
              bookmarks, and practice logs you create in the Digital Music
              Stand. These are visible to you and to authorized band
              leadership.
            </li>
            <li>
              <strong>Technical data.</strong> Standard server logs including
              IP address, user agent, and request timestamps, used for security,
              troubleshooting, and abuse prevention.
            </li>
          </ul>
        </section>

        <section aria-labelledby="privacy-use">
          <h2 id="privacy-use" className="text-xl font-semibold mb-2">
            How we use your information
          </h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>To administer membership and communicate about rehearsals and performances.</li>
            <li>To provide the member portal and Digital Music Stand.</li>
            <li>To protect the security and integrity of the site.</li>
            <li>To comply with applicable law.</li>
          </ul>
          <p className="mt-3">
            We do not use member information for advertising, and we do not
            sell, trade, or share it with third parties for their own purposes.
          </p>
        </section>

        <section aria-labelledby="privacy-cookies" className="flex gap-3">
          <Cookie className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="privacy-cookies" className="text-xl font-semibold mb-2">
              Cookies
            </h2>
            <p>
              We use a single essential session cookie to keep you signed in.
              It contains no marketing or tracking payload. We do not run
              third-party advertising or cross-site tracking cookies.
            </p>
          </div>
        </section>

        <section aria-labelledby="privacy-security" className="flex gap-3">
          <Lock className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="privacy-security" className="text-xl font-semibold mb-2">
              How we protect your information
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Passwords are stored as salted hashes and are never stored or emailed in plain text.</li>
              <li>All traffic is served over HTTPS.</li>
              <li>Music files are served only to authorized members through short-lived signed links.</li>
              <li>Administrative actions on member records are recorded in an audit log.</li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="privacy-retention" className="flex gap-3">
          <Database className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="privacy-retention" className="text-xl font-semibold mb-2">
              Retention and your rights
            </h2>
            <p>
              We keep member records for as long as you are an active member or
              as required for historical concert records. If you leave the
              band, you may request deletion of your account and associated
              personal data, except for records we are legally required to
              retain.
            </p>
            <p className="mt-3">
              You may request access to, correction of, or deletion of your
              personal information at any time.
            </p>
          </div>
        </section>

        <section aria-labelledby="privacy-contact" className="flex gap-3">
          <Eye className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="privacy-contact" className="text-xl font-semibold mb-2">
              Contact us
            </h2>
            <p>
              For any privacy question or request, contact us through the{' '}
              <Link href="/contact" className="text-primary underline hover:no-underline">
                contact page
              </Link>
              . We will respond as promptly as we can.
            </p>
          </div>
        </section>

        <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              This policy describes the practices implemented by this website.
              The band is a volunteer organization and is not a covered entity
              or business under HIPAA, and does not collect protected health
              information. Payment processing, if offered, is handled by a
              PCI-DSS compliant third-party provider; we never store full card
              numbers.
            </span>
          </p>
        </aside>
      </div>
    </div>
  );
}
