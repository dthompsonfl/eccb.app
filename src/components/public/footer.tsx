import Link from 'next/link';
import { Facebook, Instagram, Youtube, Mail, Phone, MapPin } from 'lucide-react';
import { Logo } from '@/components/icons/logo';
import { getPublicSettings } from '@/lib/cms/public-settings';

/**
 * Social icon lookup. A link is only rendered when the administrator has
 * configured a real URL for that network, so the footer never links to a bare
 * https://facebook.com.
 */
const SOCIAL_ICONS: Record<string, typeof Facebook> = {
  Facebook,
  Instagram,
  YouTube: Youtube,
};

const footerNavigation = {
  main: [
    { name: 'Home', href: '/' },
    { name: 'About', href: '/about' },
    { name: 'Events', href: '/events' },
    { name: 'News', href: '/news' },
    { name: 'Gallery', href: '/gallery' },
    { name: 'Contact', href: '/contact' },
  ],
  band: [
    { name: 'Directors & Staff', href: '/directors' },
    { name: 'Our History', href: '/about' },
    { name: 'Join the Band', href: '/signup' },
    { name: 'Policies', href: '/policies' },
    { name: 'Sponsors', href: '/sponsors' },
  ],
  members: [
    { name: 'Member Portal', href: '/member' },
    { name: 'Music Library', href: '/member/music' },
    { name: 'Attendance', href: '/member/attendance' },
    { name: 'Calendar', href: '/member/calendar' },
  ],
};

export async function PublicFooter() {
  // Contact details, band name, description and social links come from
  // SystemSetting (admin General settings). These were previously hard-coded
  // placeholders: a "555" number behind a broken tel:+185****1234 href, and
  // bare https://facebook.com / instagram.com / youtube.com links.
  const settings = await getPublicSettings();

  const socialLinks = settings.socials
    .map((s) => ({ ...s, icon: SOCIAL_ICONS[s.name] }))
    .filter((s): s is { name: string; href: string; icon: typeof Facebook } =>
      Boolean(s.icon),
    );

  return (
    <footer className="bg-slate-900 text-slate-200">
      <div className="mx-auto w-full max-w-7xl px-6 pb-8 pt-12 lg:px-8">
        <div className="xl:grid xl:grid-cols-3 xl:gap-8">
          {/* Brand */}
          <div className="space-y-8">
            <div className="flex items-center gap-2">
              <Logo className="h-8 w-auto text-primary" />
              <span className="text-xl font-bold text-white">{settings.bandName}</span>
            </div>
            {settings.bandDescription ? (
              <p className="text-sm text-slate-400 max-w-xs">
                {settings.bandDescription}
              </p>
            ) : null}
            {socialLinks.length > 0 && (
              <div className="flex gap-4">
                {socialLinks.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-400 hover:text-primary transition-colors"
                    aria-label={item.name}
                  >
                    <item.icon className="h-6 w-6" aria-hidden="true" />
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Navigation links */}
          <div className="mt-16 grid grid-cols-2 gap-8 xl:col-span-2 xl:mt-0">
            <div className="md:grid md:grid-cols-2 md:gap-8">
              <div>
                <h3 className="text-sm font-semibold text-white">Navigation</h3>
                <ul className="mt-6 space-y-4">
                  {footerNavigation.main.map((item) => (
                    <li key={item.name}>
                      <Link
                        href={item.href}
                        className="text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        {item.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-10 md:mt-0">
                <h3 className="text-sm font-semibold text-white">The Band</h3>
                <ul className="mt-6 space-y-4">
                  {footerNavigation.band.map((item) => (
                    <li key={item.name}>
                      <Link
                        href={item.href}
                        className="text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        {item.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="md:grid md:grid-cols-2 md:gap-8">
              <div>
                <h3 className="text-sm font-semibold text-white">Members</h3>
                <ul className="mt-6 space-y-4">
                  {footerNavigation.members.map((item) => (
                    <li key={item.name}>
                      <Link
                        href={item.href}
                        className="text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        {item.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-10 md:mt-0">
                <h3 className="text-sm font-semibold text-white">Contact</h3>
                <ul className="mt-6 space-y-4">
                  {settings.contactEmail && (
                    <li>
                      <a
                        href={`mailto:${settings.contactEmail}`}
                        className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        <Mail className="h-4 w-4" aria-hidden="true" />
                        {settings.contactEmail}
                      </a>
                    </li>
                  )}

                  {/* Phone renders only when a real number is configured and
                      it yields a valid tel: href. The previous markup shipped
                      href="tel:+185****1234" with display text (850) 555-1234 —
                      a masked, undialable placeholder. */}
                  {settings.contactPhone && settings.contactPhoneHref && (
                    <li>
                      <a
                        href={settings.contactPhoneHref}
                        className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        <Phone className="h-4 w-4" aria-hidden="true" />
                        {settings.contactPhone}
                      </a>
                    </li>
                  )}

                  {settings.address && (
                    <li>
                      <div className="flex items-start gap-2 text-sm text-slate-400">
                        <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span className="whitespace-pre-line">{settings.address}</span>
                      </div>
                    </li>
                  )}

                  {/* Never render an empty Contact list. */}
                  {!settings.contactEmail &&
                    !settings.contactPhone &&
                    !settings.address && (
                      <li>
                        <Link
                          href="/contact"
                          className="text-sm text-slate-400 hover:text-white transition-colors"
                        >
                          Contact us
                        </Link>
                      </li>
                    )}
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-16 border-t border-slate-800 pt-8 flex flex-col md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-slate-400">
            &copy; {new Date().getFullYear()} {settings.bandName}. All rights reserved.
          </p>
          <div className="mt-4 flex gap-6 md:mt-0">
            <Link href="/privacy" className="text-xs text-slate-400 hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-xs text-slate-400 hover:text-white transition-colors">
              Terms of Service
            </Link>
            <Link href="/accessibility" className="text-xs text-slate-400 hover:text-white transition-colors">
              Accessibility
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
