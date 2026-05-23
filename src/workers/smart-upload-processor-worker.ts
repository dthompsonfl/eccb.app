/**
 * Smart Upload Unified Worker Entry Point
 *
 * This module creates and manages the BullMQ worker for ALL Smart Upload jobs:
 *   - smartupload_process   → main pipeline (render → vision → split)
 *   - smartupload_secondPass → verification / adjudication
 *   - smartupload_autoCommit → autonomous library commit
 *
 * IMPORTANT: This is the ONLY worker that consumes the SMART_UPLOAD queue.
 * Having multiple workers on the same queue with different job routing caused
 * jobs to be silently lost (BullMQ marks a job complete when the processor
 * returns without throwing, even if the job was "skipped").
 */

import { Job } from 'bullmq';
import { createWorker } from '@/lib/jobs/queue';
import { processSmartUpload } from './smart-upload-processor';
import { processSecondPass } from './smart-upload-worker';
import { commitSmartUploadSessionToLibrary } from '@/lib/smart-upload/commit';
import { cleanupSmartUploadTempFiles } from '@/lib/services/smart-upload-cleanup';
import { SMART_UPLOAD_JOB_NAMES } from '@/lib/jobs/smart-upload';
import { loadSmartUploadRuntimeConfig } from '@/lib/smart-upload/runtime-config';
import { recordMetricSuccess, recordMetricError } from '@/lib/smart-upload/metrics';
import { SmartUploadErrorCode } from '@/lib/smart-upload/error-codes';
import { logger } from '@/lib/logger';
import type { SmartUploadSecondPassJobData } from '@/lib/jobs/definitions';

// =============================================================================
// Worker Instance
// =============================================================================

let smartUploadProcessorWorker: ReturnType<typeof createWorker> | null = null;

// =============================================================================
// Worker Management
// =============================================================================

/**
 * Start the unified smart upload worker.
 *
 * This single worker handles process, secondPass, and autoCommit jobs.
 */
export async function startSmartUploadProcessorWorker(): Promise<void> {
  if (smartUploadProcessorWorker) {
    return;
  }

  // Load concurrency from DB config so operators can tune it without redeploying
  const llmCfg = await loadSmartUploadRuntimeConfig().catch(() => null);
  const concurrency = llmCfg?.maxConcurrent ?? 2;

  const config = {
    priority: 5,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: false,
    concurrency,
  };

  smartUploadProcessorWorker = createWorker({
    queueName: 'SMART_UPLOAD',
    concurrency: config.concurrency,
    processor: async (job: Job) => {
      const sessionId = (job.data as { sessionId?: string })?.sessionId;
      const startTime = Date.now();
      try {
        // IMPORTANT: Each branch MUST return a value so BullMQ stores it as
        // job.returnvalue. The SSE endpoint filters completed events by
        // returnvalue.sessionId — if returnvalue is undefined the browser
        // never receives the terminal event and the UI stays stuck.
        switch (job.name) {
          case SMART_UPLOAD_JOB_NAMES.PROCESS:
            return await processSmartUpload(job);

          case SMART_UPLOAD_JOB_NAMES.SECOND_PASS: {
            await processSecondPass(job as Job<SmartUploadSecondPassJobData>);
            if (sessionId) {
              const duration = Date.now() - startTime;
              recordMetricSuccess(sessionId, 'verification', duration);
            }
            return { status: 'second_pass_complete', sessionId };
          }

          case SMART_UPLOAD_JOB_NAMES.AUTO_COMMIT: {
            logger.info('Running auto-commit for session', { sessionId, jobId: job.id });
            await commitSmartUploadSessionToLibrary(sessionId!, {}, 'system:auto-commit');
            logger.info('Auto-commit complete', { sessionId });
            if (sessionId) {
              const duration = Date.now() - startTime;
              recordMetricSuccess(sessionId, 'overall', duration, { action: 'auto_commit' });
            }
            return { status: 'auto_commit_complete', sessionId };
          }

          default:
            // Treat unknown job names as programmer errors — throw so BullMQ
            // retries (and eventually dead-letters) rather than silently losing
            // the job.
            throw new Error(
              `smart-upload-worker: unknown job name "${job.name}" (id=${job.id}). ` +
              `Expected one of: ${Object.values(SMART_UPLOAD_JOB_NAMES).join(', ')}`
            );
        }
      } catch (error) {
        // Record error metric
        if (sessionId) {
          const duration = Date.now() - startTime;
          recordMetricError(sessionId, SmartUploadErrorCode.UNKNOWN_ERROR, 'overall', duration);
        }

        // Only destroy temp files on the FINAL attempt to preserve idempotency
        // on retries: a subsequent attempt may need to re-download sampled parts
        // that were uploaded to storage during the failing attempt.
        const maxAttempts = job.opts?.attempts ?? 1;
        const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;
        if (sessionId && isFinalAttempt) {
          try {
            await cleanupSmartUploadTempFiles(sessionId);
          } catch (cleanupErr) {
            logger.warn('Failed to cleanup temp files after worker error', {
              sessionId,
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
        }
        throw error;
      }
    },
  });

  logger.info('Smart upload unified worker started', { concurrency: config.concurrency });
}

/**
 * Stop the smart upload processor worker
 */
export async function stopSmartUploadProcessorWorker(): Promise<void> {
  if (smartUploadProcessorWorker) {
    await smartUploadProcessorWorker.close();
    smartUploadProcessorWorker = null;
    logger.info('Smart upload unified worker stopped');
  }
}

/**
 * Check if smart upload processor worker is running
 */
export function isSmartUploadProcessorWorkerRunning(): boolean {
  return smartUploadProcessorWorker !== null;
}
