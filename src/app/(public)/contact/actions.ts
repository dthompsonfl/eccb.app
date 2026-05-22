'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { rateLimit, createRateLimitKey } from '@/lib/rate-limit';

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.'),
  email: z.string().trim().email('Please enter a valid email address.'),
  subject: z.string().trim().min(1, 'Please choose a subject.'),
  message: z.string().trim().min(10, 'Please include a message with at least 10 characters.').max(5000),
});

const subjectLabels: Record<string, string> = {
  general: 'General Inquiry',
  join: 'Joining the Band',
  booking: 'Event Booking',
  sponsorship: 'Sponsorship',
  feedback: 'Feedback',
  other: 'Other',
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function lineBreaks(value: string) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

export async function submitContactForm(data: unknown) {
  try {
    const rateLimitKey = await createRateLimitKey('contact');
    const rateLimitResult = await rateLimit(rateLimitKey, { type: 'contact' });

    if (!rateLimitResult.success) {
      return {
        success: false,
        error: 'Too many messages. Please try again later.',
        retryAfter: rateLimitResult.retryAfter,
      };
    }

    const validatedData = contactSchema.parse(data);
    const headersList = await headers();
    const subjectLabel = subjectLabels[validatedData.subject] || validatedData.subject;

    const submission = await prisma.contactSubmission.create({
      data: {
        name: validatedData.name,
        email: validatedData.email,
        subject: subjectLabel,
        message: validatedData.message,
        ipAddress: headersList.get('x-forwarded-for') || headersList.get('x-real-ip'),
        userAgent: headersList.get('user-agent'),
      },
    });

    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@eccb.app',
      subject: `[Contact Form] ${subjectLabel}`,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Submission ID:</strong> ${escapeHtml(submission.id)}</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Name</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(validatedData.name)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email</td>
            <td style="padding: 8px; border: 1px solid #ddd;">
              <a href="mailto:${escapeHtml(validatedData.email)}">${escapeHtml(validatedData.email)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Subject</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(subjectLabel)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;" colspan="2">Message</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;" colspan="2">${lineBreaks(validatedData.message)}</td>
          </tr>
        </table>
      `,
      text: `
New Contact Form Submission

Submission ID: ${submission.id}
Name: ${validatedData.name}
Email: ${validatedData.email}
Subject: ${subjectLabel}

Message:
${validatedData.message}
      `,
      replyTo: validatedData.email,
    });

    await sendEmail({
      to: validatedData.email,
      subject: 'Thank you for contacting Emerald Coast Community Band',
      html: `
        <h2>Thank you for reaching out!</h2>
        <p>Hi ${escapeHtml(validatedData.name)},</p>
        <p>We've received your message and will get back to you as soon as possible.</p>
        <p>Here's a copy of your message:</p>
        <blockquote style="border-left: 4px solid #0f766e; padding-left: 16px; margin: 16px 0; color: #666;">
          ${lineBreaks(validatedData.message)}
        </blockquote>
        <p>Best regards,<br>The Emerald Coast Community Band</p>
      `,
      text: `
Thank you for reaching out!

Hi ${validatedData.name},

We've received your message and will get back to you as soon as possible.

Here's a copy of your message:

${validatedData.message}

Best regards,
The Emerald Coast Community Band
      `,
    });

    return { success: true, submissionId: submission.id };
  } catch (error) {
    console.error('Contact form error:', error);

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.issues[0]?.message || 'Invalid form data. Please check your inputs.',
      };
    }

    return {
      success: false,
      error: 'Failed to send message. Please try again later.',
    };
  }
}
