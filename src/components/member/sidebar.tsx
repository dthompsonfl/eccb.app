'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Home,
  Music,
  Calendar,
  ClipboardCheck,
  User,
  Settings,
  Bell,
  X,
  Menu,
  BookOpen,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// Labels are written the way a musician would say them out loud. "Home" and
// "Your music" instead of "Dashboard" and "My Music"; "Which rehearsals I came
// to" instead of "Attendance". Hrefs are unchanged.
const navigation = [
  { name: 'Home', href: '/member', icon: Home, featureKey: null },
  { name: 'My Music Stand', href: '/member/stand', icon: BookOpen, featureKey: 'musicStand' as const },
  { name: 'Your Music', href: '/member/music', icon: Music, featureKey: null },
  { name: 'Practice Hub', href: '/member/practice', icon: Music, featureKey: null },
  { name: 'Dates & Times', href: '/member/calendar', icon: Calendar, featureKey: null },
  { name: 'Rehearsals I Came To', href: '/member/attendance', icon: ClipboardCheck, featureKey: null },
  { name: 'Messages', href: '/member/notifications', icon: Bell, featureKey: null },
  { name: 'About Me', href: '/member/profile', icon: User, featureKey: null },
  { name: 'Settings', href: '/member/settings', icon: Settings, featureKey: null },
];

interface EnabledFeatures {
  musicStand: boolean;
}

interface MemberSidebarProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    member?: {
      firstName: string;
      lastName: string;
      instruments: Array<{
        instrument: { name: string };
        isPrimary: boolean;
      }>;
    } | null;
  } | null;
  enabledFeatures?: EnabledFeatures;
}

export function MemberSidebar({ user, enabledFeatures }: MemberSidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const memberName = user?.member
    ? `${user.member.firstName} ${user.member.lastName}`
    : user?.name || 'Member';

  const primaryInstrument = user?.member?.instruments.find(i => i.isPrimary)?.instrument.name;

  return (
    <>
      {/* Mobile menu button */}
      <div className="fixed top-4 left-4 z-50 lg:hidden">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setMobileOpen(true)}
          className="bg-background"
          aria-label="Open the menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 text-white transform transition-transform lg:transform-none',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Mobile close button */}
        <div className="absolute top-4 right-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(false)}
            className="text-white hover:bg-white/10"
            aria-label="Close the menu"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Logo */}
        <div className="flex items-center gap-2 px-6 py-6 border-b border-white/10">
          <Music className="h-8 w-8 text-primary" />
          <span className="font-bold text-lg">Band Members</span>
        </div>

        {/* User info */}
        <div className="px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{memberName}</p>
              {primaryInstrument && (
                <p className="text-sm text-slate-400 truncate">{primaryInstrument}</p>
              )}
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {navigation
            .filter((item) => {
              if (!item.featureKey) return true;
              return enabledFeatures?.[item.featureKey] !== false;
            })
            .map((item) => {
            const isActive = pathname === item.href || 
              (item.href !== '/member' && pathname.startsWith(item.href));

            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            ← Back to the main website
          </Link>
        </div>
      </aside>
    </>
  );
}
