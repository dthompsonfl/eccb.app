import { requireAdminConsole } from '@/lib/auth/guards';

export default async function AdminRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Keep the nested route structurally transparent so it does not duplicate the
  // parent shell, but retain the canonical admin-console authorization guard.
  await requireAdminConsole();
  return children;
}
