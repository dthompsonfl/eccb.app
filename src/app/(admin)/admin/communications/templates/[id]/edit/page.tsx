import { requirePermission } from '@/lib/auth/guards';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmailTemplateForm } from '@/components/admin/communications/email-template-form';
import { getTemplateByIdAction, updateTemplateAction } from '../../actions';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';
interface EditTemplatePageProps {
  params: Promise<{ id: string }>;
}

export default async function EditTemplatePage({ params }: EditTemplatePageProps) {
  await requirePermission(MESSAGE_SEND_ALL);
  const { id } = await params;

  const template = await getTemplateByIdAction(id);
  
  if (!template) {
    notFound();
  }

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
    
    const result = await updateTemplateAction(id, {
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

    throw new Error(result.error || 'Failed to update template');
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
          <h1 className="text-3xl font-bold tracking-tight">Edit Template</h1>
          <p className="text-muted-foreground">
            Modify {template.name}
          </p>
        </div>
      </div>

      <EmailTemplateForm template={template} onSubmit={handleSubmit} />
    </div>
  );
}
