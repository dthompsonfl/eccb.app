import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guards';
import { ANNOUNCEMENT_CREATE } from '@/lib/auth/permission-constants';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { AnnouncementForm } from '@/components/admin/announcements/announcement-form';
import { updateAnnouncement, getAnnouncement } from '../actions';
import type { AnnouncementType, AnnouncementAudience, ContentStatus } from '@prisma/client';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditAnnouncementPage({ params }: PageProps) {
  await requirePermission(ANNOUNCEMENT_CREATE);
  const { id } = await params;

  const announcement = await getAnnouncement(id);

  if (!announcement) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/announcements">
          <Button variant="outline" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Announcement</h1>
          <p className="text-muted-foreground">
            Update announcement details
          </p>
        </div>
      </div>

      <AnnouncementForm
        initialData={{
          id: announcement.id,
          title: announcement.title,
          content: announcement.content,
          type: announcement.type,
          audience: announcement.audience,
          isUrgent: announcement.isUrgent,
          isPinned: announcement.isPinned,
          status: announcement.status,
          publishAt: announcement.publishAt,
          expiresAt: announcement.expiresAt,
        }}
        onSubmit={async (data) => {
          'use server';
          return updateAnnouncement(id, {
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
