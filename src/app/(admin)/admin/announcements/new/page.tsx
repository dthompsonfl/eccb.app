import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guards';
import { ANNOUNCEMENT_CREATE } from '@/lib/auth/permission-constants';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { AnnouncementForm } from '@/components/admin/announcements/announcement-form';
import { createAnnouncement } from '../actions';
import type { AnnouncementType, AnnouncementAudience, ContentStatus } from '@prisma/client';

export default async function NewAnnouncementPage() {
  await requirePermission(ANNOUNCEMENT_CREATE);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/announcements">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Announcement</h1>
          <p className="text-muted-foreground">
            Create a new announcement for your audience
          </p>
        </div>
      </div>

      <AnnouncementForm
        onSubmit={async (data) => {
          'use server';
          return createAnnouncement({
            title: data.title,
            content: data.content,
            type: data.type as AnnouncementType,
            audience: data.audience as AnnouncementAudience,
            status: data.status as ContentStatus,
            isUrgent: data.isUrgent,
            isPinned: data.isPinned,
            publishAt: data.publishAt ? new Date(data.publishAt) : null,
            expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          });
        }}
      />
    </div>
  );
}
