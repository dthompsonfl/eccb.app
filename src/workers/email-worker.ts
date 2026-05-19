/**
 * Email Worker for ECCB Platform
 * 
 * Consumes email jobs from the queue and sends them using the email service.
 * Supports single emails and bulk email operations with exponential backoff retry.
 */

import { Job } from 'bullmq';
import { sendEmail, type SendEmailOptions } from '@/lib/email';
import { createWorker } from '@/lib/jobs/queue';
import { 
  type EmailSendJobData, 
  type EmailBulkJobData,
  JOB_CONFIGS,
} from '@/lib/jobs/definitions';
import { logger } from '@/lib/logger';

// ============================================================================
// Email Job Processors
// ============================================================================

/**
 * Process a single email job
 */
async function processEmailSend(job: Job<EmailSendJobData>): Promise<void> {
  const data = job.data;
  
  logger.info('Processing email job', {
    jobId: job.id,
    to: Array.isArray(data.to) ? `${data.to.length} recipients` : data.to,
    subject: data.subject,
  });

  // Update progress
  await job.updateProgress(10);

  const emailOptions: SendEmailOptions = {
    to: data.to,
    subject: data.subject,
    html: data.html,
    text: data.text,
    from: data.from,
    replyTo: data.replyTo,
    cc: data.cc,
    bcc: data.bcc,
    attachments: data.attachments,
  };

  await job.updateProgress(30);

  const result = await sendEmail(emailOptions);

  await job.updateProgress(90);

  if (!result.success) {
    throw new Error(result.error || 'Failed to send email');
  }

  await job.updateProgress(100);

  logger.info('Email job completed', {
    jobId: job.id,
    method: result.method,
    filepath: result.filepath,
  });
}

/**
 * Process a bulk email job
 */
async function processEmailBulk(job: Job<EmailBulkJobData>): Promise<void> {
  const data = job.data;
  const totalEmails = data.emails.length;
  
  logger.info('Processing bulk email job', {
    jobId: job.id,
    totalEmails,
    campaignId: data.campaignId,
  });

  await job.updateProgress(5);

  // Process emails with progress tracking
  const results = {
    success: 0,
    failed: 0,
    errors: [] as string[],
  };

  const delayMs = data.delayMs ?? 100; // Default 100ms between emails

  for (let i = 0; i < data.emails.length; i++) {
    const email = data.emails[i];
    
    try {
      const result = await sendEmail({
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        from: email.from,
        replyTo: email.replyTo,
        cc: email.cc,
        bcc: email.bcc,
        attachments: email.attachments,
      });

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push(`${JSON.stringify(email.to)}: ${result.error || 'Unknown error'}`);
      }

      // Update progress (5% base + 90% for emails)
      const progress = 5 + Math.round((i + 1) / totalEmails * 90);
      await job.updateProgress(progress);

      // Delay between emails to avoid rate limiting
      if (i < data.emails.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      results.failed++;
      results.errors.push(`${JSON.stringify(email.to)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await job.updateProgress(100);

  // Log summary
  logger.info('Bulk email job completed', {
    jobId: job.id,
    totalEmails,
    success: results.success,
    failed: results.failed,
    campaignId: data.campaignId,
  });

  // If more than 50% failed, consider it a failure
  if (results.failed > results.success) {
    throw new Error(`Bulk email job had high failure rate: ${results.failed}/${totalEmails} failed. Errors: ${results.errors.slice(0, 5).join('; ')}`);
  }

  // Store results in job return value
  job.returnvalue = results;
}

// ============================================================================
// Worker Creation
// ============================================================================

let emailWorker: ReturnType<typeof createWorker> | null = null;

/**
 * Start the email worker
 */
export function startEmailWorker(): void {
  if (emailWorker) {
    return;
  }

  const emailConfig = JOB_CONFIGS['email.send'];
  const bulkConfig = JOB_CONFIGS['email.bulk'];

  emailWorker = createWorker({
    queueName: 'EMAIL',
    concurrency: Math.max(emailConfig.concurrency, bulkConfig.concurrency),
    processor: async (job: Job) => {
      switch (job.name) {
        case 'email.send':
          await processEmailSend(job as Job<EmailSendJobData>);
          break;
        case 'email.bulk':
          await processEmailBulk(job as Job<EmailBulkJobData>);
          break;
        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    },
  });

  logger.info('Email worker started', {
    concurrency: Math.max(emailConfig.concurrency, bulkConfig.concurrency),
  });
}

/**
 * Stop the email worker
 */
export async function stopEmailWorker(): Promise<void> {
  if (emailWorker) {
    await emailWorker.close();
    emailWorker = null;
  }
  logger.info('Email worker stopped');
}

/**
 * Check if email worker is running
 */
export function isEmailWorkerRunning(): boolean {
  return emailWorker !== null;
}

// ============================================================================
// Export for Direct Use
// ============================================================================

export { processEmailSend, processEmailBulk };
