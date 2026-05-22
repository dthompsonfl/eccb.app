import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { ComposeEmailForm } from './compose-form';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';
export default async function ComposeEmailPage() {
  await requirePermission(MESSAGE_SEND_ALL);

  // Get sections for the recipient selector
  const sections = await prisma.section.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Compose Email</h1>
        <p className="text-muted-foreground">
          Send an email to band members
        </p>
      </div>

      <ComposeEmailForm sections={sections} />
    </div>
  );
}
