import { requirePermission } from '@/lib/auth/guards';
import Link from 'next/link';
import { formatDate } from '@/lib/date';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  MoreHorizontal,
  Eye,
  Pencil,
  Trash2,
  FileText,
  RefreshCw,
  Star,
} from 'lucide-react';
import { getTemplatesAction, initializeDefaultTemplatesAction } from './actions';
import { EmailTemplateType } from '@prisma/client';

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

export default async function EmailTemplatesPage() {
  await requirePermission(MESSAGE_SEND_ALL);

  const templates = await getTemplatesAction();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Email Templates</h1>
          <p className="text-muted-foreground">
            Manage reusable email templates for communications
          </p>
        </div>
        <div className="flex gap-2">
          <form action={initializeDefaultTemplatesAction}>
            <Button type="submit" variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" />
              Initialize Defaults
            </Button>
          </form>
          <Button asChild>
            <Link href="/admin/communications/templates/new">
              <Plus className="mr-2 h-4 w-4" />
              New Template
            </Link>
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Template Variables</CardTitle>
          <CardDescription>
            Use <code className="bg-muted px-1 rounded">{'{{variableName}}'}</code> syntax in subject and body for dynamic content.
            Conditionals are supported with <code className="bg-muted px-1 rounded">{'{{#if variable}}'}...{'{{/if}}'}</code>.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Templates Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Templates</CardTitle>
          <CardDescription>
            {templates.length} template{templates.length !== 1 ? 's' : ''} available
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-2 text-muted-foreground">No templates yet</p>
                    <p className="text-sm text-muted-foreground">
                      Click "Initialize Defaults" to create default templates, or create a custom one.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{template.name}</span>
                        {template.isDefault && (
                          <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                        )}
                      </div>
                      {template.description && (
                        <p className="text-sm text-muted-foreground truncate max-w-[300px]">
                          {template.description}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={templateTypeColors[template.type]}>
                        {templateTypeLabels[template.type]}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {template.subject}
                    </TableCell>
                    <TableCell>
                      <Badge variant={template.isActive ? 'default' : 'secondary'}>
                        {template.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(template.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/admin/communications/templates/${template.id}`}>
                              <Eye className="mr-2 h-4 w-4" />
                              View & Preview
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/admin/communications/templates/${template.id}/edit`}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            className="text-destructive focus:text-destructive"
                            disabled={template.isDefault}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
