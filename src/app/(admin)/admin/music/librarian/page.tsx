import { Metadata } from 'next';
import { LibrarianDashboard } from '@/components/admin/music/librarian-dashboard';
import { requirePermission } from '@/lib/auth/guards';
import { MUSIC_ASSIGN } from '@/lib/auth/permission-constants';

export const metadata: Metadata = {
  title: 'Librarian Dashboard | Admin',
  description: 'Manage music assignments, track parts distribution, and handle returns',
};

export default async function LibrarianPage() {
  // Part distribution / returns management requires music.assign.
  await requirePermission(MUSIC_ASSIGN);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Librarian Dashboard</h1>
        <p className="text-muted-foreground">
          Manage music assignments, track parts distribution, and handle returns
        </p>
      </div>

      <LibrarianDashboard />
    </div>
  );
}
