import { requirePermission } from '@/lib/auth/guards';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmailTemplateForm } from '@/components/admin/communications/email-template-form';
import { createTemplateAction } from '../actions';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';
export default async function NewEmailTemplatePage() {
  await requirePermission(MESSAGE_SEND_ALL);

  async function handleSubmit(data: {
    name: string;
    type: string;
    subject: string;
    body: string;
    textBody?: string;
    description?: string;
    isActive: boolean;
    isDefault: boolean;
    variables: { name: string; description: string; required: boolean; defaultValue?: string }[];
  }) {
    'use server';
    
    const result = await createTemplateAction({
      name: data.name,
      type: data.type as 'WELCOME' | 'PASSWORD_RESET' | 'EVENT_REMINDER' | 'ANNOUNCEMENT' | 'ATTENDANCE_SUMMARY' | 'CUSTOM',
      subject: data.subject,
      body: data.body,
      textBody: data.textBody,
      description: data.description,
      variables: data.variables,
      isActive: data.isActive,
      isDefault: data.isDefault,
    });

    if (result.success) {
      redirect('/admin/communications/templates');
    }

    throw new Error(result.error || 'Failed to create template');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/communications/templates">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Email Template</h1>
          <p className="text-muted-foreground">
            Create a new reusable email template
          </p>
        </div>
      </div>

      <EmailTemplateForm onSubmit={handleSubmit} />
    </div>
  );
}
