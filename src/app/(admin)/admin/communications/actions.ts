'use server';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { auditLog } from '@/lib/services/audit';
import { sendEmail, sendBulkEmails } from '@/lib/email';

const composeEmailSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Email body is required'),
  recipientType: z.enum(['ALL', 'ACTIVE', 'SECTION', 'CUSTOM']),
  sectionId: z.string().optional(),
  customRecipients: z.array(z.string()).optional(),
  sendAsTest: z.boolean().optional(),
  testEmail: z.string().email().optional(),
});

export async function sendBulkEmailAction(formData: FormData) {
  const session = await requirePermission(MESSAGE_SEND_ALL);

  const rawData = Object.fromEntries(formData.entries());
  const customRecipientsRaw = formData.get('customRecipients');
  const customRecipients = customRecipientsRaw
    ? JSON.parse(customRecipientsRaw as string)
    : undefined;

  const data = composeEmailSchema.parse({
    ...rawData,
    customRecipients,
    sendAsTest: rawData.sendAsTest === 'true',
  });

  try {
    // Handle test email
    if (data.sendAsTest && data.testEmail) {
      await sendEmail({
        to: data.testEmail,
        subject: `[TEST] ${data.subject}`,
        html: data.body,
      });

      return { success: true, message: 'Test email sent successfully' };
    }

    // Get recipients based on type
    let recipients: { id: string; email: string; name: string | null }[] = [];

    if (data.recipientType === 'ALL') {
      const members = await prisma.member.findMany({
        where: { user: { email: { not: '' } } },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      recipients = members
        .filter((m) => m.user !== null)
        .map((m) => ({
          id: m.user!.id,
          email: m.user!.email,
          name: m.user!.name,
        }));
    } else if (data.recipientType === 'ACTIVE') {
      const members = await prisma.member.findMany({
        where: {
          status: 'ACTIVE',
          user: { email: { not: '' } },
        },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      recipients = members
        .filter((m) => m.user !== null)
        .map((m) => ({
          id: m.user!.id,
          email: m.user!.email,
          name: m.user!.name,
        }));
    } else if (data.recipientType === 'SECTION' && data.sectionId) {
      const members = await prisma.member.findMany({
        where: {
          sections: { some: { sectionId: data.sectionId } },
          user: { email: { not: '' } },
        },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      recipients = members
        .filter((m) => m.user !== null)
        .map((m) => ({
          id: m.user!.id,
          email: m.user!.email,
          name: m.user!.name,
        }));
    } else if (data.recipientType === 'CUSTOM' && data.customRecipients) {
      const users = await prisma.user.findMany({
        where: {
          id: { in: data.customRecipients },
        },
        select: { id: true, email: true, name: true },
      });
      recipients = users;
    }

    if (recipients.length === 0) {
      return { success: false, error: 'No recipients found' };
    }

    // Create email log entry
    const emailLog = await prisma.emailLog.create({
      data: {
        subject: data.subject,
        body: data.body,
        recipientCount: recipients.length,
        recipientType: data.recipientType,
        status: 'PENDING',
        sentById: session.user.id,
      },
    });

    // Send emails in batches
    const batchSize = 50;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);
      
      try {
        const results = await sendBulkEmails(
          batch.map((r) => ({
            to: r.email,
            subject: data.subject,
            html: data.body.replace('{{name}}', r.name || 'Member'),
          }))
        );
        successCount += results.success;
        failCount += results.failed;
      } catch (error) {
        console.error('Error sending batch:', error);
        failCount += batch.length;
      }
    }

    // Update email log
    await prisma.emailLog.update({
      where: { id: emailLog.id },
      data: {
        status: failCount === 0 ? 'SENT' : failCount === recipients.length ? 'FAILED' : 'SENT',
        sentAt: new Date(),
      },
    });

    // Audit log
    await auditLog({
      action: 'SEND_BULK_EMAIL',
      entityType: 'EMAIL',
      entityId: emailLog.id,
      newValues: {
        subject: data.subject,
        recipientType: data.recipientType,
        recipientCount: recipients.length,
        successCount,
        failCount,
      },
    });

    revalidatePath('/admin/communications');

    return {
      success: true,
      message: `Email sent to ${successCount} recipients${failCount > 0 ? `, ${failCount} failed` : ''}`,
    };
  } catch (error) {
    console.error('Error sending bulk email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}
