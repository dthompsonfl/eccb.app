import { Job } from 'bullmq';
import { prisma } from '@/lib/db';
import { createWorker, addJob } from '@/lib/jobs/queue';
import {
  type PublishScheduledJobData,
  type CleanupSessionsJobData,
  type CleanupFilesJobData,
  type EventReminderJobData,
  type NotificationJobData,
} from '@/lib/jobs/definitions';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/lib/email';
import { subDays, subHours, addHours, format } from 'date-fns';

// ============================================================================
// Scheduled Publishing
// ============================================================================

/**
 * Publish scheduled pages and announcements
 */
async function processScheduledPublish(job: Job<PublishScheduledJobData>): Promise<void> {
  const data = job.data;
  
  logger.info('Processing scheduled publish', {
    jobId: job.id,
    contentType: data.contentType,
    contentId: data.contentId,
  });

  await job.updateProgress(10);

  try {
    if (data.contentType === 'page') {
      const page = await prisma.page.findUnique({
        where: { id: data.contentId },
      });

      if (!page) {
        throw new Error(`Page not found: ${data.contentId}`);
      }

      if (page.status !== 'SCHEDULED') {
        logger.warn('Page is not in SCHEDULED status', { pageId: page.id, status: page.status });
        return;
      }

      await prisma.page.update({
        where: { id: data.contentId },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          scheduledFor: null,
        },
      });

      logger.info('Page published', { pageId: page.id, title: page.title });
    } else if (data.contentType === 'announcement') {
      const announcement = await prisma.announcement.findUnique({
        where: { id: data.contentId },
      });

      if (!announcement) {
        throw new Error(`Announcement not found: ${data.contentId}`);
      }

      if (announcement.status !== 'SCHEDULED') {
        logger.warn('Announcement is not in SCHEDULED status', { 
          announcementId: announcement.id, 
          status: announcement.status 
        });
        return;
      }

      await prisma.announcement.update({
        where: { id: data.contentId },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishAt: null,
        },
      });

      logger.info('Announcement published', { announcementId: announcement.id, title: announcement.title });
    }

    await job.updateProgress(100);
  } catch (error) {
    logger.error('Failed to publish scheduled content', {
      contentType: data.contentType,
      contentId: data.contentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

// ============================================================================
// Session Cleanup
// ============================================================================

/**
 * Cleanup expired sessions
 */
async function processCleanupSessions(job: Job<CleanupSessionsJobData>): Promise<void> {
  const data = job.data;
  const maxAgeHours = data.maxAgeHours ?? 24; // Default: 24 hours
  
  logger.info('Processing session cleanup', {
    jobId: job.id,
    maxAgeHours,
    dryRun: data.dryRun,
  });

  await job.updateProgress(10);

  const cutoffDate = subHours(new Date(), maxAgeHours);

  // Find expired sessions
  const expiredSessions = await prisma.session.findMany({
    where: {
      expiresAt: { lt: cutoffDate },
    },
    select: { id: true },
  });

  await job.updateProgress(50);

  if (data.dryRun) {
    logger.info('Dry run: would delete sessions', { count: expiredSessions.length });
    job.returnvalue = { deletedCount: 0, wouldDelete: expiredSessions.length };
  } else {
    // Delete expired sessions
    const result = await prisma.session.deleteMany({
      where: {
        expiresAt: { lt: cutoffDate },
      },
    });

    logger.info('Sessions cleaned up', { deletedCount: result.count });
    job.returnvalue = { deletedCount: result.count };
  }

  await job.updateProgress(100);
}

// ============================================================================
// File Cleanup
// ============================================================================

/**
 * Cleanup orphaned files
 */
async function processCleanupFiles(job: Job<CleanupFilesJobData>): Promise<void> {
  const data = job.data;
  const maxAgeDays = data.maxAgeDays ?? 30; // Default: 30 days
  
  logger.info('Processing file cleanup', {
    jobId: job.id,
    maxAgeDays,
    dryRun: data.dryRun,
    fileTypes: data.fileTypes,
  });

  await job.updateProgress(10);

  const cutoffDate = subDays(new Date(), maxAgeDays);

  // Find orphaned music files (files not associated with any music piece that's deleted)
  const orphanedFiles = await prisma.musicFile.findMany({
    where: {
      uploadedAt: { lt: cutoffDate },
      piece: {
        deletedAt: { not: null },
      },
    },
    select: { id: true, storageKey: true, fileName: true },
  });

  await job.updateProgress(50);

  if (data.dryRun) {
    logger.info('Dry run: would delete orphaned files', { count: orphanedFiles.length });
    job.returnvalue = { deletedCount: 0, wouldDelete: orphanedFiles.length };
  } else {
    // Delete orphaned files from storage and database
    // Note: Actual storage deletion would need to be implemented with the storage service
    const result = await prisma.musicFile.deleteMany({
      where: {
        id: { in: orphanedFiles.map((f: { id: string }) => f.id) },
      },
    });

    logger.info('Orphaned files cleaned up', { deletedCount: result.count });
    job.returnvalue = { deletedCount: result.count };
  }

  await job.updateProgress(100);
}

// ============================================================================
// Event Reminders
// ============================================================================

/**
 * Send event reminders
 */
async function processEventReminder(job: Job<EventReminderJobData>): Promise<void> {
  const data = job.data;
  
  logger.info('Processing event reminder', {
    jobId: job.id,
    eventId: data.eventId,
    reminderType: data.reminderType,
  });

  await job.updateProgress(10);

  // Get event details
  const event = await prisma.event.findUnique({
    where: { id: data.eventId },
    include: {
      venue: true,
      attendance: {
        include: {
          member: true,
        },
      },
    },
  });

  if (!event) {
    throw new Error(`Event not found: ${data.eventId}`);
  }

  await job.updateProgress(30);

  // Get members to notify
  let membersToNotify = data.memberIds;
  
  if (!membersToNotify || membersToNotify.length === 0) {
    // Get all active members who RSVP'd
    membersToNotify = event.attendance
      .filter((a: { status: string }) => a.status !== 'ABSENT')
      .map((a: { memberId: string }) => a.memberId);
  }

  // Get member emails
  const members = await prisma.member.findMany({
    where: {
      id: { in: membersToNotify },
      status: 'ACTIVE',
    },
    include: {
      user: true,
    },
  });

  await job.updateProgress(50);

  // Format event date
  const eventDate = new Date(data.eventDate);
  const formattedDate = format(eventDate, 'EEEE, MMMM d, yyyy');
  const formattedTime = format(eventDate, 'h:mm a');

  // Send reminder emails
  const emailPromises = members
    .filter((m: { user?: { email?: string } | null; email?: string | null }) => m.user?.email || m.email)
    .map((member: { firstName: string; user?: { email?: string } | null; email?: string | null }) => {
      const email = member.user?.email || member.email;
      if (!email) return null;

      return sendEmail({
        to: email,
        subject: `Reminder: ${data.eventTitle} - ${formattedDate}`,
        html: `
          <h2>Event Reminder</h2>
          <p>Hello ${member.firstName},</p>
          <p>This is a reminder for the upcoming event:</p>
          <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <h3 style="margin: 0 0 8px 0;">${data.eventTitle}</h3>
            <p style="margin: 0;"><strong>Date:</strong> ${formattedDate}</p>
            <p style="margin: 0;"><strong>Time:</strong> ${formattedTime}</p>
            ${event.location ? `<p style="margin: 0;"><strong>Location:</strong> ${event.location}</p>` : ''}
            ${event.venue ? `<p style="margin: 0;"><strong>Venue:</strong> ${event.venue.name}</p>` : ''}
            ${event.callTime ? `<p style="margin: 0;"><strong>Call Time:</strong> ${format(new Date(event.callTime), 'h:mm a')}</p>` : ''}
          </div>
          ${data.customMessage ? `<p>${data.customMessage}</p>` : ''}
          <p>Please make sure to arrive on time${event.callTime ? ` by ${format(new Date(event.callTime), 'h:mm a')}` : ''}.</p>
          <p>See you there!</p>
        `,
      });
    })
    .filter(Boolean);

  const results = await Promise.allSettled(emailPromises);
  
  const successCount = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'fulfilled').length;
  const failCount = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected').length;

  await job.updateProgress(100);

  logger.info('Event reminders sent', {
    eventId: data.eventId,
    reminderType: data.reminderType,
    successCount,
    failCount,
  });

  job.returnvalue = { successCount, failCount };
}

// ============================================================================
// Notification Creation
// ============================================================================

/**
 * Create notifications for users
 */
async function processNotificationCreate(job: Job<NotificationJobData>): Promise<void> {
  const data = job.data;
  
  logger.info('Processing notification creation', {
    jobId: job.id,
    memberId: data.memberId,
    type: data.type,
  });

  await job.updateProgress(10);

  // Get the user for this member
  const member = await prisma.member.findUnique({
    where: { id: data.memberId },
    include: { user: true },
  });

  if (!member || !member.user) {
    throw new Error(`Member or user not found: ${data.memberId}`);
  }

  await job.updateProgress(30);

  // Create notification
  await prisma.userNotification.create({
    data: {
      userId: member.user.id,
      type: mapNotificationType(data.type),
      title: data.title,
      message: data.message,
      linkUrl: data.link,
      linkText: data.link ? 'View Details' : undefined,
    },
  });

  await job.updateProgress(60);

  // Send email if requested
  if (data.sendEmail && data.emailOptions) {
    const email = member.user.email || member.email;
    if (email) {
      await sendEmail({
        to: email,
        subject: data.emailOptions.subject,
        html: data.emailOptions.html,
        text: data.emailOptions.text,
      });
    }
  }

  await job.updateProgress(100);

  logger.info('Notification created', {
    memberId: data.memberId,
    type: data.type,
    emailSent: data.sendEmail,
  });
}

function mapNotificationType(type: NotificationJobData['type']): 'ANNOUNCEMENT' | 'EVENT_REMINDER' | 'MUSIC_ASSIGNMENT' | 'ATTENDANCE_REMINDER' | 'SYSTEM' {
  switch (type) {
    case 'info':
    case 'success':
      return 'SYSTEM';
    case 'warning':
      return 'ANNOUNCEMENT';
    case 'error':
      return 'SYSTEM';
    default:
      return 'SYSTEM';
    }
}

// ============================================================================
// Scheduler Cron Jobs
// ============================================================================

/**
 * Check for scheduled content that needs to be published
 * This should be run every minute
 */
export async function checkScheduledContent(): Promise<void> {
  const now = new Date();

  // Check scheduled pages
  const scheduledPages = await prisma.page.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledFor: { lte: now },
    },
  });

  await Promise.all(scheduledPages.map(async (page) => {
    await addJob('publish.scheduled', {
      contentType: 'page',
      contentId: page.id,
      scheduledFor: page.scheduledFor!.toISOString(),
    });
    logger.info('Queued scheduled page for publishing', { pageId: page.id, title: page.title });
  }));

  // Check scheduled announcements
  const scheduledAnnouncements = await prisma.announcement.findMany({
    where: {
      status: 'SCHEDULED',
      publishAt: { lte: now },
    },
  });

  await Promise.all(scheduledAnnouncements.map(async (announcement) => {
    await addJob('publish.scheduled', {
      contentType: 'announcement',
      contentId: announcement.id,
      scheduledFor: announcement.publishAt!.toISOString(),
    });
    logger.info('Queued scheduled announcement for publishing', { 
      announcementId: announcement.id, 
      title: announcement.title 
    });
  }));
}

/**
 * Check for upcoming events and send reminders
 * This should be run every 15 minutes
 */
export async function checkEventReminders(): Promise<void> {
  const now = new Date();

  // 24-hour reminders
  const twentyFourHoursFromNow = addHours(now, 24);
  const events24h = await prisma.event.findMany({
    where: {
      startTime: {
        gte: now,
        lte: twentyFourHoursFromNow,
      },
      isCancelled: false,
    },
  });

  // Check if we already sent a 24h reminder (could use a tracking table)
  // For now, we'll queue the reminder
  await Promise.all(events24h.map(event => addJob('reminder.event', {
    eventId: event.id,
    eventTitle: event.title,
    eventDate: event.startTime.toISOString(),
    reminderType: '24h',
  })));

  // 1-hour reminders
  const oneHourFromNow = addHours(now, 1);
  const events1h = await prisma.event.findMany({
    where: {
      startTime: {
        gte: now,
        lte: oneHourFromNow,
      },
      isCancelled: false,
    },
  });

  await Promise.all(events1h.map(event => addJob('reminder.event', {
    eventId: event.id,
    eventTitle: event.title,
    eventDate: event.startTime.toISOString(),
    reminderType: '1h',
  })));
}

/**
 * Check for expiring content
 * This should be run daily
 */
export async function checkExpiringContent(): Promise<void> {
  const now = new Date();

  // Archive expired announcements
  const expiredAnnouncements = await prisma.announcement.updateMany({
    where: {
      status: 'PUBLISHED',
      expiresAt: { lt: now },
    },
    data: {
      status: 'ARCHIVED',
    },
  });

  if (expiredAnnouncements.count > 0) {
    logger.info('Archived expired announcements', { count: expiredAnnouncements.count });
  }
}

// ============================================================================
// Worker Creation
// ============================================================================

let scheduledWorker: ReturnType<typeof createWorker> | null = null;
let cleanupWorker: ReturnType<typeof createWorker> | null = null;
let notificationWorker: ReturnType<typeof createWorker> | null = null;

/**
 * Start the scheduler workers
 */
export function startSchedulerWorker(): void {
  if (scheduledWorker || cleanupWorker || notificationWorker) {
    return;
  }

  // Worker for scheduled publishing and reminders
  scheduledWorker = createWorker({
    queueName: 'SCHEDULED',
    concurrency: 2,
    processor: async (job: Job) => {
      switch (job.name) {
        case 'publish.scheduled':
          await processScheduledPublish(job as Job<PublishScheduledJobData>);
          break;
        case 'reminder.event':
          await processEventReminder(job as Job<EventReminderJobData>);
          break;
        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    },
  });

  // Worker for cleanup jobs
  cleanupWorker = createWorker({
    queueName: 'CLEANUP',
    concurrency: 1,
    processor: async (job: Job) => {
      switch (job.name) {
        case 'cleanup.sessions':
          await processCleanupSessions(job as Job<CleanupSessionsJobData>);
          break;
        case 'cleanup.files':
          await processCleanupFiles(job as Job<CleanupFilesJobData>);
          break;
        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    },
  });

  // Worker for notifications
  notificationWorker = createWorker({
    queueName: 'NOTIFICATION',
    concurrency: 5,
    processor: async (job: Job) => {
      if (job.name === 'notification.create') {
        await processNotificationCreate(job as Job<NotificationJobData>);
      } else {
        throw new Error(`Unknown job type: ${job.name}`);
      }
    },
  });

  logger.info('Scheduler workers started');
}

/**
 * Stop the scheduler workers
 */
export async function stopSchedulerWorker(): Promise<void> {
  if (scheduledWorker) {
    await scheduledWorker.close();
    scheduledWorker = null;
  }
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (notificationWorker) {
    await notificationWorker.close();
    notificationWorker = null;
  }
  logger.info('Scheduler workers stopped');
}

/**
 * Check if scheduler workers are running
 */
export function isSchedulerWorkerRunning(): boolean {
  return scheduledWorker !== null && cleanupWorker !== null && notificationWorker !== null;
}

// ============================================================================
// Export for Direct Use
// ============================================================================

export {
  processScheduledPublish,
  processCleanupSessions,
  processCleanupFiles,
  processEventReminder,
  processNotificationCreate,
};
