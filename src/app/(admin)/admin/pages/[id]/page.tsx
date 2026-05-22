import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Breadcrumbs } from '@/components/shared/breadcrumbs';
import { PageForm } from '@/components/admin/pages/page-form';
import { updatePage, deletePage } from '../actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/date';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react';
import { normalizePageContent } from '@/lib/cms/page-content';

import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPagePage({ params }: EditPageProps) {
  await requirePermission(CMS_VIEW_ALL);
  const { id } = await params;

  const page = await prisma.page.findUnique({
    where: { id },
  });

  if (!page) {
    notFound();
  }

  async function handleUpdatePage(formData: FormData) {
    'use server';
    return updatePage(id, formData);
  }

  async function handleDeletePage(_: FormData) {
    'use server';
    const result = await deletePage(id);
    if (result.success) {
      redirect('/admin/pages');
    }
  }

  const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    PUBLISHED: 'default',
    DRAFT: 'secondary',
    SCHEDULED: 'outline',
    ARCHIVED: 'outline',
  };

  // Parse content for the form
  // Page.content is a String per Prisma schema
  const contentText = normalizePageContent(page.content).body;

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Admin', href: '/admin' },
          { label: 'Pages', href: '/admin/pages' },
          { label: page.title },
        ]}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link href="/admin/pages">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Pages
              </Button>
            </Link>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{page.title}</h1>
          <div className="flex items-center gap-2 text-muted-foreground">
            <code className="text-sm">/{page.slug}</code>
            <Badge variant={statusColors[page.status]}>{page.status}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {page.status === 'PUBLISHED' && (
            <a href={`/${page.slug}`} target="_blank" rel="noopener noreferrer">
              <Button variant="outline">
                <ExternalLink className="mr-2 h-4 w-4" />
                View Page
              </Button>
            </a>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Page</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete "{page.title}"? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <form action={handleDeletePage}>
                  <AlertDialogAction type="submit">Delete</AlertDialogAction>
                </form>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Page Info */}
      <Card>
        <CardHeader>
          <CardTitle>Page Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="font-medium">{formatDate(page.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last Updated</dt>
              <dd className="font-medium">{formatDate(page.updatedAt)}</dd>
            </div>
            {page.publishedAt && (
              <div>
                <dt className="text-muted-foreground">Published</dt>
                <dd className="font-medium">{formatDate(page.publishedAt)}</dd>
              </div>
            )}
            {page.scheduledFor && (
              <div>
                <dt className="text-muted-foreground">Scheduled For</dt>
                <dd className="font-medium">{formatDate(page.scheduledFor)}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-medium">v{page.version}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Editor Form */}
      <PageForm
        initialData={{
          id: page.id,
          title: page.title,
          slug: page.slug,
          description: page.description || '',
          content: contentText,
          status: page.status,
          metaTitle: page.metaTitle || '',
          metaDescription: page.metaDescription || '',
          ogImage: page.ogImage || '',
          scheduledFor: page.scheduledFor?.toISOString().slice(0, 16) || '',
        }}
        onSubmit={handleUpdatePage}
        isEdit
      />
    </div>
  );
}
