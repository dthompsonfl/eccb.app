/**
 * Smart Upload Job Queue Functions
 *
 * This file provides job queueing functions for the Smart Upload pipeline.
 * - Main processing job (render → vision → split → verify)
 * - Second pass verification job
 */

import { Job } from 'bullmq';
import { getQueue, initializeQueues } from './queue';
import { logger } from '@/lib/logger';
import type { OcrFallbackOptions } from '@/lib/services/ocr-fallback';

// =============================================================================
// Job Data Interfaces
// =============================================================================

interface SmartUploadProcessData {
  sessionId: string;
  fileId: string;
}

interface SmartUploadSecondPassData {
  sessionId: string;
}

interface SmartUploadAutoCommitData {
  sessionId: string;
}

// =============================================================================
// Queue Names and Job Names
// =============================================================================

export const SMART_UPLOAD_JOB_NAMES = {
  PROCESS: 'smartupload.process',
  SECOND_PASS: 'smartupload.secondPass',
  AUTO_COMMIT: 'smartupload.autoCommit',
} as const;

// =============================================================================
// Job Queueing Functions
// =============================================================================

/**
 * Queue a smart upload for main processing.
 * This handles the full pipeline: render → vision → split → verify
 *
 * @param sessionId - The smart upload session ID
 * @param fileId - The file record ID
 * @returns The created job
 */
export async function queueSmartUploadProcess(
  sessionId: string,
  fileId: string
): Promise<Job> {
  initializeQueues();
  const queue = getQueue('SMART_UPLOAD');

  if (!queue) {
    throw new Error('Smart upload queue not initialized');
  }

  const job = await queue.add(
    SMART_UPLOAD_JOB_NAMES.PROCESS,
    { sessionId, fileId } as SmartUploadProcessData,
    {
      jobId: `smartupload_process_${sessionId}`,
      priority: 5,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  logger.info('Smart upload process job queued', {
    jobId: job.id,
    sessionId,
    fileId,
  });

  return job;
}

/**
 * Queue a smart upload for second pass verification.
 * This runs a secondary LLM verification to improve confidence.
 *
 * @param sessionId - The smart upload session ID
 * @returns The created job
 */
export async function queueSmartUploadSecondPass(
  sessionId: string
): Promise<Job> {
  initializeQueues();
  const queue = getQueue('SMART_UPLOAD');

  if (!queue) {
    throw new Error('Smart upload queue not initialized');
  }

  const job = await queue.add(
    SMART_UPLOAD_JOB_NAMES.SECOND_PASS,
    { sessionId } as SmartUploadSecondPassData,
    {
      jobId: `smartupload_secondPass_${sessionId}`,
      priority: 10, // Higher priority than initial processing
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  logger.info('Smart upload second pass job queued', {
    jobId: job.id,
    sessionId,
  });

  return job;
}

/**
 * Queue a smart upload for autonomous auto-commit.
 * Only triggered when confidence >= autonomousApprovalThreshold.
 *
 * @param sessionId - The smart upload session ID
 * @returns The created job
 */
export async function queueSmartUploadAutoCommit(sessionId: string): Promise<Job> {
  initializeQueues();
  const queue = getQueue('SMART_UPLOAD');

  if (!queue) {
    throw new Error('Smart upload queue not initialized');
  }

  const job = await queue.add(
    SMART_UPLOAD_JOB_NAMES.AUTO_COMMIT,
    { sessionId } as SmartUploadAutoCommitData,
    {
      jobId: `smartupload_autoCommit_${sessionId}`,
      priority: 3, // Higher priority than second pass
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  logger.info('Smart upload auto-commit job queued', { jobId: job.id, sessionId });
  return job;
}

// =============================================================================
// OCR Fallback Queueing
// =============================================================================
//
// The OCR worker (src/workers/ocr-worker.ts) has been started by
// src/workers/index.ts since it was written, but nothing ever enqueued a job
// for it: a repo-wide search for "ocr.process" matched only the worker file
// itself. The worker therefore held a BullMQ consumer and a Redis connection
// open in production while doing nothing at all.
//
// Smart Upload runs OCR inline during processing, and that is the primary
// path. This queue exists for the RE-RUN case: a librarian wants to re-OCR an
// already-uploaded session (a different engine, a different render scale, or to
// fill in a title/composer the first pass missed) without re-uploading the PDF
// and without blocking a request thread. That is exactly the job shape
// OcrProcessJobData already describes, so the missing producer belongs here.

export const OCR_JOB_NAMES = {
  PROCESS: 'ocr.process',
} as const;

/** Options for a re-OCR request. Mirrors OcrProcessJobData in the worker. */
export interface OcrProcessJobData {
  sessionId: string;
  storageKey?: string;
  filename?: string;
  options?: Partial<OcrFallbackOptions>;
  overwriteExistingMetadata?: boolean;
  updateParseStatus?: boolean;
}

/**
 * Enqueue a non-LLM OCR fallback pass for an existing Smart Upload session.
 *
 * Idempotent per session: a pending job for the same session is removed before
 * enqueuing, so a librarian double-clicking does not run the same OCR twice.
 * A job that is already active is left alone.
 */
export async function queueOcrProcess(data: OcrProcessJobData): Promise<Job> {
  initializeQueues();
  const queue = getQueue('OCR');

  if (!queue) {
    throw new Error('OCR queue not initialized');
  }

  const jobId = `ocr_process_${data.sessionId}`;

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await existing.remove();
    }
  }

  const job = await queue.add(OCR_JOB_NAMES.PROCESS, data, {
    jobId,
    // OCR is CPU/RAM heavy; keep it behind Smart Upload processing.
    priority: 3,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  });

  logger.info('Queued OCR fallback processing', {
    sessionId: data.sessionId,
    jobId: job.id,
  });

  return job;
}

// =============================================================================
// Job Status Types
// =============================================================================

export interface SmartUploadJobProgress {
  step: SmartUploadStep;
  percent: number;
  message?: string;
  sessionId?: string;
}

export type SmartUploadStep =
  | 'starting'
  | 'downloading'
  | 'scanning'
  | 'rendering'
  | 'analyzing'
  | 'validating'
  | 'splitting'
  | 'saving'
  | 'complete'
  | 'failed'
  | 'queued_for_second_pass'
  | 'auto_committing';

// Re-export types for convenience
export type { SmartUploadProcessData, SmartUploadSecondPassData, SmartUploadAutoCommitData };
