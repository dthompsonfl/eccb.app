import React from 'react';
import { requireAdminConsole } from '@/lib/auth/guards';
import {
  ShieldCheck,
  Users,
  Music,
  Calendar,
  Settings,
  FileText,
  Activity,
  ChevronRight,
  Upload,
} from 'lucide-react';
import Link from 'next/link';


// We'll define distinct menu items for admins
const adminMenuItems = [
  { icon: Activity, label: 'Overview', href: '/admin' },
  { icon: Users, label: 'Members', href: '/admin/members' },
  { icon: Music, label: 'Library', href: '/admin/music' },
  { icon: Upload, label: 'Uploads', href: '/admin/uploads/review' },
  { icon: Calendar, label: 'Events', href: '/admin/events' },
  { icon: FileText, label: 'Announcements', href: '/admin/cms' },
  { icon: ShieldCheck, label: 'Audit Logs', href: '/admin/audit' },
  { icon: Settings, label: 'Settings', href: '/admin/settings' },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Same canonical shell guard as the parent (admin) layout. This used to
  // demand the ADMIN role exclusively, which contradicted the parent list and
  // locked librarians out of the routes this sidebar links to.
  await requireAdminConsole();

  return (
    <div className="flex h-screen bg-muted/30">
      {/* Admin Specific Sidebar */}
      <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r bg-slate-900 shadow-xl transition-transform -translate-x-full md:translate-x-0">
        <div className="flex h-full flex-col px-4 py-6">
          {/* Brand */}
          <Link href="/" className="mb-10 flex items-center gap-2 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
              <ShieldCheck size={20} />
            </div>
            <span className="font-display text-xl font-bold tracking-widest text-white">
              ECCB ADMIN
            </span>
          </Link>

          {/* Navigation */}
          <nav className="flex-grow space-y-1">
            {adminMenuItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
              >
                <div className="flex items-center gap-3">
                  <item.icon size={20} />
                  {item.label}
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            ))}
          </nav>

          {/* Return to Dashboard */}
          <div className="pt-6 border-t border-slate-800 mt-auto">
            <Link
              href="/dashboard"
              className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 rounded-xl transition-colors"
            >
              <Activity size={20} />
              Member Dashboard
            </Link>
          </div>
        </div>
      </aside>

      <main className="flex-1 transition-all md:ml-64">
        <div className="h-full overflow-y-auto px-6 py-8 lg:px-10">
          {children}
        </div>
      </main>
    </div>
  );
}
