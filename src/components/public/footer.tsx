import Link from 'next/link';
import { Facebook, Instagram, Youtube, Mail, Phone, MapPin } from 'lucide-react';
import { Logo } from '@/components/icons/logo';

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
  social: [
    { name: 'Facebook', href: 'https://facebook.com', icon: Facebook },
    { name: 'Instagram', href: 'https://instagram.com', icon: Instagram },
    { name: 'YouTube', href: 'https://youtube.com', icon: Youtube },
  ],
};

export function PublicFooter() {
  return (
    <footer className="bg-slate-900 text-slate-200">
      <div className="mx-auto w-full max-w-7xl px-6 pb-8 pt-12 lg:px-8">
        <div className="xl:grid xl:grid-cols-3 xl:gap-8">
          {/* Brand */}
          <div className="space-y-8">
            <div className="flex items-center gap-2">
              <Logo className="h-8 w-auto text-primary" />
              <span className="text-xl font-bold text-white">Emerald Coast Community Band</span>
            </div>
            <p className="text-sm text-slate-400 max-w-xs">
              Bringing quality concert band music to the Emerald Coast community since 1985.
              Join us for our next performance!
            </p>
            <div className="flex gap-4">
              {footerNavigation.social.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-primary transition-colors"
                  aria-label={item.name}
                >
                  <item.icon className="h-6 w-6" />
                </a>
              ))}
            </div>
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
                  <li>
                    <a
                      href="mailto:info@eccb.app"
                      className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
                    >
                      <Mail className="h-4 w-4" />
                      info@eccb.app
                    </a>
                  </li>
                  <li>
                    <a
                      href="tel:+18505551234"
                      className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
                    >
                      <Phone className="h-4 w-4" />
                      (850) 555-1234
                    </a>
                  </li>
                  <li>
                    <div className="flex items-start gap-2 text-sm text-slate-400">
                      <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>
                        Niceville, FL 32578<br />
                        Emerald Coast
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-16 border-t border-slate-800 pt-8 flex flex-col md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-slate-400">
            &copy; {new Date().getFullYear()} Emerald Coast Community Band. All rights reserved.
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
