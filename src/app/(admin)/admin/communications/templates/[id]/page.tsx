import { requirePermission } from '@/lib/auth/guards';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDate } from '@/lib/date';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowLeft,
  Pencil,
  Star,
  FileText,
  Code,
  Eye,
} from 'lucide-react';
import { EmailTemplateType } from '@prisma/client';
import { getTemplateByIdAction } from '../actions';
import { extractTemplateVariables } from '@/lib/email-template-utils';

import { MESSAGE_SEND_ALL } from '@/lib/auth/permission-constants';
const templateTypeLabels: Record<EmailTemplateType, string> = {
  WELCOME: 'Welcome',
  PASSWORD_RESET: 'Password Reset',
  EVENT_REMINDER: 'Event Reminder',
  ANNOUNCEMENT: 'Announcement',
  ATTENDANCE_SUMMARY: 'Attendance Summary',
  CUSTOM: 'Custom',
};

const templateTypeColors: Record<EmailTemplateType, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  WELCOME: 'default',
  PASSWORD_RESET: 'secondary',
  EVENT_REMINDER: 'default',
  ANNOUNCEMENT: 'destructive',
  ATTENDANCE_SUMMARY: 'secondary',
  CUSTOM: 'outline',
};

interface ViewTemplatePageProps {
  params: Promise<{ id: string }>;
}

export default async function ViewTemplatePage({ params }: ViewTemplatePageProps) {
  await requirePermission(MESSAGE_SEND_ALL);
  const { id } = await params;

  const template = await getTemplateByIdAction(id);
  
  if (!template) {
    notFound();
  }

  const variables = template.variables as unknown as Array<{
    name: string;
    description: string;
    required: boolean;
    defaultValue?: string;
  }>;

  const detectedVars = extractTemplateVariables(
    `${template.subject} ${template.body} ${template.textBody || ''}`
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/admin/communications/templates">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{template.name}</h1>
              {template.isDefault && (
                <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
              )}
            </div>
            <p className="text-muted-foreground">
              {template.description || 'No description'}
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href={`/admin/communications/templates/${template.id}/edit`}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit Template
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column - Details */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Template Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Type</span>
                <Badge variant={templateTypeColors[template.type]}>
                  {templateTypeLabels[template.type]}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Status</span>
                <Badge variant={template.isActive ? 'default' : 'secondary'}>
                  {template.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <Separator />
              <div className="text-sm">
                <span className="text-muted-foreground">Created: </span>
                {formatDate(template.createdAt)}
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Updated: </span>
                {formatDate(template.updatedAt)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
              <CardDescription>
                Dynamic content placeholders
              </CardDescription>
            </CardHeader>
            <CardContent>
              {variables && variables.length > 0 ? (
                <div className="space-y-3">
                  {variables.map((variable, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <code className="bg-muted px-2 py-1 rounded text-sm">
                        {variable.name}
                      </code>
                      {variable.required && (
                        <Badge variant="outline" className="text-xs">
                          Required
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              ) : detectedVars.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Detected variables:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {detectedVars.map((v) => (
                      <code key={v} className="bg-muted px-2 py-1 rounded text-sm">
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No variables defined
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Content */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Subject Line
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted p-4 rounded-md">
                <p className="font-medium">{template.subject}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Code className="h-5 w-5" />
                HTML Body
              </CardTitle>
              <CardDescription>
                The HTML content of the email
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px] rounded-md border">
                <pre className="p-4 text-sm font-mono whitespace-pre-wrap">
                  {template.body}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>

          {template.textBody && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Plain Text Version
                </CardTitle>
                <CardDescription>
                  Fallback for email clients that don't support HTML
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[200px] rounded-md border">
                  <pre className="p-4 text-sm whitespace-pre-wrap">
                    {template.textBody}
                  </pre>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
