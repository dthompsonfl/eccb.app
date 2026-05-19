/**
 * Job Definitions for the ECCB Platform
 * 
 * This file defines all job types, their priorities, retry configurations,
 * and timeout settings for the background job processing system.
 */

import type { JobsOptions } from 'bullmq';

// ============================================================================
// Job Type Definitions
// ============================================================================

export type JobType =
  | 'email.send'
  | 'email.bulk'
  | 'notification.create'
  | 'publish.scheduled'
  | 'cleanup.sessions'
  | 'cleanup.files'
  | 'reminder.event'
  | 'smartupload.process'
  | 'smartupload.secondPass'
  | 'smartupload.autoCommit'
  | 'ocr.process';

export interface JobTypeNameMap {
  'email.send': EmailSendJobData;
  'email.bulk': EmailBulkJobData;
  'notification.create': NotificationJobData;
  'publish.scheduled': PublishScheduledJobData;
  'cleanup.sessions': CleanupSessionsJobData;
  'cleanup.files': CleanupFilesJobData;
  'reminder.event': EventReminderJobData;
  'smartupload.process': SmartUploadProcessJobData;
  'smartupload.secondPass': SmartUploadSecondPassJobData;
  'smartupload.autoCommit': SmartUploadAutoCommitJobData;
  'ocr.process': OcrProcessJobData;
}

// ============================================================================
// Job Data Interfaces
// ============================================================================

export interface EmailSendJobData {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
  /** ID of the member who triggered this email (for tracking) */
  triggeredBy?: string;
  /** Related entity ID (e.g., event ID for event reminders) */
  relatedEntityId?: string;
  relatedEntityType?: 'event' | 'announcement' | 'member';
}

export interface EmailBulkJobData {
  emails: EmailSendJobData[];
  /** Delay between emails in milliseconds */
  delayMs?: number;
  /** ID of the bulk email campaign (for tracking) */
  campaignId?: string;
  /** Member ID who initiated the bulk send */
  initiatedBy?: string;
}

export interface NotificationJobData {
  memberId: string;
  type: 'info' | 'warning' | 'success' | 'error';
  title: string;
  message: string;
  /** Optional link to related entity */
  link?: string;
  /** Related entity for grouping */
  relatedEntityId?: string;
  relatedEntityType?: 'event' | 'announcement' | 'music' | 'member';
  /** Whether to also send an email */
  sendEmail?: boolean;
  /** Email-specific options if sendEmail is true */
  emailOptions?: {
    subject: string;
    html: string;
    text?: string;
  };
}

export interface PublishScheduledJobData {
  /** Type of content to publish */
  contentType: 'page' | 'announcement' | 'event';
  /** ID of the content to publish */
  contentId: string;
  /** Scheduled publish time (ISO string) */
  scheduledFor: string;
  /** Member ID who scheduled the publish */
  scheduledBy?: string;
}

export interface CleanupSessionsJobData {
  /** Maximum age of sessions to keep (in hours) */
  maxAgeHours?: number;
  /** Whether to do a dry run (report only, don't delete) */
  dryRun?: boolean;
}

export interface CleanupFilesJobData {
  /** Maximum age of orphaned files to keep (in days) */
  maxAgeDays?: number;
  /** Whether to do a dry run (report only, don't delete) */
  dryRun?: boolean;
  /** Specific file types to clean up */
  fileTypes?: ('pdf' | 'image' | 'audio' | 'video')[];
}

export interface EventReminderJobData {
  /** Event ID */
  eventId: string;
  /** Event title for the reminder */
  eventTitle: string;
  /** Event date/time (ISO string) */
  eventDate: string;
  /** Type of reminder */
  reminderType: '24h' | '1h' | '15m' | 'custom';
  /** Custom message (optional) */
  customMessage?: string;
  /** Member IDs to send reminder to (if empty, sends to all RSVP'd) */
  memberIds?: string[];
}

export interface SmartUploadProcessJobData {
  /** Smart upload session ID */
  sessionId: string;
  /** File record ID */
  fileId: string;
}

export interface SmartUploadSecondPassJobData {
  /** Smart upload session ID */
  sessionId: string;
}

export interface SmartUploadAutoCommitJobData {
  /** Smart upload session ID */
  sessionId: string;
}

export interface OcrProcessJobData {
  /** SmartUploadSession.uploadSessionId */
  sessionId: string;
  /** Optional storage key override */
  storageKey?: string;
  /** Optional display filename override */
  filename?: string;
  /** Optional OCR option overrides; parsed by the OCR worker */
  options?: Record<string, unknown>;
  /** Whether OCR may overwrite existing extracted metadata */
  overwriteExistingMetadata?: boolean;
  /** Whether OCR should update parse status */
  updateParseStatus?: boolean;
}

// ============================================================================
// Job Configuration
// ============================================================================

export interface JobConfig {
  /** Job priority (higher = more important) */
  priority: number;
  /** Number of retry attempts */
  attempts: number;
  /** Backoff strategy for retries */
  backoff: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
  /** Remove job on completion */
  removeOnComplete: boolean | number;
  /** Remove job on failure */
  removeOnFail: boolean | number;
  /** Concurrency for this job type */
  concurrency: number;
}

/**
 * Default configurations for each job type
 */
export const JOB_CONFIGS: Record<JobType, JobConfig> = {
  'email.send': {
    priority: 10,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000, // Start with 1s, doubles each retry
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
    concurrency: 3,
  },
  'email.bulk': {
    priority: 5, // Lower priority than single emails
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // Start with 5s for bulk operations
    },
    removeOnComplete: 50,
    removeOnFail: 200,
    concurrency: 1, // Only one bulk job at a time
  },
  'notification.create': {
    priority: 15,
    attempts: 3,
    backoff: {
      type: 'fixed',
      delay: 2000,
    },
    removeOnComplete: 200,
    removeOnFail: 100,
    concurrency: 5,
  },
  'publish.scheduled': {
    priority: 20, // High priority for scheduled content
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    concurrency: 2,
  },
  'cleanup.sessions': {
    priority: 1, // Low priority
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 10000,
    },
    removeOnComplete: 10,
    removeOnFail: 50,
    concurrency: 1,
  },
  'cleanup.files': {
    priority: 1, // Low priority
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 10000,
    },
    removeOnComplete: 10,
    removeOnFail: 50,
    concurrency: 1,
  },
  'reminder.event': {
    priority: 15,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    concurrency: 3,
  },
  'smartupload.process': {
    priority: 5,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    concurrency: 2,
  },
  'smartupload.secondPass': {
    priority: 10,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    concurrency: 2,
  },
  'smartupload.autoCommit': {
    priority: 3,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    concurrency: 1,
  },
  'ocr.process': {
    priority: 4,
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
    concurrency: 1,
  },
};

// ============================================================================
// Queue Names
// ============================================================================

export const QUEUE_NAMES = {
  EMAIL: 'eccb-email',
  NOTIFICATION: 'eccb-notification',
  SCHEDULED: 'eccb-scheduled',
  CLEANUP: 'eccb-cleanup',
  DEAD_LETTER: 'eccb-dead-letter',
  SMART_UPLOAD: 'eccb-smart-upload',
  OCR: 'eccb-ocr',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get BullMQ job options from our job config
 */
export function getJobOptions(jobType: JobType): JobsOptions {
  const config = JOB_CONFIGS[jobType];
  return {
    priority: config.priority,
    attempts: config.attempts,
    backoff: config.backoff,
    removeOnComplete: config.removeOnComplete,
    removeOnFail: config.removeOnFail,
  };
}

/**
 * Get the queue name for a job type
 */
export function getQueueNameForJob(jobType: JobType): QueueName {
  switch (jobType) {
    case 'email.send':
    case 'email.bulk':
      return QUEUE_NAMES.EMAIL;
    case 'notification.create':
      return QUEUE_NAMES.NOTIFICATION;
    case 'publish.scheduled':
    case 'reminder.event':
      return QUEUE_NAMES.SCHEDULED;
    case 'cleanup.sessions':
    case 'cleanup.files':
      return QUEUE_NAMES.CLEANUP;
    case 'smartupload.process':
    case 'smartupload.secondPass':
    case 'smartupload.autoCommit':
      return QUEUE_NAMES.SMART_UPLOAD;
    case 'ocr.process':
      return QUEUE_NAMES.OCR;
    default:
      return QUEUE_NAMES.EMAIL;
  }
}

/**
 * Get concurrency for a job type
 */
export function getConcurrencyForJob(jobType: JobType): number {
  return JOB_CONFIGS[jobType].concurrency;
}
