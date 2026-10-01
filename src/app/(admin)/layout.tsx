import { requireAdminConsole } from '@/lib/auth/guards';
import { AdminSidebar } from '@/components/admin/sidebar';
import { AdminHeader } from '@/components/admin/header';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Shell gate for the whole admin console. The role matrix lives in
  // @/lib/auth/admin-roles and is shared with src/app/(admin)/admin/layout.tsx —
  // the two layouts must never declare their own list again.
  // Per-page capability is enforced by each page's requirePermission() call.
  await requireAdminConsole();

  return (
    <div className="flex min-h-screen">
      <AdminSidebar />
      <div className="flex-1 flex flex-col lg:pl-64">
        <AdminHeader />
        <main className="flex-1 p-6 lg:p-8 bg-slate-50 dark:bg-slate-950">
          {children}
        </main>
      </div>
    </div>
  );
}
