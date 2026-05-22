'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  Music,
  Calendar,
  FileText,
  Settings,
  BarChart3,
  Shield,
  Bell,
  X,
  Menu,
  Activity,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// Updated navigation - removed dead links, fixed CMS paths to match actual routes
const navigation = [
  { name: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  {
    name: 'Users',
    href: '/admin/users',
    icon: Users,
    children: [
      { name: 'All Users', href: '/admin/users' },
      { name: 'Create User', href: '/admin/users/new' },
    ],
  },
  {
    name: 'Members',
    href: '/admin/members',
    icon: Users,
    children: [
      { name: 'All Members', href: '/admin/members' },
      { name: 'Add Member', href: '/admin/members/new' },
    ],
  },
  {
    name: 'Music Library',
    href: '/admin/music',
    icon: Music,
    children: [
      { name: 'All Music', href: '/admin/music' },
      { name: 'Add Music', href: '/admin/music/new' },
      { name: 'Smart Music Upload', href: '/admin/uploads' },
      { name: 'Upload Review', href: '/admin/uploads/review' },
      { name: 'Smart Upload Settings', href: '/admin/uploads/settings' },
    ],
  },
  {
    name: 'Events',
    href: '/admin/events',
    icon: Calendar,
    children: [
      { name: 'All Events', href: '/admin/events' },
      { name: 'Create Event', href: '/admin/events/new' },
    ],
  },
  {
    name: 'CMS',
    href: '/admin/pages',
    icon: FileText,
    children: [
      { name: 'Pages', href: '/admin/pages' },
      { name: 'Media Assets', href: '/admin/assets' },
      { name: 'Sponsors', href: '/admin/sponsors' },
      { name: 'Gallery', href: '/admin/gallery' },
      { name: 'Leadership', href: '/admin/leadership' },
      { name: 'Contact Submissions', href: '/admin/contact-submissions' },
      { name: 'Announcements', href: '/admin/announcements' },
    ],
  },
  { name: 'Communications', href: '/admin/communications', icon: Bell },
  { name: 'Reports', href: '/admin/reports', icon: BarChart3 },
  { name: 'Settings', href: '/admin/settings', icon: Settings },
  {
    name: 'Roles',
    href: '/admin/roles',
    icon: Shield,
    children: [
      { name: 'Role Assignments', href: '/admin/roles' },
      { name: 'Custom Permissions', href: '/admin/roles/permissions' },
    ],
  },
  { name: 'Audit Logs', href: '/admin/audit', icon: Activity },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  const toggleExpanded = (name: string) => {
    setExpandedItems(prev =>
      prev.includes(name)
        ? prev.filter(item => item !== name)
        : [...prev, name]
    );
  };

  return (
    <>
      {/* Mobile menu button */}
      <div className="fixed top-4 left-4 z-50 lg:hidden">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setMobileOpen(true)}
          className="bg-background"
          aria-label="Open mobile menu"
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
          'fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-slate-900 border-r transform transition-transform lg:transform-none',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Mobile close button */}
        <div className="absolute top-4 right-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(false)}
            aria-label="Close mobile menu"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Logo */}
        <div className="flex items-center gap-2 px-6 py-6 border-b">
          <Shield className="h-8 w-8 text-primary" />
          <span className="font-bold text-lg">Admin Panel</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {navigation.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/admin' && pathname.startsWith(item.href));
            const isExpanded = expandedItems.includes(item.name) || isActive;

            return (
              <div key={item.name}>
                {item.children ? (
                  <>
                    <button
                      onClick={() => toggleExpanded(item.name)}
                      className={cn(
                        'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <item.icon className="h-5 w-5" />
                        {item.name}
                      </span>
                      <svg
                        className={cn(
                          'h-4 w-4 transition-transform',
                          isExpanded && 'rotate-180'
                        )}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="ml-8 mt-1 space-y-1">
                        {item.children.map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            onClick={() => setMobileOpen(false)}
                            className={cn(
                              'block px-3 py-2 rounded-lg text-sm transition-colors',
                              pathname === child.href
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            )}
                          >
                            {child.name}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <item.icon className="h-5 w-5" />
                    {item.name}
                  </Link>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t">
          <Link
            href="/member"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back to Member Portal
          </Link>
        </div>
      </aside>
    </>
  );
}
